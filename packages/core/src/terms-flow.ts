// The terms flow and one approval per agreement (M1-32; D-31, D-32, D-55, D-74; 04 §3.4, §3.4.2;
// 06 §2.2a; 07 §2.1, §3.5).
//
// - propose(): an `offer`. The core fills `termsId`, `version`, `parties`, `previousTermsHash` and
//   `termsHash` from its own store (terms-store.ts); `revises` only names the caller's own newest
//   offer that has no answer yet. Free and not a commitment.
// - respond(): `counter` (a new offer version linked to the newest one held), `reject` (free; carries
//   the stored terms) and `accept`, which is a commitment. The agent never supplies the terms of an
//   answer: they are copied from the stored offer.
// - A commitment builds one CommitmentScope v1 from stored data only, fixed at creation, with
//   `expiresAt = min(validUntil, createdAt + 7 days)`. `evaluateCommitment` decides (never the bare
//   `evaluate`): void → APPROVAL_VOID with no request; deny → nothing; allow → a policy grant row (a
//   ledger, never authority); approval → one pending request whose action carries the scope and the
//   stored terms. One live scope per scope key: a new pending scope voids an older pending one.
// - On the call with `approvalId`, the core re-verifies the stored owner `approval.decide` against
//   the digest it recomputes from the STORED action (or, for a grant, re-runs the rule on the
//   verified policy with recheckCommitmentGrant), checks void rules 1–6, and runs each part at most
//   once: a part is claimed by a compare-and-set in the store transaction that stores its signed
//   item, before anything is published. A claimed part is only ever republished, never re-signed.
// - The receipt parts (ACCEPTED / REJECTED, and the deferred receipt of 07 §2.1 step 4) are signed
//   by M1-7g (M1b): this module creates them, keeps their state, and gives M1-7g the lookup and the
//   atomic claim.
// - Records (M1-9d-3; 04 §3.4.2; 06 §2.2a): `notarize` on `propose` is a firm offer (scope
//   `offer`, `answers: null`): one `offer` envelope and its OFFER Record. `notarize` on an `accept`
//   adds its ACCEPT Record, left out (nothing charged) when the offer is already recorded. The
//   proof service (CommitmentRecorder) quotes the fee before the owner is asked, so the fee and any
//   proof trigger sit on the same single request (`needs_credits` first, nothing sent), and signs
//   the Record after the envelope, claiming the Record part in the transaction that stores it and
//   reserves its fee. `counter` and `reject` with `notarize` stay refused (NOTARIZE_UNAVAILABLE).
// - With a `clientRequestId`, propose() and respond() are idempotent as sendMessage is (06 §1 rule
//   6, 07 §3.3; M1-32-b): a repeat returns the original result and sends nothing; another request
//   under the same key is IDEMPOTENCY_KEY_REUSED. Every effect transaction (the envelope, the
//   approval request, the policy grant) carries the call's lease.
//
// Errors and log lines carry fixed codes only; nothing from inbound terms or the contact's name goes
// into an error, a log line or a summary beyond the 06 §2.1 name rule (I-5, I-7). No MCP tool can
// widen a policy or approve through this module (I-4).
import {
  canonicalize,
  encodeBase64url,
  encodeUtf8,
  parseJson,
  randomBytes,
} from '@4thtech-io/crypto';
import {
  BYTE_LENGTHS,
  base64url,
  checkSendAccept,
  commitmentApprovalActionSchema,
  commitmentScopeSchema,
  evmAddress,
  newestOpenOffer,
  nextTermsLink,
  termsFromInput,
  termsNoteSchema,
  type ApprovalFee,
  type CommitmentDecision,
  type CommitmentScope,
  type ContactDisplayName,
  type Terms,
} from '@4thtech-io/types';
import type { TopUpRoute } from '@4thtech-io/chain';
import {
  insertCommitmentPartsTx,
  voidPendingScopeTx,
  type ApprovalService,
  type ApprovalState,
  type CommitmentPartRow,
  type PendingApproval,
} from './approvals.js';
import { IDEMPOTENCY_KEY_REUSED } from './constants.js';
import type { IdempotencyRun, IdempotencyService } from './idempotency.js';
import {
  checkCommitmentBinding,
  commitmentParts,
  commitmentVoidedByPolicy,
  evaluateCommitment,
  policyDocumentHash,
  recheckCommitmentGrant,
  type AutoAcceptMiss,
  type CommitmentFacts,
  type CommitmentPart,
} from './commitments.js';
import type { ContactBook, ContactView } from './contacts.js';
import { nowOf, open, seal, type CoreContext } from './context.js';
import type { EnvelopeService } from './envelopes.js';
import { CoreError } from './errors.js';
import type { IdentityService } from './identity.js';
import { agentNostrKey } from './card.js';
import { renderContactName } from './names.js';
import type { OutboxService } from './outbox.js';
import type { CommitmentRecordResult, ProofRejected } from './proofs/service.js';
import { computeActionDigest, verifyStoredOwnerAction } from './owner-action.js';
import type { OwnerActions } from './owner-actions.js';
import { evaluate, type EffectivePolicy } from './policy-engine.js';
import type { Row } from './store/schema.js';
import type { StoreTx } from './store/store.js';
import {
  isLocked,
  loadTermsSnapshot,
  newestOffer,
  offerState,
  snapshotCurrentTx,
  termsHashOf,
  type Negotiation,
  type TermsRecord,
  type TermsSnapshot,
} from './terms-store.js';

export const PROPOSE_TERMS_TOOL = 'agentlink_propose_terms';
export const RESPOND_TO_TERMS_TOOL = 'agentlink_respond_to_terms';

/** A commitment scope lasts at most this long (04 §3.4.2: createdAt + 7 days). */
export const COMMITMENT_SCOPE_SECONDS = 7 * 86_400;

/** The trigger of every commitment approval (06 §3 `commitments.accept`). */
const COMMITMENT_TRIGGER = 'commitments.accept';

/** How often a call is retried when the chain changed between its read and its write. */
const CHAIN_ATTEMPTS = 3;

/** Fixed result codes (06 §2.2a; 04 §3.4.2). */
export type TermsCode =
  | 'INVALID_ARGUMENT'
  | 'USE_RESPOND_TO_TERMS'
  | 'TERMS_SUPERSEDED'
  | 'TERMS_EXPIRED'
  | 'NOT_A_PARTY'
  | 'NOT_RECORDED'
  | 'APPROVAL_USED'
  | 'APPROVAL_VOID'
  | 'POLICY_DENIED'
  /**
   * `notarize` where no Record can be made: no proof platform on this machine, or a `counter` or
   * `reject` with `notarize` (not built; M1-9d-3). Nothing is sent.
   */
  | 'NOTARIZE_UNAVAILABLE'
  /** The proof network could not be asked for a fee (07 §6.3). Nothing is sent or requested. */
  | 'CHAIN_UNAVAILABLE'
  /** This agent's profile expires before a Record could land (07 §8). Nothing is sent. */
  | 'CARD_EXPIRED'
  /** The same clientRequestId with a different request (06 §1 rule 6, 07 §3.3). Nothing runs. */
  | typeof IDEMPOTENCY_KEY_REUSED;

/** The verified on-chain record of an envelope that this agent knows (M1-7g supplies it). */
export interface KnownRecord {
  readonly kind: 'OFFER' | 'ACCEPT';
  /** The record signer's agent ID. */
  readonly signer: string;
}

/** Record lookup (M1-7g, M1b). Without one, no record is known. */
export interface RecordLookup {
  recordOf(envelopeHash: string): Promise<KnownRecord | undefined>;
}

/** A terms Record's fee and what the proofs policy says of it, before the owner is asked. */
export type CommitmentQuote =
  | {
      readonly status: 'ok';
      readonly fee: ApprovalFee;
      /** The proofs policy (06 §3): `approval` joins the commitment's single request. */
      readonly decision: 'allow' | 'approval';
      /** The proof triggers that asked (policy key paths), empty under `allow`. */
      readonly triggers: readonly string[];
    }
  | { readonly status: 'needs_credits'; readonly topUp?: TopUpRoute }
  | ProofRejected;

/** The proof service, for the Record part of a commitment (M1-9d-3; 04 §3.4.2). */
export interface CommitmentRecorder {
  quoteCommitment(input: { readonly counterparty: string }): Promise<CommitmentQuote>;
  recordCommitment(input: {
    readonly envelopeId: string;
    readonly approvalId: string;
    readonly maxFeeUsd: string;
    readonly ownerApproved: boolean;
    readonly claimTx: (tx: StoreTx, recordId: string, itemJson: string) => boolean;
  }): Promise<CommitmentRecordResult>;
  /** Resends the stored Record of a sent envelope unchanged, if one is live; never signs. */
  resendRecord(envelopeId: string): Promise<void>;
}

/** The ProofStatus of a terms result's Record (06 §2.2a `proof`). */
export type TermsProof = CommitmentRecordResult;

/** No funded network for the Record (06 §2.4, D-111): nothing was sent or requested. */
export interface TermsNeedsCredits {
  readonly status: 'needs_credits';
  readonly topUp?: TopUpRoute;
}

export interface ProposeTermsInput {
  /** The contact's agent ID. Resolving a name is the MCP layer's (M1-9q). */
  readonly to: string;
  /** A `TermsInput` (06 §2.2a), checked strictly. */
  readonly terms: unknown;
  readonly revises?: string;
  readonly note?: string;
  readonly notarize?: boolean;
  readonly approvalId?: string;
  /** Repeats with the same value return the original result and send nothing (07 §3.3). */
  readonly clientRequestId?: string;
}

export type RespondDecision = 'accept' | 'reject' | 'counter';

export interface RespondToTermsInput {
  readonly envelopeId: string;
  readonly decision: RespondDecision;
  /** Only with `counter`. */
  readonly terms?: unknown;
  readonly note?: string;
  readonly notarize?: boolean;
  readonly approvalId?: string;
  /** Repeats with the same value return the original result and send nothing (07 §3.3). */
  readonly clientRequestId?: string;
}

/** Another execution holds this clientRequestId: nothing ran; call again shortly (07 §3.3). */
export interface TermsInProgress {
  readonly status: 'in_progress';
}

/**
 * A repeat of a call whose kept result was `pending_approval`, after that approval stopped being
 * pending: its current state, as `agentlink_get_approval` reports it, never the stale result
 * (07 §3.3 "Stale approvals"). To run an approved call, call again with `approvalId`.
 */
export interface TermsApprovalState {
  readonly status: 'approval_state';
  readonly approvalId: string;
  readonly approval: ApprovalState;
}

/** What a receipt part is doing (06 §2.2a). */
export interface ReceiptState {
  readonly type: 'ACCEPTED' | 'REJECTED';
  readonly status: 'recorded' | 'submitted' | 'waiting_for_record';
  /** Unix seconds: the scope's expiresAt. */
  readonly until?: number;
}

export interface TermsRejected {
  readonly status: 'rejected';
  readonly code: TermsCode;
  /** With APPROVAL_USED: the state of the original response (04 §3.4.2). */
  readonly envelopeId?: string;
  readonly receipt?: ReceiptState;
}

/** A change from the newest version this side held before (computed locally; 04 §3.4.2). */
export interface TermsChange {
  readonly field: 'subject' | 'deliverables' | 'price' | 'deadlines' | 'validUntil';
  /** For `deliverables` and `deadlines`: the ids added, removed or changed. */
  readonly added?: readonly string[];
  readonly removed?: readonly string[];
  readonly changed?: readonly string[];
}

/** The commitment card data (11 §6.10, §8): what the approval screen renders, from stored data. */
export interface CommitmentCard {
  readonly decision: CommitmentDecision;
  readonly counterparty: {
    readonly agentId: string;
    readonly display: ContactDisplayName;
    /** renderContactName(display): quoted, with its identity label (06 §2.1). */
    readonly shown: string;
  };
  readonly version: number;
  /** The stored canonical terms the scope binds: the counterparty's content (I-5). */
  readonly terms: Terms;
  /** Null for version 1, or when the previous version is not held. */
  readonly changes: readonly TermsChange[] | null;
  /** What the single approval does. */
  readonly parts: readonly CommitmentPart[];
  /** Why auto-accept did not apply (the auto-accept note), or null. */
  readonly autoAccept: AutoAcceptMiss | null;
  /** "They accepted version N after you sent version M" (04 §3.4.2). */
  readonly lateAccept: {
    readonly acceptedVersion: number;
    readonly newestOwnVersion: number;
  } | null;
  readonly validUntil: number;
  readonly expiresAt: number;
  /** The Record's fee the approval covers (`maxFeeUsd`), or null when nothing is recorded. */
  readonly fee: ApprovalFee | null;
  /** The terms fingerprint, under Advanced (11 §8). */
  readonly fingerprint: string;
}

export interface TermsPending extends PendingApproval {
  readonly card: CommitmentCard;
}

export interface TermsSent {
  readonly status: 'ok';
  readonly envelopeId: string;
  readonly thread: string;
  readonly termsId: string;
  readonly version: number;
  readonly termsHash: string;
  readonly validUntil: number;
  /** A firm offer's Record (M1-9d-3). */
  readonly proof?: TermsProof;
}

/** One run of a propose call: what is kept for its clientRequestId. */
type ProposeOutcome = TermsSent | TermsRejected | TermsPending | TermsNeedsCredits;

export type ProposeTermsResult = ProposeOutcome | TermsInProgress | TermsApprovalState;

