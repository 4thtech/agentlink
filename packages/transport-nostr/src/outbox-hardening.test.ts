// M1-5b-c: outbox reasons for rows with fewer than 2 usable relays, and backoff jitter.
import { createLogger, type Level } from '@4thtech-io/log';
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
import { RelayPool } from './relay-pool.js';
import { MockNetwork, makeWrapEvent, relayUrls } from './testing/mock-network.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-22T10:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

type StoredRow = OutboxRow & { state: string };

class Rows implements OutboxPersistence {
  readonly rows = new Map<string, StoredRow>();
  add(row: OutboxRow): void {
    this.rows.set(row.wrapId, { ...row, state: 'pending' });
  }
  private get(id: string): StoredRow {
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
  markSent(id: string, acks: Readonly<Record<string, number>>): Promise<boolean> {
    this.rows.set(id, { ...this.get(id), acks, state: 'sent' });
    return Promise.resolve(true);
  }
  markNotDelivered(id: string, _reason: OutboxGiveUpReason): Promise<boolean> {
    this.rows.set(id, { ...this.get(id), state: 'not_delivered' });
    return Promise.resolve(true);
  }
}

function makeRow(relays: readonly string[], giveUpIn = OUTBOX_GIVE_UP_SECONDS): OutboxRow {
  const recipientKey = getPublicKey(generateSecretKey());
  const event = makeWrapEvent({ recipient: recipientKey, content: 'AAAA', createdAt: nowSeconds() });
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
    giveUpAt: createdAt + giveUpIn,
    role: 'contact',
  };
}

function setup(random?: () => number) {
  const net = new MockNetwork();
  const rows = new Rows();
  const logger = createLogger({ level: 'debug', sink: (_l: Level, _line: string) => undefined });
  const worker = new OutboxWorker({
    persistence: rows,
    pool: new RelayPool({ connector: net, addressCheck: { resolver: net }, nip11: net, logger }),
    logger,
    ...(random === undefined ? {} : { random }),
  });
  return { net, rows, worker };
}

describe('reasons for a row with fewer than 2 usable relays', () => {
  it('names the message limit when one relay is large enough and the other is not', async () => {
    const { net, rows, worker } = setup();
    const [big, small] = relayUrls('lim', 2) as [string, string];
    net.configure(big);
    net.configure(small, { maxMessageLength: 100 });
    const row = makeRow([big, small]);
    rows.add(row);
    const summary = await worker.processDue();
    expect(summary).toMatchObject({ sent: 0, retrying: 1 });
    expect(rows.rows.get(row.wrapId)?.state).toBe('pending');
    expect(summary.notices).toEqual([{ wrapId: row.wrapId, reason: 'no_relay_large_enough' }]);
  });

  it('names too few usable relays when a relay is blocked', async () => {
    const { net, rows, worker } = setup();
    const [a, b] = relayUrls('blk', 2) as [string, string];
    net.configure(a);
    net.configure(b);
    net.dns.set('blk-1.nostr-test.dev', ['10.0.0.5']);
    const row = makeRow([a, b]);
    rows.add(row);
    const summary = await worker.processDue();
    expect(summary.notices).toEqual([{ wrapId: row.wrapId, reason: 'too_few_usable_relays' }]);
  });

  it('gives no notice when 2 relays are usable, even if they fail this time', async () => {
    const { net, rows, worker } = setup();
    const [a, b] = relayUrls('use', 2) as [string, string];
    net.configure(a, { reject: true });
    net.configure(b, { reject: true });
    rows.add(makeRow([a, b]));
    expect((await worker.processDue()).notices).toEqual([]);
  });

  it('never puts a relay URL or address in a notice', async () => {
    const { net, rows, worker } = setup();
    const [a, b] = relayUrls('safe', 2) as [string, string];
    net.configure(a);
    net.configure(b, { maxMessageLength: 100 });
    rows.add(makeRow([a, b]));
    const text = JSON.stringify((await worker.processDue()).notices);
    expect(text).not.toContain('nostr-test.dev');
  });
});

describe('backoff jitter', () => {
  async function retryTime(random: () => number, giveUpIn = OUTBOX_GIVE_UP_SECONDS) {
    const { net, rows, worker } = setup(random);
    const [a, b] = relayUrls('jit', 2) as [string, string];
    net.configure(a, { reject: true });
    net.configure(b, { reject: true });
    rows.add(makeRow([a, b], giveUpIn));
    return (await worker.processDue()).nextAttemptAt as number;
  }

  it('spreads the retry times of rows with an injected random source', async () => {
    const early = await retryTime(() => 0);
    const late = await retryTime(() => 0.999);
    expect(late).toBeGreaterThan(early);
  });

  it('keeps every retry after now and within the 24 h bound', async () => {
    for (const r of [0, 0.5, 0.999]) {
      const at = await retryTime(() => r);
      expect(at).toBeGreaterThan(nowSeconds());
      expect(at).toBeLessThanOrEqual(nowSeconds() + OUTBOX_GIVE_UP_SECONDS);
    }
  });

  it('does not push a retry past give_up_at', async () => {
    const at = await retryTime(() => 0.999, 5);
    expect(at).toBeLessThanOrEqual(nowSeconds() + 5);
  });
});
