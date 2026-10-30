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
  type AcknowledgeInput,
  type AcknowledgeResult,
  type AgentLinkClient,
  type ApprovalResume,
  type ApprovalState,
  type ApprovalUse,
  type ContactView,
  type CreatedInvite,
  type ExportProofPackInput,
  type ExportProofPackResult,
  type FetchFileInput,
  type FetchFileResult,
  type InboxSender,
  type NotarizeInput,
  type NotarizeResult,
  type OpenApproval,
  type OpenOffer,
  type OutgoingFile,
  type PendingContact,
  type PolicyDecision,
  type ProofView,
  type ProposeTermsInput,
  type ProposeTermsResult,
  type RespondToTermsInput,
  type RespondToTermsResult,
  type SendMessageInput,
  type SendMessageResult,
} from '@4thtech-io/core';
import type { ContactDisplayName, ReceiptTypeName } from '@4thtech-io/types';
import {
  agentFingerprint,
  decodeHex0x,
  formatFingerprint,
  ownerFingerprint,
} from '@4thtech-io/crypto';
import type { Logger } from '@4thtech-io/log';
import {
  createFreeCreditsClaimer,
  type FreeCreditsMarker,
  type FreeCreditsOutcome,
} from './free-credits.js';
import type { PayPageConfig } from '@4thtech-io/chain';

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
  /**
   * Seconds a relay returned at its cap in this fetch (M1-5g; core `incomplete`): some messages may
   * be missing. A count only; absent or 0 when none, and for stored counts.
   */
  readonly incomplete?: number;
}

/** What a core `syncInbox` reports to the tools (M1-5g): a count only, never relay text. */
export interface SyncSummary {
  /** Seconds a relay returned at its cap (core `incomplete`). */
  readonly incomplete: number;
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
  /** Ours (M1-33d): the contact asked for a delivery receipt that is not signed yet. A flag only. */
  readonly receiptRequested?: true;
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
  /**
   * W4-SHORT-INVITE (04 §3.6.2): the format 1 link of a link (a short link fetched once from the
   * configured drop). Absent in a double: the link is used as given.
   */
  resolve?(link: string): Promise<string>;
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

/**
 * A file a `path` argument names, checked by the platform under the 04 §4 allowed-folder rule
 * (realpath on both sides, not hidden, outside the protected roots, a regular file) and NOT opened:
 * the core opens it once, through `file.open()`, after its own checks (M1-7f), and the platform
 * checks the path again when it opens it (M1-15 `openAllowedFile`).
 */
export interface AttachedFile {
  /** For the core's `sendMessage({files})`. Its realpath stays on this device. */
  readonly file: OutgoingFile;
  /** The name the contact sees: the realpath's last segment. Agent-chosen text (I-5). */
  readonly name: string;
  /** Plaintext bytes. */
  readonly size: number;
  /**
   * The plaintext SHA-256, 64 lowercase hex: hashed during the core's one read or, for an
   * idempotent repeat (the core reads nothing), read once more through the same checked open.
   */
  plaintextSha256(): Promise<string>;
}

/** Why a `path` cannot be attached. Fixed reasons only: never the path or its resolved form. */
export type AttachRefusal =
  /** No `files.allowedFolders` entry exists (`needs_setup`, 06 §2.3). */
  | 'no_folder'
  /** Outside every allowed folder, also through a symbolic link (`needs_setup`, 06 §2.3). */
  | 'outside_folder'
  /** Not a full path, `.` or `..` segments, hidden, protected, or not a regular file. */
  | 'not_allowed'
  | 'not_found';

export type AttachOutcome =
  | { readonly ok: true; readonly file: AttachedFile }
  | { readonly ok: false; readonly reason: AttachRefusal };

/**
 * The platform half of attaching a file (src/runtime/files.ts in Node): resolves and checks `path`
 * against `allowedFolders` without opening the file.
 */
export interface FileOpener {
  attach(path: string, allowedFolders: readonly string[]): Promise<AttachOutcome>;
}

/** The file calls of `agentlink_send` with `path` and `agentlink_fetch_file` (M1-9d-1; 06 §2.3). */
export interface FileTools {
  /** Checks `path` against the policy's `files.allowedFolders` (none under fail-closed, 06 §3). */
  attach(path: string): Promise<AttachOutcome>;
  /** Core `fetchFile` (M1-7f): size cap, SSRF-safe download, both hashes, quarantine (D-84). */
  fetch(input: FetchFileInput): Promise<FetchFileResult>;
}

/** The two folders a proof pack `path` may name (06 §2.4, D-87): policy paths, `~/` allowed. */
export interface PackFolders {
  readonly exportFolder: string;
  readonly inboxFolder: string;
}

/** A proof pack file read for `agentlink_verify_proof_pack` `path` (D-87). Fixed codes only. */
export type PackReadOutcome =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly code: 'PATH_NOT_ALLOWED' | 'PACK_TOO_LARGE' | 'PACK_INVALID' };

