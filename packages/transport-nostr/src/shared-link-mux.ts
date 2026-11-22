// RELAY-SHARED-CONN: the shared relay link's multiplexer, as a pure state machine. The process that
// holds the per-user local endpoint hosts it (the endpoint, the election and the token file are
// built elsewhere); every other AgentLink program on the computer sends its relay traffic through it
// over the local channel (shared-link-protocol.ts), so each relay sees one connection per computer.
//
// What it does, and no more:
// - one unauthenticated upstream connection per relay, shared by every program (virtual link) that
//   opens it. An authenticated connection is never shared across IDs: the shared connection never
//   carries a login (no challenge is passed on from it, no AUTH is sent on it); when the relay answers
//   a link with `auth-required:` and its program may log in there, that link moves to a connection of
//   its own (its subscriptions are replayed there), gets that connection's challenge, and its program
//   signs its own login on it, so no other program's events or subscriptions ever ride on it;
// - subscription ids are rewritten per virtual link (`c<n>:<id>`) on REQ, COUNT and CLOSE, and the
//   prefix is stripped on EVENT, EOSE, CLOSED and COUNT, so a program never sees another's frames;
// - OK goes, by event id, only to the link(s) that sent that event or login;
// - each program signs its own login with its own key, under its own policy. Keys, seeds and
//   plaintext never cross the channel: only signed events and relay URLs do (I-1, I-2);
// - NOTICE goes to every link on that relay;
// - not an open proxy (04 §4): every relay URL is re-checked with the relay URL rule and the address
//   check (every answer globally routable, connect to the checked address), whatever the program
//   says; per-program and total caps apply;
// - a check lane (D-156 (7)): availability checks are queued per relay and batched into one `ids`
//   filter on a login-free connection of their own, at most one at a time per relay, never the
//   shared publishing connection.
//
// Frames are untrusted at both ends (I-5): size-checked before parsing, only the frame head is read,
// and nothing from a frame, no URL, sub id, event id or token is ever logged (I-7): counts only.
import { encodeHex, randomBytes, verifyNostrEvent, type NostrEvent } from '@4thtech-io/crypto';
import type { Logger } from '@4thtech-io/log';
import { isAllowedRelayUrl } from '@4thtech-io/types';
import { isGloballyRoutable } from './relay-address.js';
import type {
  AddressCheck,
  RelayConnectFailure,
  RelayConnector,
  RelaySocket,
  RelayTarget,
  Timers,
} from './relay-io.js';
import {
  CONNECT_TIMEOUT_MS,
  MAX_CONNECTIONS,
  MAX_FRAME_BYTES,
  READBACK_TIMEOUT_MS,
  relayParts,
} from './relay-pool.js';
import {
  SHARED_HANDSHAKE_TIMEOUT_MS,
  SHARED_LINK_VERSION,
  checkLinkProof,
  decodeClientFrame,
  encodeLinkFrame,
  linkProof,
  utf8Length,
  type ClientFrame,
  type SharedLinkCloseReason,
  type SharedLinkRejectReason,
  type ServerFrame,
} from './shared-link-protocol.js';

/** Programs one shared link serves at once (proved channels). */
export const SHARED_LINK_MAX_CLIENTS = 32;
/** Channels still in the handshake at once: unproved channels never take a program's place. */
export const SHARED_LINK_MAX_PENDING_HANDSHAKES = 8;
/** Virtual links one program may hold at once. */
export const SHARED_LINK_MAX_LINKS_PER_CLIENT = 4 * MAX_CONNECTIONS;
/** Subscriptions one virtual link may hold at once. */
export const SHARED_LINK_MAX_SUBS_PER_LINK = 256;
/** Availability checks one program may have queued or running at once. */
export const SHARED_LINK_MAX_CHECKS_PER_CLIENT = 64;
/** Event ids in one check-lane batch (one `ids` filter). */
export const CHECK_LANE_MAX_BATCH = 64;
/** Check connections open at once, across all relays (one per relay at most). */
export const SHARED_LINK_MAX_CHECK_SOCKETS = 64;
/** The longest subscription id sent to a relay (relays commonly refuse longer ones; NIP-01). */
export const MAX_SUB_ID_LENGTH = 64;
/** Event ids awaiting an OK on one upstream, oldest forgotten first. */
const MAX_PENDING_OKS = 4096;
const MAX_CHALLENGE_LENGTH = 256;
const HEX_32 = /^[0-9a-f]{64}$/;

/** One accepted program's end of the local channel, as the endpoint supplies it. */
export interface SharedLinkPeer {
  /** Sends one frame to the program. May throw once the channel is gone. */
  send(frame: string): void;
  /** Closes the channel. The endpoint then calls `detach` (repeats are harmless). */
  close(): void;
}

/** The mux's handle for one program: the endpoint feeds it frames and tells it when it is gone. */
export interface SharedLinkClient {
  /** One frame from the program (untrusted). */
  receive(frame: string): void;
  /**
   * The channel ended (or the program must go): frees everything the program held and closes the
   * peer. Safe to call more than once.
   */
  detach(): void;
}

