// NET-PRECHECK (04 §4 "SSRF protection"; 07 §4.2 "Relay connections", §4.3 "Use your own servers";
// 08 §1 `POST /api/ui/network/test`; I-5, I-7): the in-app server Test. The owner types up to 8
// server addresses; this module says, per address, whether AgentLink could use it, before anything
// is saved or signed.
//
// Per address, in order, and nothing further once a step refuses:
//   1. The relay URL rule on the raw string (04 §4): `wss://` only, no IP literal, no userinfo,
//      query or fragment, the 256-character cap. Local names (localhost, .local, .internal, ...)
//      are private addresses. Nothing is looked up for a refused address.
//   2. One DNS lookup; EVERY answer must be globally routable (relay-address.ts) before any socket
//      opens: no private, loopback, link-local, CGNAT, multicast or metadata address, IPv4 or IPv6.
//   3. The first answer is pinned: both WebSocket connections and the NIP-11 fetch go to that
//      address, with SNI, certificate checks and `Host` on the name (the RelayConnector and
//      Nip11Fetcher contracts, relay-io.ts). The name is never resolved again (DNS rebinding).
//   4. NIP-11, bounded: 3 s, 64 KiB, no redirects (the fetcher's contract). Only
//      `limitation.auth_required` and `limitation.payment_required` are read, each only as a JSON
//      `true`; a huge, slow or malformed document is ignored.
//   5. Connection 1 publishes one tiny kind 1059 event signed by a THROWAWAY key made and wiped
//      inside @4thtech-io/crypto (createThrowawayEvent). No ID key is ever used, and an AUTH
//      challenge is never answered, with any key.
//   6. Connection 2, fresh, reads the event back with the sync filter AgentLink uses (`#p`, kind
//      1059) and its id. A server that answers OK but does not serve the event to a new connection
//      (it drops events, or serves only the session that sent them) is refused: contacts publish
//      from their own connections and this ID reads from its own.
// Why the test EVENT and not only a REQ: a REQ shows the server speaks Nostr, not that it takes an
// event from someone who has not signed in, which is what every contact's delivery needs (a server
// that wants a sign-in to write cannot receive from contacts). The event is a throwaway: it names no
// ID and carries no message.
//
// Outcomes are a fixed enum and refusals a fixed class; no server text (OK messages, NOTICE, CLOSED
// reasons, NIP-11 fields, error text) ever reaches a result, and nothing here logs. Bounded: at most
// 8 addresses, tested in parallel, the whole run at most 15 s. PrecheckRateLimit is the per-process
// limit (10 tests a minute) the caller applies.
import {
  NOSTR_KIND_GIFT_WRAP,
  createThrowawayEvent,
  encodeHex,
  encodeUtf8,
  parseJson,
  randomBytes,
  verifyNostrEvent,
  type NostrEvent,
} from '@4thtech-io/crypto';
import { isAllowedRelayUrl } from '@4thtech-io/types';
import { TransportError } from './errors.js';
import { isGloballyRoutable } from './relay-address.js';
import type {
  HostResolver,
  Nip11Fetcher,
  RelayConnectFailure,
  RelayConnector,
  RelaySocket,
  RelayTarget,
  Timers,
} from './relay-io.js';
import { CONNECT_TIMEOUT_MS, MAX_FRAME_BYTES, NIP11_MAX_BYTES } from './relay-pool.js';

/** At most this many addresses per test (07 §4.3: an own list is 2 to 8 servers). */
export const PRECHECK_MAX_SERVERS = 8;
/** The whole test, every address in parallel, ends by this bound. */
export const PRECHECK_TOTAL_MS = 15_000;
/** The NIP-11 document's own bound (07 §4.2); its size bound is NIP11_MAX_BYTES (64 KiB). */
export const PRECHECK_NIP11_TIMEOUT_MS = 3_000;
/** A round trip above this is `slow` (still usable: it counts as ready). */
export const PRECHECK_SLOW_MS = 1_000;
/** Tests per window, per process. */
export const PRECHECK_RATE_LIMIT = 10;
export const PRECHECK_RATE_WINDOW_MS = 60_000;

