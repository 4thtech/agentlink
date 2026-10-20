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
// and the deferred ACCEPTED of an approved accept (07 §2.1 step 4). OPENED only on request;
// ACCEPTED / REJECTED without terms are commitments (`commitments.accept`, D-31) and exclusive.
//
// Signed Record in the body (M1-7g-b, D-107): the sender's `proof` body also carries the Record and
// its signature exactly as submitted. The recipient runs the 04 §3.4 checks 1–5 on them with the
// existing checks; any mismatch drops the whole body (`proof_mismatch`). A chain read that fails is
// never a pass: the body stays pending and is checked again at later syncs (at most 256 bodies, 7
// days each, then `proof_unchecked`). A passing body's Record and signature are stored as received,
// and the recipient can export its own pack from them; an older sender's body carries neither
// (RECORD_UNAVAILABLE on export).
//
// Export (`exportProofPack`, 07 §8): the signer block is the card of the envelope's key epoch with
// its proof of possession (`proofSigner`, D-102); the content key only with an owner approval
// (`proofs.allowKeyDisclosure` is never `allow`), and then always with the envelope; the owner's
// approval of a commitment is included by default (D-55).
//
// Never logged or put in an error (I-7, 04 §5): salts, signatures, content keys, record contents.
// Inbound proof bodies and chain answers are untrusted data (I-5): only fixed codes leave here.
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
import {
  RECEIPT_TYPE_NAMES,
  RECORD_KINDS as RECORD_KIND,
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
import type { KnownRecord, RecordLookup, TermsService } from '../terms-flow.js';
import type { ProofChain, ProofKit, ProofsPlatform } from './platform.js';

/** A Record's `deadline` is this far after signing (proposed; 04 §5 replacement window). */
export const RECORD_DEADLINE_SECONDS = 3_600;
/** A Receipt's `deadline` is this far after signing (proposed). */
export const RECEIPT_DEADLINE_SECONDS = 3_600;

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
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
const RECEIPT_STATUSES: readonly string[] = [RECEIPT_SIGNED, RECEIPT_RECORDED, RECEIPT_CONFLICT];
/**
 * A `proof` envelope whose message has not arrived yet (IR-M1-7g-1 L5): kept, keyed
 * `await:<proof envelope id>`, with the message's envelope ID, and checked when that arrives.
 */
const AWAITING = 'awaiting';
/** At most this many proof envelopes wait for their message, each at most this long. */
const MAX_AWAITING = 256;
const AWAITING_SECONDS = 7 * 86_400;
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
/** Rows that are a record: own or received (not a stored receipt or a waiting proof). */
const isRecordRow = (r: Row<'proofs'>): boolean =>
  !RECEIPT_STATUSES.includes(r.status) && r.status !== AWAITING && r.status !== PENDING;
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
  | 'POLICY_CHANGED';

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
}

interface RecordedFields {
  readonly recordId: string;
  readonly chainId: number;
  readonly chain: string;
  readonly fee: ProofFee;
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
  readonly type: 'opened' | 'accepted' | 'rejected';
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
}

/** The outcome of the recipient's checks of a `proof` body (04 §3.4). */
type RecordCheck =
  | { readonly status: 'ok'; readonly received: ReceivedItem['received'] }
  /** A definite mismatch: the whole body is dropped (`proof_mismatch`). */
  | { readonly status: 'mismatch' }
  /** A chain read failed: neither a pass nor a mismatch; the body stays pending. */
  | { readonly status: 'unavailable' };
const MISMATCH: RecordCheck = Object.freeze({ status: 'mismatch' });
const UNAVAILABLE: RecordCheck = Object.freeze({ status: 'unavailable' });

class Abort extends Error {}

type Selector = Pick<NonNullable<ProofsPlatform['selector']>, 'select' | 'clear'>;

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

export class ProofService implements RecordLookup {
  readonly #ctx: CoreContext;
  readonly #deps: ProofServiceDeps;
  readonly #platform: ProofsPlatform | undefined;
  readonly #selector: Selector | undefined;

  constructor(ctx: CoreContext, deps: ProofServiceDeps, platform: ProofsPlatform | undefined) {
    this.#ctx = ctx;
    this.#deps = deps;
    this.#platform = platform;
    this.#selector =
      platform === undefined
        ? undefined
        : (platform.selector ?? platform.kit.createChainSelector());
  }

  // --- notarize --------------------------------------------------------------------------------

