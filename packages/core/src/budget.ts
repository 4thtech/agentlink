// The budget ledger (06 §3 "Daily budget window", G-7; 07 §3.5). The proof check is the pure
// `evaluateProof`; these helpers run it inside the caller's store transaction together with the
// reservation of the Record's `maxFee`, so paid actions are serialized per agent and two concurrent
// calls can never both pass on the same spent amount.
//
// Every helper takes a StoreTx and is synchronous (07 §3.1): the caller opens one transaction that
// also stores the signed Record, its salt and the idempotency effect (07 §3.5), and submits only
// after it commits. Fail closed: a missing `budget_state`, a row the engine finds inconsistent, a
// clock earlier than `newest_t`, or a read error makes the ledger broken, so every paid action needs
// the owner's approval until the next applied `policy.set` starts a fresh epoch (owner-actions.ts).
import {
  evaluateProof,
  type BudgetLedgerView,
  type EffectivePolicy,
  type ProofAction,
  type ProofEvaluation,
} from './policy-engine.js';
import { SINGLETON_SLOT } from './store/schema.js';
import type { StoreTx } from './store/store.js';

/** The ledger row to write when a proof passes or was approved (07 §3.5). */
export interface ProofReservation {
  readonly entryId: string;
  readonly recordId: string;
  readonly chainId: number;
  readonly approvalId: string | null;
  /** The Record's `deadline` (unix seconds): before it passes, the reservation is never released. */
  readonly deadline: number;
}

export interface ProofCheck extends ProofEvaluation {
  /** True when a `reserved` row was written in this transaction. */
  readonly reserved: boolean;
}

const BROKEN: BudgetLedgerView = Object.freeze({ status: 'broken' });

/**
 * The ledger of the current epoch as the engine reads it. Rows from earlier epochs are left out
 * (they no longer count); a row from a later epoch is kept so the engine sees the inconsistency.
 * A missing or broken `budget_state` gives 'broken'. A read error propagates to the caller.
 */
export function readBudgetLedger(tx: StoreTx): BudgetLedgerView {
  const state = tx.get('budget_state', { slot: SINGLETON_SLOT });
  if (state === undefined || state.status !== 'ok') return BROKEN;
  const entries = tx
    .select('budget_ledger', { ledger_epoch: { gte: state.ledger_epoch } })
    .map((r) => ({
      t: r.t,
      ledgerEpoch: r.ledger_epoch,
      state: r.state,
      reservedUsd: r.reserved_usd,
      chargedUsd: r.charged_usd,
    }));
  return { status: 'ok', epoch: state.ledger_epoch, newestT: state.newest_t, entries };
}

/** Marks the ledger broken, where a `budget_state` row exists to mark (07 §3.5). */
function markBroken(tx: StoreTx, now: number): void {
  tx.update(
    'budget_state',
    { slot: SINGLETON_SLOT, status: 'ok' },
    { status: 'broken', broken_at: now },
  );
}

/**
 * Check and reserve (06 §3, 07 §3.5), inside the caller's transaction: read the ledger, evaluate,
 * and write a `reserved` row for the action's `maxFeeUsd` when the result is `allow`, or when it is
 * `approval` and the owner already approved this action (an action approved over the limit is
 * reserved too). A `deny` is never reserved. A broken ledger is recorded as `broken`.
 */
export function checkAndReserveProof(
  tx: StoreTx,
  input: {
    readonly effective: EffectivePolicy;
    readonly action: ProofAction;
    readonly now: number;
    readonly reservation: ProofReservation;
    /** The core consumed a valid owner approval for this exact action (M1-7e). */
    readonly ownerApproved: boolean;
  },
): ProofCheck {
  const { effective, action, now, reservation } = input;
  let view: BudgetLedgerView;
  try {
    view = readBudgetLedger(tx);
  } catch {
    view = BROKEN; // a read error is never an empty sum
  }
  const result = evaluateProof(effective, action, { now, ledger: view });
  if (result.triggers.includes('ledger_broken')) markBroken(tx, now);
  const reserve =
    result.decision === 'allow' || (result.decision === 'approval' && input.ownerApproved);
  if (!reserve) return { ...result, reserved: false };

  const state = tx.get('budget_state', { slot: SINGLETON_SLOT });
  tx.insert('budget_ledger', {
    entry_id: reservation.entryId,
    ledger_epoch: state?.ledger_epoch ?? 0,
    t: now,
    record_id: reservation.recordId,
    chain_id: reservation.chainId,
    approval_id: reservation.approvalId,
    reserved_usd: action.maxFeeUsd,
    charged_usd: null,
    state: 'reserved',
    deadline: reservation.deadline,
    replaces: null,
    settled_at: null,
  });
  if (state !== undefined && now > state.newest_t) {
    tx.update('budget_state', { slot: SINGLETON_SLOT }, { newest_t: now });
  }
  return { ...result, reserved: true };
}

/**
 * The Record was confirmed on-chain: its `reserved` entry becomes `charged` with the charged fee
 * (06 §3 "Settle or release"). A compare-and-set; false when no reserved entry matched.
 */
export function settleProofCharged(
  tx: StoreTx,
  input: { readonly recordId: string; readonly chargedUsd: string; readonly now: number },
): boolean {
  return (
    tx.update(
      'budget_ledger',
      { record_id: input.recordId, state: 'reserved' },
      { state: 'charged', charged_usd: input.chargedUsd, settled_at: input.now },
    ) === 1
  );
}

export type ReleaseOutcome = 'released' | 'too_early' | 'has_record' | 'not_reserved';

/**
 * Releases a reservation only when the signed Record can no longer be charged: its `deadline` has
 * passed and the chain (read at the finalized block, 04 §5) shows no record for it. A failed
 * submission alone never releases it, because a submitter may still include the signed Record.
 */
export function releaseProofReservation(
  tx: StoreTx,
  input: { readonly recordId: string; readonly now: number; readonly chainHasRecord: boolean },
): ReleaseOutcome {
  const row = tx.select('budget_ledger', { record_id: input.recordId, state: 'reserved' })[0];
  if (row === undefined) return 'not_reserved';
  if (input.now <= row.deadline) return 'too_early';
  if (input.chainHasRecord) return 'has_record';
  const n = tx.update(
    'budget_ledger',
    { entry_id: row.entry_id, state: 'reserved' },
    { state: 'released', settled_at: input.now },
  );
  return n === 1 ? 'released' : 'not_reserved';
}
