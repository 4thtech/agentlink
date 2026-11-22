// RELAY-SHARED-CONN L3 (D-159; 07 §4.2 "One relay link per computer"; 04 §4 "Local relay link"):
// the election, the shared link's server and the client dialer, over the per-user endpoint of
// shared-relay-endpoint.ts. The mux (which relay frames go where) and the client connector (the
// virtual sockets a RelayPool holds) are transport-nostr's; this file only carries their frames.
//
// - Election: binding the endpoint is the election. EADDRINUSE: a probe connect; an answer means a
//   live shared link (be its client); ECONNREFUSED means a stale Unix socket, removed only after the
//   lstat checks, then bound again. On Unix the whole attempt runs under an inter-process lock in the
//   run folder, so two programs never both clear a stale socket and bind. Attempts are bounded (3,
//   with backoff); an endpoint that fails its checks or every attempt turns sharing off for a cool
//   down, during which a dial fails at once (the connector then connects directly): no spinning.
// - Hand-over: when a client's channel to the shared link ends without its own close, it re-races
//   after a random 0 to 500 ms. `yieldLink` (on the shared link) stops accepting, closes every
//   channel and unbinds, then rejoins after a short delay; `requestYield` (any program, after the
//   token proof) asks the current shared link to do that, and `start` then binds without a delay.
// - The winner's own program is a client of its own mux, in process: no second relay connection.
// - Server limits per channel: the frame-size limit of LinkFrameReader, at most 4 KiB before the
//   token proof is accepted, and a cap on bytes waiting to be written; a wrong proof closes the
//   channel at once and no frame after it is handed to the mux.
// - Control frames (proved channels only, handled here, never by the mux): `{"t":"yield"}` and
//   `{"t":"status"}` (answer `{"t":"status","programs":<n>}`), for the desktop host and `doctor`.
// - A stuck endpoint (it answers the connect but stalls the handshake, or breaks the protocol
//   before the proof): sharing is off for this program for a growing time (5 s, doubling, at most
//   30 s), so sockets and checks go direct at once instead of waiting out a handshake each; the
//   next election after that time finds a healthy winner when there is one. A token refusal re-reads
//   the token file. Each election, and a changed token, is a new `epoch`: connectors that were down
//   or refused try the link again then (D-159 build decisions 8 and 10).
// - Counts (D-159 build decision 11): `programs` is the IDs on this computer using the link, the
//   same number from the winner and from a client: proved channels of ID client connectors only,
//   never a channel in its handshake, a status question or a server test (`transient`).
// - Logging (I-7): fixed codes only; never a frame, id, relay URL, path or the token.
import { chmod, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { encodeHex, randomBytes } from '@4thtech-io/crypto';
import {
  FallbackConnector,
  LinkFrameReader,
  SHARED_HANDSHAKE_TIMEOUT_MS,
  SHARED_LINK_RETRY_MS,
  SHARED_LINK_VERSION,
  SharedLinkMux,
  SharedRelayConnector,
  checkLinkProof,
  decodeServerFrame,
  encodeLinkFrame,
  linkFrameBytes,
  linkProof,
  type AddressCheck,
  type RelayConnector,
  type SharedLinkChannel,
  type SharedLinkChannelHandlers,
  type SharedLinkClient,
  type SharedHandshakeOutcome,
  type SharedLinkDialer,
  type SharedLinkMuxOptions,
  type SharedLinkStats,
} from '@4thtech-io/transport-nostr';
import { withInterProcessLock } from './inter-process-lock.js';
import { nodeHostResolver, nodeRelayConnector } from './relay-io.js';
import {
  checkDir,
  checkSocket,
  ensureDir,
  ensureLinkToken,
  ownUid,
  resolveEndpoint,
  type EndpointPlatform,
  type LstatFn,
  type RelayEndpoint,
} from './shared-relay-endpoint.js';

/** The switch (D-159 (11)). `0`, `off`, `false`, `no` turn sharing off; `1`, `on`, `true`, `yes` on. */
export const SHARED_RELAYS_ENV = 'AGENTLINK_SHARED_RELAYS';
/** Off by default in 0.5.18, the first release with the shared link (D-159 (11), owner 21 Nov 2026). */
export const SHARED_RELAYS_DEFAULT = false;
/** Clients re-race after a random delay up to this when the shared link's channel ends (D-159 (8)). */
export const SHARED_LINK_RERACE_MAX_MS = 500;
/** After an unusable endpoint, dials fail at once for this long (the program connects directly). */
export const SHARED_LINK_COOLDOWN_MS = 5_000;

const ELECTION_ATTEMPTS = 3;
const ELECTION_BACKOFF_MS = 50;
const LOCK_TIMEOUT_MS = 2_000;
const PROBE_TIMEOUT_MS = 1_000;
/** A socket that refused is probed once more after this before it counts as stale (L-c). */
const STALE_RECHECK_MS = 150;
const CONNECT_TIMEOUT_MS = SHARED_HANDSHAKE_TIMEOUT_MS;
const PRE_AUTH_MAX_BYTES = 4 * 1024;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const YIELD_WAIT_MS = 3_000;
/** A program that yielded rejoins after this (plus a random part), so the host that asked binds first. */
const YIELD_REJOIN_MS = 250;
const LOCK_FILE = 'relay.lock';
const CONTROL_YIELD = '{"t":"yield"}';
const CONTROL_STATUS = '{"t":"status"}';
const STATUS_REPLY = /^\{"t":"status","programs":([0-9]{1,6})\}$/;

/** What a probe of the endpoint saw: a listener, none (stale or gone), or an error. */
export type ProbeOutcome = 'alive' | 'refused' | 'error';

const TRUE = new Set(['1', 'on', 'true', 'yes']);

/** Whether the shared link is on for this environment. */
export function sharedRelaysEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[SHARED_RELAYS_ENV];
  if (value === undefined || value.trim() === '') return SHARED_RELAYS_DEFAULT;
  return TRUE.has(value.trim().toLowerCase());
}

