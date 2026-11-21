// RELAY-SHARED-CONN: the client side of the shared relay link. A `RelayConnector` (relay-io.ts) whose
// sockets are virtual: each carries one relay's frames over the local channel to the shared link
// (shared-link-mux.ts), so the RelayPool above it is unchanged: it still signs its own NIP-42 logins
// with its own keys under its own `mayAuthenticate`, verifies every event and applies its limits.
//
// Pure and transport-agnostic: the channel (a Unix socket or a named pipe, with the endpoint checks of
// 04 §4 "Local relay link") is injected as a `SharedLinkDialer`. When the shared link cannot be used
// (no endpoint, a version mismatch, a wrong token proof, a stalled handshake, a cap, the channel
// going away), `FallbackConnector` hands the socket to the program's own direct connector instead,
// which is the behaviour before D-159. Nothing from a frame, no URL, id or token is logged (I-7).
import { encodeHex, randomBytes, verifyNostrEvent, type NostrEvent } from '@4thtech-io/crypto';
import type { Logger } from '@4thtech-io/log';
import { isAllowedRelayUrl } from '@4thtech-io/types';
import type {
  RelayConnector,
  RelaySocket,
  RelaySocketHandlers,
  RelayTarget,
  Timers,
} from './relay-io.js';
import {
  CONNECT_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  READBACK_QUEUE_WAIT_MS,
  READBACK_TIMEOUT_MS,
  type ReadbackOptions,
  type ReadbackOutcome,
} from './relay-pool.js';
import {
  SHARED_HANDSHAKE_TIMEOUT_MS,
  SHARED_LINK_VERSION,
  checkLinkProof,
  decodeServerFrame,
  encodeLinkFrame,
  linkProof,
  utf8Length,
  type ClientFrame,
  type ServerFrame,
} from './shared-link-protocol.js';

export { SHARED_HANDSHAKE_TIMEOUT_MS } from './shared-link-protocol.js';

/** After the shared link failed (not refused), new sockets go direct for this long before a retry. */
export const SHARED_LINK_RETRY_MS = 30_000;

/** What the channel reports. Frames are whole frames (the endpoint does the length prefix). */
export interface SharedLinkChannelHandlers {
  onFrame(frame: string): void;
  /** The channel ended, for any reason. Repeats are harmless. */
  onClose(): void;
}

/** One open channel to the shared link. */
export interface SharedLinkChannel {
  /** Sends one frame. May throw once the channel is gone. */
  send(frame: string): void;
  close(): void;
}

/**
 * Connects to the shared link's endpoint (after the endpoint checks of 04 §4) and returns the channel;
 * throws when there is none. Frames and the close are reported through `handlers`, never before
 * this call has returned.
 */
export type SharedLinkDialer = (handlers: SharedLinkChannelHandlers) => SharedLinkChannel;

/**
 * `idle` (not dialled yet), `connecting` (handshake), `ready`, `down` (failed; retried after
 * SHARED_LINK_RETRY_MS), `refused` (version mismatch or a failed token proof: never retried).
 */
export type SharedLinkState = 'idle' | 'connecting' | 'ready' | 'down' | 'refused';

/** `unavailable`: the shared link cannot be used; check on a connection of the program's own. */
export type SharedCheckOutcome = ReadbackOutcome | 'unavailable';

/** Thrown by `open` when the shared link cannot be used. Fixed text, never a URL (I-7). */
export class SharedLinkUnavailable extends Error {
  constructor() {
    super('shared relay link unavailable');
    this.name = 'SharedLinkUnavailable';
  }
}

