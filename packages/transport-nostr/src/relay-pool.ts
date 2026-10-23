// M1-5b: the relay pool (07 §4.2, §4.3). It owns WebSocket connections to relays and publishes one
// signed event to an explicit relay list. What it does not do: choose the list (core gives it, per
// recipient key, 07 §4.3), wrap or sign (M1-5a), persist or retry (outbox.ts), or subscribe (sync.ts,
// M1-5c; the pool exposes the parsed inbound frames through onFrame and a pinned link per relay
// through connect).
//
// Safety properties, each with a test:
// - Relay SSRF (04 §4, 07 §4.2): every connect, and every reconnect, resolves the host, refuses the
//   relay unless EVERY answer is globally routable, and hands the connector the checked address. The
//   NIP-11 fetch uses the same checked target.
// - Inbound frames above 131 072 bytes are dropped before the JSON parser sees them (04 §3.1.1).
// - Bounds (07 §4.3): at most 64 open connections, idle ones closed after 5 minutes, a relay that has
//   not connected within 10 s is skipped for that attempt. Attempts run concurrently, so black-hole
//   relays of one send never delay another send.
// - I-5, I-7: relay-sent text (OK messages, NOTICE, NIP-11 fields) is untrusted and never logged,
//   returned or put into an error; only a fixed reason code leaves this module. Logs name a relay by
//   host only (a relay URL path can carry a credential) and never carry event content.
import {
  NOSTR_KIND_AUTH,
  encodeUtf8,
  parseJson,
  type EnvelopeKeys,
  type NostrEvent,
} from '@4thtech-io/crypto';
import type { Logger } from '@4thtech-io/log';
import { isAllowedRelayUrl } from '@4thtech-io/types';
import { TransportError } from './errors.js';
import { isGloballyRoutable } from './relay-address.js';
import type {
  AddressCheck,
  Nip11Fetcher,
  RelayConnector,
  RelaySocket,
  RelayTarget,
  Timers,
} from './relay-io.js';

/** 04 §3.1.1 (G-2): inbound relay frames are at most 128 KiB, checked on the raw message. */
export const MAX_FRAME_BYTES = 131_072;
/** 07 §4.3: at most 64 open connections in the agent pool. */
export const MAX_CONNECTIONS = 64;
/** 07 §4.3: a connection idle for 5 minutes is closed. */
export const IDLE_CLOSE_MS = 5 * 60 * 1000;
/** 07 §4.3: a relay that has not connected within 10 s is skipped for that attempt. */
export const CONNECT_TIMEOUT_MS = 10_000;
/** How long a relay may take to answer an EVENT or an AUTH with OK. */
export const OK_TIMEOUT_MS = 10_000;
/** 07 §4.3: at most 32 relays per wrap. */
export const MAX_RELAYS_PER_WRAP = 32;
/** 07 §4.2: a wrap is delivered once 2 relays return OK. */
export const MIN_ACKS = 2;
/** The NIP-11 document is read only up to this size. */
export const NIP11_MAX_BYTES = 65_536;
/** 07 §4.2 (M1-5b-c): the NIP-11 wait has its own bound, inside the 10 s connect budget. */
export const NIP11_TIMEOUT_MS = 3_000;
const NIP11_TTL_MS = 60 * 60 * 1000;
const NIP11_FAILURE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 512;
const MAX_CHALLENGE_LENGTH = 256;
const HEX_32 = /^[0-9a-f]{64}$/;
const RELAY_PARTS = /^wss:\/\/([a-z0-9.-]+)(?::([0-9]+))?(?:\/.*)?$/;

/** Why a relay did not return OK for one publish. A fixed set: relay text never reaches a caller. */
export type RelayFailure =
  | 'invalid_url'
  | 'blocked_address'
  | 'resolve_failed'
  | 'connect_failed'
  | 'connect_timeout'
  | 'pool_full'
  | 'too_large'
  | 'rejected'
  | 'ok_timeout'
  | 'auth_failed'
  | 'closed'
  /** The pool itself was closed (not a bad URL, not a dropped connection). */
  | 'pool_closed';

