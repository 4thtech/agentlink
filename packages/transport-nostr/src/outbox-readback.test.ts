// SEC-RELAY-READBACK (D-156 (7); 07 §4.2, §4.3): a row is `sent` only once a relay that answered OK
// serves the wrap back by its id, on a fresh connection and without a login. When no relay can be
// checked the row is `sent` with availability `unknown`. Mock relays, a fake clock.
import { createLogger, type Level } from '@4thtech-io/log';
import { MemoryKeyStore } from '@4thtech-io/crypto/testing';
import { randomBytes, type EnvelopeKeys } from '@4thtech-io/crypto';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OUTBOX_GIVE_UP_SECONDS,
  OutboxWorker,
  READBACK_RECHECK_MS,
  type OutboxAttempt,
  type OutboxAvailability,
  type OutboxPersistence,
  type OutboxRow,
} from './outbox.js';
import { READBACK_TIMEOUT_MS, RelayPool, type ReadbackOutcome } from './relay-pool.js';
import { MockNetwork, makeWrapEvent, relayUrls } from './testing/mock-network.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-18T10:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

type StoredRow = OutboxRow & { state: string; availability?: OutboxAvailability };

class Rows implements OutboxPersistence {
  readonly rows = new Map<string, StoredRow>();
  add(row: OutboxRow): void {
    this.rows.set(row.wrapId, { ...row, state: 'pending' });
  }
  get(id: string): StoredRow {
    return this.rows.get(id) as StoredRow;
  }
  listDue(now: number): Promise<readonly OutboxRow[]> {
    return Promise.resolve(
      [...this.rows.values()].filter((r) => r.state === 'pending' && r.nextAttemptAt <= now),
    );
  }
  isPending(id: string): Promise<boolean> {
    return Promise.resolve(this.rows.get(id)?.state === 'pending');
  }
  recordAttempt(id: string, a: OutboxAttempt): Promise<boolean> {
    this.rows.set(id, { ...this.get(id), ...a });
    return Promise.resolve(true);
  }
  markSent(
    id: string,
    acks: Readonly<Record<string, number>>,
    availability: OutboxAvailability,
  ): Promise<boolean> {
    this.rows.set(id, { ...this.get(id), acks, state: 'sent', availability });
    return Promise.resolve(true);
  }
  markNotDelivered(id: string): Promise<boolean> {
    this.rows.set(id, { ...this.get(id), state: 'not_delivered' });
    return Promise.resolve(true);
  }
}

function makeRow(relays: readonly string[], acks: Record<string, number> = {}): OutboxRow {
  const recipientKey = getPublicKey(generateSecretKey());
  const event = makeWrapEvent({ recipient: recipientKey, createdAt: nowSeconds() });
  const createdAt = nowSeconds();
  return {
    wrapId: event.id,
    envelopeId: 'e'.repeat(64),
    recipientKey,
    wrapJson: JSON.stringify(event),
    relays,
    acks,
    attempts: 0,
    nextAttemptAt: createdAt,
    createdAt,
    giveUpAt: createdAt + OUTBOX_GIVE_UP_SECONDS,
    role: 'contact',
  };
}

function setup(options: { auth?: boolean } = {}) {
  const net = new MockNetwork();
  const rows = new Rows();
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', sink: (_l: Level, l: string) => lines.push(l) });
  const keys = new MemoryKeyStore(randomBytes(32)) as EnvelopeKeys;
  const pool = new RelayPool({
    connector: net,
    addressCheck: { resolver: net },
    nip11: net,
    logger,
    ...(options.auth === true ? { authKeys: keys, mayAuthenticate: () => true } : {}),
  });
  const worker = new OutboxWorker({ persistence: rows, pool, logger, random: () => 0 });
  return { net, rows, worker, lines, pool };
}

/** Runs one pass to the end, moving the fake clock through any re-check wait. */
async function pass(worker: OutboxWorker) {
  const done = worker.processDue();
  await vi.advanceTimersByTimeAsync(READBACK_RECHECK_MS + READBACK_TIMEOUT_MS * 2);
  return done;
}