  /** Records an envelope this agent sent (06 §2.4 `agentlink_notarize`). */
  async notarize(input: NotarizeInput): Promise<NotarizeResult> {
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
    });
    if (stored === undefined) return rejected('POLICY_CHANGED');
    return this.#submit(stored);
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
    readonly claim: ((tx: StoreTx) => boolean) | undefined;
    /** The row and ledger entry of the Record this one replaces (04 §5). */
    readonly replaces: { readonly recordId: string } | undefined;
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
    try {
      await this.#ctx.store.transaction((tx) => {
        if (input.claim !== undefined && !input.claim(tx)) throw new Abort();
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
          ownerApproved: input.approvalId !== null,
        });
        // Policy or budget moved between the check and this transaction: nothing is kept.
        if (!check.reserved) throw new Abort();
        if (replacedEntry !== undefined) {
          tx.update('budget_ledger', { entry_id: entryId }, { replaces: replacedEntry });
        }
        tx.insert('proofs', row);
      });
    } catch (error) {
      if (error instanceof Abort) return undefined;
      throw error;
    }
    return row;
  }

  /** A stored own row: resend it if it has not landed, or report it. */
  async #continue(row: Row<'proofs'>): Promise<NotarizeResult> {
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
  async #submit(row: Row<'proofs'>): Promise<NotarizeResult> {
    const chain = this.#chain(row.chain_id);
    if (chain === undefined) return rejected('UNSUPPORTED_CHAIN');
    const item = parseJson(row.record_json) as unknown as SignedItem;
    let outcome: ProofOutcome;
    try {
      outcome = await chain.submitter.notarize(item);
    } catch {
      this.#ctx.log.warn('proof submit failed', { code: 'submit_error' });
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
        this.#ctx.log.info('proof refused by the chain', { code: 'record_failed' });
        return { status: 'error', code: 'RECORD_FAILED', recordId: row.record_id };
      case 'conflict':
        await this.#setStatus(row, 'conflict');
        return { status: 'error', code: 'RECORD_CONFLICT', recordId: row.record_id };
      case 'pending':
        return this.#setStatus(row, 'pending');
    }
  }

  async #setStatus(row: Row<'proofs'>, status: OwnStatus): Promise<NotarizeResult> {
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

  #resultOf(row: Row<'proofs'>, confirmed: boolean): NotarizeResult {
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
      this.#ctx.log.warn('proof envelope not sent', { code: 'announce_failed' });
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
      if ((await this.#submitReceipt(row)) === 'recorded') {
        recorded += 1;
        continue;
      }
      if (await this.#replaceReceipt(row)) {
        replaced += 1;
        const after = await this.#ctx.store.transaction((tx) =>
          tx.get('proofs', { record_id: row.record_id }),
        );
        if (after?.status === RECEIPT_RECORDED) recorded += 1;
      }
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
    // A Record approved outside a commitment is not replaced after its approval's expiresAt.
    if (entry.approval_id !== null) {
      const approval = await this.#ctx.store.transaction((tx) =>
        tx.get('approvals', { approval_id: entry.approval_id as string }),
      );
      if (approval === undefined || now > approval.expires_at) return undefined;
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
      claim: undefined,
      replaces: { recordId: row.record_id },
    });
    if (stored === undefined) return undefined;
    return this.#submit(stored);
  }

  // --- the recipient: proof envelopes and receipts ---------------------------------------------

  /**
   * After a processing pass (syncInbox, the live subscription): checks each new `proof` envelope
   * from a contact on-chain, stores the record, signs DELIVERED per policy and the deferred
   * ACCEPTED (07 §2.1 step 4). Never throws; returns the receipts signed.
   */
  async processInbound(reports: readonly InboundReport[]): Promise<number> {
    if (this.#platform === undefined) return 0;
    let signed = 0;
    // Bodies kept pending by an earlier pass (a failed chain read): expired ones go first, the rest
    // are checked again after this pass's new envelopes (04 §3.4, M1-7g-b).
    let pending: readonly Row<'proofs'>[] = [];
    try {
      pending = await this.#pendingAfterExpiry();
    } catch {
      this.#ctx.log.warn('pending proof envelopes not read', { code: 'proof_inbound_error' });
    }
    for (const report of reports) {
      if (report.outcome !== 'ok' || report.envelopeId === undefined) continue;
      if (report.contactId === undefined) continue;
      try {
        signed += await this.#inbound(report.envelopeId, report.contactId);
        signed += await this.#released(report.envelopeId, report.contactId);
      } catch {
        this.#ctx.log.warn('proof envelope not processed', { code: 'proof_inbound_error' });
      }
    }
    for (const row of pending) {
      try {
        signed += await this.#recheck(row);
      } catch {
        this.#ctx.log.warn('proof envelope not processed', { code: 'proof_inbound_error' });
      }
    }
    return signed;
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
      this.#ctx.log.warn('proof envelope dropped unchecked (proof_unchecked)', {
        code: 'proof_unchecked',
      });
    }
    return rest;
  }

  /** One pending body, checked again from the existing checks on (04 §3.4). */
  async #recheck(row: Row<'proofs'>): Promise<number> {
    const proofEnvelopeId = row.record_id.slice(PENDING_PREFIX.length);
    const envelope = await this.#envelope(proofEnvelopeId);
    if (envelope?.contact_id == null || !row.record_id.startsWith(PENDING_PREFIX)) {
      // The proof envelope is gone (pruned or removed with its contact): nothing left to check.
      await this.#ctx.store.transaction((tx) =>
        tx.delete('proofs', { record_id: row.record_id, status: PENDING }),
      );
      return 0;
    }
    return this.#inbound(proofEnvelopeId, envelope.contact_id);
  }

  /**
   * Keeps a body whose chain read failed (never a pass, never a mismatch), bounded like the wait for
   * a `proof` that arrives before its message: past MAX_PENDING it is dropped as `proof_unchecked`.
   */
  async #pend(proofEnvelopeId: string, envelopeId: string, chainId: number): Promise<void> {
    const now = nowOf(this.#ctx);
    const key = `${PENDING_PREFIX}${proofEnvelopeId}`;
    const empty = await seal(this.#ctx, 'proofs', 'salt', [key], '');
    const kept = await this.#ctx.store.transaction((tx) => {
      if (tx.get('proofs', { record_id: key }) !== undefined) return 'kept';
      if (tx.count('proofs', { status: PENDING }) >= MAX_PENDING) return 'full';
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
      this.#ctx.log.info('proof envelope pending a chain read', { code: 'proof_pending' });
    } else if (kept === 'full') {
      this.#ctx.log.warn('proof envelope dropped unchecked (proof_unchecked)', {
        code: 'proof_unchecked',
      });
    }
  }

  /** The proof envelopes that waited for this message (L5): each is checked once, now. */
  async #released(envelopeId: string, contactId: string): Promise<number> {
    const now = nowOf(this.#ctx);
    const waiting = await this.#ctx.store.transaction((tx) => {
      tx.delete('proofs', { status: AWAITING, created_at: { lt: now - AWAITING_SECONDS } });
      const rows = tx.select('proofs', { envelope_id: envelopeId, status: AWAITING });
      for (const r of rows) tx.delete('proofs', { record_id: r.record_id, status: AWAITING });
      return rows;
    });
    let signed = 0;
    for (const r of waiting) {
      signed += await this.#inbound(r.record_id.slice('await:'.length), contactId);
    }
    return signed;
  }

  /** Keeps a proof envelope whose message is not here yet; bounded in number and time. */
  async #await(proofEnvelopeId: string, envelopeId: string, chainId: number): Promise<void> {
    const now = nowOf(this.#ctx);
    const key = `await:${proofEnvelopeId}`;
    const empty = await seal(this.#ctx, 'proofs', 'salt', [key], '');
    await this.#ctx.store.transaction((tx) => {
      tx.delete('proofs', { status: AWAITING, created_at: { lt: now - AWAITING_SECONDS } });
      if (tx.count('proofs', { status: AWAITING }) >= MAX_AWAITING) return;
      if (tx.get('proofs', { record_id: key }) !== undefined) return;
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
    });
  }

  async #inbound(proofEnvelopeId: string, contactId: string): Promise<number> {
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
      await this.#await(proofEnvelopeId, envelopeId, chainId);
      return 0;
    }
    const signedItem =
      body.data.record === undefined || body.data.signature === undefined
        ? undefined
        : { record: body.data.record, signature: body.data.signature };
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
      await this.#pend(proofEnvelopeId, envelopeId, chainId);
      return 0;
    }
    if (check.status === 'mismatch') {
      await this.#ctx.store.transaction((tx) =>
        tx.delete('proofs', { record_id: pendingKey, status: PENDING }),
      );
      // Fixed code only: nothing from the proof body or the chain answer (I-5, I-7).
      this.#ctx.log.warn('proof envelope does not match the chain (proof_mismatch)', {
        code: 'proof_mismatch',
      });
      return 0;
    }
    const checked = check.received;
    const sealedSalt = await seal(this.#ctx, 'proofs', 'salt', [recordId], salt);
    const now = nowOf(this.#ctx);
    // The Record and signature exactly as received, after every check passed (04 §3.4, D-107).
    const item: ReceivedItem =
      signedItem === undefined ? { received: checked } : { received: checked, ...signedItem };
    await this.#ctx.store.transaction((tx) => {
      tx.delete('proofs', { record_id: pendingKey, status: PENDING });
      const existing = tx.get('proofs', { record_id: recordId });
      if (existing !== undefined) {
        // An older sender's body stored first: a later body with the checked Record completes it.
        if (
          signedItem !== undefined &&
          existing.status === 'received' &&
          existing.envelope_id === envelopeId &&
          this.#receivedItem(existing)?.record === undefined
        ) {
          tx.update(
            'proofs',
            { record_id: recordId, status: 'received', record_json: existing.record_json },
            { record_json: canonicalize(item as never) },
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
    if (checked.kind === RECORD_KIND.OFFER) signed += await this.#deferred(stored, checked);
    return signed;
  }

  /**
   * The 05 §3.3 / 04 §3.4 recipient check before any receipt: the record exists on-chain, its signer
   * is the contact, its envelope hash is the stored envelope's (from that contact, to us), its kind
   * is the 05 §3.1 kind of the payload held, and its commitment opens to this agent. With a signed
   * Record in the body (D-107), checks 1–5 of 04 §3.4 as well: the local ones before any read, so a
   * definite mismatch never waits on the chain. Only a read that fails is `unavailable`; anything
   * else that does not match is `mismatch`.
   */
  async #checkRecord(
    contactId: string,
    envelopeId: string,
    chainId: number,
    recordId: string,
    salt: string,
    signedItem: { readonly record: RecordJson; readonly signature: string } | undefined,
  ): Promise<RecordCheck> {
    const chain = this.#chain(chainId);
    if (chain === undefined) return MISMATCH;
    const target = await this.#envelope(envelopeId);
    if (
      target === undefined ||
      target.direction !== 'in' ||
      target.state !== 'ok' ||
      target.contact_id !== contactId
    ) {
      return MISMATCH;
    }
    const payload = await this.#payload(target);
    if (payload === undefined) return MISMATCH;
    const kind = this.#kit.recordKindForPayload(payload);
    if (kind === null) return MISMATCH;
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
        return MISMATCH;
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
    if (signer === ZERO_ADDRESS || state.timestamp === 0n) return MISMATCH;
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
    const onChain =
      stored.status === RECEIPT_RECORDED || (await this.#submitReceipt(stored)) === 'recorded';
    return { status: 'ok', recordId, receipt: type, onChain };
  }

  /**
   * Submits the stored signed Receipt unchanged. On-chain: the row becomes `receipt_recorded` and a
   * commitment part that holds this item becomes `done` (07 §2.1 step 3, §3.5).
   */
  async #submitReceipt(stored: Row<'proofs'>): Promise<ProofOutcome['status'] | 'error'> {
    const chain = this.#chain(stored.chain_id);
    if (chain === undefined) return 'error';
    let status: ProofOutcome['status'];
    try {
      status = (await chain.submitter.acknowledge(parseJson(stored.record_json) as never)).status;
    } catch {
      this.#ctx.log.warn('receipt submit failed', { code: 'submit_error' });
      return 'error';
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
      this.#ctx.log.info('receipt conflicts on-chain', { code: 'receipt_conflict' });
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

  /** The deferred ACCEPTED of an approved accept scope (07 §2.1 step 4; D-55). */
  async #deferred(row: Row<'proofs'>, checked: ReceivedItem['received']): Promise<number> {
    const terms = this.#deps.terms();
    const d = await terms.deferredReceipt({
      envelopeHash: checked.envelopeHash,
      kind: 'OFFER',
      signer: checked.signer,
    });
    if (d.status !== 'ready') {
      if (d.status === 'void') this.#ctx.log.info('deferred receipt void', { code: d.code });
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
   * Runs the deferred ACCEPTED for every received OFFER record (07 §2.1 step 4): after an accept
   * whose offer was already recorded, so its receipt is signed without a second approval.
   */
  async runDeferredReceipts(): Promise<number> {
    if (this.#platform === undefined) return 0;
    const rows = await this.#ctx.store.transaction((tx) =>
      tx.select('proofs', { status: 'received' }),
    );
    let n = 0;
    for (const row of rows) {
      const item = this.#received(row);
      if (item?.kind !== RECORD_KIND.OFFER) continue;
      try {
        n += await this.#deferred(row, item);
      } catch {
        this.#ctx.log.warn('deferred receipt failed', { code: 'deferred_error' });
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
      this.#ctx.log.warn('proof pack not built', { code: 'pack_invalid' });
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
      const signed = signedApprovalDecideSchema.safeParse(parseJson(approval.signed_decision));
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
      return { signed: parseJson(approval.signed_decision), action };
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