export type LinkLogger = NonNullable<SharedLinkMuxOptions['logger']>;

/**
 * `idle` (not elected yet), `electing`, `winner` (this program holds the endpoint and the mux),
 * `client` (another program does), `unavailable` (sharing off for now: own connections), `closed`.
 */
export type SharedLinkRole = 'idle' | 'electing' | 'winner' | 'client' | 'unavailable' | 'closed';

/** For `agentlink doctor` (11 §5.15): counts only. */
export interface SharedRelayStatus {
  readonly on: boolean;
  readonly role: SharedLinkRole;
  /** Programs on the shared link, when known. */
  readonly programs?: number;
}

export interface SharedRelayLinkOptions extends EndpointPlatform {
  readonly home: string;
  readonly cliVersion: string;
  /** The 32-byte token of the run folder (ensureLinkToken). Never sent, never logged. */
  readonly token: Uint8Array;
  /** The program's direct connector: the mux opens upstreams through it when this program wins. */
  readonly direct: RelayConnector;
  readonly addressCheck: AddressCheck;
  readonly logger?: LinkLogger;
  /** The pool's own `mayAuthenticate` (07 §4.3), passed to the client connector. */
  readonly mayAuthenticate?: (relayUrl: string) => boolean;
  /** Test seam: lstat (to simulate another user). */
  readonly lstat?: LstatFn;
  /** Test seam: [0, 1) jitter. */
  readonly random?: () => number;
  /** Test seam: the endpoint probe (`real` is the built-in one). */
  readonly probeEndpoint?: (
    path: string,
    real: (path: string) => Promise<ProbeOutcome>,
  ) => Promise<ProbeOutcome>;
}

/** Options for one more client connector on the link. */
export interface LinkConnectorOptions {
  /** A short-lived connector (the server test, a check): not counted as an ID on the link. */
  readonly transient?: boolean;
}

type BindOutcome = 'bound' | 'busy' | 'unsafe' | 'retry';

const microtask = (fn: () => void): void => {
  void Promise.resolve().then(fn);
};

const codeOf = (error: unknown): unknown => (error as { code?: unknown } | null)?.code;

class Unavailable extends Error {
  constructor() {
    super('shared relay link unavailable');
    this.name = 'SharedLinkUnavailable';
  }
}