/** A pack saved into `proofs.exportFolder`. `rules`: the policy fails closed (06 §3). */
export type PackSaveOutcome =
  | { readonly ok: true; readonly savedTo: string }
  | { readonly ok: false; readonly reason: 'rules' | 'folder' };

/**
 * A proof pack's verification (07 §8; the chain package's `verifyProofPack`), as the handler needs
 * it. Every hex value is checked by the verifier against the chain; the disclosed content is
 * untrusted (I-5) and goes only into the untrusted block.
 */
export type PackCheck =
  | {
      readonly valid: false;
      readonly verdict: 'failed';
      /** The chain package's fixed failure code (snake_case). */
      readonly reason: string;
    }
  | {
      readonly valid: true;
      /** D-95: `record_only` is never shown as a full pass. */
      readonly verdict: 'verified' | 'record_only';
      /** The shipped chain's config key (Advanced detail; never in a summary). */
      readonly chain: string;
      readonly recordId: string;
      readonly signer: string;
      /** The owner keys of the signer's card, when the pack carries a valid one. */
      readonly signerCard: {
        readonly ownerEvm: string;
        readonly ownerNostr: string;
        readonly ownerEnc: string;
      } | null;
      readonly timestamp: string;
      readonly envelopeHash: string;
      readonly receipts: readonly { readonly type: ReceiptTypeName; readonly at: string }[];
      readonly contentVerified: boolean;
      /** Untrusted (I-5): the disclosed payload, when it opened; only for the untrusted block. */
      readonly content: unknown;
      /** Non-fatal finding codes (`signer_no_longer_confirms`, `receipt_tx_mismatch`). */
      readonly notices: readonly string[];
    };

/** The agent's credits and the price list (06 §2.1 `credits`, `prices`; D-45, G-43). */
export interface AccountView {
  readonly credits: readonly {
    readonly chain: string;
    readonly token: string;
    /** Base units, decimal. */
    readonly amount: string;
    readonly usd: string;
  }[];
  readonly prices: readonly {
    readonly action: 'notarize';
    readonly usd: string;
    readonly protocolUsd: string;
    readonly integratorUsd: string;
  }[];
}

/** How `account` selects (M1-26-c, 07 §6.3): as the paid path does. */
export interface AccountOptions {
  /** Policy `proofs.defaultChain` (06 §3); left out under fail-closed, as the core does. */
  readonly defaultChain?: string;
}

/**
 * The proof calls (M1-9d-2; 06 §2.4). The core (M1-7g) does notarize, receipts and the pack; the
 * platform (src/runtime/proofs.ts in Node) reads and writes pack files and runs the verifier and the
 * credit reads against the shipped chains. Nothing here changes a policy, decides an approval or
 * exports an agent key (I-4).
 */
export interface ProofTools {
  notarize(input: NotarizeInput): Promise<NotarizeResult>;
  acknowledge(input: AcknowledgeInput): Promise<AcknowledgeResult>;
  get(input: {
    readonly envelopeId?: string;
    readonly recordId?: string;
  }): Promise<ProofView | undefined>;
  /** Core `exportProofPack`: the content key only with the owner's approval (06 §3). */
  exportPack(input: ExportProofPackInput): Promise<ExportProofPackResult>;
  /** Writes the pack JSON into `proofs.exportFolder` under a new name; never overwrites. */
  savePack(recordId: string, json: string): Promise<PackSaveOutcome>;
  /** D-87: a pack file inside `proofs.exportFolder` or `files.inboxFolder` only. */
  readPack(path: string): Promise<PackReadOutcome>;
  /** The 07 §8 verifier against the shipped chains (their known Notary only). */
  verify(pack: Uint8Array | Readonly<Record<string, unknown>>): Promise<PackCheck>;
  /** Credits and prices within a short budget; undefined when no chain answered. */
  account(agentId: string): Promise<AccountView | undefined>;
  /** The Advanced `chain?` override: a shipped chain's key to its ID; undefined if unsupported. */
  chainIdOf(key: string): number | undefined;
  /**
   * M1-36i: free test credits on a testnet, claimed once per agent (tools/free-credits.ts). Absent
   * where the runtime has no free-credits service or no place to remember the claim.
   */
  freeCredits?(chainId: number): Promise<FreeCreditsOutcome>;
}

