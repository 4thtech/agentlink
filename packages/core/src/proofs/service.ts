// Proofs and receipts in the core (M1-7g; 03 §4.3; 04 §3.4 `proof`, §3.4.2, §5; 05 §3.1, §3.3;
// 06 §2.4, §3; 07 §2.1 step 4, §6.2, §6.3, §8; D-31, D-32, D-55, D-61, D-86, D-102).
//
// Sender side (`notarize`): the kind comes from the payload (05 §3.1, D-86) and control types are
// NOT_NOTARIZABLE; terms types go through the terms tools (USE_TERMS_TOOLS). The chain is selected
// automatically (07 §6.3; nothing funded → `needs_credits` with the top-up route). Policy `proofs.*`
// and the daily budget are evaluated, and the Record is signed and stored with its fresh salt in the
// same store transaction that reserves its fee (06 §3, 07 §3.5); only then is it submitted. Once the
// chain shows it, a follow-up `proof` envelope `{envelopeId, chainId, recordId, salt}` carries the
// salt to the recipient. A Record that has not landed is resent unchanged; a replacement (new nonce,
// fresh salt, new deadline) is signed only when `replacementAllowed` says the earlier one can never
// land (04 §5), and an approved Record is not replaced after its approval's `expiresAt`.
//
// Recipient side (`processInbound`): a `proof` envelope from a contact is checked on-chain before
// anything is signed: the record exists, its signer is that contact, its `envelopeHash` is the
// stored envelope's, its kind is the 05 §3.1 kind of the payload this agent holds, and its recipient
// commitment opens to this agent with the delivered salt. Then DELIVERED per the effective
// `receipts.autoDelivered` (default off; the contact rule, else the global value; D-109)
// and the deferred ACCEPTED of an approved accept on its OFFER record, or of an approved `confirm` on
// their ACCEPT record (07 §2.1 step 4; 04 §3.4.2, M1-7g-d). A `receiptRequest` in the body
// (M1-33d) is kept as a flag on the received record and never signs anything; the user's
// `acknowledge {type: "delivered"}` signs exactly one DELIVERED (receipt-request.ts). OPENED only on request;
// ACCEPTED / REJECTED without terms are commitments (`commitments.accept`, D-31) and exclusive.
//
// Signed Record in the body (M1-7g-b, D-107): the sender's `proof` body also carries the Record and
// its signature exactly as submitted. The recipient runs the 04 §3.4 checks 1–5 on them with the
// existing checks; any mismatch drops the whole body (`proof_mismatch`). A chain read that fails is
// never a pass: the body stays pending and is checked again at later syncs (at most 256 bodies, 7
// days each, then `proof_unchecked`; at most PROOF_PENDING_PER_CONTACT of them from one contact,
// M1-7g-c). A definite mismatch (`proof_mismatch`, `proof_parent_mismatch`) flags the contact
// (04 §3.4, M1-7g-c): the `proof` envelope is stored as refused with that fixed code, and
// `processInbound` reports it as a flagged refusal for the activity feed. Nothing clears it.
// A passing body's Record and signature are stored as received,
// and the recipient can export its own pack from them; an older sender's body carries neither
// (RECORD_UNAVAILABLE on export).
//
// Export (`exportProofPack`, 07 §8): the signer block is the card of the envelope's key epoch with
// its proof of possession (`proofSigner`, D-102); the content key only with an owner approval
// (`proofs.allowKeyDisclosure` is never `allow`), and then always with the envelope; the owner's
// approval of a commitment is included by default (D-55).
//
// Never logged or put in an error (I-7, 04 §5): salts, signatures, content keys, record contents.
// Inbound proof bodies and chain answers are untrusted data (I-5): only fixed codes leave here, and
// the log keeps a `code` field only when it is one of PROOF_LOG_CODES (M1-7g-d).
import {
  HPKE_ENC_LENGTH,
  WRAPPED_CEK_LENGTH,
  canonicalize,
  decodeBase64url,
  encodeBase64url,
  encodeHex0x,
  hashRecord,
  occV2Domain,
  parseJson,
  recipientCommitment,
  wipe,
  type Envelope,
} from '@4thtech-io/crypto';
import type {
  BuiltRecord,
  ChainSelection,
  Hex,
  ProofOutcome,
  RecordKind,
  TopUpRoute,
} from '@4thtech-io/chain';
import type { Logger } from '@4thtech-io/log';
import {
  RECEIPT_TYPE_NAMES,
  RECORD_KINDS as RECORD_KIND,
  compareUsd,
  payloadSchema,
  proofBodySchema,
  proofPackSchema,
  signedApprovalDecideSchema,
  type ApprovalFee,
  type Payload,
  type ReceiptTypeName,
  type RecordJson,
} from '@4thtech-io/types';
import { feeContextFromQuote, type ApprovalService, type PendingApproval } from '../approvals.js';
import {
  checkAndReserveProof,
  readBudgetLedger,
  releaseProofReservation,
  settleProofCharged,
} from '../budget.js';
import { evaluateCommitment } from '../commitments.js';
import type { ContactBook } from '../contacts.js';
import { CoreError } from '../errors.js';
import { nowOf, open, seal, type CoreContext } from '../context.js';
import type { EnvelopeService, InboundReport } from '../envelopes.js';
import type { IdentityService } from '../identity.js';
import { renderContactName } from '../names.js';
import type { OutboxService } from '../outbox.js';
import { parseOwnerActionText } from '../owner-action.js';
import type { OwnerActions } from '../owner-actions.js';
import {
  evaluate,
  evaluateProof,
  type EffectivePolicy,
  type ProofAction,
  type ProofTrigger,
} from '../policy-engine.js';
import type { Row } from '../store/schema.js';
import type { StoreTx } from '../store/store.js';
import type {
  CommitmentQuote,
  CommitmentRecorder,
  KnownRecord,
  RecordLookup,
  TermsService,
} from '../terms-flow.js';
import type { ProofChain, ProofKit, ProofsPlatform } from './platform.js';
import type { Page, PageQuery } from '../paging.js';
import {
  listProofs,
  readCredits,
  requestFreeCredits,
  type CreditsView,
  type FreeCreditsResult,
  type ProofListItem,
} from './reads.js';
import { RECEIPT_REQUEST, receiptRequestKey, senderRequestedTx } from './receipt-request.js';

/** A Record's `deadline` is this far after signing (proposed; 04 §5 replacement window). */
export const RECORD_DEADLINE_SECONDS = 3_600;
/** A Receipt's `deadline` is this far after signing (proposed). */
export const RECEIPT_DEADLINE_SECONDS = 3_600;
/**
 * Queued receipts posted per sync pass (D-114, M1-34-b): a receipt no submitter took stays stored
 * and is posted again on a later pass; the least recently tried go first, so none waits forever.
 */
export const QUEUED_RECEIPTS_PER_PASS = 5;
/**
 * How long one queued receipt waits for inclusion on a sync pass (IR-M1-34-b-1 M-1): short, since
 * the next pass reads the chain first; five slow posts then cost seconds, not minutes.
 */
export const QUEUED_RECEIPT_WAIT_MS = 2_000;
/**
 * The client's own simulation refusals that no resend can fix (IR-M1-34-b-1 L-1): the record is not
 * on-chain, the signature or the recipient commitment is wrong. `Expired` is not here: 04 §5 may
 * allow a replacement.
 */
/**
 * A receipt the client's chain reads answer `RecordNotFound` for is posted again this many times,
 * after RECEIPT_NOT_FOUND_RETRY_MS, before it becomes `receipt_failed` (M1-34-c): a client RPC that
 * lags behind the block holding the record must not fail the receipt for good. Fixed, so a record
 * that never existed costs one extra post per receipt, once.
 */
export const RECEIPT_NOT_FOUND_RETRIES = 1;
/** The fixed delay before that retry (M1-34-c): a few blocks on the supported chains. */
export const RECEIPT_NOT_FOUND_RETRY_MS = 3_000;
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
const TERMINAL_RECEIPT_ERRORS: ReadonlySet<string> = new Set([
  'RecordNotFound',
  'InvalidSignature',
  'NotRecipient',
]);

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const TERMS_TYPES: ReadonlySet<string> = new Set(['offer', 'accept', 'reject']);
const RECEIPT_CODE: Readonly<Record<ReceiptTypeName, number>> = Object.freeze({
  DELIVERED: 1,
  OPENED: 2,
  ACCEPTED: 3,
  REJECTED: 4,
});

/** Own Record rows: where each stands. `received` rows are records a contact made for us. */
type OwnStatus =
  | 'signed'
  | 'pending'
  | 'needs_credits'
  | 'failed'
  | 'conflict'
  | 'recorded'
  | 'announced'
  | 'replaced'
  /** A refused (`failed`) Record whose reservation was released once it could never land. */
  | 'released';
const LIVE: readonly OwnStatus[] = ['signed', 'pending', 'needs_credits'];
/** The rows the proof list shows (M1-11r-a): every record, own or received, except a replaced one. */
export const LISTED_PROOF_STATUSES: readonly (Exclude<OwnStatus, 'replaced'> | 'received')[] = [
  'signed',
  'pending',
  'needs_credits',
  'failed',
  'conflict',
  'recorded',
  'announced',
  'released',
  'received',
];
const ON_CHAIN: readonly string[] = ['recorded', 'announced'];
/**
 * A signed Receipt of this agent, kept so the same bytes are resent until they land (04 §5). Its
 * `proofs` row is keyed by the submitter item ID `<recordId>:<receiptType>` (07 §7), holds the
 * signed item in `record_json` and an empty sealed `salt` (the salt lives on the record's row).
 */
const RECEIPT_SIGNED = 'receipt_signed';
const RECEIPT_RECORDED = 'receipt_recorded';
/** The conflicting ACCEPTED/REJECTED type is on-chain: this receipt can never land. */
const RECEIPT_CONFLICT = 'receipt_conflict';
/** The chain refuses this receipt for good (TERMINAL_RECEIPT_ERRORS): it leaves the queue. */
const RECEIPT_FAILED = 'receipt_failed';
const RECEIPT_STATUSES: readonly string[] = [
  RECEIPT_SIGNED,
  RECEIPT_RECORDED,
  RECEIPT_CONFLICT,
  RECEIPT_FAILED,
];
/**
 * A `proof` envelope whose message has not arrived yet (IR-M1-7g-1 L5): kept, keyed
 * `await:<proof envelope id>`, with the message's envelope ID, and checked when that arrives.
 */
const AWAITING = 'awaiting';
/** At most this many proof envelopes wait for their message, each at most this long. */
const MAX_AWAITING = 256;
const AWAITING_SECONDS = 7 * 86_400;
const AWAITING_PREFIX = 'await:';
/**
 * One contact's share of the waiting pool (M1-7g-d, as for the pending pool): at most this many of
 * the MAX_AWAITING proof envelopes come from one contact, so one contact cannot fill the pool.
 */
export const PROOF_AWAITING_PER_CONTACT = 32;
/**
 * A `proof` envelope whose chain read failed (an RPC error or timeout, not an answer; 04 §3.4,
 * M1-7g-b): kept, keyed `pending:<proof envelope id>`, never a pass and never a mismatch, and checked
 * again from the existing checks on at each later inbox sync until the read answers.
 */
const PENDING = 'proof_pending';
const PENDING_PREFIX = 'pending:';
/** At most this many bodies are pending, each at most this long after it was received. */
const MAX_PENDING = 256;
const PENDING_SECONDS = 7 * 86_400;
/**
 * One contact's share of the pending pool (M1-7g-c): at most this many of the MAX_PENDING bodies
 * come from one contact, so one contact cannot fill the pool and push out the others' bodies.
 */
export const PROOF_PENDING_PER_CONTACT = 32;
/**
 * The fixed codes the proof flow writes in a log line's `code` field (M1-7g-d, I-7): the logger
 * keeps only these; any other value is redacted. The void codes of a deferred receipt are TermsCode.
 */
export const PROOF_LOG_CODES: readonly string[] = Object.freeze([
  'submit_error',
  'record_failed',
  'announce_failed',
  'proof_inbound_error',
  'proof_unchecked',
  'proof_pending',
  'proof_mismatch',
  'proof_parent_mismatch',
  'receipt_conflict',
  'receipt_failed',
  'deferred_error',
  'pack_invalid',
  'APPROVAL_VOID',
  'TERMS_EXPIRED',
  'TERMS_SUPERSEDED',
  'POLICY_DENIED',
  'NOT_A_PARTY',
]);
/** Rows that are a record: own or received (not a stored receipt or a waiting proof). */
const isRecordRow = (r: Row<'proofs'>): boolean =>
  !RECEIPT_STATUSES.includes(r.status) &&
  r.status !== AWAITING &&
  r.status !== PENDING &&
  r.status !== RECEIPT_REQUEST;
const receiptItemId = (recordId: string, code: number): string => `${recordId}:${String(code)}`;

/** Fixed refusal codes (06 §1 rule 3). */
export type ProofCode =
  | 'PROOFS_UNAVAILABLE'
  | 'ENVELOPE_NOT_FOUND'
  | 'NOT_NOTARIZABLE'
  | 'USE_TERMS_TOOLS'
  | 'USE_RESPOND_TO_TERMS'
  | 'POLICY_DENIED'
  | 'CARD_EXPIRED'
  | 'CHAIN_UNAVAILABLE'
  | 'UNSUPPORTED_CHAIN'
  | 'NOT_RECORDED'
  | 'RECORD_UNAVAILABLE'
  | 'RECEIPT_CONFLICT'
  | 'APPROVAL_INVALID'
  | 'POLICY_CHANGED'
  /** `parentRecordId` is not zero and not a record the chain shows this agent signed (D-109). */
  | 'PARENT_NOT_OWN'
  /**
   * A terms Record (M1-9d-3): the fee now quoted is above the commitment's `maxFeeUsd`, so the
   * approval does not cover it (04 §3.4.2). Nothing is signed or charged.
   */
  | 'FEE_ABOVE_APPROVED';

/** What one `processInbound` pass did (M1-7g-c). */
export interface ProofInboundResult {
  /** Receipts signed in this pass. */
  readonly signed: number;
  /**
   * A `proof` envelope that did not match the chain (04 §3.4): outcome `refused`, reason
   * `proof_mismatch` or `proof_parent_mismatch`, its contact, `flagged: true`. Fixed codes and
   * validated IDs only, never a value from the body or the chain answer (I-5, I-7).
   */
  readonly reports: readonly InboundReport[];
}