export class SharedRelayLink {
  /** Where this user's shared link listens, or undefined (no usable path: sharing off). */
  readonly endpoint: RelayEndpoint | undefined;
  private readonly options: SharedRelayLinkOptions;
  private token: Uint8Array;
  private readonly lstatFn: LstatFn;
  private readonly uid: () => number | undefined;
  private readonly random: () => number;
  private readonly logger: LinkLogger | undefined;
  private current: SharedLinkRole = 'idle';
  private server: Server | undefined;
  private mux: SharedLinkMux | undefined;
  private readonly accepted = new Set<Socket>();
  private readonly dialled = new Set<Socket>();
  private election: Promise<SharedLinkRole> | undefined;
  private skipDelay: (() => void) | undefined;
  private unavailableUntil = 0;
  private shared: SharedRelayConnector | undefined;
  private closed = false;
  /** Bumped by every election and every token change (the connectors' `epoch`). */
  private generation = 0;
  /** The current back-off after a stuck endpoint (0: none). */
  private stuckBackoffMs = 0;
  private reloading = false;

  constructor(options: SharedRelayLinkOptions) {
    if (!(options.token instanceof Uint8Array) || options.token.length !== 32) {
      throw new TypeError('shared link token must be 32 bytes');
    }
    this.options = options;
    this.token = options.token.slice();
    this.lstatFn = options.lstat ?? lstat;
    this.uid = options.uid ?? ownUid;
    this.random = options.random ?? Math.random;
    this.logger = options.logger;
    this.endpoint = resolveEndpoint(options.home, options);
  }

  get role(): SharedLinkRole {
    return this.current;
  }

  /** The dialer a SharedRelayConnector uses (07 §4.2 seam). */
  readonly dial: SharedLinkDialer = (handlers) => this.dialChannel(handlers);

  /** This program's client connector on the link (one per link; a failed channel redials at once). */
  connector(): SharedRelayConnector {
    this.shared ??= this.makeConnector(this.options.mayAuthenticate, false);
    return this.shared;
  }

  private makeConnector(
    mayAuthenticate: ((relayUrl: string) => boolean) | undefined,
    transient: boolean,
  ): SharedRelayConnector {
    return new SharedRelayConnector({
      dial: this.dial,
      token: this.token,
      currentToken: () => this.token,
      epoch: () => this.generation,
      onHandshake: (outcome) => this.handshakeEnded(outcome),
      cliVersion: this.options.cliVersion,
      ...(this.logger === undefined ? {} : { logger: this.logger }),
      // The election here bounds retries (cool down); a stuck endpoint gets SHARED_LINK_RETRY_MS.
      retryAfterMs: 0,
      handshakeRetryMs: SHARED_LINK_RETRY_MS,
      ...(transient ? { transient: true } : {}),
      ...(mayAuthenticate === undefined ? {} : { mayAuthenticate }),
    });
  }

  /**
   * A client connector of its own for one more RelayPool on this link (L4: one per agent a process
   * opens), with that pool's `mayAuthenticate`. Each is its own program on the link, so the check
   * lane never batches ids of different IDs together (D-159, owner decision 1).
   */
  newConnector(
    mayAuthenticate?: (relayUrl: string) => boolean,
    options: LinkConnectorOptions = {},
  ): SharedRelayConnector {
    return this.makeConnector(mayAuthenticate, options.transient === true);
  }

  /**
   * A connector's handshake ended. A stuck endpoint (stalled, or a protocol error before the
   * proof) turns sharing off for this program for a growing time; a token refusal re-reads the
   * token file. Fixed codes only are logged.
   */
  private handshakeEnded(outcome: SharedHandshakeOutcome): void {
    if (outcome === 'ready') {
      this.stuckBackoffMs = 0;
      return;
    }
    if (outcome === 'token') {
      void this.reloadToken();
      return;
    }
    if ((outcome !== 'stalled' && outcome !== 'protocol') || this.current !== 'client') return;
    this.stuckBackoffMs = Math.min(
      SHARED_LINK_RETRY_MS,
      Math.max(SHARED_LINK_COOLDOWN_MS, this.stuckBackoffMs * 2),
    );
    this.current = 'unavailable';
    this.unavailableUntil = Date.now() + this.stuckBackoffMs;
    this.logger?.info('shared relay link not used', { reason: outcome });
  }

