// The handler context (06 §1, D-73 (1); M1-9c). A handler is a function of its validated input and
// this context; it never opens a file, a socket, the keychain or the store itself. Everything goes
// through the core client, so a Worker (M2-3b) can supply the same context.
//
// `ToolClient` is the narrow read surface the handlers use, built from an `AgentLinkClient` by
// `coreToolClient` (pure: core and crypto only). Tests pass doubles. The M1-9k pieces the handlers
// may not import (src/approval/next-step.ts, 06 §1) arrive here as plain functions.
import {
  CoreError,
  evaluate,
  type AgentLinkClient,
  type ApprovalResume,
  type ApprovalState,
  type ApprovalUse,
  type ContactView,
  type CreatedInvite,
  type InboxSender,
  type OpenApproval,
  type OpenOffer,
  type PendingContact,
  type PolicyDecision,
  type ProposeTermsInput,
  type ProposeTermsResult,
  type RespondToTermsInput,
  type RespondToTermsResult,
  type SendMessageInput,
  type SendMessageResult,
} from '@4thtech-io/core';
import type { ContactDisplayName } from '@4thtech-io/types';
import {
  agentFingerprint,
  decodeHex0x,
  formatFingerprint,
  ownerFingerprint,
} from '@4thtech-io/crypto';
import type { Logger } from '@4thtech-io/log';

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
  /** Only these envelopes (M1-22: the open offers); an empty list matches nothing. */
  readonly envelopeIds?: readonly string[];
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

/**
 * The invite and pairing calls of `agentlink_create_invite` and `agentlink_accept_invite` (M1-9o).
 * Nothing here sets `allowed`: `start` is called only after the handler has the policy `allow` or a
 * used owner approval (I-4).
 */
export interface InviteTools {
  /** A single-use invite (04 §3.6); the link carries the secret and is never logged. */
  create(input: { label?: string; expiresInDays?: number }): Promise<CreatedInvite>;
  /** Step 1 of accept: decodes and checks the link, stores nothing (06 §2.1 name rule applies). */
  check(link: string): Promise<PendingContact>;
  /** The policy decision for `contacts.acceptInvites`. */
  decision(): Promise<PolicyDecision>;
  /** Creates the pending approval for `action`; returns its `apr_` ID. */
  requestApproval(action: unknown, summary: string): Promise<string>;
  /**
   * The open request for this exact `action` (core `approvalService.findOpen`): `pending`, or
   * `approved` and unused, re-verified; undefined otherwise. Read-only: an `approved` answer lets
   * nothing run (the call must still name the ID, I-4).
   */
  findOpenApproval(action: unknown): Promise<OpenApproval | undefined>;
  /** Re-verifies the owner's signature against `action`'s digest and claims the approval once. */
  useApproval(approvalId: string, action: unknown, decision: PolicyDecision): Promise<ApprovalUse>;
  /** Stages the pairing and its handshake (only after `allow` or a used approval). */
  start(link: string): Promise<PendingContact>;
  /** Publishes the staged handshake; false when the network is unreachable (kept for later). */
  publish(): Promise<boolean>;
}

/**
 * The terms calls of `agentlink_propose_terms` and `agentlink_respond_to_terms` (M1-9q; 06 §2.2a,
 * D-55). The core (M1-32) fills the version, parties and links, checks the negotiation chain, builds
 * the commitment scope and decides it (policy grant or one owner request); nothing here sets or
 * widens an approval (I-4).
 */
