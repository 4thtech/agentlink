// The handler context (06 §1, D-73 (1); M1-9c). A handler is a function of its validated input and
// this context; it never opens a file, a socket, the keychain or the store itself. Everything goes
// through the core client, so a Worker (M2-3b) can supply the same context.
//
// `ToolClient` is the narrow read surface the handlers use, built from an `AgentLinkClient` by
// `coreToolClient` (pure: core and crypto only). Tests pass doubles. The M1-9k pieces the handlers
// may not import (src/approval/next-step.ts, 06 §1) arrive here as plain functions.
import type { AgentLinkClient, ApprovalCheck, ContactView } from '@agentlink/core';
import {
  agentFingerprint,
  decodeHex0x,
  formatFingerprint,
  ownerFingerprint,
} from '@agentlink/crypto';
import type { Logger } from '@agentlink/log';

/** The agent's own identity as status shows it: IDs and display fingerprints only. */
export interface SelfView {
  readonly agentId: string;
  /** Short agent fingerprint (04 §2.9), `7F3A·19C2`. */
  readonly agentFingerprint: string;
  /** Short owner fingerprint. */
  readonly ownerFingerprint: string;
}

/** Counts by contact (never content) and the requests count (06 §2.1). */
export interface Counts {
  readonly inbox: readonly { readonly contactId: string; readonly unread: number }[];
  readonly requests: number;
}

/** What the core's approval check gives for a stored approval's own action (06 §2.5). */
export interface StoredApprovalState {
  readonly check: ApprovalCheck;
  /** The row's `decided_at`, unix seconds, or null. */
  readonly decidedAt: number | null;
}

/** The read surface the M1-9c handlers use. */
export interface ToolClient {
  /** The agent's identity, or undefined when it has none yet (needs `agentlink init`). */
  self(): Promise<SelfView | undefined>;
  /** The fetch-only catch-up (M1-7h, D-73): fetches and stores, processes nothing (06 §2.0). */
  catchUp(budgetMs: number): Promise<Counts>;
  /** The same counts from the store only (no relay traffic). */
  storedCounts(): Promise<Counts>;
  /** Contacts that are not removed (core `contacts.list`). */
  contacts(): Promise<readonly ContactView[]>;
  /** The backend for files above the inline limit under the current policy (06 §2.1). */
  storageMode(): Promise<'drop' | 'own'>;
  /**
   * Pending approval requests. Absent until the core exposes a read for it (no public core API
   * reads the `approvals` table in M1a); `agentlink_status` then leaves `pendingApprovals` out.
   */
  pendingApprovals?(): Promise<number>;
  /**
   * The core's approval check for the row's own stored action (06 §2.5), or undefined for an
   * unknown ID. Absent until the core exposes it; `agentlink_get_approval` then answers with the
   * fixed "not available yet" error.
   */
  approvalState?(approvalId: string): Promise<StoredApprovalState | undefined>;
}

export interface ToolContext {
  readonly client: ToolClient;
  /** Unix seconds. */
  readonly clock: () => number;
  readonly logger: Logger;
  /** The local agent name this server serves (06 §6 pattern; checked by the runtime). */
  readonly agentName: string;
  /**
   * The `nextStep` of a `pending_approval` result (06 §2.5 step 2): M1-9k's `approvalNextStep`
   * bound to this server's local agent name. It checks the ID and the name itself.
   */
  readonly approvalNextStep: (approvalId: string) => string;
  /**
   * Origins a result `url` may use (the local UI and console origins, 06 §1 rule 3; IR-M1-2b-1
   * F-5). Empty in M1a: there is no URL (D-73 (3)), so any `url` is refused.
   */
  readonly urlOrigins: readonly string[];
}

/** When the server runs for an agent that is not set up: every tool answers `needs_setup`. */
export interface NeedsSetupContext {
  readonly needsSetup: {
    /** Fixed copy (the runtime's `needs_setup` message). */
    readonly message: string;
  };
  readonly logger: Logger;
}

export type HandlerEnvironment = ToolContext | NeedsSetupContext;

const short = (digest: Uint8Array): string => formatFingerprint(digest, 'short');

/** Builds the handlers' read surface from a core client (pure: no Node, no store access). */
export function coreToolClient(client: AgentLinkClient): ToolClient {
  return Object.freeze<ToolClient>({
    async self() {
      const identity = await client.identity.get();
      if (identity === undefined) return undefined;
      const { card } = identity;
      return {
        agentId: identity.agentId,
        agentFingerprint: short(agentFingerprint(decodeHex0x(identity.agentId, { length: 20 }))),
        ownerFingerprint: short(
          ownerFingerprint(
            decodeHex0x(card.ownerEvm, { length: 20 }),
            decodeHex0x(card.ownerNostr, { length: 32 }),
            decodeHex0x(card.ownerEnc, { length: 32 }),
          ),
        ),
      };
    },
    async catchUp(budgetMs) {
      const { inbox, requests } = await client.catchUp({ budgetMs });
      return { inbox, requests };
    },
    async storedCounts() {
      const { inbox, requests } = await client.inbox.counts();
      return { inbox, requests };
    },
    contacts: () => client.contacts.list(),
    async storageMode() {
      const effective = await client.ownerActions.loadPolicy();
      return effective.mode !== 'fail_closed' && effective.policy.files.storage === 'own'
        ? 'own'
        : 'drop';
    },
  });
}