/** The outcome of one address. `slow` counts as ready; the owner sees a warning. */
export type PrecheckOutcome = 'ready' | 'slow' | 'needs_sign_in' | 'needs_payment' | 'refused';

/** Why an address is refused: a fixed class, never server text. */
export type PrecheckRefusal =
  /** Not a `wss://` address. */
  | 'not_wss'
  /** An IP address instead of a name. */
  | 'ip_literal'
  /** A local name, or a DNS answer that is not publicly routable. */
  | 'private_address'
  /** Any other break of the relay URL rule (userinfo, query, fragment, length, characters). */
  | 'invalid_url'
  | 'dns_failed'
  | 'tls_failed'
  | 'connect_failed'
  | 'timeout'
  /** It answered, but not as a Nostr server (no WebSocket upgrade, or no Nostr frame at all). */
  | 'not_nostr'
  /** It refused the test event, or did not serve it back to a new connection. */
  | 'rejected_events';

/** One address's answer. Built field by field: nothing from the server. */
export interface PrecheckResult {
  /** The host name, only when the address passed the relay URL rule; else null. */
  readonly host: string | null;
  readonly outcome: PrecheckOutcome;
  /** Set exactly when `outcome` is `refused`. */
  readonly reason: PrecheckRefusal | null;
  /** Whole milliseconds of the slower of the publish and the read-back; null unless measured. */
  readonly roundTripMs: number | null;
}

/** The I/O seams (relay-io.ts). There is deliberately no key, signer or KeyStore here. */
export interface PrecheckOptions {
  readonly resolver: HostResolver;
  readonly connector: RelayConnector;
  /** NIP-11 fetcher; without one, no document is read. */
  readonly nip11?: Nip11Fetcher;
  readonly timers?: Timers;
  /** Milliseconds; default Date.now (read at call time, so fake clocks apply). */
  readonly now?: () => number;
}

/** The per-process rate limit: PRECHECK_RATE_LIMIT tests per PRECHECK_RATE_WINDOW_MS. */
export class PrecheckRateLimit {
  readonly #now: () => number;
  readonly #taken: number[] = [];

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  /** Takes one test: 0 when allowed, else the whole seconds to wait (at least 1). */
  take(): number {
    const at = this.#now();
    while (this.#taken.length > 0 && (this.#taken[0] as number) <= at - PRECHECK_RATE_WINDOW_MS) {
      this.#taken.shift();
    }
    if (this.#taken.length >= PRECHECK_RATE_LIMIT) {
      const oldest = this.#taken[0] as number;
      return Math.max(1, Math.ceil((oldest + PRECHECK_RATE_WINDOW_MS - at) / 1000));
    }
    this.#taken.push(at);
    return 0;
  }
}

const RELAY_PARTS = /^wss:\/\/([a-z0-9.-]+)(?::([0-9]+))?(?:\/.*)?$/;
const NUMERIC_LABEL = /^(?:[0-9]+|0x[0-9a-f]*)$/i;
/** Local names: a private address whatever DNS says (04 §4; RFC 6761, 6762, 8375). */
const LOCAL_NAMES = ['localhost', 'localdomain', 'local', 'internal', 'home.arpa'];
const NOSTR_FRAMES: ReadonlySet<string> = new Set([
  'OK',
  'EVENT',
  'EOSE',
  'CLOSED',
  'NOTICE',
  'AUTH',
  'COUNT',
]);

type Parsed = { readonly url: string; readonly host: string; readonly port: number };