/** The outcome for one relay. */
export interface RelayPublishResult {
  readonly relay: string;
  readonly ok: boolean;
  readonly reason: 'ok' | RelayFailure;
}

/** The outcome of publishing one event to one relay list. */
export interface PublishOutcome {
  readonly results: readonly RelayPublishResult[];
  /** The relays that returned OK. */
  readonly acked: readonly string[];
  /** True when at least MIN_ACKS relays of the list returned OK (07 §4.2). */
  readonly sent: boolean;
}

/** Per-relay health, for the activity feed and `doctor`. No event content. */
export interface RelayHealth {
  readonly relay: string;
  readonly connected: boolean;
  readonly successes: number;
  readonly failures: number;
  /** Unix milliseconds of the last OK, or undefined. */
  readonly lastOkAt: number | undefined;
  readonly lastFailure: RelayFailure | undefined;
  /** The relay's NIP-11 `max_message_length`, when it published one. */
  readonly maxMessageLength: number | undefined;
}

/** A parsed inbound frame from a relay, for M1-5c. Its content is untrusted (I-5). */
export type FrameListener = (relay: string, frame: readonly unknown[]) => void;

/** Called when a pooled connection ends, for any reason (the relay URL only). */
export type CloseListener = (relay: string) => void;

/**
 * A pinned connection to one relay for a subscription (M1-5c). While a link is held the idle timer
 * does not close the connection and it is not evicted. Release it when the subscription ends.
 */
export interface RelayLink {
  /** Sends one text frame. False if the connection is gone or the send failed. */
  send(text: string): boolean;
  /** NIP-42 login with the pool's `authKeys`, only on a relay `mayAuthenticate` allows. */
  authenticate(): Promise<boolean>;
  /** True while the underlying connection is open. */
  isOpen(): boolean;
  /** Unpins the connection. Safe to call more than once. */
  release(): void;
}

export interface RelayPoolOptions {
  readonly connector: RelayConnector;
  /** How relay addresses are checked (07 §4.2). Required: skipping the check must be a named choice. */
  readonly addressCheck: AddressCheck;
  /** NIP-11 fetcher. Without one, no relay is skipped for size by this pool. */
  readonly nip11?: Nip11Fetcher;
  /**
   * Signs NIP-42 AUTH (kind 22242): the agent's KeyStore, or an OwnerSession on owner surfaces.
   * Without it, a relay that demands AUTH is skipped. AUTH is signed only when a relay asks for it,
   * so a relay that does not need it never learns the key.
   */
  readonly authKeys?: EnvelopeKeys;
  /**
   * True for a relay where this pool may log in with `authKeys`. Deny by default (07 §4.3: the owner
   * key never logs in on a relay that is only in a contact's list): with no hook, no login is ever
   * signed, so a caller must say which relays are its own.
   */
  readonly mayAuthenticate?: (relayUrl: string) => boolean;
  readonly logger?: Logger;
  /** Clock in Unix milliseconds (default: the wall clock). */
  readonly now?: () => number;
  /** Timers (default: the global ones, read at call time so fake timers apply). */
  readonly timers?: Timers;
}

interface Waiter {
  (outcome: 'ok' | 'rejected' | 'auth_required' | 'closed'): void;
}

interface Connection {
  readonly url: string;
  state: 'connecting' | 'open' | 'closed';
  socket: RelaySocket | undefined;
  /** Resolves undefined once open, or the reason it did not open. */
  ready: Promise<RelayFailure | undefined>;
  inflight: number;
  lastUsed: number;
  idleTimer: unknown;
  waiters: Map<string, Waiter[]>;
  challenge: string | undefined;
  challengeWaiters: ((challenge: string | undefined) => void)[];
  authenticatedChallenge: string | undefined;
  onOpen: (() => void) | undefined;
  onEarlyClose: (() => void) | undefined;
}

