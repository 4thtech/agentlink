// verifyProofPack (07 §6.2, §8; 05 §3.1, §3.3; 02 J5, F-44; M1-4d).
//
// A proof pack is untrusted (I-5). The verifier:
// - parses it strictly (parse.ts) and takes the chain from the caller's supported list by the pack's
//   `chainId`, and the Notary address from that chain's shipped config, never from the pack (06 §2.4);
// - recomputes the record ID and the EIP-712 struct hash and digest from `pack.record`;
// - reads `getRecord` once, through the caller's read client (address-checked fetch, URL-free
//   errors), and compares signer, kind, envelope hash, recipient commitment and struct hash;
// - checks the signature as OpenZeppelin SignatureChecker does: canonical ECDSA recovery first, then
//   ERC-1271 `isValidSignature` through `eth_call` when the signer has code;
// - with the signer's agent card, checks `cardSig` (by the card's `ownerEvm`, 04 §2.4) and that the
//   card had not expired when the record was made, and that its owner and agent keys differ (04 §2.9;
//   M1-4d-b); with the card's proof of possession, checks that the agent's EVM key (`cardAgentSig`)
//   and message key (`cardPop`) both signed this exact card (04 §2.9, 07 §8; M1-4d-d, D-102);
// - opens the recipient commitment with a disclosed salt, and takes receipts from `RecordState`,
//   whose `receiptFlags` must agree with `receiptAt` (D-97); checks each listed receipt's `txHash`
//   with one transaction-receipt read, or reports it as not checked (receipts.ts; M1-4d-c);
// - reports a contract-account signer that no longer confirms its signature with the non-fatal
//   code `signer_no_longer_confirms`, the verdict unchanged (D-96);
// - checks the owner approval against the record and the card, or reports the standing rule
//   (approval.ts; M1-4d-c);
// - with a disclosed content key, checks the content in the 07 §8 order (content.ts), including that
//   the card names the envelope's sender (IR-M1-4d-1 M-1). Content is attributed to the record
//   signer (`verified`) only with a valid proof of possession and an ECDSA signer (D-102).
// No log queries (some RPCs prune logs) and no 4thTech service. The result carries fixed codes,
// values from the chain or from fields the chain has confirmed, and `signerCard`, which the owner
// signed (checked by `cardSig`, not by the chain); nothing is echoed from a refused pack.
import {
  decodeEcdsaSignature,
  encodeHex0x,
  equalBytes,
  decodeHex0x,
  hashRecord,
  occV2Domain,
  recipientCommitment,
  recoverEvmAddress,
  verifyCardOwnerSig,
  // The card's proof of possession (04 §2.9, 07 §8; D-102): cardAgentSig and cardPop; never throws.
  verifyCardPossession,
} from '@4thtech-io/crypto';
import {
  RECEIPT_TYPE_NAMES,
  type AgentCard,
  type Payload,
  type ReceiptTypeName,
} from '@4thtech-io/types';
import { parseAbi, type Address, type Hex as ViemHex } from 'viem';
import type { ChainConfig } from '../config/index.js';
import { notaryReader } from '../clients/calls.js';
import { ChainError } from '../clients/errors.js';
import type { ReadClient } from '../clients/read-client.js';
import { ChainInputError, computeRecordId, type Hex } from '../ids/index.js';
import { verifyOwnerApproval, type OwnerApprovalResult } from './approval.js';
import { checkDisclosedContent } from './content.js';
import { parseProofPack, type ParsedProofPack } from './parse.js';
import {
  proofFailureMessage,
  proofNoticeMessage,
  type ProofContentFailure,
  type ProofNoticeCode,
  type ProofPackFailure,
} from './reasons.js';
import { NOT_CHECKED, checkReceiptTx, receiptFlagsConsistent, type ReceiptTx } from './receipts.js';

/** A chain the verifier may read: its shipped config and a read client for it. */
export interface VerifyChain {
  readonly config: ChainConfig;
  readonly client: ReadClient;
}

export interface VerifyProofPackOptions {
  /**
   * The supported chains (07 §6.1), each with its read client. The pack's `chainId` picks one; a
   * pack for any other chain is `unsupported_chain`.
   */
  readonly chains: readonly VerifyChain[];
}

/** A receipt as the chain records it (05 §3.3 `receiptAt`). */
export interface VerifiedReceipt {
  readonly type: ReceiptTypeName;
  /** RFC 3339 UTC, from the block timestamp the Notary stored. */
  readonly at: string;
  /** What the `txHash` the pack names for it shows (M1-4d-c); the receipt stands either way. */
  readonly tx: ReceiptTx;
}

