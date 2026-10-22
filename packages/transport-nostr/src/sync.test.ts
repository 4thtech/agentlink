// M1-5c acceptance: subscribe and sync (07 §4.2, §3.2 `seen`, `sync_cursors`; 04 §3.1.1; 06 §6).
// Cursor and resume, dedup across relays, replay and out-of-order, hostile and oversized frames, the
// 3 s budget, NIP-42, live subscriptions, bounded memory and no content in logs. Mock relays and a
// fake clock; real gift wraps built with controlled created_at. Every key is generated at runtime.
import {
  KeyStoreError,
  canonicalize,
  createGiftWrap,
  encodeBase64url,
  encodeHex,
  randomBytes,
  type Envelope,
  type EnvelopeKeys,
  type NostrEvent,
  type UnsignedNostrEvent,
} from '@4thtech-io/crypto';
import { createLogger, type Level } from '@4thtech-io/log';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { v2 as nip44 } from 'nostr-tools/nip44';
import { createRumor, createSeal } from 'nostr-tools/nip59';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENTLINK_TAG, NOSTR_KIND_RUMOR } from './gift-wrap.js';
import { IDLE_CLOSE_MS, MAX_FRAME_BYTES, RelayPool } from './relay-pool.js';
import {
  DEDUP_CACHE_ENTRIES,
  FIRST_SYNC_LOOKBACK_SECONDS,
  GAP_REQUERY_TIMEOUT_MS,
  MAX_GAP_REQUERIES_PER_PASS,
  MAX_GAP_REQUERY_IDS,
  MAX_LEARNED_IDS_PER_RELAY,
  LIVE_RETRY_BASE_MS,
  MAX_NEW_WRAPS_PER_PASS,
  MAX_PAGES_PER_PASS,
  MAX_QUEUED_EVENTS,
  SYNC_PAGE_LIMIT,
  type SyncResume,
  SEEN_RETENTION_SECONDS,
  SYNC_BUDGET_MS,
  SYNC_LOOKBACK_SECONDS,
  SYNC_SKEW_SECONDS,
  SyncEngine,
  seenPruneBefore,
  syncSince,
  type SeenKind,
  type SyncDisposition,
  type SyncItem,
  type SyncPersistence,
} from './sync.js';
import { MockNetwork, relayUrls } from './testing/mock-network.js';

const START = Date.UTC(2026, 9, 14, 12, 0, 0);
const NOW = START / 1000;
const HOUR = 3_600;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

// --- fixtures -------------------------------------------------------------------------------------

interface TestKeys extends EnvelopeKeys {
  readonly pubkey: string;
  readonly secretKey: Uint8Array;
}

function referenceKeys(): TestKeys {
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  return {
    pubkey,
    secretKey,
    signEnvelopeHash: () => Promise.reject(new Error('not used')),
    unwrapCek: () => Promise.reject(new Error('not used')),
    signNostr: (event: UnsignedNostrEvent) =>
      Promise.resolve(
        finalizeEvent(
          {
            kind: event.kind,
            created_at: event.created_at,
            tags: event.tags.map((tag) => [...tag]),
            content: event.content,
          },
          secretKey,
        ) as unknown as NostrEvent,
      ),
    nip44Encrypt: (peer: string, plaintext: string) =>
      Promise.resolve(nip44.encrypt(plaintext, nip44.utils.getConversationKey(secretKey, peer))),
    nip44Decrypt: (peer: string, payload: string) =>
      Promise.resolve(nip44.decrypt(payload, nip44.utils.getConversationKey(secretKey, peer))),
  };
}

const b64 = (length: number): string => encodeBase64url(randomBytes(length));

function makeEnvelope(from: string, overrides: Partial<Envelope> = {}): Envelope {
  return {
    v: 1,
    id: b64(16),
    thread: b64(16),
    from,
    createdAt: 1_760_000_000,
    recipients: [{ kid: b64(16), enc: b64(32), wk: b64(48) }],
    aead: { alg: 'A256GCM-KC', iv: b64(12), kc: b64(32), ct: b64(64) },
    sig: encodeHex(randomBytes(64)),
    ...overrides,
  };
}

/** A real gift wrap whose created_at is exactly `createdAt` (wrapEnvelope randomises it). */
function makeWrap(
  recipient: TestKeys,
  options: { sender?: TestKeys; createdAt?: number; envelope?: Envelope } = {},
): { event: NostrEvent; envelope: Envelope } {
  const sender = options.sender ?? referenceKeys();
  const envelope = options.envelope ?? makeEnvelope(sender.pubkey);
  const rumor = createRumor(
    { kind: NOSTR_KIND_RUMOR, tags: [[...AGENTLINK_TAG]], content: canonicalize(envelope) },
    sender.secretKey,
  );
  const seal = createSeal(rumor, sender.secretKey, recipient.pubkey) as unknown as NostrEvent;
  const event = createGiftWrap(seal, recipient.pubkey, options.createdAt ?? NOW - HOUR);
  return { event, envelope };
}

/** The `seen` and `sync_cursors` tables as core would implement them. */
class MemorySync implements SyncPersistence {
  readonly cursors = new Map<string, number>();
  readonly seen = new Map<string, number>();
  readonly marks: string[] = [];
  failReads = false;
  failWrites = false;

  getCursor(relay: string): Promise<number | undefined> {
    if (this.failReads) return Promise.reject(new Error('disk'));
    return Promise.resolve(this.cursors.get(relay));
  }
  setCursor(relay: string, lastSeen: number): Promise<void> {
    if (this.failWrites) return Promise.reject(new Error('disk'));
    this.cursors.set(relay, lastSeen);
    return Promise.resolve();
  }
  isSeen(kind: SeenKind, id: string): Promise<boolean> {
    if (this.failReads) return Promise.reject(new Error('disk'));
    return Promise.resolve(this.seen.has(`${kind}:${id}`));
  }
  markSeen(kind: SeenKind, id: string, firstSeenAt: number): Promise<void> {
    if (this.failWrites) return Promise.reject(new Error('disk'));
    this.marks.push(`${kind}:${id}`);
    if (!this.seen.has(`${kind}:${id}`)) this.seen.set(`${kind}:${id}`, firstSeenAt);
    return Promise.resolve();
  }
  readonly resumes = new Map<string, SyncResume>();
  getResume(relay: string): Promise<SyncResume | undefined> {
    return Promise.resolve(this.resumes.get(relay));
  }
  setResume(relay: string, resume: SyncResume | undefined): Promise<void> {
    if (resume === undefined) this.resumes.delete(relay);
    else this.resumes.set(relay, resume);
    return Promise.resolve();
  }
  prune(before: number): void {
    for (const [key, at] of this.seen) if (at < before) this.seen.delete(key);
  }
  has(kind: SeenKind, id: string): boolean {
    return this.seen.has(`${kind}:${id}`);
  }
}

interface Setup {
  net: MockNetwork;
  store: MemorySync;
  recipient: TestKeys;
  lines: string[];
  pool: RelayPool;
  engine: SyncEngine;
  items: SyncItem[];
  /** A fresh pool and engine over the same store: a restart. */
  restart(): Setup;
  handler(disposition?: SyncDisposition): (item: SyncItem) => Promise<SyncDisposition>;
}

function setup(
  shared: {
    net?: MockNetwork;
    store?: MemorySync;
    recipient?: TestKeys;
    keys?: EnvelopeKeys;
    dedupCacheEntries?: number;
    learnedIdsPerRelay?: number;
    auth?: boolean;
  } = {},
): Setup {
  const net = shared.net ?? new MockNetwork();
  const store = shared.store ?? new MemorySync();
  const recipient = shared.recipient ?? referenceKeys();
  const lines: string[] = [];
  const logger = createLogger({
    level: 'debug',
    sink: (_l: Level, line: string) => lines.push(line),
  });
  const pool = new RelayPool({
    connector: net,
    addressCheck: { resolver: net },
    nip11: net,
    logger,
    ...(shared.auth === true ? { authKeys: recipient, mayAuthenticate: () => true } : {}),
  });
  const engine = new SyncEngine({
    pool,
    persistence: store,
    keys: shared.keys ?? recipient,
    logger,
    ...(shared.dedupCacheEntries === undefined
      ? {}
      : { dedupCacheEntries: shared.dedupCacheEntries }),
    ...(shared.learnedIdsPerRelay === undefined
      ? {}
      : { learnedIdsPerRelay: shared.learnedIdsPerRelay }),
  });
  const items: SyncItem[] = [];
  const result: Setup = {
    net,
    store,
    recipient,
    lines,
    pool,
    engine,
    items,
    restart: () => setup({ ...shared, net, store, recipient }),
    handler:
      (disposition = 'verified') =>
      (item) => {
        items.push(item);
        return Promise.resolve(disposition);
      },
  };
  return result;
}

/** The live-only REQs (limit 0) sent to `relay`. */
const liveReqs = (s: Setup, relay: string) => s.net.reqs(relay).filter((r) => r.filter.limit === 0);

const ids = (s: Setup): string[] => s.items.map((i) => i.giftWrapId);