  /** The token file changed (another program replaced a corrupt one): use the new token. */
  private async reloadToken(): Promise<void> {
    if (this.reloading || this.closed) return;
    this.reloading = true;
    try {
      const fresh = await ensureLinkToken(this.options.home);
      if (fresh instanceof Uint8Array && fresh.length === 32 && !sameBytes(fresh, this.token)) {
        this.token = fresh.slice();
        this.generation += 1;
      }
    } catch {
      // the token this program has stays
    } finally {
      this.reloading = false;
    }
  }

  /**
   * For `agentlink doctor` (11 §5.15), without joining the election: the number of programs on the
   * shared link (after the two-way token proof), `none` when no program holds it, or undefined
   * when the endpoint could not be checked or did not prove the token.
   */
  async probeStatus(): Promise<number | 'none' | undefined> {
    const endpoint = this.endpoint;
    if (endpoint === undefined) return undefined;
    if (endpoint.kind === 'unix') {
      const socket = await checkSocket(endpoint.path, this.lstatFn, this.uid);
      if (socket === 'missing') return 'none';
      if (socket !== 'ok' || !(await checkDir(endpoint.dir, this.lstatFn, this.uid))) {
        return undefined;
      }
    }
    const alive = await this.probe(endpoint.path);
    if (alive === 'refused') return 'none';
    if (alive !== 'alive') return undefined;
    const reply = await this.control(CONTROL_STATUS, 'reply');
    const match = typeof reply === 'string' ? STATUS_REPLY.exec(reply) : null;
    return match === null ? undefined : Number(match[1]);
  }

  /** Runs the election now, without the random delay (a pending one is cut short). */
  start(): Promise<SharedLinkRole> {
    if (this.election !== undefined) {
      this.skipDelay?.();
      return this.election;
    }
    return this.elect(0);
  }

  /** The mux's counts while this program holds the link. */
  stats(): SharedLinkStats | undefined {
    return this.mux?.stats();
  }

  async status(): Promise<SharedRelayStatus> {
    const role = this.current;
    if (role === 'winner' && this.mux !== undefined) {
      return { on: true, role, programs: this.mux.stats().ids };
    }
    if (role === 'client') {
      const reply = await this.control(CONTROL_STATUS, 'reply');
      const match = typeof reply === 'string' ? STATUS_REPLY.exec(reply) : null;
      if (match !== null) return { on: true, role, programs: Number(match[1]) };
    }
    return { on: true, role };
  }

  /**
   * Hand-over, on the shared link (L4: the desktop host may call it on its own link): stop
   * accepting, close every channel, unbind; this program rejoins as a client after a short delay.
   */
  async yieldLink(): Promise<boolean> {
    if (this.current !== 'winner') return false;
    await this.stopServer();
    if (this.closed) return true;
    this.current = 'idle';
    this.logger?.info('shared relay link handed over');
    void this.elect(YIELD_REJOIN_MS + this.random() * YIELD_REJOIN_MS);
    return true;
  }

  /**
   * Asks the program that holds the link to hand it over (after the two-way token proof). True when
   * it closed the channel in time; then `start()` binds without the random delay.
   */
  async requestYield(): Promise<boolean> {
    if (this.current === 'winner') return false;
    return (await this.control(CONTROL_YIELD, 'close')) === 'closed';
  }