/** Step 1: the relay URL rule on the raw string, with a refusal class a person can act on. */
function classify(raw: unknown): Parsed | PrecheckRefusal {
  if (typeof raw !== 'string') return 'invalid_url';
  if (!raw.startsWith('wss://')) return 'not_wss';
  const rest = raw.slice('wss://'.length);
  const end = rest.search(/[/?#]/);
  const authority = end === -1 ? rest : rest.slice(0, end);
  if (authority.includes('@')) return 'invalid_url';
  if (authority.startsWith('[')) return 'ip_literal';
  const colon = authority.lastIndexOf(':');
  if (authority.indexOf(':') !== colon) return 'ip_literal'; // a bare IPv6 address
  const host = (colon === -1 ? authority : authority.slice(0, colon)).toLowerCase();
  const labels = host.split('.');
  if (host !== '' && labels.every((label) => NUMERIC_LABEL.test(label))) return 'ip_literal';
  if (LOCAL_NAMES.some((name) => host === name || host.endsWith(`.${name}`))) {
    return 'private_address';
  }
  if (!isAllowedRelayUrl(raw)) return 'invalid_url';
  const m = RELAY_PARTS.exec(raw);
  if (m === null) return 'invalid_url';
  const port = m[2] === undefined ? 443 : Number(m[2]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return 'invalid_url';
  return { url: raw, host: m[1] as string, port };
}

const refused = (host: string | null, reason: PrecheckRefusal): PrecheckResult =>
  Object.freeze({ host, outcome: 'refused', reason, roundTripMs: null });

const answered = (
  host: string,
  outcome: Exclude<PrecheckOutcome, 'refused'>,
  roundTripMs: number | null,
): PrecheckResult => Object.freeze({ host, outcome, reason: null, roundTripMs });

/** NIP-11 flags: each true only for a JSON `true`; undefined for no readable document. */
function readFlags(body: unknown): { auth: boolean; payment: boolean } | undefined {
  if (typeof body !== 'string' || body.length > NIP11_MAX_BYTES) return undefined;
  if (encodeUtf8(body).length > NIP11_MAX_BYTES) return undefined;
  let doc: unknown;
  try {
    doc = parseJson(body);
  } catch {
    return undefined;
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return undefined;
  const limitation = (doc as Record<string, unknown>).limitation;
  if (typeof limitation !== 'object' || limitation === null || Array.isArray(limitation)) {
    return { auth: false, payment: false };
  }
  const l = limitation as Record<string, unknown>;
  return { auth: l.auth_required === true, payment: l.payment_required === true };
}

/** One text frame as a JSON array, size-checked before parsing; anything else is undefined. */
function frameOf(data: unknown): unknown[] | undefined {
  if (typeof data !== 'string' || data.length > MAX_FRAME_BYTES) return undefined;
  if (data.length * 3 > MAX_FRAME_BYTES && encodeUtf8(data).length > MAX_FRAME_BYTES) {
    return undefined;
  }
  try {
    const frame = parseJson(data) as unknown;
    return Array.isArray(frame) ? frame : undefined;
  } catch {
    return undefined;
  }
}

const failureReason = (kind: RelayConnectFailure | undefined): PrecheckRefusal =>
  kind === 'tls' ? 'tls_failed' : kind === 'upgrade' ? 'not_nostr' : 'connect_failed';

interface Io {
  readonly resolver: HostResolver;
  readonly connector: RelayConnector;
  readonly nip11: Nip11Fetcher | undefined;
  readonly timers: Timers;
  readonly now: () => number;
}

/** What one connection step ends with. */
type Step =
  | { readonly kind: 'ok'; readonly ms: number }
  | { readonly kind: 'sign_in' }
  | { readonly kind: 'refused'; readonly reason: PrecheckRefusal };

/** One address's test; `abort` ends it at the overall cap (closing its sockets). */
class OneTest {
  readonly #io: Io;
  readonly #sockets = new Set<RelaySocket>();
  readonly #aborters = new Set<() => void>();
  #aborted = false;

  constructor(io: Io) {
    this.#io = io;
  }

  abort(): void {
    this.#aborted = true;
    for (const stop of [...this.#aborters]) stop();
    this.#closeAll();
  }

  #closeAll(): void {
    for (const socket of this.#sockets) {
      try {
        socket.close();
      } catch {
        // closing a dead socket is not an error
      }
    }
    this.#sockets.clear();
  }

  async run(raw: unknown): Promise<PrecheckResult> {
    try {
      return await this.#run(raw);
    } finally {
      this.#closeAll();
    }
  }

  async #run(raw: unknown): Promise<PrecheckResult> {
    const parsed = classify(raw);
    if (typeof parsed === 'string') return refused(null, parsed);
    const { host } = parsed;
    // Step 2: one lookup; every answer globally routable before any socket opens.
    const answers = await this.#lookup(host);
    if (answers === 'timeout') return refused(host, 'timeout');
    if (answers === undefined) return refused(host, 'dns_failed');
    if (!Array.isArray(answers) || answers.length === 0) return refused(host, 'dns_failed');
    if (!answers.every((a) => typeof a === 'string' && isGloballyRoutable(a))) {
      return refused(host, 'private_address');
    }
    // Step 3: the pin. Every connection and the NIP-11 fetch use this one target.
    const target: RelayTarget = Object.freeze({
      url: parsed.url,
      host,
      port: parsed.port,
      address: answers[0] as string,
    });
    const flags = this.#nip11(target);
    // Step 5: the throwaway-key event.
    const event = createThrowawayEvent((pubkey) => ({
      kind: NOSTR_KIND_GIFT_WRAP,
      created_at: Math.floor(this.#io.now() / 1000),
      tags: [['p', pubkey]],
      content: encodeHex(randomBytes(16)),
    }));
    const published = await this.#publish(target, event);
    let readBack: Step | undefined;
    if (published.kind === 'ok') readBack = await this.#readBack(target, event);
    const doc = await flags;
    const step = readBack ?? published;
    if (step.kind === 'refused') {
      if (step.reason === 'rejected_events' && doc?.payment === true) {
        return answered(host, 'needs_payment', null);
      }
      return refused(host, step.reason);
    }
    if (doc?.payment === true) return answered(host, 'needs_payment', null);
    if (step.kind === 'sign_in') return answered(host, 'needs_sign_in', null);
    const ms = Math.max(published.kind === 'ok' ? published.ms : 0, step.ms);
    if (doc?.auth === true) return answered(host, 'needs_sign_in', ms);
    return answered(host, ms > PRECHECK_SLOW_MS ? 'slow' : 'ready', ms);
  }

  /** Step 2's lookup; it ends at the overall cap even if the resolver never answers. */
  #lookup(host: string): Promise<readonly string[] | undefined | 'timeout'> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: readonly string[] | undefined | 'timeout'): void => {
        if (done) return;
        done = true;
        this.#aborters.delete(stop);
        resolve(value);
      };
      const stop = (): void => finish('timeout');
      if (this.#aborted) {
        finish('timeout');
        return;
      }
      this.#aborters.add(stop);
      try {
        this.#io.resolver.resolve(host).then(
          (answers) => finish(answers),
          () => finish(undefined),
        );
      } catch {
        finish(undefined);
      }
    });
  }

  /** Step 4: NIP-11, bounded in time; never rejects; undefined for no readable document. */
  #nip11(target: RelayTarget): Promise<{ auth: boolean; payment: boolean } | undefined> {
    const fetcher = this.#io.nip11;
    if (fetcher === undefined) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: { auth: boolean; payment: boolean } | undefined): void => {
        if (done) return;
        done = true;
        this.#io.timers.clearTimeout(timer);
        this.#aborters.delete(stop);
        resolve(value);
      };
      const stop = (): void => finish(undefined);
      this.#aborters.add(stop);
      const timer = this.#io.timers.setTimeout(stop, PRECHECK_NIP11_TIMEOUT_MS);
      try {
        fetcher.fetch(target, { maxBytes: NIP11_MAX_BYTES }).then(
          (body) => finish(readFlags(body)),
          () => finish(undefined),
        );
      } catch {
        finish(undefined);
      }
    });
  }

  /**
   * One connection to the pinned target: `onOpen` sends the step's frame, `onFrame` decides. Ends
   * with the step's answer; a close before an answer, a failed open or the connect bound end it too.
   */
  #connect(
    target: RelayTarget,
    begin: (socket: RelaySocket) => void,
    onFrame: (frame: unknown[], end: (step: Step) => void) => void,
    silence: (spokeNostr: boolean, authSeen: boolean) => Step,
  ): Promise<Step> {
    if (this.#aborted) return Promise.resolve(refusal('timeout'));
    return new Promise((resolve) => {
      let done = false;
      let opened = false;
      let failure: RelayConnectFailure | undefined;
      let spokeNostr = false;
      let authSeen = false;
      let socket: RelaySocket | undefined;
      const end = (step: Step): void => {
        if (done) return;
        done = true;
        this.#io.timers.clearTimeout(connectTimer);
        this.#aborters.delete(stop);
        if (socket !== undefined) {
          this.#sockets.delete(socket);
          try {
            socket.close();
          } catch {
            // closing a dead socket is not an error
          }
        }
        resolve(step);
      };
      // At the overall cap: nothing Nostr-like ever came back is not_nostr, else a timeout.
      const stop = (): void => end(opened ? silence(spokeNostr, authSeen) : refusal('timeout'));
      this.#aborters.add(stop);
      const connectTimer = this.#io.timers.setTimeout(() => {
        if (!opened) end(refusal('timeout'));
      }, CONNECT_TIMEOUT_MS);
      try {
        socket = this.#io.connector.open(target, {
          onOpen: () => {
            if (done || opened || socket === undefined) return;
            opened = true;
            try {
              begin(socket);
            } catch {
              end(refusal('connect_failed'));
            }
          },
          onMessage: (data) => {
            if (done || !opened) return;
            const frame = frameOf(data);
            if (frame === undefined || typeof frame[0] !== 'string') return;
            if (!NOSTR_FRAMES.has(frame[0])) return;
            spokeNostr = true;
            // NIP-42: noted, never answered (no key of any kind signs an AUTH here).
            if (frame[0] === 'AUTH') authSeen = true;
            onFrame(frame, end);
          },
          onFailure: (kind) => {
            if (!opened && failure === undefined) failure = kind;
          },
          onClose: () => {
            if (opened) end(authSeen ? { kind: 'sign_in' } : refusal('connect_failed'));
            else end(refusal(failureReason(failure)));
          },
        });
      } catch {
        end(refusal('connect_failed'));
        return;
      }
      if (done) {
        try {
          socket.close();
        } catch {
          // closing a dead socket is not an error
        }
        return;
      }
      this.#sockets.add(socket);
      // The upgrade may have completed while open() ran (a synchronous connector).
    });
  }

  /** Connection 1: publish the throwaway event and wait for its OK. */
  #publish(target: RelayTarget, event: NostrEvent): Promise<Step> {
    let sentAt = 0;
    return this.#connect(
      target,
      (socket) => {
        sentAt = this.#io.now();
        socket.send(JSON.stringify(['EVENT', event]));
      },
      (frame, end) => {
        if (frame[0] !== 'OK' || frame[1] !== event.id) return;
        if (frame[2] === true) {
          end({ kind: 'ok', ms: Math.max(0, Math.round(this.#io.now() - sentAt)) });
          return;
        }
        // Only the machine-readable prefix is read (NIP-01); the rest is never kept.
        const signIn = typeof frame[3] === 'string' && frame[3].startsWith('auth-required:');
        end(signIn ? { kind: 'sign_in' } : refusal('rejected_events'));
      },
      (spokeNostr, authSeen) =>
        authSeen ? { kind: 'sign_in' } : refusal(spokeNostr ? 'timeout' : 'not_nostr'),
    );
  }

  /** Connection 2, fresh: the event must come back by its id under the sync filter. */
  #readBack(target: RelayTarget, event: NostrEvent): Promise<Step> {
    const subId = `t${encodeHex(randomBytes(4))}`;
    let sentAt = 0;
    let served = false;
    return this.#connect(
      target,
      (socket) => {
        sentAt = this.#io.now();
        socket.send(
          JSON.stringify([
            'REQ',
            subId,
            { ids: [event.id], kinds: [NOSTR_KIND_GIFT_WRAP], '#p': [event.pubkey], limit: 1 },
          ]),
        );
      },
      (frame, end) => {
        if (frame[1] !== subId) return;
        if (frame[0] === 'EVENT') {
          const got = frame[2] as NostrEvent | undefined;
          if (typeof got === 'object' && got !== null && got.id === event.id && verifies(got)) {
            served = true;
          }
        } else if (frame[0] === 'EOSE') {
          end(
            served
              ? { kind: 'ok', ms: Math.max(0, Math.round(this.#io.now() - sentAt)) }
              : refusal('rejected_events'),
          );
        } else if (frame[0] === 'CLOSED') {
          const signIn = typeof frame[2] === 'string' && frame[2].startsWith('auth-required:');
          end(signIn ? { kind: 'sign_in' } : refusal('rejected_events'));
        }
      },
      (_spokeNostr, authSeen) => (authSeen ? { kind: 'sign_in' } : refusal('timeout')),
    );
  }
}

const refusal = (reason: PrecheckRefusal): Step => ({ kind: 'refused', reason });

function verifies(event: NostrEvent): boolean {
  try {
    return verifyNostrEvent(event);
  } catch {
    return false;
  }
}

/** Read at call time, so fake clocks apply (as the pool's). This package has no Node types. */
const defaultTimers: Timers = {
  setTimeout: (callback, ms) =>
    (globalThis as unknown as { setTimeout(cb: () => void, ms: number): unknown }).setTimeout(
      callback,
      ms,
    ),
  clearTimeout: (handle) =>
    (globalThis as unknown as { clearTimeout(handle: unknown): void }).clearTimeout(handle),
};

/**
 * Tests each of `urls` (1 to PRECHECK_MAX_SERVERS entries, as typed; non-strings are refused as
 * `invalid_url`) and answers one result per entry, in order. Never rejects for a server's behaviour;
 * a list that is not an array of 1 to 8 entries is a TransportError (`invalid_argument`).
 */
export async function precheckServers(
  urls: readonly unknown[],
  options: PrecheckOptions,
): Promise<readonly PrecheckResult[]> {
  if (!Array.isArray(urls) || urls.length === 0 || urls.length > PRECHECK_MAX_SERVERS) {
    throw new TransportError('invalid_argument', 'server test: 1 to 8 addresses');
  }
  const io: Io = {
    resolver: options.resolver,
    connector: options.connector,
    nip11: options.nip11,
    timers: options.timers ?? defaultTimers,
    now: options.now ?? (() => Date.now()),
  };
  const tests = urls.map(() => new OneTest(io));
  const timer = io.timers.setTimeout(() => {
    for (const test of tests) test.abort();
  }, PRECHECK_TOTAL_MS);
  try {
    // Every step of a test ends when it is aborted, so each run settles by the cap.
    return await Promise.all(
      tests.map((test, i) =>
        test.run(urls[i]).catch(() => {
          const parsed = classify(urls[i]);
          return refused(typeof parsed === 'string' ? null : parsed.host, 'connect_failed');
        }),
      ),
    );
  } finally {
    io.timers.clearTimeout(timer);
  }
}