/** Runs `promise` while the fake clock advances, so timers inside it can fire. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms);
  return promise;
}

function identity(s: Setup) {
  return [{ pubkey: s.recipient.pubkey }];
}

// --- the since rule and the pruning bound ---------------------------------------------------------

describe('since and pruning (07 §4.2, §4.3, §3.2)', () => {
  it('reads a relay with no cursor 9 days back, and a cursor back 48 h plus S', () => {
    expect(syncSince(NOW, undefined)).toBe(NOW - 9 * 86_400);
    expect(FIRST_SYNC_LOOKBACK_SECONDS).toBe(9 * 86_400);
    expect(syncSince(NOW, NOW - 1_000)).toBe(NOW - 1_000 - 172_800 - 300);
    expect(SYNC_LOOKBACK_SECONDS + SYNC_SKEW_SECONDS).toBe(173_100);
  });

  it('does not trust a cursor from the future or a cursor that is not a time', () => {
    expect(syncSince(NOW, NOW + 10 * 86_400)).toBe(NOW - 173_100);
    expect(syncSince(NOW, -5)).toBe(NOW - 9 * 86_400);
    expect(syncSince(NOW, 1.5)).toBe(NOW - 9 * 86_400);
    expect(syncSince(NOW, Number.NaN)).toBe(NOW - 9 * 86_400);
  });

  it('keeps a seen row 7 days (fake clock), and longer when a recent cursor still needs it', () => {
    const store = new MemorySync();
    void store.markSeen('wrap', 'a'.repeat(64), NOW);
    const day = 86_400;
    store.prune(seenPruneBefore(NOW + 6 * day, [NOW + 6 * day]));
    expect(store.has('wrap', 'a'.repeat(64))).toBe(true); // 6 days: kept
    store.prune(seenPruneBefore(NOW + SEEN_RETENTION_SECONDS - 1, []));
    expect(store.has('wrap', 'a'.repeat(64))).toBe(true); // just under 7 days: kept
    store.prune(seenPruneBefore(NOW + SEEN_RETENTION_SECONDS + 1, []));
    expect(store.has('wrap', 'a'.repeat(64))).toBe(false); // over 7 days, no cursor needs it
  });

  it('keeps rows a lagging relay cursor may still request, and ignores a cursor older than 30 days', () => {
    const day = 86_400;
    // A relay last read 20 days ago will ask for 22 days and 5 minutes back.
    expect(seenPruneBefore(NOW, [NOW - 20 * day])).toBe(NOW - 20 * day - 172_800 - 300);
    // The lowest of several cursors wins.
    expect(seenPruneBefore(NOW, [NOW - 10 * day, NOW - 15 * day, NOW - HOUR])).toBe(
      NOW - 15 * day - 172_800 - 300,
    );
    // A relay that never answers (cursor over 30 days old) does not stop pruning.
    expect(seenPruneBefore(NOW, [NOW - 31 * day])).toBe(NOW - SEEN_RETENTION_SECONDS);
    // Recent cursors never pull the bound below 7 days.
    expect(seenPruneBefore(NOW, [NOW - HOUR])).toBe(NOW - SEEN_RETENTION_SECONDS);
  });
});

// --- cursor and resume ----------------------------------------------------------------------------

describe('cursor and resume', () => {
  it('asks a new relay for kind 1059 to our keys, 9 days back, and saves the cursor at EOSE', async () => {
    const s = setup();
    const [relay] = relayUrls('first', 1) as [string];
    s.net.configure(relay);
    const wrap = makeWrap(s.recipient, { createdAt: NOW - 8 * 86_400 });
    s.net.inject(relay, wrap.event);

    const result = await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });

    const [req] = s.net.reqs(relay);
    expect(req?.filter).toEqual({
      kinds: [1059],
      '#p': [s.recipient.pubkey],
      since: NOW - 9 * 86_400,
      limit: SYNC_PAGE_LIMIT,
    });
    expect(result).toMatchObject({ partial: false, delivered: 1, duplicates: 0, dropped: 0 });
    expect(result.relays).toEqual([{ relay, status: 'complete', reason: 'ok' }]);
    expect(ids(s)).toEqual([wrap.event.id]);
    expect(s.store.cursors.get(relay)).toBe(NOW);
  });

  it('finds an event with created_at 47 h in the past after a restart', async () => {
    const first = setup();
    const [relay] = relayUrls('restart', 1) as [string];
    first.net.configure(relay);
    await first.engine.sync({
      relays: [relay],
      identities: identity(first),
      onEnvelope: first.handler(),
    });
    expect(first.store.cursors.get(relay)).toBe(NOW);

    // Later a wrap arrives on the relay whose randomised created_at is 47 h before the cursor.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    const late = makeWrap(first.recipient, { createdAt: NOW - 47 * HOUR });
    first.net.inject(relay, late.event);

    const second = first.restart();
    const result = await second.engine.sync({
      relays: [relay],
      identities: identity(second),
      onEnvelope: second.handler(),
    });

    expect(second.net.reqs(relay).at(-1)?.filter.since).toBe(NOW - 173_100);
    expect(ids(second)).toEqual([late.event.id]);
    expect(result.partial).toBe(false);
    expect(second.store.cursors.get(relay)).toBe(NOW + 600);
  });

  it('does not ask for what is older than the window', async () => {
    const s = setup();
    const [relay] = relayUrls('window', 1) as [string];
    s.net.configure(relay);
    s.store.cursors.set(relay, NOW);
    s.net.inject(relay, makeWrap(s.recipient, { createdAt: NOW - 49 * HOUR }).event);
    await s.engine.sync({ relays: [relay], identities: identity(s), onEnvelope: s.handler() });
    expect(s.items).toHaveLength(0);
  });

  it('keeps one cursor per relay: a relay that fails keeps its own', async () => {
    const s = setup();
    const [good, bad] = relayUrls('perrelay', 2) as [string, string];
    s.net.configure(good);
    s.net.configure(bad, { silentReq: true });
    s.store.cursors.set(bad, NOW - 5 * HOUR);
    const result = await within(
      s.engine.sync({ relays: [good, bad], identities: identity(s), onEnvelope: s.handler() }),
      SYNC_BUDGET_MS,
    );
    expect(s.store.cursors.get(good)).toBe(NOW);
    expect(s.store.cursors.get(bad)).toBe(NOW - 5 * HOUR);
    expect(result.partial).toBe(true);
    expect(result.relays.find((r) => r.relay === bad)).toMatchObject({
      status: 'incomplete',
      reason: 'budget',
    });
  });

  it('does not move the cursor of a relay that cannot be reached or that closes the subscription', async () => {
    const s = setup();
    const [down, closed, refused] = relayUrls('fail', 3) as [string, string, string];
    s.net.configure(down);
    s.net.dns.set(down.slice('wss://'.length), ['10.0.0.1']); // refused by the address check
    s.net.configure(closed);
    s.net.configure(refused, { requireAuth: true }); // no authKeys on this pool: cannot log in
    const result = await s.engine.sync({
      relays: [down, closed, refused],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(result.relays.map((r) => [r.status, r.reason])).toEqual([
      ['failed', 'blocked_address'],
      ['complete', 'ok'],
      ['failed', 'auth_failed'],
    ]);
    expect(s.store.cursors.has(down)).toBe(false);
    expect(s.store.cursors.has(refused)).toBe(false);
    expect(s.store.cursors.get(closed)).toBe(NOW);
  });

  it('reads the full first-sync window when the cursor cannot be read', async () => {
    const s = setup();
    const [relay] = relayUrls('badcursor', 1) as [string];
    s.net.configure(relay);
    s.store.cursors.set(relay, NOW);
    s.store.failReads = true;
    await s.engine.sync({ relays: [relay], identities: identity(s), onEnvelope: s.handler() });
    expect(s.net.reqs(relay)[0]?.filter.since).toBe(NOW - 9 * 86_400);
  });

  it('still delivers when the cursor cannot be saved, and says nothing from the relay', async () => {
    const s = setup();
    const [relay] = relayUrls('nosave', 1) as [string];
    s.net.configure(relay);
    s.net.inject(relay, makeWrap(s.recipient).event);
    s.store.failWrites = true;
    const result = await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(result.delivered).toBe(1);
    expect(s.store.cursors.size).toBe(0);
  });

  it('holds the cursor while the handler asks to see an item again, then delivers it on the next pass', async () => {
    const s = setup();
    const [relay] = relayUrls('retry', 1) as [string];
    s.net.configure(relay);
    const wrap = makeWrap(s.recipient);
    s.net.inject(relay, wrap.event);

    const first = await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler('retry'),
    });
    expect(first).toMatchObject({ partial: true, delivered: 0, deferred: 1 });
    expect(first.relays[0]).toMatchObject({ status: 'incomplete', reason: 'handler_retry' });
    expect(s.store.cursors.has(relay)).toBe(false);
    expect(s.store.has('wrap', wrap.event.id)).toBe(false); // seen only with the processed outcome

    const second = await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(second).toMatchObject({ partial: false, delivered: 1 });
    expect(s.store.has('wrap', wrap.event.id)).toBe(true);
    expect(s.store.cursors.get(relay)).toBe(NOW);
  });

  it('treats a handler that throws as a retry and never logs what it threw', async () => {
    const s = setup();
    const [relay] = relayUrls('throws', 1) as [string];
    s.net.configure(relay);
    s.net.inject(relay, makeWrap(s.recipient).event);
    const result = await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: () => Promise.reject(new Error('CANARY-handler-text')),
    });
    expect(result).toMatchObject({ partial: true, deferred: 1, delivered: 0 });
    expect(s.store.marks).toEqual([]);
    expect(s.lines.join('\n')).not.toContain('CANARY-handler-text');
  });

  it('stops with a fixed reason when the keys are locked, marks nothing and keeps the cursor', async () => {
    const recipient = referenceKeys();
    const locked: EnvelopeKeys = {
      ...recipient,
      nip44Decrypt: () => Promise.reject(new KeyStoreError('owner_locked', 'locked')),
    };
    const s = setup({ recipient, keys: locked });
    const [relay] = relayUrls('locked', 1) as [string];
    s.net.configure(relay);
    s.net.inject(relay, makeWrap(recipient).event);
    const result = await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(result.relays[0]).toMatchObject({ status: 'failed', reason: 'keys_unavailable' });
    expect(s.store.marks).toEqual([]);
    expect(s.store.cursors.size).toBe(0);
  });

  it('decrypts with the epoch of the key the wrap is addressed to', async () => {
    const recipient = referenceKeys();
    const spied = { ...recipient, nip44Decrypt: vi.fn(recipient.nip44Decrypt) };
    const s = setup({ recipient, keys: spied });
    const [relay] = relayUrls('epoch', 1) as [string];
    s.net.configure(relay);
    s.net.inject(relay, makeWrap(recipient).event);
    await s.engine.sync({
      relays: [relay],
      identities: [{ pubkey: recipient.pubkey, epoch: 2 }],
      onEnvelope: s.handler(),
    });
    expect(spied.nip44Decrypt).toHaveBeenCalled();
    for (const call of spied.nip44Decrypt.mock.calls) expect(call[2]).toEqual({ epoch: 2 });
    expect(s.items[0]?.recipient).toBe(recipient.pubkey);
  });
});

// --- dedup ---------------------------------------------------------------------------------------

describe('dedup', () => {
  it('delivers the same envelope from 3 relays once', async () => {
    const s = setup();
    const relays = relayUrls('three', 3);
    const wrap = makeWrap(s.recipient);
    for (const relay of relays) {
      s.net.configure(relay);
      s.net.inject(relay, wrap.event);
    }
    const result = await s.engine.sync({
      relays,
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(result).toMatchObject({ partial: false, delivered: 1, duplicates: 2 });
    expect(ids(s)).toEqual([wrap.event.id]);
    expect(s.store.marks.filter((m) => m.startsWith('wrap:'))).toEqual([`wrap:${wrap.event.id}`]);
    for (const relay of relays) expect(s.store.cursors.get(relay)).toBe(NOW);
  });

  it('delivers once when the 3 copies arrive while the first is still being handled', async () => {
    const s = setup();
    const relays = relayUrls('slowhandler', 3);
    const wrap = makeWrap(s.recipient);
    for (const relay of relays) {
      s.net.configure(relay);
      s.net.inject(relay, wrap.event);
    }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const done = s.engine.sync({
      relays,
      identities: identity(s),
      onEnvelope: async (): Promise<SyncDisposition> => {
        calls += 1;
        await gate;
        return 'verified';
      },
    });
    await vi.advanceTimersByTimeAsync(50);
    release();
    const result = await done;
    expect(calls).toBe(1);
    expect(result).toMatchObject({ partial: false, delivered: 1, duplicates: 2 });
  });

  it("holds every relay's cursor when the one copy being handled ends as a retry", async () => {
    const s = setup();
    const relays = relayUrls('sharedretry', 2);
    const wrap = makeWrap(s.recipient);
    for (const relay of relays) {
      s.net.configure(relay);
      s.net.inject(relay, wrap.event);
    }
    const result = await s.engine.sync({
      relays,
      identities: identity(s),
      onEnvelope: s.handler('retry'),
    });
    expect(result.partial).toBe(true);
    expect(s.store.cursors.size).toBe(0);
  });

  it('delivers nothing again on a later pass or after a restart (the seen-set)', async () => {
    const s = setup();
    const [relay] = relayUrls('replay', 1) as [string];
    s.net.configure(relay);
    s.net.inject(relay, makeWrap(s.recipient).event);
    await s.engine.sync({ relays: [relay], identities: identity(s), onEnvelope: s.handler() });
    const again = await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(again).toMatchObject({ delivered: 0, duplicates: 1 });
    const restarted = s.restart();
    const after = await restarted.engine.sync({
      relays: [relay],
      identities: identity(restarted),
      onEnvelope: restarted.handler(),
    });
    expect(after).toMatchObject({ delivered: 0, duplicates: 1 });
    expect(restarted.items).toHaveLength(0);
  });

  it('delivers every event once whatever order a relay serves them in, and on replay', async () => {
    const s = setup();
    const [a, b] = relayUrls('order', 2) as [string, string];
    s.net.configure(a, { newestFirst: true });
    s.net.configure(b);
    const wraps = [0, 1, 2, 3, 4].map((i) =>
      makeWrap(s.recipient, { createdAt: NOW - (i + 1) * HOUR }),
    );
    for (const w of wraps) s.net.inject(a, w.event);
    for (const w of [...wraps].reverse()) s.net.inject(b, w.event);
    const first = await s.engine.sync({
      relays: [a, b],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(first.delivered).toBe(5);
    expect([...ids(s)].sort()).toEqual(wraps.map((w) => w.event.id).sort());
    const replay = await s.engine.sync({
      relays: [a, b],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(replay).toMatchObject({ delivered: 0, duplicates: 10 });
    expect(s.items).toHaveLength(5);
  });

  it('treats a seen-set that cannot be read as empty for that pass (07 §3.2)', async () => {
    const s = setup();
    const [relay] = relayUrls('unreadable', 1) as [string];
    s.net.configure(relay);
    const wrap = makeWrap(s.recipient);
    s.net.inject(relay, wrap.event);
    await s.engine.sync({ relays: [relay], identities: identity(s), onEnvelope: s.handler() });
    const restarted = s.restart();
    restarted.store.failReads = true;
    const again = await restarted.engine.sync({
      relays: [relay],
      identities: identity(restarted),
      onEnvelope: restarted.handler(),
    });
    expect(again.delivered).toBe(1); // late work, never a loss: core step 9 dedups stored envelopes
  });

  it("does not let an unverified envelope that reuses another envelope's id suppress the real one (IR-M1-5a-1 L-3)", async () => {
    const s = setup();
    const [relayA, relayB] = relayUrls('reuse', 2) as [string, string];
    s.net.configure(relayA);
    s.net.configure(relayB);
    const real = makeWrap(s.recipient);
    const attacker = referenceKeys();
    const forged = makeWrap(s.recipient, {
      sender: attacker,
      envelope: makeEnvelope(attacker.pubkey, { id: real.envelope.id }), // copies the victim's id
      createdAt: NOW - 2 * HOUR,
    });
    s.net.inject(relayA, forged.event); // the attacker's arrives first, from another relay
    s.net.inject(relayB, real.event);

    const handler = (item: SyncItem): Promise<SyncDisposition> => {
      s.items.push(item);
      // The attacker's signature does not verify (step 4): processed, not verified.
      return Promise.resolve(item.envelope.from === attacker.pubkey ? 'processed' : 'verified');
    };
    const result = await s.engine.sync({
      relays: [relayA, relayB],
      identities: identity(s),
      onEnvelope: handler,
    });

    expect(result.delivered).toBe(2);
    expect(ids(s).sort()).toEqual([forged.event.id, real.event.id].sort());
    expect(
      s.items.every((i) => i.envelopeSeen === false || i.envelope.from !== attacker.pubkey),
    ).toBe(true);
    // Only the verified envelope's id is recorded.
    expect(s.store.has('envelope', real.envelope.id)).toBe(true);
    expect(s.store.marks.filter((m) => m.startsWith('envelope:'))).toEqual([
      `envelope:${real.envelope.id}`,
    ]);
  });

  it('still delivers a later envelope with an id that is seen, with the seen flag as a hint only', async () => {
    const s = setup();
    const [relay] = relayUrls('hint', 1) as [string];
    s.net.configure(relay);
    const real = makeWrap(s.recipient);
    s.net.inject(relay, real.event);
    await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler('verified'),
    });
    expect(s.items[0]?.envelopeSeen).toBe(false);

    const attacker = referenceKeys();
    const copy = makeWrap(s.recipient, {
      sender: attacker,
      envelope: makeEnvelope(attacker.pubkey, { id: real.envelope.id }),
      createdAt: NOW - 3 * HOUR,
    });
    s.net.inject(relay, copy.event);
    await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler('processed'),
    });
    expect(s.items).toHaveLength(2);
    expect(s.items[1]?.envelopeSeen).toBe(true);
    expect(s.items[1]?.giftWrapId).toBe(copy.event.id);
  });

  it("does not let a forged copy of a wrap's id hide the real wrap, in either order", async () => {
    for (const forgedFirst of [true, false]) {
      const s = setup();
      const [relayA, relayB] = relayUrls(`forged${forgedFirst ? 'a' : 'b'}`, 2) as [string, string];
      s.net.configure(relayA);
      s.net.configure(relayB);
      const real = makeWrap(s.recipient);
      const forged = { ...real.event, sig: 'f'.repeat(128) };
      if (forgedFirst) {
        s.net.inject(relayA, forged);
        s.net.inject(relayB, real.event);
      } else {
        s.net.inject(relayA, real.event);
        s.net.inject(relayB, forged);
      }
      const result = await s.engine.sync({
        relays: [relayA, relayB],
        identities: identity(s),
        onEnvelope: s.handler(),
      });
      expect(ids(s)).toEqual([real.event.id]);
      expect(result.delivered).toBe(1);
    }
  });

  it('does not record a wrap that fails to open, and drops it again when served again', async () => {
    const s = setup();
    const [relay] = relayUrls('junk', 1) as [string];
    s.net.configure(relay);
    const wrongRecipient = referenceKeys();
    const notOurs = makeWrap(wrongRecipient).event; // sealed to someone else, but tagged to us below
    const tampered = {
      ...notOurs,
      tags: [['p', s.recipient.pubkey]],
    } as NostrEvent; // id and signature no longer match
    s.net.inject(relay, tampered);
    const result = await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(result).toMatchObject({ delivered: 0, dropped: 1, partial: false });
    expect(s.store.marks).toEqual([]);
    expect(s.items).toHaveLength(0);
  });

  it('drops a wrap that is not addressed to one of our keys', async () => {
    const s = setup();
    const [relay] = relayUrls('notours', 1) as [string];
    // A correct relay would not serve it (the REQ names our keys); this one does.
    const foreign = makeWrap(referenceKeys()).event;
    s.net.configure(relay, { extraFrames: (subId) => [JSON.stringify(['EVENT', subId, foreign])] });
    const result = await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(result).toMatchObject({ delivered: 0, dropped: 1 });
    expect(s.store.marks).toEqual([]);
  });

  it('bounds the dedup memory whatever a relay sends', async () => {
    // The cap is injected (dedupCacheEntries), so a small one proves the bound with few inputs. Each
    // valid wrap costs real secp256k1 and NIP-44 work (create and open), which is slow on CI runners,
    // so the input is a multiple of the cap rather than of the production default.
    const CAP = 4;
    const VALID = CAP * 4;
    const JUNK = CAP * 50;
    const s = setup({ dedupCacheEntries: CAP });
    const [relay] = relayUrls('bound', 1) as [string];
    s.net.configure(relay);
    // VALID valid wraps and JUNK wraps that are junk (random id and signature, not for us).
    const wraps = Array.from({ length: VALID }, (_, i) =>
      makeWrap(s.recipient, { createdAt: NOW - (i + 1) * 60 }),
    );
    for (const w of wraps) s.net.inject(relay, w.event);
    s.net.configure(relay, {
      extraFrames: (subId) =>
        Array.from({ length: JUNK }, () =>
          JSON.stringify([
            'EVENT',
            subId,
            {
              id: encodeHex(randomBytes(32)),
              pubkey: encodeHex(randomBytes(32)),
              created_at: NOW - 1,
              kind: 1059,
              tags: [],
              content: 'x',
              sig: encodeHex(randomBytes(64)),
            },
          ]),
        ),
    });
    const first = await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(first.delivered).toBe(VALID);
    expect(first.dropped).toBe(JUNK);
    expect(s.engine.dedupStats()).toEqual({ processed: CAP, junk: CAP, inflight: 0 });
    // Evicted entries are still deduplicated by the persisted seen-set.
    const second = await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(second.delivered).toBe(0);
    expect(s.items).toHaveLength(VALID);
    expect(s.engine.dedupStats().processed).toBe(CAP);
    expect(DEDUP_CACHE_ENTRIES).toBeGreaterThan(0);
  });
});

// --- hostile relays ------------------------------------------------------------------------------

describe('hostile and malformed input (I-5)', () => {
  const junkEvent = (): Record<string, unknown> => ({
    id: encodeHex(randomBytes(32)),
    pubkey: encodeHex(randomBytes(32)),
    created_at: NOW,
    kind: 1059,
    tags: [],
    content: 'x',
    sig: encodeHex(randomBytes(64)),
  });

  it('ignores malformed, foreign and oversized frames and still completes with the real event', async () => {
    const s = setup();
    const [relay] = relayUrls('hostile', 1) as [string];
    const canary = `CANARY-${Math.random().toString(36).slice(2)}`;
    const wrap = makeWrap(s.recipient);
    s.net.inject(relay, wrap.event);
    // An EVENT frame of exactly MAX_FRAME_BYTES parses (as junk); one byte more never reaches the parser.
    const frameOf = (subId: string, bytes: number): string => {
      const base = JSON.stringify(['EVENT', subId, { ...junkEvent(), content: '' }]).length;
      return JSON.stringify([
        'EVENT',
        subId,
        { ...junkEvent(), content: 'a'.repeat(bytes - base) },
      ]);
    };
    s.net.configure(relay, {
      extraFrames: (subId) => [
        'not json at all',
        '{"a":1}',
        '[]',
        '["EVENT"]',
        '["EVENT", 5, 6]',
        `["NOTICE","${canary}"]`,
        `["EOSE","${subId}-other"]`,
        JSON.stringify(['EVENT', `${subId}-other`, junkEvent()]), // another subscription's id
        JSON.stringify(['EVENT', subId, 'text']),
        JSON.stringify(['EVENT', subId, null]),
        JSON.stringify(['EVENT', subId, { ...junkEvent(), kind: 1 }]),
        JSON.stringify(['EVENT', subId, { ...junkEvent(), id: canary }]),
        frameOf(subId, MAX_FRAME_BYTES),
        frameOf(subId, MAX_FRAME_BYTES + 1),
      ],
    });
    const result = await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(result).toMatchObject({ partial: false, delivered: 1 });
    // text, null, kind 1, bad id, and the 131 072-byte junk event; the +1 frame never parsed.
    expect(result.dropped).toBe(5);
    expect(ids(s)).toEqual([wrap.event.id]);
    expect(s.lines.join('\n')).not.toContain(canary);
  });

  it('ends a relay that floods the queue behind a slow handler instead of holding it all in memory', async () => {
    const s = setup();
    const [relay] = relayUrls('flood', 1) as [string];
    s.net.inject(relay, makeWrap(s.recipient).event);
    s.net.configure(relay, {
      extraFrames: (subId) =>
        Array.from({ length: MAX_QUEUED_EVENTS + 100 }, () =>
          JSON.stringify(['EVENT', subId, junkEvent()]),
        ),
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const done = s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: async (): Promise<SyncDisposition> => {
        await gate;
        return 'verified';
      },
    });
    await vi.advanceTimersByTimeAsync(100);
    release();
    const result = await done;
    expect(result.partial).toBe(true);
    expect(result.relays[0]).toMatchObject({ status: 'incomplete', reason: 'overflow' });
    expect(s.store.cursors.has(relay)).toBe(false);
  });

  it('ends a relay that makes us open more wraps than a pass allows, and keeps its cursor', async () => {
    const s = setup();
    const [relay] = relayUrls('opens', 1) as [string];
    s.net.inject(relay, makeWrap(s.recipient).event);
    s.net.configure(relay, {
      extraFrames: (subId) =>
        Array.from({ length: MAX_NEW_WRAPS_PER_PASS + 10 }, () =>
          JSON.stringify(['EVENT', subId, { ...junkEvent(), tags: [['p', s.recipient.pubkey]] }]),
        ),
    });
    const result = await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(result.delivered).toBe(1);
    expect(result.relays[0]).toMatchObject({ status: 'incomplete', reason: 'too_many_events' });
    expect(s.store.cursors.has(relay)).toBe(false);
  });

  it('reports a relay that closes the subscription, with a fixed reason and none of its text', async () => {
    const s = setup();
    const [relay] = relayUrls('closedsub', 1) as [string];
    s.net.configure(relay, {
      extraFrames: (subId) => [JSON.stringify(['CLOSED', subId, 'error: CANARY-closed-text'])],
      noEose: true,
    });
    const result = await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(result.relays[0]).toMatchObject({ status: 'failed', reason: 'subscription_closed' });
    expect(JSON.stringify(result)).not.toContain('CANARY');
    expect(s.lines.join('\n')).not.toContain('CANARY');
  });

  it('reports a relay that drops the connection mid-pass', async () => {
    const s = setup();
    const [relay] = relayUrls('dropped', 1) as [string];
    s.net.configure(relay, { noEose: true });
    const done = s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    await vi.advanceTimersByTimeAsync(10);
    s.net.socket(relay)?.dropFromRelay();
    const result = await within(done, 10);
    expect(result.relays[0]).toMatchObject({ status: 'failed', reason: 'connection_lost' });
    expect(s.store.cursors.has(relay)).toBe(false);
  });
});

// --- the time budget -----------------------------------------------------------------------------

describe('time budget (06 §6)', () => {
  it("returns partial results at 3 s when one relay is slow, and keeps that relay's cursor", async () => {
    const s = setup();
    const [fast, slow] = relayUrls('budget', 2) as [string, string];
    s.net.configure(fast);
    s.net.configure(slow, { silentReq: true });
    const wrap = makeWrap(s.recipient);
    s.net.inject(fast, wrap.event);
    let settled = false;
    const done = s.engine
      .sync({ relays: [fast, slow], identities: identity(s), onEnvelope: s.handler() })
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(SYNC_BUDGET_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await done;
    expect(SYNC_BUDGET_MS).toBe(3_000);
    expect(result.partial).toBe(true);
    expect(result.delivered).toBe(1);
    expect(result.relays).toEqual([
      { relay: fast, status: 'complete', reason: 'ok' },
      { relay: slow, status: 'incomplete', reason: 'budget' },
    ]);
    expect(s.store.cursors.has(slow)).toBe(false);
    // The subscription on the slow relay is closed, and its connection no longer pinned.
    const closes = s.net.received.filter((r) => r.relay === slow && r.frame.startsWith('["CLOSE"'));
    expect(closes).toHaveLength(1);
  });

  it('does not wait for a relay that never connects (black hole)', async () => {
    const s = setup();
    const [fast, hole] = relayUrls('hole', 2) as [string, string];
    s.net.configure(fast);
    s.net.configure(hole, { blackHole: true });
    s.net.inject(fast, makeWrap(s.recipient).event);
    const done = s.engine.sync({
      relays: [fast, hole],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    const result = await within(done, SYNC_BUDGET_MS);
    expect(result.partial).toBe(true);
    expect(result.delivered).toBe(1);
    expect(result.relays[1]).toMatchObject({ status: 'incomplete', reason: 'budget' });
    await vi.advanceTimersByTimeAsync(20_000); // the connect attempt ends later; nothing is sent
    expect(s.net.reqs(hole)).toHaveLength(0);
    expect(s.pool.connectionCount).toBe(1);
  });

  it('returns at once when every relay is done, and honours a longer budget', async () => {
    const s = setup();
    const relays = relayUrls('early', 3);
    for (const relay of relays) s.net.configure(relay);
    const started = Date.now();
    const result = await s.engine.sync({
      relays,
      identities: identity(s),
      onEnvelope: s.handler(),
      budgetMs: 60_000,
    });
    expect(Date.now() - started).toBe(0);
    expect(result.partial).toBe(false);

    const slow = relayUrls('longer', 1) as [string];
    s.net.configure(slow[0], { silentReq: true });
    let settled = false;
    const done = s.engine
      .sync({ relays: slow, identities: identity(s), onEnvelope: s.handler(), budgetMs: 10_000 })
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await done).partial).toBe(true);
  });
});

// --- NIP-42 --------------------------------------------------------------------------------------

describe('NIP-42', () => {
  it('logs in when a relay answers the REQ with auth-required, then reads', async () => {
    const s = setup({ auth: true });
    const [relay] = relayUrls('auth', 1) as [string];
    s.net.configure(relay, { requireAuth: true });
    s.net.inject(relay, makeWrap(s.recipient).event);
    const result = await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(result).toMatchObject({ partial: false, delivered: 1 });
    expect(s.net.reqs(relay)).toHaveLength(4); // refused once, served after the login, the repeat page, the step below it
    expect(s.net.socket(relay)?.authed).toBe(true);
  });

  it('does not log in on a pool that has no AUTH keys', async () => {
    const s = setup();
    const [relay] = relayUrls('noauth', 1) as [string];
    s.net.configure(relay, { requireAuth: true });
    const result = await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(result.relays[0]).toMatchObject({ status: 'failed', reason: 'auth_failed' });
    expect(s.net.socket(relay)?.authed).toBe(false);
  });
});

// --- live subscriptions --------------------------------------------------------------------------

describe('live subscription', () => {
  it('reads the backlog, then new events, and stops on unsubscribe', async () => {
    const s = setup();
    const [relay] = relayUrls('live', 1) as [string];
    s.net.configure(relay);
    const old = makeWrap(s.recipient, { createdAt: NOW - 5 * HOUR });
    s.net.inject(relay, old.event);
    const unsubscribe = s.engine.subscribe({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(ids(s)).toEqual([old.event.id]);
    expect(s.store.cursors.get(relay)).toBe(NOW);

    const fresh = makeWrap(s.recipient, { createdAt: NOW - 60 });
    s.net.inject(relay, fresh.event);
    await vi.advanceTimersByTimeAsync(20);
    expect(ids(s)).toEqual([old.event.id, fresh.event.id]);

    unsubscribe();
    await vi.advanceTimersByTimeAsync(20);
    expect(s.net.received.some((r) => r.relay === relay && r.frame.startsWith('["CLOSE"'))).toBe(
      true,
    );
    s.net.inject(relay, makeWrap(s.recipient).event);
    await vi.advanceTimersByTimeAsync(LIVE_RETRY_BASE_MS * 3);
    expect(s.items).toHaveLength(2);
    expect(liveReqs(s, relay)).toHaveLength(1);
  });

  it('M1-9s: unsubscribe waits for a handler in flight and then writes no cursor and marks nothing', async () => {
    const s = setup();
    const [relay] = relayUrls('livestop', 1) as [string];
    s.net.configure(relay);
    let release: ((d: SyncDisposition) => void) | undefined;
    const unsubscribe = s.engine.subscribe({
      relays: [relay],
      identities: identity(s),
      onEnvelope: (item) => {
        s.items.push(item);
        return new Promise<SyncDisposition>((resolve) => {
          release = resolve;
        });
      },
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(s.store.cursors.get(relay)).toBe(NOW);
    // Past the live cursor interval, so a delivered event would move the cursor.
    await vi.advanceTimersByTimeAsync(61_000);
    const fresh = makeWrap(s.recipient, { createdAt: NOW - 60 });
    s.net.inject(relay, fresh.event);
    await vi.advanceTimersByTimeAsync(20);
    expect(ids(s)).toEqual([fresh.event.id]);
    expect(release).toBeTypeOf('function');

    let done = false;
    const stopped = unsubscribe().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(done).toBe(false); // the handler is still running
    release?.('verified');
    await vi.advanceTimersByTimeAsync(20);
    await stopped;
    expect(done).toBe(true);
    expect(s.store.cursors.get(relay)).toBe(NOW);
    expect(s.store.marks).not.toContain(`wrap:${fresh.event.id}`);
    expect(s.store.has('wrap', fresh.event.id)).toBe(false);
  });

  it('delivers a live duplicate once, and a wrap seen by a sync pass never', async () => {
    const s = setup();
    const [relay] = relayUrls('livedup', 1) as [string];
    s.net.configure(relay);
    const wrap = makeWrap(s.recipient);
    s.net.inject(relay, wrap.event);
    s.engine.subscribe({ relays: [relay], identities: identity(s), onEnvelope: s.handler() });
    await vi.advanceTimersByTimeAsync(20);
    s.net.fanOut(relay, wrap.event); // the relay sends it again
    await vi.advanceTimersByTimeAsync(20);
    expect(s.items).toHaveLength(1);
  });

  it('resubscribes with backoff after the connection is lost and picks up what arrived meanwhile', async () => {
    const s = setup();
    const [relay] = relayUrls('reconnect', 1) as [string];
    s.net.configure(relay);
    const unsubscribe = s.engine.subscribe({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(liveReqs(s, relay)).toHaveLength(1);

    s.net.socket(relay)?.dropFromRelay();
    await vi.advanceTimersByTimeAsync(20);
    const missed = makeWrap(s.recipient, { createdAt: NOW - 30 });
    s.net.stored.push({ relay, event: missed.event }); // stored while nobody was listening
    await vi.advanceTimersByTimeAsync(LIVE_RETRY_BASE_MS);
    await vi.advanceTimersByTimeAsync(20);

    const paged = s.net.reqs(relay).filter((r) => r.filter.limit !== 0);
    expect(paged[1]?.filter.since).toBe(NOW - 173_100);
    expect(liveReqs(s, relay)).toHaveLength(2);
    expect(ids(s)).toEqual([missed.event.id]);
    unsubscribe();
  });

  it('keeps a quiet subscription connected past the 5-minute idle close', async () => {
    const s = setup();
    const [relay] = relayUrls('idle', 1) as [string];
    s.net.configure(relay);
    const unsubscribe = s.engine.subscribe({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS * 2);
    expect(s.pool.connectionCount).toBe(1);
    expect(liveReqs(s, relay)).toHaveLength(1);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS + 10);
    expect(s.pool.connectionCount).toBe(0); // released: the idle rule applies again
  });

  it('stops retrying when the pool is closed', async () => {
    const s = setup();
    const [relay] = relayUrls('poolclosed', 1) as [string];
    s.net.configure(relay);
    s.engine.subscribe({ relays: [relay], identities: identity(s), onEnvelope: s.handler() });
    await vi.advanceTimersByTimeAsync(20);
    s.pool.close();
    await vi.advanceTimersByTimeAsync(LIVE_RETRY_BASE_MS * 10);
    expect(liveReqs(s, relay)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// --- arguments and logs --------------------------------------------------------------------------

describe('arguments', () => {
  it('refuses a bad relay list, key list, handler or budget', async () => {
    const s = setup();
    const ok = { relays: relayUrls('args', 1), identities: identity(s), onEnvelope: s.handler() };
    await expect(s.engine.sync({ ...ok, relays: [] })).rejects.toMatchObject({
      code: 'invalid_relays',
    });
    await expect(s.engine.sync({ ...ok, relays: relayUrls('many', 65) })).rejects.toMatchObject({
      code: 'invalid_relays',
    });
    await expect(s.engine.sync({ ...ok, identities: [] })).rejects.toMatchObject({
      code: 'invalid_argument',
    });
    await expect(s.engine.sync({ ...ok, identities: [{ pubkey: 'AB' }] })).rejects.toMatchObject({
      code: 'invalid_argument',
    });
    await expect(
      s.engine.sync({ ...ok, identities: [{ pubkey: s.recipient.pubkey, epoch: -1 }] }),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(s.engine.sync({ ...ok, budgetMs: 0 })).rejects.toMatchObject({
      code: 'invalid_argument',
    });
    await expect(
      s.engine.sync({ ...ok, onEnvelope: undefined as unknown as never }),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(() => s.engine.subscribe({ ...ok, relays: [] })).toThrow();
  });

  it('reports a relay URL that fails the rule without connecting to it', async () => {
    const s = setup();
    const result = await s.engine.sync({
      relays: ['ws://plain.example', 'wss://1.relay.example'],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(result.relays.map((r) => r.reason)).toEqual(['invalid_url', 'invalid_url']);
    expect(s.net.opens).toHaveLength(0);
  });
});

describe('logging (I-7)', () => {
  it('writes no event content, relay URL path, key or id to the logs', async () => {
    const s = setup();
    const url = 'wss://logs-0.nostr-test.dev/path-secret';
    s.net.configure(url);
    const wrap = makeWrap(s.recipient);
    s.net.inject(url, wrap.event);
    s.net.inject(url, { ...wrap.event, id: 'a'.repeat(64) } as NostrEvent); // invalid copy
    await s.engine.sync({ relays: [url], identities: identity(s), onEnvelope: s.handler('retry') });
    await s.engine.sync({
      relays: [url],
      identities: identity(s),
      onEnvelope: s.handler('verified'),
    });
    const text = s.lines.join('\n');
    expect(text.length).toBeGreaterThan(0);
    for (const forbidden of [
      'path-secret',
      wrap.event.id,
      wrap.event.content.slice(0, 30),
      wrap.envelope.id,
      s.recipient.pubkey,
      wrap.envelope.from,
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

// --- pagination (IR-M1-5c-1 H-1, M-2, M-3) -------------------------------------------------------

/** A wrap-shaped event for us that fails to open: what a flood of junk looks like. */
function junkWrap(recipientKey: string, createdAt: number): Record<string, unknown> {
  return {
    id: encodeHex(randomBytes(32)),
    pubkey: encodeHex(randomBytes(32)),
    created_at: createdAt,
    kind: 1059,
    tags: [['p', recipientKey]],
    content: 'x',
    sig: encodeHex(randomBytes(64)),
  };
}