interface Health {
  successes: number;
  failures: number;
  lastOkAt: number | undefined;
  lastFailure: RelayFailure | undefined;
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

/** UTF-8 length of a string, without encoding it when the answer is already clear. */
function utf8Length(text: string, limit: number): number {
  if (text.length > limit) return text.length; // at least one byte per UTF-16 unit: over the limit
  if (text.length * 3 <= limit) return text.length * 3; // an upper bound that is within the limit
  return encodeUtf8(text).length;
}

/** `limitation.max_message_length` of a NIP-11 document, if it is a positive safe integer. */
function readMaxMessageLength(doc: unknown): number | undefined {
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObject(doc) || !isObject(doc.limitation)) return undefined;
  const value = doc.limitation.max_message_length;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** `wss://host[:port]` of a relay URL: what health output and the activity feed may show. */
function relayOrigin(url: string): string {
  const m = RELAY_PARTS.exec(url);
  if (m === null) return 'wss://invalid';
  return m[2] === undefined ? `wss://${m[1] as string}` : `wss://${m[1] as string}:${m[2]}`;
}

/** Splits a validated relay URL into host and port without a URL parser (04 §4). */
function relayParts(url: string): { host: string; port: number } | undefined {
  const m = RELAY_PARTS.exec(url);
  if (m === null) return undefined;
  return { host: m[1] as string, port: m[2] === undefined ? 443 : Number(m[2]) };
}

export class RelayPool {
  private readonly connector: RelayConnector;
  private readonly addressCheck: AddressCheck;
  private readonly nip11: Nip11Fetcher | undefined;
  private readonly authKeys: EnvelopeKeys | undefined;
  private readonly mayAuthenticate: (relayUrl: string) => boolean;
  private readonly logger: Logger | undefined;
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly conns = new Map<string, Connection>();
  private readonly health = new Map<string, Health>();
  private readonly limits = new Map<string, { limit: number | undefined; at: number }>();
  private readonly listeners = new Set<FrameListener>();
  private readonly closeListeners = new Set<CloseListener>();
  private closed = false;

  constructor(options: RelayPoolOptions) {
    this.connector = options.connector;
    this.addressCheck = options.addressCheck;
    this.nip11 = options.nip11;
    this.authKeys = options.authKeys;
    this.mayAuthenticate = options.mayAuthenticate ?? (() => false);
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
    this.timers = options.timers ?? defaultTimers;
  }

  /**
   * Publishes `event` to exactly the relays in `relays` and to no other (07 §4.3). All attempts run
   * concurrently. Never rejects for a relay problem: each relay's outcome is in the result.
   * @throws TransportError `invalid_relays` for an empty list or one over 32 entries.
   */
  async publish(event: NostrEvent, relays: readonly string[]): Promise<PublishOutcome> {
    if (!Array.isArray(relays) || relays.length === 0 || relays.length > MAX_RELAYS_PER_WRAP) {
      throw new TransportError('invalid_relays', 'relay list must hold 1 to 32 relays');
    }
    const unique = [...new Set(relays)];
    const frame = JSON.stringify(['EVENT', event]);
    const frameBytes = encodeUtf8(frame).length;
    const results = await Promise.all(
      unique.map((relay) => this.publishOne(event, frame, frameBytes, relay)),
    );
    const acked = results.filter((r) => r.ok).map((r) => r.relay);
    return { results, acked, sent: acked.length >= MIN_ACKS };
  }

  /** Per-relay health for every relay seen so far. */
  relayHealth(): readonly RelayHealth[] {
    return [...this.health.entries()].map(([relay, h]) => ({
      relay: relayOrigin(relay), // origin only: no path or query (07 §4.3, the logger's URL rule)
      connected: this.conns.get(relay)?.state === 'open',
      successes: h.successes,
      failures: h.failures,
      lastOkAt: h.lastOkAt,
      lastFailure: h.lastFailure,
      maxMessageLength: this.limits.get(relay)?.limit,
    }));
  }

  /** True once close() has been called. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Open or opening connections. */
  get connectionCount(): number {
    return this.conns.size;
  }