export interface SharedRelayConnectorOptions {
  readonly dial: SharedLinkDialer;
  /** The 32-byte token from the run folder (04 §4). It is never sent; only proofs are. */
  readonly token: Uint8Array;
  readonly cliVersion: string;
  readonly logger?: Logger;
  readonly timers?: Timers;
  /** Clock in Unix milliseconds (default: the wall clock). */
  readonly now?: () => number;
  /** Default SHARED_HANDSHAKE_TIMEOUT_MS. */
  readonly handshakeTimeoutMs?: number;
  /** Default SHARED_LINK_RETRY_MS. */
  readonly retryAfterMs?: number;
  /**
   * The pool's own `mayAuthenticate` (07 §4.3). A relay where it says no is never given a
   * connection of its own for a login. Absent: every relay may be (the link then decides on demand).
   */
  readonly mayAuthenticate?: (relayUrl: string) => boolean;
}

type Fallback = (handlers: RelaySocketHandlers) => RelaySocket;

interface Link {
  readonly id: number;
  readonly url: string;
  readonly handlers: RelaySocketHandlers;
  readonly fallback: Fallback | undefined;
  readonly socket: VirtualSocket;
  sentOpen: boolean;
  opened: boolean;
}

interface PendingCheck {
  readonly q: number;
  readonly url: string;
  readonly id: string;
  sent: boolean;
  readonly settle: (answer: Extract<ServerFrame, { t: 'checked' }> | SharedCheckOutcome) => void;
}

const HEX_32 = /^[0-9a-f]{64}$/;

const defaultTimers: Timers = {
  setTimeout: (callback, ms) =>
    (globalThis as unknown as { setTimeout(cb: () => void, ms: number): unknown }).setTimeout(
      callback,
      ms,
    ),
  clearTimeout: (handle) =>
    (globalThis as unknown as { clearTimeout(handle: unknown): void }).clearTimeout(handle),
};

/** The socket the pool holds: virtual on the shared link, or the direct one after a fallback. */
class VirtualSocket implements RelaySocket {
  inner: RelaySocket | undefined;
  closed = false;

  constructor(
    private readonly owner: SharedRelayConnector,
    private readonly linkId: () => number,
  ) {}

  send(text: string): void {
    if (this.inner !== undefined) {
      this.inner.send(text);
      return;
    }
    if (this.closed || typeof text !== 'string') throw new SharedLinkUnavailable();
    if (utf8Length(text, MAX_FRAME_BYTES) > MAX_FRAME_BYTES) {
      throw new RangeError('relay frame too large');
    }
    this.owner.sendOnLink(this.linkId(), text);
  }

  close(): void {
    if (this.inner !== undefined) {
      this.inner.close();
      return;
    }
    if (this.closed) return;
    this.closed = true;
    this.owner.closeLink(this.linkId());
  }
}

export class SharedRelayConnector implements RelayConnector {
  private readonly dial: SharedLinkDialer;
  private readonly token: Uint8Array;
  private readonly cliVersion: string;
  private readonly logger: Logger | undefined;
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly handshakeTimeoutMs: number;
  private readonly retryAfterMs: number;
  private readonly mayAuthenticate: ((relayUrl: string) => boolean) | undefined;
  private current: SharedLinkState = 'idle';
  private channel: SharedLinkChannel | undefined;
  private nonce: string | undefined;
  private proved = false;
  private handshakeTimer: unknown;
  private downAt = 0;
  private linkSeq = 0;
  private checkSeq = 0;
  private readonly links = new Map<number, Link>();
  private readonly checks = new Map<number, PendingCheck>();

  constructor(options: SharedRelayConnectorOptions) {
    if (!(options.token instanceof Uint8Array) || options.token.length !== 32) {
      throw new TypeError('shared link token must be 32 bytes');
    }
    this.dial = options.dial;
    this.token = options.token.slice();
    this.cliVersion = options.cliVersion;
    this.logger = options.logger;
    this.timers = options.timers ?? defaultTimers;
    this.now = options.now ?? (() => Date.now());
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? SHARED_HANDSHAKE_TIMEOUT_MS;
    this.retryAfterMs = options.retryAfterMs ?? SHARED_LINK_RETRY_MS;
    this.mayAuthenticate = options.mayAuthenticate;
  }

