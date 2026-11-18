// SEC-RESTORE-GUARD (D-156; 04 §2.3.3 "After a restore", 06 §3): what the core does after an ID was
// restored from a backup. The restored store holds the backup's spend state and the backup's
// seen-set, so the spending and the sending of the hours before the restore are not known here, and
// inbound that an earlier copy of this ID already handled can arrive again.
//
// - The restore mark is a KeyStore item next to the agent's keys (the runtime supplies it, as it
//   does the policy-version mark): the time of the last restore in unix seconds, 0 when the ID was
//   never restored. The runtime writes it when a restore writes the ID's keys; nothing in the core
//   or behind an MCP tool lowers or clears it.
// - For RESTORE_GUARD_SECONDS after that time (the restore window) every paid action asks the owner
//   (the hard ceilings still refuse), the outgoing per-day caps are halved, and a commitment is never
//   allowed by the rules alone: it asks the owner.
// - Inbound whose signed creation time is before the restore (with a clock-skew allowance) is stored
//   and shown, but triggers nothing automatically: no received ack, no automatic receipt, no file
//   saved automatically, no file link answered, and a contact it pairs waits for the owner.
// - Fail closed: a mark that cannot be read, or reads as anything but a time, counts as a restore
//   in force for every check (the window stays open and all inbound counts as replayed).
//
// A runtime without a mark (tests, a host with no KeyStore items) gets no guard: the Node runtime
// always passes one. Residual (G-1, 04 §2.5): KeyStore items are not a boundary against a same-user
// process; the on-chain allowance (SEC-ALLOWANCE) is the control for money.
import type { CommitmentEvaluation } from './commitments.js';
import type { CoreContext } from './context.js';
import { nowOf } from './context.js';

/** How long after a restore the guard holds (24 h, the budget window). */
export const RESTORE_GUARD_SECONDS = 86_400;

/** Inbound created up to this long after the restore still counts as sent before it (clock skew). */
export const RESTORE_CLOCK_SKEW_SECONDS = 300;

/** The restore mark, a KeyStore item supplied by the runtime. */
export interface RestoreMark {
  /**
   * The time of the last restore (unix seconds), or 0 when the ID was never restored. Rejects when
   * the item cannot be read or kept.
   */
  read(): Promise<number>;
}

export type RestoreState =
  | { readonly status: 'none' }
  | { readonly status: 'restored'; readonly restoredAt: number }
  /** The mark could not be read: every check treats it as a restore in force. */
  | { readonly status: 'unknown' };

const NONE: RestoreState = Object.freeze({ status: 'none' });
const UNKNOWN: RestoreState = Object.freeze({ status: 'unknown' });

/** The restore state from the context's mark. Never throws. */
export async function readRestoreState(ctx: CoreContext): Promise<RestoreState> {
  const mark = ctx.restoreMark;
  if (mark === undefined) return NONE;
  let at: unknown;
  try {
    at = await mark.read();
  } catch {
    return UNKNOWN;
  }
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) return UNKNOWN;
  return at === 0 ? NONE : Object.freeze({ status: 'restored', restoredAt: at });
}

/** True while the restore window is open at `now` (a clock earlier than the restore keeps it open). */
export function restoreWindowOpen(state: RestoreState, now: number): boolean {
  if (state.status === 'none') return false;
  if (state.status === 'unknown') return true;
  return now < state.restoredAt + RESTORE_GUARD_SECONDS;
}

/** True for inbound created before the restore (with the skew allowance): no automatic action. */
export function restoredReplay(state: RestoreState, createdAt: number): boolean {
  if (state.status === 'none') return false;
  if (state.status === 'unknown') return true;
  return !(createdAt >= state.restoredAt + RESTORE_CLOCK_SKEW_SECONDS);
}

/** Reads the mark and answers whether the restore window is open now. Never throws on the mark. */
export async function restoreWindowNow(ctx: CoreContext): Promise<boolean> {
  return restoreWindowOpen(await readRestoreState(ctx), nowOf(ctx));
}

/** A commitment the rules would allow asks the owner while the restore window is open. */
export function guardCommitment(
  evaluation: CommitmentEvaluation,
  windowOpen: boolean,
): CommitmentEvaluation {
  if (!windowOpen || evaluation.decision !== 'allow') return evaluation;
  return { decision: 'approval', autoAccept: 'restored' };
}