/** The platform half of the proof tools (src/runtime/proofs.ts in Node). */
export interface ProofPlatformTools {
  readPack(path: string, folders: PackFolders): Promise<PackReadOutcome>;
  savePack(exportFolder: string, recordId: string, json: string): Promise<PackSaveOutcome>;
  verify(pack: Uint8Array | Readonly<Record<string, unknown>>): Promise<PackCheck>;
  /** Credits and the price where the paid path would pay (M1-26-c, the same selection). */
  account(agentId: string, options?: AccountOptions): Promise<AccountView | undefined>;
  chainIdOf(key: string): number | undefined;
  /**
   * M1-36i: true only for a chain on the chain package's testnet allowlist whose shipped config says
   * testnet (the second check beside the core's own). Absent: no free test credits.
   */
  isFreeCreditsChain?(chainId: number): boolean;
}

/** The core surface the handlers use. */
export interface ToolClient {
  /** The agent's identity, or undefined when it has none yet (needs `agentlink init`). */
  self(): Promise<SelfView | undefined>;
  /**
   * W4-PAUSE (06 §6 "Paused agents"): whether the owner paused this agent (core `paused`, which is
   * true when the pause row cannot be read). Absent only in a double that does not need it.
   */
  paused?(): Promise<boolean>;
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
  syncInbox(budgetMs: number): Promise<SyncSummary | void>;
  /** One inbox page with its read marks (06 §2.2): core `inbox.page` (M1-7h-c; wired by M1-9p-b). */
  inboxPage(query: InboxPageQuery): Promise<InboxPage>;
  /** Invites and pairing (M1-9o). Absent in a double that does not need them: the tools then answer "not available". */
  readonly invites?: InviteTools;
  /** Terms (M1-9q). Absent in a double that does not need them: the tools then answer "not available". */
  readonly terms?: TermsTools;
  /**
   * Files (M1-9d-1). Absent where the runtime has no file platform: `agentlink_send` with `path` and
   * `agentlink_fetch_file` then answer "not available".
   */
  readonly files?: FileTools;
  /**
   * Proofs (M1-9d-2). Absent where the runtime has no proof platform: the proof tools then answer
   * "not available", and status carries no credits.
   */
  readonly proofs?: ProofTools;
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
  /**
   * M1-26-e: the shipped pay page config (the chain package's `PAY_PAGE`, which is not live yet).
   * A top-up link is given only when `live`; absent means the shipped config. Production wiring
   * never sets it; tests do, to exercise a live page.
   */
  readonly payPage?: PayPageConfig;
  /**
   * M1-36a-b: the command prefix that works on this machine (the runtime's `cliPrefix()`, M1-36a).
   * Only the two fixed forms are used (`noOwnerFor`); absent or anything else: the npx form.
   */
  readonly cliPrefix?: string;
  /**
   * M1-36a-b: whether an owner exists on this machine, for the no-owner text: `false` only when it is
   * known that none does (then `owner init`), undefined when unknown (then `owner add-agent`).
   */
  readonly ownerExists?: () => Promise<boolean | undefined>;
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

/** What the runtime adds to the core client (M1-9d-1). */
export interface CoreToolClientOptions {
  /** The platform's allowed-folder check for `path` arguments; without it there are no file tools. */
  readonly files?: FileOpener;
  /** The proof platform (pack files, verifier, credits); without it there are no proof tools. */
  readonly proofs?: ProofPlatformTools;
  /** M1-36i: where the free test credits claim is remembered; without it nothing is claimed. */
  readonly freeCredits?: FreeCreditsMarker;
}

/** Builds the handlers' read surface from a core client (pure: no Node, no store access). */
export function coreToolClient(
  client: AgentLinkClient,
  options: CoreToolClientOptions = {},
): ToolClient {
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
    paused: () => client.paused(),
    async catchUp(budgetMs) {
      const { inbox, requests, incomplete } = await client.catchUp({ budgetMs });
      return { inbox, requests, incomplete };
    },
    async storedCounts() {
      const { inbox, requests } = await client.inbox.counts();
      return { inbox, requests };
    },
    contacts: () => client.contacts.list(),
    send: (input) => client.sendMessage(input),
    async syncInbox(budgetMs) {
      const { incomplete } = await client.syncInbox({ budgetMs });
      return { incomplete };
    },
    inboxPage: (query) => client.inbox.page(query),
    pendingApprovals: () => client.approvalService.countPending(),
    approvalState: (approvalId) => client.approvalService.read(approvalId),
    approvalResume: (approvalId) => client.approvalService.resumeOf(approvalId),
    openOffers: () => client.terms.openOffers(),
    invites: coreInviteTools(client),
    terms: coreTermsTools(client),
    ...(options.files === undefined ? {} : { files: coreFileTools(client, options.files) }),
    ...(options.proofs === undefined
      ? {}
      : { proofs: coreProofTools(client, options.proofs, options.freeCredits) }),
    async storageMode() {
      const effective = await client.ownerActions.loadPolicy();
      return effective.mode !== 'fail_closed' && effective.policy.files.storage === 'own'
        ? 'own'
        : 'drop';
    },
  });
}

