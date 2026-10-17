// M1-7i: the budget check and the reservation of the Record's `maxFee` in one store transaction
// (06 §3 "Daily budget window", G-7; 07 §3.5). Settle on confirmation, release only after the
// deadline with no record, and fail closed on a missing, corrupted or clock-skewed ledger.
import { POLICY_DEFAULTS } from '@agentlink/types';
import { describe, expect, it } from 'vitest';
import {
  checkAndReserveProof,
  readBudgetLedger,
  releaseProofReservation,
  settleProofCharged,
  type ProofReservation,
} from './budget.js';
import type { EffectivePolicy, PolicyAction } from './policy-engine.js';
import { MemoryStore } from './store/memory-store.js';
import { SINGLETON_SLOT } from './store/schema.js';
import type { Store, StoreTx } from './store/store.js';

const NOW = 1_800_000_000;
const defaults: EffectivePolicy = { mode: 'defaults', policy: POLICY_DEFAULTS };
const failClosed: EffectivePolicy = { mode: 'fail_closed', problem: 'missing' };

const proof = (feeUsd: string, maxFeeUsd = feeUsd): PolicyAction & { kind: 'proof' } => ({
  kind: 'proof',
  feeUsd,
  maxFeeUsd,
  counterparty: null,
});
let seq = 0;
const reservation = (over: Partial<ProofReservation> = {}): ProofReservation => {
  seq += 1;
  const id = seq.toString(16).padStart(4, '0');
  return {
    entryId: `e${id}`,
    recordId: `0x${id.padStart(64, '0')}`,
    chainId: 8453,
    approvalId: null,
    deadline: NOW + 3600,
    ...over,
  };
};

async function freshStore(over: { epoch?: number; newestT?: number } = {}): Promise<Store> {
  const store = new MemoryStore();
  await store.transaction((tx) =>
    tx.insert('budget_state', {
      slot: SINGLETON_SLOT,
      ledger_epoch: over.epoch ?? 1,
      status: 'ok',
      newest_t: over.newestT ?? NOW - 1000,
      since: NOW - 1000,
      broken_at: null,
    }),
  );
  return store;
}

const reserve = (
  store: Store,
  action: PolicyAction & { kind: 'proof' },
  opts: {
    now?: number;
    ownerApproved?: boolean;
    effective?: EffectivePolicy;
    res?: ProofReservation;
  } = {},
) =>
  store.transaction((tx) =>
    checkAndReserveProof(tx, {
      effective: opts.effective ?? defaults,
      action,
      now: opts.now ?? NOW,
      reservation: opts.res ?? reservation(),
      ownerApproved: opts.ownerApproved ?? false,
    }),
  );
const rows = (store: Store) => store.transaction((tx) => tx.select('budget_ledger'));
const state = (store: Store) => store.transaction((tx) => tx.select('budget_state')[0]);

