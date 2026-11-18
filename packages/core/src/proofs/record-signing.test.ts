// SEC-RECORD-ATOMIC: the Record signing gate. The signer is called only with a ticket issued by the
// reserving transaction, for that Record, once, while its reservation still holds.
import type { BuiltRecord } from '@4thtech-io/chain';
import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../store/memory-store.js';
import type { Sealed } from '../store/schema.js';
import type { Store } from '../store/store.js';
import {
  RECORD_SIGNING,
  issueRecordTicket,
  signUnderReservation,
  type RecordTicket,
} from './record-signing.js';

const NOW = 1_800_000_000;
const ID = `0x${'a'.repeat(64)}`;
const OTHER = `0x${'b'.repeat(64)}`;
const built = (recordId: string) => ({ recordId }) as unknown as BuiltRecord;

async function reserved(recordId = ID, state: 'reserved' | 'released' = 'reserved') {
  const store = new MemoryStore();
  await store.transaction((tx) => {
    tx.insert('budget_ledger', {
      entry_id: `led_${recordId.slice(2, 34)}`,
      ledger_epoch: 1,
      t: NOW,
      record_id: recordId,
      chain_id: 84532,
      approval_id: null,
      reserved_usd: '0.1',
      charged_usd: null,
      state,
      deadline: NOW + 3600,
      replaces: null,
      settled_at: null,
    });
    tx.insert('proofs', {
      record_id: recordId,
      envelope_id: 'env_1',
      chain_id: 84532,
      record_json: '{}',
      tx_hash: null,
      status: RECORD_SIGNING,
      fee_token: null,
      fee_amount: null,
      salt: 'sealed' as Sealed,
      created_at: NOW,
    });
  });
  return store;
}

const ticketFor = (store: Store, recordId = ID) =>
  store.transaction((tx) => issueRecordTicket(tx, recordId));

const run = (store: Store, ticket: RecordTicket, record = built(ID)) => {
  const sign = vi.fn(() => Promise.resolve('0xsig'));
  const out = signUnderReservation({
    store,
    ticket,
    built: record,
    sign,
    encode: (s) => JSON.stringify({ signature: s }),
  });
  return { sign, out };
};

describe('the Record signing gate (SEC-RECORD-ATOMIC)', () => {
  it('no ticket without a held reservation and a signing row', async () => {
    expect(await ticketFor(await reserved(ID, 'released'))).toBeUndefined();
    expect(await ticketFor(await reserved(), OTHER)).toBeUndefined();
  });

  it('a held reservation: signs once and stores the signed item', async () => {
    const store = await reserved();
    const ticket = (await ticketFor(store))!;
    const { sign, out } = run(store, ticket);
    expect(await out).toBe('{"signature":"0xsig"}');
    expect(sign).toHaveBeenCalledTimes(1);
    const row = await store.transaction((tx) => tx.get('proofs', { record_id: ID }));
    expect(row?.status).toBe('signed');
  });

  it('a forged ticket, a reused ticket, or one for another Record is refused before signing', async () => {
    const store = await reserved();
    const forged = run(store, Object.freeze({ recordId: ID }));
    await expect(forged.out).rejects.toThrow();
    expect(forged.sign).not.toHaveBeenCalled();

    const ticket = (await ticketFor(store))!;
    const other = run(store, ticket, built(OTHER));
    await expect(other.out).rejects.toThrow();
    expect(other.sign).not.toHaveBeenCalled();

    const fresh = (await ticketFor(store))!;
    await run(store, fresh).out;
    const again = run(store, fresh);
    await expect(again.out).rejects.toThrow();
    expect(again.sign).not.toHaveBeenCalled();
  });

  it('a reservation released before signing: nothing is signed', async () => {
    const store = await reserved();
    const ticket = (await ticketFor(store))!;
    await store.transaction((tx) =>
      tx.update('budget_ledger', { record_id: ID }, { state: 'released', settled_at: NOW }),
    );
    const { sign, out } = run(store, ticket);
    expect(await out).toBeUndefined();
    expect(sign).not.toHaveBeenCalled();
  });

  it('a signer failure leaves the fee reserved and the row unsigned', async () => {
    const store = await reserved();
    const ticket = (await ticketFor(store))!;
    await expect(
      signUnderReservation({
        store,
        ticket,
        built: built(ID),
        sign: () => Promise.reject(new Error('test: signer down')),
        encode: (s) => s,
      }),
    ).rejects.toThrow();
    const [entry, row] = await store.transaction((tx) => [
      tx.select('budget_ledger', { record_id: ID })[0],
      tx.get('proofs', { record_id: ID }),
    ]);
    expect(entry?.state).toBe('reserved');
    expect(row?.status).toBe(RECORD_SIGNING);
  });
});
