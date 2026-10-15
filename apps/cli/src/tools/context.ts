// The handler context (06 §1, D-73 (1); M1-9c). A handler is a function of its validated input and
// this context; it never opens a file, a socket, the keychain or the store itself. Everything goes
// through the core client, so a Worker (M2-3b) can supply the same context.
//
// `ToolClient` is the narrow read surface the handlers use, built from an `AgentLinkClient` by
// `coreToolClient` (pure: core and crypto only). Tests pass doubles. The M1-9k pieces the handlers
// may not import (src/approval/next-step.ts, 06 §1) arrive here as plain functions.
import type {
  AgentLinkClient,
  ApprovalCheck,
  ContactView,
  InboxSender,
  SendMessageInput,
  SendMessageResult,
} from '@agentlink/core';
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

/** A file as an inbox item shows it (06 §2.2 `FileInfo`): never a URL, a file key or inline bytes. */
export interface PageFile {
  readonly index: number;
  readonly size: number;
  readonly plaintextSha256: string;
  readonly delivery: 'inline' | 'drop' | 'own';
  /** Unix seconds, or null for inline. */
  readonly expiresAt: number | null;
  /** Untrusted (I-5): the sender's file name and MIME type, for the block only. */
  readonly name: string;
  readonly mime: string;
}

/** What every inbox page item carries (06 §2.2 `MessageBase`, before the wrapper). */
interface PageItemBase {
  readonly envelopeId: string;
  readonly thread: string;
  readonly type: string;
  /** The envelope's `createdAt`, unix seconds. */
  readonly createdAt: number;
  readonly replyTo: string | null;
  readonly files: readonly PageFile[];
  /**
   * Untrusted (I-5): the body of a Talk item (a string or a JSON object), or null for `offer`,
   * `accept` and `reject`, whose content is `terms` and `note`.
   */
  readonly body: string | Readonly<Record<string, unknown>> | null;
  /** Untrusted: the terms of an `offer`, `accept` or `reject`, as received. */
  readonly terms?: Readonly<Record<string, unknown>>;
  /** Untrusted: the free note of an `offer` or `reject`. */
  readonly note?: string | null;
  /** Ours (checked by the core): the terms reference of an `offer`, `accept` or `reject`. */
  readonly termsRef?: {
    readonly termsId: string;
    readonly version: number;
    readonly termsHash: string;
    /** Unix seconds. */
    readonly validUntil: number;
  };
}

/** An inbound item: from a contact, or an accepted request (`from: null`, D-72). */
export interface InboundPageItem extends PageItemBase {
  readonly direction: 'in';
  /** The contact under the 06 §2.1 rule; null only for an accepted request (D-72). */
  readonly from: InboxSender | null;
  /** Only when `from` is null: the 04 §2.9 sender code, short form (`2B9E·04D1`). */
  readonly senderCode?: string;
  /** True if it had been returned before this call (06 §2.2 "Read state"). */
  readonly read: boolean;
}

/** An outbound item (06 §2.2 `OutboundMessage`). */
export interface OutboundPageItem extends PageItemBase {
  readonly direction: 'out';
  readonly to: InboxSender;
  readonly delivery: 'queued' | 'sent' | 'not_delivered';
}

export type PageItem = InboundPageItem | OutboundPageItem;

/** One `agentlink_inbox` page query (06 §2.2 "Order and paging", "Read state"). */
export interface InboxPageQuery {
  /** Only this contact's items (the thread view). */
  readonly contactId?: string;
  /** Only items with `createdAt` at or after this, unix seconds. */
  readonly since?: number;
  /** Only items strictly older than this envelope, by (`createdAt`, envelopeId bytes). */
  readonly before?: string;
  /** 1 to 100. */
  readonly limit: number;
  /** False: unread inbound items only. */
  readonly includeRead: boolean;
  /** False: no outbound items. */
  readonly includeSent: boolean;
  /**
   * The bytes an item takes in the text result. The core takes the newest matching items first and
   * stops before the item that would take the sum above `maxBytes`, keeping at least one.
   */
  readonly sizeOf: (item: PageItem) => number;
  readonly maxBytes: number;
}

export type InboxPage =
  | {
      readonly status: 'ok';
      /** Oldest first. Inbound items here are marked read in the transaction that built the page. */
      readonly items: readonly PageItem[];
      /** The requests queue, a count only (06 §2.1). */
      readonly requests: number;
    }
  /** `before` names no item this query can see: nothing was read or marked. */
  | { readonly status: 'before_not_found' };

/** The core surface the handlers use. */
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
   * Pending approval requests. Absent until the core read lands (card M1-7e-3, PR #116; wired in
   * `coreToolClient` by M1-9c-b); until then `agentlink_status` leaves `pendingApprovals` out.
   */
  pendingApprovals?(): Promise<number>;
  /**
   * The core's approval check for the row's own stored action (06 §2.5), or undefined for an
   * unknown ID. Absent until the core read lands (card M1-7e-3, PR #116; wired by M1-9c-b);
   * until then `agentlink_get_approval` answers with the fixed "not available yet" error.
   */
  approvalState?(approvalId: string): Promise<StoredApprovalState | undefined>;
  /** Core `sendMessage` (M1-7k): policy, envelope, outbox, first publish; idempotent (07 §3.3). */
  send(input: SendMessageInput): Promise<SendMessageResult>;
  /** Core `syncInbox` (M1-7h): fetches, stores and processes envelopes within the budget (06 §6). */
  syncInbox(budgetMs: number): Promise<void>;
  /**
   * One inbox page with its read marks (06 §2.2). Absent until the core page read lands (proposed card M1-7h-c);
   * until then `agentlink_inbox` answers with the fixed "not available yet" error and syncs nothing.
   */
  inboxPage?(query: InboxPageQuery): Promise<InboxPage>;
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
    send: (input) => client.sendMessage(input),
    async syncInbox(budgetMs) {
      await client.syncInbox({ budgetMs });
    },
    async storageMode() {
      const effective = await client.ownerActions.loadPolicy();
      return effective.mode !== 'fail_closed' && effective.policy.files.storage === 'own'
        ? 'own'
        : 'drop';
    },
  });
}