export interface SharedLinkMuxOptions {
  /** Opens upstream relay connections (07 §4.2: to the checked address, no redirects, no proxy). */
  readonly connector: RelayConnector;
  /** The address check for every upstream (07 §4.2), as for a RelayPool. */
  readonly addressCheck: AddressCheck;
  /** The 32-byte secret a program must present in the handshake. */
  readonly token: Uint8Array;
  /**
   * This build's CLI version. Programs share by protocol version only (SHARED_LINK_VERSION); CLI
   * versions are counted for `doctor`, never a reason to refuse.
   */
  readonly cliVersion: string;
  readonly logger?: Logger;
  readonly timers?: Timers;
  readonly maxClients?: number;
  /** Default SHARED_LINK_MAX_PENDING_HANDSHAKES. */
  readonly maxPending?: number;
  /** Distinct relays one program may use through the link (default MAX_CONNECTIONS). */
  readonly maxRelaysPerClient?: number;
  readonly maxLinksPerClient?: number;
  /**
   * Relay connections in total, shared and own (logged-in) ones (default MAX_CONNECTIONS, 64;
   * D-159). Check connections have their own cap.
   */
  readonly maxUpstreams?: number;
}

/** Counts only (I-7). */
export interface SharedLinkStats {
  /** Channels attached, proved or not. */
  readonly clients: number;
  /**
   * IDs on this computer using the link: proved channels of ID clients (one client connector per
   * ID a program opened), never a channel still in its handshake or a short-lived `aux` one (a
   * server test, a check, a status question). The number `doctor` and the network view show.
   */
  readonly ids: number;
  /** Ready programs by CLI version. */
  readonly cliVersions: Readonly<Record<string, number>>;
  /** Relay connections, shared and own. */
  readonly upstreams: number;
  /** Of those, connections of one link that logs in there. */
  readonly ownUpstreams: number;
  readonly checkSockets: number;
  /** Virtual links refused by the relay URL rule or the address check. */
  readonly refused: number;
  /** Virtual links refused by a cap. */
  readonly limited: number;
  readonly rejectedHandshakes: number;
  readonly dropped: {
    readonly too_large: number;
    readonly malformed: number;
    readonly unknown: number;
    readonly unrouted: number;
  };
}

type DropReason = keyof SharedLinkStats['dropped'];

interface Client {
  readonly peer: SharedLinkPeer;
  state: 'hello' | 'prove' | 'ready' | 'closed';
  readonly links: Map<number, VLink>;
  helloTimer: unknown;
  /** Both handshake nonces (hex), between `hello` and `prove`. */
  nonces: { client: string; server: string } | undefined;
  checks: number;
  /** The program's CLI version, for counts only. */
  cli: string | undefined;
  /** A short-lived channel (hello `kind: aux`): never counted as an ID. */
  aux: boolean;
}

interface VLink {
  /** Unique across the mux: the `c<n>:` prefix. */
  readonly key: number;
  readonly client: Client;
  readonly id: number;
  readonly url: string;
  /** The shared connection, or this link's own one after it moved to log in. */
  upstream: Upstream;
  /** The program may log in on this relay (its `mayAuthenticate`). */
  readonly auth: boolean;
  opened: boolean;
  /** The program's sub id to the rewritten one. */
  readonly subs: Map<string, string>;
  /** The program's sub id to its rewritten REQ or COUNT frame, replayed when the link moves. */
  readonly reqs: Map<string, string>;
  /** Frames from the program while its own connection opens (bounded). */
  readonly pending: string[];
}

interface Upstream {
  readonly url: string;
  /** A connection of one link that logs in on it; never shared. */
  readonly own: boolean;
  state: 'connecting' | 'open' | 'closed';
  socket: RelaySocket | undefined;
  readonly links: Set<VLink>;
  /** Rewritten sub id to its link and the program's own id. */
  readonly subs: Map<string, { link: VLink; orig: string }>;
  readonly oks: Map<string, Set<VLink>>;
  challenge: string | undefined;
  failure: RelayConnectFailure | undefined;
  timer: unknown;
}

interface CheckRequest {
  readonly client: Client;
  readonly q: number;
  readonly id: string;
}

interface Lane {
  readonly url: string;
  readonly queue: CheckRequest[];
  running: boolean;
}

const defaultTimers: Timers = {
  setTimeout: (callback, ms) =>
    (globalThis as unknown as { setTimeout(cb: () => void, ms: number): unknown }).setTimeout(
      callback,
      ms,
    ),
  clearTimeout: (handle) =>
    (globalThis as unknown as { clearTimeout(handle: unknown): void }).clearTimeout(handle),
};

const parseFrame = (text: string): unknown[] | undefined => {
  try {
    const frame: unknown = JSON.parse(text);
    return Array.isArray(frame) && typeof frame[0] === 'string' ? frame : undefined;
  } catch {
    return undefined;
  }
};

const eventId = (value: unknown): string | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' && HEX_32.test(id) ? id : undefined;
};