describe('check and reserve (06 §3, 07 §3.5)', () => {
  it('reserves the maximum fee and raises newest_t in the same transaction', async () => {
    const store = await freshStore();
    const res = reservation({ approvalId: null });
    const out = await reserve(store, proof('0.4', '0.9'), { res });
    expect(out).toEqual({ decision: 'allow', triggers: [], reserved: true });
    expect(await rows(store)).toEqual([
      {
        entry_id: res.entryId,
        ledger_epoch: 1,
        t: NOW,
        record_id: res.recordId,
        chain_id: 8453,
        approval_id: null,
        reserved_usd: '0.9',
        charged_usd: null,
        state: 'reserved',
        deadline: res.deadline,
        replaces: null,
        settled_at: null,
      },
    ]);
    expect((await state(store))?.newest_t).toBe(NOW);
  });

  it('N concurrent paid proofs over the remaining budget never all pass', async () => {
    const store = await freshStore();
    // Budget $5, $1 max each: 8 concurrent calls; exactly 5 pass and reserve.
    const results = await Promise.all(Array.from({ length: 8 }, () => reserve(store, proof('1'))));
    expect(results.filter((r) => r.decision === 'allow' && r.reserved)).toHaveLength(5);
    expect(results.filter((r) => r.decision === 'approval' && !r.reserved)).toHaveLength(3);
    expect(await rows(store)).toHaveLength(5);
  });

  it('spent + max fee equal to the budget is allowed; one cent more is not', async () => {
    const store = await freshStore();
    expect((await reserve(store, proof('1'))).decision).toBe('allow');
    expect((await reserve(store, proof('1'))).decision).toBe('allow');
    expect((await reserve(store, proof('1'))).decision).toBe('allow');
    expect((await reserve(store, proof('1'))).decision).toBe('allow');
    expect((await reserve(store, proof('0.99'))).decision).toBe('allow');
    expect((await reserve(store, proof('0.02'))).decision).toBe('approval');
    expect((await reserve(store, proof('0.01'))).decision).toBe('allow');
  });

  it('an action the owner approved over the limit is reserved too', async () => {
    const store = await freshStore();
    const out = await reserve(store, proof('3'), { ownerApproved: true });
    expect(out).toEqual({ decision: 'approval', triggers: ['per_action'], reserved: true });
    expect((await rows(store))[0]?.reserved_usd).toBe('3');
  });

  it('a deny is never reserved, even with an owner approval', async () => {
    const store = await freshStore();
    const p = {
      mode: 'signed',
      version: 2,
      policy: { ...POLICY_DEFAULTS, proofs: { ...POLICY_DEFAULTS.proofs, notarize: 'deny' } },
    } as EffectivePolicy;
    const out = await reserve(store, proof('0.1'), { ownerApproved: true, effective: p });
    expect(out).toEqual({ decision: 'deny', triggers: ['notarize'], reserved: false });
    expect(await rows(store)).toEqual([]);
  });

  it('under fail closed nothing is reserved without an owner approval', async () => {
    const store = await freshStore();
    const out = await reserve(store, proof('0.1'), { effective: failClosed });
    expect(out).toEqual({ decision: 'approval', triggers: ['policy_invalid'], reserved: false });
    expect(await rows(store)).toEqual([]);
  });

  it('an entry leaves the window at now − 86 400', async () => {
    const store = await freshStore({ newestT: NOW - 86_400 });
    await reserve(store, proof('1'), { now: NOW - 86_400 });
    await reserve(store, proof('1'), { now: NOW - 86_400 });
    await reserve(store, proof('1'), { now: NOW - 86_400 });
    await reserve(store, proof('1'), { now: NOW - 86_400 });
    await reserve(store, proof('1'), { now: NOW - 86_399 });
    expect((await reserve(store, proof('0.01'), { now: NOW - 1 })).decision).toBe('approval');
    expect((await reserve(store, proof('1'), { now: NOW })).decision).toBe('allow');
  });
});

describe('settle and release (06 §3, 04 §5)', () => {
  it('a confirmed record settles to the charged fee', async () => {
    const store = await freshStore();
    const res = reservation();
    await reserve(store, proof('1'), { res });
    for (let i = 0; i < 4; i += 1) await reserve(store, proof('1'));
    expect((await reserve(store, proof('0.5'))).decision).toBe('approval');
    const settled = await store.transaction((tx) =>
      settleProofCharged(tx, { recordId: res.recordId, chargedUsd: '0.3', now: NOW + 10 }),
    );
    expect(settled).toBe(true);
    const row = (await rows(store)).find((r) => r.record_id === res.recordId);
    expect(row).toMatchObject({ state: 'charged', charged_usd: '0.3', settled_at: NOW + 10 });
    expect((await reserve(store, proof('0.7'), { now: NOW + 20 })).decision).toBe('allow');
  });

  it('settles only a reserved entry, once', async () => {
    const store = await freshStore();
    const res = reservation();
    await reserve(store, proof('1'), { res });
    const settle = () =>
      store.transaction((tx) =>
        settleProofCharged(tx, { recordId: res.recordId, chargedUsd: '1', now: NOW + 1 }),
      );
    expect(await settle()).toBe(true);
    expect(await settle()).toBe(false);
  });

  it('a failed submission keeps its reservation until the deadline passes with no record', async () => {
    const store = await freshStore();
    const res = reservation({ deadline: NOW + 600 });
    await reserve(store, proof('5'), { res, ownerApproved: true });
    const release = (now: number, chainHasRecord: boolean) =>
      store.transaction((tx) =>
        releaseProofReservation(tx, { recordId: res.recordId, now, chainHasRecord }),
      );
    expect(await release(NOW + 1, false)).toBe('too_early');
    expect(await release(NOW + 600, false)).toBe('too_early');
    expect((await reserve(store, proof('0.01'), { now: NOW + 600 })).decision).toBe('approval');
    expect(await release(NOW + 601, true)).toBe('has_record');
    expect((await rows(store)).find((r) => r.record_id === res.recordId)?.state).toBe('reserved');
    expect(await release(NOW + 601, false)).toBe('released');
    expect((await rows(store)).find((r) => r.record_id === res.recordId)).toMatchObject({
      state: 'released',
      settled_at: NOW + 601,
    });
    expect((await reserve(store, proof('1'), { now: NOW + 602 })).decision).toBe('allow');
    expect(await release(NOW + 700, false)).toBe('not_reserved');
  });
});