describe('pagination (a relay that caps stored results per filter)', () => {
  it('delivers every wrap of the window from a relay that caps results, and moves the cursor only at the end', async () => {
    const s = setup();
    const [relay] = relayUrls('capped', 1) as [string];
    s.net.configure(relay, { maxLimit: 5 });
    const wraps = Array.from({ length: 23 }, (_, i) =>
      makeWrap(s.recipient, { createdAt: NOW - (i + 1) * 600 }),
    );
    for (const w of wraps) s.net.inject(relay, w.event);
    const cursorsSeen: number[] = [];
    const result = await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: (item) => {
        s.items.push(item);
        cursorsSeen.push(s.store.cursors.size);
        return 'verified';
      },
    });
    expect(result).toMatchObject({ partial: false, delivered: 23 });
    expect([...ids(s)].sort()).toEqual(wraps.map((w) => w.event.id).sort());
    expect(cursorsSeen.every((n) => n === 0)).toBe(true); // never before the last page
    expect(s.store.cursors.get(relay)).toBe(NOW);
    // Pages walk back: each later page asks for an older `until`.
    const untils = s.net
      .reqs(relay)
      .map((r) => r.filter.until)
      .filter((u): u is number => u !== undefined);
    expect(untils.length).toBeGreaterThanOrEqual(4);
    expect([...untils].sort((a, b) => b - a)).toEqual(untils);
  });

  it('is not starved by a flood of junk wraps tagged to us: older real events stay reachable', async () => {
    const s = setup();
    const [relay] = relayUrls('flood-cap', 1) as [string];
    s.net.configure(relay, { maxLimit: 5 });
    for (let i = 0; i < 40; i += 1) {
      s.net.inject(relay, junkWrap(s.recipient.pubkey, NOW - 10 - i) as unknown as NostrEvent);
    }
    const real = [1, 2, 3].map((i) => makeWrap(s.recipient, { createdAt: NOW - i * 6 * HOUR }));
    for (const w of real) s.net.inject(relay, w.event);
    const result = await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(result).toMatchObject({ partial: false, delivered: 3, dropped: 40 });
    expect(s.store.cursors.get(relay)).toBe(NOW);
  });

  it('reads a relay that ignores limit and until once, and ends', async () => {
    const s = setup();
    const [relay] = relayUrls('nolimit', 1) as [string];
    s.net.configure(relay, { ignoreLimit: true });
    const wraps = Array.from({ length: 12 }, (_, i) =>
      makeWrap(s.recipient, { createdAt: NOW - (i + 1) * 60 }),
    );
    for (const w of wraps) s.net.inject(relay, w.event);
    const result = await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(result).toMatchObject({ partial: false, delivered: 12 });
    expect(s.net.reqs(relay).length).toBeLessThanOrEqual(3);
  });

  it('keeps the cursor when pagination is interrupted, and resumes from the saved page next time', async () => {
    const s = setup();
    const [relay] = relayUrls('interrupt', 1) as [string];
    s.net.configure(relay, { maxLimit: 5 });
    const wraps = Array.from({ length: 14 }, (_, i) =>
      makeWrap(s.recipient, { createdAt: NOW - (i + 1) * 600 }),
    );
    for (const w of wraps) s.net.inject(relay, w.event);
    // After the first page the relay stops answering.
    let delivered = 0;
    const first = await within(
      s.engine.sync({
        relays: [relay],
        identities: identity(s),
        onEnvelope: (item) => {
          s.items.push(item);
          delivered += 1;
          if (delivered === 5) s.net.configure(relay, { maxLimit: 5, silentReq: true });
          return 'verified';
        },
      }),
      SYNC_BUDGET_MS,
    );
    expect(first.partial).toBe(true);
    expect(first.delivered).toBe(5);
    expect(s.store.cursors.has(relay)).toBe(false);
    const resume = s.store.resumes.get(relay);
    expect(resume?.startedAt).toBe(NOW);
    expect(resume?.until).toBe(NOW - 5 * 600);

    // The relay answers again: the next pass starts at the saved page, not at the newest.
    s.net.configure(relay, { maxLimit: 5 });
    const second = s.restart();
    const result = await second.engine.sync({
      relays: [relay],
      identities: identity(second),
      onEnvelope: second.handler(),
    });
    expect(second.net.reqs(relay).some((r) => r.filter.until === NOW - 5 * 600)).toBe(true);
    expect(result).toMatchObject({ partial: false });
    expect(s.items.length + second.items.length).toBe(14);
    expect(second.store.cursors.get(relay)).toBe(NOW);
    expect(second.store.resumes.has(relay)).toBe(false);
  });

  it('makes progress through a junk flood larger than the pass bound, across restarts (M-3)', async () => {
    const s = setup();
    const [relay] = relayUrls('bigflood', 1) as [string];
    s.net.configure(relay, { maxLimit: 500 });
    const total = MAX_NEW_WRAPS_PER_PASS + 60;
    for (let i = 0; i < total; i += 1) {
      s.net.inject(relay, junkWrap(s.recipient.pubkey, NOW - 100 - i) as unknown as NostrEvent);
    }
    const real = [1, 2].map((i) => makeWrap(s.recipient, { createdAt: NOW - i * 5 * HOUR }));
    for (const w of real) s.net.inject(relay, w.event);

    const first = await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(first.relays[0]).toMatchObject({ status: 'incomplete', reason: 'too_many_events' });
    expect(s.store.cursors.has(relay)).toBe(false);
    expect(s.store.resumes.has(relay)).toBe(true);

    const second = s.restart(); // a new process: the in-memory junk cache is empty
    const result = await second.engine.sync({
      relays: [relay],
      identities: identity(second),
      onEnvelope: second.handler(),
    });
    expect(result.partial).toBe(false);
    expect(second.items.map((i) => i.giftWrapId).sort()).toEqual(
      real.map((w) => w.event.id).sort(),
    );
    expect(second.store.cursors.get(relay)).toBe(NOW);
  });
});