  /** Ends the link: the endpoint is unbound (if held), every channel closed. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.skipDelay?.();
    for (const socket of this.dialled) socket.destroy();
    this.dialled.clear();
    await this.stopServer();
    this.current = 'closed';
  }

  // --- election ----------------------------------------------------------------------------------

  private elect(delayMs: number): Promise<SharedLinkRole> {
    if (this.election !== undefined) return this.election;
    if (this.closed) return Promise.resolve('closed');
    this.current = 'electing';
    const run = async (): Promise<SharedLinkRole> => {
      if (delayMs > 0) await this.sleep(delayMs);
      for (let attempt = 0; attempt < ELECTION_ATTEMPTS; attempt += 1) {
        if (this.closed) return 'closed';
        const outcome = await this.tryBind();
        if (outcome === 'bound') return 'winner';
        if (outcome === 'busy') return 'client';
        if (outcome === 'unsafe') return 'unavailable';
        await this.sleep(ELECTION_BACKOFF_MS * 2 ** attempt * (1 + this.random()));
      }
      return 'unavailable';
    };
    const election = run()
      .catch((): SharedLinkRole => 'unavailable')
      .then(async (role) => {
        this.election = undefined;
        this.skipDelay = undefined;
        this.generation += 1; // connectors that were down or refused may try the link again
        if (this.closed) {
          await this.stopServer();
          this.current = 'closed';
          return 'closed' as const;
        }
        this.current = role;
        if (role === 'unavailable') {
          this.unavailableUntil = Date.now() + SHARED_LINK_COOLDOWN_MS;
          this.logger?.info('shared relay link not used', { reason: 'endpoint' });
        } else {
          this.logger?.debug('shared relay link elected', { role });
        }
        return role;
      });
    this.election = election;
    return election;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        if (this.skipDelay === done) this.skipDelay = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      this.skipDelay = done;
    });
  }

  private async tryBind(): Promise<BindOutcome> {
    const endpoint = this.endpoint;
    if (endpoint === undefined) return 'unsafe';
    if (endpoint.kind === 'pipe') {
      const listened = await this.listen(endpoint.path);
      if (listened === 'ok') return 'bound';
      if (listened === 'in_use')
        return (await this.probe(endpoint.path)) === 'alive' ? 'busy' : 'retry';
      return 'retry';
    }
    if (!(await ensureDir(endpoint.dir, this.lstatFn, this.uid))) return 'unsafe';
    try {
      return await withInterProcessLock(
        join(endpoint.dir, LOCK_FILE),
        () => this.bindUnix(endpoint.path, endpoint.dir),
        { timeoutMs: LOCK_TIMEOUT_MS },
      );
    } catch {
      return 'retry';
    }
  }

  private async bindUnix(path: string, dir: string): Promise<BindOutcome> {
    if ((await checkSocket(path, this.lstatFn, this.uid)) === 'unsafe') return 'unsafe';
    let listened = await this.listen(path);
    if (listened === 'in_use') {
      let probe = await this.probe(path);
      if (probe === 'refused') {
        // A refusal may be a program between close and bind: ask once more before unlinking.
        await this.sleep(STALE_RECHECK_MS);
        if (this.closed) return 'retry';
        probe = await this.probe(path);
      }
      if (probe === 'alive') return 'busy';
      if (probe !== 'refused') return 'retry';
      // Stale: no answer. Removed only after the same checks (04 §4).
      if (
        !(await checkDir(dir, this.lstatFn, this.uid)) ||
        (await checkSocket(path, this.lstatFn, this.uid)) === 'unsafe'
      ) {
        return 'unsafe';
      }
      await unlink(path).catch(() => undefined);
      listened = await this.listen(path);
    }
    if (listened !== 'ok') return 'retry';
    // Only this user may connect, whatever the umask (the 0700 folder is the first guard).
    await chmod(path, 0o600).catch(() => undefined);
    if (
      !(await checkDir(dir, this.lstatFn, this.uid)) ||
      (await checkSocket(path, this.lstatFn, this.uid)) !== 'ok'
    ) {
      await this.stopServer();
      return 'unsafe';
    }
    return 'bound';
  }

  private listen(path: string): Promise<'ok' | 'in_use' | 'error'> {
    const mux = new SharedLinkMux({
      connector: this.options.direct,
      addressCheck: this.options.addressCheck,
      token: this.token,
      cliVersion: this.options.cliVersion,
      ...(this.logger === undefined ? {} : { logger: this.logger }),
    });
    const server = createServer((socket) => this.accept(socket, mux));
    return new Promise((resolve) => {
      server.once('error', (error) => {
        mux.close();
        resolve(codeOf(error) === 'EADDRINUSE' ? 'in_use' : 'error');
      });
      server.listen({ path, exclusive: true }, () => {
        server.removeAllListeners('error');
        server.on('error', () => undefined);
        this.server = server;
        this.mux = mux;
        resolve('ok');
      });
    });
  }

  /** `alive` (a program answers), `refused` (no listener: stale or gone), `error`. */
  private probe(path: string): Promise<ProbeOutcome> {
    const seam = this.options.probeEndpoint;
    if (seam !== undefined) return seam(path, (p) => realProbe(p));
    return realProbe(path);
  }

  private async stopServer(): Promise<void> {
    const server = this.server;
    const mux = this.mux;
    this.server = undefined;
    this.mux = undefined;
    if (server === undefined) return;
    const closing = new Promise<void>((resolve) => server.close(() => resolve()));
    mux?.close();
    for (const socket of this.accepted) socket.destroy();
    this.accepted.clear();
    await closing;
  }

