// M1-5b acceptance: the outbox (07 §3.2, §4.2). The stored gift wrap is republished, never re-wrapped,
// to exactly the relays of its row; a row is `sent` at 2 OKs and `not_delivered` after 24 h; it
// survives a restart (persistence fake); and no content reaches the logs. Mock relays, a fake clock.
import { createLogger, type Level } from '@agentlink/log';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OUTBOX_GIVE_UP_SECONDS,
  OutboxWorker,
  type OutboxAttempt,
  type OutboxGiveUpReason,
  type OutboxPersistence,
  type OutboxRow,
} from './outbox.js';
import { CONNECT_TIMEOUT_MS, RelayPool } from './relay-pool.js';
import { MockNetwork, makeWrapEvent, relayUrls } from './testing/mock-network.js';

const START = Date.UTC(2026, 9, 14, 12, 0, 0);
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

type Stored = OutboxRow & {
  state: 'pending' | 'sent' | 'not_delivered';
  reason?: OutboxGiveUpReason;
};

/** The `outbox` table as the core would implement it: rows survive a new worker and pool. */
class MemoryOutbox implements OutboxPersistence {
  readonly rows = new Map<string, Stored>();
  failWrites = false;

  add(row: OutboxRow): void {
    this.rows.set(row.wrapId, { ...row, state: 'pending' });
  }
  get(wrapId: string): Stored {
    const row = this.rows.get(wrapId);
    if (row === undefined) throw new Error('no such row');
    return row;
  }
  listDue(now: number): Promise<readonly OutboxRow[]> {
    return Promise.resolve(
      [...this.rows.values()].filter((r) => r.state === 'pending' && r.nextAttemptAt <= now),
    );
  }
  isPending(wrapId: string): Promise<boolean> {
    return Promise.resolve(this.rows.get(wrapId)?.state === 'pending');
  }
  recordAttempt(wrapId: string, attempt: OutboxAttempt): Promise<void> {
    if (this.failWrites) return Promise.reject(new Error('disk full'));
    this.rows.set(wrapId, { ...this.get(wrapId), ...attempt });
    return Promise.resolve();
  }
  markSent(wrapId: string, acks: Readonly<Record<string, number>>): Promise<void> {
    if (this.failWrites) return Promise.reject(new Error('disk full'));
    this.rows.set(wrapId, { ...this.get(wrapId), acks, state: 'sent' });
    return Promise.resolve();
  }
  markNotDelivered(wrapId: string, reason: OutboxGiveUpReason): Promise<void> {
    this.rows.set(wrapId, { ...this.get(wrapId), state: 'not_delivered', reason });
    return Promise.resolve();
  }
}

function makeRow(
  relays: readonly string[],
  overrides: Partial<OutboxRow> = {},
  content = 'AAAA',
): OutboxRow {
  const recipientKey = getPublicKey(generateSecretKey());
  const event = makeWrapEvent({ recipient: recipientKey, content });
  const createdAt = nowSeconds();
  return {
    wrapId: event.id,
    envelopeId: 'e'.repeat(64),
    recipientKey,
    wrapJson: JSON.stringify(event),
    relays,
    acks: {},
    attempts: 0,
    nextAttemptAt: createdAt,
    createdAt,
    giveUpAt: createdAt + OUTBOX_GIVE_UP_SECONDS,
    role: 'contact',
    ...overrides,
  };
}

function setup(net = new MockNetwork()) {
  const outbox = new MemoryOutbox();
  const lines: string[] = [];
  const logger = createLogger({
    level: 'debug',
    sink: (_l: Level, line: string) => lines.push(line),
  });
  const worker = (): OutboxWorker =>
    new OutboxWorker({
      persistence: outbox,
      pool: new RelayPool({ connector: net, addressCheck: { resolver: net }, nip11: net, logger }),
      logger,
    });
  return { net, outbox, lines, worker };
}