  get state(): SharedLinkState {
    return this.current;
  }

  /** RelayConnector: a virtual socket on the shared link. Throws SharedLinkUnavailable if unusable. */
  open(target: RelayTarget, handlers: RelaySocketHandlers): RelaySocket {
    return this.openOr(target, handlers, undefined);
  }

  /**
   * Like `open`, but whenever the shared link cannot carry this socket before it opened (unusable
   * now, the handshake fails, a cap on the link), `fallback` opens it instead with the same handlers.
   */
  openOr(
    target: RelayTarget,
    handlers: RelaySocketHandlers,
    fallback: Fallback | undefined,
  ): RelaySocket {
    if (!this.usable()) {
      if (fallback === undefined) throw new SharedLinkUnavailable();
      return fallback(handlers);
    }
    this.linkSeq = (this.linkSeq + 1) % 2 ** 31 || 1;
    const id = this.linkSeq;
    const socket = new VirtualSocket(this, () => id);
    const link: Link = {
      id,
      url: target.url,
      handlers,
      fallback,
      socket,
      sentOpen: false,
      opened: false,
    };
    this.links.set(id, link);
    if (this.current === 'ready') this.sendOpen(link);
    return socket;
  }

  /**
   * The availability check through the shared link's check lane (D-156 (7), D-159 (9)): never on a
   * publishing connection, never logged in; the answer is verified here (I-5). `unavailable` when
   * the shared link cannot be used. Never rejects.
   */
  checkServed(
    relay: string,
    eventId: string,
    options: ReadbackOptions = {},
  ): Promise<SharedCheckOutcome> {
    if (typeof eventId !== 'string' || !HEX_32.test(eventId) || !isAllowedRelayUrl(relay)) {
      return Promise.resolve('unchecked');
    }
    const signal = options.signal;
    if (signal?.aborted === true) return Promise.resolve('unchecked');
    if (!this.usable()) return Promise.resolve('unavailable');
    this.checkSeq = (this.checkSeq + 1) % 2 ** 31 || 1;
    const q = this.checkSeq;
    return new Promise<SharedCheckOutcome>((resolve) => {
      let done = false;
      const onAbort = (): void => settle('unchecked');
      const settle = (
        answer: Extract<ServerFrame, { t: 'checked' }> | SharedCheckOutcome,
      ): void => {
        if (done) return;
        done = true;
        this.timers.clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.checks.delete(q);
        resolve(typeof answer === 'string' ? answer : readAnswer(answer, eventId));
      };
      const timer = this.timers.setTimeout(
        () => settle('unchecked'),
        READBACK_QUEUE_WAIT_MS + CONNECT_TIMEOUT_MS + READBACK_TIMEOUT_MS,
      );
      signal?.addEventListener('abort', onAbort);
      const check: PendingCheck = { q, url: relay, id: eventId, sent: false, settle };
      this.checks.set(q, check);
      if (this.current === 'ready') this.sendCheck(check);
    });
  }

  /** Ends the channel; open virtual sockets close. */
  close(): void {
    this.fail('down', 'closed');
  }

  // --- used by VirtualSocket ---------------------------------------------------------------------

  /** @internal */
  sendOnLink(id: number, data: string): void {
    const link = this.links.get(id);
    if (link === undefined || !link.opened || this.current !== 'ready') {
      throw new SharedLinkUnavailable();
    }
    this.send({ t: 'send', link: id, data }, true);
  }

  /** @internal */
  closeLink(id: number): void {
    const link = this.links.get(id);
    if (link === undefined) return;
    this.links.delete(id);
    if (link.sentOpen && this.current === 'ready') this.send({ t: 'close', link: id });
  }

  // --- channel ---------------------------------------------------------------------------------