  /** Parsed inbound frames (after the 128 KiB check), for subscribers. Returns the unsubscribe. */
  onFrame(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Notified when a pooled connection ends (the relay URL only). Returns the unsubscribe. */
  onRelayClose(listener: CloseListener): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  /**
   * Opens (or reuses) the connection to `relay` and pins it for a subscription (07 §4.2, M1-5c).
   * The same checks as a publish apply: URL rule, relay SSRF check on every connect, 64-connection
   * bound, 10 s connect budget. Returns the link, or the fixed reason it is not available.
   */
  async connect(relay: string): Promise<RelayLink | RelayFailure> {
    if (this.closed) return 'pool_closed';
    if (!isAllowedRelayUrl(relay) || relayParts(relay) === undefined) return 'invalid_url';
    const conn = this.acquire(relay);
    if (typeof conn === 'string') return conn;
    conn.inflight += 1;
    let failure: RelayFailure | undefined;
    try {
      failure = await conn.ready;
    } catch {
      failure = 'connect_failed';
    }
    if (failure !== undefined || conn.state !== 'open') {
      conn.inflight -= 1;
      this.touch(conn);
      this.record(relay, failure ?? 'closed');
      return failure ?? 'closed';
    }
    let released = false;
    return {
      send: (text) => {
        if (conn.state !== 'open' || conn.socket === undefined) return false;
        try {
          conn.socket.send(text);
          return true;
        } catch {
          return false;
        }
      },
      authenticate: () =>
        conn.state === 'open' ? this.authenticate(conn) : Promise.resolve(false),
      isOpen: () => conn.state === 'open',
      release: () => {
        if (released) return;
        released = true;
        conn.inflight -= 1;
        this.touch(conn);
      },
    };
  }

  /** Closes every connection. The pool refuses new publishes afterwards. */
  close(): void {
    this.closed = true;
    for (const conn of [...this.conns.values()]) this.drop(conn);
  }

  // --- publish ---------------------------------------------------------------------------------

  private async publishOne(
    event: NostrEvent,
    frame: string,
    frameBytes: number,
    relay: string,
  ): Promise<RelayPublishResult> {
    let reason: 'ok' | RelayFailure;
    try {
      reason = await this.attempt(event, frame, frameBytes, relay);
    } catch {
      reason = 'closed'; // a connector or timer fault: never a throw to the caller, never its text
    }
    this.record(relay, reason);
    return { relay, ok: reason === 'ok', reason };
  }

  private async attempt(
    event: NostrEvent,
    frame: string,
    frameBytes: number,
    relay: string,
  ): Promise<'ok' | RelayFailure> {
    if (this.closed) return 'pool_closed';
    if (!isAllowedRelayUrl(relay) || relayParts(relay) === undefined) return 'invalid_url';
    if (this.tooLarge(relay, frameBytes)) return 'too_large';
    const conn = this.acquire(relay);
    if (typeof conn === 'string') return conn;
    conn.inflight += 1;
    try {
      const failure = await conn.ready;
      if (failure !== undefined) return failure;
      if (this.tooLarge(relay, frameBytes)) return 'too_large'; // learned from NIP-11 while connecting
      let outcome = await this.request(conn, event.id, frame);
      if (outcome === 'auth_required') {
        if (!(await this.authenticate(conn))) return 'auth_failed';
        outcome = await this.request(conn, event.id, frame);
      }
      if (outcome === 'ok') return 'ok';
      if (outcome === 'closed') return 'closed';
      if (outcome === 'auth_required') return 'auth_failed';
      return outcome === 'rejected' ? 'rejected' : 'ok_timeout';
    } finally {
      conn.inflight -= 1;
      this.touch(conn);
    }
  }

  private tooLarge(relay: string, frameBytes: number): boolean {
    const limit = this.limits.get(relay)?.limit;
    return limit !== undefined && limit < frameBytes;
  }

  /** Sends one frame that the relay answers with ["OK", id, ...]; resolves with the classified answer. */
  private request(
    conn: Connection,
    id: string,
    frame: string,
  ): Promise<'ok' | 'rejected' | 'auth_required' | 'closed' | 'timeout'> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (
        outcome: 'ok' | 'rejected' | 'auth_required' | 'closed' | 'timeout',
      ): void => {
        if (done) return;
        done = true;
        this.timers.clearTimeout(timer);
        const list = conn.waiters.get(id)?.filter((w) => w !== waiter) ?? [];
        if (list.length === 0) conn.waiters.delete(id);
        else conn.waiters.set(id, list);
        resolve(outcome);
      };
      const waiter: Waiter = (outcome) => finish(outcome);
      const timer = this.timers.setTimeout(() => finish('timeout'), OK_TIMEOUT_MS);
      conn.waiters.set(id, [...(conn.waiters.get(id) ?? []), waiter]);
      try {
        if (conn.state !== 'open' || conn.socket === undefined) finish('closed');
        else conn.socket.send(frame);
      } catch {
        finish('closed');
      }
    });
  }

  // --- NIP-42 ----------------------------------------------------------------------------------

  /** Logs in with a challenge-signed kind 22242 event (NIP-42), signed through EnvelopeKeys.signNostr. */
  private async authenticate(conn: Connection): Promise<boolean> {
    const keys = this.authKeys;
    if (keys === undefined || !this.mayAuthenticate(conn.url)) return false;
    const challenge = conn.challenge ?? (await this.waitForChallenge(conn));
    if (challenge === undefined) return false;
    if (conn.authenticatedChallenge === challenge) return true;
    let signed: NostrEvent;
    try {
      signed = await keys.signNostr({
        kind: NOSTR_KIND_AUTH,
        created_at: Math.floor(this.now() / 1000),
        tags: [
          ['relay', conn.url],
          ['challenge', challenge],
        ],
        content: '',
      });
    } catch {
      return false; // a locked or expired OwnerSession, for example
    }
    const outcome = await this.request(conn, signed.id, JSON.stringify(['AUTH', signed]));
    if (outcome !== 'ok') return false;
    conn.authenticatedChallenge = challenge;
    return true;
  }

  private waitForChallenge(conn: Connection): Promise<string | undefined> {
    return new Promise((resolve) => {
      const waiter = (challenge: string | undefined): void => {
        this.timers.clearTimeout(timer);
        resolve(challenge);
      };
      const timer = this.timers.setTimeout(() => {
        const at = conn.challengeWaiters.indexOf(waiter);
        if (at !== -1) conn.challengeWaiters.splice(at, 1); // no stale waiter on a long-lived connection
        resolve(undefined);
      }, OK_TIMEOUT_MS);
      conn.challengeWaiters.push(waiter);
    });
  }

  // --- connections -----------------------------------------------------------------------------

  /** The pooled connection for `url`, opening one if needed; or the reason it cannot. */
  private acquire(url: string): Connection | 'pool_full' {
    const existing = this.conns.get(url);
    if (existing !== undefined && existing.state !== 'closed') {
      existing.lastUsed = this.now();
      return existing;
    }
    if (this.conns.size >= MAX_CONNECTIONS) {
      const idle = [...this.conns.values()]
        .filter((c) => c.inflight === 0)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (idle === undefined) return 'pool_full';
      this.drop(idle);
    }
    const conn: Connection = {
      url,
      state: 'connecting',
      socket: undefined,
      ready: Promise.resolve(undefined),
      inflight: 0,
      lastUsed: this.now(),
      idleTimer: undefined,
      waiters: new Map(),
      challenge: undefined,
      challengeWaiters: [],
      authenticatedChallenge: undefined,
      onOpen: undefined,
      onEarlyClose: undefined,
    };
    this.conns.set(url, conn);
    conn.ready = this.establish(conn);
    this.touch(conn);
    return conn;
  }

  /** Resolve, check, open, and (in parallel) read NIP-11, all inside the 10 s connect budget. */
  private establish(conn: Connection): Promise<RelayFailure | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (failure: RelayFailure | undefined): void => {
        if (settled) return;
        settled = true;
        this.timers.clearTimeout(timer);
        if (failure !== undefined) this.drop(conn);
        resolve(failure);
      };
      const timer = this.timers.setTimeout(() => settle('connect_timeout'), CONNECT_TIMEOUT_MS);
      void this.openSocket(conn).then(settle, () => settle('connect_failed'));
    });
  }

  private async openSocket(conn: Connection): Promise<RelayFailure | undefined> {
    const target = await this.resolveTarget(conn.url);
    if (typeof target === 'string') return target;
    if (conn.state === 'closed') return 'connect_failed'; // timed out or evicted while resolving
    const opened = new Promise<boolean>((resolve) => {
      conn.onOpen = () => resolve(true);
      conn.onEarlyClose = () => resolve(false);
    });
    conn.socket = this.connector.open(target, {
      onOpen: () => {
        if (conn.state !== 'connecting') return;
        conn.state = 'open';
        conn.onOpen?.();
      },
      onMessage: (data) => this.handleMessage(conn, data),
      onClose: () => this.handleClosed(conn),
    });
    const [isOpen] = await Promise.all([opened, this.loadLimit(target)]);
    return isOpen ? undefined : 'connect_failed';
  }

  /** 07 §4.2 steps 1 to 3: resolve, require every answer to be globally routable, pin the address. */
  private async resolveTarget(url: string): Promise<RelayTarget | RelayFailure> {
    const parts = relayParts(url);
    if (parts === undefined || parts.port < 1 || parts.port > 65535) return 'invalid_url';
    if (this.addressCheck === 'platform') {
      return { url, host: parts.host, port: parts.port, address: undefined };
    }
    let answers: readonly string[];
    try {
      answers = await this.addressCheck.resolver.resolve(parts.host);
    } catch {
      this.logger?.warn('relay skipped', { reason: 'resolve_failed', host: parts.host });
      return 'resolve_failed';
    }
    if (!Array.isArray(answers) || answers.length === 0) {
      this.logger?.warn('relay skipped', { reason: 'resolve_failed', host: parts.host });
      return 'resolve_failed';
    }
    if (!answers.every(isGloballyRoutable)) {
      // Names the relay, never the address (07 §4.2 step 2).
      this.logger?.warn('relay skipped', { reason: 'blocked_address', host: parts.host });
      return 'blocked_address';
    }
    return { url, host: parts.host, port: parts.port, address: answers[0] as string };
  }

  /** Reads and caches `limitation.max_message_length` of the NIP-11 document. Never rejects. */
  private async loadLimit(target: RelayTarget): Promise<void> {
    const fetcher = this.nip11;
    if (fetcher === undefined) return;
    const cached = this.limits.get(target.url);
    if (cached !== undefined) {
      const ttl = cached.limit === undefined ? NIP11_FAILURE_TTL_MS : NIP11_TTL_MS;
      if (this.now() - cached.at < ttl) return;
    }
    let limit: number | undefined;
    try {
      const body = await this.boundedFetch(fetcher, target);
      if (typeof body === 'string' && utf8Length(body, NIP11_MAX_BYTES) <= NIP11_MAX_BYTES) {
        const value = readMaxMessageLength(parseJson(body));
        if (value !== undefined) limit = value;
      }
    } catch {
      limit = undefined; // an unreadable document: the limit stays unknown, the relay may reject
    }
    if (this.limits.size >= MAX_CACHE_ENTRIES)
      this.limits.delete(this.limits.keys().next().value as string);
    this.limits.set(target.url, { limit, at: this.now() });
  }

  /**
   * The NIP-11 fetch, bounded in time: after NIP11_TIMEOUT_MS the wait ends with no document, so a
   * hanging HTTP server cannot make a working relay miss the publish's connect budget. A late answer
   * is ignored. The size bound is passed on and checked again on the result.
   */
  private boundedFetch(fetcher: Nip11Fetcher, target: RelayTarget): Promise<string | undefined> {
    return new Promise((resolve) => {
      const timer = this.timers.setTimeout(() => resolve(undefined), NIP11_TIMEOUT_MS);
      const done = (body: string | undefined): void => {
        this.timers.clearTimeout(timer);
        resolve(body);
      };
      try {
        fetcher.fetch(target, { maxBytes: NIP11_MAX_BYTES }).then(done, () => done(undefined));
      } catch {
        done(undefined);
      }
    });
  }

  private touch(conn: Connection): void {
    if (conn.state === 'closed') return;
    if (conn.idleTimer !== undefined) this.timers.clearTimeout(conn.idleTimer);
    conn.idleTimer = this.timers.setTimeout(() => {
      conn.idleTimer = undefined;
      if (conn.inflight > 0) this.touch(conn);
      else this.drop(conn);
    }, IDLE_CLOSE_MS);
  }

  /** Closes a connection and forgets it. Pending requests end as `closed`. */
  private drop(conn: Connection): void {
    if (conn.state === 'closed') return;
    conn.state = 'closed';
    if (conn.idleTimer !== undefined) this.timers.clearTimeout(conn.idleTimer);
    conn.idleTimer = undefined;
    if (this.conns.get(conn.url) === conn) this.conns.delete(conn.url);
    try {
      conn.socket?.close();
    } catch {
      // closing a dead socket is not an error
    }
    conn.onEarlyClose?.();
    for (const list of [...conn.waiters.values()]) for (const w of [...list]) w('closed');
    for (const w of conn.challengeWaiters.splice(0)) w(undefined);
    for (const listener of [...this.closeListeners]) {
      try {
        listener(conn.url);
      } catch {
        // a subscriber's fault does not stop the pool
      }
    }
  }

  private handleClosed(conn: Connection): void {
    this.drop(conn);
  }

  // --- inbound frames --------------------------------------------------------------------------

  /** One raw WebSocket message: size-checked on the string, before it is parsed (04 §3.1.1). */
  private handleMessage(conn: Connection, data: unknown): void {
    if (conn.state === 'closed' || typeof data !== 'string') return; // Nostr frames are text
    if (utf8Length(data, MAX_FRAME_BYTES) > MAX_FRAME_BYTES) {
      this.logger?.warn('relay frame dropped', { reason: 'frame_too_large' });
      return;
    }
    let frame: unknown;
    try {
      frame = parseJson(data);
    } catch {
      return; // malformed JSON from a relay: dropped, nothing logged from it
    }
    if (!Array.isArray(frame) || typeof frame[0] !== 'string') return;
    this.touch(conn);
    switch (frame[0]) {
      case 'OK':
        this.handleOk(conn, frame);
        return;
      case 'AUTH':
        this.handleAuth(conn, frame);
        return;
      default:
        for (const listener of [...this.listeners]) {
          try {
            listener(conn.url, frame);
          } catch {
            // a subscriber's fault does not stop the pool
          }
        }
    }
  }

  private handleOk(conn: Connection, frame: readonly unknown[]): void {
    const [, id, accepted, message] = frame;
    if (frame.length < 3 || typeof id !== 'string' || !HEX_32.test(id)) return;
    if (typeof accepted !== 'boolean') return;
    const waiters = conn.waiters.get(id);
    if (waiters === undefined) return;
    const text = typeof message === 'string' ? message : '';
    // Only a fixed prefix is read from the relay's text (NIP-01, NIP-42); the rest is ignored.
    const outcome = accepted
      ? 'ok'
      : text.startsWith('auth-required:')
        ? 'auth_required'
        : 'rejected';
    for (const waiter of [...waiters]) waiter(outcome);
  }

  private handleAuth(conn: Connection, frame: readonly unknown[]): void {
    const challenge = frame[1];
    if (
      typeof challenge !== 'string' ||
      challenge.length === 0 ||
      challenge.length > MAX_CHALLENGE_LENGTH
    ) {
      return;
    }
    conn.challenge = challenge;
    for (const waiter of conn.challengeWaiters.splice(0)) waiter(challenge);
  }

  // --- health ----------------------------------------------------------------------------------

  private record(relay: string, reason: 'ok' | RelayFailure): void {
    let h = this.health.get(relay);
    if (h === undefined) {
      if (this.health.size >= MAX_CACHE_ENTRIES) {
        this.health.delete(this.health.keys().next().value as string);
      }
      h = { successes: 0, failures: 0, lastOkAt: undefined, lastFailure: undefined };
      this.health.set(relay, h);
    }
    if (reason === 'ok') {
      h.successes += 1;
      h.lastOkAt = this.now();
    } else {
      h.failures += 1;
      h.lastFailure = reason;
    }
  }
}