export interface ProofRejected {
  readonly status: 'rejected';
  readonly code: ProofCode;
}

const rejected = (code: ProofCode): ProofRejected => Object.freeze({ status: 'rejected', code });

export interface ProofFee {
  /** The Record's `feeToken`, `0x` + 40 lowercase hex. */
  readonly token: string;
  /** Base units: the signed `maxFee` (the charge is at most this, 06 §2.4). */
  readonly amount: string;
  /** USD amount (04 §2.4.1), 1:1 for stablecoins (D-46). */
  readonly usd: string;
}

export interface NotarizeInput {
  readonly envelopeId: string;
  /** The Advanced / tool `chain?` override (06 §2.4); never asked of the user. */
  readonly chainId?: number;
  readonly approvalId?: string;
  /**
   * The Record's `parentRecordId` (D-109; 05 §3.1, 04 §5.1). Absent or zero by default. Otherwise
   * only a record the selected chain shows this agent signed (its own earlier record); a record of
   * another signer, one the chain does not hold or a malformed value is `PARENT_NOT_OWN`, and a
   * failed read is `CHAIN_UNAVAILABLE`. Either way nothing is signed or charged. No tool sets it.
   */
  readonly parentRecordId?: string;
  /**
   * The user asked for a delivery receipt (06 §2.4 `requestReceipt`, D-109; M1-33d): the `proof`
   * envelope carries `receiptRequest: "delivered"`. Kept with the Record when it is first signed
   * (an approval covers it); an envelope already notarized without one asks for nothing more.
   */
  readonly requestReceipt?: boolean;
}

interface RecordedFields {
  readonly recordId: string;
  readonly chainId: number;
  readonly chain: string;
  readonly fee: ProofFee;
  /** Present (true) only when this proof's envelope asks the recipient for a delivery receipt. */
  readonly receiptRequested?: true;
  /**
   * Present (true) only when the call asked for a delivery receipt (`requestReceipt`) and the
   * envelope already had a proof without one, so no request was added (M1-33d-b): the agent must
   * not tell its user it asked.
   */
  readonly receiptRequestNotAdded?: true;
}

export type NotarizeResult =
  /** On-chain. `confirmed` at the configured depth (07 §6.1). */
  | (RecordedFields & { readonly status: 'ok'; readonly confirmed: boolean })
  /** Signed and stored, not on-chain yet: resent unchanged by `resubmitPending` (04 §5). */
  | (RecordedFields & { readonly status: 'submitted' })
  /** Nothing funded (07 §6.3). `recordId` when the contract refused an already-signed Record. */
  | {
      readonly status: 'needs_credits';
      readonly topUp?: TopUpRoute;
      readonly recordId?: string;
    }
  | {
      readonly status: 'error';
      readonly code: 'RECORD_FAILED' | 'RECORD_CONFLICT';
      readonly recordId: string;
    }
  | PendingApproval
  | ProofRejected;

export interface AcknowledgeInput {
  readonly envelopeId: string;
  /** `delivered` is the user's own yes (06 §2.4, D-109; M1-33d): no owner approval, one receipt. */
  readonly type: 'delivered' | 'opened' | 'accepted' | 'rejected';
  readonly approvalId?: string;
}

export type AcknowledgeResult =
  | {
      readonly status: 'ok';
      readonly recordId: string;
      readonly receipt: ReceiptTypeName;
      /** True once the chain shows the receipt. */
      readonly onChain: boolean;
    }
  | PendingApproval
  | ProofRejected;

export interface ProofView {
  readonly direction: 'sent' | 'received';
  readonly status: string;
  readonly recordId: string;
  readonly chainId: number;
  readonly chain: string;
  readonly fee?: ProofFee;
  /** From the chain when it answers, otherwise the receipts this agent signed. */
  readonly receipts: readonly { readonly type: ReceiptTypeName; readonly at: string }[];
}

export interface ExportProofPackInput {
  readonly envelopeId?: string;
  readonly recordId?: string;
  /** Discloses the envelope's content key: needs an owner approval (06 §3). Default false. */
  readonly includeContentKey?: boolean;
  readonly approvalId?: string;
  /** The owner's approval of a commitment (D-55): included by default; the owner may leave it out. */
  readonly includeOwnerApproval?: boolean;
  /**
   * Discloses the recipient's address and the salt that opens the commitment (07 §8 "optional
   * disclosure"; 04 §5: unlinkable unless disclosed). Default false.
   */
  readonly includeRecipient?: boolean;
}

export type ExportProofPackResult =
  | {
      readonly status: 'ok';
      readonly recordId: string;
      readonly pack: Readonly<Record<string, unknown>>;
    }
  | PendingApproval
  | ProofRejected;

export interface ResubmitSummary {
  /** Signed items sent again unchanged. */
  readonly resent: number;
  /** Replacements signed (04 §5). */
  readonly replaced: number;
  /** Items now on-chain. */
  readonly recorded: number;
}

export interface ProofServiceDeps {
  readonly identity: IdentityService;
  readonly contacts: ContactBook;
  readonly envelopes: EnvelopeService;
  readonly outbox: OutboxService;
  readonly ownerActions: OwnerActions;
  readonly approvals: ApprovalService;
  /** Late-bound: the terms service is built with this service as its record lookup. */
  readonly terms: () => TermsService;
}

/** The stored own Record: the exact signed item, as canonical JSON. */
interface SignedItem {
  readonly record: BuiltRecord['record'];
  readonly signature: string;
}

/**
 * The stored on-chain view of a record a contact made for us and, from a sender at M1-7g-b on, the
 * signed Record and signature exactly as received in the `proof` body after they passed the 04 §3.4
 * checks (D-107). An older sender's body leaves both out.
 */
interface ReceivedItem {
  readonly received: {
    readonly signer: string;
    readonly envelopeHash: string;
    readonly kind: number;
    readonly recipientCommitment: string;
  };
  readonly record?: RecordJson;
  readonly signature?: string;
  /** The sender asked for a delivery receipt (M1-33d): a flag only, never signs anything (D-109). */
  readonly receiptRequest?: 'delivered';
}

/** The outcome of the recipient's checks of a `proof` body (04 §3.4). */
type RecordCheck =
  | { readonly status: 'ok'; readonly received: ReceivedItem['received'] }
  /** A definite mismatch: the whole body is dropped (`proof_mismatch`). */
  | { readonly status: 'mismatch'; readonly code?: 'proof_parent_mismatch' }
  /** A chain read failed: neither a pass nor a mismatch; the body stays pending. */
  | { readonly status: 'unavailable' };
const MISMATCH: RecordCheck = Object.freeze({ status: 'mismatch' });
/** The 04 §3.4 parent check (D-109): the Record names a parent another signer made. */
const PARENT_MISMATCH: RecordCheck = Object.freeze({
  status: 'mismatch',
  code: 'proof_parent_mismatch',
});
const UNAVAILABLE: RecordCheck = Object.freeze({ status: 'unavailable' });

class Abort extends Error {}

type Selector = Pick<NonNullable<ProofsPlatform['selector']>, 'select' | 'clear'>;

/**
 * A requested `parentRecordId` (D-109): `undefined` for none (absent or zero, the default), the
 * value for a well-formed `bytes32` (04 §2.4.1: `0x` + 64 lowercase hex), `null` for anything else.
 */
function parentOf(value: unknown): string | undefined | null {
  if (value === undefined || value === ZERO_BYTES32) return undefined;
  return typeof value === 'string' && BYTES32.test(value) ? value : null;
}