  /** True when the shared link is ready or being set up; dials when it is time to (again). */
  private usable(): boolean {
    switch (this.current) {
      case 'ready':
      case 'connecting':
        return true;
      case 'refused':
        return false;
      case 'down':
        if (this.now() - this.downAt < this.retryAfterMs) return false;
        return this.connect();
      default:
        return this.connect();
    }
  }

  private connect(): boolean {
    this.current = 'connecting';
    this.proved = false;
    this.nonce = encodeHex(randomBytes(32));
    let channel: SharedLinkChannel | undefined;
    const handlers: SharedLinkChannelHandlers = {
      onFrame: (frame) => {
        if (this.channel === channel) this.onFrame(frame);
      },
      onClose: () => {
        if (this.channel === channel) this.fail('down', 'closed');
      },
    };
    try {
      channel = this.dial(handlers);
    } catch {
      this.markDown('no_endpoint');
      return false;
    }
    this.channel = channel;
    this.handshakeTimer = this.timers.setTimeout(() => {
      this.handshakeTimer = undefined;
      if (this.current === 'connecting') this.fail('down', 'stalled');
    }, this.handshakeTimeoutMs);
    return this.send({
      t: 'hello',
      v: SHARED_LINK_VERSION,
      cli: this.cliVersion,
      nonce: this.nonce,
    });
  }

  private markDown(reason: string): void {
    this.current = 'down';
    this.downAt = this.now();
    this.logger?.info('shared relay link not used', { reason });
  }

  /** Sends a frame; a failed send ends the channel. `rethrow` for a socket's own send. */
  private send(frame: ClientFrame, rethrow = false): boolean {
    const channel = this.channel;
    if (channel === undefined) {
      if (rethrow) throw new SharedLinkUnavailable();
      return false;
    }
    try {
      channel.send(encodeLinkFrame(frame));
      return true;
    } catch {
      this.fail('down', 'closed');
      if (rethrow) throw new SharedLinkUnavailable();
      return false;
    }
  }

  private sendOpen(link: Link): void {
    link.sentOpen = true;
    let auth: boolean;
    try {
      auth = this.mayAuthenticate?.(link.url) ?? true;
    } catch {
      auth = false; // a failing policy hook never grants a login
    }
    this.send({ t: 'open', link: link.id, url: link.url, auth: auth === true });
  }

  private sendCheck(check: PendingCheck): void {
    check.sent = true;
    this.send({ t: 'check', q: check.q, url: check.url, id: check.id });
  }

  private onFrame(text: string): void {
    const decoded = decodeServerFrame(text);
    if (!decoded.ok) {
      this.logger?.debug('shared relay link dropped a frame', { reason: decoded.reason });
      if (this.current === 'connecting') this.fail('down', 'protocol');
      return;
    }
    const frame = decoded.frame;
    if (this.current === 'connecting') {
      this.handshake(frame);
      return;
    }
    if (this.current !== 'ready') return;
    switch (frame.t) {
      case 'opened': {
        const link = this.links.get(frame.link);
        if (link === undefined || link.opened) return;
        link.opened = true;
        link.handlers.onOpen();
        return;
      }
      case 'msg': {
        const link = this.links.get(frame.link);
        if (link?.opened === true) link.handlers.onMessage(frame.data);
        return;
      }
      case 'closed': {
        const link = this.links.get(frame.link);
        if (link === undefined) return;
        this.links.delete(frame.link);
        if (!link.opened && frame.why === 'limit' && this.toFallback(link)) return;
        this.endLink(link, frame.why === 'closed' ? undefined : frame.why);
        return;
      }
      case 'checked':
        this.checks.get(frame.q)?.settle(frame);
        return;
      default:
        return; // a second handshake frame: ignored
    }
  }

