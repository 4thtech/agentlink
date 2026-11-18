// SEC-RESTORE-GUARD (D-156): after an ID is restored from a backup, the spend state it holds is the
// backup's. For 24 h every paid action asks the owner, the outgoing caps are tighter, commitments
// are never allowed by policy alone, and inbound sent before the restore triggers nothing
// automatically. An unreadable restore mark counts as a restore in force (fail closed).
import { OUTGOING_DEFAULTS, POLICY_DEFAULTS } from '@4thtech-io/types';
import { describe, expect, it } from 'vitest';
import { checkAndReserveProof } from './budget.js';
import {
  evaluateOutgoing,
  evaluateProof,
  type EffectivePolicy,
  type ProofAction,
} from './policy-engine.js';
import { approvalProofTriggers } from './proofs/service.js';
import {
  RESTORE_CLOCK_SKEW_SECONDS,
  RESTORE_GUARD_SECONDS,
  guardCommitment,
  readRestoreState,
  requestedBeforeRestore,
  restoreWindowOpen,
  restoredReplay,
  type RestoreMark,
} from './restore-guard.js';
import { MemoryStore } from './store/memory-store.js';
import { SINGLETON_SLOT } from './store/schema.js';
import type { CoreContext } from './context.js';

const NOW = 1_800_000_000;
const defaults: EffectivePolicy = { mode: 'defaults', policy: POLICY_DEFAULTS };
const proof = (feeUsd: string): ProofAction => ({
  kind: 'proof',
  feeUsd,
  maxFeeUsd: feeUsd,
  counterparty: null,
});
const empty = { status: 'ok', epoch: 1, newestT: NOW - 10, entries: [] } as const;

const ctxWith = (restoreMark?: RestoreMark): CoreContext =>
  ({ ...(restoreMark === undefined ? {} : { restoreMark }) }) as unknown as CoreContext;
const mark = (value: unknown): RestoreMark => ({ read: () => Promise.resolve(value as number) });

describe('readRestoreState', () => {
  it('no mark (a runtime without one) and a zero mark are "never restored"', async () => {
    expect(await readRestoreState(ctxWith())).toEqual({ status: 'none' });
    expect(await readRestoreState(ctxWith(mark(0)))).toEqual({ status: 'none' });
  });

  it('a time is the restore time', async () => {
    expect(await readRestoreState(ctxWith(mark(NOW)))).toEqual({
      status: 'restored',
      restoredAt: NOW,
      reason: 'restore',
    });
  });

  it('the reason (restore or update) comes from the mark, for the card copy only', async () => {
    const updated: RestoreMark = {
      read: () => Promise.resolve(NOW),
      reason: () => Promise.resolve('update'),
    };
    expect(await readRestoreState(ctxWith(updated))).toEqual({
      status: 'restored',
      restoredAt: NOW,
      reason: 'update',
    });
    const unreadable: RestoreMark = {
      read: () => Promise.resolve(NOW),
      reason: () => Promise.reject(new Error('x')),
    };
    expect(await readRestoreState(ctxWith(unreadable))).toMatchObject({ reason: 'update' });
  });

  it('a mark that throws or holds anything but a time is unknown (fail closed)', async () => {
    const throwing: RestoreMark = { read: () => Promise.reject(new Error('keychain')) };
    expect(await readRestoreState(ctxWith(throwing))).toEqual({ status: 'unknown' });
    for (const bad of [-1, 1.5, '5', null, Number.NaN, 2 ** 60]) {
      expect(await readRestoreState(ctxWith(mark(bad)))).toEqual({ status: 'unknown' });
    }
  });
});

describe('restoreWindowOpen', () => {
  const restored = { status: 'restored', restoredAt: NOW, reason: 'restore' } as const;
  it('is open for 24 h after the restore, then closes', () => {
    expect(RESTORE_GUARD_SECONDS).toBe(86_400);
    expect(restoreWindowOpen(restored, NOW)).toBe(true);
    expect(restoreWindowOpen(restored, NOW + RESTORE_GUARD_SECONDS - 1)).toBe(true);
    expect(restoreWindowOpen(restored, NOW + RESTORE_GUARD_SECONDS)).toBe(false);
  });
  it('a clock earlier than the restore keeps it open', () => {
    expect(restoreWindowOpen(restored, NOW - 3_600)).toBe(true);
  });
  it('unknown is always open; never restored is never open', () => {
    expect(restoreWindowOpen({ status: 'unknown' }, NOW + 10 * RESTORE_GUARD_SECONDS)).toBe(true);
    expect(restoreWindowOpen({ status: 'none' }, NOW)).toBe(false);
  });
});

describe('requestedBeforeRestore: owner approvals asked for before the restore', () => {
  const restored = { status: 'restored', restoredAt: NOW, reason: 'restore' } as const;
  it('a request made before the restore (with the skew allowance) is void; a later one is not', () => {
    expect(requestedBeforeRestore(restored, NOW - 1)).toBe(true);
    expect(requestedBeforeRestore(restored, NOW + RESTORE_CLOCK_SKEW_SECONDS - 1)).toBe(true);
    expect(requestedBeforeRestore(restored, NOW + RESTORE_CLOCK_SKEW_SECONDS)).toBe(false);
    expect(requestedBeforeRestore(restored, NOW + 10 * RESTORE_GUARD_SECONDS)).toBe(false);
  });
  it('unknown voids every request; never restored none', () => {
    expect(requestedBeforeRestore({ status: 'unknown' }, NOW + 10 ** 6)).toBe(true);
    expect(requestedBeforeRestore({ status: 'none' }, 0)).toBe(false);
  });
});