/** A relay's `auth-required:` prefix (NIP-42), read on OK and CLOSED messages only. */
const authRequired = (message: unknown): boolean =>
  typeof message === 'string' && message.startsWith('auth-required:');

/** The program's own sub id for a rewritten one. */
const subOf = (link: { subs: Map<string, string> }, rewritten: string): string => {
  for (const [orig, value] of link.subs) if (value === rewritten) return orig;
  return rewritten;
};

const verifies = (event: unknown): boolean => {
  try {
    return verifyNostrEvent(event as NostrEvent);
  } catch {
    return false;
  }
};

export class SharedLinkMux {
  private readonly connector: RelayConnector;
  private readonly addressCheck: AddressCheck;
  private readonly token: Uint8Array;
  private readonly logger: Logger | undefined;
  private readonly timers: Timers;
  private readonly maxClients: number;
  private readonly maxPending: number;
  private readonly maxRelaysPerClient: number;
  private readonly maxLinksPerClient: number;
  private readonly maxUpstreams: number;
  private readonly clients = new Set<Client>();
  private readonly upstreams = new Map<string, Upstream>();
  private readonly ownUpstreams = new Set<Upstream>();
  private readonly lanes = new Map<string, Lane>();
  private checkSockets = 0;
  private linkSeq = 0;
  private checkSeq = 0;
  private closed = false;
  private counts = {
    refused: 0,
    limited: 0,
    rejectedHandshakes: 0,
    dropped: { too_large: 0, malformed: 0, unknown: 0, unrouted: 0 },
  };

  constructor(options: SharedLinkMuxOptions) {
    if (!(options.token instanceof Uint8Array) || options.token.length !== 32) {
      throw new TypeError('shared link token must be 32 bytes');
    }
    this.connector = options.connector;
    this.addressCheck = options.addressCheck;
    this.token = options.token.slice();
    this.logger = options.logger;
    this.timers = options.timers ?? defaultTimers;
    this.maxClients = options.maxClients ?? SHARED_LINK_MAX_CLIENTS;
    this.maxPending = options.maxPending ?? SHARED_LINK_MAX_PENDING_HANDSHAKES;
    this.maxRelaysPerClient = options.maxRelaysPerClient ?? MAX_CONNECTIONS;
    this.maxLinksPerClient = options.maxLinksPerClient ?? SHARED_LINK_MAX_LINKS_PER_CLIENT;
    this.maxUpstreams = options.maxUpstreams ?? MAX_CONNECTIONS;
  }

  /** Counts for `doctor` and tests. Never a URL or an id. */
  stats(): SharedLinkStats {
    // No prototype: a version string such as `constructor` is only ever a key (L-d).
    const cliVersions = Object.create(null) as Record<string, number>;
    let ids = 0;
    for (const client of this.clients) {
      if (client.state !== 'ready') continue;
      if (!client.aux) ids += 1;
      if (client.cli !== undefined) cliVersions[client.cli] = (cliVersions[client.cli] ?? 0) + 1;
    }
    return {
      clients: this.clients.size,
      ids,
      cliVersions,
      upstreams: this.upstreams.size + this.ownUpstreams.size,
      ownUpstreams: this.ownUpstreams.size,
      checkSockets: this.checkSockets,
      refused: this.counts.refused,
      limited: this.counts.limited,
      rejectedHandshakes: this.counts.rejectedHandshakes,
      dropped: { ...this.counts.dropped },
    };
  }

  /** A program connected to the endpoint. It must send `hello` first. */
  attach(peer: SharedLinkPeer): SharedLinkClient {
    const client: Client = {
      peer,
      state: 'hello',
      links: new Map(),
      helloTimer: undefined,
      nonces: undefined,
      checks: 0,
      cli: undefined,
      aux: false,
    };
    const handle: SharedLinkClient = {
      receive: (frame) => this.receive(client, frame),
      detach: () => this.detach(client),
    };
    if (this.closed || this.pendingCount() >= this.maxPending) {
      client.state = 'closed';
      this.counts.rejectedHandshakes += 1;
      this.sendTo(client, { t: 'reject', reason: 'busy' }, true);
      this.closePeer(peer);
      return handle;
    }
    this.clients.add(client);
    client.helloTimer = this.timers.setTimeout(() => {
      client.helloTimer = undefined;
      if (client.state === 'hello' || client.state === 'prove') this.reject(client, 'protocol');
    }, SHARED_HANDSHAKE_TIMEOUT_MS);
    return handle;
  }

  /** Channels still in the handshake. */
  private pendingCount(): number {
    let pending = 0;
    for (const client of this.clients) if (client.state !== 'ready') pending += 1;
    return pending;
  }

  /** Proved channels (the program cap counts these only). */
  private readyCount(): number {
    let ready = 0;
    for (const client of this.clients) if (client.state === 'ready') ready += 1;
    return ready;
  }

  /** Ends every program's channel and every upstream. */
  close(): void {
    this.closed = true;
    for (const client of [...this.clients]) {
      this.closePeer(client.peer);
      this.detach(client);
    }
  }

