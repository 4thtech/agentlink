// NET-PRECHECK (04 §4 "SSRF protection"; 07 §4.2 "Relay connections", §4.3 "Use your own servers";
// 08 §1 `POST /api/ui/network/test`; I-5, I-7): the in-app server Test. The owner types up to 8
// server addresses; this module says, per address, whether AgentLink could use it, before anything
// is saved or signed.
//
// Per address, in order, and nothing further once a step refuses (D-158 (4); 07 §4.3 "The test"):
//   1. The relay URL rule on the raw string (04 §4): `wss://` only, no IP literal, no userinfo,
//      query or fragment, the 256-character cap; local names (localhost, .local, .internal, ...)
//      too. A refused address is `not_allowed`, and nothing is looked up for it.
//   2. One DNS lookup; EVERY answer must be globally routable (relay-address.ts) before any socket
//      opens: no private, loopback, link-local, CGNAT, multicast or metadata address, IPv4 or IPv6
//      (`not_allowed`).
//   3. The first answer is pinned: both WebSocket connections and the NIP-11 fetch go to that
//      address, with SNI, certificate checks and `Host` on the name (the RelayConnector and
//      Nip11Fetcher contracts, relay-io.ts). The name is never resolved again (DNS rebinding).
//   4. NIP-11, bounded: 3 s, 64 KiB, no redirects (the fetcher's contract). Only
//      `limitation.auth_required`, `payment_required` (each only as a JSON `true`) and
//      `max_message_length` are read; a limit below the largest wrap is `too_small`; a huge, slow
//      or malformed document is ignored.
//   5. Connection 1 publishes one tiny kind 1059 event signed by a THROWAWAY key made and wiped
//      inside @4thtech-io/crypto (createThrowawayEvent), with a NIP-40 expiration. It must be
//      accepted (`OK`) without a login, because contacts publish without one: a refusal, or a
//      demand to log in first, is `not_accepted`. No ID key is ever used, and an AUTH challenge is
//      never answered, with any key.
//   6. Connection 2, fresh and unauthenticated, makes the two reads: the event's id (`limit: 1`)
//      and the sync filter AgentLink uses (`kinds: [1059]`, `#p` the throwaway key). Both must
//      serve it, else `not_kept`; a read that wants a login is `sign_in`. With the shared relay
//      link on (D-159 (9)), the event is first asked for by its id in the link's check lane
//      (`checkServed`): `missing` there is `not_kept`; any other answer leaves these reads in charge.
//      Connection 2 is always the program's own (`openOwn` when the connector has one), never a
//      virtual socket on the link, so the reads never ride the upstream that wrote the event.
// Why the test EVENT and not only a REQ: a REQ shows the server speaks Nostr, not that it takes an
// event from someone who has not signed in, which is what every contact's delivery needs. The
// event is a throwaway: it names no ID and carries no message.
//
// Outcomes and reasons are the fixed sets of 07 §4.3 and 08 §1; `signInRequired` and
// `paymentRequired` are the warning flags beside the outcome. No server text (OK messages, NOTICE,
// CLOSED reasons, NIP-11 fields, error text) ever reaches a result, and nothing here logs.
// Bounded: at most 8 addresses (duplicates tested once), in parallel, each at most 10 s.
// PrecheckRateLimit is the rate limit (10 tests a minute) the caller applies.
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
/** Each address's test ends by this bound (07 §4.3: 10 s per server); all run in parallel. */
export const PRECHECK_SERVER_TIMEOUT_MS = 10_000;
/**
 * The smallest NIP-11 `max_message_length` that carries AgentLink's largest valid gift wrap as an
 * EVENT frame (about 88 KB; 04 §3.1.1). Below it: `too_small`.
 */
export const PRECHECK_MIN_MESSAGE_LENGTH = 90_112;
/** The test event's NIP-40 expiration, after its created_at: servers may drop it then. */
export const PRECHECK_EVENT_EXPIRY_SECONDS = 600;
/** The NIP-11 document's own bound (07 §4.2); its size bound is NIP11_MAX_BYTES (64 KiB). */
export const PRECHECK_NIP11_TIMEOUT_MS = 3_000;
/** A round trip above this is `slow` (still usable: it counts as ready). */
export const PRECHECK_SLOW_MS = 1_000;
/** Tests per window, per process. */
export const PRECHECK_RATE_LIMIT = 10;
export const PRECHECK_RATE_WINDOW_MS = 60_000;

/** The outcome of one address (07 §4.3). `slow` counts as ready; `sign_in` is allowed with a warning. */
export type PrecheckOutcome = 'ready' | 'slow' | 'sign_in' | 'refused';