export interface TermsResponded {
  readonly status: 'ok';
  readonly decision: RespondDecision;
  readonly thread: string;
  readonly termsId: string;
  readonly version: number;
  readonly termsHash: string;
  readonly envelopeId?: string;
  readonly receipt?: ReceiptState;
  /** A recorded accept's Record (M1-9d-3). */
  readonly proof?: TermsProof;
}

/** One run of a respond call: what is kept for its clientRequestId. */
type RespondOutcome = TermsResponded | TermsRejected | TermsPending | TermsNeedsCredits;

export type RespondToTermsResult = RespondOutcome | TermsInProgress | TermsApprovalState;

/**
 * A received offer that waits for this agent's answer (06 §2.1 `openOffers`, §2.2 `openOffers`;
 * M1-22): the newest open offer of its negotiation, from an active contact, not locked by an accept,
 * not rejected by this agent and not past `validUntil`. IDs and numbers only: the terms stay
 * untrusted content, read through the inbox (I-5).
 */
export interface OpenOffer {
  readonly envelopeId: string;
  /** The contact's agent ID. */
  readonly contactId: string;
  readonly termsId: string;
  readonly version: number;
  /** Unix seconds. */
  readonly validUntil: number;
}

/** One negotiation as the agent may list it (the terms stay untrusted content, I-5). */
export interface NegotiationSummary {
  readonly termsId: string;
  readonly newestVersion: number;
  readonly newestEnvelopeId: string | null;
  readonly lockedVersions: readonly number[];
  readonly items: readonly {
    readonly envelopeId: string;
    readonly direction: 'in' | 'out';
    readonly type: 'offer' | 'accept' | 'reject';
    readonly version: number;
    readonly state: 'open' | 'conflict' | 'answer';
    /** An accept of one of this agent's own versions after it sent a newer one (04 §3.4.2). */
    readonly lateAccept: boolean;
  }[];
}

/** The deferred-receipt lookup for M1-7g (07 §2.1 step 4). */
export type DeferredReceipt =
  | { readonly status: 'none' }
  | { readonly status: 'void'; readonly approvalId: string; readonly code: TermsCode }
  | { readonly status: 'ready'; readonly approvalId: string; readonly scope: CommitmentScope };

export interface TermsDeps {
  readonly identity: IdentityService;
  readonly contacts: ContactBook;
  readonly envelopes: EnvelopeService;
  readonly outbox: OutboxService;
  readonly ownerActions: OwnerActions;
  readonly approvals: ApprovalService;
  readonly records?: RecordLookup;
  /** Records for `notarize` (M1-9d-3). Without it, `notarize` is NOTARIZE_UNAVAILABLE. */
  readonly recorder?: CommitmentRecorder;
  /** `clientRequestId` idempotency (07 §3.3). Without it a call with a clientRequestId fails closed. */
  readonly idempotency?: IdempotencyService;
}

const rejected = (code: TermsCode, extra: Partial<TermsRejected> = {}): TermsRejected => ({
  status: 'rejected',
  code,
  ...extra,
});

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isEnvelopeId = (v: unknown): v is string => base64url(BYTE_LENGTHS.id).safeParse(v).success;

/** An approval ID among a run's effects (IR-M1-32-b-1 I03: exact, never a prefix match). */
const APPROVAL_EFFECT = /^apr_[A-Za-z0-9_-]{22}$/;

/** A kept terms result (07 §3.3): only these are ever stored for a clientRequestId. */
const isKeptResult = (v: unknown): boolean =>
  isObject(v) && (v.status === 'ok' || v.status === 'rejected' || v.status === 'pending_approval');

/** The optional `clientRequestId` and `approvalId` are strings when present. */
const keyFieldsValid = (input: Record<string, unknown>): boolean =>
  (input.clientRequestId === undefined || typeof input.clientRequestId === 'string') &&
  (input.approvalId === undefined || typeof input.approvalId === 'string');

/** The parts of a decision as stored rows (07 §3.5): the envelope, the record, the receipt. */
function partRows(parts: readonly CommitmentPart[]): CommitmentPartRow[] {
  return parts.map((p) =>
    p.endsWith('_envelope') ? 'envelope' : p.endsWith('_record') ? 'record' : 'receipt',
  );
}

/** A note: absent (null), or canonical terms text of 1–500 code points (D-74). */
function readNote(note: unknown): { ok: true; note: string | null } | { ok: false } {
  if (note === undefined) return { ok: true, note: null };
  const r = termsNoteSchema.safeParse(note);
  return r.success && r.data !== null ? { ok: true, note: r.data } : { ok: false };
}

/** Field changes between two versions (computed locally, never from the counterparty's pointer). */
export function termsChanges(previous: Terms, next: Terms): TermsChange[] {
  const changes: TermsChange[] = [];
  const same = (a: unknown, b: unknown) => canonicalize(a as never) === canonicalize(b as never);
  if (previous.subject !== next.subject) changes.push({ field: 'subject' });
  const byId = <T extends { id?: string; ref?: string }>(list: readonly T[]) =>
    new Map(list.map((x) => [x.id ?? x.ref ?? '', x]));
  for (const field of ['deliverables', 'deadlines'] as const) {
    const a = byId(previous[field] as readonly { id?: string; ref?: string }[]);
    const b = byId(next[field] as readonly { id?: string; ref?: string }[]);
    const added = [...b.keys()].filter((k) => !a.has(k));
    const removed = [...a.keys()].filter((k) => !b.has(k));
    const changed = [...b.keys()].filter((k) => a.has(k) && !same(a.get(k), b.get(k)));
    if (added.length + removed.length + changed.length > 0) {
      changes.push({ field, added, removed, changed });
    }
  }
  if (!same(previous.price, next.price)) changes.push({ field: 'price' });
  if (previous.validUntil !== next.validUntil) changes.push({ field: 'validUntil' });
  return changes;
}

/** Whether this agent sent a newer offer version than `version` in the negotiation (late accept). */
function newestOwnAbove(n: Negotiation | undefined, self: string, version: number): number | null {
  let newest: number | null = null;
  for (const o of n?.state.offers ?? []) {
    if (o.sender === self && o.version > version && (newest === null || o.version > newest)) {
      newest = o.version;
    }
  }
  return newest;
}

/**
 * Void rule 1 (04 §3.4.2) for the offer `envelopeId` at `version`: it is not open (a conflicted
 * envelope of its version), it is not the newest open offer, or an offer with a higher version is
 * stored in any state (IR-M1-32-1 F01: a conflict on n + 1 never revives a scope on n). A conflict
 * on its own version supersedes only the conflicted envelopes: the anchored resend that follows
 * it (D-74 item 2) is open and stays acceptable (IR-M1-32-1 D1-F01).
 */
function supersededInStore(
  n: Negotiation | undefined,
  envelopeId: string,
  version: number,
): boolean {
  const offers = n?.state.offers ?? [];
  return (
    offerState(n, envelopeId) !== 'open' ||
    newestOpenOffer(offers)?.envelopeId !== envelopeId ||
    offers.some((o) => o.version > version)
  );
}

/** A stored commitment: the approval row, its parsed action, scope and terms. */
interface StoredCommitment {
  readonly row: Row<'approvals'>;
  readonly tool: typeof PROPOSE_TERMS_TOOL | typeof RESPOND_TO_TERMS_TOOL;
  readonly action: Record<string, unknown>;
  readonly scope: CommitmentScope;
  readonly terms: Terms;
  readonly fee: ApprovalFee | null;
  readonly args: {
    envelopeId?: string;
    decision?: string;
    notarize?: boolean;
    to?: string;
    terms?: unknown;
    revises?: string;
  };
}

/** A quote mapped to what the terms call returns when it does not run (nothing sent). */
function quoteRefusal(
  quote: Exclude<CommitmentQuote, { status: 'ok' }>,
): TermsRejected | TermsNeedsCredits {
  if (quote.status === 'needs_credits') {
    return quote.topUp === undefined
      ? { status: 'needs_credits' }
      : { status: 'needs_credits', topUp: quote.topUp };
  }
  switch (quote.code) {
    case 'POLICY_DENIED':
      return rejected('POLICY_DENIED');
    case 'CARD_EXPIRED':
      return rejected('CARD_EXPIRED');
    case 'PROOFS_UNAVAILABLE':
      return rejected('NOTARIZE_UNAVAILABLE');
    default:
      return rejected('CHAIN_UNAVAILABLE');
  }
}

/** The approval's triggers (sorted, unique): the commitment rule and any proof rule that asked. */
function triggersOf(commitmentAsked: boolean, proofTriggers: readonly string[]): string[] {
  const all = new Set<string>(proofTriggers);
  if (commitmentAsked || all.size === 0) all.add(COMMITMENT_TRIGGER);
  return [...all].sort();
}

/** The call a scope answers: what must match the stored action (04 §3.4.2). */
interface CommitCall {
  readonly envelopeId: string;
  readonly decision: RespondDecision;
  readonly notarize: boolean;
  /** The call's idempotency execution: every effect transaction carries its lease (07 §3.3). */
  readonly run?: IdempotencyRun | undefined;
}

/** A commitment about to be scoped: the answered record and what the decision needs. */
interface CommitPlan {
  readonly call: CommitCall;
  readonly decision: CommitmentDecision;
  readonly contact: ContactView;
  readonly answered: TermsRecord;
  /** The stored terms the scope binds (for `confirm`, the terms of their accept). */
  readonly terms: Terms;
  readonly termsHash: string;
  readonly validUntil: number;
  readonly superseded: boolean;
  /** The parts this scope covers (an accept that already ran leaves only the receipt). */
  readonly parts: readonly CommitmentPart[];
  readonly snapshot: TermsSnapshot;
  /** The Record's fee when the scope covers a Record part (M1-9d-3), else null. */
  readonly fee: ApprovalFee | null;
  /** The proof triggers that asked for the owner (06 §3), joined to this request. */
  readonly proofTriggers: readonly string[];
}

export class TermsService {
  readonly #ctx: CoreContext;
  readonly #deps: TermsDeps;

  constructor(ctx: CoreContext, deps: TermsDeps) {
    this.#ctx = ctx;
    this.#deps = deps;
  }

  // --- helpers -------------------------------------------------------------------------------------