  // --- programs --------------------------------------------------------------------------------

  private receive(client: Client, text: string): void {
    if (client.state === 'closed') return;
    const decoded = decodeClientFrame(text);
    if (client.state === 'hello' || client.state === 'prove') {
      const wanted = client.state;
      if (!decoded.ok || decoded.frame.t !== wanted) {
        if (!decoded.ok) this.drop(decoded.reason);
        this.reject(client, 'protocol');
        return;
      }
      if (decoded.frame.t === 'hello') this.hello(client, decoded.frame);
      else if (decoded.frame.t === 'prove') this.prove(client, decoded.frame.proof);
      return;
    }
    if (!decoded.ok) {
      this.drop(decoded.reason);
      return;
    }
    const frame = decoded.frame;
    switch (frame.t) {
      case 'open':
        this.open(client, frame.link, frame.url, frame.auth ?? true);
        return;
      case 'send': {
        const link = client.links.get(frame.link);
        if (link === undefined) this.drop('unrouted');
        else this.fromProgram(link, frame.data);
        return;
      }
      case 'close': {
        const link = client.links.get(frame.link);
        if (link !== undefined) this.unlink(link);
        return;
      }
      case 'check':
        this.check(client, frame.q, frame.url, frame.id);
        return;
      default:
        this.drop('malformed'); // a second hello
    }
  }

  private hello(client: Client, frame: Extract<ClientFrame, { t: 'hello' }>): void {
    // Protocol version only (D-159): CLI versions differ between npx versions and still share.
    if (frame.v !== SHARED_LINK_VERSION) {
      this.reject(client, 'version');
      return;
    }
    client.cli = frame.cli;
    client.aux = frame.kind === 'aux';
    const serverNonce = encodeHex(randomBytes(32));
    client.nonces = { client: frame.nonce, server: serverNonce };
    client.state = 'prove';
    this.sendTo(client, {
      t: 'challenge',
      v: SHARED_LINK_VERSION,
      nonce: serverNonce,
      proof: linkProof(this.token, 'server', frame.nonce, serverNonce),
    });
  }

  private prove(client: Client, proof: string): void {
    const nonces = client.nonces;
    if (
      nonces === undefined ||
      !checkLinkProof(this.token, 'client', nonces.client, nonces.server, proof)
    ) {
      this.reject(client, 'token');
      return;
    }
    client.nonces = undefined;
    if (client.helloTimer !== undefined) this.timers.clearTimeout(client.helloTimer);
    client.helloTimer = undefined;
    if (this.readyCount() >= this.maxClients) {
      this.reject(client, 'busy');
      return;
    }
    client.state = 'ready';
    this.sendTo(client, { t: 'accept', v: SHARED_LINK_VERSION });
  }

  /** Refuses the handshake and closes the channel: nothing after it is read. */
  private reject(client: Client, reason: SharedLinkRejectReason): void {
    this.counts.rejectedHandshakes += 1;
    this.logger?.warn('shared relay link refused a program', { reason });
    this.sendTo(client, { t: 'reject', reason }, true);
    this.closePeer(client.peer);
    this.detach(client);
  }

  private detach(client: Client): void {
    if (client.state === 'closed' && !this.clients.has(client)) return;
    client.state = 'closed';
    if (client.helloTimer !== undefined) this.timers.clearTimeout(client.helloTimer);
    client.helloTimer = undefined;
    this.clients.delete(client);
    for (const link of [...client.links.values()]) this.unlink(link);
    // Its queued checks are skipped when their batch is taken; running ones answer nobody.
    this.closePeer(client.peer); // the channel ends with the program's state (repeats are harmless)
  }

  private sendTo(client: Client, frame: ServerFrame, evenIfClosed = false): void {
    if (client.state === 'closed' && !evenIfClosed) return;
    try {
      client.peer.send(encodeLinkFrame(frame));
    } catch {
      if (!evenIfClosed) {
        this.closePeer(client.peer);
        this.detach(client);
      }
    }
  }

  private closePeer(peer: SharedLinkPeer): void {
    try {
      peer.close();
    } catch {
      // a dead channel is closed already
    }
  }

  private drop(reason: DropReason): void {
    this.counts.dropped[reason] += 1;
    this.logger?.debug('shared relay link dropped a frame', { reason });
  }

  private upstreamCount(): number {
    return this.upstreams.size + this.ownUpstreams.size;
  }

  // --- virtual links -----------------------------------------------------------------------------

