// The M1a local approval channel (06 §2.5, 03 §3, §4.5; D-73 (3); M1-9k).
//
// Until the local approval server lands (M1b), the owner decides in the CLI, in a terminal the agent
// does not control: `agentlink approve <id>` opens the same agent and store, signs the decision with
// owner presence and applies it through its own core client (M1-9b). Nothing travels between the
// processes except through the store.
//
// So this channel has nothing to deliver:
// - `request()` writes nothing, sends nothing and returns `{approvalId}` with no URL.
// - `status()` reads the approval row and returns `pending` while the row exists, has no signed
//   decision or cancel and has not expired, and `unknown` otherwise. It NEVER returns `signed`, so
//   core's `collect` is not used in M1a. The row's `status` column is a cache and is ignored here.
//
// I-4: a channel is delivery, not authority. Nothing it returns approves anything; the server's core
// re-verifies the stored signed object against the action digest it recomputes (M1-7e). This class
// has no method that decides, applies, claims or changes a row, and the object is frozen.
import type {
  ApprovalChannel,
  ApprovalChannelStatus,
  ApprovalRequest,
  ApprovalTicket,
  Store,
} from '@4thtech-io/core';
import { approvalIdSchema } from '@4thtech-io/types';

/** What the channel needs from an approval row: presence of the signed objects and the expiry. */
export interface ApprovalRowView {
  readonly hasSignedDecision: boolean;
  readonly hasSignedCancel: boolean;
  /** Unix seconds. */
  readonly expiresAt: number;
}

/**
 * Reads one approval row by ID. Core has no public read-by-id for the channel, so the runtime reads
 * the row through the Store interface (storeApprovalReader). Reads only clear columns; no `enc`
 * column is opened.
 */
export interface ApprovalRowReader {
  read(approvalId: string): Promise<ApprovalRowView | undefined>;
}

/** The ApprovalRowReader over the agent's store (07 §3 `approvals`). */
export function storeApprovalReader(store: Store): ApprovalRowReader {
  return Object.freeze({
    read: async (approvalId: string): Promise<ApprovalRowView | undefined> => {
      const row = await store.transaction((tx) => tx.get('approvals', { approval_id: approvalId }));
      if (row === undefined) return undefined;
      return {
        hasSignedDecision: row.signed_decision !== null,
        hasSignedCancel: row.signed_cancel !== null,
        expiresAt: row.expires_at,
      };
    },
  });
}

const PENDING: ApprovalChannelStatus = Object.freeze({ state: 'pending' });
const UNKNOWN: ApprovalChannelStatus = Object.freeze({ state: 'unknown' });

export interface LocalApprovalChannelOptions {
  readonly reader: ApprovalRowReader;
  /** Unix seconds. */
  readonly clock: () => number;
}

/**
 * Builds the M1a channel. Returns a frozen object with exactly `request` and `status`: there is no
 * route through it to a decision (I-4).
 */
export function createLocalApprovalChannel(options: LocalApprovalChannelOptions): ApprovalChannel {
  const { reader, clock } = options;
  const isApprovalId = (value: unknown): value is string =>
    typeof value === 'string' && approvalIdSchema.safeParse(value).success;

  return Object.freeze({
    request(request: ApprovalRequest): Promise<ApprovalTicket> {
      const approvalId = (request as { approvalId?: unknown } | null)?.approvalId;
      if (!isApprovalId(approvalId)) {
        return Promise.reject(new Error('approval channel: the approval ID is not valid'));
      }
      // No `url` in M1a (06 §2.5 step 1): the tool's nextStep names `agentlink approve <id>`.
      return Promise.resolve(Object.freeze({ approvalId }));
    },
    async status(approvalId: string): Promise<ApprovalChannelStatus> {
      // Fail closed: anything not provably a live, undecided row is `unknown`; never `signed`.
      if (!isApprovalId(approvalId)) return UNKNOWN;
      let view: ApprovalRowView | undefined;
      try {
        view = await reader.read(approvalId);
      } catch {
        return UNKNOWN;
      }
      if (view === undefined) return UNKNOWN;
      if (view.hasSignedDecision !== false || view.hasSignedCancel !== false) return UNKNOWN;
      let now: number;
      try {
        now = clock();
      } catch {
        return UNKNOWN;
      }
      if (
        typeof view.expiresAt !== 'number' ||
        !Number.isFinite(view.expiresAt) ||
        !Number.isFinite(now) ||
        view.expiresAt <= now
      ) {
        return UNKNOWN;
      }
      return PENDING;
    },
  });
}