describe('restoredReplay: inbound sent before the restore', () => {
  const restored = { status: 'restored', restoredAt: NOW, reason: 'restore' } as const;
  it('an envelope created before the restore (with the skew allowance) is a replay', () => {
    expect(restoredReplay(restored, NOW - 86_400)).toBe(true);
    expect(restoredReplay(restored, NOW + RESTORE_CLOCK_SKEW_SECONDS - 1)).toBe(true);
    expect(restoredReplay(restored, NOW + RESTORE_CLOCK_SKEW_SECONDS)).toBe(false);
  });
  it('unknown treats everything as a replay; never restored nothing', () => {
    expect(restoredReplay({ status: 'unknown' }, NOW + 10 ** 6)).toBe(true);
    expect(restoredReplay({ status: 'none' }, 0)).toBe(false);
  });
});

describe('paid actions in the restore window', () => {
  it('a proof that would pass asks the owner, with the restore trigger', () => {
    expect(evaluateProof(defaults, proof('0.01'), { now: NOW, ledger: empty }).decision).toBe(
      'allow',
    );
    const out = evaluateProof(defaults, proof('0.01'), {
      now: NOW,
      ledger: empty,
      restoreWindow: true,
    });
    expect(out.decision).toBe('approval');
    expect(out.triggers).toContain('restored');
  });

  it('after an update the trigger says so (copy only: the decision is the same)', () => {
    const out = evaluateProof(defaults, proof('0.01'), {
      now: NOW,
      ledger: empty,
      restoreWindow: true,
      restoreReason: 'update',
    });
    expect(out.decision).toBe('approval');
    expect(out.triggers).toContain('updated');
    expect(out.triggers).not.toContain('restored');
  });

  it('the card names the restore, never the daily budget, and offers no "remember"', () => {
    expect(approvalProofTriggers(['restored'])).toEqual(['proofs.restored']);
    expect(approvalProofTriggers(['updated'])).toEqual(['proofs.updated']);
    expect(approvalProofTriggers(['restored', 'per_action'])).toEqual([
      'proofs.perActionMaxUSD',
      'proofs.restored',
    ]);
  });

  it('the hard ceilings still refuse inside the window (never an approval)', () => {
    const out = evaluateProof(defaults, proof('0.51'), {
      now: NOW,
      ledger: empty,
      restoreWindow: true,
    });
    expect(out.decision).toBe('deny');
    expect(out.ceiling).toBe('per_action');
  });

  it('checkAndReserveProof reserves nothing without the owner, and reserves with the owner', async () => {
    const store = new MemoryStore();
    await store.transaction((tx) =>
      tx.insert('budget_state', {
        slot: SINGLETON_SLOT,
        ledger_epoch: 1,
        status: 'ok',
        newest_t: NOW - 10,
        since: NOW - 100,
        broken_at: null,
      }),
    );
    const reservation = (n: number) => ({
      entryId: `led_${String(n)}`,
      recordId: `0x${String(n).padStart(64, '0')}`,
      chainId: 1,
      approvalId: null,
      deadline: NOW + 600,
    });
    const base = { effective: defaults, action: proof('0.01'), now: NOW, restoreWindow: true };
    const asked = await store.transaction((tx) =>
      checkAndReserveProof(tx, { ...base, reservation: reservation(1), ownerApproved: false }),
    );
    expect(asked.decision).toBe('approval');
    expect(asked.reserved).toBe(false);
    const approved = await store.transaction((tx) =>
      checkAndReserveProof(tx, { ...base, reservation: reservation(2), ownerApproved: true }),
    );
    expect(approved.reserved).toBe(true);
  });
});

describe('outgoing caps in the restore window', () => {
  const usage = (messages: number) => ({
    contactMessages: 0,
    messages,
    contactFiles: 0,
    files: 0,
    bytes: 0,
  });
  it('the per-day caps are halved while the window is open', () => {
    const half = Math.floor(OUTGOING_DEFAULTS.messagesPerDay / 2);
    const action = { contact: `0x${'3d'.repeat(20)}`, files: 0, bytes: 0 };
    expect(evaluateOutgoing(defaults, action, usage(half)).decision).toBe('allow');
    const inWindow = evaluateOutgoing(defaults, action, usage(half), { restoreWindow: true });
    expect(inWindow).toEqual({ decision: 'deny', limit: 'messages_day', max: half });
    expect(
      evaluateOutgoing(defaults, action, usage(half - 1), { restoreWindow: true }).decision,
    ).toBe('allow');
  });
});

describe('commitments in the restore window', () => {
  const grant = { basis: 'auto_accept', policyHash: '0x00' } as const;
  it('a policy allow becomes an owner request; anything else is unchanged', () => {
    expect(guardCommitment({ decision: 'allow', grant }, true)).toEqual({
      decision: 'approval',
      autoAccept: 'restored',
    });
    expect(guardCommitment({ decision: 'allow', grant }, false)).toEqual({
      decision: 'allow',
      grant,
    });
    expect(guardCommitment({ decision: 'deny' }, true)).toEqual({ decision: 'deny' });
    expect(guardCommitment({ decision: 'approval', autoAccept: 'reject' }, true)).toEqual({
      decision: 'approval',
      autoAccept: 'reject',
    });
  });
});