/** A non-fatal finding: the pack verifies and the verdict is unchanged (M1-4d-c). */
export interface ProofNotice {
  readonly code: ProofNoticeCode;
  readonly message: string;
}

/**
 * The disclosed content. A payload is untrusted content (I-5): show it only inside the untrusted
 * block (06 §4). `sender` is the envelope's `from` (64 lowercase hex, 04 §3.1), whose signature over
 * the envelope verified.
 * - `verified`: the content is attributed to the record signer: the signer's card names `sender`
 *   as its key, both of the card's agent keys signed the card (`cardAgentSig`, `cardPop`), and the
 *   signer is not a contract account (07 §8; M1-4d-d, D-102);
 * - `unattributed`: the content verifies, but it is not attributed to the record signer: the pack
 *   carries no card (`sender_not_bound`), or the card names `sender` as the agent's key without
 *   proof of possession, or the signer is a contract account (`card_pop_missing`); never show the
 *   signer as its author;
 * - `failed`: the pack proves no content (`reason`), including `sender_mismatch`, when the card
 *   names another key (a recipient that notarized an envelope it received, IR-M1-4d-1 M-1).
 */
export type ProofContentResult =
  | { readonly status: 'not_disclosed' }
  | { readonly status: 'verified'; readonly payload: Payload; readonly sender: string }
  | {
      readonly status: 'unattributed';
      readonly reason: 'sender_not_bound' | 'card_pop_missing';
      readonly message: string;
      readonly payload: Payload;
      readonly sender: string;
    }
  | { readonly status: 'failed'; readonly reason: ProofContentFailure; readonly message: string };

/**
 * How far the result can be trusted, the field to show first (IR-M1-4d-1 M-2):
 * - `verified`: the record, its receipts and the disclosed content all verify, and the content is
 *   attributed to the signer (proof of possession, M1-4d-d);
 * - `record_only`: the record and its receipts verify, but no content was disclosed, the
 *   disclosed content failed, or it is not attributed to the signer (`content`); never show this
 *   as a full pass;
 * - `failed`: the pack proves nothing (`reason`).
 */
export type ProofVerdict = 'verified' | 'record_only' | 'failed';

/** The block the record was read at: `finalized` (no reorg can remove it) or `latest`. */
export type Finality = 'finalized' | 'latest';

export interface ProofPackValid {
  readonly verdict: 'verified' | 'record_only';
  /** The record and its receipts verify. Read `verdict` for the content. */
  readonly valid: true;
  readonly chainId: number;
  /** The chain's config key. */
  readonly chain: string;
  readonly notary: Hex;
  readonly recordId: Hex;
  readonly signer: Hex;
  /** `account` for an ECDSA signer, `contract` for an ERC-1271 account. */
  readonly signerType: 'account' | 'contract';
  /**
   * The signer's agent card (04 §2.4) when the pack carries one: `cardSig` recovered to its
   * `ownerEvm`, its `agentEvm` is the signer and differs from `ownerEvm`, and it had not expired
   * when the record was made. It is the owner's signed statement, not a value the chain confirms;
   * the display name and relays it hashes are not checked here.
   * Null when the pack carries no card.
   */
  readonly signerCard: AgentCard | null;
  readonly kind: number;
  /** RFC 3339 UTC: when the Notary stored the record. */
  readonly timestamp: string;
  /** `finalized` where the chain answers that tag and the record is final; otherwise `latest`. */
  readonly finality: Finality;
  readonly envelopeHash: Hex;
  /** The disclosed recipient, once its salt opened the commitment; null when not disclosed. */
  readonly recipient: { readonly evm: Hex } | null;
  /** Every receipt the chain holds for the record, in type order. */
  readonly receipts: readonly VerifiedReceipt[];
  readonly contentVerified: boolean;
  readonly content: ProofContentResult;
  /** The owner approval the pack carries, checked against this record (07 §8; M1-4d-c). */
  readonly ownerApproval: OwnerApprovalResult;
  /** Non-fatal findings, in a fixed order; empty when there are none. */
  readonly notices: readonly ProofNotice[];
}

export interface ProofPackInvalid {
  readonly verdict: 'failed';
  readonly valid: false;
  readonly reason: ProofPackFailure;
  readonly message: string;
}