export interface TermsTools {
  /** Core `proposeTerms`: `to` is the resolved contact's agent ID. */
  propose(input: ProposeTermsInput): Promise<ProposeTermsResult>;
  /** Core `respondToTerms`. */
  respond(input: RespondToTermsInput): Promise<RespondToTermsResult>;
  /**
   * The contact who sent the received `offer` or `accept` named by `envelopeId`, as the 06 §2.1
   * name rule shows it, or undefined when it is not one. For summaries only: the core decides.
   */
  senderOf(
    envelopeId: string,
  ): Promise<{ readonly id: string; readonly display: ContactDisplayName } | undefined>;
}

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
   * The number of approvals waiting for the owner (core `approvalService.countPending`, M1-7e-3):
   * undecided, not cancelled, not voided and not lapsed. A display count only.
   */
  pendingApprovals(): Promise<number>;
  /**
   * One approval read by ID for its own stored action (core `approvalService.read`, M1-7e-3): the
   * stored signed objects are re-verified before the row's `status` cache is read. Read-only.
   */
  approvalState(approvalId: string): Promise<ApprovalState>;
  /**
   * What an open approval is for (core `approvalService.resumeOf`, M1-22): the tool and only its
   * structured, schema-checked args, while the agent still has something to run. Read-only; it
   * authorises nothing (I-4). Absent in a double that does not need it.
   */
  approvalResume?(approvalId: string): Promise<ApprovalResume | undefined>;
  /**
   * Received offers waiting for an answer (core `terms.openOffers`, M1-22): IDs and numbers only,
   * read from the store (no relay traffic, nothing marked). Absent in a double that does not need it.
   */
  openOffers?(): Promise<readonly OpenOffer[]>;
  /** Core `sendMessage` (M1-7k): policy, envelope, outbox, first publish; idempotent (07 §3.3). */
  send(input: SendMessageInput): Promise<SendMessageResult>;
  /** Core `syncInbox` (M1-7h): fetches, stores and processes envelopes within the budget (06 §6). */
  syncInbox(budgetMs: number): Promise<void>;
  /** One inbox page with its read marks (06 §2.2): core `inbox.page` (M1-7h-c; wired by M1-9p-b). */
  inboxPage(query: InboxPageQuery): Promise<InboxPage>;
  /** Invites and pairing (M1-9o). Absent in a double that does not need them: the tools then answer "not available". */
  readonly invites?: InviteTools;
  /** Terms (M1-9q). Absent in a double that does not need them: the tools then answer "not available". */
  readonly terms?: TermsTools;
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
  /**
   * M1-11a-b: the local approval UI's link for one request (08 §1, 06 §2.5), built by `agentlink
   * mcp`; absent elsewhere (the CLI commands and tests keep the M1a result). It may start the local
   * approval server. Undefined when no link can be given: the result then stays the M1a one.
   */
  readonly approvalLink?: (approvalId: string) => Promise<ApprovalLink | undefined>;
}

/**
 * The approval page link of a `pending_approval` result. The url holds no secret (no session
 * link): it grants nothing to the agent that sees it (04 §2.5, I-4).
 */
export interface ApprovalLink {
  /** `http://localhost:<port>/approve/<approvalId>`. */
  readonly url: string;
  /** `http://localhost:<port>`: the only origin the result `url` may use. */
  readonly origin: string;
  /** The nextStep text with the link, which replaces the M1a `approvalNextStep` text. */
  readonly nextStep: string;
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
    inboxPage: (query) => client.inbox.page(query),
    pendingApprovals: () => client.approvalService.countPending(),
    approvalState: (approvalId) => client.approvalService.read(approvalId),
    approvalResume: (approvalId) => client.approvalService.resumeOf(approvalId),
    openOffers: () => client.terms.openOffers(),
    invites: coreInviteTools(client),
    terms: coreTermsTools(client),
    async storageMode() {
      const effective = await client.ownerActions.loadPolicy();
      return effective.mode !== 'fail_closed' && effective.policy.files.storage === 'own'
        ? 'own'
        : 'drop';
    },
  });
}

/** The received envelope types a terms answer can name (06 §2.2a (a) and (b)). */
const ANSWERABLE: ReadonlySet<string> = new Set(['offer', 'accept']);

function coreTermsTools(client: AgentLinkClient): TermsTools {
  return Object.freeze<TermsTools>({
    propose: (input) => client.proposeTerms(input),
    respond: (input) => client.respondToTerms(input),
    async senderOf(envelopeId) {
      // The core's own inbox read: a processed inbound row from a contact, opened in memory only.
      const [item] = await client.inbox.items([envelopeId]);
      if (item === undefined || !ANSWERABLE.has(item.type)) return undefined;
      return { id: item.from.contactId, display: item.from.display };
    },
  });
}

/** Core errors that only mean "the outbox could not publish right now". */
const OFFLINE_CODES: ReadonlySet<string> = new Set(['transport_unavailable']);

function coreInviteTools(client: AgentLinkClient): InviteTools {
  return Object.freeze<InviteTools>({
    create: (input) => client.pairing.createInvite(input),
    async check(link) {
      return (await client.pairing.acceptInvite({ link })).contact;
    },
    async decision() {
      return evaluate(await client.ownerActions.loadPolicy(), { kind: 'invite.accept' });
    },
    async requestApproval(action, summary) {
      const pending = await client.approvalService.request({
        action,
        summary,
      });
      return pending.approvalId;
    },
    findOpenApproval: (action) => client.approvalService.findOpen(action),
    useApproval: (approvalId, action, decision) =>
      client.approvalService.use(approvalId, action, decision),
    async start(link) {
      const started = await client.pairing.acceptInvite({ link, allowed: true });
      // `allowed` was set, so this does not happen; fail closed if it ever does.
      if (started.status !== 'pending') {
        throw new CoreError('approval_action_invalid', 'The pairing could not be started.');
      }
      return started.contact;
    },
    async publish() {
      try {
        const summary = await client.outbox.processDue();
        return summary.sent > 0 && summary.failed === 0 && summary.notDelivered === 0;
      } catch (error) {
        if (error instanceof CoreError && !OFFLINE_CODES.has(error.code)) throw error;
        return false;
      }
    },
  });
}