  private open(client: Client, id: number, url: string, auth: boolean): void {
    if (client.links.has(id)) {
      this.drop('malformed');
      return;
    }
    const closeAt = (why: SharedLinkCloseReason): void => {
      this.sendTo(client, { t: 'closed', link: id, why });
    };
    const parts = relayParts(url);
    if (!isAllowedRelayUrl(url) || parts === undefined || parts.port < 1 || parts.port > 65535) {
      this.counts.refused += 1;
      this.logger?.warn('shared relay link refused a relay', { reason: 'invalid_url' });
      closeAt('refused');
      return;
    }
    const relays = new Set([...client.links.values()].map((l) => l.url));
    if (
      client.links.size >= this.maxLinksPerClient ||
      (!relays.has(url) && relays.size >= this.maxRelaysPerClient)
    ) {
      this.counts.limited += 1;
      closeAt('limit');
      return;
    }
    let upstream = this.upstreams.get(url);
    if (upstream === undefined) {
      if (this.upstreamCount() >= this.maxUpstreams) {
        this.counts.limited += 1;
        closeAt('limit');
        return;
      }
      upstream = this.connectUpstream(url, false);
    }
    this.linkSeq = (this.linkSeq + 1) % Number.MAX_SAFE_INTEGER;
    const link: VLink = {
      key: this.linkSeq,
      client,
      id,
      url,
      upstream,
      auth,
      opened: false,
      subs: new Map(),
      reqs: new Map(),
      pending: [],
    };
    client.links.set(id, link);
    upstream.links.add(link);
    if (upstream.state === 'open') this.markOpened(link);
  }

  private markOpened(link: VLink): void {
    if (link.opened) return;
    link.opened = true;
    this.sendTo(link.client, { t: 'opened', link: link.id });
  }

  /** Leaves `upstream`: its subscriptions there end, and an upstream with no link left closes. */
  private leave(link: VLink, upstream: Upstream): void {
    if (!upstream.links.delete(link)) return;
    for (const rewritten of link.subs.values()) {
      if (upstream.subs.get(rewritten)?.link !== link) continue;
      upstream.subs.delete(rewritten);
      this.toRelay(upstream, JSON.stringify(['CLOSE', rewritten]));
    }
    for (const [id, senders] of upstream.oks) {
      senders.delete(link);
      if (senders.size === 0) upstream.oks.delete(id);
    }
    if (upstream.links.size === 0) this.endUpstream(upstream, 'closed');
  }

  /** A link ends (the program closed it, or left): its subscriptions end upstream too. */
  private unlink(link: VLink): void {
    const { client, upstream } = link;
    if (client.links.get(link.id) === link) client.links.delete(link.id);
    this.leave(link, upstream);
    link.subs.clear();
    link.reqs.clear();
    link.pending.length = 0;
  }

  /**
   * The relay asked this link's program to log in, on the shared connection. A program that may log
   * in there moves to a connection of its own (never shared, D-159), and gets that connection's
   * challenge; its subscriptions are replayed there. A program that may not stays on the shared
   * connection, which is never logged in. At the connection cap the link is closed as `limit`, so
   * its program logs in on a connection of its own at once instead of waiting for a challenge.
   */
  private moveToOwn(link: VLink): void {
    const from = link.upstream;
    if (from.own || !link.auth || from.state === 'closed') return;
    if (this.upstreamCount() >= this.maxUpstreams) {
      this.counts.limited += 1;
      if (link.client.links.get(link.id) !== link) return;
      this.unlink(link);
      this.sendTo(link.client, { t: 'closed', link: link.id, why: 'limit' });
      return;
    }
    const own = this.connectUpstream(link.url, true);
    // Keep the shared connection's pending OKs for this link: answers already on their way still
    // route to it by event id (oks are not tied to `link.upstream`).
    for (const rewritten of link.subs.values()) {
      if (from.subs.get(rewritten)?.link !== link) continue;
      from.subs.delete(rewritten);
      this.toRelay(from, JSON.stringify(['CLOSE', rewritten]));
      own.subs.set(rewritten, { link, orig: subOf(link, rewritten) });
    }
    from.links.delete(link);
    link.upstream = own;
    own.links.add(link);
    if (from.links.size === 0) this.endUpstream(from, 'closed');
  }

  private toLink(link: VLink, data: string): void {
    if (!link.opened) return;
    this.sendTo(link.client, { t: 'msg', link: link.id, data });
  }

  // --- upstream connections ----------------------------------------------------------------------

  private connectUpstream(url: string, own: boolean): Upstream {
    const upstream: Upstream = {
      url,
      own,
      state: 'connecting',
      socket: undefined,
      links: new Set(),
      subs: new Map(),
      oks: new Map(),
      challenge: undefined,
      failure: undefined,
      timer: undefined,
    };
    if (own) this.ownUpstreams.add(upstream);
    else this.upstreams.set(url, upstream);
    upstream.timer = this.timers.setTimeout(() => {
      upstream.timer = undefined;
      if (upstream.state === 'connecting') this.endUpstream(upstream, 'connect');
    }, CONNECT_TIMEOUT_MS);
    void this.resolveTarget(url).then(
      (target) => {
        if (upstream.state !== 'connecting') return;
        if (typeof target === 'string') {
          if (target === 'refused') this.counts.refused += 1;
          this.endUpstream(upstream, target);
          return;
        }
        try {
          upstream.socket = this.connector.open(target, {
            onOpen: () => this.upstreamOpened(upstream),
            onMessage: (data) => this.fromRelay(upstream, data),
            onClose: () => this.endUpstream(upstream, upstream.failure ?? 'closed'),
            onFailure: (kind) => {
              upstream.failure = kind;
            },
          });
        } catch {
          this.endUpstream(upstream, 'connect');
          return;
        }
        // A close reported while open() ran ended the upstream before the socket was stored.
        if ((upstream.state as Upstream['state']) === 'closed') this.closeSocket(upstream.socket);
      },
      () => this.endUpstream(upstream, 'connect'),
    );
    return upstream;
  }