export type ProofPackResult = ProofPackValid | ProofPackInvalid;

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const ZERO32 = `0x${'0'.repeat(64)}`;
/**
 * ERC-1271 `isValidSignature(bytes32,bytes)`: a valid signature returns its selector, 0x1626ba7e.
 * SignatureChecker reads the answer as one bytes32 word and compares it with the selector padded on
 * the right, so the answer is decoded as bytes32 here too.
 */
const ERC1271_MAGIC_WORD = `0x1626ba7e${'0'.repeat(56)}`;
const ERC1271_ABI = parseAbi([
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes32)',
]);

/** ChainError codes that mean the chain could not be asked, not that the account refused. */
const CHAIN_FAILURES: ReadonlySet<string> = new Set([
  'rpc_timeout',
  'rpc_unavailable',
  'rpc_error',
  'method_refused',
]);

const notice = (code: ProofNoticeCode): ProofNotice =>
  Object.freeze({ code, message: proofNoticeMessage(code) });

const invalid = (reason: ProofPackFailure): ProofPackInvalid =>
  Object.freeze({
    verdict: 'failed',
    valid: false,
    reason,
    message: proofFailureMessage(reason),
  });

/** A chain answer failed: not a property of the pack. */
class Unavailable extends Error {}

/** The latest second an RFC 3339 `YYYY-…Z` timestamp (and a JS Date) can hold: 9999-12-31T23:59:59Z. */
const MAX_TIMESTAMP = 253_402_300_799n;

/** RFC 3339 UTC, or null for a chain time no such timestamp can hold. */
const iso = (seconds: bigint): string | null =>
  seconds > MAX_TIMESTAMP
    ? null
    : new Date(Number(seconds) * 1000).toISOString().replace('.000Z', 'Z');

function checkOptions(options: unknown): readonly VerifyChain[] {
  const chains = (options as { chains?: unknown } | null)?.chains;
  if (!Array.isArray(chains)) {
    throw new ChainInputError('invalid_verify_options', 'options.chains: must be an array');
  }
  for (const entry of chains as unknown[]) {
    const e = entry as { config?: { chainId?: unknown }; client?: unknown } | null;
    if (
      typeof e !== 'object' ||
      e === null ||
      typeof e.config?.chainId !== 'number' ||
      typeof e.client !== 'object' ||
      e.client === null
    ) {
      throw new ChainInputError(
        'invalid_verify_options',
        'options.chains: each entry needs a chain config and a read client',
      );
    }
  }
  return chains as readonly VerifyChain[];
}

interface RecordState {
  readonly signer: string;
  readonly timestamp: bigint;
  readonly kind: number;
  readonly envelopeHash: string;
  readonly recipientCommitment: string;
  readonly recordStructHash: string;
  readonly receiptFlags: number;
  readonly receiptAt: readonly bigint[];
}

async function readRecordAt(
  chain: VerifyChain,
  recordId: Hex,
  blockTag: 'finalized' | 'latest',
): Promise<RecordState> {
  try {
    const state = await notaryReader(chain.client, chain.config).read.getRecord([recordId], {
      blockTag,
    });
    return state as unknown as RecordState;
  } catch {
    // ChainErrors carry no URL; none of their detail leaves here either.
    throw new Unavailable();
  }
}

const exists = (state: RecordState): boolean =>
  state.signer.toLowerCase() !== ZERO_ADDRESS && state.timestamp !== 0n;

/**
 * The blocks to read the record at, in order (IR-M1-4d-1 M-3, IR-M1-4d-2 R2-M-1): `finalized` where
 * the chain answers that tag (07 §6.1 `finalizedTag`), so a reorg cannot remove what it shows; then
 * `latest`, for a record or a receipt that is not final yet. The first block at which the pack
 * matches the chain wins, and the result reports which one.
 */
const blockTags = (chain: VerifyChain): readonly Finality[] =>
  chain.config.finalizedTag ? ['finalized', 'latest'] : ['latest'];

/** The signer's kind, and whether a contract account still confirms the signature (D-96). */
interface SignatureCheck {
  readonly type: 'account' | 'contract';
  readonly confirms: boolean;
}

const ACCOUNT: SignatureCheck = Object.freeze({ type: 'account', confirms: true });
const CONTRACT_CONFIRMS: SignatureCheck = Object.freeze({ type: 'contract', confirms: true });
const CONTRACT_REFUSES: SignatureCheck = Object.freeze({ type: 'contract', confirms: false });