describe('delivery', () => {
  it('marks a row sent once 2 relays of its list return OK, republishing the stored event', async () => {
    const { net, outbox, worker } = setup();
    const relays = relayUrls('send', 3);
    for (const url of relays) net.configure(url);
    const row = makeRow(relays);
    outbox.add(row);
    const summary = await worker().processDue();
    expect(summary).toMatchObject({ sent: 1, retrying: 0, notDelivered: 0, failed: 0 });
    expect(outbox.get(row.wrapId).state).toBe('sent');
    // Never re-wrapped: the relays hold exactly the stored event, byte for byte.
    const published = net.stored.map((s) => JSON.stringify(s.event));
    expect(published).toHaveLength(3);
    expect(new Set(published)).toEqual(new Set([row.wrapJson]));
    expect(Object.keys(outbox.get(row.wrapId).acks).sort()).toEqual([...relays].sort());
  });

  it('is not sent with 1 OK: it keeps the ack, backs off, and then publishes only to the others', async () => {
    const { net, outbox, worker } = setup();
    const [good, down, late] = relayUrls('part', 3) as [string, string, string];
    net.configure(good);
    net.configure(down, { reject: true });
    net.configure(late, { reject: true });
    const row = makeRow([good, down, late]);
    outbox.add(row);
    const w = worker();

    const first = await w.processDue();
    expect(first).toMatchObject({ sent: 0, retrying: 1 });
    expect(first.nextAttemptAt).toBe(nowSeconds() + 30);
    const after = outbox.get(row.wrapId);
    expect(after).toMatchObject({ state: 'pending', attempts: 1 });
    expect(Object.keys(after.acks)).toEqual([good]);

    // Not due yet: nothing happens.
    const opensBefore = net.opens.length;
    expect(await w.processDue()).toMatchObject({ sent: 0, retrying: 0 });
    expect(net.opens.length).toBe(opensBefore);

    // Due again; the relay that was down now accepts. The acknowledged relay is not asked again.
    net.configure(down);
    vi.setSystemTime(Date.now() + 30_000);
    const storedBefore = net.stored.length;
    const second = await w.processDue();
    expect(second.sent).toBe(1);
    expect(outbox.get(row.wrapId).state).toBe('sent');
    expect(net.stored.slice(storedBefore).map((s) => s.relay)).toEqual([down]);
    expect(
      net.received.filter((f) => f.relay === good && f.frame.startsWith('["EVENT"')),
    ).toHaveLength(1);
  });

  it('backs off 30 s, 60 s, 120 s and so on, at most 1 h, never past give-up', async () => {
    const { net, outbox, worker } = setup();
    const [a, b] = relayUrls('back', 2) as [string, string];
    net.configure(a, { reject: true });
    net.configure(b, { reject: true });
    const row = makeRow([a, b]);
    outbox.add(row);
    const w = worker();
    const delays: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      const before = nowSeconds();
      const summary = await w.processDue();
      delays.push((summary.nextAttemptAt as number) - before);
      vi.setSystemTime((summary.nextAttemptAt as number) * 1000);
    }
    expect(delays).toEqual([30, 60, 120, 240, 480, 960, 1920, 3600, 3600]);

    // Close to give-up the next attempt is the give-up time itself.
    const late = makeRow([a, b], {
      attempts: 20,
      createdAt: nowSeconds() - 86_300,
      giveUpAt: nowSeconds() + 100,
    });
    outbox.add(late);
    const summary = await w.processDue();
    expect(summary.nextAttemptAt).toBe(late.giveUpAt);
  });

  it('survives a restart: a new worker and pool continue from the persisted row', async () => {
    const { net, outbox, worker } = setup();
    const [a, b] = relayUrls('boot', 2) as [string, string];
    net.configure(a);
    net.configure(b, { reject: true });
    const row = makeRow([a, b]);
    outbox.add(row);
    await worker().processDue();
    expect(outbox.get(row.wrapId).state).toBe('pending');

    // "Restart": everything in memory is gone except the table.
    net.configure(b);
    vi.setSystemTime(Date.now() + 30_000);
    const restarted = setup(net);
    for (const stored of outbox.rows.values()) restarted.outbox.add(stored);
    expect((await restarted.worker().processDue()).sent).toBe(1);
    expect(restarted.outbox.get(row.wrapId).state).toBe('sent');
  });

  it('recovers a row that already holds 2 acks (a crash after publishing) without publishing', async () => {
    const { net, outbox, worker } = setup();
    const [a, b] = relayUrls('crash', 2) as [string, string];
    const row = makeRow([a, b], { acks: { [a]: nowSeconds(), [b]: nowSeconds() } });
    outbox.add(row);
    expect((await worker().processDue()).sent).toBe(1);
    expect(net.opens).toHaveLength(0);
  });

  it('gives up after 24 h: not_delivered (timeout), and nothing is published after that', async () => {
    const { net, outbox, worker } = setup();
    const relays = relayUrls('dead', 3);
    for (const url of relays) net.configure(url, { blackHole: true });
    const row = makeRow(relays);
    outbox.add(row);
    const w = worker();
    const first = w.processDue();
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    expect(await first).toMatchObject({ retrying: 1 });

    // Keep retrying through the day.
    let guard = 0;
    while (nowSeconds() < row.giveUpAt - 1 && guard < 100) {
      guard += 1;
      const stored = outbox.get(row.wrapId);
      vi.setSystemTime(Math.min(stored.nextAttemptAt, row.giveUpAt - 1) * 1000);
      const pass = w.processDue();
      await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
      await pass;
      if (nowSeconds() >= row.giveUpAt - 1) break;
    }
    expect(outbox.get(row.wrapId).state).toBe('pending');
    expect(outbox.get(row.wrapId).attempts).toBeGreaterThan(5);

    vi.setSystemTime(row.giveUpAt * 1000);
    const opens = net.opens.length;
    expect(await w.processDue()).toMatchObject({ notDelivered: 1, sent: 0 });
    expect(outbox.get(row.wrapId)).toMatchObject({ state: 'not_delivered', reason: 'timeout' });
    expect(net.opens.length).toBe(opens);
    expect(await w.processDue()).toMatchObject({ sent: 0, retrying: 0, notDelivered: 0 });
  });

  it('does not give up a row that reached 2 acks just before the deadline', async () => {
    const { net, outbox, worker } = setup();
    const [a, b] = relayUrls('edge', 2) as [string, string];
    net.configure(a);
    net.configure(b);
    const row = makeRow([a, b], { acks: { [a]: 1, [b]: 1 }, giveUpAt: nowSeconds() - 1 });
    outbox.add(row);
    expect((await worker().processDue()).sent).toBe(1);
  });

  it('counts owner rows like contact rows', async () => {
    const { net, outbox, worker } = setup();
    const [a, b] = relayUrls('owner', 2) as [string, string];
    net.configure(a);
    net.configure(b);
    const row = makeRow([a, b], { role: 'owner' });
    outbox.add(row);
    expect((await worker().processDue()).sent).toBe(1);
  });
});