  private upstreamOpened(upstream: Upstream): void {
    if (upstream.state !== 'connecting') return;
    upstream.state = 'open';
    if (upstream.timer !== undefined) this.timers.clearTimeout(upstream.timer);
    upstream.timer = undefined;
    for (const link of [...upstream.links]) {
      this.markOpened(link);
      if (!upstream.own) continue;
      // A link that moved here: its subscriptions again, then what it sent meanwhile.
      for (const req of link.reqs.values()) this.toRelay(upstream, req);
      for (const text of link.pending.splice(0)) this.fromProgram(link, text);
      const challenge = upstream.challenge;
      if (challenge !== undefined) this.toLink(link, JSON.stringify(['AUTH', challenge]));
    }
  }

  /** 07 §4.2 steps 1 to 3, again, here: the program's claimed address is never used. */
  private async resolveTarget(url: string): Promise<RelayTarget | 'refused' | 'connect'> {
    const parts = relayParts(url);
    if (parts === undefined) return 'refused';
    if (this.addressCheck === 'platform') {
      return { url, host: parts.host, port: parts.port, address: undefined };
    }
    let answers: readonly string[];
    try {
      answers = await this.addressCheck.resolver.resolve(parts.host);
    } catch {
      return 'connect';
    }
    if (!Array.isArray(answers) || answers.length === 0) return 'connect';
    if (!answers.every(isGloballyRoutable)) {
      this.logger?.warn('shared relay link refused a relay', { reason: 'blocked_address' });
      return 'refused';
    }
    return { url, host: parts.host, port: parts.port, address: answers[0] as string };
  }

  private endUpstream(upstream: Upstream, why: SharedLinkCloseReason): void {
    if (upstream.state === 'closed') return;
    upstream.state = 'closed';
    if (upstream.timer !== undefined) this.timers.clearTimeout(upstream.timer);
    upstream.timer = undefined;
    if (this.upstreams.get(upstream.url) === upstream) this.upstreams.delete(upstream.url);
    this.ownUpstreams.delete(upstream);
    this.closeSocket(upstream.socket);
    for (const link of [...upstream.links]) {
      upstream.links.delete(link);
      if (link.client.links.get(link.id) === link) link.client.links.delete(link.id);
      link.pending.length = 0;
      if (link.opened || !upstream.own) {
        this.sendTo(link.client, { t: 'closed', link: link.id, why });
      }
    }
    upstream.subs.clear();
    upstream.oks.clear();
  }

  private closeSocket(socket: RelaySocket | undefined): void {
    try {
      socket?.close();
    } catch {
      // closing a dead socket is not an error
    }
  }

  private toRelay(upstream: Upstream, text: string): void {
    if (upstream.state !== 'open' || upstream.socket === undefined) return;
    try {
      upstream.socket.send(text);
    } catch {
      this.endUpstream(upstream, 'closed');
    }
  }

  /** A program's relay frame: only the head is read; subscription ids are rewritten. */
  private fromProgram(link: VLink, data: string): void {
    const upstream = link.upstream;
    if (link.opened && upstream.own && upstream.state === 'connecting') {
      // Its own connection is opening: hold the frame (bounded), send it once open.
      if (link.pending.length < SHARED_LINK_MAX_SUBS_PER_LINK) link.pending.push(data);
      else this.drop('unrouted');
      return;
    }
    if (!link.opened || upstream.state !== 'open') {
      this.drop('unrouted');
      return;
    }
    const frame = parseFrame(data);
    if (frame === undefined) {
      this.drop('malformed');
      return;
    }
    switch (frame[0]) {
      case 'REQ':
      case 'COUNT': {
        const sub = frame[1];
        if (typeof sub !== 'string' || sub.length === 0) {
          this.drop('malformed');
          return;
        }
        const rewritten = `c${link.key}:${sub}`;
        if (
          rewritten.length > MAX_SUB_ID_LENGTH ||
          (!link.subs.has(sub) && link.subs.size >= SHARED_LINK_MAX_SUBS_PER_LINK)
        ) {
          this.counts.limited += 1;
          this.toLink(link, JSON.stringify(['CLOSED', sub, 'error: shared link limit']));
          return;
        }
        const text = JSON.stringify([frame[0], rewritten, ...frame.slice(2)]);
        link.subs.set(sub, rewritten);
        if (frame[0] === 'REQ') link.reqs.set(sub, text);
        upstream.subs.set(rewritten, { link, orig: sub });
        this.toRelay(upstream, text);
        return;
      }
      case 'CLOSE': {
        const sub = frame[1];
        const rewritten = typeof sub === 'string' ? link.subs.get(sub) : undefined;
        if (rewritten === undefined) {
          this.drop('unrouted');
          return;
        }
        link.subs.delete(sub as string);
        link.reqs.delete(sub as string);
        upstream.subs.delete(rewritten);
        this.toRelay(upstream, JSON.stringify(['CLOSE', rewritten]));
        return;
      }
      case 'EVENT':
      case 'AUTH': {
        const id = eventId(frame[1]);
        if (id === undefined) {
          this.drop('malformed');
          return;
        }
        if (frame[0] === 'AUTH' && !upstream.own) {
          // Never a login on the shared connection (D-159): it would cover every program on it.
          this.drop('unrouted');
          this.toLink(link, JSON.stringify(['OK', id, false, 'restricted: shared connection']));
          this.moveToOwn(link);
          return;
        }
        let senders = upstream.oks.get(id);
        if (senders === undefined) {
          if (upstream.oks.size >= MAX_PENDING_OKS) {
            upstream.oks.delete(upstream.oks.keys().next().value as string);
          }
          senders = new Set();
          upstream.oks.set(id, senders);
        }
        senders.add(link);
        this.toRelay(upstream, data); // the signed event goes on verbatim
        return;
      }
      default:
        this.drop('unknown');
    }
  }