  // --- the shared link's side of a channel -------------------------------------------------------

  private accept(socket: Socket, mux: SharedLinkMux): void {
    if (this.closed || this.mux !== mux) {
      socket.destroy();
      return;
    }
    this.accepted.add(socket);
    const reader = new LinkFrameReader();
    let proved = false;
    let done = false;
    let received = 0;
    const end = (): void => {
      if (done) return;
      done = true;
      socket.pause();
      socket.end(() => socket.destroy());
      setTimeout(() => socket.destroy(), 1_000).unref();
    };
    const client: SharedLinkClient = mux.attach({
      send: (frame) => {
        if (done || socket.destroyed) throw new Unavailable();
        if (!proved && frame.startsWith('{"t":"accept"')) proved = true;
        socket.write(linkFrameBytes(frame));
        if (socket.writableLength > MAX_BUFFERED_BYTES) {
          this.logger?.warn('shared relay link closed a slow program', { reason: 'backlog' });
          end();
        }
      },
      close: end,
    });
    socket.on('data', (chunk: Buffer) => {
      if (done) return;
      if (!proved) {
        received += chunk.length;
        if (received > PRE_AUTH_MAX_BYTES) {
          this.logger?.warn('shared relay link refused a program', { reason: 'pre_auth_size' });
          client.detach();
          return;
        }
      }
      const { frames, error } = reader.push(
        new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length),
      );
      for (const frame of frames) {
        if (done) return; // a closed channel reads nothing more
        if (proved && frame === CONTROL_YIELD) {
          void this.yieldLink();
          return;
        }
        if (proved && frame === CONTROL_STATUS) {
          // IDs on the link, as the winner counts them (the asking channel is `aux`: not one).
          const programs = mux.stats().ids;
          socket.write(linkFrameBytes(`{"t":"status","programs":${programs}}`));
          continue;
        }
        client.receive(frame);
      }
      if (error !== undefined && !done) {
        this.logger?.warn('shared relay link refused a program', { reason: error });
        client.detach();
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      done = true;
      this.accepted.delete(socket);
      client.detach();
    });
  }

  // --- the program's side ------------------------------------------------------------------------

  private dialChannel(handlers: SharedLinkChannelHandlers): SharedLinkChannel {
    if (this.closed) throw new Unavailable();
    if (this.current === 'unavailable') {
      if (Date.now() < this.unavailableUntil) throw new Unavailable();
      void this.elect(0);
    } else if (this.current === 'idle') {
      void this.elect(0);
    }
    if (this.current === 'winner' && this.mux !== undefined)
      return this.inProcess(handlers, this.mux);
    return this.deferred(handlers);
  }

  /** A channel whose far end is chosen when the election ends: frames wait until then. */
  private deferred(handlers: SharedLinkChannelHandlers): SharedLinkChannel {
    const queue: string[] = [];
    let inner: SharedLinkChannel | undefined;
    let closed = false;
    const guarded: SharedLinkChannelHandlers = {
      onFrame: (frame) => {
        if (!closed) handlers.onFrame(frame);
      },
      onClose: () => {
        if (closed) return;
        closed = true;
        handlers.onClose();
      },
    };
    void (async () => {
      const role = this.election !== undefined ? await this.election : this.current;
      if (closed) return;
      if (role === 'winner' && this.mux !== undefined) inner = this.inProcess(guarded, this.mux);
      else if (role === 'client') inner = await this.connectClient(guarded);
      else throw new Unavailable();
      if (closed) {
        inner.close();
        return;
      }
      for (const frame of queue.splice(0)) inner.send(frame);
    })().catch(() => {
      microtask(() => guarded.onClose());
    });
    return {
      send: (frame) => {
        if (closed) throw new Unavailable();
        if (inner === undefined) queue.push(frame);
        else inner.send(frame);
      },
      close: () => {
        if (closed) return;
        closed = true;
        inner?.close();
      },
    };
  }