describe('routing (07 §4.3)', () => {
  it('publishes each row only to its own relays, with disjoint sender and recipient lists', async () => {
    const { net, outbox, worker } = setup();
    const recipientList = relayUrls('rcpt', 3);
    const senderList = relayUrls('self', 3);
    for (const url of [...recipientList, ...senderList]) net.configure(url);
    const forRecipient = makeRow(recipientList);
    const forSender = makeRow(senderList, { role: 'owner' });
    outbox.add(forRecipient);
    outbox.add(forSender);
    await worker().processDue();
    expect(net.storedOn(forRecipient.wrapId).sort()).toEqual([...recipientList].sort());
    expect(net.storedOn(forSender.wrapId).sort()).toEqual([...senderList].sort());
  });

  it('does not touch a relay outside the row list even when another row uses it', async () => {
    const { net, outbox, worker } = setup();
    const [shared, onlyA, onlyB] = relayUrls('shr', 3) as [string, string, string];
    for (const url of [shared, onlyA, onlyB]) net.configure(url);
    const a = makeRow([shared, onlyA]);
    const b = makeRow([shared, onlyB]);
    outbox.add(a);
    outbox.add(b);
    await worker().processDue();
    expect(net.storedOn(a.wrapId)).not.toContain(onlyB);
    expect(net.storedOn(b.wrapId)).not.toContain(onlyA);
  });
});