describe('queue memory bound counts the whole event (M-2)', () => {
  it('ends a relay that fills frames with tags rather than content', async () => {
    const s = setup();
    const [relay] = relayUrls('tagflood', 1) as [string];
    s.net.inject(relay, makeWrap(s.recipient).event);
    s.net.configure(relay, {
      extraFrames: (subId) =>
        Array.from({ length: 220 }, () =>
          JSON.stringify([
            'EVENT',
            subId,
            { ...junkWrap(s.recipient.pubkey, NOW - 5), tags: [['x', 'a'.repeat(100_000)]] },
          ]),
        ),
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const done = s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: async (): Promise<SyncDisposition> => {
        await gate;
        return 'verified';
      },
    });
    await vi.advanceTimersByTimeAsync(100);
    release();
    const result = await done;
    expect(result.relays[0]).toMatchObject({ status: 'incomplete', reason: 'overflow' });
  });
});

describe('seen-set seam (Q-1) and ordering (L-3)', () => {
  it('works with a persistence that has no markSeen: core writes the seen row itself', async () => {
    const store = new MemorySync();
    const reads: string[] = [];
    const persistence: SyncPersistence = {
      getCursor: (r) => store.getCursor(r),
      setCursor: (r, t) => store.setCursor(r, t),
      isSeen: (k, id) => {
        reads.push(`${k}:${id}`);
        return store.isSeen(k, id);
      },
    };
    const net = new MockNetwork();
    const recipient = referenceKeys();
    const pool = new RelayPool({ connector: net, addressCheck: { resolver: net } });
    const engine = new SyncEngine({ pool, persistence, keys: recipient });
    const [relay] = relayUrls('nomark', 1) as [string];
    net.configure(relay);
    const wrap = makeWrap(recipient);
    net.inject(relay, wrap.event);
    const items: SyncItem[] = [];
    const handler = (item: SyncItem): SyncDisposition => {
      items.push(item);
      return 'verified';
    };
    const opts = {
      relays: [relay],
      identities: [{ pubkey: recipient.pubkey }],
      onEnvelope: handler,
    };
    expect(await engine.sync(opts)).toMatchObject({ delivered: 1 });
    expect(await engine.sync(opts)).toMatchObject({ delivered: 0, duplicates: 1 }); // in-process cache
    expect(items).toHaveLength(1);
    expect(reads).toContain(`wrap:${wrap.event.id}`);
  });

  it('does not read the persisted seen-set for a wrap that is not addressed to us', async () => {
    const s = setup();
    const reads: string[] = [];
    const isSeen = s.store.isSeen.bind(s.store);
    s.store.isSeen = (k, id) => {
      reads.push(id);
      return isSeen(k, id);
    };
    const [relay] = relayUrls('orderchk', 1) as [string];
    const foreign = makeWrap(referenceKeys()).event;
    s.net.configure(relay, { extraFrames: (subId) => [JSON.stringify(['EVENT', subId, foreign])] });
    await s.engine.sync({ relays: [relay], identities: identity(s), onEnvelope: s.handler() });
    expect(reads).not.toContain(foreign.id);
  });
});

