// Per-path decoders of the 04 §2.4.1 canonical binary encodings (M1-2a).
//
// Rules (04 §2.4.1):
// - The decoder is chosen by schema path, never by field name alone: `nonce`, `sig` and `id` mean
//   different things on different paths. Each path below names the schema that holds it.
// - A value decodes only in its path's one canonical form. Anything else is rejected (null), never
//   normalised: no trimming, lower-casing or prefix fixing.
// - Where a schema in this package has the path, its own leaf validates the value, so the table and
//   the object schemas cannot disagree (terms since M1-21). Paths whose objects are built elsewhere (EIP-3009,
//   submitter bodies, drop bodies, tool outputs) use the primitive of their table row.
// - Comparisons decode both values, each by its own path, and compare the bytes.
// Validators never throw on hostile input; they report null.
import type { z } from 'zod';
import { agentCardSchema, cardAgentSigSchema, cardSigSchema, inviteSchema } from './card.js';
import { BYTE_LENGTHS } from './constants.js';
import {
  approvalIdSchema,
  base64url,
  base64urlToBytes,
  bip340SigHex,
  bytes32Hex,
  bytesEqual,
  evmAddress,
  hex0xToBytes,
  hexToBytes,
  nostrPubkeyHex,
  sha256Hex,
  uint256Decimal,
} from './encoding.js';
import { aeadSchema, envelopeSchema, recipientSchema } from './envelope.js';
import {
  agentRevokeActionSchema,
  approvalDecideParamsSchema,
  contactCheckParamsSchema,
  signedOwnerActionSchema,
} from './owner-action.js';
import {
  approvalFeeSchema,
  commitmentAnswersSchema,
  commitmentScopeSchema,
  counterpartySchema,
} from './approval.js';
import {
  approvalRequestBodySchema,
  fileEntrySchema,
  handshakeAckBodySchema,
  handshakeBodySchema,
  offerBodySchema,
  proofBodySchema,
} from './payload.js';
import {
  proofFeeSchema,
  proofPackDisclosureSchema,
  proofPackReceiptSchema,
  proofPackRecipientSchema,
  proofPackSchema,
  proofPackSignerSchema,
  proofStatusShape,
  receiptStructSchema,
  recordSchema,
  recordSignatureSchema,
} from './proof.js';
import { termsDeliverableSchema, termsPriceSchema, termsSchema } from './terms.js';

interface Decoder {
  /** The strict schema of the path: the value must pass it unchanged. */
  readonly schema: z.ZodType;
  /** Bytes of a value that passed `schema`. */
  readonly toBytes: (value: string) => Uint8Array | null;
}

// --- byte conversions of each row ---------------------------------------------------------------