function coreFileTools(client: AgentLinkClient, opener: FileOpener): FileTools {
  return Object.freeze<FileTools>({
    async attach(path) {
      // 06 §3: under fail-closed no folder is allowed (`files.allowedFolders` treated as empty).
      const effective = await client.ownerActions.loadPolicy();
      const folders = effective.mode === 'fail_closed' ? [] : effective.policy.files.allowedFolders;
      return opener.attach(path, folders);
    },
    fetch: (input) => client.fetchFile(input),
  });
}

function coreProofTools(
  client: AgentLinkClient,
  platform: ProofPlatformTools,
  marker: FreeCreditsMarker | undefined,
): ProofTools {
  // M1-36i: only with both the runtime's testnet check and a marker; the core checks again.
  const isFreeCreditsChain = platform.isFreeCreditsChain?.bind(platform);
  const freeCredits =
    isFreeCreditsChain === undefined || marker === undefined
      ? undefined
      : createFreeCreditsClaimer({
          request: (chainId) => client.proofs.requestFaucet(chainId),
          isFreeCreditsChain,
          marker,
        });
  /** The verified policy's folders, or undefined while it fails closed (06 §3). */
  const folders = async (): Promise<PackFolders | undefined> => {
    const effective = await client.ownerActions.loadPolicy();
    if (effective.mode === 'fail_closed') return undefined;
    return {
      exportFolder: effective.policy.proofs.exportFolder,
      inboxFolder: effective.policy.files.inboxFolder,
    };
  };
  return Object.freeze<ProofTools>({
    notarize: (input) => client.notarize(input),
    acknowledge: (input) => client.acknowledge(input),
    get: (input) => client.getProof(input),
    exportPack: (input) => client.exportProofPack(input),
    async savePack(recordId, json) {
      const current = await folders();
      if (current === undefined) return { ok: false, reason: 'rules' };
      return platform.savePack(current.exportFolder, recordId, json);
    },
    async readPack(path) {
      // Under fail-closed no folder is allowed (D-87 folders come from the verified policy only).
      const current = await folders();
      if (current === undefined) return { ok: false, code: 'PATH_NOT_ALLOWED' };
      return platform.readPack(path, current);
    },
    verify: (pack) => platform.verify(pack),
    async account(agentId) {
      // M1-26-c: the core's paid path selects with the policy default chain (none under
      // fail-closed); status follows the same selection.
      const effective = await client.ownerActions.loadPolicy();
      const defaultChain =
        effective.mode === 'fail_closed' ? undefined : effective.policy.proofs.defaultChain;
      return platform.account(agentId, defaultChain === undefined ? {} : { defaultChain });
    },
    chainIdOf: (key) => platform.chainIdOf(key),
    ...(freeCredits === undefined ? {} : { freeCredits }),
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
    resolve: (link) => client.pairing.resolveInviteLink(link),
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