/**
 * OpenZeppelin `SignatureChecker.isValidSignatureNow` (05 §3.2): a canonical 65-byte ECDSA signature
 * that recovers `signer`, else an ERC-1271 account at `signer` that returns the magic value. Null
 * when the signer has no code and the signature does not recover to it (`signature_invalid`). An
 * account with code that does not return the magic value now is `confirms: false`: the Notary
 * checked the signature when it stored the record, so that is a non-fatal finding (D-96).
 */
async function checkSignature(
  chain: VerifyChain,
  signer: Hex,
  digest: Uint8Array,
  signature: string,
): Promise<SignatureCheck | null> {
  try {
    const recovered = recoverEvmAddress(digest, decodeEcdsaSignature(signature));
    if (equalBytes(recovered, decodeHex0x(signer, { length: 20 }))) return ACCOUNT;
  } catch {
    // Not a canonical ECDSA signature: only an ERC-1271 account can accept it.
  }
  let code: string | undefined;
  try {
    code = await chain.client.getCode({ address: signer as Address });
  } catch {
    throw new Unavailable();
  }
  if (code === undefined || code === '0x') return null;
  let word: string;
  try {
    // Decoded as one bytes32 word, as SignatureChecker does: a shorter answer is a refusal.
    word = await chain.client.readContract({
      address: signer as Address,
      abi: ERC1271_ABI,
      functionName: 'isValidSignature',
      args: [encodeHex0x(digest) as ViemHex, signature as ViemHex],
    });
  } catch (error) {
    // Only a failure to reach or ask the chain is the chain's. A revert, an empty answer or one that
    // does not decode is a refusal by the account, as in SignatureChecker (IR-M1-4d-1 L-1).
    if (error instanceof ChainError && CHAIN_FAILURES.has(error.code)) throw new Unavailable();
    return CONTRACT_REFUSES;
  }
  return typeof word === 'string' && word.toLowerCase() === ERC1271_MAGIC_WORD
    ? CONTRACT_CONFIRMS
    : CONTRACT_REFUSES;
}

/** A receipt the chain holds, before its `txHash` is checked. */
interface ChainReceipt {
  readonly type: ReceiptTypeName;
  readonly at: string;
  readonly seconds: bigint;
}

interface OnChainMatch {
  /** The record's chain time in seconds, and as RFC 3339 UTC. */
  readonly seconds: bigint;
  readonly timestamp: string;
  readonly finality: Finality;
  readonly receipts: readonly ChainReceipt[];
}

/**
 * Compares the pack with the record state read at one block: existence, the record fields, and the
 * receipts (05 §3.3: every one the pack lists must be stored, at the same second). Returns the
 * failure code, or the chain's timestamp and receipts.
 */
function matchState(
  state: RecordState,
  pack: ParsedProofPack,
  structHash: string,
  finality: Finality,
): OnChainMatch | ProofPackFailure {
  const record = pack.record;
  if (!exists(state)) return 'record_not_found';
  const timestamp = iso(state.timestamp);
  if (timestamp === null || state.receiptAt.some((at) => at > MAX_TIMESTAMP)) {
    return 'malformed_record';
  }
  // D-97: the flags must agree with the receipt times (05 §3.3 layout).
  if (!receiptFlagsConsistent(state.receiptFlags, state.receiptAt)) return 'malformed_record';
  if (state.signer.toLowerCase() !== record.signer) return 'signer_mismatch';
  if (state.kind !== record.kind) return 'kind_mismatch';
  if (state.envelopeHash.toLowerCase() !== record.envelopeHash) return 'envelope_hash_mismatch';
  if (state.recipientCommitment.toLowerCase() !== record.recipientCommitment) {
    return 'commitment_mismatch';
  }
  if (state.recordStructHash.toLowerCase() !== structHash) return 'record_mismatch';
  const receipts: ChainReceipt[] = [];
  RECEIPT_TYPE_NAMES.forEach((type, i) => {
    const at = state.receiptAt[i] ?? 0n;
    if (at > 0n) receipts.push(Object.freeze({ type, at: iso(at) as string, seconds: at }));
  });
  for (const claimed of pack.receipts) {
    const onChain = receipts.find((r) => r.type === claimed.type);
    if (!onChain) return 'receipt_not_on_chain';
    if (onChain.at !== claimed.at) return 'receipt_mismatch';
  }
  return { seconds: state.timestamp, timestamp, finality, receipts };
}