/** A `uint256` decimal string (already strict) as 32 big-endian bytes. */
function uint256ToBytes(value: string): Uint8Array {
  let n = BigInt(value);
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/** The 16 bytes of an `approvalId` after its exact `apr_` prefix. */
const approvalIdToBytes = (value: string): Uint8Array | null => base64urlToBytes(value.slice(4));

const hex0x = (schema: z.ZodType): Decoder => ({ schema, toBytes: hex0xToBytes });
const bare = (schema: z.ZodType): Decoder => ({ schema, toBytes: hexToBytes });
const b64 = (schema: z.ZodType): Decoder => ({ schema, toBytes: base64urlToBytes });
const uint256 = (schema: z.ZodType): Decoder => ({ schema, toBytes: uint256ToBytes });

// --- the leaves of this package's schemas ------------------------------------------------------

const card = agentCardSchema.shape;
const invite = inviteSchema.shape;
const ownerAction = agentRevokeActionSchema.shape;
const envelope = envelopeSchema.shape;
const recipient = recipientSchema.shape;
const aead = aeadSchema.shape;
const file = fileEntrySchema.shape;
const handshake = handshakeBodySchema.shape;
const ack = handshakeAckBodySchema.shape;
const proofBody = proofBodySchema.shape;
const approvalRequest = approvalRequestBodySchema.shape;
const scope = commitmentScopeSchema.shape;
const pack = proofPackSchema.shape;
const record = recordSchema.shape;
const receipt = receiptStructSchema.shape;
const terms = termsSchema.shape;
const termsDeliverable = termsDeliverableSchema.shape;

// The table of 04 §2.4.1, one decoder per schema path. A literal object with a null prototype, so a
// lookup never reaches Object.prototype (`toString`, `__proto__`).
const DECODERS = Object.freeze(
  Object.assign(Object.create(null) as object, {
    // `0x` + 40 hex (address)
    'OwnerAction.agent': hex0x(ownerAction.agent),
    'contact.check.params.contact': hex0x(contactCheckParamsSchema.shape.contact),
    'tool.contact.id': hex0x(evmAddress),
    'tool.agent.id': hex0x(evmAddress),
    'approval-request.agent': hex0x(approvalRequest.agent),
    'approval-request.action.context.fee.token': hex0x(approvalFeeSchema.shape.token),
    'terms.parties[]': hex0x(evmAddress),
    'terms.deliverables[].by': hex0x(termsDeliverable.by),
    'terms.price.payer': hex0x(termsPriceSchema.shape.payer),
    'CommitmentScope.agentId': hex0x(scope.agentId),
    'CommitmentScope.counterparty.agentId': hex0x(counterpartySchema.shape.agentId),
    'policy.contacts.allowed[]': hex0x(evmAddress),
    'policy.commitments.autoAcceptContacts[]': hex0x(evmAddress),
    'policy.contactRules[].contact': hex0x(evmAddress),
    'AgentCard.agentEvm': hex0x(card.agentEvm),
    'AgentCard.ownerEvm': hex0x(card.ownerEvm),
    'ProofPack.notary': hex0x(pack.notary),
    'ProofPack.signer.evm': hex0x(proofPackSignerSchema.shape.evm),
    'ProofPack.recipient.evm': hex0x(proofPackRecipientSchema.shape.evm),
    'ProofPack.receipts[].signer': hex0x(proofPackReceiptSchema.shape.signer),
    'Record.signer': hex0x(record.signer),
    'Receipt.signer': hex0x(receipt.signer),
    'Record.feeToken': hex0x(record.feeToken),
    'ProofStatus.fee.token': hex0x(proofFeeSchema.shape.token),
    'ProofStatus.signer': hex0x(evmAddress),
    'EIP3009.auth.from': hex0x(evmAddress),
    'EIP3009.auth.to': hex0x(evmAddress),

    // `0x` + 64 hex (bytes32)
    'proof.recordId': hex0x(proofBody.recordId),
    'ProofPack.recordId': hex0x(pack.recordId),
    'handshake-ack.handshakeHash': hex0x(ack.handshakeHash),
    'proof.salt': hex0x(proofBody.salt),
    'ProofPack.recipient.salt': hex0x(proofPackRecipientSchema.shape.salt),
    'CommitmentScope.answers.envelopeHash': hex0x(commitmentAnswersSchema.shape.envelopeHash),
    'ProofPack.envelopeHash': hex0x(pack.envelopeHash),
    'Record.envelopeHash': hex0x(record.envelopeHash),
    'Record.recipientCommitment': hex0x(record.recipientCommitment),
    'Record.parentRecordId': hex0x(record.parentRecordId),
    'Record.appId': hex0x(record.appId),
    'Receipt.recordId': hex0x(receipt.recordId),
    'Receipt.salt': hex0x(receipt.salt),
    recordStructHash: hex0x(bytes32Hex),
    txHash: hex0x(proofPackReceiptSchema.shape.txHash),
    'AgentCard.agentNostr': hex0x(card.agentNostr),
    'AgentCard.agentEnc': hex0x(card.agentEnc),
    'AgentCard.ownerNostr': hex0x(card.ownerNostr),
    'AgentCard.ownerEnc': hex0x(card.ownerEnc),
    'AgentCard.nameHash': hex0x(card.nameHash),
    'AgentCard.relaysHash': hex0x(card.relaysHash),
    'DomainClaim.ownerNostr': hex0x(bytes32Hex),
    'EIP3009.auth.nonce': hex0x(bytes32Hex),
    'EIP3009.auth.r': hex0x(bytes32Hex),
    'EIP3009.auth.s': hex0x(bytes32Hex),
    'ProofStatus.recordId': hex0x(proofStatusShape.recordId),
    'ProofStatus.txHash': hex0x(proofStatusShape.txHash),
    'verify_proof_pack.recordId': hex0x(bytes32Hex),
    'verify_proof_pack.envelopeHash': hex0x(bytes32Hex),

    // `0x` + hex (ECDSA signature): canonical 65 bytes; Record-side signatures may be ERC-1271
    'invite.cardSig': hex0x(invite.cardSig),
    'handshake.cardSig': hex0x(handshake.cardSig),
    'handshake-ack.cardSig': hex0x(ack.cardSig),
    'card-update.cardSig': hex0x(cardSigSchema),
    'invite.cardAgentSig': hex0x(invite.cardAgentSig),
    'handshake.cardAgentSig': hex0x(cardAgentSigSchema),
    'card-update.cardAgentSig': hex0x(cardAgentSigSchema),
    'ProofPack.signer.cardSig': hex0x(cardSigSchema),
    'ProofPack.signer.cardAgentSig': hex0x(cardAgentSigSchema),
    'ProofPack.signature': hex0x(pack.signature),
    'submitter.records[].signature': hex0x(recordSignatureSchema),
    'submitter.receipts[].signature': hex0x(recordSignatureSchema),

    // Decimal string (uint256), as 32 big-endian bytes
    'Record.maxFee': uint256(record.maxFee),
    'Record.nonce': uint256(record.nonce),
    'ProofStatus.fee.amount': uint256(proofFeeSchema.shape.amount),
    'approval-request.action.context.fee.amount': uint256(approvalFeeSchema.shape.amount),
    'EIP3009.auth.value': uint256(uint256Decimal),
    'EIP3009.auth.validAfter': uint256(uint256Decimal),
    'EIP3009.auth.validBefore': uint256(uint256Decimal),

    // Bare hex, 64 (Nostr key or event id)
    'envelope.from': bare(envelope.from),
    'OwnerAction.owner': bare(ownerAction.owner),
    'CommitmentScope.counterparty.ownerKey': bare(counterpartySchema.shape.ownerKey),
    'nostr.eventId': bare(nostrPubkeyHex),

    // Bare hex, 128 (BIP-340)
    'envelope.sig': bare(envelope.sig),
    'SignedOwnerAction.sig': bare(signedOwnerActionSchema.shape.sig),
    'handshake.cardPop': bare(bip340SigHex),
    'handshake-ack.cardPop': bare(bip340SigHex),
    'card-update.cardPop': bare(bip340SigHex),
    'ProofPack.signer.cardPop': bare(bip340SigHex),

    // Bare hex, 64 (digest under a Nostr key only)
    'approval-request.actionDigest': bare(approvalRequest.actionDigest),
    'approval.decide.params.actionDigest': bare(approvalDecideParamsSchema.shape.actionDigest),
    'terms-body.termsHash': bare(offerBodySchema.shape.termsHash),
    'terms.previousTermsHash': bare(terms.previousTermsHash),
    'CommitmentScope.termsHash': bare(scope.termsHash),
    'payload.files[].plaintextSha256': bare(file.plaintextSha256),
    'terms.deliverables[].plaintextSha256': bare(termsDeliverable.plaintextSha256),
    'payload.files[].ciphertextSha256': bare(file.ciphertextSha256),
    'drop-commit.ciphertextSha256': bare(sha256Hex),
    'ProofPack.ownerApproval.policyHash': bare(sha256Hex),
    'handshake.inviterCardHash': bare(handshake.inviterCardHash),
    'contact.check.params.pairingDigest': bare(contactCheckParamsSchema.shape.pairingDigest),
    'tool.termsHash': bare(sha256Hex),

    // base64url without padding
    'envelope.id': b64(envelope.id),
    'envelope.thread': b64(envelope.thread),
    'envelope.recipients[].kid': b64(recipient.kid),
    'envelope.recipients[].enc': b64(recipient.enc),
    'envelope.recipients[].wk': b64(recipient.wk),
    'envelope.aead.iv': b64(aead.iv),
    'envelope.aead.kc': b64(aead.kc),
    'envelope.aead.ct': b64(aead.ct),
    'payload.replyTo': b64(base64url(BYTE_LENGTHS.id)),
    // `inline` is nullable in the file entry; null is not an encoded value, so only the string form.
    'payload.files[].inline': b64(file.inline.unwrap()),
    'payload.files[].fileKey': b64(file.fileKey),
    'proof.envelopeId': b64(proofBody.envelopeId),
    'CommitmentScope.answers.envelopeId': b64(commitmentAnswersSchema.shape.envelopeId),
    'CommitmentScope.thread': b64(scope.thread),
    'CommitmentScope.termsId': b64(scope.termsId),
    'terms.termsId': b64(terms.termsId),
    'invite.inviteId': b64(invite.inviteId),
    'invite.secret': b64(invite.secret),
    'invite.codeCommit': b64(invite.codeCommit),
    'handshake.inviteId': b64(handshake.inviteId),
    'handshake.proof': b64(handshake.proof),
    'handshake.codeNonce': b64(handshake.codeNonce),
    'handshake.codeCommit': b64(handshake.codeCommit),
    'handshake-ack.inviteId': b64(ack.inviteId),
    'handshake-ack.handshakeId': b64(ack.handshakeId),
    'handshake-ack.codeReveal': b64(ack.codeReveal),
    'OwnerAction.nonce': b64(ownerAction.nonce),
    'drop-request.nonce': b64(base64url(16)),
    'ProofPack.disclosure.contentKey': b64(proofPackDisclosureSchema.shape.contentKey),
    'tool.envelopeId': b64(base64url(BYTE_LENGTHS.id)),

    // Prefixed string: `apr_` + base64url of 16 bytes; decodes to those 16 bytes
    approvalId: { schema: approvalIdSchema, toBytes: approvalIdToBytes },
  } satisfies Record<string, Decoder>),
);

/** A schema path of the 04 §2.4.1 table. */
export type EncodingPath = keyof typeof DECODERS;

/** Every schema path that has a canonical binary encoding (04 §2.4.1). */
export const ENCODING_PATHS: readonly EncodingPath[] = Object.freeze(
  Object.keys(DECODERS) as EncodingPath[],
);

/** True when `path` is a schema path of the 04 §2.4.1 table. */
export const isEncodingPath = (path: unknown): path is EncodingPath =>
  typeof path === 'string' && Object.hasOwn(DECODERS, path);

/**
 * The bytes of `value` at schema path `path` (04 §2.4.1), or null when the value is not in that
 * path's one canonical form (or the path is not in the table). A `uint256` decodes to 32 big-endian
 * bytes and an `approvalId` to its 16 random bytes. Never throws; each call returns new bytes.
 */
export function decodeAtPath(path: EncodingPath, value: unknown): Uint8Array | null {
  if (!isEncodingPath(path) || typeof value !== 'string') return null;
  const decoder: Decoder = DECODERS[path];
  try {
    return decoder.schema.safeParse(value).success ? decoder.toBytes(value) : null;
  } catch {
    return null;
  }
}

/** One encoded value and the schema path it was read from. */
export interface EncodedAt {
  readonly path: EncodingPath;
  readonly value: unknown;
}

/**
 * Byte equality of two encoded values, each decoded by its own path (04 §2.4.1 "Compare bytes,
 * never strings"): for example OwnerAction `owner` against the card's `ownerNostr`. Null when either
 * value fails its own strict parse; callers treat that as a rejection, never as "not equal". Not
 * constant-time (public data).
 */
export function equalAtPaths(a: EncodedAt, b: EncodedAt): boolean | null {
  const left = decodeAtPath(a.path, a.value);
  const right = decodeAtPath(b.path, b.value);
  if (left === null || right === null) return null;
  return bytesEqual(left, right);
}