describe('fail closed on the ledger (06 §3, 07 §3.5)', () => {
  it('a missing budget_state gives approval and reserves nothing', async () => {
    const store = new MemoryStore();
    const out = await reserve(store, proof('0.01'));
    expect(out).toEqual({ decision: 'approval', triggers: ['ledger_broken'], reserved: false });
    expect(await rows(store)).toEqual([]);
  });

  it('a clock earlier than newest_t gives approval and marks the ledger broken until a fresh epoch', async () => {
    const store = await freshStore({ newestT: NOW + 50 });
    expect((await reserve(store, proof('0.01'))).decision).toBe('approval');
    expect(await state(store)).toMatchObject({ status: 'broken', broken_at: NOW });
    // Once broken it stays broken, even with a good clock, until a policy.set starts a fresh epoch.
    expect((await reserve(store, proof('0.01'), { now: NOW + 100 })).decision).toBe('approval');
    await store.transaction((tx) =>
      tx.update(
        'budget_state',
        { slot: SINGLETON_SLOT },
        { ledger_epoch: 2, status: 'ok', newest_t: NOW + 200, since: NOW + 200, broken_at: null },
      ),
    );
    expect((await reserve(store, proof('0.01'), { now: NOW + 200 })).decision).toBe('allow');
  });

  it('a row from a later epoch than the state breaks the ledger', async () => {
    const store = await freshStore({ epoch: 1 });
    await store.transaction((tx) =>
      tx.insert('budget_ledger', {
        entry_id: 'x1',
        ledger_epoch: 2,
        t: NOW - 5,
        record_id: `0x${'f'.repeat(64)}`,
        chain_id: 8453,
        approval_id: null,
        reserved_usd: '0.01',
        charged_usd: null,
        state: 'reserved',
        deadline: NOW + 100,
        replaces: null,
        settled_at: null,
      }),
    );
    const out = await reserve(store, proof('0.01'));
    expect(out.decision).toBe('approval');
    expect(out.triggers).toContain('ledger_broken');
    expect((await state(store))?.status).toBe('broken');
  });

  it('a read error counts as a broken ledger, never as an empty sum', async () => {
    const store = await freshStore();
    const out = await store.transaction((tx) => {
      const failing: StoreTx = {
        ...tx,
        get: tx.get.bind(tx),
        count: tx.count.bind(tx),
        insert: tx.insert.bind(tx),
        update: tx.update.bind(tx),
        delete: tx.delete.bind(tx),
        select: ((table: string, ...rest: unknown[]) => {
          if (table === 'budget_ledger') throw new Error('disk I/O error');
          return (tx.select as (...a: unknown[]) => unknown)(table, ...rest);
        }) as StoreTx['select'],
      };
      return checkAndReserveProof(failing, {
        effective: defaults,
        action: proof('0.01'),
        now: NOW,
        reservation: reservation(),
        ownerApproved: false,
      });
    });
    expect(out).toEqual({ decision: 'approval', triggers: ['ledger_broken'], reserved: false });
  });

  it('readBudgetLedger returns the current epoch view', async () => {
    const store = await freshStore({ epoch: 3, newestT: NOW - 7 });
    expect(await store.transaction((tx) => readBudgetLedger(tx))).toEqual({
      status: 'ok',
      epoch: 3,
      newestT: NOW - 7,
      entries: [],
    });
  });
});
