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
// - opens the recipient commitment with a disclosed salt, and takes receipts from `RecordState`;
// - with a disclosed content key, checks the content in the 07 §8 order (content.ts).
// No log queries (some RPCs prune logs) and no 4thTech service. The result carries fixed codes and
// values from the chain or from fields the chain has confirmed; nothing is echoed from a refused pack.
import {
  decodeEcdsaSignature,
  encodeHex0x,
  equalBytes,
  decodeHex0x,
  hashRecord,
  occV2Domain,
  recipientCommitment,
  recoverEvmAddress,
} from '@4thtech-io/crypto';
import { RECEIPT_TYPE_NAMES, type Payload, type ReceiptTypeName } from '@4thtech-io/types';
import { parseAbi, type Address, type Hex as ViemHex } from 'viem';
import type { ChainConfig } from '../config/index.js';
import { notaryReader } from '../clients/calls.js';
import { ChainError } from '../clients/errors.js';
import type { ReadClient } from '../clients/read-client.js';
import { ChainInputError, computeRecordId, type Hex } from '../ids/index.js';
import { checkDisclosedContent } from './content.js';
import { parseProofPack, type ParsedProofPack } from './parse.js';
import { proofFailureMessage, type ProofContentFailure, type ProofPackFailure } from './reasons.js';

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
}

export type ProofContentResult =
  | { readonly status: 'not_disclosed' }
  /** The payload is untrusted content (I-5): show it only inside the untrusted block (06 §4). */
  | { readonly status: 'verified'; readonly payload: Payload }
  | { readonly status: 'failed'; readonly reason: ProofContentFailure; readonly message: string };

export interface ProofPackValid {
  readonly valid: true;
  readonly chainId: number;
  /** The chain's config key. */
  readonly chain: string;
  readonly notary: Hex;
  readonly recordId: Hex;
  readonly signer: Hex;
  /** `account` for an ECDSA signer, `contract` for an ERC-1271 account. */
  readonly signerType: 'account' | 'contract';
  readonly kind: number;
  /** RFC 3339 UTC: when the Notary stored the record. */
  readonly timestamp: string;
  readonly envelopeHash: Hex;
  /** The disclosed recipient, once its salt opened the commitment; null when not disclosed. */
  readonly recipient: { readonly evm: Hex } | null;
  /** Every receipt the chain holds for the record, in type order. */
  readonly receipts: readonly VerifiedReceipt[];
  readonly contentVerified: boolean;
  readonly content: ProofContentResult;
}

export interface ProofPackInvalid {
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

const invalid = (reason: ProofPackFailure): ProofPackInvalid =>
  Object.freeze({ valid: false, reason, message: proofFailureMessage(reason) });

/** A chain answer failed: not a property of the pack. */
class Unavailable extends Error {}

const iso = (seconds: bigint): string =>
  new Date(Number(seconds) * 1000).toISOString().replace('.000Z', 'Z');

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
  readonly receiptAt: readonly bigint[];
}

async function readRecord(chain: VerifyChain, recordId: Hex): Promise<RecordState> {
  try {
    const state = await notaryReader(chain.client, chain.config).read.getRecord([recordId]);
    return state as unknown as RecordState;
  } catch {
    // ChainErrors carry no URL; none of their detail leaves here either.
    throw new Unavailable();
  }
}

/**
 * OpenZeppelin `SignatureChecker.isValidSignatureNow` (05 §3.2): a canonical 65-byte ECDSA signature
 * that recovers `signer`, else an ERC-1271 account at `signer` that returns the magic value.
 */
async function checkSignature(
  chain: VerifyChain,
  signer: Hex,
  digest: Uint8Array,
  signature: string,
): Promise<'account' | 'contract' | null> {
  try {
    const recovered = recoverEvmAddress(digest, decodeEcdsaSignature(signature));
    if (equalBytes(recovered, decodeHex0x(signer, { length: 20 }))) return 'account';
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
    // A revert or an undecodable answer is a refusal by the account; anything else is the chain's.
    if (
      error instanceof ChainError &&
      (error.code === 'call_reverted' || error.code === 'invalid_call')
    ) {
      return null;
    }
    throw new Unavailable();
  }
  return typeof word === 'string' && word.toLowerCase() === ERC1271_MAGIC_WORD ? 'contract' : null;
}

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
    const state = await readRecord(chain, recordId);
    if (state.signer.toLowerCase() === ZERO_ADDRESS || state.timestamp === 0n) {
      return invalid('record_not_found');
    }
    if (state.signer.toLowerCase() !== signer) return invalid('signer_mismatch');
    if (state.kind !== record.kind) return invalid('kind_mismatch');
    if (state.envelopeHash.toLowerCase() !== record.envelopeHash) {
      return invalid('envelope_hash_mismatch');
    }
    if (state.recipientCommitment.toLowerCase() !== record.recipientCommitment) {
      return invalid('commitment_mismatch');
    }
    if (state.recordStructHash.toLowerCase() !== structHash) return invalid('record_mismatch');

    // 2. The signer's signature over the EIP-712 digest under this chain's OCC v2 domain.
    const signerType = await checkSignature(chain, signer, hashes.digest, pack.signature);
    if (signerType === null) return invalid('signature_invalid');

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

    // 4. Receipts come from RecordState; each one the pack lists must be there, at the same time.
    const receipts: VerifiedReceipt[] = [];
    RECEIPT_TYPE_NAMES.forEach((type, i) => {
      const at = state.receiptAt[i] ?? 0n;
      if (at > 0n) receipts.push(Object.freeze({ type, at: iso(at) }));
    });
    for (const claimed of pack.receipts) {
      const onChain = receipts.find((r) => r.type === claimed.type);
      if (!onChain) return invalid('receipt_not_on_chain');
      if (onChain.at !== claimed.at) return invalid('receipt_mismatch');
    }

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
        );
      } catch {
        check = { ok: false as const, reason: 'decrypt_failed' as const };
      }
      content = check.ok
        ? Object.freeze({ status: 'verified', payload: check.payload })
        : Object.freeze({
            status: 'failed',
            reason: check.reason,
            message: proofFailureMessage(check.reason),
          });
    }

    return Object.freeze({
      valid: true,
      chainId: chain.config.chainId,
      chain: chain.config.key,
      notary,
      recordId,
      signer,
      signerType,
      kind: record.kind,
      timestamp: iso(state.timestamp),
      envelopeHash: record.envelopeHash as Hex,
      recipient,
      receipts: Object.freeze(receipts),
      contentVerified: content.status === 'verified',
      content,
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