describe('read-back before "sent"', () => {
  it('is sent with availability confirmed when an acking relay serves the wrap back', async () => {
    const { net, rows, worker } = setup();
    const relays = relayUrls('ok', 2);
    for (const url of relays) net.configure(url);
    const row = makeRow(relays);
    rows.add(row);
    const summary = await pass(worker);
    expect(summary).toMatchObject({ sent: 1, retrying: 0 });
    expect(rows.get(row.wrapId)).toMatchObject({ state: 'sent', availability: 'confirmed' });
    const reqs = relays.flatMap((r) => net.reqs(r));
    expect(reqs.length).toBeGreaterThan(0);
    for (const req of reqs) expect(req.filter).toEqual({ ids: [row.wrapId], limit: 1 });
  });

  it('is sent when only one of the acking relays serves it', async () => {
    const { net, rows, worker } = setup();
    const [good, liar] = relayUrls('one', 2) as [string, string];
    net.configure(good);
    net.configure(liar, { neverServes: true });
    const row = makeRow([good, liar]);
    rows.add(row);
    await pass(worker);
    expect(rows.get(row.wrapId)).toMatchObject({ state: 'sent', availability: 'confirmed' });
  });

  it('never confirms on OKs whose relays answer empty: with no other relay to try, sent and unknown', async () => {
    const { net, rows, worker } = setup();
    const relays = relayUrls('liar', 2);
    for (const url of relays) net.configure(url, { neverServes: true });
    const row = makeRow(relays);
    rows.add(row);
    expect(await pass(worker)).toMatchObject({ sent: 1, notDelivered: 0 });
    expect(rows.get(row.wrapId)).toMatchObject({ state: 'sent', availability: 'unknown' });
  });

  it('does not count a relay that serves the wrap only on the connection that published it', async () => {
    const { net, rows, worker } = setup();
    const relays = relayUrls('same', 2);
    for (const url of relays) net.configure(url, { sameSocketOnly: true });
    const row = makeRow(relays);
    rows.add(row);
    expect(await pass(worker)).toMatchObject({ sent: 1 });
    expect(rows.get(row.wrapId)).toMatchObject({ state: 'sent', availability: 'unknown' });
  });

  it("after an empty read, keeps the OKs and republishes only to the row's other relays", async () => {
    const { net, rows, worker } = setup();
    const [e1, e2, later] = relayUrls('more', 3) as [string, string, string];
    net.configure(e1, { neverServes: true });
    net.configure(e2, { neverServes: true });
    net.configure(later, { reject: true });
    const row = makeRow([e1, e2, later]);
    rows.add(row);
    const start = nowSeconds();
    expect(await pass(worker)).toMatchObject({ sent: 0, retrying: 1, notDelivered: 0 });
    const stored = rows.get(row.wrapId);
    expect(stored.state).toBe('pending');
    // The OKs stay (the relays accepted it); they just do not confirm it.
    expect(Object.keys(stored.acks).sort()).toEqual([e1, e2].sort());
    expect(stored.nextAttemptAt).toBe(start + 30);

    net.configure(later); // the third relay works now and serves it
    const events = (): string[] =>
      net.received.filter((r) => r.frame.startsWith('["EVENT"')).map((r) => r.relay);
    const before = events().length;
    vi.setSystemTime((start + 31) * 1000);
    expect(await pass(worker)).toMatchObject({ sent: 1 });
    expect(events().slice(before)).toEqual([later]);
    expect(rows.get(row.wrapId)).toMatchObject({ state: 'sent', availability: 'confirmed' });
  });

  it('an empty read never makes a message not delivered: at the give-up time it is sent, unknown', async () => {
    const { net, rows, worker } = setup();
    const [e1, e2, down] = relayUrls('bound', 3) as [string, string, string];
    net.configure(e1, { neverServes: true });
    net.configure(e2, { neverServes: true });
    net.configure(down, { reject: true });
    const row = makeRow([e1, e2, down]);
    rows.add(row);
    await pass(worker);
    expect(rows.get(row.wrapId).state).toBe('pending');
    vi.setSystemTime(Date.now() + OUTBOX_GIVE_UP_SECONDS * 1000);
    expect(await pass(worker)).toMatchObject({ sent: 1, notDelivered: 0 });
    expect(rows.get(row.wrapId)).toMatchObject({ state: 'sent', availability: 'unknown' });
  });

  it('at the give-up time one OK is enough for sent, unknown; none at all stays not delivered', async () => {
    const { net, rows, worker } = setup();
    const [one, down] = relayUrls('single', 2) as [string, string];
    net.configure(one, { neverServes: true });
    net.configure(down, { reject: true });
    const row = makeRow([one, down]);
    rows.add(row);
    expect(await pass(worker)).toMatchObject({ retrying: 1 });
    const [d1, d2] = relayUrls('none', 2) as [string, string];
    net.configure(d1, { reject: true });
    net.configure(d2, { reject: true });
    const dead = makeRow([d1, d2]);
    rows.add(dead);
    vi.setSystemTime(Date.now() + OUTBOX_GIVE_UP_SECONDS * 1000);
    expect(await pass(worker)).toMatchObject({ sent: 1, notDelivered: 1 });
    expect(rows.get(row.wrapId)).toMatchObject({ state: 'sent', availability: 'unknown' });
    expect(rows.get(dead.wrapId).state).toBe('not_delivered');
  });

  it('re-checks once after a short wait, for a relay that stores the wrap a moment after its OK', async () => {
    const { net, rows, worker } = setup();
    const relays = relayUrls('lag', 2);
    for (const url of relays) net.configure(url, { neverServes: true });
    const row = makeRow(relays);
    rows.add(row);
    const done = worker.processDue();
    await vi.advanceTimersByTimeAsync(10);
    // The relay now has it (as if its write landed late).
    net.inject(relays[0] as string, JSON.parse(row.wrapJson));
    await vi.advanceTimersByTimeAsync(READBACK_RECHECK_MS + READBACK_TIMEOUT_MS);
    expect(await done).toMatchObject({ sent: 1 });
    expect(rows.get(row.wrapId)).toMatchObject({ state: 'sent', availability: 'confirmed' });
  });

  it('is sent with availability unknown when no relay can be checked (each wants a login to read)', async () => {
    const { net, rows, worker } = setup({ auth: true });
    const relays = relayUrls('gated', 2);
    for (const url of relays) net.configure(url, { requireAuth: true });
    const row = makeRow(relays);
    rows.add(row);
    expect(await pass(worker)).toMatchObject({ sent: 1 });
    expect(rows.get(row.wrapId)).toMatchObject({ state: 'sent', availability: 'unknown' });
  });

  it('is sent with availability unknown when every check times out, within the bound', async () => {
    const { net, rows, worker } = setup();
    const relays = relayUrls('mute', 2);
    for (const url of relays) net.configure(url, { silentIdsReq: true });
    const row = makeRow(relays);
    rows.add(row);
    let summary: unknown;
    void worker.processDue().then((s) => {
      summary = s;
    });
    await vi.advanceTimersByTimeAsync(READBACK_TIMEOUT_MS + 10);
    expect(summary).toMatchObject({ sent: 1 });
    expect(rows.get(row.wrapId)).toMatchObject({ state: 'sent', availability: 'unknown' });
  });

  it('checks stored acks too (a crash after the publish): an OK nobody can back never confirms', async () => {
    const { net, rows, worker } = setup();
    const relays = relayUrls('crash', 2);
    for (const url of relays) net.configure(url, { neverServes: true });
    const at = nowSeconds();
    const row = makeRow(relays, Object.fromEntries(relays.map((r) => [r, at])));
    rows.add(row);
    expect(await pass(worker)).toMatchObject({ sent: 1 });
    expect(rows.get(row.wrapId)).toMatchObject({ state: 'sent', availability: 'unknown' });
    expect(net.received.filter((r) => r.frame.startsWith('["EVENT"'))).toHaveLength(0);
  });

  it('marks availability unknown when the pool cannot check at all', async () => {
    const rows = new Rows();
    const relays = relayUrls('nocheck', 2);
    const row = makeRow(relays);
    rows.add(row);
    const worker = new OutboxWorker({
      persistence: rows,
      pool: {
        publish: (_event, list) =>
          Promise.resolve({
            results: list.map((relay) => ({ relay, ok: true, reason: 'ok' as const })),
            acked: [...list],
            sent: true,
          }),
      },
    });
    await worker.processDue();
    expect(rows.get(row.wrapId)).toMatchObject({ state: 'sent', availability: 'unknown' });
  });

  it('asks only relays of the row that answered OK', async () => {
    const asked: string[] = [];
    const rows = new Rows();
    const [a, b, down] = relayUrls('ask', 3) as [string, string, string];
    const row = makeRow([a, b, down]);
    rows.add(row);
    const worker = new OutboxWorker({
      persistence: rows,
      pool: {
        publish: () =>
          Promise.resolve({
            results: [
              { relay: a, ok: true, reason: 'ok' as const },
              { relay: b, ok: true, reason: 'ok' as const },
              { relay: down, ok: false, reason: 'rejected' as const },
            ],
            acked: [a, b, 'wss://not-in-the-row.example.com'],
            sent: true,
          }),
        checkServed: (relay: string): Promise<ReadbackOutcome> => {
          asked.push(relay);
          return Promise.resolve('served');
        },
      },
    });
    await worker.processDue();
    expect(asked.length).toBeGreaterThan(0);
    for (const relay of asked) expect([a, b]).toContain(relay);
    expect(rows.get(row.wrapId).availability).toBe('confirmed');
  });

  it('logs counts only: never a relay URL or the wrap id', async () => {
    const { net, rows, worker, lines } = setup();
    const relays = relayUrls('quietlog', 2);
    for (const url of relays) net.configure(url, { neverServes: true });
    const row = makeRow(relays);
    rows.add(row);
    await pass(worker);
    for (const line of lines) {
      expect(line).not.toContain(row.wrapId);
      for (const relay of relays) expect(line).not.toContain(relay);
    }
  });
});