  async #self(): Promise<{ readonly agentId: string; readonly ownerNostr: string }> {
    const view = await this.#deps.identity.get();
    if (view === undefined) {
      throw new CoreError('identity_missing', 'This agent has no identity yet. Run init first.');
    }
    if (view.revoked) throw new CoreError('identity_revoked', 'This agent has been revoked.');
    return { agentId: view.agentId, ownerNostr: view.card.ownerNostr };
  }

  async #activeContact(id: string): Promise<ContactView> {
    const contact = await this.#deps.contacts.get(id);
    if (contact.status !== 'active' || contact.pairing !== 'complete') {
      throw new CoreError('contact_not_active', 'That contact cannot receive messages now.');
    }
    return contact;
  }

  #idempotency(): IdempotencyService {
    const service = this.#deps.idempotency;
    if (service === undefined) {
      throw new CoreError('idempotency_unavailable', 'Repeat protection is not available.');
    }
    return service;
  }

  /**
   * `clientRequestId` idempotency for the terms tools (06 §1 rule 6, 07 §3.3; IR-M1-9q-1 F-2), as
   * for `sendMessage`: the row decides replay (the identical result, nothing runs or is
   * published), IDEMPOTENCY_KEY_REUSED (another request under the key: nothing runs, nothing of the
   * original is returned), in progress, a stale pending approval (its current state), resume (a
   * takeover finishes from the stored effects, never runs blindly), or run. Every effect
   * transaction of the run carries the lease (#sendEnvelope, #insertGrant, approvals.request). A run
   * that throws before any effect deletes its row, so a retry runs once the cause is fixed.
   */
  async #idempotent<R extends ProposeOutcome | RespondOutcome>(
    tool: string,
    input: { readonly clientRequestId?: unknown; readonly approvalId?: unknown },
    args: Record<string, unknown>,
    run: (run: IdempotencyRun | undefined) => Promise<R>,
    resume: (run: IdempotencyRun) => Promise<R>,
  ): Promise<R | TermsRejected | TermsInProgress | TermsApprovalState> {
    const clientRequestId = input.clientRequestId;
    if (clientRequestId === undefined) return run(undefined);
    const idempotency = this.#idempotency();
    const start = await idempotency.begin({
      tool,
      clientRequestId: clientRequestId as string,
      ...(typeof input.approvalId === 'string' ? { approvalId: input.approvalId } : {}),
      args,
    });
    switch (start.kind) {
      case 'replay':
        if (!isKeptResult(start.result)) {
          throw new CoreError('store_unreadable', 'A stored value could not be read.');
        }
        return start.result as R;
      case 'key_reused':
        return rejected(IDEMPOTENCY_KEY_REUSED);
      case 'in_progress':
        return { status: 'in_progress' };
      case 'stale_approval':
        return {
          status: 'approval_state',
          approvalId: start.approvalId,
          approval: await this.#deps.approvals.read(start.approvalId),
        };
      case 'resume': {
        const done = await resume(start.run);
        await idempotency.finish(start.run, done);
        return done;
      }
      case 'run': {
        let done: R;
        try {
          done = await run(start.run);
        } catch (error) {
          if (start.run.effects.length === 0) {
            await idempotency.finish(start.run, null, { keep: false }).catch(() => false);
          }
          throw error;
        }
        // `needs_credits` sent and asked nothing: not kept, so the call runs after a top-up.
        await idempotency.finish(
          start.run,
          done,
          done.status === 'needs_credits' ? { keep: false } : {},
        );
        return done;
      }
    }
  }

  async #policy(): Promise<EffectivePolicy> {
    return this.#deps.ownerActions.loadPolicy();
  }

  async #sendAllowed(to: string, sizeBytes: number): Promise<boolean> {
    return (
      evaluate(await this.#policy(), { kind: 'envelope.send', contact: to, sizeBytes }) === 'allow'
    );
  }

  /**
   * Signs, stores and publishes one terms envelope. `claimTx` (a commitment part) and the chain check
   * run in the storing transaction; `stale` means the chain changed and nothing was written.
   */
  async #sendEnvelope(input: {
    readonly to: string;
    readonly payload: Record<string, unknown>;
    readonly thread?: string;
    readonly snapshot: TermsSnapshot;
    readonly claimTx?: (tx: StoreTx, envelopeId: string, envelopeJson: string) => boolean;
    readonly run?: IdempotencyRun | undefined;
  }): Promise<
    | { readonly kind: 'sent'; readonly envelopeId: string; readonly thread: string }
    | { readonly kind: 'stale' | 'denied' | 'lost' }
  > {
    const { envelopes, outbox } = this.#deps;
    outbox.requireTransport();
    if (!(await this.#sendAllowed(input.to, 0))) return { kind: 'denied' };
    const { built, row } = await envelopes.prepare({
      to: { contact: input.to },
      payload: input.payload,
      ...(input.thread === undefined ? {} : { thread: input.thread }),
    });
    const json = row.envelope_json ?? '';
    if (!(await this.#sendAllowed(input.to, encodeUtf8(json).length))) return { kind: 'denied' };
    const routes = await outbox.routes(await outbox.contactPeer(input.to));
    const keys = routes.map((r) => r.recipient);
    if (
      keys.length !== built.recipientNostrKeys.length ||
      !built.recipientNostrKeys.every((k) => keys.includes(k))
    ) {
      throw new CoreError('contact_not_active', 'That contact cannot receive messages now.');
    }
    const rows = await outbox.prepareRows(built.envelope, routes);
    const envelopeId = built.envelope.id;
    const run = input.run;
    const effect =
      run === undefined ? undefined : await this.#idempotency().prepareEffect(run, [envelopeId]);
    const outcome = await this.#ctx.store.transaction((tx) => {
      if (!snapshotCurrentTx(tx, input.snapshot)) return 'stale' as const;
      const contact = tx.get('contacts', { contact_id: input.to });
      if (contact?.status !== 'active' || contact.pairing !== 'complete') {
        throw new CoreError('contact_not_active', 'That contact cannot receive messages now.');
      }
      if (input.claimTx !== undefined && !input.claimTx(tx, envelopeId, json)) {
        return 'lost' as const;
      }
      // The call's lease, in the transaction that stores the envelope (07 §3.3 "Effects"): if
      // another execution owns the call, the whole transaction aborts and nothing is stored.
      if (run !== undefined && !this.#idempotency().effectTx(tx, run, effect!)) {
        throw new CoreError('idempotency_lost', 'This request is already being handled.');
      }
      tx.insert('envelopes', row);
      for (const r of rows) tx.insert('outbox', r);
      return 'stored' as const;
    });
    if (outcome !== 'stored') return { kind: outcome };
    if (run !== undefined) this.#idempotency().committed(run, effect!);
    this.#ctx.log.info('terms envelope stored for sending', { wraps: rows.length });
    await this.#publish(envelopeId);
    return { kind: 'sent', envelopeId, thread: built.thread };
  }

  async #publish(envelopeId: string): Promise<void> {
    try {
      await this.#deps.outbox.publishEnvelope(envelopeId);
    } catch {
      this.#ctx.log.warn('first publish failed; the outbox retries', { envelopes: 1 });
    }
  }

  // --- propose -------------------------------------------------------------------------------------

  /**
   * `agentlink_propose_terms` (06 §2.2a): sends an `offer`. Without `revises` it starts a negotiation
   * (version 1); with it, the new version replaces the caller's own newest unanswered offer.
   */
  async propose(input: ProposeTermsInput): Promise<ProposeTermsResult> {
    if (!isObject(input) || !evmAddress.safeParse(input.to).success || !isObject(input.terms)) {
      return rejected('INVALID_ARGUMENT');
    }
    if (input.revises !== undefined && !isEnvelopeId(input.revises)) {
      return rejected('INVALID_ARGUMENT');
    }
    if (input.notarize !== undefined && typeof input.notarize !== 'boolean') {
      return rejected('INVALID_ARGUMENT');
    }
    // A recorded offer carries only the terms (06 §2.2a).
    if (input.notarize === true && input.note !== undefined) return rejected('INVALID_ARGUMENT');
    const note = readNote(input.note);
    if (!note.ok) return rejected('INVALID_ARGUMENT');
    if (!keyFieldsValid(input as unknown as Record<string, unknown>)) {
      return rejected('INVALID_ARGUMENT');
    }
    const notarize = input.notarize === true;
    if (notarize && this.#deps.recorder === undefined) return rejected('NOTARIZE_UNAVAILABLE');
    // `args` as for `action.args` (04 §3.4.1): defaults applied, without approvalId and
    // clientRequestId. The terms are the caller's TermsInput as given.
    const args = {
      to: input.to,
      terms: input.terms,
      revises: input.revises ?? null,
      note: note.note,
      notarize,
    };
    return this.#idempotent(
      PROPOSE_TERMS_TOOL,
      input,
      args,
      (run) => (notarize ? this.#proposeFirm(input, run) : this.#proposeRun(input, note.note, run)),
      (run) => (notarize ? this.#resumeFirm(input, run) : this.#resumeOffer(run)),
    );
  }

  async #proposeRun(
    input: ProposeTermsInput,
    note: string | null,
    run: IdempotencyRun | undefined,
  ): Promise<ProposeOutcome> {
    const to = input.to;
    for (let attempt = 0; attempt < CHAIN_ATTEMPTS; attempt += 1) {
      await this.#deps.identity.assertCanSend();
      const self = (await this.#self()).agentId;
      if (to === self) return rejected('INVALID_ARGUMENT');
      await this.#activeContact(to);
      const snapshot = await loadTermsSnapshot(this.#ctx, self, to);
      const now = nowOf(this.#ctx);
      let termsId: string;
      let link: { version: number; previousTermsHash: string | null; replyTo: string | null };
      let thread: string | undefined;
      if (input.revises === undefined) {
        termsId = encodeBase64url(randomBytes(BYTE_LENGTHS.termsId));
        link = { version: 1, previousTermsHash: null, replyTo: null };
      } else {
        const entry = snapshot.byEnvelope.get(input.revises);
        const n = entry === undefined ? undefined : snapshot.negotiations.get(entry.key);
        const own = entry?.record;
        const answered =
          own !== undefined &&
          (n?.records ?? []).some(
            (r) => r.direction === 'in' && r.type !== 'offer' && r.replyTo === own.envelopeId,
          );
        if (
          own === undefined ||
          n === undefined ||
          own.direction !== 'out' ||
          own.type !== 'offer' ||
          newestOffer(n)?.envelopeId !== own.envelopeId ||
          isLocked(n, own.terms.version) ||
          answered
        ) {
          return rejected('USE_RESPOND_TO_TERMS');
        }
        termsId = n.termsId;
        link = nextTermsLink(n.state, self);
        thread = own.thread;
      }
      const terms = termsFromInput(input.terms, {
        termsId,
        version: link.version,
        previousTermsHash: link.previousTermsHash,
        self,
        counterparty: to,
        now,
      });
      if (!terms.success) return rejected('INVALID_ARGUMENT');
      const sent = await this.#sendOffer(to, terms.data, note, link.replyTo, thread, snapshot, run);
      if (sent !== 'stale') return sent;
    }
    return rejected('TERMS_SUPERSEDED');
  }

  /**
   * A takeover of a propose call that already stored its offer (07 §3.3 "Resume"): the result from
   * the stored offer, and its pending rows published; never a second offer.
   */
  async #resumeOffer(run: IdempotencyRun): Promise<TermsSent> {
    const { record } = await this.#storedEffect(run);
    if (record.type !== 'offer') {
      throw new CoreError('store_unreadable', 'A stored value could not be read.');
    }
    await this.#publish(record.envelopeId);
    return {
      status: 'ok',
      envelopeId: record.envelopeId,
      thread: record.thread,
      termsId: record.terms.termsId,
      version: record.terms.version,
      termsHash: record.termsHash,
      validUntil: record.terms.validUntil,
    };
  }

  /** The envelope a run stored (its last envelope effect), read back through the chain. */
  async #storedEffect(run: IdempotencyRun): Promise<{ readonly record: TermsRecord }> {
    const unreadable = () => new CoreError('store_unreadable', 'A stored value could not be read.');
    const envelopeId = [...run.effects].reverse().find((e) => isEnvelopeId(e));
    if (envelopeId === undefined) throw unreadable();
    const row = await this.#ctx.store.transaction((tx) =>
      tx.get('envelopes', { envelope_id: envelopeId }),
    );
    if (row === undefined || row.direction !== 'out' || row.contact_id === null) {
      throw unreadable();
    }
    const self = (await this.#self()).agentId;
    const snapshot = await loadTermsSnapshot(this.#ctx, self, row.contact_id);
    const record = snapshot.byEnvelope.get(envelopeId)?.record;
    if (record === undefined || record.direction !== 'out') throw unreadable();
    return { record };
  }

  async #sendOffer(
    to: string,
    terms: Terms,
    note: string | null,
    replyTo: string | null,
    thread: string | undefined,
    snapshot: TermsSnapshot,
    run: IdempotencyRun | undefined,
  ): Promise<TermsSent | TermsRejected | 'stale'> {
    const hash = termsHashOf(terms);
    const sent = await this.#sendEnvelope({
      to,
      payload: {
        type: 'offer',
        body: { terms, termsHash: hash, note },
        replyTo,
        files: [],
      },
      ...(thread === undefined ? {} : { thread }),
      snapshot,
      run,
    });
    if (sent.kind === 'stale') return 'stale';
    if (sent.kind !== 'sent') return rejected('POLICY_DENIED');
    return {
      status: 'ok',
      envelopeId: sent.envelopeId,
      thread: sent.thread,
      termsId: terms.termsId,
      version: terms.version,
      termsHash: hash,
      validUntil: terms.validUntil,
    };
  }

  // --- respond -------------------------------------------------------------------------------------

  /**
   * `agentlink_respond_to_terms` (06 §2.2a). `envelopeId` is (a) the contact's newest `offer` in
   * its negotiation, or (b) the contact's `accept` of one of this agent's own offers that has not
   * expired. `accept` is a commitment under one scope (04 §3.4.2).
   */
  async respond(input: RespondToTermsInput): Promise<RespondToTermsResult> {
    if (!isObject(input) || !isEnvelopeId(input.envelopeId)) return rejected('INVALID_ARGUMENT');
    const decision = input.decision;
    if (decision !== 'accept' && decision !== 'reject' && decision !== 'counter') {
      return rejected('INVALID_ARGUMENT');
    }
    if (input.notarize !== undefined && typeof input.notarize !== 'boolean') {
      return rejected('INVALID_ARGUMENT');
    }
    const notarize = input.notarize === true;
    // The agent never supplies the terms of an answer; a counter needs them (06 §2.2a).
    if ((decision === 'counter') !== (input.terms !== undefined)) {
      return rejected('INVALID_ARGUMENT');
    }
    // `note` only with reject and an unrecorded counter (IR-D55-1 F03).
    if (input.note !== undefined && (decision === 'accept' || notarize)) {
      return rejected('INVALID_ARGUMENT');
    }
    const note = readNote(input.note);
    if (!note.ok) return rejected('INVALID_ARGUMENT');
    if (!keyFieldsValid(input as unknown as Record<string, unknown>)) {
      return rejected('INVALID_ARGUMENT');
    }
    // A recorded accept (M1-9d-3); a recorded counter or reject is not built (nothing sent).
    if (notarize && (decision !== 'accept' || this.#deps.recorder === undefined)) {
      return rejected('NOTARIZE_UNAVAILABLE');
    }
    // `args` as for `action.args` (04 §3.4.1): defaults applied, without approvalId and
    // clientRequestId (the approvalId is part of the key instead).
    const args = {
      envelopeId: input.envelopeId,
      decision,
      terms: input.terms ?? null,
      note: note.note,
      notarize,
    };
    return this.#idempotent(
      RESPOND_TO_TERMS_TOOL,
      input,
      args,
      async (run) => {
        for (let attempt = 0; attempt < CHAIN_ATTEMPTS; attempt += 1) {
          const result = await this.#respondOnce(input, decision, note.note, run);
          if (result !== 'stale') return result;
        }
        return rejected('TERMS_SUPERSEDED');
      },
      (run) => this.#resumeResponse(input, decision, run),
    );
  }

  /**
   * A takeover of a respond call with stored effects (07 §3.3 "Resume"): never runs it blindly.
   * A commitment (an approval among the effects, or a call with `approvalId`) continues through its
   * scope, whose parts run at most once and are only ever republished; a sent `reject` or counter
   * is reported from the stored envelope and its pending rows are published.
   */
  async #resumeResponse(
    input: RespondToTermsInput,
    decision: RespondDecision,
    run: IdempotencyRun,
  ): Promise<RespondOutcome> {
    const self = (await this.#self()).agentId;
    const call: CommitCall = {
      envelopeId: input.envelopeId,
      decision,
      notarize: input.notarize === true,
      run,
    };
    const approvalId =
      [...run.effects].reverse().find((e) => APPROVAL_EFFECT.test(e) && !isEnvelopeId(e)) ??
      (decision === 'accept' ? input.approvalId : undefined);
    if (approvalId !== undefined) {
      const r = await this.#runScope(approvalId, call, self);
      // This call's own accept already went out: report it as this call's result.
      if (r.status === 'rejected' && r.code === 'APPROVAL_USED' && r.envelopeId !== undefined) {
        const stored = await this.#stored(approvalId);
        if (stored !== undefined) {
          return {
            status: 'ok',
            decision,
            thread: stored.scope.thread,
            termsId: stored.scope.termsId,
            version: stored.scope.version,
            termsHash: stored.scope.termsHash,
            envelopeId: r.envelopeId,
            ...(r.receipt === undefined ? {} : { receipt: r.receipt }),
          };
        }
      }
      return r;
    }
    const { record } = await this.#storedEffect(run);
    await this.#publish(record.envelopeId);
    return {
      status: 'ok',
      decision,
      thread: record.thread,
      termsId: record.terms.termsId,
      version: record.terms.version,
      termsHash: record.termsHash,
      envelopeId: record.envelopeId,
    };
  }

  async #respondOnce(
    input: RespondToTermsInput,
    decision: RespondDecision,
    note: string | null,
    run: IdempotencyRun | undefined,
  ): Promise<RespondOutcome | 'stale'> {
    const self = (await this.#self()).agentId;
    const call: CommitCall = {
      envelopeId: input.envelopeId,
      decision,
      notarize: input.notarize === true,
      ...(run === undefined ? {} : { run }),
    };
    if (input.approvalId !== undefined && decision === 'accept') {
      const used = await this.#runApproved(input.approvalId, call, self);
      if (used !== 'fresh') return used;
    }
    const row = await this.#ctx.store.transaction((tx) =>
      tx.get('envelopes', { envelope_id: input.envelopeId }),
    );
    if (
      row === undefined ||
      row.direction !== 'in' ||
      row.state !== 'ok' ||
      row.contact_id === null
    ) {
      return rejected('INVALID_ARGUMENT');
    }
    const contactId = row.contact_id;
    const contact = await this.#activeContact(contactId);
    const snapshot = await loadTermsSnapshot(this.#ctx, self, contactId);
    const entry = snapshot.byEnvelope.get(input.envelopeId);
    if (entry === undefined) return rejected('INVALID_ARGUMENT');
    const rec = entry.record;
    const n = snapshot.negotiations.get(entry.key);
    if (!rec.terms.parties.includes(self)) return rejected('NOT_A_PARTY');
    const now = nowOf(this.#ctx);

    // Path (b): their accept of one of our own offers.
    if (rec.type === 'accept') {
      const own = rec.replyTo === null ? undefined : snapshot.byEnvelope.get(rec.replyTo)?.record;
      if (own === undefined || own.direction !== 'out' || own.type !== 'offer') {
        return rejected('INVALID_ARGUMENT');
      }
      if (decision === 'counter') return rejected('INVALID_ARGUMENT');
      if (now > own.terms.validUntil) return rejected('TERMS_EXPIRED');
      if (decision === 'reject') {
        // 06 §2.2a path (b): replyTo names our own offer, whose terms it carries (IR-D-74-1 F04).
        return this.#sendAnswer('reject', own, note, snapshot, contactId, run);
      }
      // `confirm`: ACCEPTED on their ACCEPT record. No message.
      const record = await this.#deps.records?.recordOf(rec.envelopeHash);
      if (record === undefined || record.kind !== 'ACCEPT' || record.signer !== contactId) {
        return rejected('NOT_RECORDED');
      }
      return this.#commit({
        call,
        decision: 'confirm',
        contact,
        answered: rec,
        terms: rec.terms,
        termsHash: rec.termsHash,
        validUntil: own.terms.validUntil,
        superseded: newestOwnAbove(n, self, rec.terms.version) !== null,
        parts: commitmentParts({ decision: 'confirm', notarize: false }),
        snapshot,
        fee: null,
        proofTriggers: [],
      });
    }
    if (rec.type !== 'offer' || rec.direction !== 'in') return rejected('INVALID_ARGUMENT');

    // Path (a): their offer.
    if (decision === 'counter') {
      if (newestOffer(n)?.envelopeId !== rec.envelopeId || isLocked(n, rec.terms.version)) {
        return rejected('TERMS_SUPERSEDED');
      }
      const link = nextTermsLink(n!.state, self);
      const terms = termsFromInput(input.terms, {
        termsId: rec.terms.termsId,
        version: link.version,
        previousTermsHash: link.previousTermsHash,
        self,
        counterparty: contactId,
        now,
      });
      if (!terms.success) return rejected('INVALID_ARGUMENT');
      const sent = await this.#sendOffer(
        contactId,
        terms.data,
        note,
        link.replyTo,
        rec.thread,
        snapshot,
        run,
      );
      if (sent === 'stale') return 'stale';
      if (sent.status !== 'ok') return sent;
      return {
        status: 'ok',
        decision,
        thread: sent.thread,
        termsId: sent.termsId,
        version: sent.version,
        termsHash: sent.termsHash,
        envelopeId: sent.envelopeId,
      };
    }
    if (decision === 'reject') {
      if (offerState(n, rec.envelopeId) !== 'open' || isLocked(n, rec.terms.version)) {
        return rejected('TERMS_SUPERSEDED');
      }
      if (newestOffer(n)?.envelopeId !== rec.envelopeId) return rejected('TERMS_SUPERSEDED');
      if (now > rec.terms.validUntil) return rejected('TERMS_EXPIRED');
      return this.#sendAnswer('reject', rec, note, snapshot, contactId, run);
    }

    // accept on (a): a commitment. After our accept for it ran, a new scope covers the receipt only.
    const acceptRan = (n?.records ?? []).some(
      (r) => r.direction === 'out' && r.type === 'accept' && r.replyTo === rec.envelopeId,
    );
    if (!acceptRan) {
      const check = checkSendAccept(n!.state, rec.envelopeId, self, now);
      if (check.result === 'refuse') {
        switch (check.reason) {
          case 'expired':
            return rejected('TERMS_EXPIRED');
          case 'superseded':
          case 'conflicted':
          case 'locked':
            return rejected('TERMS_SUPERSEDED');
          default:
            return rejected('INVALID_ARGUMENT');
        }
      }
      if (supersededInStore(n, rec.envelopeId, rec.terms.version)) {
        return rejected('TERMS_SUPERSEDED');
      }
    } else if (now > rec.terms.validUntil) {
      return rejected('TERMS_EXPIRED');
    }
    // With `notarize`, the accept's Record runs only if the offer has no record (04 §3.4.2), and
    // only once: an accept already sent and recorded needs none (M1-9d-3).
    // Once the accept has run, a later scope covers only the receipt (04 §3.4.2): never a Record
    // of an accept sent under an earlier scope.
    const record =
      call.notarize && !acceptRan && !(await this.#offerRecorded(rec.envelopeHash, contactId));
    let fee: ApprovalFee | null = null;
    let proofTriggers: readonly string[] = [];
    if (record) {
      const quote = await this.#deps.recorder!.quoteCommitment({ counterparty: contactId });
      if (quote.status !== 'ok') return quoteRefusal(quote);
      fee = quote.fee;
      proofTriggers = quote.triggers;
    }
    const parts = commitmentParts({ decision: 'accept', notarize: call.notarize }).filter(
      (p) => (p !== 'accept_envelope' || !acceptRan) && (p !== 'accept_record' || record),
    );
    return this.#commit({
      call,
      decision: 'accept',
      contact,
      answered: rec,
      terms: rec.terms,
      termsHash: rec.termsHash,
      validUntil: rec.terms.validUntil,
      superseded: false,
      parts,
      snapshot,
      fee,
      proofTriggers,
    });
  }

  /** A `reject` (free): the stored terms of `offer`, `replyTo` = that offer. */
  async #sendAnswer(
    type: 'reject',
    offer: TermsRecord,
    note: string | null,
    snapshot: TermsSnapshot,
    contactId: string,
    run: IdempotencyRun | undefined,
  ): Promise<RespondOutcome | 'stale'> {
    const sent = await this.#sendEnvelope({
      to: contactId,
      payload: {
        type,
        body: { terms: offer.terms, termsHash: offer.termsHash, note },
        replyTo: offer.envelopeId,
        files: [],
      },
      thread: offer.thread,
      snapshot,
      run,
    });
    if (sent.kind === 'stale') return 'stale';
    if (sent.kind !== 'sent') return rejected('POLICY_DENIED');
    return {
      status: 'ok',
      decision: 'reject',
      thread: sent.thread,
      termsId: offer.terms.termsId,
      version: offer.terms.version,
      termsHash: offer.termsHash,
      envelopeId: sent.envelopeId,
    };
  }

  // --- commitments ---------------------------------------------------------------------------------

  /** The scope (04 §3.4.2), fixed now from stored data only. Undefined when it would not start. */
  #scopeOf(plan: CommitPlan, self: string, now: number): CommitmentScope | undefined {
    const scope = commitmentScopeSchema.safeParse({
      v: 1,
      kind: 'agentlink/commitment',
      agentId: self,
      decision: plan.decision,
      counterparty: {
        agentId: plan.contact.id,
        ownerKey: plan.contact.card.ownerNostr.slice(2),
      },
      thread: plan.answered.thread,
      termsId: plan.terms.termsId,
      version: plan.terms.version,
      termsHash: plan.termsHash,
      answers: { envelopeId: plan.answered.envelopeId, envelopeHash: plan.answered.envelopeHash },
      notarize: plan.call.notarize,
      maxFeeUsd: plan.fee?.usd ?? null,
      createdAt: now,
      expiresAt: Math.min(plan.validUntil, now + COMMITMENT_SCOPE_SECONDS),
    });
    return scope.success ? scope.data : undefined;
  }

  #actionOf(
    plan: CommitPlan,
    scope: CommitmentScope,
    commitmentAsked: boolean,
  ): Record<string, unknown> {
    return {
      tool: RESPOND_TO_TERMS_TOOL,
      args: {
        envelopeId: plan.call.envelopeId,
        decision: plan.call.decision,
        notarize: plan.call.notarize,
      },
      context: {
        triggers: triggersOf(commitmentAsked, plan.proofTriggers),
        scope,
        terms: plan.terms,
        fee: plan.fee,
      },
    };
  }

  #summaryOf(plan: CommitPlan): string {
    const who = renderContactName(plan.contact.display);
    const v = plan.terms.version;
    return plan.decision === 'confirm'
      ? `Confirm that ${who} accepted version ${v} of your terms`
      : `Accept version ${v} of the terms from ${who}`;
  }

  /** A new scope for `plan`: void, deny, a policy grant that runs now, or one pending request. */
  async #commit(plan: CommitPlan): Promise<RespondOutcome | 'stale'> {
    const self = (await this.#self()).agentId;
    const now = nowOf(this.#ctx);
    const scope = this.#scopeOf(plan, self, now);
    if (scope === undefined) return rejected('TERMS_EXPIRED');
    const facts: CommitmentFacts = {
      kind: 'terms',
      self,
      scope,
      terms: plan.terms,
      supersededByOwnNewer: plan.superseded,
    };
    const policy = await this.#policy();
    const evaluation = evaluateCommitment(policy, facts);
    if (evaluation.decision === 'void') return rejected('APPROVAL_VOID');
    // A denial creates nothing: no request, no grant, no envelope (06 §3).
    if (evaluation.decision === 'deny') return rejected('POLICY_DENIED');
    // A proof rule that asks joins the same single request (04 §3.4.2 "One request per call").
    const ask = evaluation.decision === 'approval' || plan.proofTriggers.length > 0;
    const action = this.#actionOf(plan, scope, evaluation.decision === 'approval');
    const scopeKey = plan.answered.envelopeId;
    const parts = partRows(plan.parts);
    if (ask) {
      const pending = await this.#deps.approvals.request(
        {
          action,
          summary: this.#summaryOf(plan),
          answersEnvelopeId: plan.answered.envelopeId,
          commitment: { scopeKey, parts },
        },
        plan.call.run === undefined ? {} : { run: plan.call.run },
      );
      const card = this.#card(
        plan,
        scope,
        evaluation.decision === 'approval' ? evaluation.autoAccept : null,
      );
      return { ...pending, card };
    }
    // allow: a policy grant with the same scope (04 §3.4.2), then its parts run now.
    const approvalId = await this.#insertGrant(
      action,
      scope,
      scopeKey,
      parts,
      evaluation.grant.policyHash,
      this.#summaryOf(plan),
      plan.call.run,
    );
    return this.#runScope(approvalId, plan.call, self);
  }

  async #insertGrant(
    action: Record<string, unknown>,
    scope: CommitmentScope,
    scopeKey: string,
    parts: readonly CommitmentPartRow[],
    policyHash: string,
    summary: string,
    run: IdempotencyRun | undefined,
  ): Promise<string> {
    const ctx = this.#ctx;
    const now = nowOf(ctx);
    const approvalId = `apr_${encodeBase64url(randomBytes(16))}`;
    const key = [approvalId];
    const sealedAction = await seal(ctx, 'approvals', 'action_json', key, canonicalize(action));
    const sealedSummary = await seal(ctx, 'approvals', 'summary', key, summary);
    const sealedHash = await seal(ctx, 'approvals', 'policy_hash', key, policyHash);
    const effect =
      run === undefined ? undefined : await this.#idempotency().prepareEffect(run, [approvalId]);
    await ctx.store.transaction((tx) => {
      // The call's lease, in the transaction that stores the grant (07 §3.3 "Effects").
      if (run !== undefined && !this.#idempotency().effectTx(tx, run, effect!)) {
        throw new CoreError('idempotency_lost', 'This request is already being handled.');
      }
      voidPendingScopeTx(tx, scopeKey, now);
      tx.insert('approvals', {
        approval_id: approvalId,
        action_json: sealedAction,
        scope_json: canonicalize(scope),
        answers_envelope_id: scope.answers?.envelopeId ?? null,
        scope_key: scopeKey,
        source: 'policy_grant',
        policy_hash: sealedHash,
        signed_decision: null,
        signed_cancel: null,
        summary: sealedSummary,
        status: 'approved',
        expires_at: scope.expiresAt,
        created_at: now,
        decided_at: now,
      });
      insertCommitmentPartsTx(tx, approvalId, parts, now);
    });
    if (run !== undefined) this.#idempotency().committed(run, effect!);
    return approvalId;
  }

  /** Reads a stored commitment; undefined for anything that is not a well-formed one. */
  async #stored(approvalId: string): Promise<StoredCommitment | undefined> {
    if (typeof approvalId !== 'string' || !/^apr_[A-Za-z0-9_-]{22}$/.test(approvalId)) {
      return undefined;
    }
    const row = await this.#ctx.store.transaction((tx) =>
      tx.get('approvals', { approval_id: approvalId }),
    );
    if (row === undefined || row.scope_json === null) return undefined;
    let action: unknown;
    try {
      action = parseJson(
        await open(this.#ctx, 'approvals', 'action_json', [approvalId], row.action_json),
      );
    } catch {
      return undefined;
    }
    const parsed = commitmentApprovalActionSchema.safeParse(action);
    if (!parsed.success) return undefined;
    const context = parsed.data.context;
    // The scope column is a copy of the action's scope; one that differs is a tampered row.
    if (canonicalize(context.scope as never) !== row.scope_json) return undefined;
    return {
      row,
      tool: parsed.data.tool,
      action: action as Record<string, unknown>,
      scope: context.scope,
      terms: context.terms,
      fee: context.fee,
      args: parsed.data.args as StoredCommitment['args'],
    };
  }

  /**
   * The authority behind a stored commitment, re-verified now (04 §3.4.2): the owner's
   * `approval.decide` over the digest recomputed from the stored action (never a batch, never the
   * status column), or for a grant the rule re-run on the verified policy (recheckCommitmentGrant).
   */
  async #authority(
    stored: StoredCommitment,
    self: { agentId: string; ownerNostr: string },
    policy: EffectivePolicy,
    facts: CommitmentFacts,
  ): Promise<'ok' | 'pending' | 'ask_owner' | TermsCode> {
    const { row } = stored;
    const now = nowOf(this.#ctx);
    if (row.signed_cancel !== null) return 'APPROVAL_VOID';
    if (row.status === 'void' || row.status === 'cancelled' || row.status === 'denied') {
      return 'APPROVAL_VOID';
    }
    if (row.source === 'policy_grant') {
      if (row.policy_hash === null || row.signed_decision !== null) return 'APPROVAL_VOID';
      let hash: string;
      try {
        hash = await open(
          this.#ctx,
          'approvals',
          'policy_hash',
          [row.approval_id],
          row.policy_hash,
        );
      } catch {
        return 'APPROVAL_VOID';
      }
      const e = evaluateCommitment(policy, facts);
      const basis = e.decision === 'allow' ? e.grant.basis : 'rule';
      const r = recheckCommitmentGrant(policy, facts, { basis, policyHash: hash });
      if (r.status === 'allow') return 'ok';
      if (r.status === 'ask_owner') return 'ask_owner';
      return 'APPROVAL_VOID';
    }
    if (row.signed_decision === null) {
      return now > row.expires_at ? 'APPROVAL_VOID' : 'pending';
    }
    const decided = verifyStoredOwnerAction(row.signed_decision, {
      agent: self.agentId,
      ownerNostr: self.ownerNostr,
    });
    if (!decided.ok || decided.signed.body.op !== 'approval.decide') return 'APPROVAL_VOID';
    const params = decided.signed.body.params;
    if (
      params.approvalId !== row.approval_id ||
      params.decision !== 'approve' ||
      params.actionDigest !== computeActionDigest(stored.action)
    ) {
      return 'APPROVAL_VOID';
    }
    // Void rule 4: `commitments.accept` is now deny.
    if (commitmentVoidedByPolicy(policy)) return 'APPROVAL_VOID';
    return 'ok';
  }

  /** Void rules 1, 2, 3 and 5 against the store now (04 §3.4.2). Undefined when none applies. */
  async #voidRule(
    stored: StoredCommitment,
    self: string,
    envelopeUnrun: boolean,
  ): Promise<{ code: TermsCode; reason: 'expired' | 'superseded' | 'void' } | undefined> {
    const { scope } = stored;
    const now = nowOf(this.#ctx);
    if (now > scope.expiresAt) return { code: 'TERMS_EXPIRED', reason: 'expired' };
    const voided = { code: 'APPROVAL_VOID' as const, reason: 'void' as const };
    // Rule 3: the contact (status, owner key, card) and both agents.
    let contact: ContactView;
    try {
      contact = await this.#deps.contacts.get(scope.counterparty.agentId);
    } catch {
      return voided;
    }
    if (
      contact.status !== 'active' ||
      contact.pairing !== 'complete' ||
      contact.card.ownerNostr.slice(2) !== scope.counterparty.ownerKey ||
      contact.card.issuedAt > scope.createdAt
    ) {
      return voided;
    }
    // The card itself (IR-M1-32-1 F03): a card-update raises keyEpoch and so changes the agent key
    // (04 §3.4.1). The answered envelope's signing key is the card the scope was built on; any
    // later card, whatever its `issuedAt`, signs with another key.
    const answeredRow =
      scope.answers === null
        ? undefined
        : await this.#ctx.store.transaction((tx) =>
            tx.get('envelopes', { envelope_id: scope.answers!.envelopeId }),
          );
    if (answeredRow === undefined || answeredRow.from_key !== agentNostrKey(contact.card)) {
      return voided;
    }
    // Rule 2: the stored answered envelope still binds the scope.
    let snapshot: TermsSnapshot;
    try {
      snapshot = await loadTermsSnapshot(this.#ctx, self, contact.id);
    } catch {
      return voided;
    }
    const answers = scope.answers;
    if (answers === null) return voided;
    const entry = snapshot.byEnvelope.get(answers.envelopeId);
    if (
      entry === undefined ||
      entry.record.direction !== 'in' ||
      entry.record.envelopeHash !== answers.envelopeHash ||
      entry.record.termsHash !== scope.termsHash ||
      !checkCommitmentBinding(self, scope, entry.record.terms).ok ||
      termsHashOf(stored.terms) !== scope.termsHash
    ) {
      return voided;
    }
    // Rule 1: before the envelope is sent, a newer version (in any state, from either side) or a
    // conflict on this one is in the store (IR-M1-32-1 F01: a conflict on n + 1 makes this version
    // the newest open one again, but never revives a scope on it).
    if (
      envelopeUnrun &&
      supersededInStore(snapshot.negotiations.get(entry.key), answers.envelopeId, scope.version)
    ) {
      return { code: 'TERMS_SUPERSEDED', reason: 'superseded' };
    }
    return undefined;
  }

  async #voidParts(approvalId: string, reason: 'expired' | 'superseded' | 'void'): Promise<void> {
    const now = nowOf(this.#ctx);
    await this.#ctx.store.transaction((tx) => {
      tx.update(
        'commitment_parts',
        { approval_id: approvalId, state: { in: ['unclaimed', 'claimed'] } },
        { state: 'void', void_reason: reason, updated_at: now },
      );
    });
  }

  /**
   * A call with `approvalId` (04 §3.4.2). A call that asks for another action is not covered: it
   * gets a new request (`fresh`), and this approval stays as it is.
   */
  async #runApproved(
    approvalId: string,
    call: CommitCall,
    self: string,
  ): Promise<RespondOutcome | 'fresh'> {
    const stored = await this.#stored(approvalId);
    if (stored === undefined) return rejected('APPROVAL_VOID');
    if (stored.scope.agentId !== self) return rejected('APPROVAL_VOID');
    const a = stored.args;
    if (
      stored.tool !== RESPOND_TO_TERMS_TOOL ||
      a.envelopeId !== call.envelopeId ||
      a.decision !== call.decision ||
      a.notarize !== call.notarize
    ) {
      return 'fresh';
    }
    return this.#runScope(approvalId, call, self);
  }

  /** Runs the parts of a stored scope that have not run, each at most once. */
  async #runScope(approvalId: string, call: CommitCall, selfId: string): Promise<RespondOutcome> {
    for (let attempt = 0; attempt < CHAIN_ATTEMPTS; attempt += 1) {
      const r = await this.#runScopeOnce(approvalId, call, selfId);
      if (r !== 'stale') return r;
    }
    return rejected('TERMS_SUPERSEDED');
  }

  async #runScopeOnce(
    approvalId: string,
    call: CommitCall,
    selfId: string,
  ): Promise<RespondOutcome | 'stale'> {
    const stored = await this.#stored(approvalId);
    if (stored === undefined) return rejected('APPROVAL_VOID');
    const self = await this.#self();
    if (self.agentId !== selfId || stored.scope.agentId !== selfId)
      return rejected('APPROVAL_VOID');
    const { scope } = stored;
    // A firm offer runs only through propose (#runOfferScope).
    if (scope.decision === 'offer' || stored.tool !== RESPOND_TO_TERMS_TOOL) {
      return rejected('APPROVAL_VOID');
    }
    const parts = await this.#ctx.store.transaction((tx) =>
      tx.select('commitment_parts', { approval_id: approvalId }),
    );
    const envelopePart = parts.find((p) => p.part === 'envelope');
    const receiptPart = parts.find((p) => p.part === 'receipt');
    const recordPart = parts.find((p) => p.part === 'record');
    // The Record part (M1-9d-3) that has not run: still unclaimed (no credits then, say). A claimed
    // one has run: a repeat resends its stored item unchanged and is APPROVAL_USED (04 §3.4.2).
    const recordOpen = recordPart?.state === 'unclaimed';
    const receipt = (): ReceiptState | undefined =>
      receiptPart === undefined || receiptPart.state === 'void'
        ? undefined
        : {
            type: scope.decision === 'reject' ? 'REJECTED' : 'ACCEPTED',
            status: receiptPart.state === 'done' ? 'recorded' : 'waiting_for_record',
            until: scope.expiresAt,
          };
    const ok = (envelopeId?: string, proof?: TermsProof): RespondOutcome => {
      const rc = receipt();
      return {
        status: 'ok',
        decision: call.decision,
        thread: scope.thread,
        termsId: scope.termsId,
        version: scope.version,
        termsHash: scope.termsHash,
        ...(envelopeId === undefined ? {} : { envelopeId }),
        ...(rc === undefined ? {} : { receipt: rc }),
        ...(proof === undefined ? {} : { proof }),
      };
    };
    // The state of the original response, for a call that did not claim the part (04 §3.4.2).
    const used = (envelopeId: string | null | undefined): RespondOutcome => {
      const rc = receipt();
      return rejected('APPROVAL_USED', {
        ...(envelopeId === null || envelopeId === undefined ? {} : { envelopeId }),
        ...(rc === undefined ? {} : { receipt: rc }),
      });
    };
    // A Record already claimed (signed, perhaps not on-chain yet): resent unchanged, never signed
    // again, and the approval is used (04 §3.4.2, §5).
    if (recordPart?.state === 'claimed') {
      if (envelopePart?.item_ref != null)
        await this.#deps.recorder?.resendRecord(envelopePart.item_ref);
      return used(envelopePart?.item_ref);
    }
    // Already sent: a repeat call never sends or signs a part twice (04 §3.4.2). A Record part
    // that has not run yet (no credits then, say) still runs, under the checks below.
    if (envelopePart?.state === 'done' && !recordOpen) return used(envelopePart.item_ref);
    // Claimed by an earlier or a concurrent call, its delivery not yet confirmed: only the call
    // whose claim committed reports `ok` (a takeover of that same request is resumed from its
    // stored effects). This call republishes the same signed envelope, never a new one, and reports
    // the approval as used (04 §3.4.2; 07 §2.1).
    if (envelopePart?.state === 'claimed' && envelopePart.item_ref !== null) {
      const id = envelopePart.item_ref;
      await this.#publish(id);
      await this.#markEnvelopeDone(approvalId, id);
      if (!recordOpen) return used(id);
    }
    const policy = await this.#policy();
    const facts: CommitmentFacts = {
      kind: 'terms',
      self: selfId,
      scope,
      terms: stored.terms,
      supersededByOwnNewer: false,
    };
    const authority = await this.#authority(stored, self, policy, facts);
    if (authority === 'pending') {
      // Not decided yet: the same request stands (06 §2.5).
      const card = await this.commitmentCard(approvalId);
      let summary: string;
      try {
        summary = await open(this.#ctx, 'approvals', 'summary', [approvalId], stored.row.summary);
      } catch {
        return rejected('APPROVAL_VOID');
      }
      if (card === undefined) return rejected('APPROVAL_VOID');
      return {
        status: 'pending_approval',
        approvalId,
        actionDigest: computeActionDigest(stored.action),
        summary,
        expiresAt: stored.row.expires_at,
        card,
      };
    }
    if (authority === 'ask_owner') {
      // The policy no longer allows this grant: nothing runs on it (06 §3; 04 §3.4.2).
      await this.#voidParts(approvalId, 'void');
      return rejected('APPROVAL_VOID');
    }
    if (authority !== 'ok') {
      await this.#voidParts(approvalId, 'void');
      return rejected(authority);
    }
    const envelopeUnrun = envelopePart?.state === 'unclaimed';
    const voidRule = await this.#voidRule(stored, selfId, envelopeUnrun);
    if (voidRule !== undefined) {
      await this.#voidParts(approvalId, voidRule.reason);
      return rejected(voidRule.code);
    }
    // The accept already went out under this scope: only its Record part is left (M1-9d-3).
    if (envelopePart !== undefined && envelopePart.state !== 'unclaimed' && recordOpen) {
      const id = envelopePart.item_ref;
      if (envelopePart.state === 'void' || id === null) {
        return rejected(envelopePart.void_reason === 'expired' ? 'TERMS_EXPIRED' : 'APPROVAL_VOID');
      }
      const proof = await this.#recordPart(approvalId, stored, id);
      return proof === 'lost' ? used(id) : ok(id, proof);
    }
    if (envelopePart === undefined) {
      // A receipt-only scope: nothing is sent. The first call with the approval reports the
      // receipt state; a repeat call is APPROVAL_USED with that state (04 §3.4.2; IR-M1-32-1 F06).
      // The first call is recorded by moving the receipt part's updated_at past the row's
      // created_at (parts are created at created_at); any claim or void changes its state instead.
      const createdAt = stored.row.created_at;
      if (receiptPart?.state === 'unclaimed' && receiptPart.updated_at > createdAt) {
        const rc = receipt();
        return rejected('APPROVAL_USED', rc === undefined ? {} : { receipt: rc });
      }
      const first = await this.#ctx.store.transaction(
        (tx) =>
          tx.update(
            'commitment_parts',
            {
              approval_id: approvalId,
              part: 'receipt',
              state: 'unclaimed',
              updated_at: { lte: createdAt },
            },
            { updated_at: Math.max(nowOf(this.#ctx), createdAt + 1) },
          ) === 1,
      );
      if (!first) {
        const rc = receipt();
        return rejected('APPROVAL_USED', rc === undefined ? {} : { receipt: rc });
      }
      return ok();
    }
    if (envelopePart.state === 'void') {
      return rejected(envelopePart.void_reason === 'expired' ? 'TERMS_EXPIRED' : 'APPROVAL_VOID');
    }

    // The envelope part: claim and store the signed `accept` in one transaction, then publish.
    const answers = scope.answers!;
    const contactId = scope.counterparty.agentId;
    const snapshot = await loadTermsSnapshot(this.#ctx, selfId, contactId);
    const offer = snapshot.byEnvelope.get(answers.envelopeId)?.record;
    if (offer === undefined) return rejected('APPROVAL_VOID');
    const now = nowOf(this.#ctx);
    const scopeKey = stored.row.scope_key;
    const sent = await this.#sendEnvelope({
      to: contactId,
      payload: {
        type: 'accept',
        body: { terms: offer.terms, termsHash: offer.termsHash, note: null },
        replyTo: offer.envelopeId,
        files: [],
      },
      thread: offer.thread,
      snapshot,
      run: call.run,
      claimTx: (tx, envelopeId, json) => {
        // Another scope for the same answered envelope already claimed its envelope part (F06).
        if (scopeKey !== null) {
          for (const other of tx.select('approvals', { scope_key: scopeKey })) {
            if (other.approval_id === approvalId) continue;
            const used = tx.count('commitment_parts', {
              approval_id: other.approval_id,
              part: 'envelope',
              state: { in: ['claimed', 'done'] },
            });
            if (used > 0) return false;
          }
        }
        return (
          tx.update(
            'commitment_parts',
            { approval_id: approvalId, part: 'envelope', state: 'unclaimed' },
            {
              state: 'claimed',
              item_ref: envelopeId,
              item_json: json,
              claimed_at: now,
              updated_at: now,
            },
          ) === 1
        );
      },
    });
    if (sent.kind === 'stale') return 'stale';
    if (sent.kind === 'denied') return rejected('POLICY_DENIED');
    if (sent.kind !== 'sent') {
      // A concurrent retry claimed it, or another scope already sent the accept: run nothing new.
      // The claim belongs to the other call, which reports `ok`; this one reports the approval as
      // used (04 §3.4.2).
      const now2 = await this.#ctx.store.transaction((tx) =>
        tx.get('commitment_parts', { approval_id: approvalId, part: 'envelope' }),
      );
      if (now2?.state === 'claimed' && now2.item_ref !== null) {
        await this.#publish(now2.item_ref);
        await this.#markEnvelopeDone(approvalId, now2.item_ref);
      }
      return used(now2?.item_ref);
    }
    await this.#markEnvelopeDone(approvalId, sent.envelopeId);
    if (recordPart === undefined) return ok(sent.envelopeId);
    const proof = await this.#recordPart(approvalId, stored, sent.envelopeId);
    return ok(sent.envelopeId, proof === 'lost' ? undefined : proof);
  }

  /** `claimed` → `done` once the stored envelope is `sent` (07 §3.5). */
  async #markEnvelopeDone(approvalId: string, envelopeId: string): Promise<void> {
    const now = nowOf(this.#ctx);
    await this.#ctx.store.transaction((tx) => {
      const env = tx.get('envelopes', { envelope_id: envelopeId });
      if (env?.delivery !== 'sent') return;
      tx.update(
        'commitment_parts',
        { approval_id: approvalId, part: 'envelope', state: 'claimed', item_ref: envelopeId },
        { state: 'done', done_at: now, updated_at: now },
      );
    });
  }

  // --- Records under a commitment (M1-9d-3; 04 §3.4.2; 06 §2.2a) -------------------------------

  /** Whether the contact's OFFER record of this envelope is known (verified, M1-7g). */
  async #offerRecorded(envelopeHash: string, contactId: string): Promise<boolean> {
    const known = await this.#deps.records?.recordOf(envelopeHash);
    return known?.kind === 'OFFER' && known.signer === contactId;
  }

  /**
   * The Record part of a scope, for the envelope its envelope part sent (04 §3.4.2): at most once.
   * The proof service claims the part in the transaction that stores the signed Record and
   * reserves its fee, never above the scope's `maxFeeUsd`. An accept's Record is left out (the part
   * void, nothing charged) when the offer has a record by now. `lost`: a concurrent call claimed it.
   */
  async #recordPart(
    approvalId: string,
    stored: StoredCommitment,
    envelopeId: string,
  ): Promise<TermsProof | 'lost' | undefined> {
    const { scope } = stored;
    const recorder = this.#deps.recorder;
    const voidRecord = async () =>
      this.#ctx.store.transaction((tx) => {
        tx.update(
          'commitment_parts',
          { approval_id: approvalId, part: 'record', state: 'unclaimed' },
          { state: 'void', void_reason: 'void', updated_at: nowOf(this.#ctx) },
        );
      });
    if (
      scope.decision === 'accept' &&
      scope.answers !== null &&
      (await this.#offerRecorded(scope.answers.envelopeHash, scope.counterparty.agentId))
    ) {
      await voidRecord();
      return undefined;
    }
    if (recorder === undefined || scope.maxFeeUsd === null) {
      await voidRecord();
      return undefined;
    }
    const now = nowOf(this.#ctx);
    const result = await recorder.recordCommitment({
      envelopeId,
      approvalId,
      maxFeeUsd: scope.maxFeeUsd,
      ownerApproved: stored.row.source === 'owner',
      claimTx: (tx, recordId, itemJson) =>
        tx.update(
          'commitment_parts',
          { approval_id: approvalId, part: 'record', state: 'unclaimed' },
          {
            state: 'claimed',
            item_ref: recordId,
            item_json: itemJson,
            claimed_at: now,
            updated_at: now,
          },
        ) === 1,
    });
    if (result.status === 'rejected' && result.code === 'POLICY_CHANGED') {
      const part = await this.#ctx.store.transaction((tx) =>
        tx.get('commitment_parts', { approval_id: approvalId, part: 'record' }),
      );
      if (part?.state === 'claimed' || part?.state === 'done') return 'lost';
    }
    if (result.status === 'ok') {
      const done = nowOf(this.#ctx);
      await this.#ctx.store.transaction((tx) => {
        tx.update(
          'commitment_parts',
          { approval_id: approvalId, part: 'record', state: 'claimed', item_ref: result.recordId },
          { state: 'done', done_at: done, updated_at: done },
        );
      });
    }
    this.#ctx.log.info('terms record', { status: result.status });
    return result;
  }

  /** The negotiation with `termsId` in a snapshot (one per termsId and pair). */
  #negotiationOf(snapshot: TermsSnapshot, termsId: string): Negotiation | undefined {
    for (const n of snapshot.negotiations.values()) if (n.termsId === termsId) return n;
    return undefined;
  }

  /** The thread a new negotiation with this contact goes in, as for an unrecorded offer. */
  async #threadWith(contactId: string): Promise<string> {
    const existing = await this.#ctx.store.transaction(
      (tx) =>
        tx.select(
          'envelopes',
          { contact_id: contactId, state: 'ok' },
          {
            orderBy: [
              ['created_at', 'desc'],
              ['envelope_id', 'asc'],
            ],
            limit: 1,
          },
        )[0]?.thread_id,
    );
    return existing ?? encodeBase64url(randomBytes(BYTE_LENGTHS.thread));
  }

  /**
   * Whether `revises` (or none, for version 1) still names the slot a firm offer was built for: the
   * caller's own newest unanswered, unlocked offer (as #proposeRun checks), with the same next link.
   */
  #offerSlot(
    snapshot: TermsSnapshot,
    self: string,
    terms: Terms,
  ): { readonly replyTo: string | null } | undefined {
    const n = this.#negotiationOf(snapshot, terms.termsId);
    if (terms.version === 1) {
      return n === undefined ? { replyTo: null } : undefined;
    }
    if (n === undefined) return undefined;
    const own = newestOffer(n);
    const answered =
      own !== undefined &&
      n.records.some(
        (r) => r.direction === 'in' && r.type !== 'offer' && r.replyTo === own.envelopeId,
      );
    if (
      own === undefined ||
      own.direction !== 'out' ||
      own.type !== 'offer' ||
      isLocked(n, own.terms.version) ||
      answered
    ) {
      return undefined;
    }
    const link = nextTermsLink(n.state, self);
    if (link.version !== terms.version || link.previousTermsHash !== terms.previousTermsHash) {
      return undefined;
    }
    return { replyTo: link.replyTo };
  }

  /**
   * `agentlink_propose_terms` with `notarize`: a firm offer (04 §3.4.2 scope `offer`). The terms
   * are built from the store now and bound to one scope with the Record's fee; nothing is sent
   * until the owner approves (or a `commitments.accept: allow` grant runs it at once). The call
   * with the `approvalId` and the same arguments runs it from the STORED terms; other arguments get
   * a new request.
   */
  async #proposeFirm(
    input: ProposeTermsInput,
    run: IdempotencyRun | undefined,
  ): Promise<ProposeOutcome> {
    const self = await this.#self();
    if (input.approvalId !== undefined) {
      const stored = await this.#stored(input.approvalId);
      if (stored === undefined || stored.scope.agentId !== self.agentId) {
        return rejected('APPROVAL_VOID');
      }
      const a = stored.args;
      if (
        stored.tool === PROPOSE_TERMS_TOOL &&
        a.to === input.to &&
        a.revises === input.revises &&
        canonicalize(a.terms as never) === canonicalize(input.terms as never)
      ) {
        return this.#runOfferScope(input.approvalId, run, self.agentId);
      }
    }
    const to = input.to;
    for (let attempt = 0; attempt < CHAIN_ATTEMPTS; attempt += 1) {
      await this.#deps.identity.assertCanSend();
      if (to === self.agentId) return rejected('INVALID_ARGUMENT');
      const contact = await this.#activeContact(to);
      const snapshot = await loadTermsSnapshot(this.#ctx, self.agentId, to);
      const now = nowOf(this.#ctx);
      let termsId: string;
      let link: { version: number; previousTermsHash: string | null };
      let thread: string;
      if (input.revises === undefined) {
        termsId = encodeBase64url(randomBytes(BYTE_LENGTHS.termsId));
        link = { version: 1, previousTermsHash: null };
        thread = await this.#threadWith(to);
      } else {
        const entry = snapshot.byEnvelope.get(input.revises);
        const n = entry === undefined ? undefined : snapshot.negotiations.get(entry.key);
        const own = entry?.record;
        if (own === undefined || n === undefined || newestOffer(n)?.envelopeId !== own.envelopeId) {
          return rejected('USE_RESPOND_TO_TERMS');
        }
        termsId = n.termsId;
        link = nextTermsLink(n.state, self.agentId);
        thread = own.thread;
      }
      const built = termsFromInput(input.terms, {
        termsId,
        version: link.version,
        previousTermsHash: link.previousTermsHash,
        self: self.agentId,
        counterparty: to,
        now,
      });
      if (!built.success) return rejected('INVALID_ARGUMENT');
      const terms = built.data;
      // The same slot rules as an unrecorded revision (USE_RESPOND_TO_TERMS otherwise).
      if (this.#offerSlot(snapshot, self.agentId, terms) === undefined) {
        return input.revises === undefined
          ? rejected('TERMS_SUPERSEDED')
          : rejected('USE_RESPOND_TO_TERMS');
      }
      // The fee first: no credits means nothing is sent and the owner is not asked (D-111).
      const quote = await this.#deps.recorder!.quoteCommitment({ counterparty: to });
      if (quote.status !== 'ok') return quoteRefusal(quote);
      const termsHash = termsHashOf(terms);
      const scope = commitmentScopeSchema.safeParse({
        v: 1,
        kind: 'agentlink/commitment',
        agentId: self.agentId,
        decision: 'offer',
        counterparty: { agentId: contact.id, ownerKey: contact.card.ownerNostr.slice(2) },
        thread,
        termsId: terms.termsId,
        version: terms.version,
        termsHash,
        answers: null,
        notarize: true,
        maxFeeUsd: quote.fee.usd,
        createdAt: now,
        expiresAt: Math.min(terms.validUntil, now + COMMITMENT_SCOPE_SECONDS),
      });
      if (!scope.success) return rejected('TERMS_EXPIRED');
      const facts: CommitmentFacts = {
        kind: 'terms',
        self: self.agentId,
        scope: scope.data,
        terms,
        supersededByOwnNewer: false,
      };
      const evaluation = evaluateCommitment(await this.#policy(), facts);
      if (evaluation.decision === 'void') return rejected('APPROVAL_VOID');
      if (evaluation.decision === 'deny') return rejected('POLICY_DENIED');
      const commitmentAsked = evaluation.decision === 'approval';
      const action = {
        tool: PROPOSE_TERMS_TOOL,
        args: {
          to,
          terms: input.terms,
          ...(input.revises === undefined ? {} : { revises: input.revises }),
          notarize: true,
        },
        context: {
          triggers: triggersOf(commitmentAsked, quote.triggers),
          scope: scope.data,
          terms,
          fee: quote.fee,
        },
      };
      // One live scope per firm offer: this agent, the negotiation key and the version (04 §3.4.2).
      const scopeKey = `offer:${to}:${terms.termsId}:${String(terms.version)}`;
      const parts = partRows(['offer_envelope', 'offer_record']);
      const who = renderContactName(contact.display);
      const summary = `Send version ${String(terms.version)} of your terms to ${who} as a firm offer with proof`;
      if (commitmentAsked || quote.triggers.length > 0) {
        const pending = await this.#deps.approvals.request(
          { action, summary, commitment: { scopeKey, parts } },
          run === undefined ? {} : { run },
        );
        const card = this.#offerCard(
          contact,
          scope.data,
          terms,
          snapshot,
          commitmentAsked ? evaluation.autoAccept : null,
          quote.fee,
        );
        return { ...pending, card };
      }
      if (evaluation.decision !== 'allow') return rejected('APPROVAL_VOID');
      const approvalId = await this.#insertGrant(
        action,
        scope.data,
        scopeKey,
        parts,
        evaluation.grant.policyHash,
        summary,
        run,
      );
      const r = await this.#runOfferScope(approvalId, run, self.agentId);
      if (r.status !== 'rejected' || r.code !== 'TERMS_SUPERSEDED') return r;
    }
    return rejected('TERMS_SUPERSEDED');
  }

  /**
   * A takeover of a firm-offer call with stored effects (07 §3.3 "Resume"): through its scope,
   * whose parts run at most once; never a second offer.
   */
  async #resumeFirm(input: ProposeTermsInput, run: IdempotencyRun): Promise<ProposeOutcome> {
    const self = (await this.#self()).agentId;
    const approvalId =
      [...run.effects].reverse().find((e) => APPROVAL_EFFECT.test(e) && !isEnvelopeId(e)) ??
      input.approvalId;
    if (approvalId === undefined) return this.#resumeOffer(run);
    const r = await this.#runOfferScope(approvalId, run, self);
    if (r.status === 'rejected' && r.code === 'APPROVAL_USED' && r.envelopeId !== undefined) {
      return this.#resumeOffer(run).catch(() => r);
    }
    return r;
  }

  /** Runs the parts of a stored firm offer that have not run, each at most once. */
  async #runOfferScope(
    approvalId: string,
    run: IdempotencyRun | undefined,
    selfId: string,
  ): Promise<ProposeOutcome> {
    for (let attempt = 0; attempt < CHAIN_ATTEMPTS; attempt += 1) {
      const r = await this.#runOfferScopeOnce(approvalId, run, selfId);
      if (r !== 'stale') return r;
    }
    return rejected('TERMS_SUPERSEDED');
  }

  async #runOfferScopeOnce(
    approvalId: string,
    run: IdempotencyRun | undefined,
    selfId: string,
  ): Promise<ProposeOutcome | 'stale'> {
    const stored = await this.#stored(approvalId);
    if (stored === undefined || stored.tool !== PROPOSE_TERMS_TOOL) {
      return rejected('APPROVAL_VOID');
    }
    const self = await this.#self();
    const { scope, terms } = stored;
    if (self.agentId !== selfId || scope.agentId !== selfId || scope.decision !== 'offer') {
      return rejected('APPROVAL_VOID');
    }
    const parts = await this.#ctx.store.transaction((tx) =>
      tx.select('commitment_parts', { approval_id: approvalId }),
    );
    const envelopePart = parts.find((p) => p.part === 'envelope');
    const recordPart = parts.find((p) => p.part === 'record');
    if (envelopePart === undefined || recordPart === undefined) return rejected('APPROVAL_VOID');
    // Only an unclaimed Record part still runs; a claimed one has run (04 §3.4.2).
    const recordOpen = recordPart.state === 'unclaimed';
    const sent = (envelopeId: string, proof?: TermsProof): TermsSent => ({
      status: 'ok',
      envelopeId,
      thread: scope.thread,
      termsId: scope.termsId,
      version: scope.version,
      termsHash: scope.termsHash,
      validUntil: terms.validUntil,
      ...(proof === undefined ? {} : { proof }),
    });
    const used = (envelopeId: string | null | undefined): TermsRejected =>
      rejected(
        'APPROVAL_USED',
        envelopeId === null || envelopeId === undefined ? {} : { envelopeId },
      );
    // A Record already claimed: resent unchanged, never signed again; the approval is used.
    if (recordPart.state === 'claimed') {
      if (envelopePart.item_ref !== null) {
        await this.#deps.recorder?.resendRecord(envelopePart.item_ref);
      }
      return used(envelopePart.item_ref);
    }
    // Already sent and recorded (or the Record is void): never a part twice (04 §3.4.2).
    if (envelopePart.state === 'done' && !recordOpen) return used(envelopePart.item_ref);
    if (envelopePart.state === 'claimed' && envelopePart.item_ref !== null) {
      await this.#publish(envelopePart.item_ref);
      await this.#markEnvelopeDone(approvalId, envelopePart.item_ref);
      if (!recordOpen) return used(envelopePart.item_ref);
    }
    const facts: CommitmentFacts = {
      kind: 'terms',
      self: selfId,
      scope,
      terms,
      supersededByOwnNewer: false,
    };
    const authority = await this.#authority(stored, self, await this.#policy(), facts);
    if (authority === 'pending') {
      const card = await this.commitmentCard(approvalId);
      let summary: string;
      try {
        summary = await open(this.#ctx, 'approvals', 'summary', [approvalId], stored.row.summary);
      } catch {
        return rejected('APPROVAL_VOID');
      }
      if (card === undefined) return rejected('APPROVAL_VOID');
      return {
        status: 'pending_approval',
        approvalId,
        actionDigest: computeActionDigest(stored.action),
        summary,
        expiresAt: stored.row.expires_at,
        card,
      };
    }
    if (authority !== 'ok') {
      await this.#voidParts(approvalId, 'void');
      return rejected(authority === 'ask_owner' ? 'APPROVAL_VOID' : authority);
    }
    const envelopeUnrun = envelopePart.state === 'unclaimed';
    const voidRule = await this.#offerVoidRule(stored, selfId);
    if (voidRule !== undefined) {
      await this.#voidParts(approvalId, voidRule.reason);
      return rejected(voidRule.code);
    }
    if (envelopePart.state === 'void') {
      return rejected(envelopePart.void_reason === 'expired' ? 'TERMS_EXPIRED' : 'APPROVAL_VOID');
    }
    let envelopeId: string;
    if (envelopeUnrun) {
      const snapshot = await loadTermsSnapshot(this.#ctx, selfId, scope.counterparty.agentId);
      // Void rule 1 (04 §3.4.2): before the offer is sent, its slot must still be the same.
      const slot = this.#offerSlot(snapshot, selfId, terms);
      if (slot === undefined) {
        await this.#voidParts(approvalId, 'superseded');
        return rejected('TERMS_SUPERSEDED');
      }
      const now = nowOf(this.#ctx);
      const scopeKey = stored.row.scope_key;
      const out = await this.#sendEnvelope({
        to: scope.counterparty.agentId,
        payload: {
          type: 'offer',
          body: { terms, termsHash: scope.termsHash, note: null },
          replyTo: slot.replyTo,
          files: [],
        },
        thread: scope.thread,
        snapshot,
        run,
        claimTx: (tx, id, json) => {
          if (scopeKey !== null) {
            for (const other of tx.select('approvals', { scope_key: scopeKey })) {
              if (other.approval_id === approvalId) continue;
              const taken = tx.count('commitment_parts', {
                approval_id: other.approval_id,
                part: 'envelope',
                state: { in: ['claimed', 'done'] },
              });
              if (taken > 0) return false;
            }
          }
          return (
            tx.update(
              'commitment_parts',
              { approval_id: approvalId, part: 'envelope', state: 'unclaimed' },
              { state: 'claimed', item_ref: id, item_json: json, claimed_at: now, updated_at: now },
            ) === 1
          );
        },
      });
      if (out.kind === 'stale') return 'stale';
      if (out.kind === 'denied') return rejected('POLICY_DENIED');
      if (out.kind !== 'sent') {
        const now2 = await this.#ctx.store.transaction((tx) =>
          tx.get('commitment_parts', { approval_id: approvalId, part: 'envelope' }),
        );
        if (now2?.state === 'claimed' && now2.item_ref !== null) {
          await this.#publish(now2.item_ref);
          await this.#markEnvelopeDone(approvalId, now2.item_ref);
        }
        return used(now2?.item_ref);
      }
      await this.#markEnvelopeDone(approvalId, out.envelopeId);
      envelopeId = out.envelopeId;
    } else {
      if (envelopePart.item_ref === null) return rejected('APPROVAL_VOID');
      envelopeId = envelopePart.item_ref;
    }
    const proof = await this.#recordPart(approvalId, stored, envelopeId);
    if (proof === 'lost') return used(envelopeId);
    return sent(envelopeId, proof);
  }

  /**
   * Void rules 2, 3 and 5 for a firm offer (04 §3.4.2; rule 1 is the slot check before sending):
   * the scope's expiry, the contact (status, owner key, card) and the stored terms binding.
   */
  async #offerVoidRule(
    stored: StoredCommitment,
    self: string,
  ): Promise<{ code: TermsCode; reason: 'expired' | 'void' } | undefined> {
    const { scope } = stored;
    if (nowOf(this.#ctx) > scope.expiresAt) return { code: 'TERMS_EXPIRED', reason: 'expired' };
    const voided = { code: 'APPROVAL_VOID' as const, reason: 'void' as const };
    let contact: ContactView;
    try {
      contact = await this.#deps.contacts.get(scope.counterparty.agentId);
    } catch {
      return voided;
    }
    if (
      contact.status !== 'active' ||
      contact.pairing !== 'complete' ||
      contact.card.ownerNostr.slice(2) !== scope.counterparty.ownerKey ||
      contact.card.issuedAt > scope.createdAt
    ) {
      return voided;
    }
    if (
      !checkCommitmentBinding(self, scope, stored.terms).ok ||
      termsHashOf(stored.terms) !== scope.termsHash
    ) {
      return voided;
    }
    return undefined;
  }

  /** The card of a firm offer (11 §6.10): our own terms, the changes from our previous version. */
  #offerCard(
    contact: ContactView,
    scope: CommitmentScope,
    terms: Terms,
    snapshot: TermsSnapshot,
    autoAccept: AutoAcceptMiss | null,
    fee: ApprovalFee | null,
  ): CommitmentCard {
    const n = this.#negotiationOf(snapshot, terms.termsId);
    const open = (r: TermsRecord) => (offerState(n, r.envelopeId) === 'open' ? 0 : 1);
    const previous = (n?.records ?? [])
      .filter((r) => r.type === 'offer' && r.terms.version < terms.version)
      .sort((a, b) => b.terms.version - a.terms.version || open(a) - open(b))[0];
    return {
      decision: 'offer',
      counterparty: {
        agentId: contact.id,
        display: contact.display,
        shown: renderContactName(contact.display),
      },
      version: terms.version,
      terms,
      changes: previous === undefined ? null : termsChanges(previous.terms, terms),
      parts: commitmentParts({ decision: 'offer', notarize: true }),
      autoAccept,
      lateAccept: null,
      validUntil: terms.validUntil,
      expiresAt: scope.expiresAt,
      fee,
      fingerprint: scope.termsHash,
    };
  }

  // --- card, listing, deferred receipt, expiry -----------------------------------------------------

  #card(
    plan: CommitPlan,
    scope: CommitmentScope,
    autoAccept: AutoAcceptMiss | null,
  ): CommitmentCard {
    const n = plan.snapshot.negotiations.get(
      plan.snapshot.byEnvelope.get(plan.answered.envelopeId)?.key ?? '',
    );
    // The newest lower version held, its open (live) offer first, never a conflicted original
    // when a resend replaced it (IR-M1-32-1 F05).
    const open = (r: TermsRecord) => (offerState(n, r.envelopeId) === 'open' ? 0 : 1);
    const previous = (n?.records ?? [])
      .filter((r) => r.type === 'offer' && r.terms.version < plan.terms.version)
      .sort((a, b) => b.terms.version - a.terms.version || open(a) - open(b))[0];
    const self = scope.agentId;
    const newerOwn =
      plan.decision === 'confirm' ? newestOwnAbove(n, self, plan.terms.version) : null;
    return {
      decision: plan.decision,
      counterparty: {
        agentId: plan.contact.id,
        display: plan.contact.display,
        shown: renderContactName(plan.contact.display),
      },
      version: plan.terms.version,
      terms: plan.terms,
      changes: previous === undefined ? null : termsChanges(previous.terms, plan.terms),
      parts: commitmentParts({ decision: plan.decision, notarize: plan.call.notarize }).filter(
        (p) => plan.parts.includes(p),
      ),
      autoAccept,
      lateAccept:
        newerOwn === null
          ? null
          : { acceptedVersion: plan.terms.version, newestOwnVersion: newerOwn },
      validUntil: plan.validUntil,
      expiresAt: scope.expiresAt,
      fee: plan.fee,
      fingerprint: scope.termsHash,
    };
  }

  /** The card data of a stored commitment request (for `agentlink approve`, 11 §6.10; M1-9q). */
  async commitmentCard(approvalId: string): Promise<CommitmentCard | undefined> {
    const stored = await this.#stored(approvalId);
    if (stored === undefined) return undefined;
    const self = (await this.#self()).agentId;
    const { scope } = stored;
    let contact: ContactView;
    try {
      contact = await this.#deps.contacts.get(scope.counterparty.agentId);
    } catch {
      return undefined;
    }
    const snapshot = await loadTermsSnapshot(this.#ctx, self, contact.id);
    if (scope.decision === 'offer') {
      const e = evaluateCommitment(await this.#policy(), {
        kind: 'terms',
        self,
        scope,
        terms: stored.terms,
        supersededByOwnNewer: false,
      });
      return this.#offerCard(
        contact,
        scope,
        stored.terms,
        snapshot,
        e.decision === 'approval' ? e.autoAccept : null,
        stored.fee,
      );
    }
    const answered =
      scope.answers === null ? undefined : snapshot.byEnvelope.get(scope.answers.envelopeId);
    if (answered === undefined) return undefined;
    const n = snapshot.negotiations.get(answered.key);
    const own =
      scope.decision === 'confirm' && answered.record.replyTo !== null
        ? snapshot.byEnvelope.get(answered.record.replyTo)?.record
        : undefined;
    const superseded =
      scope.decision === 'confirm' && newestOwnAbove(n, self, scope.version) !== null;
    const e = evaluateCommitment(await this.#policy(), {
      kind: 'terms',
      self,
      scope,
      terms: stored.terms,
      supersededByOwnNewer: superseded,
    });
    const parts = await this.#ctx.store.transaction((tx) =>
      tx.select('commitment_parts', { approval_id: approvalId }),
    );
    const kinds = new Set(parts.map((p) => p.part));
    const plan: CommitPlan = {
      call: {
        envelopeId: stored.args.envelopeId ?? '',
        decision: (stored.args.decision ?? 'accept') as RespondDecision,
        notarize: scope.notarize,
      },
      decision: scope.decision,
      contact,
      answered: answered.record,
      terms: stored.terms,
      termsHash: scope.termsHash,
      validUntil: own?.terms.validUntil ?? stored.terms.validUntil,
      superseded,
      parts: commitmentParts(scope).filter((p) => kinds.has(partRows([p])[0]!)),
      snapshot,
      fee: stored.fee,
      proofTriggers: [],
    };
    return this.#card(plan, scope, e.decision === 'approval' ? e.autoAccept : null);
  }

  /** The negotiations with a contact, rebuilt from the store (06 §2.2a; for the inbox and status). */
  async negotiations(contactId: string): Promise<NegotiationSummary[]> {
    const self = (await this.#self()).agentId;
    const snapshot = await loadTermsSnapshot(this.#ctx, self, contactId);
    const out: NegotiationSummary[] = [];
    for (const n of snapshot.negotiations.values()) {
      const head = newestOffer(n);
      out.push({
        termsId: n.termsId,
        newestVersion: head?.terms.version ?? 0,
        newestEnvelopeId: head?.envelopeId ?? null,
        lockedVersions: [...n.state.lockedVersions],
        items: n.records.map((r) => {
          const own =
            r.type === 'accept' && r.direction === 'in' && r.replyTo !== null
              ? snapshot.byEnvelope.get(r.replyTo)?.record
              : undefined;
          return {
            envelopeId: r.envelopeId,
            direction: r.direction,
            type: r.type,
            version: r.terms.version,
            state: r.type === 'offer' ? (offerState(n, r.envelopeId) ?? 'open') : 'answer',
            lateAccept:
              own !== undefined &&
              own.direction === 'out' &&
              newestOwnAbove(n, self, r.terms.version) !== null,
          };
        }),
      });
    }
    return out;
  }

  /**
   * The received offers waiting for an answer (see `OpenOffer`), across active, paired contacts,
   * oldest `validUntil` first. Read-only: it rebuilds each contact's negotiations from the store and
   * changes nothing. A contact whose stored terms do not read is left out (fail closed, counted in
   * the log only).
   */
  async openOffers(): Promise<OpenOffer[]> {
    const self = (await this.#self()).agentId;
    const now = nowOf(this.#ctx);
    const contacts = (await this.#deps.contacts.list()).filter(
      (c) => c.status === 'active' && c.pairing === 'complete',
    );
    const out: OpenOffer[] = [];
    let unreadable = 0;
    for (const contact of contacts) {
      let snapshot: TermsSnapshot;
      try {
        snapshot = await loadTermsSnapshot(this.#ctx, self, contact.id);
      } catch {
        unreadable += 1;
        continue;
      }
      for (const n of snapshot.negotiations.values()) {
        const head = newestOffer(n);
        if (head === undefined || head.direction !== 'in') continue;
        const version = head.terms.version;
        if (isLocked(n, version) || now > head.terms.validUntil) continue;
        const rejected = n.records.some(
          (r) => r.direction === 'out' && r.type === 'reject' && r.terms.version === version,
        );
        if (rejected) continue;
        out.push({
          envelopeId: head.envelopeId,
          contactId: contact.id,
          termsId: n.termsId,
          version,
          validUntil: head.terms.validUntil,
        });
      }
    }
    if (unreadable > 0)
      this.#ctx.log.warn('open offers: contacts unreadable', { contacts: unreadable });
    return out.sort(
      (x, y) =>
        x.validUntil - y.validUntil ||
        (x.envelopeId < y.envelopeId ? -1 : x.envelopeId > y.envelopeId ? 1 : 0),
    );
  }

  /**
   * The deferred `ACCEPTED` receipt (07 §2.1 step 4), for M1-7g when it processes a record's
   * `proof` envelope (never from `agentlink_status`): an approved scope whose
   * `answers.envelopeHash` is the record's, the signer the scope's counterparty, with its receipt
   * part unclaimed, and the record kind matching the decision: `OFFER` for an `accept`, `ACCEPT`
   * for a `confirm` (their accept of our offer, 04 §3.4.2; M1-7g-d). Void rules 2–6 and, for a
   * grant, the policy are re-checked. M1-7g then checks the recipient commitment on-chain and claims
   * the part (claimReceiptPart) in the transaction that stores the signed receipt.
   */
  async deferredReceipt(record: {
    readonly envelopeHash: string;
    readonly kind: 'OFFER' | 'ACCEPT';
    readonly signer: string;
  }): Promise<DeferredReceipt> {
    const decision: CommitmentDecision | undefined =
      record.kind === 'OFFER' ? 'accept' : record.kind === 'ACCEPT' ? 'confirm' : undefined;
    if (decision === undefined) return { status: 'none' };
    const self = await this.#self();
    const candidates = await this.#ctx.store.transaction((tx) =>
      tx
        .select('approvals', { status: 'approved' })
        .filter((r) => r.scope_json !== null)
        .filter(
          (r) =>
            tx.count('commitment_parts', {
              approval_id: r.approval_id,
              part: 'receipt',
              state: 'unclaimed',
            }) === 1,
        ),
    );
    for (const row of candidates) {
      const stored = await this.#stored(row.approval_id);
      if (stored === undefined) continue;
      const { scope } = stored;
      // Only after the accept was sent: its envelope part claimed or done, or a receipt-only
      // scope whose accept ran under an earlier one (IR-M1-32-1 F02).
      const envelopePart = await this.#ctx.store.transaction((tx) =>
        tx.get('commitment_parts', { approval_id: row.approval_id, part: 'envelope' }),
      );
      if (
        envelopePart !== undefined &&
        envelopePart.state !== 'claimed' &&
        envelopePart.state !== 'done'
      ) {
        continue;
      }
      if (
        scope.decision !== decision ||
        scope.agentId !== self.agentId ||
        scope.answers?.envelopeHash !== record.envelopeHash ||
        scope.counterparty.agentId !== record.signer
      ) {
        continue;
      }
      const facts: CommitmentFacts = {
        kind: 'terms',
        self: self.agentId,
        scope,
        terms: stored.terms,
        supersededByOwnNewer: false,
      };
      const authority = await this.#authority(stored, self, await this.#policy(), facts);
      if (authority !== 'ok') {
        await this.#voidParts(row.approval_id, 'void');
        return {
          status: 'void',
          approvalId: row.approval_id,
          code: authority === 'pending' || authority === 'ask_owner' ? 'APPROVAL_VOID' : authority,
        };
      }
      const voidRule = await this.#voidRule(stored, self.agentId, false);
      if (voidRule !== undefined) {
        await this.#voidParts(row.approval_id, voidRule.reason);
        return { status: 'void', approvalId: row.approval_id, code: voidRule.code };
      }
      return { status: 'ready', approvalId: row.approval_id, scope };
    }
    return { status: 'none' };
  }

  /**
   * The atomic claim of a receipt part (07 §3.5), for M1-7g: inside its store transaction that stores
   * the signed receipt. True only for the one call that moved it `unclaimed` → `claimed`, and only if
   * no other scope with the same scope key has its receipt part claimed or done.
   */
  claimReceiptPartTx(
    tx: StoreTx,
    approvalId: string,
    itemRef: string,
    itemJson: string,
    now: number,
  ): boolean {
    const row = tx.get('approvals', { approval_id: approvalId });
    if (row === undefined || row.scope_key === null) return false;
    // Re-checked inside the claim transaction (IR-M1-32-1 F04): a cancel, a denial or a void that
    // landed since the lookup, and the scope's expiry.
    if (row.status !== 'approved' || row.signed_cancel !== null || row.scope_json === null) {
      return false;
    }
    let expiresAt: unknown;
    try {
      expiresAt = (parseJson(row.scope_json) as { expiresAt?: unknown }).expiresAt;
    } catch {
      return false;
    }
    if (typeof expiresAt !== 'number' || now > expiresAt) return false;
    for (const other of tx.select('approvals', { scope_key: row.scope_key })) {
      if (other.approval_id === approvalId) continue;
      if (
        tx.count('commitment_parts', {
          approval_id: other.approval_id,
          part: 'receipt',
          state: { in: ['claimed', 'done'] },
        }) > 0
      ) {
        return false;
      }
    }
    return (
      tx.update(
        'commitment_parts',
        { approval_id: approvalId, part: 'receipt', state: 'unclaimed' },
        {
          state: 'claimed',
          item_ref: itemRef,
          item_json: itemJson,
          claimed_at: now,
          updated_at: now,
        },
      ) === 1
    );
  }

  /** 07 §2.1 step 5: at `expiresAt`, the open parts of every scope are void. Returns parts changed. */
  async expireDue(): Promise<number> {
    const now = nowOf(this.#ctx);
    return this.#ctx.store.transaction((tx) => {
      let n = 0;
      for (const row of tx.select('approvals', { status: { in: ['approved', 'pending'] } })) {
        if (row.scope_json === null) continue;
        let expiresAt: unknown;
        try {
          expiresAt = (parseJson(row.scope_json) as { expiresAt?: unknown }).expiresAt;
        } catch {
          expiresAt = undefined;
        }
        // A scope that cannot be read authorises nothing anyway; its parts are void too.
        if (typeof expiresAt === 'number' && now <= expiresAt) continue;
        n += tx.update(
          'commitment_parts',
          { approval_id: row.approval_id, state: { in: ['unclaimed', 'claimed'] } },
          { state: 'void', void_reason: 'expired', updated_at: now },
        );
      }
      return n;
    });
  }
}

/** The policy document hash a grant records (re-exported for the proof pack, 07 §8). */
export { policyDocumentHash };