const iso = (seconds: bigint | number): string =>
  new Date(Number(seconds) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

function proofTriggers(triggers: readonly ProofTrigger[]): string[] {
  const out = new Set<string>();
  for (const t of triggers) {
    if (t === 'notarize' || t === 'policy_invalid') out.add('proofs.notarize');
    else if (t === 'per_action') out.add('proofs.perActionMaxUSD');
    else out.add('proofs.dailyBudgetUSD');
  }
  return [...out].sort();
}

/** A terms Record's outcome (M1-9d-3): as `notarize`, never a separate approval. */
export type CommitmentRecordResult = Exclude<NotarizeResult, PendingApproval>;

export class ProofService implements RecordLookup, CommitmentRecorder {
  readonly #ctx: CoreContext;
  readonly #log: Logger;
  readonly #deps: ProofServiceDeps;
  readonly #platform: ProofsPlatform | undefined;
  readonly #selector: Selector | undefined;
  readonly #sleep: (ms: number) => Promise<void>;
  /** Queued receipt ID -> the pass that last tried it (in memory; M1-34-b). */
  readonly #receiptTries = new Map<string, number>();
  /** The receipt signing in progress, by receipt item ID (M1-33d-b: one signature, I-6). */
  readonly #signing = new Map<string, Promise<AcknowledgeResult>>();
  #receiptPass = 0;

  constructor(ctx: CoreContext, deps: ProofServiceDeps, platform: ProofsPlatform | undefined) {
    this.#ctx = ctx;
    this.#log = ctx.log.withCodes(PROOF_LOG_CODES);
    this.#deps = deps;
    this.#platform = platform;
    this.#sleep = platform?.sleep ?? defaultSleep;
    this.#selector =
      platform === undefined
        ? undefined
        : (platform.selector ?? platform.kit.createChainSelector());
  }

  // --- notarize --------------------------------------------------------------------------------

  /** Records an envelope this agent sent (06 §2.4 `agentlink_notarize`). */
  async notarize(input: NotarizeInput): Promise<NotarizeResult> {
    const result = await this.#notarize(input);
    if (result.status !== 'ok' && result.status !== 'submitted') return result;
    // Says "asked" only when the stored marker is there: a request on an envelope already notarized
    // without one is not claimed (M1-33d), and is reported as not added (M1-33d-b).
    const asked = await this.#ctx.store.transaction((tx) =>
      senderRequestedTx(tx, input.envelopeId),
    );
    if (asked) return Object.freeze({ ...result, receiptRequested: true as const });
    if (input.requestReceipt === true) {
      return Object.freeze({ ...result, receiptRequestNotAdded: true as const });
    }
    return result;
  }

  async #notarize(input: NotarizeInput): Promise<NotarizeResult> {
    const platform = this.#platform;
    if (platform === undefined) return rejected('PROOFS_UNAVAILABLE');
    const self = await this.#self();
    const row = await this.#envelope(input.envelopeId);
    if (row === undefined || row.direction !== 'out' || row.state !== 'ok') {
      return rejected('ENVELOPE_NOT_FOUND');
    }
    const payload = await this.#payload(row);
    if (payload === undefined) return rejected('ENVELOPE_NOT_FOUND');
    if (TERMS_TYPES.has(payload.type)) return rejected('USE_TERMS_TOOLS');
    const kind = this.#kit.recordKindForPayload(payload);
    if (kind === null) return rejected('NOT_NOTARIZABLE');
    // D-109: zero by default; any other value must be well-formed before the chain is asked.
    const parent = parentOf(input.parentRecordId);
    if (parent === null) return rejected('PARENT_NOT_OWN');

    // Already recorded, or signed and not landed: never sign a second Record (04 §5).
    const existing = await this.#ownRows(input.envelopeId);
    // A refused one stays the answer until the chain shows it can never land (resubmitPending).
    const live = existing.find((r) => r.status !== 'replaced' && r.status !== 'released');
    if (live !== undefined) return this.#continue(live);

    await this.#deps.identity.assertCanSend();
    const now = nowOf(this.#ctx);
    const deadline = now + RECORD_DEADLINE_SECONDS;

    // The verifier refuses a card that expired before the record's chain time (07 §8).
    const signer = await this.#deps.contacts.proofSigner(row.from_key);
    const expiresAt = signer?.agentCard.expiresAt ?? 0;
    if (expiresAt !== 0 && expiresAt <= deadline) return rejected('CARD_EXPIRED');

    const effective = await this.#deps.ownerActions.loadPolicy();
    const defaultChain =
      effective.mode === 'fail_closed' ? undefined : effective.policy.proofs.defaultChain;
    const selection = await this.#select(self.agentId, defaultChain, input.chainId);
    if (selection.status === 'needs_credits') {
      return Object.freeze({ status: 'needs_credits', topUp: selection.topUp });
    }
    if (selection.status !== 'ok') return rejected('CHAIN_UNAVAILABLE');
    const chain = this.#chain(selection.chainId);
    if (chain === undefined) return rejected('UNSUPPORTED_CHAIN');
    if (parent !== undefined) {
      // Only this agent's own earlier record on this chain, before any approval, signature or
      // reservation (D-109; 04 §5.1). A read that fails refuses: it is never a pass.
      const own = await this.#ownParent(chain, self.agentId, parent);
      if (own !== 'ok') return rejected(own);
    }
    const tokenAddress = (selection.quote.tokenAddress ?? ZERO_ADDRESS).toLowerCase();
    const decimals = chain.config.feeTokens.find(
      (t) => t.symbol === selection.quote.token,
    )?.decimals;
    if (decimals === undefined) return rejected('CHAIN_UNAVAILABLE');
    const fee = feeContextFromQuote({
      token: tokenAddress,
      amount: selection.quote.total,
      decimals,
    });

    const recipient = row.contact_id;
    const counterparty = recipient === null ? null : await this.#counterparty(recipient);
    const action: ProofAction = {
      kind: 'proof',
      feeUsd: fee.usd,
      maxFeeUsd: fee.usd,
      counterparty:
        counterparty === null
          ? null
          : { contact: counterparty.agentId, ruleEligible: counterparty.eligible },
    };
    const pre = await this.#ctx.store.transaction((tx) =>
      evaluateProof(effective, action, { now, ledger: readBudgetLedger(tx) }),
    );
    if (pre.decision === 'deny') return rejected('POLICY_DENIED');
    const approvalAction = {
      tool: 'agentlink_notarize',
      args: {
        envelopeId: input.envelopeId,
        ...(input.chainId === undefined ? {} : { chain: chain.config.key }),
        // The approval covers this parent and no other (absent: the default zero).
        ...(parent === undefined ? {} : { parentRecordId: parent }),
        // And this receipt request, or none (M1-33d): the card says what a receipt makes public.
        ...(input.requestReceipt === true ? { requestReceipt: true } : {}),
      },
      context: {
        triggers: proofTriggers(pre.triggers),
        counterparty:
          counterparty === null
            ? null
            : { agentId: counterparty.agentId, ownerKey: counterparty.ownerKey },
        envelopeHash: row.envelope_hash,
        fee,
      },
    };
    let claim: ((tx: StoreTx) => boolean) | undefined;
    if (pre.decision === 'approval') {
      if (input.approvalId === undefined) {
        return this.#deps.approvals.request({
          action: approvalAction,
          summary:
            counterparty === null
              ? `Record a note on-chain for ${fee.usd} USD`
              : `Record a message to ${counterparty.name} on-chain for ${fee.usd} USD`,
        });
      }
      const auth = await this.#deps.approvals.authorize(
        input.approvalId,
        approvalAction,
        'approval',
      );
      if (auth.status !== 'authorized') return rejected('APPROVAL_INVALID');
      claim = auth.claim;
    }

    const built = this.#kit.buildRecord({
      chainId: chain.config.chainId,
      notary: chain.config.contracts.notary,
      signer: self.agentId,
      envelopeHash: row.envelope_hash,
      recipient,
      // Checked above against the chain; absent, the builder's zero (D-109).
      ...(parent === undefined ? {} : { parentRecordId: parent }),
      kind: kind as RecordKind,
      feeToken: tokenAddress,
      maxFee: selection.quote.total,
      deadline,
    });
    const signature = await this.#kit.signRecord(this.#ctx.keyStore, built);
    const stored = await this.#storeSigned({
      built,
      signature,
      envelopeId: input.envelopeId,
      fee,
      effective,
      action,
      approvalId: claim === undefined ? null : (input.approvalId ?? null),
      claim,
      replaces: undefined,
      receiptRequest: input.requestReceipt === true,
    });
    if (stored === undefined) return rejected('POLICY_CHANGED');
    return this.#submit(stored);
  }

  // --- terms Records under a commitment scope (M1-9d-3; 04 §3.4.2; 06 §2.2a) ---------------------

  /**
   * The fee a terms Record would cost now and what the proofs policy says of it, before the terms
   * flow asks the owner (04 §3.4.2 "One request per call": the fee and any proof trigger join the
   * commitment's single request). Chain chosen automatically (07 §6.3); nothing funded is
   * `needs_credits` with the top-up route, before anything is sent or requested. Signs nothing.
   */
  async quoteCommitment(input: { readonly counterparty: string }): Promise<CommitmentQuote> {
    if (this.#platform === undefined) return rejected('PROOFS_UNAVAILABLE');
    const self = await this.#self();
    const now = nowOf(this.#ctx);
    // The verifier refuses a card that expired before the record's chain time (07 §8).
    const expiresAt = self.card.expiresAt ?? 0;
    if (expiresAt !== 0 && expiresAt <= now + RECORD_DEADLINE_SECONDS) {
      return rejected('CARD_EXPIRED');
    }
    const effective = await this.#deps.ownerActions.loadPolicy();
    const priced = await this.#price(self.agentId, effective);
    if (priced.status !== 'ok') return priced;
    const counterparty = await this.#counterparty(input.counterparty);
    if (counterparty === null) return rejected('POLICY_DENIED');
    const action: ProofAction = {
      kind: 'proof',
      feeUsd: priced.fee.usd,
      maxFeeUsd: priced.fee.usd,
      counterparty: { contact: counterparty.agentId, ruleEligible: counterparty.eligible },
    };
    const pre = await this.#ctx.store.transaction((tx) =>
      evaluateProof(effective, action, { now, ledger: readBudgetLedger(tx) }),
    );
    if (pre.decision === 'deny') return rejected('POLICY_DENIED');
    return Object.freeze({
      status: 'ok',
      fee: priced.fee,
      decision: pre.decision,
      triggers: pre.decision === 'approval' ? proofTriggers(pre.triggers) : [],
    });
  }

  /**
   * Records a terms envelope this agent sent (the `offer` of a firm offer, kind OFFER; an `accept`,
   * kind ACCEPT) as the Record part of a commitment scope (04 §3.4.2). The scope's single approval
   * covers it, so no proof approval is asked here: the fee must be within `maxFeeUsd`, and the
   * proofs policy and budget are checked again in the transaction that stores the signed Record,
   * reserves its fee and claims the part (`claimTx`), before anything is submitted. A Record already
   * stored for the envelope is resent unchanged or reported, never signed again (04 §5).
   */
  async recordCommitment(input: {
    readonly envelopeId: string;
    readonly approvalId: string;
    readonly maxFeeUsd: string;
    /** The owner signed this scope (a policy grant is not an owner approval of the fee). */
    readonly ownerApproved: boolean;
    readonly claimTx: (tx: StoreTx, recordId: string, itemJson: string) => boolean;
  }): Promise<CommitmentRecordResult> {
    if (this.#platform === undefined) return rejected('PROOFS_UNAVAILABLE');
    const self = await this.#self();
    const row = await this.#envelope(input.envelopeId);
    if (row === undefined || row.direction !== 'out' || row.state !== 'ok') {
      return rejected('ENVELOPE_NOT_FOUND');
    }
    const payload = await this.#payload(row);
    if (payload === undefined || (payload.type !== 'offer' && payload.type !== 'accept')) {
      return rejected('ENVELOPE_NOT_FOUND');
    }
    const kind = this.#kit.recordKindForPayload(payload);
    if (kind === null) return rejected('NOT_NOTARIZABLE');
    // Already recorded, or signed and not landed: never sign a second Record (04 §5).
    const existing = await this.#ownRows(input.envelopeId);
    const live = existing.find((r) => r.status !== 'replaced' && r.status !== 'released');
    if (live !== undefined) return this.#continue(live);

    await this.#deps.identity.assertCanSend();
    const now = nowOf(this.#ctx);
    const deadline = now + RECORD_DEADLINE_SECONDS;
    const signer = await this.#deps.contacts.proofSigner(row.from_key);
    const expiresAt = signer?.agentCard.expiresAt ?? 0;
    if (expiresAt !== 0 && expiresAt <= deadline) return rejected('CARD_EXPIRED');

    const effective = await this.#deps.ownerActions.loadPolicy();
    const priced = await this.#price(self.agentId, effective);
    if (priced.status !== 'ok') return priced;
    const { fee, chain, quote } = priced;
    // The approval covers a fee of at most maxFeeUsd (04 §3.4.2), never more.
    if (compareUsd(fee.usd, input.maxFeeUsd) > 0) return rejected('FEE_ABOVE_APPROVED');
    const counterparty = row.contact_id === null ? null : await this.#counterparty(row.contact_id);
    if (counterparty === null) return rejected('ENVELOPE_NOT_FOUND');
    const action: ProofAction = {
      kind: 'proof',
      feeUsd: fee.usd,
      maxFeeUsd: fee.usd,
      counterparty: { contact: counterparty.agentId, ruleEligible: counterparty.eligible },
    };
    const built = this.#kit.buildRecord({
      chainId: chain.config.chainId,
      notary: chain.config.contracts.notary,
      signer: self.agentId,
      envelopeHash: row.envelope_hash,
      recipient: row.contact_id,
      kind: kind as RecordKind,
      feeToken: fee.token,
      maxFee: quote.total,
      deadline,
    });
    const signature = await this.#kit.signRecord(this.#ctx.keyStore, built);
    const stored = await this.#storeSigned({
      built,
      signature,
      envelopeId: input.envelopeId,
      fee,
      effective,
      action,
      approvalId: input.approvalId,
      ownerApproved: input.ownerApproved,
      claim: (tx, next) => input.claimTx(tx, next.record_id, next.record_json),
      replaces: undefined,
    });
    if (stored === undefined) return rejected('POLICY_CHANGED');
    return this.#submit(stored);
  }

  /**
   * A repeat of a commitment whose Record part is claimed (04 §3.4.2, §5): the stored signed Record
   * is submitted again unchanged, or its proof envelope sent once recorded. Never signs; never
   * throws (a failure leaves it to resubmitPending).
   */
  async resendRecord(envelopeId: string): Promise<void> {
    if (this.#platform === undefined) return;
    try {
      const live = (await this.#ownRows(envelopeId)).find(
        (r) => r.status !== 'replaced' && r.status !== 'released',
      );
      if (live !== undefined) await this.#continue(live);
    } catch {
      this.#log.warn('proof submit failed', { code: 'submit_error' });
    }
  }

  /** The automatic chain choice and its fee (07 §6.3), as `notarize` makes it, without override. */
  async #price(
    payer: string,
    effective: EffectivePolicy,
  ): Promise<
    | {
        readonly status: 'ok';
        readonly fee: ApprovalFee;
        readonly chain: ProofChain;
        readonly quote: Extract<ChainSelection, { status: 'ok' }>['quote'];
      }
    | { readonly status: 'needs_credits'; readonly topUp?: TopUpRoute }
    | ProofRejected
  > {
    const defaultChain =
      effective.mode === 'fail_closed' ? undefined : effective.policy.proofs.defaultChain;
    const selection = await this.#select(payer, defaultChain, undefined);
    if (selection.status === 'needs_credits') {
      return Object.freeze({ status: 'needs_credits', topUp: selection.topUp });
    }
    if (selection.status !== 'ok') return rejected('CHAIN_UNAVAILABLE');
    const chain = this.#chain(selection.chainId);
    if (chain === undefined) return rejected('UNSUPPORTED_CHAIN');
    const token = (selection.quote.tokenAddress ?? ZERO_ADDRESS).toLowerCase();
    const decimals = chain.config.feeTokens.find(
      (t) => t.symbol === selection.quote.token,
    )?.decimals;
    if (decimals === undefined) return rejected('CHAIN_UNAVAILABLE');
    const fee = feeContextFromQuote({ token, amount: selection.quote.total, decimals });
    return { status: 'ok', fee, chain, quote: selection.quote };
  }

  /**
   * The sender side of the `parentRecordId` rule (D-109; 05 §3.1, 04 §5.1): the chain must show a
   * record with this ID whose signer is this agent. Absent or another signer's is `PARENT_NOT_OWN`;
   * a read that fails is `CHAIN_UNAVAILABLE` (fail closed). Nothing from the chain is logged.
   */
  async #ownParent(
    chain: ProofChain,
    self: string,
    parent: string,
  ): Promise<'ok' | 'PARENT_NOT_OWN' | 'CHAIN_UNAVAILABLE'> {
    let stored: Awaited<ReturnType<ProofChain['state']['getRecord']>>;
    try {
      stored = await chain.state.getRecord(parent as Hex);
    } catch {
      return 'CHAIN_UNAVAILABLE';
    }
    if (stored === null) return 'PARENT_NOT_OWN';
    return String(stored.signer).toLowerCase() === self.toLowerCase() ? 'ok' : 'PARENT_NOT_OWN';
  }

  /** Signs nothing: stores the signed Record with its salt and reserves its fee, all or nothing. */
  async #storeSigned(input: {
    readonly built: BuiltRecord;
    readonly signature: string;
    readonly envelopeId: string;
    readonly fee: ApprovalFee;
    readonly effective: EffectivePolicy;
    readonly action: ProofAction;
    readonly approvalId: string | null;
    /**
     * Runs first in the storing transaction, with the row about to be stored (a commitment's Record
     * part is claimed here, M1-9d-3); false stores nothing.
     */
    readonly claim: ((tx: StoreTx, row: Row<'proofs'>) => boolean) | undefined;
    /** The owner approved this exact fee (default: an approval is named). A grant is not one. */
    readonly ownerApproved?: boolean;
    /** The row and ledger entry of the Record this one replaces (04 §5). */
    readonly replaces: { readonly recordId: string } | undefined;
    /** Keep the sender's receipt-request marker with this Record (M1-33d). */
    readonly receiptRequest?: boolean;
  }): Promise<Row<'proofs'> | undefined> {
    const { built } = input;
    const now = nowOf(this.#ctx);
    const recordId = built.recordId;
    const salt = await seal(this.#ctx, 'proofs', 'salt', [recordId], built.salt ?? '');
    const row: Row<'proofs'> = {
      record_id: recordId,
      envelope_id: input.envelopeId,
      chain_id: built.domain.chainId,
      record_json: canonicalize({ record: built.record, signature: input.signature } as never),
      tx_hash: null,
      status: 'signed',
      fee_token: input.fee.token,
      fee_amount: input.fee.amount,
      salt,
      created_at: now,
    };
    const entryId = `led_${recordId.slice(2, 34)}`;
    const requestKey = receiptRequestKey(input.envelopeId);
    const requestSalt =
      input.receiptRequest === true
        ? await seal(this.#ctx, 'proofs', 'salt', [requestKey], '')
        : undefined;
    try {
      await this.#ctx.store.transaction((tx) => {
        if (input.claim !== undefined && !input.claim(tx, row)) throw new Abort();
        let replacedEntry: string | undefined;
        if (input.replaces !== undefined) {
          const old = tx.select('budget_ledger', { record_id: input.replaces.recordId })[0];
          if (
            releaseProofReservation(tx, {
              recordId: input.replaces.recordId,
              now,
              chainHasRecord: false,
            }) !== 'released'
          ) {
            throw new Abort();
          }
          replacedEntry = old?.entry_id;
          tx.update('proofs', { record_id: input.replaces.recordId }, { status: 'replaced' });
        }
        const check = checkAndReserveProof(tx, {
          effective: input.effective,
          action: input.action,
          now,
          reservation: {
            entryId,
            recordId,
            chainId: row.chain_id,
            approvalId: input.approvalId,
            deadline: built.record.deadline,
          },
          ownerApproved: input.ownerApproved ?? input.approvalId !== null,
        });
        // Policy or budget moved between the check and this transaction: nothing is kept.
        if (!check.reserved) throw new Abort();
        if (replacedEntry !== undefined) {
          tx.update('budget_ledger', { entry_id: entryId }, { replaces: replacedEntry });
        }
        tx.insert('proofs', row);
        // The request travels in the `proof` envelope only, never in the signed item (M1-33d).
        if (
          requestSalt !== undefined &&
          tx.get('proofs', { record_id: requestKey }) === undefined
        ) {
          tx.insert('proofs', {
            record_id: requestKey,
            envelope_id: input.envelopeId,
            chain_id: row.chain_id,
            record_json: '{}',
            tx_hash: null,
            status: RECEIPT_REQUEST,
            fee_token: null,
            fee_amount: null,
            salt: requestSalt,
            created_at: now,
          });
        }
      });
    } catch (error) {
      if (error instanceof Abort) return undefined;
      throw error;
    }
    return row;
  }

  /** A stored own row: resend it if it has not landed, or report it. */
  async #continue(row: Row<'proofs'>): Promise<CommitmentRecordResult> {
    if (ON_CHAIN.includes(row.status)) {
      if (row.status === 'recorded') await this.#announce(row);
      return this.#resultOf(row, true);
    }
    if (row.status === 'conflict') {
      return { status: 'error', code: 'RECORD_CONFLICT', recordId: row.record_id };
    }
    if (row.status === 'failed') {
      return { status: 'error', code: 'RECORD_FAILED', recordId: row.record_id };
    }
    return this.#submit(row);
  }

  /** Submits the stored signed item (07 §6.2): the same bytes every time (04 §5). */
  async #submit(row: Row<'proofs'>): Promise<CommitmentRecordResult> {
    const chain = this.#chain(row.chain_id);
    if (chain === undefined) return rejected('UNSUPPORTED_CHAIN');
    const item = parseJson(row.record_json) as unknown as SignedItem;
    let outcome: ProofOutcome;
    try {
      outcome = await chain.submitter.notarize(item);
    } catch {
      this.#log.warn('proof submit failed', { code: 'submit_error' });
      return this.#setStatus(row, 'pending');
    }
    switch (outcome.status) {
      case 'recorded':
        await this.#settle(row, 'recorded');
        await this.#announce({ ...row, status: 'recorded' });
        return this.#resultOf({ ...row, status: 'recorded' }, outcome.confirmed);
      case 'needs_credits': {
        await this.#setStatus(row, 'needs_credits');
        const sel = outcome.selection;
        return Object.freeze({
          status: 'needs_credits',
          recordId: row.record_id,
          ...(sel?.status === 'needs_credits' ? { topUp: sel.topUp } : {}),
        });
      }
      case 'failed':
        await this.#setStatus(row, 'failed');
        this.#log.info('proof refused by the chain', { code: 'record_failed' });
        return { status: 'error', code: 'RECORD_FAILED', recordId: row.record_id };
      case 'conflict':
        await this.#setStatus(row, 'conflict');
        return { status: 'error', code: 'RECORD_CONFLICT', recordId: row.record_id };
      case 'pending':
        return this.#setStatus(row, 'pending');
    }
  }

  async #setStatus(row: Row<'proofs'>, status: OwnStatus): Promise<CommitmentRecordResult> {
    await this.#ctx.store.transaction((tx) =>
      tx.update('proofs', { record_id: row.record_id, status: { in: [...LIVE] } }, { status }),
    );
    return this.#resultOf({ ...row, status }, false);
  }

  /** On-chain: the reservation becomes `charged` (at most `maxFee`, 06 §3), once. */
  async #settle(row: Row<'proofs'>, status: 'recorded'): Promise<void> {
    const usd = this.#feeOf(row)?.usd;
    const now = nowOf(this.#ctx);
    await this.#ctx.store.transaction((tx) => {
      tx.update(
        'proofs',
        { record_id: row.record_id, status: { in: [...LIVE, 'failed'] } },
        { status },
      );
      if (usd !== undefined)
        settleProofCharged(tx, { recordId: row.record_id, chargedUsd: usd, now });
      // A commitment's Record part (M1-9d-3; 04 §3.4.2): `claimed` → `done` once the chain shows it.
      tx.update(
        'commitment_parts',
        { part: 'record', item_ref: row.record_id, state: 'claimed' },
        { state: 'done', done_at: now, updated_at: now },
      );
    });
    this.#selector?.clear();
  }

  #feeOf(row: Row<'proofs'>): ProofFee | undefined {
    const chain = this.#chain(row.chain_id);
    if (chain === undefined || row.fee_token === null || row.fee_amount === null) return undefined;
    const token = chain.config.feeTokens.find(
      (t) => (t.address ?? ZERO_ADDRESS).toLowerCase() === row.fee_token,
    );
    if (token === undefined) return undefined;
    return feeContextFromQuote({
      token: row.fee_token,
      amount: BigInt(row.fee_amount),
      decimals: token.decimals,
    });
  }

  #resultOf(row: Row<'proofs'>, confirmed: boolean): CommitmentRecordResult {
    const chain = this.#chain(row.chain_id);
    const fee = this.#feeOf(row);
    const base = {
      recordId: row.record_id,
      chainId: row.chain_id,
      chain: chain?.config.key ?? String(row.chain_id),
      fee: fee ?? { token: row.fee_token ?? ZERO_ADDRESS, amount: row.fee_amount ?? '0', usd: '0' },
    };
    return ON_CHAIN.includes(row.status)
      ? Object.freeze({ status: 'ok', ...base, confirmed })
      : Object.freeze({ status: 'submitted', ...base });
  }

  /**
   * The follow-up `proof` envelope (04 §3.4): `{envelopeId, chainId, recordId, salt}` to the
   * recipient, stored with its outbox rows in the transaction that marks the row `announced`.
   * A failure leaves the row `recorded` for the next pass. A self-note has no recipient.
   */
  async #announce(row: Row<'proofs'>): Promise<void> {
    const envelope = await this.#envelope(row.envelope_id);
    const contactId = envelope?.contact_id ?? null;
    if (contactId === null) {
      await this.#ctx.store.transaction((tx) =>
        tx.update(
          'proofs',
          { record_id: row.record_id, status: 'recorded' },
          { status: 'announced' },
        ),
      );
      return;
    }
    try {
      const { envelopes, outbox, ownerActions } = this.#deps;
      outbox.requireTransport();
      const policy = await ownerActions.loadPolicy();
      if (
        evaluate(policy, { kind: 'envelope.send', contact: contactId, sizeBytes: 0 }) !== 'allow'
      ) {
        return;
      }
      const salt = await open(this.#ctx, 'proofs', 'salt', [row.record_id], row.salt);
      // D-107: the signed Record and its signature, exactly as submitted, so the recipient can
      // export a pack too. Only inside this end-to-end encrypted envelope (I-2, I-3).
      const item = parseJson(row.record_json) as unknown as SignedItem;
      // M1-33d: the user's delivery receipt request, kept per envelope (a replacement keeps it).
      const requested = await this.#ctx.store.transaction((tx) =>
        senderRequestedTx(tx, row.envelope_id),
      );
      const { built, row: envRow } = await envelopes.prepare({
        to: { contact: contactId },
        payload: {
          type: 'proof',
          body: {
            envelopeId: row.envelope_id,
            chainId: row.chain_id,
            recordId: row.record_id,
            salt,
            record: item.record as never,
            signature: item.signature,
            ...(requested ? { receiptRequest: 'delivered' as const } : {}),
          },
          replyTo: row.envelope_id,
          files: [],
        },
      });
      const routes = await outbox.routes(await outbox.contactPeer(contactId));
      const rows = await outbox.prepareRows(built.envelope, routes);
      const marked = await this.#ctx.store.transaction((tx) => {
        const n = tx.update(
          'proofs',
          { record_id: row.record_id, status: 'recorded' },
          { status: 'announced' },
        );
        if (n !== 1) return false;
        tx.insert('envelopes', envRow);
        for (const r of rows) tx.insert('outbox', r);
        return true;
      });
      if (!marked) return;
      try {
        await outbox.publishEnvelope(built.envelope.id);
      } catch {
        // The rows stay pending; the outbox retries (07 §3.2).
      }
    } catch {
      this.#log.warn('proof envelope not sent', { code: 'announce_failed' });
    }
  }

  // --- resubmission and replacement (04 §5) ----------------------------------------------------

  /**
   * Resends every own Record that has not landed, unchanged; signs a replacement only when the
   * chain shows the earlier one can never land, and never after an approval's `expiresAt`; sends
   * the `proof` envelope of a recorded one. A failed chain read signs nothing.
   */
  async resubmitPending(): Promise<ResubmitSummary> {
    if (this.#platform === undefined) return { resent: 0, replaced: 0, recorded: 0 };
    const rows = await this.#ctx.store.transaction((tx) =>
      tx.select('proofs', { status: { in: [...LIVE, 'recorded', 'failed'] } }),
    );
    let resent = 0;
    let replaced = 0;
    let recorded = 0;
    const receiptRows = await this.#ctx.store.transaction((tx) =>
      tx.select('proofs', { status: RECEIPT_SIGNED }),
    );
    for (const row of receiptRows) {
      resent += 1;
      const outcome = await this.#postReceipt(row);
      if (outcome === 'recorded' || outcome === 'replaced') recorded += 1;
      if (outcome === 'replaced' || outcome === 'replaced_open') replaced += 1;
    }
    for (const row of rows) {
      if (row.status === 'recorded') {
        await this.#announce(row);
        continue;
      }
      const chain = this.#chain(row.chain_id);
      if (chain === undefined) continue;
      const item = parseJson(row.record_json) as unknown as SignedItem;
      if (row.status !== 'failed') {
        resent += 1;
        const r = await this.#submit(row);
        if (r.status === 'ok') {
          recorded += 1;
          continue;
        }
      }
      const now = nowOf(this.#ctx);
      if (now <= item.record.deadline) continue;
      let allowed: boolean;
      try {
        allowed = await this.#kit.replacementAllowed(chain.state, {
          recordId: row.record_id,
          deadline: item.record.deadline,
        });
      } catch {
        allowed = false;
      }
      if (!allowed) continue;
      if (row.status === 'failed') {
        // The contract refused it: release the reservation, sign nothing new.
        await this.#ctx.store.transaction((tx) => {
          releaseProofReservation(tx, { recordId: row.record_id, now, chainHasRecord: false });
          tx.update(
            'proofs',
            { record_id: row.record_id, status: 'failed' },
            { status: 'released' },
          );
        });
        continue;
      }
      const out = await this.#replace(row, item);
      if (out !== undefined) {
        replaced += 1;
        if (out.status === 'ok') recorded += 1;
      }
    }
    return { resent, replaced, recorded };
  }

  /** One replacement Record: new nonce, fresh salt, new deadline, every other field unchanged. */
  async #replace(row: Row<'proofs'>, item: SignedItem): Promise<NotarizeResult | undefined> {
    const chain = this.#chain(row.chain_id) as ProofChain;
    const now = nowOf(this.#ctx);
    const entry = await this.#ctx.store.transaction(
      (tx) => tx.select('budget_ledger', { record_id: row.record_id, state: 'reserved' })[0],
    );
    if (entry === undefined) return undefined;
    // An approved Record is not replaced after its approval's expiresAt (for a commitment, the
    // scope's: the row's expires_at never outlives it, 04 §3.4.2).
    let ownerApproved = false;
    if (entry.approval_id !== null) {
      const approval = await this.#ctx.store.transaction((tx) =>
        tx.get('approvals', { approval_id: entry.approval_id as string }),
      );
      if (approval === undefined || now > approval.expires_at) return undefined;
      // A policy grant is a ledger row, never the owner's approval of a fee (04 §3.4.2).
      ownerApproved = approval.source === 'owner';
    }
    const envelope = await this.#envelope(row.envelope_id);
    if (envelope === undefined) return undefined;
    const fee = this.#feeOf(row);
    if (fee === undefined) return undefined;
    const r = item.record;
    const built = this.#kit.buildRecord({
      chainId: row.chain_id,
      notary: chain.config.contracts.notary,
      signer: r.signer,
      envelopeHash: r.envelopeHash,
      recipient: envelope.contact_id,
      parentRecordId: r.parentRecordId,
      appId: r.appId,
      kind: r.kind as RecordKind,
      feeToken: r.feeToken,
      maxFee: BigInt(r.maxFee),
      deadline: now + RECORD_DEADLINE_SECONDS,
    });
    const signature = await this.#kit.signRecord(this.#ctx.keyStore, built);
    const counterparty =
      envelope.contact_id === null ? null : await this.#counterparty(envelope.contact_id);
    const stored = await this.#storeSigned({
      built,
      signature,
      envelopeId: row.envelope_id,
      fee,
      effective: await this.#deps.ownerActions.loadPolicy(),
      action: {
        kind: 'proof',
        feeUsd: fee.usd,
        maxFeeUsd: fee.usd,
        counterparty:
          counterparty === null
            ? null
            : { contact: counterparty.agentId, ruleEligible: counterparty.eligible },
      },
      approvalId: entry.approval_id,
      ownerApproved,
      // A commitment's Record part follows its stored item (04 §3.4.2 "A signed item that did not
      // land"): same part, still `claimed`, the replacement in the old item's place.
      claim: (tx, next) => {
        const part = tx.select('commitment_parts', {
          part: 'record',
          item_ref: row.record_id,
          state: 'claimed',
        })[0];
        if (part !== undefined) {
          tx.update(
            'commitment_parts',
            { approval_id: part.approval_id, part: 'record', item_ref: row.record_id },
            {
              item_ref: next.record_id,
              item_json: next.record_json,
              replacements: part.replacements + 1,
              updated_at: now,
            },
          );
        }
        return true;
      },
      replaces: { recordId: row.record_id },
    });
    if (stored === undefined) return undefined;
    return this.#submit(stored);
  }

  /**
   * One stored receipt, posted again unchanged; replaced (04 §5) only when the chain shows the
   * earlier one can never land. `recorded`: on-chain now; `replaced`: a replacement landed;
   * `replaced_open`: a replacement was signed and is still open; `open`: still queued.
   */
  async #postReceipt(
    row: Row<'proofs'>,
    waitMs?: number,
  ): Promise<'recorded' | 'replaced' | 'replaced_open' | 'open' | 'failed'> {
    const status = await this.#submitReceipt(row, waitMs);
    if (status === 'recorded') return 'recorded';
    if (status === 'terminal') return 'failed';
    if (!(await this.#replaceReceipt(row))) return 'open';
    const after = await this.#ctx.store.transaction((tx) =>
      tx.get('proofs', { record_id: row.record_id }),
    );
    return after?.status === RECEIPT_RECORDED ? 'replaced' : 'replaced_open';
  }

  /**
   * The receipt queue (D-114; 07 §7; M1-34-b): a signed receipt that no submitter took when it was
   * signed stays stored (`receipt_signed`) and is posted here on a later sync pass, at most
   * QUEUED_RECEIPTS_PER_PASS per pass, least recently tried first. The same signed bytes are sent
   * until they land (04 §5); the proof stays valid with fewer receipts meanwhile. Receipts go only
   * through the submitters, which the sender's proof fee covers: nothing here pays from this
   * agent's account or asks it for credits. Each post waits at most QUEUED_RECEIPT_WAIT_MS for
   * inclusion. A receipt the chain refuses for good leaves the queue (`receipt_failed`). `only`
   * limits the pass to those queued IDs. Never throws; returns how many are on-chain now.
   */
  async postQueuedReceipts(only?: ReadonlySet<string>): Promise<number> {
    if (this.#platform === undefined) return 0;
    let rows: Row<'proofs'>[];
    try {
      rows = await this.#ctx.store.transaction((tx) =>
        tx.select('proofs', { status: RECEIPT_SIGNED }),
      );
    } catch {
      this.#log.warn('queued receipts not read', { code: 'submit_error' });
      return 0;
    }
    const live = new Set(rows.map((r) => r.record_id));
    for (const id of [...this.#receiptTries.keys()]) {
      if (!live.has(id)) this.#receiptTries.delete(id);
    }
    this.#receiptPass += 1;
    const tried = (r: Row<'proofs'>) => this.#receiptTries.get(r.record_id) ?? 0;
    const due = rows
      .filter((r) => only === undefined || only.has(r.record_id))
      .sort((x, y) => tried(x) - tried(y) || x.created_at - y.created_at)
      .slice(0, QUEUED_RECEIPTS_PER_PASS);
    let landed = 0;
    for (const row of due) {
      this.#receiptTries.set(row.record_id, this.#receiptPass);
      try {
        const outcome = await this.#postReceipt(row, QUEUED_RECEIPT_WAIT_MS);
        if (outcome === 'recorded' || outcome === 'replaced') landed += 1;
      } catch {
        this.#log.warn('queued receipt not posted', { code: 'submit_error' });
      }
    }
    return landed;
  }

  // --- the recipient: proof envelopes and receipts ---------------------------------------------

  /**
   * After a processing pass (syncInbox, the live subscription): checks each new `proof` envelope
   * from a contact on-chain, stores the record, signs DELIVERED per policy and the deferred
   * ACCEPTED (07 §2.1 step 4). Never throws; returns the receipts signed and the contacts flagged
   * for a `proof` body that does not match the chain (04 §3.4, M1-7g-c).
   */
  async processInbound(reports: readonly InboundReport[]): Promise<ProofInboundResult> {
    const flags: InboundReport[] = [];
    if (this.#platform === undefined) return { signed: 0, reports: flags };
    // Receipts no submitter took on an earlier pass (D-114). They are posted after this pass's new
    // envelopes (IR-M1-34-b-1 M-1); the ones this pass signs were just submitted and wait for the
    // next pass.
    let queued: ReadonlySet<string> = new Set();
    try {
      queued = new Set(
        (
          await this.#ctx.store.transaction((tx) => tx.select('proofs', { status: RECEIPT_SIGNED }))
        ).map((r) => r.record_id),
      );
    } catch {
      this.#log.warn('queued receipts not read', { code: 'submit_error' });
    }
    let signed = 0;
    // Bodies kept pending by an earlier pass (a failed chain read): expired ones go first, the rest
    // are checked again after this pass's new envelopes (04 §3.4, M1-7g-b).
    let pending: readonly Row<'proofs'>[] = [];
    try {
      pending = await this.#pendingAfterExpiry();
    } catch {
      this.#log.warn('pending proof envelopes not read', { code: 'proof_inbound_error' });
    }
    for (const report of reports) {
      if (report.outcome !== 'ok' || report.envelopeId === undefined) continue;
      if (report.contactId === undefined) continue;
      try {
        signed += await this.#inbound(report.envelopeId, report.contactId, flags);
        signed += await this.#released(report.envelopeId, report.contactId, flags);
      } catch {
        this.#log.warn('proof envelope not processed', { code: 'proof_inbound_error' });
      }
    }
    for (const row of pending) {
      try {
        signed += await this.#recheck(row, flags);
      } catch {
        this.#log.warn('proof envelope not processed', { code: 'proof_inbound_error' });
      }
    }
    if (queued.size > 0) await this.postQueuedReceipts(queued);
    return { signed, reports: flags };
  }

  /** Drops pending bodies older than PENDING_SECONDS (`proof_unchecked`); returns the rest. */
  async #pendingAfterExpiry(): Promise<readonly Row<'proofs'>[]> {
    const now = nowOf(this.#ctx);
    const { expired, rest } = await this.#ctx.store.transaction((tx) => {
      const old = tx.select('proofs', {
        status: PENDING,
        created_at: { lt: now - PENDING_SECONDS },
      });
      for (const r of old) tx.delete('proofs', { record_id: r.record_id, status: PENDING });
      return { expired: old.length, rest: tx.select('proofs', { status: PENDING }) };
    });
    for (let i = 0; i < expired; i += 1) {
      // Fixed code only: nothing from the body or the chain (I-5, I-7).
      this.#log.warn('proof envelope dropped unchecked (proof_unchecked)', {
        code: 'proof_unchecked',
      });
    }
    return rest;
  }

  /** One pending body, checked again from the existing checks on (04 §3.4). */
  async #recheck(row: Row<'proofs'>, flags: InboundReport[]): Promise<number> {
    const proofEnvelopeId = row.record_id.slice(PENDING_PREFIX.length);
    const envelope = await this.#envelope(proofEnvelopeId);
    if (
      envelope?.contact_id == null ||
      envelope.state !== 'ok' ||
      !row.record_id.startsWith(PENDING_PREFIX)
    ) {
      // The proof envelope is gone (pruned or removed with its contact) or was refused by a
      // concurrent pass (an orphan row, IR-M1-7g-c-1): nothing left to check.
      await this.#ctx.store.transaction((tx) =>
        tx.delete('proofs', { record_id: row.record_id, status: PENDING }),
      );
      return 0;
    }
    return this.#inbound(proofEnvelopeId, envelope.contact_id, flags);
  }

  /**
   * Keeps a body whose chain read failed (never a pass, never a mismatch), bounded like the wait for
   * a `proof` that arrives before its message: past MAX_PENDING it is dropped as `proof_unchecked`.
   */
  async #pend(
    proofEnvelopeId: string,
    envelopeId: string,
    chainId: number,
    contactId: string,
  ): Promise<void> {
    const now = nowOf(this.#ctx);
    const key = `${PENDING_PREFIX}${proofEnvelopeId}`;
    const empty = await seal(this.#ctx, 'proofs', 'salt', [key], '');
    const kept = await this.#ctx.store.transaction((tx) => {
      if (tx.get('proofs', { record_id: key }) !== undefined) return 'kept';
      // Refused by a concurrent pass in the meantime: no orphan row (IR-M1-7g-c-1).
      if (tx.get('envelopes', { envelope_id: proofEnvelopeId })?.state !== 'ok') return 'gone';
      const pending = tx.select('proofs', { status: PENDING });
      if (pending.length >= MAX_PENDING) return 'full';
      // The contact's share (M1-7g-c): a pending row belongs to the contact of its proof envelope.
      let mine = 0;
      for (const r of pending) {
        const proofEnvelope = tx.get('envelopes', {
          envelope_id: r.record_id.slice(PENDING_PREFIX.length),
        });
        if (proofEnvelope?.state === 'ok' && proofEnvelope.contact_id === contactId) mine += 1;
      }
      if (mine >= PROOF_PENDING_PER_CONTACT) return 'full';
      tx.insert('proofs', {
        record_id: key,
        envelope_id: envelopeId,
        chain_id: chainId,
        record_json: '{}',
        tx_hash: null,
        status: PENDING,
        fee_token: null,
        fee_amount: null,
        salt: empty,
        created_at: now,
      });
      return 'new';
    });
    if (kept === 'new') {
      this.#log.info('proof envelope pending a chain read', { code: 'proof_pending' });
    } else if (kept === 'full') {
      this.#log.warn('proof envelope dropped unchecked (proof_unchecked)', {
        code: 'proof_unchecked',
      });
    }
  }

  /** The proof envelopes that waited for this message (L5): each is checked once, now. */
  async #released(envelopeId: string, contactId: string, flags: InboundReport[]): Promise<number> {
    const now = nowOf(this.#ctx);
    const waiting = await this.#ctx.store.transaction((tx) => {
      tx.delete('proofs', { status: AWAITING, created_at: { lt: now - AWAITING_SECONDS } });
      const rows = tx.select('proofs', { envelope_id: envelopeId, status: AWAITING });
      for (const r of rows) tx.delete('proofs', { record_id: r.record_id, status: AWAITING });
      return rows;
    });
    let signed = 0;
    for (const r of waiting) {
      signed += await this.#inbound(r.record_id.slice(AWAITING_PREFIX.length), contactId, flags);
    }
    return signed;
  }

  /**
   * Keeps a proof envelope whose message is not here yet; bounded in number and time, and per
   * contact (M1-7g-d): past MAX_AWAITING, or past the contact's share, it is dropped as
   * `proof_unchecked`.
   */
  async #await(
    proofEnvelopeId: string,
    envelopeId: string,
    chainId: number,
    contactId: string,
  ): Promise<void> {
    const now = nowOf(this.#ctx);
    const key = `${AWAITING_PREFIX}${proofEnvelopeId}`;
    const empty = await seal(this.#ctx, 'proofs', 'salt', [key], '');
    const kept = await this.#ctx.store.transaction((tx) => {
      tx.delete('proofs', { status: AWAITING, created_at: { lt: now - AWAITING_SECONDS } });
      if (tx.get('proofs', { record_id: key }) !== undefined) return 'kept';
      // A waiting row whose proof envelope was refused, or is gone, can never be checked: it is
      // removed here and releases its slot, as a pending row is (04 §3.4, M1-7g-f).
      const waiting: Row<'proofs'>[] = [];
      let mine = 0;
      for (const r of tx.select('proofs', { status: AWAITING })) {
        const proofEnvelope = r.record_id.startsWith(AWAITING_PREFIX)
          ? tx.get('envelopes', { envelope_id: r.record_id.slice(AWAITING_PREFIX.length) })
          : undefined;
        if (proofEnvelope?.state !== 'ok') {
          tx.delete('proofs', { record_id: r.record_id, status: AWAITING });
          continue;
        }
        waiting.push(r);
        // The contact's share: a waiting row belongs to the contact of its proof envelope.
        if (proofEnvelope.contact_id === contactId) mine += 1;
      }
      if (waiting.length >= MAX_AWAITING) return 'full';
      if (mine >= PROOF_AWAITING_PER_CONTACT) return 'full';
      tx.insert('proofs', {
        record_id: key,
        envelope_id: envelopeId,
        chain_id: chainId,
        record_json: '{}',
        tx_hash: null,
        status: AWAITING,
        fee_token: null,
        fee_amount: null,
        salt: empty,
        created_at: now,
      });
      return 'new';
    });
    if (kept === 'full') {
      // Fixed code only: nothing from the body (I-5, I-7).
      this.#log.warn('proof envelope dropped unchecked (proof_unchecked)', {
        code: 'proof_unchecked',
      });
    }
  }

  async #inbound(
    proofEnvelopeId: string,
    contactId: string,
    flags: InboundReport[],
  ): Promise<number> {
    const row = await this.#envelope(proofEnvelopeId);
    if (row?.type !== 'proof' || row.direction !== 'in' || row.state !== 'ok') return 0;
    if (row.contact_id !== contactId) return 0;
    const payload = await this.#payload(row);
    if (payload?.type !== 'proof') return 0;
    const body = proofBodySchema.safeParse(payload.body);
    if (!body.success) return 0;
    const { envelopeId, chainId, recordId, salt } = body.data;
    if ((await this.#envelope(envelopeId)) === undefined) {
      // The message is not here yet (relays deliver out of order): check it when it arrives.
      await this.#await(proofEnvelopeId, envelopeId, chainId, contactId);
      return 0;
    }
    const signedItem =
      body.data.record === undefined || body.data.signature === undefined
        ? undefined
        : { record: body.data.record, signature: body.data.signature };
    // The sender's request is its content (I-5): kept as a flag, never signs anything (M1-33d).
    const request = body.data.receiptRequest === 'delivered' ? 'delivered' : undefined;
    const pendingKey = `${PENDING_PREFIX}${proofEnvelopeId}`;
    const check = await this.#checkRecord(
      contactId,
      envelopeId,
      chainId,
      recordId,
      salt,
      signedItem,
    );
    if (check.status === 'unavailable') {
      await this.#pend(proofEnvelopeId, envelopeId, chainId, contactId);
      return 0;
    }
    if (check.status === 'mismatch') {
      // The whole body is dropped and the contact is flagged (04 §3.4, M1-7g-c): the `proof`
      // envelope is stored as refused with the fixed code, in the transaction that drops its pending
      // row. Compare-and-set on `ok`, so a concurrent pass flags it once. No proof is stored, so no
      // receipt is ever signed for it (D-109). No tool clears a refusal (I-4).
      const reason = check.code ?? 'proof_mismatch';
      const now = nowOf(this.#ctx);
      const refused = await this.#ctx.store.transaction((tx) => {
        tx.delete('proofs', { record_id: pendingKey, status: PENDING });
        return tx.update(
          'envelopes',
          { envelope_id: proofEnvelopeId, contact_id: contactId, state: 'ok', type: 'proof' },
          {
            state: 'refused',
            refused_reason: reason,
            refused_at: now,
            envelope_json: null,
            payload_json: null,
          },
        );
      });
      if (refused === 1) {
        const flag: InboundReport = {
          envelopeId: proofEnvelopeId,
          outcome: 'refused',
          reason,
          contactId,
          flagged: true,
        };
        flags.push(Object.freeze(flag));
      }
      // Fixed code only: nothing from the proof body or the chain answer (I-5, I-7).
      if (reason === 'proof_parent_mismatch') {
        this.#log.warn(
          'proof envelope names another signer’s record as parent (proof_parent_mismatch)',
          { code: 'proof_parent_mismatch' },
        );
      } else {
        this.#log.warn('proof envelope does not match the chain (proof_mismatch)', {
          code: 'proof_mismatch',
        });
      }
      return 0;
    }
    const checked = check.received;
    const sealedSalt = await seal(this.#ctx, 'proofs', 'salt', [recordId], salt);
    const now = nowOf(this.#ctx);
    // The Record and signature exactly as received, after every check passed (04 §3.4, D-107).
    const item: ReceivedItem = {
      received: checked,
      ...(signedItem ?? {}),
      ...(request === undefined ? {} : { receiptRequest: request }),
    };
    await this.#ctx.store.transaction((tx) => {
      tx.delete('proofs', { record_id: pendingKey, status: PENDING });
      const existing = tx.get('proofs', { record_id: recordId });
      if (existing !== undefined) {
        // An older sender's body stored first: a later body with the checked Record completes it,
        // keeping a request either body made (M1-33d).
        const held = this.#receivedItem(existing);
        if (
          signedItem !== undefined &&
          existing.status === 'received' &&
          existing.envelope_id === envelopeId &&
          held?.record === undefined
        ) {
          const merged: ReceivedItem =
            held?.receiptRequest === 'delivered' ? { ...item, receiptRequest: 'delivered' } : item;
          tx.update(
            'proofs',
            { record_id: recordId, status: 'received', record_json: existing.record_json },
            { record_json: canonicalize(merged as never) },
          );
        }
        return;
      }
      tx.insert('proofs', {
        record_id: recordId,
        envelope_id: envelopeId,
        chain_id: chainId,
        record_json: canonicalize(item as never),
        tx_hash: null,
        status: 'received',
        fee_token: null,
        fee_amount: null,
        salt: sealedSalt,
        created_at: now,
      });
    });
    const stored = await this.#ctx.store.transaction((tx) =>
      tx.get('proofs', { record_id: recordId }),
    );
    if (stored?.status !== 'received' || stored.envelope_id !== envelopeId) return 0;
    let signed = 0;
    const effective = await this.#deps.ownerActions.loadPolicy();
    // The record's signer is this contact (checked above); its contact rule may replace the global
    // `receipts.autoDelivered` while it is paired and not blocked or revoked (06 §3, D-109).
    const signer = await this.#counterparty(contactId);
    const auto = evaluate(effective, {
      kind: 'receipt.auto',
      receipt: 'delivered',
      counterparty:
        signer === null ? null : { contact: signer.agentId, ruleEligible: signer.eligible },
    });
    if (auto === 'allow') {
      if ((await this.#signReceipt(stored, 'DELIVERED')).status === 'ok') signed += 1;
    }
    if (checked.kind === RECORD_KIND.OFFER || checked.kind === RECORD_KIND.ACCEPT) {
      signed += await this.#deferred(stored, checked);
    }
    return signed;
  }

  /**
   * The 05 §3.3 / 04 §3.4 recipient check before any receipt: the record exists on-chain, its signer
   * is the contact, its envelope hash is the stored envelope's (from that contact, to us), its kind
   * is the 05 §3.1 kind of the payload held, and its commitment opens to this agent. With a signed
   * Record in the body (D-107), checks 1–5 of 04 §3.4 as well: the local ones before any read, so a
   * definite mismatch never waits on the chain.
   *
   * Definite (`mismatch`, the contact is flagged; M1-7g-c, IR-M1-7g-c-1): the body contradicts the
   * message held from this contact (checks 1, 2 and 4 on the signed Record), or an answered read of
   * a record that exists contradicts it (signer, kind, envelope hash, commitment, struct hash,
   * signature, or a parent that exists and has another signer). Everything else is `unavailable`
   * (kept pending, checked again, dropped unchecked after 7 days, never flagged): a read that fails,
   * a record or parent not visible yet (zero signer or timestamp, or none), a chain this agent does
   * not know, and local state that is not ready (the message not `ok` yet, its payload not held, a
   * kind this build does not map, a card lookup that fails).
   */
  async #checkRecord(
    contactId: string,
    envelopeId: string,
    chainId: number,
    recordId: string,
    salt: string,
    signedItem: { readonly record: RecordJson; readonly signature: string } | undefined,
  ): Promise<RecordCheck> {
    // A chain this agent does not know (config or version skew): never a flag.
    const chain = this.#chain(chainId);
    if (chain === undefined) return UNAVAILABLE;
    const target = await this.#envelope(envelopeId);
    // The body names a message this contact did not send to this agent: a contradiction.
    if (target === undefined || target.direction !== 'in' || target.contact_id !== contactId) {
      return MISMATCH;
    }
    // Local state not ready (still `received`, e.g. a terms offer waiting for a link): retried.
    if (target.state !== 'ok') return UNAVAILABLE;
    const payload = await this.#payload(target);
    if (payload === undefined) return UNAVAILABLE;
    const kind = this.#kit.recordKindForPayload(payload);
    if (kind === null) return UNAVAILABLE;
    const self = await this.#self();
    const contact = contactId.toLowerCase();
    const heldHash = target.envelope_hash.toLowerCase();
    let mine: string;
    try {
      mine = encodeHex0x(recipientCommitment(self.agentId, salt));
    } catch {
      return MISMATCH;
    }
    const notary = chain.config.contracts.notary.toLowerCase();
    let structHash: string | undefined;
    if (signedItem !== undefined) {
      const r = signedItem.record;
      // 1. The held envelope's hash, and a commitment that opens to this agent with this salt.
      if (r.envelopeHash !== heldHash || r.recipientCommitment !== mine) return MISMATCH;
      // 2. recordId = keccak256(abi.encode(chainId, notary, signer, nonce)) (05 §3.3).
      try {
        const derived = this.#kit.computeRecordId(chainId, notary, r.signer, BigInt(r.nonce));
        if (derived.toLowerCase() !== recordId) return MISMATCH;
      } catch {
        return MISMATCH;
      }
      // 3 (the part that needs no read). The kind mapping of the envelope held (05 §3.1).
      if (r.kind !== kind) return MISMATCH;
      // 4. The signer is the agentEvm of the contact's card for the envelope's key epoch.
      if (r.signer !== contact) return MISMATCH;
      try {
        const card = await this.#deps.contacts.proofSigner(target.from_key);
        if (card !== undefined && card.agentCard.agentEvm.toLowerCase() !== r.signer) {
          return MISMATCH;
        }
      } catch {
        return UNAVAILABLE;
      }
      try {
        structHash = encodeHex0x(hashRecord(occV2Domain(chainId, notary), r).structHash);
      } catch {
        return MISMATCH;
      }
    }
    let state: {
      signer: string;
      timestamp: bigint;
      kind: number;
      envelopeHash: string;
      recipientCommitment: string;
      recordStructHash: string;
    };
    try {
      state = (await this.#kit
        .notaryReader(chain.client, chain.config)
        .read.getRecord([recordId as Hex])) as unknown as typeof state;
    } catch {
      // A read that fails is never a pass and never a mismatch (04 §3.4, M1-7g-b).
      return UNAVAILABLE;
    }
    const signer = String(state.signer).toLowerCase();
    // Not visible yet (a lagging RPC, a reorg, a record sent before it was confirmed): retried.
    if (signer === ZERO_ADDRESS || state.timestamp === 0n) return UNAVAILABLE;
    if (signer !== contact) return MISMATCH;
    if (Number(state.kind) !== kind) return MISMATCH;
    const envelopeHash = String(state.envelopeHash).toLowerCase();
    if (envelopeHash !== heldHash) return MISMATCH;
    const commitment = String(state.recipientCommitment).toLowerCase();
    if (commitment !== mine) return MISMATCH;
    if (signedItem !== undefined) {
      const r = signedItem.record;
      // 3. The struct hash, signer and kind the chain holds.
      if (String(state.recordStructHash).toLowerCase() !== structHash) return MISMATCH;
      if (signer !== r.signer || Number(state.kind) !== r.kind) return MISMATCH;
      // 5. The signature, as the Notary's SignatureChecker judges it, now.
      const sig = await this.#checkSignature(chain, recordId, signedItem, self.agentId, salt);
      if (sig === 'unavailable') return UNAVAILABLE;
      if (sig !== 'ok') return MISMATCH;
      // Parent check (D-109; 04 §3.4, §5.1), after the checks above: a non-zero parent must be a
      // record the chain shows `record.signer` made. A failed read is neither a pass nor a flag.
      if (r.parentRecordId !== ZERO_BYTES32) {
        let parent: Awaited<ReturnType<ProofChain['state']['getRecord']>>;
        try {
          parent = await chain.state.getRecord(r.parentRecordId as Hex);
        } catch {
          return UNAVAILABLE;
        }
        // A parent not visible yet is retried; one that exists with another signer is definite.
        if (parent === null || /^0x0*$/.test(String(parent.signer))) return UNAVAILABLE;
        if (String(parent.signer).toLowerCase() !== r.signer) return PARENT_MISMATCH;
      }
    }
    return {
      status: 'ok',
      received: { signer, envelopeHash, kind, recipientCommitment: commitment },
    };
  }

  /**
   * 04 §3.4 check 5 through the chain package's own verifier, over the pack this body would make:
   * canonical ECDSA recovery for a signer without code, ERC-1271 `isValidSignature` for one with code.
   * Unlike a pack's verification (D-96), an account that does not accept the signature at the time
   * of this check is a mismatch. A read the verifier could not make is `unavailable`.
   */
  async #checkSignature(
    chain: ProofChain,
    recordId: string,
    signedItem: { readonly record: RecordJson; readonly signature: string },
    self: string,
    salt: string,
  ): Promise<RecordCheck['status']> {
    const candidate = {
      type: 'agentlink.proof',
      version: 1,
      chainId: chain.config.chainId,
      notary: chain.config.contracts.notary.toLowerCase(),
      recordId,
      record: signedItem.record,
      signature: signedItem.signature,
      signer: { evm: signedItem.record.signer },
      envelopeHash: signedItem.record.envelopeHash,
      recipient: { evm: self, salt },
      receipts: [],
      disclosure: null,
      ownerApproval: null,
      exportedAt: iso(nowOf(this.#ctx)),
    };
    let result: Awaited<ReturnType<ProofKit['verifyProofPack']>>;
    try {
      result = await this.#kit.verifyProofPack(candidate, {
        chains: [{ config: chain.config, client: chain.client }],
      });
    } catch {
      return 'mismatch';
    }
    if (!result.valid) return result.reason === 'chain_unavailable' ? 'unavailable' : 'mismatch';
    if (result.notices.some((n) => n.code === 'signer_no_longer_confirms')) return 'mismatch';
    if (result.recordId.toLowerCase() !== recordId || result.signer !== signedItem.record.signer) {
      return 'mismatch';
    }
    return 'ok';
  }

  /**
   * Signs, stores and submits one receipt on a received record. The signed item is stored (one per
   * record and type; ACCEPTED and REJECTED exclusive) in the transaction that also runs `claim`, if
   * any, and only then submitted. A stored one is never signed again: it is resent unchanged until
   * it lands (04 §5); `resubmitPending` replaces it only when it can never land.
   */
  async #signReceipt(
    row: Row<'proofs'>,
    type: ReceiptTypeName,
    claim?: (tx: StoreTx, itemJson: string) => boolean,
  ): Promise<AcknowledgeResult> {
    // M1-33d-b (I-6): concurrent calls for one record and type (two `acknowledge {delivered}` at
    // once) run one after the other, so the second finds the stored receipt and signs nothing. The
    // store transaction below still keeps one per record and type across processes.
    const id = receiptItemId(row.record_id, RECEIPT_CODE[type]);
    for (let running = this.#signing.get(id); running !== undefined;) {
      await running.catch(() => undefined);
      running = this.#signing.get(id);
    }
    const work = this.#signReceiptOnce(row, type, claim);
    this.#signing.set(id, work);
    try {
      return await work;
    } finally {
      if (this.#signing.get(id) === work) this.#signing.delete(id);
    }
  }

  async #signReceiptOnce(
    row: Row<'proofs'>,
    type: ReceiptTypeName,
    claim?: (tx: StoreTx, itemJson: string) => boolean,
  ): Promise<AcknowledgeResult> {
    const chain = this.#chain(row.chain_id);
    if (chain === undefined) return rejected('UNSUPPORTED_CHAIN');
    const code = RECEIPT_CODE[type];
    const id = receiptItemId(row.record_id, code);
    const existing = await this.#ctx.store.transaction((tx) => tx.get('proofs', { record_id: id }));
    if (existing !== undefined) return this.#receiptResult(existing, type);
    const self = await this.#self();
    const now = nowOf(this.#ctx);
    const salt = await open(this.#ctx, 'proofs', 'salt', [row.record_id], row.salt);
    const itemJson = await this.#buildReceiptItem(row, code, salt, now);
    const empty = await seal(this.#ctx, 'proofs', 'salt', [id], '');
    const outcome = await this.#ctx.store.transaction((tx) => {
      if (tx.get('proofs', { record_id: id }) !== undefined) return 'exists';
      if (tx.get('receipts', { record_id: row.record_id, type: code }) !== undefined) {
        return 'exists';
      }
      if (code === 3 || code === 4) {
        const other = code === 3 ? 4 : 3;
        if (tx.get('receipts', { record_id: row.record_id, type: other }) !== undefined) {
          return 'conflict';
        }
      }
      if (claim !== undefined && !claim(tx, itemJson)) return 'refused';
      tx.insert('receipts', {
        record_id: row.record_id,
        type: code,
        signer: self.agentId,
        tx_hash: null,
        at: now,
      });
      tx.insert('proofs', {
        record_id: id,
        envelope_id: row.envelope_id,
        chain_id: row.chain_id,
        record_json: itemJson,
        tx_hash: null,
        status: RECEIPT_SIGNED,
        fee_token: null,
        fee_amount: null,
        salt: empty,
        created_at: now,
      });
      return 'stored';
    });
    if (outcome === 'conflict') return rejected('RECEIPT_CONFLICT');
    if (outcome === 'refused') return rejected('APPROVAL_INVALID');
    const stored = await this.#ctx.store.transaction((tx) => tx.get('proofs', { record_id: id }));
    if (stored === undefined) return rejected('NOT_RECORDED');
    return this.#receiptResult(stored, type);
  }

  /** A signed Receipt as canonical JSON `{receipt, signature}`, through KeyStore.sign712. */
  async #buildReceiptItem(
    row: Row<'proofs'>,
    code: number,
    salt: string,
    now: number,
  ): Promise<string> {
    const chain = this.#chain(row.chain_id) as ProofChain;
    const self = await this.#self();
    const built = this.#kit.buildReceipt({
      chainId: row.chain_id,
      notary: chain.config.contracts.notary,
      signer: self.agentId,
      recordId: row.record_id,
      receiptType: code,
      salt,
      deadline: now + RECEIPT_DEADLINE_SECONDS,
    });
    const signature = await this.#kit.signReceipt(this.#ctx.keyStore, built);
    return canonicalize({ receipt: built.receipt, signature } as never);
  }

  /** The result for a stored receipt: submitted again (the same bytes) unless it has landed. */
  async #receiptResult(stored: Row<'proofs'>, type: ReceiptTypeName): Promise<AcknowledgeResult> {
    const recordId = stored.record_id.slice(0, stored.record_id.lastIndexOf(':'));
    if (stored.status === RECEIPT_CONFLICT) return rejected('RECEIPT_CONFLICT');
    if (stored.status === RECEIPT_FAILED) return rejected('NOT_RECORDED');
    const onChain =
      stored.status === RECEIPT_RECORDED || (await this.#submitReceipt(stored)) === 'recorded';
    return { status: 'ok', recordId, receipt: type, onChain };
  }

  /**
   * Submits the stored signed Receipt unchanged. On-chain: the row becomes `receipt_recorded` and a
   * commitment part that holds this item becomes `done` (07 §2.1 step 3, §3.5).
   */
  async #submitReceipt(
    stored: Row<'proofs'>,
    waitMs?: number,
  ): Promise<ProofOutcome['status'] | 'error' | 'terminal'> {
    const chain = this.#chain(stored.chain_id);
    if (chain === undefined) return 'error';
    const item = parseJson(stored.record_json) as never;
    const call = waitMs === undefined ? undefined : { waitMs };
    let outcome: ProofOutcome;
    try {
      outcome = await chain.submitter.acknowledge(item, call);
      // M1-34-c: a client RPC that lags behind the block holding the record answers
      // `RecordNotFound` for a record that exists. The same signed item is posted again, a fixed
      // RECEIPT_NOT_FOUND_RETRIES times after RECEIPT_NOT_FOUND_RETRY_MS, before it counts as
      // refused for good. Nothing is signed again; a receipt carries no fee (05 §3.3).
      for (
        let retry = 0;
        retry < RECEIPT_NOT_FOUND_RETRIES &&
        outcome.status === 'failed' &&
        outcome.error === 'RecordNotFound';
        retry += 1
      ) {
        await this.#sleep(RECEIPT_NOT_FOUND_RETRY_MS);
        outcome = await chain.submitter.acknowledge(item, call);
      }
    } catch {
      this.#log.warn('receipt submit failed', { code: 'submit_error' });
      return 'error';
    }
    const status = outcome.status;
    if (status === 'failed' && TERMINAL_RECEIPT_ERRORS.has(outcome.error)) {
      // The chain's own simulation refuses it for good: no resend or replacement can land it.
      this.#log.warn('receipt refused by the chain', { code: 'receipt_failed' });
      await this.#ctx.store.transaction((tx) =>
        tx.update(
          'proofs',
          { record_id: stored.record_id, status: RECEIPT_SIGNED },
          { status: RECEIPT_FAILED },
        ),
      );
      return 'terminal';
    }
    const now = nowOf(this.#ctx);
    if (status === 'recorded') {
      await this.#ctx.store.transaction((tx) => {
        tx.update(
          'proofs',
          { record_id: stored.record_id, status: RECEIPT_SIGNED },
          { status: RECEIPT_RECORDED },
        );
        tx.update(
          'commitment_parts',
          { part: 'receipt', item_ref: stored.record_id, state: 'claimed' },
          { state: 'done', done_at: now, updated_at: now },
        );
      });
    } else if (status === 'conflict') {
      this.#log.info('receipt conflicts on-chain', { code: 'receipt_conflict' });
      await this.#ctx.store.transaction((tx) =>
        tx.update(
          'proofs',
          { record_id: stored.record_id, status: RECEIPT_SIGNED },
          { status: RECEIPT_CONFLICT },
        ),
      );
    }
    return status;
  }

  /**
   * One replacement Receipt (04 §5): only after the stored one's deadline, when the finalized block
   * shows neither its type nor the conflicting one, and, for a commitment part, never after the
   * scope's `expiresAt`. Same record and type, new deadline; the part's stored item follows.
   */
  async #replaceReceipt(stored: Row<'proofs'>): Promise<boolean> {
    const chain = this.#chain(stored.chain_id);
    if (chain === undefined) return false;
    const item = parseJson(stored.record_json) as unknown as {
      receipt: { recordId: string; receiptType: number; deadline: number };
    };
    const now = nowOf(this.#ctx);
    if (now <= item.receipt.deadline) return false;
    let allowed: boolean;
    try {
      allowed = await this.#kit.replacementAllowed(chain.state, {
        recordId: item.receipt.recordId,
        deadline: item.receipt.deadline,
        receiptType: item.receipt.receiptType,
      });
    } catch {
      allowed = false;
    }
    if (!allowed) return false;
    const part = await this.#ctx.store.transaction(
      (tx) => tx.select('commitment_parts', { part: 'receipt', item_ref: stored.record_id })[0],
    );
    if (part !== undefined) {
      if (part.state !== 'claimed') return false;
      const approval = await this.#ctx.store.transaction((tx) =>
        tx.get('approvals', { approval_id: part.approval_id }),
      );
      let expiresAt: unknown;
      try {
        expiresAt = (parseJson(approval?.scope_json ?? '') as { expiresAt?: unknown }).expiresAt;
      } catch {
        expiresAt = undefined;
      }
      if (typeof expiresAt !== 'number' || now > expiresAt) return false;
    }
    const record = await this.#ctx.store.transaction((tx) =>
      tx.get('proofs', { record_id: item.receipt.recordId }),
    );
    if (record?.status !== 'received') return false;
    const salt = await open(this.#ctx, 'proofs', 'salt', [record.record_id], record.salt);
    const itemJson = await this.#buildReceiptItem(record, item.receipt.receiptType, salt, now);
    const swapped = await this.#ctx.store.transaction((tx) => {
      const n = tx.update(
        'proofs',
        { record_id: stored.record_id, status: RECEIPT_SIGNED, record_json: stored.record_json },
        { record_json: itemJson },
      );
      if (n !== 1) return false;
      if (part !== undefined) {
        tx.update(
          'commitment_parts',
          { approval_id: part.approval_id, part: 'receipt', state: 'claimed' },
          { item_json: itemJson, replacements: part.replacements + 1, updated_at: now },
        );
      }
      return true;
    });
    if (!swapped) return false;
    const fresh = await this.#ctx.store.transaction((tx) =>
      tx.get('proofs', { record_id: stored.record_id }),
    );
    if (fresh !== undefined) await this.#submitReceipt(fresh);
    return true;
  }

  /**
   * The deferred ACCEPTED of an approved scope (07 §2.1 step 4; D-55): an `accept` on its OFFER
   * record, or a `confirm` on their ACCEPT record (04 §3.4.2, M1-7g-d).
   */
  async #deferred(row: Row<'proofs'>, checked: ReceivedItem['received']): Promise<number> {
    const kind =
      checked.kind === RECORD_KIND.OFFER
        ? 'OFFER'
        : checked.kind === RECORD_KIND.ACCEPT
          ? 'ACCEPT'
          : undefined;
    if (kind === undefined) return 0;
    const terms = this.#deps.terms();
    const d = await terms.deferredReceipt({
      envelopeHash: checked.envelopeHash,
      kind,
      signer: checked.signer,
    });
    if (d.status !== 'ready') {
      if (d.status === 'void') this.#log.info('deferred receipt void', { code: d.code });
      return 0;
    }
    const approvalId = d.approvalId;
    const itemRef = `${row.record_id}:3`;
    const r = await this.#signReceipt(row, 'ACCEPTED', (tx, itemJson) =>
      terms.claimReceiptPartTx(tx, approvalId, itemRef, itemJson, nowOf(this.#ctx)),
    );
    // On-chain, #submitReceipt marked the part done; otherwise resubmitPending republishes the
    // stored item and marks it done when it lands (07 §2.1 step 3).
    return r.status === 'ok' ? 1 : 0;
  }

  /**
   * Runs the deferred ACCEPTED for every received OFFER and ACCEPT record (07 §2.1 step 4): after an
   * accept whose offer was already recorded, or an approved `confirm` (whose ACCEPT record is always
   * known first), so the receipt is signed without a second approval.
   */
  async runDeferredReceipts(): Promise<number> {
    if (this.#platform === undefined) return 0;
    const rows = await this.#ctx.store.transaction((tx) =>
      tx.select('proofs', { status: 'received' }),
    );
    let n = 0;
    for (const row of rows) {
      const item = this.#received(row);
      if (item?.kind !== RECORD_KIND.OFFER && item?.kind !== RECORD_KIND.ACCEPT) continue;
      try {
        n += await this.#deferred(row, item);
      } catch {
        this.#log.warn('deferred receipt failed', { code: 'deferred_error' });
      }
    }
    return n;
  }

  #received(row: Row<'proofs'>): ReceivedItem['received'] | undefined {
    return this.#receivedItem(row)?.received;
  }

  #receivedItem(row: Row<'proofs'>): ReceivedItem | undefined {
    try {
      return parseJson(row.record_json) as unknown as ReceivedItem;
    } catch {
      return undefined;
    }
  }

  /** An explicit receipt (06 §2.4 `agentlink_acknowledge`). */
  async acknowledge(input: AcknowledgeInput): Promise<AcknowledgeResult> {
    if (this.#platform === undefined) return rejected('PROOFS_UNAVAILABLE');
    const row = (
      await this.#ctx.store.transaction((tx) =>
        tx.select('proofs', { envelope_id: input.envelopeId, status: 'received' }),
      )
    )[0];
    if (row === undefined) return rejected('NOT_RECORDED');
    // The user's own yes (06 §2.4, §3; D-109): no owner approval, as for `opened`. #signReceipt
    // signs at most one per record and type (I-6); a repeat returns the stored receipt.
    if (input.type === 'delivered') return this.#signReceipt(row, 'DELIVERED');
    if (input.type === 'opened') return this.#signReceipt(row, 'OPENED');

    const type: ReceiptTypeName = input.type === 'accepted' ? 'ACCEPTED' : 'REJECTED';
    const envelope = await this.#envelope(input.envelopeId);
    const payload = envelope === undefined ? undefined : await this.#payload(envelope);
    if (envelope === undefined || payload === undefined) return rejected('ENVELOPE_NOT_FOUND');
    if (TERMS_TYPES.has(payload.type)) return rejected('USE_RESPOND_TO_TERMS');
    const done = await this.#ctx.store.transaction((tx) =>
      tx.select('receipts', { record_id: row.record_id, type: { in: [3, 4] } }),
    );
    if (done.some((r) => r.type !== RECEIPT_CODE[type])) return rejected('RECEIPT_CONFLICT');

    const evaluation = evaluateCommitment(await this.#deps.ownerActions.loadPolicy(), {
      kind: 'acknowledge',
      receipt: type,
    });
    if (evaluation.decision === 'deny' || evaluation.decision === 'void') {
      return rejected('POLICY_DENIED');
    }
    if (evaluation.decision === 'allow') return this.#signReceipt(row, type);
    const counterparty = await this.#counterparty(envelope.contact_id ?? '');
    if (counterparty === null) return rejected('ENVELOPE_NOT_FOUND');
    const action = {
      tool: 'agentlink_acknowledge',
      args: { envelopeId: input.envelopeId, type: input.type },
      context: {
        triggers: ['commitments.accept'],
        counterparty: { agentId: counterparty.agentId, ownerKey: counterparty.ownerKey },
        recordId: row.record_id,
        receipt: type,
      },
    };
    if (input.approvalId === undefined) {
      return this.#deps.approvals.request({
        action,
        summary:
          type === 'ACCEPTED'
            ? `Confirm on-chain that you accept the message from ${counterparty.name}`
            : `Confirm on-chain that you reject the message from ${counterparty.name}`,
      });
    }
    const auth = await this.#deps.approvals.authorize(input.approvalId, action, 'approval');
    if (auth.status !== 'authorized') return rejected('APPROVAL_INVALID');
    return this.#signReceipt(row, type, (tx) => auth.claim(tx));
  }

  // --- reading and export ----------------------------------------------------------------------

  /** The proof of an envelope or record, own or received (06 §2.4 `agentlink_get_proof`). */
  async getProof(input: {
    readonly envelopeId?: string;
    readonly recordId?: string;
  }): Promise<ProofView | undefined> {
    const row = await this.#find(input);
    if (row === undefined) return undefined;
    const chain = this.#chain(row.chain_id);
    let receipts: { type: ReceiptTypeName; at: string }[] = [];
    let read = false;
    if (chain !== undefined) {
      try {
        const stored = await chain.state.getRecord(row.record_id as Hex);
        if (stored !== null) {
          RECEIPT_TYPE_NAMES.forEach((type, i) => {
            const at = stored.receiptAt[i] ?? 0n;
            if (at !== 0n) receipts.push({ type, at: iso(at) });
          });
          read = true;
        }
      } catch {
        read = false;
      }
    }
    if (!read) {
      const own = await this.#ctx.store.transaction((tx) =>
        tx.select('receipts', { record_id: row.record_id }),
      );
      receipts = own
        .sort((x, y) => x.type - y.type)
        .map((r) => ({ type: RECEIPT_TYPE_NAMES[r.type - 1] as ReceiptTypeName, at: iso(r.at) }));
    }
    const fee = row.status === 'received' ? undefined : this.#feeOf(row);
    return Object.freeze({
      direction: row.status === 'received' ? 'received' : 'sent',
      status: row.status,
      recordId: row.record_id,
      chainId: row.chain_id,
      chain: chain?.config.key ?? String(row.chain_id),
      ...(fee === undefined ? {} : { fee }),
      receipts: Object.freeze(receipts),
    });
  }

  /**
   * The stored proofs, own and received, newest first and paged (M1-11r-a, the local UI's proof
   * list). Store only: no chain read. IDs, chain, status and time; never the salt, the signed
   * Record or a transaction hash.
   */
  list(query: PageQuery = {}): Promise<Page<ProofListItem>> {
    return listProofs(this.#ctx, this.#platform, LISTED_PROOF_STATUSES, query);
  }

  /**
   * The agent's credits on every supported chain (M1-11r-a): read-only, per chain, with a chain
   * that cannot be read marked `available: false`. `unavailable` without the proofs platform or
   * before init.
   */
  async creditsBalance(): Promise<CreditsView> {
    return readCredits(this.#platform, await this.#deps.identity.agentAddress());
  }

  /**
   * Free test credits on `chainId` (M1-11r-a; 05 §9, M1-10b). Testnets on the hard-coded allowlist
   * only: any other chain, mainnets included, is refused before anything is sent. Sends only the
   * chain ID and the agent ID. The one call of the local UI reads that is not a read.
   */
  async requestFaucet(chainId: number): Promise<FreeCreditsResult> {
    return requestFreeCredits(
      this.#ctx,
      this.#platform,
      await this.#deps.identity.agentAddress(),
      chainId,
    );
  }

  /**
   * True when the chain shows the contact's DELIVERED receipt on this agent's own on-chain record
   * of a sent envelope (M1-1g-h: the `files.deleteAfter: receipt` trigger; 04 §4, 06 §3). Only the
   * chain counts: the contract accepts a receipt only from the recipient the record commits to.
   * False without a proofs platform, an own on-chain record, or a chain answer. Never throws.
   */
  async deliveredReceiptOnChain(envelopeId: string): Promise<boolean> {
    if (this.#platform === undefined) return false;
    const rows = await this.#ctx.store.transaction((tx) =>
      tx.select('proofs', { envelope_id: envelopeId, status: { in: [...ON_CHAIN] } }),
    );
    for (const row of rows) {
      if (!isRecordRow(row)) continue;
      const chain = this.#chain(row.chain_id);
      if (chain === undefined) continue;
      try {
        const stored = await chain.state.getRecord(row.record_id as Hex);
        if ((stored?.receiptAt[RECEIPT_CODE.DELIVERED - 1] ?? 0n) !== 0n) return true;
      } catch {
        // No chain answer: not delivered as far as this pass knows; the next pass asks again.
      }
    }
    return false;
  }

  async #find(input: {
    readonly envelopeId?: string;
    readonly recordId?: string;
  }): Promise<Row<'proofs'> | undefined> {
    return this.#ctx.store.transaction((tx) => {
      const rows =
        input.recordId !== undefined
          ? tx.select('proofs', { record_id: input.recordId.toLowerCase() })
          : input.envelopeId !== undefined
            ? tx.select('proofs', { envelope_id: input.envelopeId })
            : [];
      const usable = rows.filter((r) => isRecordRow(r) && r.status !== 'replaced');
      // Prefer an on-chain own record, then any own one, then a received one.
      return (
        usable.find((r) => ON_CHAIN.includes(r.status)) ??
        usable.find((r) => r.status !== 'received') ??
        usable[0]
      );
    });
  }

  /** Builds the 07 §8 proof pack. The tool layer writes it to `proofs.exportFolder`. */
  async exportProofPack(input: ExportProofPackInput): Promise<ExportProofPackResult> {
    if (this.#platform === undefined) return rejected('PROOFS_UNAVAILABLE');
    const row = await this.#find(input);
    if (row === undefined) return rejected('NOT_RECORDED');
    // Recipient side (07 §8, D-107): only from the signed Record and signature that arrived in the
    // `proof` body and passed the 04 §3.4 checks, never from the chain read alone. An older sender's
    // body carried neither: RECORD_UNAVAILABLE.
    const received = row.status === 'received';
    let item: SignedItem;
    if (received) {
      const stored = this.#receivedItem(row);
      if (stored?.record === undefined || stored.signature === undefined) {
        return rejected('RECORD_UNAVAILABLE');
      }
      item = { record: stored.record as SignedItem['record'], signature: stored.signature };
    } else {
      if (!ON_CHAIN.includes(row.status)) return rejected('NOT_RECORDED');
      item = parseJson(row.record_json) as unknown as SignedItem;
    }
    const chain = this.#chain(row.chain_id);
    if (chain === undefined) return rejected('UNSUPPORTED_CHAIN');
    const envelopeRow = await this.#envelope(row.envelope_id);
    if (envelopeRow?.envelope_json == null) return rejected('ENVELOPE_NOT_FOUND');
    if (envelopeRow.direction !== (received ? 'in' : 'out')) return rejected('RECORD_UNAVAILABLE');

    let contentKey: string | undefined;
    if (input.includeContentKey === true) {
      const effective = await this.#deps.ownerActions.loadPolicy();
      if (evaluate(effective, { kind: 'key.disclose' }) === 'deny')
        return rejected('POLICY_DENIED');
      const action = {
        tool: 'agentlink_export_proof_pack',
        args: { envelopeId: row.envelope_id, includeContentKey: true },
        context: {
          triggers: ['proofs.allowKeyDisclosure'],
          recordId: row.record_id,
          envelopeHash: envelopeRow.envelope_hash,
        },
      };
      if (input.approvalId === undefined) {
        return this.#deps.approvals.request({
          action,
          summary: 'Share the content of a recorded message in a proof pack',
        });
      }
      const used = await this.#deps.approvals.use(input.approvalId, action, 'approval');
      if (used.status !== 'used') return rejected('APPROVAL_INVALID');
      contentKey = await this.#contentKey(envelopeRow.envelope_json);
      if (contentKey === undefined) return rejected('RECORD_UNAVAILABLE');
    }

    const signer = (await this.#deps.contacts.proofSigner(envelopeRow.from_key)) ?? {
      evm: item.record.signer,
    };
    // The record's recipient: the contact on the sender side, this agent on the recipient side.
    const recipientEvm = received ? (await this.#self()).agentId : envelopeRow.contact_id;
    const salt =
      recipientEvm === null || input.includeRecipient !== true
        ? ''
        : await open(this.#ctx, 'proofs', 'salt', [row.record_id], row.salt);
    const ownerApproval =
      input.includeOwnerApproval === false ? null : await this.#ownerApproval(row, received);
    const base = {
      type: 'agentlink.proof',
      version: 1,
      chainId: row.chain_id,
      notary: chain.config.contracts.notary.toLowerCase(),
      recordId: row.record_id,
      record: item.record,
      signature: item.signature,
      signer,
      envelopeHash: item.record.envelopeHash,
      ...(contentKey === undefined
        ? {}
        : { envelope: parseJson(envelopeRow.envelope_json) as unknown }),
      ...(recipientEvm === null || salt === '' ? {} : { recipient: { evm: recipientEvm, salt } }),
      // Receipts are read by the verifier from the chain; a pack lists only those with a known
      // transaction hash (07 §8), which the submitter outcome does not carry yet.
      receipts: [],
      disclosure: contentKey === undefined ? null : { contentKey },
      exportedAt: iso(nowOf(this.#ctx)),
    };
    let parsed = proofPackSchema.safeParse({ ...base, ownerApproval });
    if (!parsed.success && ownerApproval !== null) {
      parsed = proofPackSchema.safeParse({ ...base, ownerApproval: null });
    }
    if (!parsed.success) {
      this.#log.warn('proof pack not built', { code: 'pack_invalid' });
      return rejected('RECORD_UNAVAILABLE');
    }
    return Object.freeze({
      status: 'ok',
      recordId: row.record_id,
      pack: Object.freeze({ ...base, ownerApproval: parsed.data.ownerApproval }),
    });
  }

  /** The 32-byte CEK from this agent's own entry (04 §3.3), as base64url; wiped after encoding. */
  async #contentKey(envelopeJson: string): Promise<string | undefined> {
    const envelope = parseJson(envelopeJson) as unknown as Envelope;
    const current = await this.#ctx.keyStore.getPublicBundle();
    for (let epoch = current.keyEpoch; epoch >= 0; epoch -= 1) {
      const bundle = await this.#ctx.keyStore.getPublicBundle({ epoch });
      const kid = encodeBase64url(bundle.kid);
      const entry = envelope.recipients.find((e) => e.kid === kid);
      if (entry === undefined) continue;
      let cek: Uint8Array | undefined;
      try {
        cek = await this.#ctx.keyStore.unwrapCek(
          {
            enc: decodeBase64url(entry.enc, { length: HPKE_ENC_LENGTH }),
            wk: decodeBase64url(entry.wk, { length: WRAPPED_CEK_LENGTH }),
          },
          decodeBase64url(envelope.id),
          { epoch },
        );
        return encodeBase64url(cek);
      } catch {
        return undefined;
      } finally {
        if (cek !== undefined) wipe(cek);
      }
    }
    return undefined;
  }

  /**
   * The exporting side's approval of the commitment this envelope carried out (07 §8, D-55): the
   * owner's signed `approval.decide` with its action, or a standing-rule grant with the policy hash.
   * On the sender side, the commitment whose envelope part is this envelope; on the recipient side
   * (D-107), the one whose ACCEPTED or REJECTED receipt part is on this record. Null when there is no
   * such commitment or the stored decision is not a single decide.
   */
  async #ownerApproval(row: Row<'proofs'>, received: boolean): Promise<unknown> {
    const part = await this.#ctx.store.transaction(
      (tx) =>
        (received
          ? tx.select('commitment_parts', {
              part: 'receipt',
              item_ref: {
                in: [receiptItemId(row.record_id, 3), receiptItemId(row.record_id, 4)],
              },
            })
          : tx.select('commitment_parts', { part: 'envelope', item_ref: row.envelope_id }))[0],
    );
    if (part === undefined) return null;
    const approval = await this.#ctx.store.transaction((tx) =>
      tx.get('approvals', { approval_id: part.approval_id }),
    );
    if (approval === undefined) return null;
    try {
      if (approval.source === 'policy_grant') {
        if (approval.policy_hash === null) return null;
        const policyHash = await open(
          this.#ctx,
          'approvals',
          'policy_hash',
          [approval.approval_id],
          approval.policy_hash,
        );
        return { standingRule: true, policyHash };
      }
      if (approval.signed_decision === null) return null;
      const signed = signedApprovalDecideSchema.safeParse(
        parseOwnerActionText(approval.signed_decision),
      );
      if (!signed.success) return null;
      const action = parseJson(
        await open(
          this.#ctx,
          'approvals',
          'action_json',
          [approval.approval_id],
          approval.action_json,
        ),
      );
      return { signed: parseOwnerActionText(approval.signed_decision), action };
    } catch {
      return null;
    }
  }

  // --- RecordLookup (M1-32 terms flow) ---------------------------------------------------------

  /** A verified record of an envelope with this hash: own on-chain, or received and checked. */
  async recordOf(envelopeHash: string): Promise<KnownRecord | undefined> {
    const rows = await this.#ctx.store.transaction((tx) => {
      const ids = tx
        .select('envelopes', { envelope_hash: envelopeHash.toLowerCase() })
        .map((e) => e.envelope_id);
      return ids.length === 0 ? [] : tx.select('proofs', { envelope_id: { in: ids } });
    });
    for (const row of rows) {
      let kind: number | undefined;
      let signer: string | undefined;
      if (row.status === 'received') {
        const r = this.#received(row);
        kind = r?.kind;
        signer = r?.signer;
      } else if (ON_CHAIN.includes(row.status)) {
        const r = (parseJson(row.record_json) as unknown as SignedItem).record;
        kind = r.kind;
        signer = r.signer;
      }
      if (signer === undefined) continue;
      if (kind === RECORD_KIND.OFFER) return { kind: 'OFFER', signer };
      if (kind === RECORD_KIND.ACCEPT) return { kind: 'ACCEPT', signer };
    }
    return undefined;
  }

  // --- helpers ---------------------------------------------------------------------------------

  async #self() {
    const view = await this.#deps.identity.get();
    if (view === undefined) {
      throw new CoreError('identity_missing', 'This agent has no identity yet. Run init first.');
    }
    return view;
  }

  get #kit(): ProofKit {
    // Only reached on paths that checked the platform first.
    return (this.#platform as ProofsPlatform).kit;
  }

  #chain(chainId: number): ProofChain | undefined {
    return this.#platform?.chains.find((c) => c.config.chainId === chainId);
  }

  async #select(
    payer: string,
    defaultChain: string | undefined,
    chainId: number | undefined,
  ): Promise<ChainSelection> {
    const platform = this.#platform as ProofsPlatform;
    const selector = this.#selector as Selector;
    try {
      return await selector.select(
        platform.chains.map((c) => ({ config: c.config, client: c.client })),
        payer as Hex,
        {
          feeType: 'NOTARIZE',
          ...(defaultChain === undefined ? {} : { defaultChain }),
          ...(chainId === undefined ? {} : { chainId }),
        },
      );
    } catch {
      return { status: 'unavailable', unavailable: [] };
    }
  }

  async #envelope(envelopeId: string): Promise<Row<'envelopes'> | undefined> {
    if (typeof envelopeId !== 'string' || envelopeId.length === 0) return undefined;
    return this.#ctx.store.transaction((tx) => tx.get('envelopes', { envelope_id: envelopeId }));
  }

  async #payload(row: Row<'envelopes'>): Promise<Payload | undefined> {
    if (row.payload_json === null) return undefined;
    try {
      const text = await open(
        this.#ctx,
        'envelopes',
        'payload_json',
        [row.envelope_id],
        row.payload_json,
      );
      const parsed = payloadSchema.safeParse(parseJson(text));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  async #counterparty(contactId: string): Promise<{
    readonly agentId: string;
    readonly ownerKey: string;
    readonly name: string;
    readonly eligible: boolean;
  } | null> {
    try {
      const contact = await this.#deps.contacts.get(contactId);
      return {
        agentId: contact.id,
        ownerKey: contact.card.ownerNostr.slice(2),
        name: renderContactName(contact.display),
        eligible: contact.status === 'active',
      };
    } catch {
      return null;
    }
  }

  async #ownRows(envelopeId: string): Promise<Row<'proofs'>[]> {
    return this.#ctx.store.transaction((tx) =>
      tx
        .select('proofs', { envelope_id: envelopeId })
        .filter((r) => isRecordRow(r) && r.status !== 'received'),
    );
  }
}