  /** A relay frame: size-checked before parsing, then routed by its head only. */
  private fromRelay(upstream: Upstream, data: unknown): void {
    if (upstream.state !== 'open' || typeof data !== 'string') return;
    if (utf8Length(data, MAX_FRAME_BYTES) > MAX_FRAME_BYTES) {
      this.drop('too_large');
      return;
    }
    const frame = parseFrame(data);
    if (frame === undefined) {
      this.drop('malformed');
      return;
    }
    switch (frame[0]) {
      case 'EVENT':
      case 'EOSE':
      case 'CLOSED':
      case 'COUNT': {
        const sub = typeof frame[1] === 'string' ? upstream.subs.get(frame[1]) : undefined;
        if (sub === undefined) {
          this.drop('unrouted');
          return;
        }
        if (frame[0] === 'CLOSED') {
          upstream.subs.delete(frame[1] as string);
          sub.link.subs.delete(sub.orig);
          sub.link.reqs.delete(sub.orig);
        }
        this.toLink(sub.link, JSON.stringify([frame[0], sub.orig, ...frame.slice(2)]));
        if (frame[0] === 'CLOSED' && !upstream.own && authRequired(frame[2])) {
          this.moveToOwn(sub.link);
        }
        return;
      }
      case 'OK': {
        const id = typeof frame[1] === 'string' ? frame[1] : undefined;
        const senders = id === undefined ? undefined : upstream.oks.get(id);
        if (senders === undefined) {
          this.drop('unrouted');
          return;
        }
        upstream.oks.delete(id as string);
        for (const link of senders) this.toLink(link, data);
        if (!upstream.own && frame[2] === false && authRequired(frame[3])) {
          for (const link of senders) if (link.upstream === upstream) this.moveToOwn(link);
        }
        return;
      }
      case 'AUTH': {
        const challenge = frame[1];
        if (
          typeof challenge !== 'string' ||
          challenge.length === 0 ||
          challenge.length > MAX_CHALLENGE_LENGTH
        ) {
          this.drop('malformed');
          return;
        }
        // The shared connection's challenge is never passed on: nobody logs in there.
        if (!upstream.own) return;
        upstream.challenge = challenge;
        for (const link of [...upstream.links]) this.toLink(link, data);
        return;
      }
      case 'NOTICE':
        for (const link of [...upstream.links]) this.toLink(link, data);
        return;
      default:
        this.drop('unknown');
    }
  }

  // --- check lane (D-156 (7)) ----------------------------------------------------------------------

  private check(client: Client, q: number, url: string, id: string): void {
    const parts = relayParts(url);
    if (!isAllowedRelayUrl(url) || parts === undefined || parts.port < 1 || parts.port > 65535) {
      this.counts.refused += 1;
      this.sendTo(client, { t: 'checked', q, outcome: 'unchecked' });
      return;
    }
    if (client.checks >= SHARED_LINK_MAX_CHECKS_PER_CLIENT) {
      this.counts.limited += 1;
      this.sendTo(client, { t: 'checked', q, outcome: 'unchecked' });
      return;
    }
    client.checks += 1;
    let lane = this.lanes.get(url);
    if (lane === undefined) {
      lane = { url, queue: [], running: false };
      this.lanes.set(url, lane);
    }
    lane.queue.push({ client, q, id });
    if (!lane.running) this.runLane(lane);
  }

  /**
   * The next read: the program at the front of the queue, and up to CHECK_LANE_MAX_BATCH distinct
   * ids of that program only. Ids of different programs (different IDs) never share one read, so a
   * relay cannot tie their messages together by the filter (D-159, owner decision 1).
   */
  private takeBatch(lane: Lane): CheckRequest[] {
    const ids = new Set<string>();
    const taken: CheckRequest[] = [];
    const rest: CheckRequest[] = [];
    let owner: Client | undefined;
    for (const request of lane.queue) {
      if (request.client.state === 'closed') continue;
      owner ??= request.client;
      if (request.client === owner && (ids.has(request.id) || ids.size < CHECK_LANE_MAX_BATCH)) {
        ids.add(request.id);
        taken.push(request);
      } else {
        rest.push(request);
      }
    }
    lane.queue.splice(0, lane.queue.length, ...rest);
    return taken;
  }

