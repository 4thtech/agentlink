// DELIVERY-COUNTS-TEST (07 §3.2): `updateRelayCounts` raises the stored "available" count on a row
// that is already `sent` (and its envelope), only upwards, never above accepted, counts only.
import { MemoryKeyStore } from '@4thtech-io/crypto/testing';
import { createLogger } from '@4thtech-io/log';
import { describe, expect, it } from 'vitest';
import type { CoreContext } from './context.js';
import { StoreOutboxPersistence } from './outbox.js';
import { MemoryStore } from './store/memory-store.js';
import type { Row } from './store/schema.js';
import { TestStoreCipher, seed } from './testing/fixtures.js';

const NOW = 1_800_000_000;
const WRAP = 'w'.repeat(21) + 'A';
const ENV = 'e'.repeat(21) + 'A';

function envelope(): Row<'envelopes'> {
  return {
    envelope_id: ENV,
    envelope_hash: 'h',
    thread_id: 't'.repeat(21) + 'A',
    direction: 'out',
    contact_id: '0x' + '3d'.repeat(20),
    from_key: 'self',
    type: 'message',
    state: 'ok',
    refused_reason: null,
    created_at: NOW,
    envelope_json: null,
    payload_json: null,
    read_at: null,
    delivery: 'sent',
    refused_at: null,
    request_accepted_at: null,
    deleted_at: null,
    availability: 'confirmed',
    relays_accepted: null,
    relays_available: null,
  };
}

function outbox(
  state: Row<'outbox'>['state'],
  accepted: number | null,
  available: number | null,
): Row<'outbox'> {
  return {
    wrap_id: WRAP,
    envelope_id: ENV,
    recipient_key: 'k'.repeat(64),
    wrap_json: null,
    relays: 'enc',
    acks: 'enc',
    attempt: 1,
    role: 'contact',
    attempts: 1,
    next_attempt_at: NOW,
    created_at: NOW,
    give_up_at: NOW + 3600,
    state,
    reason: null,
    availability: state === 'sent' ? 'confirmed' : null,
    relays_accepted: accepted,
    relays_available: available,
  } as unknown as Row<'outbox'>;
}

async function setup(row: Row<'outbox'>) {
  const store = new MemoryStore();
  await store.transaction((tx) => {
    tx.insert('envelopes', envelope());
    tx.insert('outbox', row);
  });
  const ctx: CoreContext = {
    keyStore: new MemoryKeyStore(seed(1)),
    store,
    cipher: new TestStoreCipher(),
    now: () => NOW,
    log: createLogger({ name: 'core', level: 'error', sink: () => undefined }),
  };
  const persistence = new StoreOutboxPersistence(ctx, ENV);
  const read = () =>
    store.transaction((tx) => ({
      row: tx.get('outbox', { wrap_id: WRAP }),
      env: tx.get('envelopes', { envelope_id: ENV }),
    }));
  return { persistence, read };
}

describe('updateRelayCounts (DELIVERY-COUNTS-TEST)', () => {
  it('raises available on a sent row and on its envelope', async () => {
    const { persistence, read } = await setup(outbox('sent', 3, 1));
    await persistence.updateRelayCounts(WRAP, { accepted: 3, available: 2 });
    const { row, env } = await read();
    expect(row).toMatchObject({ relays_accepted: 3, relays_available: 2 });
    expect(env).toMatchObject({ relays_accepted: 3, relays_available: 2 });
  });

  it('never lowers the count and never exceeds accepted', async () => {
    const { persistence, read } = await setup(outbox('sent', 3, 2));
    await persistence.updateRelayCounts(WRAP, { accepted: 3, available: 1 });
    expect((await read()).row?.relays_available).toBe(2);
    await persistence.updateRelayCounts(WRAP, { accepted: 3, available: 99 });
    expect((await read()).row?.relays_available).toBe(3);
  });

  it('ignores a row that is not sent, has no count, or does not exist', async () => {
    const pending = await setup(outbox('pending', null, null));
    await pending.persistence.updateRelayCounts(WRAP, { accepted: 3, available: 2 });
    expect((await pending.read()).row?.relays_available).toBeNull();
    const old = await setup(outbox('sent', null, null));
    await old.persistence.updateRelayCounts(WRAP, { accepted: 3, available: 2 });
    expect((await old.read()).row?.relays_available).toBeNull();
    await old.persistence.updateRelayCounts('x'.repeat(21) + 'A', { accepted: 1, available: 1 });
  });
});