/** Content attributed to the record signer (07 §8; M1-4d-d). */
const isAttributed = (content: ProofContentResult): boolean => content.status === 'verified';

async function verifyParsed(
  pack: ParsedProofPack,
  chains: readonly VerifyChain[],
): Promise<ProofPackResult> {
  const chain = chains.find((c) => c.config.chainId === pack.chainId);
  if (!chain) return invalid('unsupported_chain');
  const notary = chain.config.contracts.notary.toLowerCase() as Hex;
  if (pack.notary !== notary) return invalid('notary_mismatch');

  const record = pack.record;
  const signer = record.signer as Hex;
  const recordId = computeRecordId(chain.config.chainId, notary, signer, BigInt(record.nonce));
  if (pack.recordId !== recordId) return invalid('record_id_mismatch');
  const hashes = hashRecord(occV2Domain(chain.config.chainId, notary), record);
  const structHash = encodeHex0x(hashes.structHash);

  try {
    // 1. The record as the chain holds it (05 §3.3: every field is checkable from getRecord alone).
    // A mismatch at `finalized` may only mean the record or a receipt is newer than that block:
    // read again at `latest`, and fail only when the pack does not match there either.
    let matched: OnChainMatch | undefined;
    let failure: ProofPackFailure = 'record_not_found';
    for (const tag of blockTags(chain)) {
      const result = matchState(await readRecordAt(chain, recordId, tag), pack, structHash, tag);
      if (typeof result === 'string') failure = result;
      else {
        matched = result;
        break;
      }
    }
    if (!matched) return invalid(failure);
    const { seconds, timestamp, finality, receipts } = matched;

    // 2. The signer's signature over the EIP-712 digest under this chain's OCC v2 domain. A contract
    // account that no longer confirms it is a non-fatal finding (D-96); a signer without code whose
    // signature does not recover to it fails.
    const signatureCheck = await checkSignature(chain, signer, hashes.digest, pack.signature);
    if (signatureCheck === null) return invalid('signature_invalid');
    const signerType = signatureCheck.type;
    const notices: ProofNotice[] = [];
    if (!signatureCheck.confirms) notices.push(notice('signer_no_longer_confirms'));

    // 2b. The signer's agent card, when the pack carries one (04 §2.4; M1-4d-b). The schema already
    // holds `cardSig` with the card and the card's `agentEvm` equal to the signer; checked again
    // here, fail closed. The card is the owner's statement, signed with `ownerEvm`, that `agentNostr`
    // is this agent's key; it must have been in force when the record was made (`expiresAt` 0 is no
    // expiry). Its owner and agent keys must differ (04 §2.9).
    let signerCard: AgentCard | null = null;
    const card = pack.signer.agentCard;
    if (card !== undefined) {
      if (
        card.agentEvm !== signer ||
        card.ownerEvm === card.agentEvm ||
        !verifyCardOwnerSig(card, pack.signer.cardSig)
      ) {
        return invalid('card_invalid');
      }
      if (card.expiresAt !== 0 && BigInt(card.expiresAt) <= seconds) return invalid('card_expired');
      signerCard = Object.freeze({ ...card });
    }

    // 2c. The card's proof of possession (07 §8; M1-4d-d, D-102). The schema holds the two
    // signatures together and only with the card; checked again here, fail closed. Either one that
    // does not verify over this exact card refuses the pack before any content step. Possession is
    // proven only for an ECDSA signer: a contract account is not attributed through a card in this
    // version (M1-4d-e), though its signatures, when present, must still verify.
    const { cardAgentSig, cardPop } = pack.signer;
    let cardPossession = false;
    if (cardAgentSig !== undefined || cardPop !== undefined) {
      if (signerCard === null || cardAgentSig === undefined || cardPop === undefined) {
        return invalid('malformed_pack');
      }
      if (!verifyCardPossession(signerCard, cardAgentSig, cardPop)) {
        return invalid('card_pop_invalid');
      }
      cardPossession = true;
    }
    const attributable = cardPossession && signerType === 'account';

    // 3. A disclosed recipient must open the commitment (04 §5); a self-note has none to open.
    let recipient: { evm: Hex } | null = null;
    if (pack.recipient !== undefined) {
      const opened =
        record.recipientCommitment !== ZERO32 &&
        encodeHex0x(recipientCommitment(pack.recipient.evm, pack.recipient.salt)) ===
          record.recipientCommitment;
      if (!opened) return invalid('recipient_mismatch');
      recipient = Object.freeze({ evm: pack.recipient.evm as Hex });
    }

    // 4. Receipts came from RecordState (matchState): each one the pack lists is there, on time,
    // and the flags agree with the times (D-97). The `txHash` the pack names for each is checked
    // with one transaction-receipt read; a mismatch is a non-fatal finding (receipts.ts).
    const verifiedReceipts: VerifiedReceipt[] = [];
    let txMismatch = false;
    for (const onChain of receipts) {
      const claimed = pack.receipts.find((r) => r.type === onChain.type);
      const tx =
        claimed === undefined
          ? NOT_CHECKED
          : await checkReceiptTx(chain, notary, recordId, claimed, onChain.seconds);
      if (tx.status === 'mismatch') txMismatch = true;
      verifiedReceipts.push(Object.freeze({ type: onChain.type, at: onChain.at, tx }));
    }
    if (txMismatch) notices.push(notice('receipt_tx_mismatch'));

    // 5. Content, only with a disclosed key, in the 07 §8 order.
    let content: ProofContentResult = Object.freeze({ status: 'not_disclosed' });
    if (pack.disclosure !== null) {
      let check;
      try {
        check = await checkDisclosedContent(
          pack.envelope,
          pack.disclosure.contentKey,
          record.envelopeHash,
          record.kind,
          signerCard?.agentNostr ?? null,
        );
      } catch {
        check = { ok: false as const, reason: 'decrypt_failed' as const };
      }
      if (!check.ok) {
        content = Object.freeze({
          status: 'failed',
          reason: check.reason,
          message: proofFailureMessage(check.reason),
        });
      } else if (attributable) {
        // Opened, from the card's agentNostr (content.ts), and both of the card's agent keys
        // signed that card: the content is the record signer's (07 §8; D-102).
        content = Object.freeze({
          status: 'verified',
          payload: check.payload,
          sender: check.sender,
        });
      } else {
        // Opened. Without a card nothing in the pack binds the sender to the signer (IR-M1-4d-1
        // M-1). With one, the card names the sender, but without its proof of possession, or for a
        // contract-account signer, the content stays unattributed (07 §8; D-95, D-102).
        const reason = signerCard === null ? 'sender_not_bound' : 'card_pop_missing';
        content = Object.freeze({
          status: 'unattributed',
          reason,
          message: proofFailureMessage(reason),
          payload: check.payload,
          sender: check.sender,
        });
      }
    }

    // 6. The owner approval, against this record, the signer's card and the opened content
    // (approval.ts; M1-4d-c): a signer-side approval is bound to this record only through it.
    const opened =
      content.status === 'verified' || content.status === 'unattributed' ? content.payload : null;
    const ownerApproval = verifyOwnerApproval(pack, signerCard, opened);
    if (ownerApproval === null) return invalid('owner_approval_invalid');

    const contentVerified = isAttributed(content);
    return Object.freeze({
      verdict: contentVerified ? 'verified' : 'record_only',
      valid: true,
      chainId: chain.config.chainId,
      chain: chain.config.key,
      notary,
      recordId,
      signer,
      signerType,
      signerCard,
      kind: record.kind,
      timestamp,
      finality,
      envelopeHash: record.envelopeHash as Hex,
      recipient,
      receipts: Object.freeze(verifiedReceipts),
      contentVerified,
      content,
      ownerApproval,
      notices: Object.freeze(notices),
    });
  } catch (error) {
    if (error instanceof Unavailable) return invalid('chain_unavailable');
    throw error;
  }
}

/**
 * Verifies a proof pack (07 §8) against the chain it names. `pack` is the pack's JSON text, its
 * UTF-8 bytes, or a parsed JSON object; at most MAX_PROOF_PACK_BYTES. Resolves to a result with a
 * fixed reason for every failure; it rejects only for bad `options` (a ChainInputError).
 */
export async function verifyProofPack(
  pack: string | Uint8Array | object,
  options: VerifyProofPackOptions,
): Promise<ProofPackResult> {
  const chains = checkOptions(options);
  const parsed = parseProofPack(pack);
  if (!parsed.ok) return invalid(parsed.reason);
  try {
    return await verifyParsed(parsed.pack, chains);
  } catch {
    // Unexpected (a hashing refusal on a value the schema let through): fail closed, no detail.
    return invalid('malformed_pack');
  }
}