describe('unreadable and ended rows', () => {
  const corrupt: [string, (row: OutboxRow) => OutboxRow][] = [
    ['not JSON', (r) => ({ ...r, wrapJson: '{nope' })],
    ['a different id', (r) => ({ ...r, wrapId: 'f'.repeat(64) })],
    [
      'a tampered content',
      (r) => ({ ...r, wrapJson: JSON.stringify({ ...JSON.parse(r.wrapJson), content: 'BBBB' }) }),
    ],
    [
      'a wrong kind',
      (r) => ({ ...r, wrapJson: JSON.stringify({ ...JSON.parse(r.wrapJson), kind: 1 }) }),
    ],
    [
      'a different recipient key',
      (r) => ({ ...r, recipientKey: getPublicKey(generateSecretKey()) }),
    ],
    ['an empty relay list', (r) => ({ ...r, relays: [] })],
    ['an invalid relay URL', (r) => ({ ...r, relays: [...r.relays, 'ws://127.0.0.1'] })],
    ['a relay list over 32', (r) => ({ ...r, relays: relayUrls('big', 33) })],
    [
      'a relay list that is not an array',
      (r) => ({ ...r, relays: 'wss://a.nostr-test.dev' as never }),
    ],
  ];

  it.each(corrupt)(
    'marks a row with %s not_delivered (unreadable) and publishes nothing',
    async (_name, corruptRow) => {
      const { net, outbox, worker } = setup();
      const relays = relayUrls('bad', 2);
      for (const url of relays) net.configure(url);
      const row = corruptRow(makeRow(relays));
      outbox.add(row);
      expect(await worker().processDue()).toMatchObject({ notDelivered: 1, sent: 0 });
      expect(outbox.get(row.wrapId)).toMatchObject({
        state: 'not_delivered',
        reason: 'unreadable',
      });
      expect(net.opens).toHaveLength(0);
    },
  );

  it('skips a row that a revoke ended after it was listed', async () => {
    const { net, outbox, worker } = setup();
    const relays = relayUrls('rev', 2);
    for (const url of relays) net.configure(url);
    const row = makeRow(relays);
    outbox.add(row);
    const listDue = outbox.listDue.bind(outbox);
    outbox.listDue = async (now) => {
      const rows = await listDue(now);
      outbox.rows.set(row.wrapId, { ...outbox.get(row.wrapId), state: 'not_delivered' });
      return rows;
    };
    expect(await worker().processDue()).toMatchObject({ sent: 0, retrying: 0, notDelivered: 0 });
    expect(net.opens).toHaveLength(0);
  });

  it('leaves a row pending, and goes on with the others, when persistence fails', async () => {
    const { net, outbox, worker } = setup();
    const relays = relayUrls('pf', 2);
    for (const url of relays) net.configure(url);
    const bad = makeRow(relays);
    outbox.add(bad);
    const original = outbox.markSent.bind(outbox);
    outbox.markSent = (wrapId, acks) =>
      wrapId === bad.wrapId ? Promise.reject(new Error('disk full')) : original(wrapId, acks);
    const good = makeRow(relays);
    outbox.add(good);
    const summary = await worker().processDue();
    expect(summary).toMatchObject({ sent: 1, failed: 1 });
    expect(outbox.get(bad.wrapId).state).toBe('pending');
    expect(outbox.get(good.wrapId).state).toBe('sent');
  });
});

describe('logging (I-7)', () => {
  it('writes no wrap content, relay URL path or key to the logs', async () => {
    const { net, outbox, lines, worker } = setup();
    const canary = `CANARY-${Math.random().toString(36).slice(2)}`;
    const urls = ['wss://log-0.nostr-test.dev/path-secret', 'wss://log-1.nostr-test.dev'];
    for (const url of urls) net.configure(url, { okMessage: canary });
    const row = makeRow(urls, {}, canary);
    outbox.add(row);
    const broken = makeRow(urls, { wrapJson: `${canary} {` });
    outbox.add(broken);
    await worker().processDue();
    const text = lines.join('\n');
    expect(text).not.toContain(canary);
    expect(text).not.toContain('path-secret');
    expect(text).not.toContain(row.recipientKey);
    expect(text).not.toContain(row.wrapId);
    expect(text).not.toContain(row.wrapJson.slice(0, 40));
  });
});