  /**
   * `partial`: the read ended early; an id neither found nor in `partial` (a match that did not
   * verify: not evidence, so missing) is unchecked.
   */
  private answer(
    taken: readonly CheckRequest[],
    found: Map<string, string> | undefined,
    partial?: ReadonlySet<string>,
  ): void {
    for (const request of taken) {
      request.client.checks = Math.max(0, request.client.checks - 1);
      const data = found?.get(request.id);
      this.sendTo(
        request.client,
        found === undefined
          ? { t: 'checked', q: request.q, outcome: 'unchecked' }
          : data !== undefined
            ? { t: 'checked', q: request.q, outcome: 'found', data }
            : partial !== undefined && !partial.has(request.id)
              ? { t: 'checked', q: request.q, outcome: 'unchecked' }
              : { t: 'checked', q: request.q, outcome: 'missing' },
      );
    }
  }

  /** One check connection per relay at a time; the batch is taken when the connection opens. */
  private runLane(lane: Lane): void {
    lane.running = true;
    const next = (): void => {
      lane.running = false;
      if (lane.queue.some((r) => r.client.state !== 'closed')) this.runLane(lane);
      else if (this.lanes.get(lane.url) === lane) this.lanes.delete(lane.url);
    };
    if (this.checkSockets >= SHARED_LINK_MAX_CHECK_SOCKETS) {
      this.counts.limited += 1;
      this.answer(this.takeBatch(lane), undefined);
      next();
      return;
    }
    this.checkSockets += 1;
    this.checkSeq = (this.checkSeq + 1) % Number.MAX_SAFE_INTEGER;
    const subId = `k${this.checkSeq}`;
    let socket: RelaySocket | undefined;
    let taken: CheckRequest[] = [];
    let batch = new Set<string>();
    const found = new Map<string, string>();
    let events = 0;
    const forged = new Set<string>();
    let done = false;
    const finish = (outcome: 'done' | 'partial' | 'unchecked'): void => {
      if (done) return;
      done = true;
      this.timers.clearTimeout(timer);
      this.checkSockets -= 1;
      this.closeSocket(socket);
      if (taken.length === 0) taken = this.takeBatch(lane); // ended before it opened
      this.answer(
        taken,
        outcome === 'unchecked' ? undefined : found,
        outcome === 'partial' ? forged : undefined,
      );
      next();
    };
    const timer = this.timers.setTimeout(
      () => finish('unchecked'),
      CONNECT_TIMEOUT_MS + READBACK_TIMEOUT_MS,
    );
    const onOpen = (): void => {
      if (done || socket === undefined) return;
      taken = this.takeBatch(lane);
      batch = new Set(taken.map((r) => r.id));
      if (batch.size === 0) {
        finish('unchecked');
        return;
      }
      try {
        socket.send(JSON.stringify(['REQ', subId, { ids: [...batch], limit: batch.size }]));
      } catch {
        finish('unchecked');
      }
    };
    const onMessage = (data: unknown): void => {
      if (done || typeof data !== 'string') return;
      if (utf8Length(data, MAX_FRAME_BYTES) > MAX_FRAME_BYTES) {
        this.drop('too_large');
        return;
      }
      const frame = parseFrame(data);
      if (frame === undefined || frame[1] !== subId) return; // AUTH, NOTICE, others: ignored
      if (frame[0] === 'EVENT') {
        events += 1;
        const id = eventId(frame[2]);
        // Only a matching event that verifies is evidence (as in RelayPool.checkServed). The work
        // per batch is bounded: the read stops at the first match that does not verify, and after
        // as many EVENT frames as ids it asked for (its `limit`).
        if (id !== undefined && batch.has(id) && !found.has(id)) {
          if (!verifies(frame[2])) {
            forged.add(id);
            finish('partial');
            return;
          }
          found.set(id, JSON.stringify(frame[2]));
        }
        if (events >= batch.size) finish('partial');
      } else if (frame[0] === 'EOSE') finish('done');
      else if (frame[0] === 'CLOSED') finish('unchecked'); // a login wanted, or refused
    };
    void this.resolveTarget(lane.url).then(
      (target) => {
        if (done) return;
        if (typeof target === 'string') {
          finish('unchecked');
          return;
        }
        let opened = false;
        try {
          socket = this.connector.open(target, {
            onOpen: () => {
              opened = true;
              onOpen();
            },
            onMessage,
            onClose: () => finish('unchecked'),
          });
        } catch {
          finish('unchecked');
          return;
        }
        if (done) this.closeSocket(socket);
        else if (opened) onOpen(); // the upgrade completed while open() ran
      },
      () => finish('unchecked'),
    );
  }
}