/** Why an address is refused (07 §4.3, 08 §1): a fixed class, never server text. */
export type PrecheckRefusal =
  /** It refused the test event, or wants a login to accept it (contacts publish without one). */
  | 'not_accepted'
  /** It accepted the test event but did not serve it back to a new connection. */
  | 'not_kept'
  /** No lookup, connection or answer within the bound (DNS, TLS, connect, timeout). */
  | 'unreachable'
  /** The relay URL rule or the address check (IP literal, local name, private DNS answer). */
  | 'not_allowed'
  /** Its NIP-11 message limit is below the largest wrap. */
  | 'too_small'
  /** It answered, but not as a Nostr server (no WebSocket upgrade, or no Nostr frame at all). */
  | 'invalid';

/** One address's answer. Built field by field: nothing from the server. */
export interface PrecheckResult {
  /** The origin host (`:port` only when not 443), only when the address passed the URL rule. */
  readonly host: string | null;
  readonly outcome: PrecheckOutcome;
  /** Set exactly when `outcome` is `refused`. */
  readonly reason: PrecheckRefusal | null;
  /** Whole milliseconds of the slower of the publish and the reads; null unless measured. */
  readonly roundTripMs: number | null;
  /** A read wanted a login, or NIP-11 `auth_required`; null when nothing could tell. */
  readonly signInRequired: boolean | null;
  /** NIP-11 `payment_required` (a warning only); null without a readable document. */
  readonly paymentRequired: boolean | null;
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
  /**
   * RELAY-SHARED-CONN (D-159 (9); 07 §4.2 "Check lane"): the shared link's check lane, when it is
   * on. After the write, the event is asked for by its id there (never on the connection that wrote
   * it); `missing` is `not_kept`. Any other answer leaves the fresh reads (step 6) in charge.
   */
  readonly checkServed?: (
    relay: string,
    eventId: string,
  ) => Promise<'served' | 'missing' | 'unchecked' | 'unavailable'>;
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

type Parsed = {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  /** What a result shows: the host, `:port` only when not 443 (as the network view). */
  readonly display: string;
};

/** Step 1: the relay URL rule on the raw string, with a refusal class a person can act on. */
function classify(raw: unknown): Parsed | 'not_allowed' {
  if (typeof raw !== 'string') return 'not_allowed';
  if (!raw.startsWith('wss://')) return 'not_allowed';
  const rest = raw.slice('wss://'.length);
  const end = rest.search(/[/?#]/);
  const authority = end === -1 ? rest : rest.slice(0, end);
  if (authority.includes('@')) return 'not_allowed';
  if (authority.startsWith('[')) return 'not_allowed';
  const colon = authority.lastIndexOf(':');
  if (authority.indexOf(':') !== colon) return 'not_allowed'; // a bare IPv6 address
  const host = (colon === -1 ? authority : authority.slice(0, colon)).toLowerCase();
  const labels = host.split('.');
  if (host !== '' && labels.every((label) => NUMERIC_LABEL.test(label))) return 'not_allowed';
  if (LOCAL_NAMES.some((name) => host === name || host.endsWith(`.${name}`))) {
    return 'not_allowed';
  }
  if (!isAllowedRelayUrl(raw)) return 'not_allowed';
  const m = RELAY_PARTS.exec(raw);
  if (m === null) return 'not_allowed';
  const port = m[2] === undefined ? 443 : Number(m[2]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return 'not_allowed';
  const name = m[1] as string;
  return { url: raw, host: name, port, display: port === 443 ? name : `${name}:${port}` };
}

type Flags = { readonly auth: boolean; readonly payment: boolean; readonly maxLength?: number };

const refused = (host: string | null, reason: PrecheckRefusal, doc?: Flags): PrecheckResult =>
  Object.freeze({
    host,
    outcome: 'refused',
    reason,
    roundTripMs: null,
    signInRequired: doc === undefined ? null : doc.auth,
    paymentRequired: doc === undefined ? null : doc.payment,
  });

const answered = (
  host: string,
  outcome: Exclude<PrecheckOutcome, 'refused'>,
  roundTripMs: number | null,
  signInRequired: boolean,
  doc: Flags | undefined,
): PrecheckResult =>
  Object.freeze({
    host,
    outcome,
    reason: null,
    roundTripMs,
    signInRequired,
    paymentRequired: doc === undefined ? null : doc.payment,
  });

/** NIP-11 flags: each true only for a JSON `true`; undefined for no readable document. */
function readFlags(body: unknown): Flags | undefined {
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
  const max = l.max_message_length;
  return {
    auth: l.auth_required === true,
    payment: l.payment_required === true,
    ...(typeof max === 'number' && Number.isSafeInteger(max) && max > 0 ? { maxLength: max } : {}),
  };
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

/** A connection that never opened: a refused upgrade is not a Nostr server; the rest unreachable. */
const failureReason = (kind: RelayConnectFailure | undefined): PrecheckRefusal =>
  kind === 'upgrade' ? 'invalid' : 'unreachable';

interface Io {
  readonly resolver: HostResolver;
  readonly connector: RelayConnector;
  readonly checkServed: PrecheckOptions['checkServed'];
  readonly nip11: Nip11Fetcher | undefined;
  readonly timers: Timers;
  readonly now: () => number;
}

/** What one connection step ends with. */
type Step =
  | { readonly kind: 'ok'; readonly ms: number }
  | { readonly kind: 'sign_in' }
  | { readonly kind: 'refused'; readonly reason: PrecheckRefusal };

/** One address's test; `abort` ends it at its 10 s bound (closing its sockets). */
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
    // 07 §4.3: 10 s per server, whatever the server does.
    const timer = this.#io.timers.setTimeout(() => this.abort(), PRECHECK_SERVER_TIMEOUT_MS);
    try {
      return await this.#run(raw);
    } finally {
      this.#io.timers.clearTimeout(timer);
      this.#closeAll();
    }
  }

  async #run(raw: unknown): Promise<PrecheckResult> {
    const parsed = classify(raw);
    if (typeof parsed === 'string') return refused(null, parsed);
    const host = parsed.display;
    // Step 2: one lookup; every answer globally routable before any socket opens.
    const answers = await this.#lookup(parsed.host);
    if (answers === 'timeout' || answers === undefined) return refused(host, 'unreachable');
    if (!Array.isArray(answers) || answers.length === 0) return refused(host, 'unreachable');
    if (!answers.every((a) => typeof a === 'string' && isGloballyRoutable(a))) {
      return refused(host, 'not_allowed');
    }
    // Step 3: the pin. Every connection and the NIP-11 fetch use this one target.
    const target: RelayTarget = Object.freeze({
      url: parsed.url,
      host: parsed.host,
      port: parsed.port,
      address: answers[0] as string,
    });
    const flags = this.#nip11(target);
    // Step 5: the throwaway-key event, with a NIP-40 expiration so servers may drop it soon.
    const createdAt = Math.floor(this.#io.now() / 1000);
    const event = createThrowawayEvent((pubkey) => ({
      kind: NOSTR_KIND_GIFT_WRAP,
      created_at: createdAt,
      tags: [
        ['p', pubkey],
        ['expiration', String(createdAt + PRECHECK_EVENT_EXPIRY_SECONDS)],
      ],
      content: encodeHex(randomBytes(16)),
    }));
    const published = await this.#publish(target, event);
    let reads: Step | undefined;
    if (published.kind === 'ok') {
      reads =
        (await this.#lane(parsed.url, event.id)) === 'missing'
          ? refusal('not_kept')
          : await this.#readBack(target, event, createdAt);
    }
    const doc = await flags;
    const step = reads ?? published;
    if (step.kind === 'refused' && (step.reason === 'unreachable' || step.reason === 'invalid')) {
      return refused(host, step.reason, doc);
    }
    if (doc?.maxLength !== undefined && doc.maxLength < PRECHECK_MIN_MESSAGE_LENGTH) {
      return refused(host, 'too_small', doc);
    }
    if (step.kind === 'refused') return refused(host, step.reason, doc);
    if (step.kind === 'sign_in') return answered(host, 'sign_in', null, true, doc);
    const ms = Math.max(published.kind === 'ok' ? published.ms : 0, step.ms);
    // Accepted and both reads served, but NIP-11 says `auth_required`: sign_in, with a warning.
    if (doc?.auth === true) return answered(host, 'sign_in', ms, true, doc);
    return answered(host, ms > PRECHECK_SLOW_MS ? 'slow' : 'ready', ms, false, doc);
  }

  /** The check lane's answer (shared link on), or undefined; it ends at the bound too. */
  #lane(url: string, eventId: string): Promise<string | undefined> {
    const check = this.#io.checkServed;
    if (check === undefined || this.#aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: string | undefined): void => {
        if (done) return;
        done = true;
        this.#aborters.delete(stop);
        resolve(value);
      };
      const stop = (): void => finish(undefined);
      this.#aborters.add(stop);
      try {
        check(url, eventId).then(
          (outcome) => finish(outcome),
          () => finish(undefined),
        );
      } catch {
        finish(undefined);
      }
    });
  }

  /** Step 2's lookup; it ends at the bound even if the resolver never answers. */
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
  #nip11(target: RelayTarget): Promise<Flags | undefined> {
    const fetcher = this.#io.nip11;
    if (fetcher === undefined) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: Flags | undefined): void => {
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
    quiet: (spokeNostr: boolean, authSeen: boolean) => Step,
    own = false,
  ): Promise<Step> {
    if (this.#aborted) return Promise.resolve(refusal('unreachable'));
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
      // At the bound, or a close after the open with no answer: the step's own rule (`quiet`).
      const stop = (): void => end(opened ? quiet(spokeNostr, authSeen) : refusal('unreachable'));
      this.#aborters.add(stop);
      const connectTimer = this.#io.timers.setTimeout(() => {
        if (!opened) end(refusal('unreachable'));
      }, CONNECT_TIMEOUT_MS);
      try {
        // Connection 2 (`own`): a connection of the program's own when the connector is on the
        // shared relay link (D-159 (9)), never a virtual one that rides the upstream that wrote.
        const connector = this.#io.connector;
        const opener =
          own && typeof connector.openOwn === 'function'
            ? connector.openOwn.bind(connector)
            : connector.open.bind(connector);
        socket = opener(target, {
          onOpen: () => {
            if (done || opened || socket === undefined) return;
            opened = true;
            try {
              begin(socket);
            } catch {
              end(refusal('unreachable'));
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
            if (opened) end(quiet(true, authSeen));
            else end(refusal(failureReason(failure)));
          },
        });
      } catch {
        end(refusal('unreachable'));
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
        // A refusal, or `auth-required:` (a login to write): contacts could not deliver to it.
        end(refusal('not_accepted'));
      },
      // An AUTH challenge and no OK: it wants a login to accept (D-158 (3)); a Nostr frame but no
      // OK: unreachable in time; nothing Nostr-like at all: not a Nostr server.
      (spokeNostr, authSeen) =>
        refusal(authSeen ? 'not_accepted' : spokeNostr ? 'unreachable' : 'invalid'),
    );
  }

  /**
   * Connection 2, fresh and unauthenticated: the two reads of 07 §4.3, by the event's id and by the
   * sync filter. Both must serve the event (verified, same id) before their EOSE.
   */
  #readBack(target: RelayTarget, event: NostrEvent, createdAt: number): Promise<Step> {
    const tag = encodeHex(randomBytes(4));
    const byId = `i${tag}`;
    const bySync = `s${tag}`;
    let sentAt = 0;
    const served = new Set<string>();
    const ended = new Set<string>();
    return this.#connect(
      target,
      (socket) => {
        sentAt = this.#io.now();
        socket.send(JSON.stringify(['REQ', byId, { ids: [event.id], limit: 1 }]));
        socket.send(
          JSON.stringify([
            'REQ',
            bySync,
            { kinds: [NOSTR_KIND_GIFT_WRAP], '#p': [event.pubkey], since: createdAt - 60 },
          ]),
        );
      },
      (frame, end) => {
        const sub = frame[1];
        if (sub !== byId && sub !== bySync) return;
        if (frame[0] === 'EVENT') {
          const got = frame[2] as NostrEvent | undefined;
          if (typeof got === 'object' && got !== null && got.id === event.id && verifies(got)) {
            served.add(sub);
          }
        } else if (frame[0] === 'EOSE') {
          if (!served.has(sub)) {
            end(refusal('not_kept'));
            return;
          }
          ended.add(sub);
          if (ended.size === 2) {
            end({ kind: 'ok', ms: Math.max(0, Math.round(this.#io.now() - sentAt)) });
          }
        } else if (frame[0] === 'CLOSED') {
          // Only the machine-readable prefix is read (NIP-01); the rest is never kept.
          const signIn = typeof frame[2] === 'string' && frame[2].startsWith('auth-required:');
          end(signIn ? { kind: 'sign_in' } : refusal('not_kept'));
        }
      },
      (_spokeNostr, authSeen) => (authSeen ? { kind: 'sign_in' } : refusal('unreachable')),
      true,
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
 * `not_allowed`) and answers one result per entry, in order. The same address twice is tested once
 * and answered twice. Never rejects for a server's behaviour; a list that is not an array of 1 to 8
 * entries is a TransportError (`invalid_argument`).
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
    checkServed: options.checkServed,
    nip11: options.nip11,
    timers: options.timers ?? defaultTimers,
    now: options.now ?? (() => Date.now()),
  };
  const runs = new Map<string, Promise<PrecheckResult>>();
  const runOf = (raw: unknown): Promise<PrecheckResult> => {
    if (typeof raw !== 'string') return Promise.resolve(refused(null, 'not_allowed'));
    let run = runs.get(raw);
    if (run === undefined) {
      run = new OneTest(io).run(raw).catch(() => {
        const parsed = classify(raw);
        return refused(typeof parsed === 'string' ? null : parsed.display, 'unreachable');
      });
      runs.set(raw, run);
    }
    return run;
  };
  // Every step of a test ends when it is aborted (10 s per server), so each run settles by then.
  return Promise.all(urls.map(runOf));
}