  private handshake(frame: ServerFrame): void {
    const nonce = this.nonce;
    if (frame.t === 'reject') {
      const refused = frame.reason === 'version' || frame.reason === 'token';
      this.fail(refused ? 'refused' : 'down', frame.reason);
      return;
    }
    if (frame.t === 'challenge' && !this.proved && nonce !== undefined) {
      if (
        frame.v !== SHARED_LINK_VERSION ||
        !checkLinkProof(this.token, 'server', nonce, frame.nonce, frame.proof)
      ) {
        // An endpoint that cannot prove the token learns nothing more and gets nothing more.
        this.fail('refused', frame.v !== SHARED_LINK_VERSION ? 'version' : 'token');
        return;
      }
      this.proved = true;
      this.send({ t: 'prove', proof: linkProof(this.token, 'client', nonce, frame.nonce) });
      return;
    }
    if (frame.t === 'accept' && this.proved && frame.v === SHARED_LINK_VERSION) {
      this.current = 'ready';
      this.nonce = undefined;
      if (this.handshakeTimer !== undefined) this.timers.clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
      for (const link of [...this.links.values()]) if (!link.sentOpen) this.sendOpen(link);
      for (const check of [...this.checks.values()]) if (!check.sent) this.sendCheck(check);
      return;
    }
    this.fail('down', 'protocol');
  }

  /** The shared link ends: sockets that never opened go to their fallback, the others close. */
  private fail(state: 'down' | 'refused', reason: string): void {
    const wasReady = this.current === 'ready';
    if (this.current === 'refused' && state === 'down') state = 'refused';
    if (this.handshakeTimer !== undefined) this.timers.clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
    const channel = this.channel;
    this.channel = undefined;
    this.nonce = undefined;
    this.proved = false;
    if (state === 'refused') {
      this.current = 'refused';
      this.logger?.info('shared relay link not used', { reason });
    } else this.markDown(reason);
    try {
      channel?.close();
    } catch {
      // a dead channel is closed already
    }
    const links = [...this.links.values()];
    this.links.clear();
    for (const link of links) {
      if (!link.opened && this.toFallback(link)) continue;
      this.endLink(link, link.opened ? undefined : 'connect');
    }
    for (const check of [...this.checks.values()]) {
      check.settle(wasReady && check.sent ? 'unchecked' : 'unavailable');
    }
  }

  private toFallback(link: Link): boolean {
    if (link.fallback === undefined || link.socket.closed) return false;
    try {
      link.socket.inner = link.fallback(link.handlers);
      return true;
    } catch {
      return false;
    }
  }

  private endLink(
    link: Link,
    failure: 'refused' | 'limit' | 'tls' | 'upgrade' | 'connect' | undefined,
  ): void {
    link.socket.closed = true;
    try {
      if (!link.opened && failure !== undefined) {
        link.handlers.onFailure?.(failure === 'tls' || failure === 'upgrade' ? failure : 'connect');
      }
      link.handlers.onClose();
    } catch {
      // a handler's fault does not stop the connector
    }
  }
}

/** The check lane's answer, verified here: only a matching event that verifies is evidence. */
function readAnswer(
  answer: Extract<ServerFrame, { t: 'checked' }>,
  eventId: string,
): ReadbackOutcome {
  if (answer.outcome === 'unchecked') return 'unchecked';
  if (answer.outcome === 'missing' || answer.data === undefined) return 'missing';
  try {
    const event = JSON.parse(answer.data) as NostrEvent;
    return typeof event === 'object' &&
      event !== null &&
      event.id === eventId &&
      verifyNostrEvent(event)
      ? 'served'
      : 'missing';
  } catch {
    return 'missing';
  }
}

/**
 * The connector a program's RelayPool uses with the shared link on: the shared link when it can
 * carry the socket, the program's own direct connector otherwise (D-159 (7)).
 */
export class FallbackConnector implements RelayConnector {
  constructor(
    private readonly shared: SharedRelayConnector,
    private readonly direct: RelayConnector,
  ) {}

  open(target: RelayTarget, handlers: RelaySocketHandlers): RelaySocket {
    return this.shared.openOr(target, handlers, (h) => this.direct.open(target, h));
  }
}
