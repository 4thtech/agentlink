// RESTORE-TRACES (D-156; 04 §2.3.3 "After a restore"; 07 §3.5): what a restore leaves in the store,
// for the owner to see. Display only: the guard itself (restore-guard.ts) decides from the restore
// mark, never from these rows.
//
// - `budget_restores`: one spending-history entry per restore mark, written when the core opens the
//   store (AgentLinkClient.create): `restore` when the ID was restored from a backup, `update` when an
//   update started the guard. A time and a reason, never an amount; the budget never reads it. A
//   restore replaces the store with the backup's, so the entry is written after it, from the mark.
// - `restore_replays`: inbound first stored after a restore whose signed createdAt is before it (the
//   guard's skew rule), written with the envelope (envelopes.ts receive). Only for a known restore
//   from a backup: an update that started the guard, or an unreadable mark, still stops every
//   automatic action (fail closed) but labels nothing.
//
// Nothing behind an MCP tool writes or deletes either table (I-4).
import type { CoreContext } from './context.js';
import { nowOf } from './context.js';
import { readRestoreState, restoredReplay, type RestoreState } from './restore-guard.js';
import type { StoreTx } from './store/store.js';

/**
 * Writes the spending-history entry of the current restore mark, once per mark. Never throws: the
 * entry is for display, and the guard holds without it.
 */
export async function recordRestoreTrace(ctx: CoreContext): Promise<void> {
  try {
    const state = await readRestoreState(ctx);
    if (state.status !== 'restored') return;
    const now = nowOf(ctx);
    await ctx.store.transaction((tx) => {
      if (tx.get('budget_restores', { restored_at: state.restoredAt }) !== undefined) return;
      tx.insert('budget_restores', {
        restored_at: state.restoredAt,
        reason: state.reason,
        noted_at: now,
      });
    });
  } catch {
    // Display only; a later open writes it.
  }
}

/**
 * Inside the transaction that first stores an inbound envelope: records it as received again after
 * the restore when its signed createdAt is before the restore (with the skew allowance).
 */
export function noteReplayTx(
  tx: StoreTx,
  state: RestoreState,
  envelopeId: string,
  createdAt: number,
): void {
  // An update that started the guard restored nothing: nothing arrives "from before" it.
  if (state.status !== 'restored' || state.reason !== 'restore') return;
  if (!restoredReplay(state, createdAt)) return;
  if (tx.get('restore_replays', { envelope_id: envelopeId }) !== undefined) return;
  tx.insert('restore_replays', { envelope_id: envelopeId, restored_at: state.restoredAt });
}