describe('live cursor timing (L-1)', () => {
  it('writes the arrival time of the event, not the time it was handled', async () => {
    const s = setup();
    const [relay] = relayUrls('arrival', 1) as [string];
    s.net.configure(relay);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const unsubscribe = s.engine.subscribe({
      relays: [relay],
      identities: identity(s),
      onEnvelope: async (): Promise<SyncDisposition> => {
        await gate;
        return 'verified';
      },
    });
    await vi.advanceTimersByTimeAsync(100 * 1000);
    s.net.inject(relay, makeWrap(s.recipient, { createdAt: NOW + 50 }).event);
    await vi.advanceTimersByTimeAsync(400 * 1000); // the handler is still busy
    release();
    await vi.advanceTimersByTimeAsync(50);
    expect(s.store.cursors.get(relay)).toBe(NOW + 100);
    unsubscribe();
  });
});

// --- H-1b: a second that holds at least the relay's cap of events -------------------------------

describe('a saturated second (IR-M1-5c-1 H-1b)', () => {
  it('reaches an older real wrap behind a full page of wraps at one second', async () => {
    const s = setup();
    const [relay] = relayUrls('saturated', 1) as [string];
    s.net.configure(relay, { maxLimit: 5 });
    const T = NOW - 1_000;
    const same = Array.from({ length: 5 }, () => makeWrap(s.recipient, { createdAt: T }));
    const older = makeWrap(s.recipient, { createdAt: T - 3 * HOUR });
    for (const w of same) s.net.inject(relay, w.event);
    s.net.inject(relay, older.event);
    const cursorsSeen: number[] = [];
    const result = await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: (item) => {
        s.items.push(item);
        cursorsSeen.push(s.store.cursors.size);
        return 'verified';
      },
    });
    expect(ids(s)).toContain(older.event.id);
    expect(result).toMatchObject({ partial: false, delivered: 6 });
    expect(cursorsSeen.every((n) => n === 0)).toBe(true);
    expect(s.store.cursors.get(relay)).toBe(NOW);
  });

  it('is not hidden from by a junk flood of at least the cap at one timestamp', async () => {
    const s = setup();
    const [relay] = relayUrls('satflood', 1) as [string];
    s.net.configure(relay, { maxLimit: 5 });
    for (let i = 0; i < 12; i += 1) {
      s.net.inject(relay, junkWrap(s.recipient.pubkey, NOW - 500) as unknown as NostrEvent);
    }
    const real = [1, 2, 3].map((i) => makeWrap(s.recipient, { createdAt: NOW - 500 - i * HOUR }));
    for (const w of real) s.net.inject(relay, w.event);
    const result = await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect([...ids(s)].sort()).toEqual(real.map((w) => w.event.id).sort());
    expect(result.partial).toBe(false);
    expect(s.store.cursors.get(relay)).toBe(NOW);
  });

  it('walks through many saturated seconds with strictly falling pages and a bounded count', async () => {
    const s = setup();
    const [relay] = relayUrls('satbound', 1) as [string];
    s.net.configure(relay, { maxLimit: 2 });
    for (let sec = 0; sec < 40; sec += 1) {
      for (let k = 0; k < 3; k += 1) {
        s.net.inject(relay, junkWrap(s.recipient.pubkey, NOW - 100 - sec) as unknown as NostrEvent);
      }
    }
    const real = makeWrap(s.recipient, { createdAt: NOW - 2 * HOUR });
    s.net.inject(relay, real.event);
    const result = await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(ids(s)).toEqual([real.event.id]);
    expect(result.partial).toBe(false);
    const untils = s.net
      .reqs(relay)
      .map((r) => r.filter.until)
      .filter((u): u is number => u !== undefined);
    expect(untils.every((u, i) => i === 0 || u < (untils[i - 1] as number))).toBe(true);
    expect(s.net.reqs(relay).length).toBeLessThanOrEqual(MAX_PAGES_PER_PASS);
  });

  it('still stops when a relay ignores until (an event lies above it)', async () => {
    const s = setup();
    const [relay] = relayUrls('satignore', 1) as [string];
    s.net.configure(relay, { ignoreLimit: true });
    for (let i = 0; i < 6; i += 1) {
      s.net.inject(relay, makeWrap(s.recipient, { createdAt: NOW - 100 }).event);
    }
    const result = await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(result.partial).toBe(false);
    expect(s.net.reqs(relay).length).toBeLessThanOrEqual(3);
  });
});