  /** The winner's own program: a client of its own mux, in process. */
  private inProcess(handlers: SharedLinkChannelHandlers, mux: SharedLinkMux): SharedLinkChannel {
    let ending = false;
    let ended = false;
    const shut = (): void => {
      if (ending) return;
      ending = true;
      microtask(() => {
        ended = true;
        client.detach();
        handlers.onClose();
      });
    };
    const client: SharedLinkClient = mux.attach({
      send: (frame) => {
        if (ending) throw new Unavailable();
        microtask(() => {
          if (!ended) handlers.onFrame(frame);
        });
      },
      close: shut,
    });
    return {
      send: (frame) => {
        if (ending) throw new Unavailable();
        microtask(() => {
          if (!ended) client.receive(frame);
        });
      },
      close: shut,
    };
  }

  /** Connects to the shared link's endpoint after the checks (04 §4). Rejects when it cannot. */
  private async openSocket(): Promise<Socket> {
    const endpoint = this.endpoint;
    if (endpoint === undefined) throw new Unavailable();
    if (
      endpoint.kind === 'unix' &&
      (!(await checkDir(endpoint.dir, this.lstatFn, this.uid)) ||
        (await checkSocket(endpoint.path, this.lstatFn, this.uid)) !== 'ok')
    ) {
      throw new Unavailable();
    }
    const socket = connect(endpoint.path);
    this.dialled.add(socket);
    socket.on('close', () => this.dialled.delete(socket));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Unavailable()), CONNECT_TIMEOUT_MS);
        socket.once('connect', () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once('error', () => {
          clearTimeout(timer);
          reject(new Unavailable());
        });
      });
    } catch (error) {
      socket.destroy();
      throw error;
    }
    socket.on('error', () => undefined);
    return socket;
  }

  private async connectClient(handlers: SharedLinkChannelHandlers): Promise<SharedLinkChannel> {
    let socket: Socket;
    try {
      socket = await this.openSocket();
    } catch (error) {
      this.winnerGone();
      throw error;
    }
    const reader = new LinkFrameReader();
    let ours = false;
    socket.on('data', (chunk: Buffer) => {
      const { frames, error } = reader.push(
        new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length),
      );
      for (const frame of frames) handlers.onFrame(frame);
      if (error !== undefined) socket.destroy();
    });
    socket.on('close', () => {
      handlers.onClose();
      if (!ours) this.winnerGone();
    });
    return {
      send: (frame) => {
        if (socket.destroyed) throw new Unavailable();
        socket.write(linkFrameBytes(frame));
      },
      close: () => {
        ours = true;
        socket.destroy();
      },
    };
  }

  /** The shared link's channel ended: re-race after a random 0 to 500 ms (D-159 (8)). */
  private winnerGone(): void {
    if (this.closed || this.current !== 'client') return;
    this.current = 'idle';
    void this.elect(this.random() * SHARED_LINK_RERACE_MAX_MS);
  }

  /**
   * A control channel: the full two-way proof, then one control frame. `reply`: the next frame;
   * `close`: 'closed' once the shared link ends the channel. Undefined on any failure.
   */
  private async control(request: string, want: 'reply' | 'close'): Promise<string | undefined> {
    let socket: Socket;
    try {
      socket = await this.openSocket();
    } catch {
      return undefined;
    }
    const reader = new LinkFrameReader();
    const frames: string[] = [];
    let waiter: (() => void) | undefined;
    let ended = false;
    socket.on('data', (chunk: Buffer) => {
      const { frames: got, error } = reader.push(
        new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length),
      );
      frames.push(...got);
      if (error !== undefined) socket.destroy();
      waiter?.();
    });
    socket.on('close', () => {
      ended = true;
      waiter?.();
    });
    const next = async (): Promise<string | undefined> => {
      const deadline = Date.now() + YIELD_WAIT_MS;
      while (frames.length === 0 && !ended) {
        const left = deadline - Date.now();
        if (left <= 0) return undefined;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, left);
          waiter = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        waiter = undefined;
      }
      return frames.shift();
    };
    try {
      const nonce = encodeHex(randomBytes(32));
      socket.write(
        linkFrameBytes(
          encodeLinkFrame({
            t: 'hello',
            v: SHARED_LINK_VERSION,
            cli: this.options.cliVersion,
            nonce,
            kind: 'aux', // a status or yield question: never counted as an ID
          }),
        ),
      );
      const challenge = decodeServerFrame(await next());
      if (
        !challenge.ok ||
        challenge.frame.t !== 'challenge' ||
        challenge.frame.v !== SHARED_LINK_VERSION ||
        !checkLinkProof(this.token, 'server', nonce, challenge.frame.nonce, challenge.frame.proof)
      ) {
        return undefined; // an endpoint that cannot prove the token learns nothing more
      }
      socket.write(
        linkFrameBytes(
          encodeLinkFrame({
            t: 'prove',
            proof: linkProof(this.token, 'client', nonce, challenge.frame.nonce),
          }),
        ),
      );
      const accept = decodeServerFrame(await next());
      if (!accept.ok || accept.frame.t !== 'accept') return undefined;
      socket.write(linkFrameBytes(request));
      if (want === 'reply') return await next();
      const deadline = Date.now() + YIELD_WAIT_MS;
      while (!ended && Date.now() < deadline) {
        frames.length = 0;
        await next();
      }
      return ended ? 'closed' : undefined;
    } finally {
      socket.destroy();
    }
  }
}

/** The built-in endpoint probe. */
function realProbe(path: string): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const timer = setTimeout(() => finish('error'), PROBE_TIMEOUT_MS);
    function finish(outcome: ProbeOutcome): void {
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    }
    socket.once('connect', () => finish('alive'));
    socket.once('error', (error) => {
      const code = codeOf(error);
      finish(code === 'ECONNREFUSED' || code === 'ENOENT' ? 'refused' : 'error');
    });
  });
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

export interface CreateRelayConnectorOptions {
  readonly home: string;
  readonly cliVersion: string;
  /** Default: process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly logger?: LinkLogger;
  /** The pool's own `mayAuthenticate` (07 §4.3). */
  readonly mayAuthenticate?: (relayUrl: string) => boolean;
}

export interface RelayConnectorChoice {
  /** For the RelayPool: FallbackConnector(shared, direct) when on, the direct connector when off. */
  readonly connector: RelayConnector;
  /** The shared link (election, hand-over, status), when on. */
  readonly link: SharedRelayLink | undefined;
  /** The client connector (its check lane: checkServed), when on. */
  readonly shared: SharedRelayConnector | undefined;
  /**
   * L4: the connector for one more RelayPool in this process (one per agent): its own client
   * connector on the link with that pool's `mayAuthenticate`, with the direct fallback; the direct
   * connector when off.
   */
  forPool(
    mayAuthenticate: (relayUrl: string) => boolean,
    options?: LinkConnectorOptions,
  ): RelayConnector;
}

/** Test seam behind createRelayConnector: the direct connector and the address check injected. */
export async function createRelayConnectorWith(
  options: CreateRelayConnectorOptions & {
    readonly direct: RelayConnector;
    readonly addressCheck: AddressCheck;
  } & EndpointPlatform,
): Promise<RelayConnectorChoice> {
  const off: RelayConnectorChoice = {
    connector: options.direct,
    link: undefined,
    shared: undefined,
    forPool: () => options.direct,
  };
  if (!sharedRelaysEnabled(options.env ?? process.env)) return off;
  const token = await ensureLinkToken(options.home).catch(() => undefined);
  if (token === undefined) {
    options.logger?.info('shared relay link not used', { reason: 'token' });
    return off;
  }
  const link = new SharedRelayLink({ ...options, token });
  const shared = link.connector();
  void link.start();
  return {
    connector: new FallbackConnector(shared, options.direct),
    link,
    shared,
    forPool: (mayAuthenticate, connectorOptions) =>
      new FallbackConnector(link.newConnector(mayAuthenticate, connectorOptions), options.direct),
  };
}

/**
 * The relay connector for a Node program's RelayPool (D-159): the shared link with a direct
 * fallback when AGENTLINK_SHARED_RELAYS is on, the direct connector when it is off (the default in
 * 0.5.18).
 */
export function createRelayConnector(
  options: CreateRelayConnectorOptions,
): Promise<RelayConnectorChoice> {
  return createRelayConnectorWith({
    home: options.home,
    cliVersion: options.cliVersion,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.mayAuthenticate === undefined ? {} : { mayAuthenticate: options.mayAuthenticate }),
    direct: nodeRelayConnector(),
    addressCheck: { resolver: nodeHostResolver() },
  });
}