// --- M1-5d: more events than a relay's cap within one second -------------------------------------

describe('more events than the relay cap within one second (M1-5d)', () => {
  it('reports the overflowing second of a capped relay with a fixed reason, and still moves on', async () => {
    const s = setup();
    const [relay] = relayUrls('gap-one', 1) as [string];
    s.net.configure(relay, { maxLimit: 5 });
    const T = NOW - 1_000;
    const same = Array.from({ length: 8 }, () => makeWrap(s.recipient, { createdAt: T }));
    const older = makeWrap(s.recipient, { createdAt: T - 3 * HOUR });
    for (const w of same) s.net.inject(relay, w.event);
    s.net.inject(relay, older.event);
    const result = await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    // Only the cap of that second can be read from this relay; the rest is reported, not dropped.
    expect(ids(s)).toContain(older.event.id);
    expect(s.items).toHaveLength(6);
    expect(result.gaps).toEqual([{ relay, second: T, reason: 'relay_cap' }]);
    // Reading the same relay again cannot fetch it, so the pass is not held for it (a junk flood
    // must not stall the cursor, H-1b).
    expect(result.partial).toBe(false);
    expect(s.store.cursors.get(relay)).toBe(NOW);
  });

  it('reports a saturated second even when nothing older lies in the window', async () => {
    const s = setup();
    const [relay] = relayUrls('gap-alone', 1) as [string];
    s.net.configure(relay, { maxLimit: 5 });
    const T = NOW - 2 * HOUR;
    for (let i = 0; i < 7; i += 1) {
      s.net.inject(relay, makeWrap(s.recipient, { createdAt: T }).event);
    }
    const result = await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(s.items).toHaveLength(5);
    expect(result.gaps).toEqual([{ relay, second: T, reason: 'relay_cap' }]);
  });

  it('delivers every wrap of the second across the relay list, and closes the gap there (M2-19)', async () => {
    const s = setup();
    const [capped, full] = relayUrls('gap-two', 2) as [string, string];
    s.net.configure(capped, { maxLimit: 5 });
    s.net.configure(full);
    const T = NOW - 1_000;
    const same = Array.from({ length: 9 }, () => makeWrap(s.recipient, { createdAt: T }));
    const older = makeWrap(s.recipient, { createdAt: T - 5 * HOUR });
    for (const w of [...same, older]) {
      s.net.inject(capped, w.event);
      s.net.inject(full, w.event);
    }
    const result = await s.engine.sync({
      relays: [capped, full],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect([...ids(s)].sort()).toEqual([...same, older].map((w) => w.event.id).sort());
    expect(result.delivered).toBe(10);
    // The full relay read that second in full and the capped relay holds what it hid (M2-19).
    expect(result.gaps).toEqual([]);
    expect(result.partial).toBe(false);
  });

  it('reports no gap for a capped relay whose seconds each hold fewer events than its cap', async () => {
    const s = setup();
    const [relay] = relayUrls('gap-none', 1) as [string];
    s.net.configure(relay, { maxLimit: 5 });
    const wraps = Array.from({ length: 23 }, (_, i) =>
      makeWrap(s.recipient, { createdAt: NOW - 600 - Math.floor(i / 2) * 60 }),
    );
    for (const w of wraps) s.net.inject(relay, w.event);
    const result = await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(result.delivered).toBe(23);
    expect(result.gaps ?? []).toEqual([]);
  });

  it('reports no gap for a single wrap or an empty relay', async () => {
    const s = setup();
    const [one, empty] = relayUrls('gap-single', 2) as [string, string];
    s.net.configure(one);
    s.net.configure(empty);
    s.net.inject(one, makeWrap(s.recipient, { createdAt: NOW - HOUR }).event);
    const result = await s.engine.sync({
      relays: [one, empty],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(result.delivered).toBe(1);
    expect(result.gaps ?? []).toEqual([]);
  });

  it('bounds the reported seconds by the page bound, and logs only their count', async () => {
    const s = setup();
    const [relay] = relayUrls('gap-many', 1) as [string];
    s.net.configure(relay, { maxLimit: 2 });
    for (let sec = 0; sec < 40; sec += 1) {
      for (let k = 0; k < 3; k += 1) {
        s.net.inject(relay, junkWrap(s.recipient.pubkey, NOW - 100 - sec) as unknown as NostrEvent);
      }
    }
    const result = await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    const gaps = result.gaps ?? [];
    expect(gaps.length).toBe(40);
    expect(gaps.length).toBeLessThanOrEqual(MAX_PAGES_PER_PASS);
    expect(gaps.every((g) => g.relay === relay && g.reason === 'relay_cap')).toBe(true);
    expect(new Set(gaps.map((g) => g.second)).size).toBe(40);
    const text = s.lines.join('\n');
    expect(text).toContain('"gaps":40');
    for (const g of gaps) expect(text).not.toContain(String(g.second));
  });

  it('logs the count of reported seconds of a live subscription, never the seconds', async () => {
    const s = setup();
    const [relay] = relayUrls('gap-live', 1) as [string];
    s.net.configure(relay, { maxLimit: 5 });
    const T = NOW - 1_000;
    for (let i = 0; i < 8; i += 1) {
      s.net.inject(relay, makeWrap(s.recipient, { createdAt: T }).event);
    }
    const unsubscribe = s.engine.subscribe({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    await vi.advanceTimersByTimeAsync(500);
    await unsubscribe();
    const text = s.lines.join('\n');
    expect(text).toContain('relay second over cap');
    expect(text).not.toContain(String(T));
  });
});

// --- M2-19: a bounded `ids` re-query closes a gap where another relay holds the events ------------

/** The REQs with an `ids` filter sent to `relay` (M2-19). */
const idsReqs = (s: Setup, relay: string) =>
  s.net.reqs(relay).filter((r) => (r.filter as { ids?: unknown }).ids !== undefined);
const reqIds = (r: { filter: unknown } | undefined): string[] =>
  (r?.filter as { ids?: string[] } | undefined)?.ids ?? [];

/** `count` wraps at second `at`, stored on every relay of `relays`. */
function injectEverywhere(s: Setup, relays: readonly string[], count: number, at: number) {
  const wraps = Array.from({ length: count }, () => makeWrap(s.recipient, { createdAt: at }));
  for (const w of wraps) for (const relay of relays) s.net.inject(relay, w.event);
  return wraps;
}

/**
 * One older wrap on each of `relays`. Without it a relay whose window holds only second T returns
 * all of it in one page at one second, which M1-5d reports as a (false-alarm) gap of its own, and a
 * relay with a gap at T closes no other gap there.
 */
function olderEverywhere(s: Setup, relays: readonly string[], at: number) {
  return injectEverywhere(s, relays, 1, at - HOUR);
}

describe('a bounded ids re-query for a relay-cap gap (M2-19)', () => {
  it('closes the gap of a capped relay when a second relay read that second in full', async () => {
    const s = setup();
    const [capped, full] = relayUrls('rq-close', 2) as [string, string];
    s.net.configure(capped, { maxLimit: 5 });
    s.net.configure(full);
    const T = NOW - 2_000;
    const same = injectEverywhere(s, [capped, full], 8, T);
    olderEverywhere(s, [capped, full], T);
    const result = await s.engine.sync({
      relays: [capped, full],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(result.delivered).toBe(9);
    expect(result.gaps).toEqual([]);
    expect(result.partial).toBe(false);
    // One query, on the capped relay only, for exactly the ids it did not show at that second.
    const rq = idsReqs(s, capped);
    expect(rq).toHaveLength(1);
    expect(idsReqs(s, full)).toHaveLength(0);
    const shown = new Set(same.slice(0, 5).map((w) => w.event.id));
    const asked = reqIds(rq[0]);
    expect([...asked].sort()).toEqual(
      same
        .map((w) => w.event.id)
        .filter((id) => !shown.has(id))
        .sort(),
    );
    expect(asked.length).toBeLessThanOrEqual(MAX_GAP_REQUERY_IDS);
    const filter = rq[0]?.filter as Record<string, unknown>;
    expect(filter.since).toBe(T);
    expect(filter.until).toBe(T);
    expect(filter.kinds).toEqual([1059]);
    expect(filter['#p']).toEqual([s.recipient.pubkey]);
    expect(filter.limit).toBe(asked.length);
    // Nothing is handed to the handler twice.
    expect(new Set(ids(s)).size).toBe(ids(s).length);
  });

  /**
   * `count` wraps at second `at` on each of `relays` that the seen-set already holds: the engine
   * takes them as `duplicate` without opening them (no crypto), which keeps the bound tests fast.
   */
  function seenEverywhere(s: Setup, relays: readonly string[], count: number, at: number) {
    const events = Array.from(
      { length: count },
      () => junkWrap(s.recipient.pubkey, at) as unknown as NostrEvent,
    );
    for (const event of events) {
      s.store.seen.set(`wrap:${event.id}`, NOW - 10);
      for (const relay of relays) s.net.inject(relay, event);
    }
    return events;
  }

  it('keeps the queries per pass and the ids per query within the fixed bounds', async () => {
    const s = setup();
    const [capped, full] = relayUrls('rq-bounds', 2) as [string, string];
    s.net.configure(capped, { maxLimit: 2 });
    s.net.configure(full);
    expect(MAX_GAP_REQUERIES_PER_PASS).toBe(16);
    expect(MAX_GAP_REQUERY_IDS).toBe(64);
    const seconds = MAX_GAP_REQUERIES_PER_PASS + 4;
    for (let sec = 0; sec < seconds; sec += 1)
      seenEverywhere(s, [capped, full], 3, NOW - 100 - sec);
    const result = await s.engine.sync({
      relays: [capped, full],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    const rq = idsReqs(s, capped);
    expect(rq).toHaveLength(MAX_GAP_REQUERIES_PER_PASS);
    for (const r of rq) {
      expect(reqIds(r).length).toBeGreaterThan(0);
      expect(reqIds(r).length).toBeLessThanOrEqual(MAX_GAP_REQUERY_IDS);
    }
    // The gaps over the query bound stay reported, so the user still hears of them (M1-5g).
    expect(result.gaps ?? []).toHaveLength(seconds - MAX_GAP_REQUERIES_PER_PASS);
    expect(result.partial).toBe(false);
    expect(result.dropped).toBe(0);
  });

  it('queries a second with exactly the bound of missing ids, and closes it', async () => {
    const s = setup();
    const [capped, full] = relayUrls('rq-at-bound', 2) as [string, string];
    // A relay's cap applies to the ids query too, so this one shows 64 and can return 64 more.
    s.net.configure(capped, { maxLimit: MAX_GAP_REQUERY_IDS });
    s.net.configure(full);
    const T = NOW - 3_000;
    seenEverywhere(s, [capped, full], 2 * MAX_GAP_REQUERY_IDS, T);
    seenEverywhere(s, [capped, full], 1, T - HOUR);
    const result = await s.engine.sync({
      relays: [capped, full],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    const rq = idsReqs(s, capped);
    expect(rq).toHaveLength(1);
    expect(reqIds(rq[0])).toHaveLength(MAX_GAP_REQUERY_IDS);
    expect(result.gaps).toEqual([]);
  });

  it('does not query a second with more missing ids than the bound, and keeps it reported', async () => {
    const s = setup();
    const [capped, full] = relayUrls('rq-many-ids', 2) as [string, string];
    s.net.configure(capped, { maxLimit: 5 });
    s.net.configure(full);
    const T = NOW - 3_000;
    seenEverywhere(s, [capped, full], MAX_GAP_REQUERY_IDS + 6, T);
    seenEverywhere(s, [capped, full], 1, T - HOUR);
    const result = await s.engine.sync({
      relays: [capped, full],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(idsReqs(s, capped)).toHaveLength(0);
    expect(result.gaps).toEqual([{ relay: capped, second: T, reason: 'relay_cap' }]);
  });

  it('keeps a gap no relay can close reported: a lone capped relay', async () => {
    const s = setup();
    const [relay] = relayUrls('rq-alone', 1) as [string];
    s.net.configure(relay, { maxLimit: 5 });
    const T = NOW - 1_500;
    injectEverywhere(s, [relay], 8, T);
    const result = await s.engine.sync({
      relays: [relay],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(idsReqs(s, relay)).toHaveLength(0);
    expect(result.gaps).toEqual([{ relay, second: T, reason: 'relay_cap' }]);
  });

  it('keeps both gaps when every relay is capped at that second', async () => {
    const s = setup();
    const [a, b] = relayUrls('rq-both', 2) as [string, string];
    s.net.configure(a, { maxLimit: 5 });
    s.net.configure(b, { maxLimit: 5 });
    const T = NOW - 1_500;
    injectEverywhere(s, [a, b], 8, T);
    const result = await s.engine.sync({
      relays: [a, b],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(idsReqs(s, a)).toHaveLength(0);
    expect(idsReqs(s, b)).toHaveLength(0);
    expect(result.gaps).toEqual([
      { relay: a, second: T, reason: 'relay_cap' },
      { relay: b, second: T, reason: 'relay_cap' },
    ]);
  });

  it('keeps the gap when the other relay holds nothing more at that second', async () => {
    const s = setup();
    const [capped, other] = relayUrls('rq-nothing', 2) as [string, string];
    s.net.configure(capped, { maxLimit: 5 });
    s.net.configure(other);
    const T = NOW - 1_500;
    // A junk flood on the capped relay only; the other relay has a wrap at another second.
    for (let i = 0; i < 9; i += 1) {
      s.net.inject(capped, junkWrap(s.recipient.pubkey, T) as unknown as NostrEvent);
    }
    s.net.inject(other, makeWrap(s.recipient, { createdAt: T - 60 }).event);
    const result = await s.engine.sync({
      relays: [capped, other],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(idsReqs(s, capped)).toHaveLength(0);
    expect(result.gaps).toEqual([{ relay: capped, second: T, reason: 'relay_cap' }]);
  });

  it('keeps the gap when the capped relay does not hold what the other relay returned', async () => {
    const s = setup();
    const [capped, other] = relayUrls('rq-disjoint', 2) as [string, string];
    s.net.configure(capped, { maxLimit: 5 });
    s.net.configure(other);
    const T = NOW - 1_500;
    // The other relay holds everything the capped relay shows, plus 3 wraps the capped one lacks.
    injectEverywhere(s, [capped, other], 5, T);
    injectEverywhere(s, [capped], 3, T);
    const elsewhere = injectEverywhere(s, [other], 3, T);
    olderEverywhere(s, [capped, other], T);
    const result = await s.engine.sync({
      relays: [capped, other],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    const rq = idsReqs(s, capped);
    expect(rq).toHaveLength(1);
    expect([...reqIds(rq[0])].sort()).toEqual(elsewhere.map((w) => w.event.id).sort());
    expect(result.gaps).toEqual([{ relay: capped, second: T, reason: 'relay_cap' }]);
    expect(result.delivered).toBe(9);
  });

  // --- IR-M2-19-1 H-1: "no gap at T" on the other relay is not proof it read T in full ---------

  it('keeps the gap when the other relay is capped below MIN_GAP_EVENTS (cap 1)', async () => {
    const s = setup();
    const [capped, tiny] = relayUrls('rq-cap-one', 2) as [string, string];
    s.net.configure(capped, { maxLimit: 5 });
    s.net.configure(tiny, { maxLimit: 1, newestFirst: true });
    const T = NOW - 1_500;
    injectEverywhere(s, [capped, tiny], 8, T);
    const result = await s.engine.sync({
      relays: [capped, tiny],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(result.delivered).toBeLessThan(8);
    expect(idsReqs(s, capped)).toHaveLength(0);
    expect(result.gaps).toEqual([{ relay: capped, second: T, reason: 'relay_cap' }]);
  });

  it('keeps the gap when the other relay ignores `until` (its walk ends early)', async () => {
    const s = setup();
    const [capped, loose] = relayUrls('rq-ignores-until', 2) as [string, string];
    s.net.configure(capped, { maxLimit: 5 });
    s.net.configure(loose, { ignoreLimit: true, maxLimit: 9 });
    const T = NOW - 1_500;
    injectEverywhere(s, [capped, loose], 1, T + 10);
    injectEverywhere(s, [capped, loose], 8, T);
    const result = await s.engine.sync({
      relays: [capped, loose],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(result.relays.find((r) => r.relay === loose)?.status).toBe('complete');
    expect(idsReqs(s, capped)).toHaveLength(0);
    expect(result.gaps).toEqual([{ relay: capped, second: T, reason: 'relay_cap' }]);
  });

  it("keeps the gap when the second is the other relay's `since` (its walk may cut there)", async () => {
    const s = setup();
    const [capped, edge] = relayUrls('rq-at-since', 2) as [string, string];
    s.net.configure(capped, { maxLimit: 5 });
    s.net.configure(edge, { maxLimit: 6 });
    const T = NOW - 500 - SYNC_LOOKBACK_SECONDS - SYNC_SKEW_SECONDS;
    s.store.cursors.set(edge, NOW - 500); // the edge relay's window starts exactly at T
    injectEverywhere(s, [capped, edge], 8, T);
    const result = await s.engine.sync({
      relays: [capped, edge],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(idsReqs(s, capped)).toHaveLength(0);
    expect(result.gaps).toEqual([{ relay: capped, second: T, reason: 'relay_cap' }]);
  });

  // --- IR-M2-19-2 H-2: a page smaller than the largest is no proof that it was not capped ---------

  /** `count` wraps at the distinct seconds T+1 … T+count on each of `relays`. */
  function newerEverywhere(s: Setup, relays: readonly string[], count: number, at: number) {
    for (let i = 1; i <= count; i += 1) injectEverywhere(s, relays, 1, at + i);
  }

  it('keeps the gap when the other relay lowers its cap between pages (10, then 7)', async () => {
    const s = setup();
    const [capped, shifty] = relayUrls('rq-cap-shift', 2) as [string, string];
    s.net.configure(capped, { maxLimit: 5 });
    s.net.configure(shifty, { capSequence: [10, 7] });
    const T = NOW - 1_500;
    newerEverywhere(s, [capped, shifty], 10, T);
    injectEverywhere(s, [capped, shifty], 9, T);
    olderEverywhere(s, [capped, shifty], T);
    const result = await s.engine.sync({
      relays: [capped, shifty],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(result.relays.find((r) => r.relay === shifty)?.status).toBe('complete');
    expect(idsReqs(s, capped)).toHaveLength(0);
    expect(result.gaps).toEqual([{ relay: capped, second: T, reason: 'relay_cap' }]);
  });

  it('keeps the gap when the other relay serves that second only on a smaller last page (8, 8, then 7)', async () => {
    const s = setup();
    const [capped, shifty] = relayUrls('rq-cap-last', 2) as [string, string];
    s.net.configure(capped, { maxLimit: 5 });
    s.net.configure(shifty, { capSequence: [8, 8, 7] });
    const T = NOW - 1_500;
    newerEverywhere(s, [capped, shifty], 16, T);
    injectEverywhere(s, [capped, shifty], 9, T);
    olderEverywhere(s, [capped, shifty], T);
    const result = await s.engine.sync({
      relays: [capped, shifty],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(result.relays.find((r) => r.relay === shifty)?.status).toBe('complete');
    expect(idsReqs(s, capped)).toHaveLength(0);
    expect(result.gaps).toEqual([{ relay: capped, second: T, reason: 'relay_cap' }]);
  });

  // --- AUDIT-FABLE-M2-19-1: exclusive `until` (M-1) and stray frames as page evidence (L-1, L-2) ---

  it('keeps the gap when the other relay applies `until` exclusively and cut that second', async () => {
    const s = setup();
    const [capped, strict] = relayUrls('rq-excl-until', 2) as [string, string];
    s.net.configure(capped, { maxLimit: 2 });
    s.net.configure(strict, { maxLimit: 4, exclusiveUntil: true });
    const T = NOW - 1_500;
    injectEverywhere(s, [capped, strict], 1, T + 10);
    injectEverywhere(s, [capped, strict], 6, T);
    injectEverywhere(s, [capped, strict], 1, T - 10);
    const result = await s.engine.sync({
      relays: [capped, strict],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(result.relays.find((r) => r.relay === strict)?.status).toBe('complete');
    expect(idsReqs(s, capped)).toHaveLength(0);
    expect(result.gaps).toEqual([{ relay: capped, second: T, reason: 'relay_cap' }]);
  });

  /** The other relay cuts T (cap 4) and adds one stray frame at T-10 to its first page. */
  async function strayCase(name: string, stray: (s: Setup, at: number) => Record<string, unknown>) {
    const s = setup();
    const [capped, other] = relayUrls(name, 2) as [string, string];
    const T = NOW - 1_500;
    s.net.configure(capped, { maxLimit: 2 });
    s.net.configure(other, {
      maxLimit: 4,
      extraFrames: (subId) => [JSON.stringify(['EVENT', subId, stray(s, T - 10)])],
    });
    injectEverywhere(s, [capped, other], 1, T + 10);
    injectEverywhere(s, [capped, other], 6, T);
    const result = await s.engine.sync({
      relays: [capped, other],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(idsReqs(s, capped)).toHaveLength(0);
    expect(result.gaps).toEqual([{ relay: capped, second: T, reason: 'relay_cap' }]);
  }

  it('does not take a stray kind-1 event as proof that a second was read in full', async () => {
    await strayCase('rq-stray-kind', (s, at) => ({ ...junkWrap(s.recipient.pubkey, at), kind: 1 }));
  });

  it('does not take a wrap for a foreign key as proof that a second was read in full', async () => {
    await strayCase('rq-stray-p', (_s, at) => junkWrap(encodeHex(randomBytes(32)), at));
  });

  it('does not take an older junk wrap with a bad signature, out of order, as proof', async () => {
    await strayCase('rq-stray-sig', (s, at) => junkWrap(s.recipient.pubkey, at));
  });

  it('keeps the gap when the other relay lacks a wrap the capped relay showed at that second', async () => {
    const s = setup();
    const [capped, other] = relayUrls('rq-not-superset', 2) as [string, string];
    s.net.configure(capped, { maxLimit: 5 });
    s.net.configure(other);
    const T = NOW - 1_500;
    injectEverywhere(s, [capped], 1, T); // shown by the capped relay, absent from the other
    injectEverywhere(s, [capped, other], 7, T);
    olderEverywhere(s, [capped, other], T);
    const result = await s.engine.sync({
      relays: [capped, other],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(idsReqs(s, capped)).toHaveLength(0);
    expect(result.gaps).toEqual([{ relay: capped, second: T, reason: 'relay_cap' }]);
  });

  it('keeps the gap when the other relay did not complete its pass', async () => {
    const s = setup();
    const [capped, other] = relayUrls('rq-incomplete', 2) as [string, string];
    s.net.configure(capped, { maxLimit: 5 });
    s.net.configure(other);
    const T = NOW - 1_500;
    const same = injectEverywhere(s, [capped, other], 8, T);
    olderEverywhere(s, [capped, other], T);
    // The handler asks to see a wrap only the other relay showed again: its pass is not complete.
    const retryId = same[7]?.event.id;
    const result = await s.engine.sync({
      relays: [capped, other],
      identities: identity(s),
      onEnvelope: (item) => {
        s.items.push(item);
        return Promise.resolve(item.giftWrapId === retryId ? 'retry' : 'verified');
      },
    });
    expect(result.relays.find((r) => r.relay === other)?.status).toBe('incomplete');
    expect(idsReqs(s, capped)).toHaveLength(0);
    expect(result.gaps).toEqual([{ relay: capped, second: T, reason: 'relay_cap' }]);
  });

  it('gives up a re-query the capped relay never answers, well inside the time budget', async () => {
    const s = setup();
    const [capped, full] = relayUrls('rq-silent', 2) as [string, string];
    s.net.configure(capped, { maxLimit: 5, silentIdsReq: true });
    s.net.configure(full);
    const T = NOW - 1_500;
    injectEverywhere(s, [capped, full], 8, T);
    olderEverywhere(s, [capped, full], T);
    let settled = false;
    const done = s.engine
      .sync({ relays: [capped, full], identities: identity(s), onEnvelope: s.handler() })
      .finally(() => (settled = true));
    expect(GAP_REQUERY_TIMEOUT_MS).toBeLessThan(SYNC_BUDGET_MS);
    await vi.advanceTimersByTimeAsync(GAP_REQUERY_TIMEOUT_MS + 10);
    expect(settled).toBe(true);
    const result = await done;
    const rq = idsReqs(s, capped);
    expect(rq).toHaveLength(1);
    expect(result.gaps).toEqual([{ relay: capped, second: T, reason: 'relay_cap' }]);
    expect(result.partial).toBe(false);
    const closes = s.net.received.filter(
      (r) => r.relay === capped && r.frame === JSON.stringify(['CLOSE', rq[0]?.subId]),
    );
    expect(closes).toHaveLength(1);
  });

  it('stops a re-query that returns more frames than it asked for, and keeps the gap', async () => {
    const s = setup();
    const [capped, full] = relayUrls('rq-hostile', 2) as [string, string];
    const T = NOW - 1_500;
    s.net.configure(capped, {
      maxLimit: 5,
      idsExtraFrames: (subId) =>
        Array.from({ length: 50 }, () =>
          JSON.stringify(['EVENT', subId, junkWrap(s.recipient.pubkey, T)]),
        ),
    });
    s.net.configure(full);
    const same = injectEverywhere(s, [capped, full], 8, T);
    const older = olderEverywhere(s, [capped, full], T);
    const result = await s.engine.sync({
      relays: [capped, full],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(idsReqs(s, capped)).toHaveLength(1);
    expect(result.gaps).toEqual([{ relay: capped, second: T, reason: 'relay_cap' }]);
    const known = [...same, ...older].map((w) => w.event.id);
    expect(s.items.every((i) => known.includes(i.giftWrapId))).toBe(true);
    expect(result.delivered).toBe(9);
  });

  it('runs no ids re-query in a live subscription', async () => {
    const s = setup();
    const [capped, full] = relayUrls('rq-live', 2) as [string, string];
    s.net.configure(capped, { maxLimit: 5 });
    s.net.configure(full);
    injectEverywhere(s, [capped, full], 8, NOW - 1_000);
    const unsubscribe = s.engine.subscribe({
      relays: [capped, full],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    await vi.advanceTimersByTimeAsync(500);
    await unsubscribe();
    expect(idsReqs(s, capped)).toHaveLength(0);
  });

  it('never logs an id, a second or a relay URL, only counts', async () => {
    const s = setup();
    const [capped, full] = relayUrls('rq-log', 2) as [string, string];
    s.net.configure(capped, { maxLimit: 5 });
    s.net.configure(full);
    const T = NOW - 1_500;
    const same = injectEverywhere(s, [capped, full], 8, T);
    olderEverywhere(s, [capped, full], T);
    await s.engine.sync({
      relays: [capped, full],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    const text = s.lines.join('\n');
    expect(text).toContain('"gapsClosed":1');
    expect(text).not.toContain(String(T));
    expect(text).not.toContain(capped);
    expect(text).not.toContain(full);
    for (const w of same) expect(text).not.toContain(w.event.id);
  });

  it('does not close a gap from a relay it stopped learning ids from (memory bound)', async () => {
    expect(MAX_LEARNED_IDS_PER_RELAY).toBe(2_048);
    // The bound is injected (learnedIdsPerRelay), so a small one proves it with few inputs.
    const s = setup({ learnedIdsPerRelay: 6 });
    const [capped, full] = relayUrls('rq-learn-bound', 2) as [string, string];
    s.net.configure(capped, { maxLimit: 5 });
    s.net.configure(full);
    const T = NOW - 1_500;
    injectEverywhere(s, [capped, full], 8, T);
    olderEverywhere(s, [capped, full], T);
    const result = await s.engine.sync({
      relays: [capped, full],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(result.relays.find((r) => r.relay === full)?.status).toBe('complete');
    expect(result.delivered).toBe(9);
    expect(idsReqs(s, capped)).toHaveLength(0);
    expect(result.gaps).toEqual([{ relay: capped, second: T, reason: 'relay_cap' }]);
  });

  it('closes the same gap with a learned-ids bound the relay stays under', async () => {
    const s = setup({ learnedIdsPerRelay: 9 });
    const [capped, full] = relayUrls('rq-learn-under', 2) as [string, string];
    s.net.configure(capped, { maxLimit: 5 });
    s.net.configure(full);
    const T = NOW - 1_500;
    injectEverywhere(s, [capped, full], 8, T);
    olderEverywhere(s, [capped, full], T);
    const result = await s.engine.sync({
      relays: [capped, full],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    expect(idsReqs(s, capped)).toHaveLength(1);
    expect(result.gaps).toEqual([]);
  });
});

describe('a bound drop shared between relays (L-2)', () => {
  it("holds the cursor of a relay that waited on another relay's over-bound drop", async () => {
    const s = setup();
    const [a, b] = relayUrls('shared-bound', 2) as [string, string];
    const wrap = makeWrap(s.recipient, { createdAt: NOW - 3 * HOUR });
    // Relay A uses up the pass bound with junk, then serves the wrap as the 2001st opening.
    s.net.configure(a, {
      extraFrames: (subId) => [
        ...Array.from({ length: MAX_NEW_WRAPS_PER_PASS }, () =>
          JSON.stringify(['EVENT', subId, junkWrap(s.recipient.pubkey, NOW - 10)]),
        ),
        JSON.stringify(['EVENT', subId, wrap.event]),
      ],
      noEose: true,
    });
    // Relay B is quiet until the wrap is already being opened for A.
    s.net.configure(b, { noEose: true });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const isSeen = s.store.isSeen.bind(s.store);
    s.store.isSeen = (k, id) => (id === wrap.event.id ? gate.then(() => false) : isSeen(k, id));

    const done = s.engine.sync({
      relays: [a, b],
      identities: identity(s),
      onEnvelope: s.handler(),
    });
    await vi.advanceTimersByTimeAsync(200); // A is stuck on the wrap's seen-set read
    s.net.inject(b, wrap.event); // B's copy arrives and waits on A's work
    await vi.advanceTimersByTimeAsync(50);
    release();
    const result = await within(done, 10);

    expect(s.items).toHaveLength(0);
    for (const relay of [a, b]) {
      expect(result.relays.find((r) => r.relay === relay)).toMatchObject({
        status: 'incomplete',
        reason: 'too_many_events',
      });
      expect(s.store.cursors.has(relay)).toBe(false);
    }
  });
});
