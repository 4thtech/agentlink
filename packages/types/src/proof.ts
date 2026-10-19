// Proofs: the Record and Receipt JSON forms (05 §3.1), ProofPack v1 (07 §8) and ProofStatus
// (06 §2.4).
//
// Encodings follow 04 §2.4.1 and a verifier rejects a pack in any other form (07 §8). Objects a pack
// embeds (agent card, envelope, SignedOwnerAction, approval action) keep their own strict schemas
// and bytes. Cross-field checks compare strings that have already passed their strict, single-
// spelling parse, so string equality is byte equality here. Signatures, record IDs, hashes and the
// chain itself are checked by the verifier (crypto, chain), not by these shapes.
import { z } from 'zod';
import { commitmentApprovalActionSchema } from './approval.js';
import { agentCardSchema, cardAgentSigSchema, cardSigSchema } from './card.js';
import { BYTE_LENGTHS, MAX_URL_LENGTH, RECEIPT_TYPES, RECORD_KINDS } from './constants.js';
import {
  base64url,
  bip340SigHex,
  bytes32Hex,
  evmAddress,
  isUtcTimestamp,
  sha256Hex,
  uint256Decimal,
  uint53,
} from './encoding.js';
import { envelopeSchema } from './envelope.js';
import { signedApprovalDecideSchema } from './owner-action.js';
import { chainKeySchema } from './policy.js';
import { isUsdAmount, parseUsd, usdAmountSchema } from './usd.js';

const freeze = <T>(value: T): Readonly<T> => Object.freeze(value);

/** PROPOSED form of the pack's and ProofStatus' `at` and `exportedAt` (the spec writes "…"). */
export const utcTimestampSchema = z
  .string()
  .refine(isUtcTimestamp, 'must be an RFC 3339 UTC timestamp: YYYY-MM-DDTHH:MM:SSZ');

// --- URLs ----------------------------------------------------------------------------------------

/** An https link we generate (block explorer, verify page): no user info, no whitespace. */
export const httpsUrlSchema = z
  .string()
  .max(MAX_URL_LENGTH)
  .regex(/^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?(?:[/?#][\x21-\x7e]*)?$/, {
    message: 'must be an https URL with a lowercase host, no user info and no whitespace',
  });

// --- Record and Receipt (05 §3.1) ----------------------------------------------------------------

const recordKinds = Object.values(RECORD_KINDS) as [number, ...number[]];
const receiptTypeCodes = Object.values(RECEIPT_TYPES) as [number, ...number[]];

/** Receipt type names, in the order of their on-chain codes (05 §3.1). */
export const RECEIPT_TYPE_NAMES = freeze(['DELIVERED', 'OPENED', 'ACCEPTED', 'REJECTED'] as const);
export type ReceiptTypeName = (typeof RECEIPT_TYPE_NAMES)[number];

/** The Record struct in its JSON form (05 §3.1, 04 §2.4.1). */
export const recordSchema = z.strictObject({
  signer: evmAddress,
  envelopeHash: bytes32Hex,
  recipientCommitment: bytes32Hex,
  parentRecordId: bytes32Hex,
  appId: bytes32Hex,
  kind: z.literal(recordKinds),
  feeToken: evmAddress,
  maxFee: uint256Decimal,
  nonce: uint256Decimal,
  deadline: uint53,
});

/** The Receipt struct in its JSON form (05 §3.1, 04 §2.4.1). */
export const receiptStructSchema = z.strictObject({
  signer: evmAddress,
  recordId: bytes32Hex,
  receiptType: z.literal(receiptTypeCodes),
  salt: bytes32Hex,
  deadline: uint53,
});

/** Upper bound on an ERC-1271 signature (a bound on untrusted input; the spec sets none). */
export const MAX_ERC1271_SIGNATURE_BYTES = 4096;

/**
 * A Record, Receipt or proof-pack signature in its JSON form (04 §2.4.1): `0x` + a non-empty, even
 * number of lowercase hex digits, at most MAX_ERC1271_SIGNATURE_BYTES. The form is not judged here,
 * as the Notary's SignatureChecker does not judge it: the canonical ECDSA rule (low s, v 27 or 28)
 * applies where the signature is checked by ECDSA recovery (an EOA signer), and an ERC-1271 account
 * may accept any bytes, 65 included (a Safe's v of 0, 1 or above 30). The verifier applies both.
 */
export function isRecordSignature(sig: unknown): sig is string {
  if (typeof sig !== 'string') return false;
  if (sig.length < 4 || sig.length > 2 + 2 * MAX_ERC1271_SIGNATURE_BYTES) return false;
  return /^0x(?:[0-9a-f]{2})+$/.test(sig);
}

export const recordSignatureSchema = z
  .string()
  .refine(
    isRecordSignature,
    'must be 0x + an even number of lowercase hex digits (ECDSA or ERC-1271)',
  );

// --- receipts lists ------------------------------------------------------------------------------

/** Each receipt type at most once, and ACCEPTED and REJECTED never both (05 §3.3, 06 §2.4). */
function receiptTypesValid(receipts: readonly unknown[]): boolean {
  const types = receipts.map((r) =>
    r !== null && typeof r === 'object' ? (r as { type?: unknown }).type : undefined,
  );
  return (
    new Set(types).size === types.length &&
    !(types.includes('ACCEPTED') && types.includes('REJECTED'))
  );
}
const RECEIPTS_MESSAGE = 'each receipt type at most once; ACCEPTED and REJECTED are exclusive';

// --- ProofPack v1 (07 §8) ------------------------------------------------------------------------

export const proofPackReceiptSchema = z.strictObject({
  type: z.enum(RECEIPT_TYPE_NAMES),
  signer: evmAddress,
  txHash: bytes32Hex,
  at: utcTimestampSchema,
});

/**
 * `signer`: the record signer and, optionally, its agent card with the owner's `cardSig` (07 §8):
 * `cardSig` is present exactly when `agentCard` is, since a card without its signature cannot be
 * checked (the pack schema holds that rule). The card's proof of possession (04 §2.9, 07 §8; D-102,
 * M1-4d-d): `cardAgentSig` (the agent EVM key's EIP-712 signature over the card, canonical ECDSA)
 * and `cardPop` (BIP-340 by the card's `agentNostr`, bare 128 hex) are present together or not at
 * all, and only with `agentCard`. Whether they verify is the verifier's check.
 */
export const proofPackSignerSchema = z
  .strictObject({
    evm: evmAddress,
    agentCard: agentCardSchema.exactOptional(),
    cardSig: cardSigSchema.exactOptional(),
    cardAgentSig: cardAgentSigSchema.exactOptional(),
    cardPop: bip340SigHex.exactOptional(),
  })
  .superRefine((o, ctx) => {
    const hasAgentSig = o.cardAgentSig !== undefined;
    if (hasAgentSig !== (o.cardPop !== undefined)) {
      ctx.addIssue({ code: 'custom', message: 'cardAgentSig and cardPop come together', path: [] });
    }
    if (hasAgentSig && o.agentCard === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'cardAgentSig and cardPop come only with agentCard',
        path: ['agentCard'],
      });
    }
  });

/** Optional disclosure of the recipient and the salt that opens `recipientCommitment`. */
export const proofPackRecipientSchema = z.strictObject({
  evm: evmAddress,
  salt: bytes32Hex,
});

/** The envelope's 32-byte content key, only if the owner approved (`proofs.allowKeyDisclosure`). */
export const proofPackDisclosureSchema = z.strictObject({
  contentKey: base64url(BYTE_LENGTHS.key),
});

/**
 * The exporting side's owner approval of the commitment (04 §3.4): its signed `approval.decide`
 * (an approve, by the same agent the scope names) and the commitment action it signed.
 */
const signedCommitmentApprovalSchema = z
  .strictObject({
    signed: signedApprovalDecideSchema,
    action: commitmentApprovalActionSchema,
  })
  .superRefine((o, ctx) => {
    if (o.signed?.body?.params?.decision !== 'approve') {
      ctx.addIssue({
        code: 'custom',
        message: 'the owner approval must be an approve',
        path: ['signed', 'body', 'params', 'decision'],
      });
    }
    if (o.signed?.body?.agent !== o.action?.context?.scope?.agentId) {
      ctx.addIssue({
        code: 'custom',
        message: 'the approval must be signed for the agent the scope names',
        path: ['signed', 'body', 'agent'],
      });
    }
  });

/** A policy grant: "approved by the owner's standing rule", with the policy document's hash. */
const standingRuleApprovalSchema = z.strictObject({
  standingRule: z.literal(true),
  policyHash: sha256Hex,
});

export const proofPackOwnerApprovalSchema = z
  .union([signedCommitmentApprovalSchema, standingRuleApprovalSchema])
  .nullable();

export const proofPackSchema = z
  .strictObject({
    type: z.literal('agentlink.proof'),
    version: z.literal(1),
    chainId: uint53.refine((n) => n > 0, 'chainId must be positive'),
    notary: evmAddress,
    recordId: bytes32Hex,
    record: recordSchema,
    signature: recordSignatureSchema,
    signer: proofPackSignerSchema,
    envelopeHash: bytes32Hex,
    envelope: envelopeSchema.exactOptional(),
    recipient: proofPackRecipientSchema.exactOptional(),
    receipts: z
      .array(proofPackReceiptSchema)
      .max(RECEIPT_TYPE_NAMES.length)
      .refine(receiptTypesValid, RECEIPTS_MESSAGE),
    disclosure: proofPackDisclosureSchema.nullable(),
    ownerApproval: proofPackOwnerApprovalSchema,
    exportedAt: utcTimestampSchema,
  })
  .superRefine((p, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: 'custom', message, path });
    if (p.signer?.evm !== p.record?.signer) {
      issue('signer.evm must be the record signer', ['signer', 'evm']);
    }
    if (p.envelopeHash !== p.record?.envelopeHash) {
      issue('envelopeHash must be the record envelopeHash', ['envelopeHash']);
    }
    const card = p.signer?.agentCard;
    if ((card === undefined) !== (p.signer?.cardSig === undefined)) {
      issue('agentCard and cardSig come together', ['signer']);
    }
    if (card !== undefined && card?.agentEvm !== p.signer?.evm) {
      issue('agentCard must be the signer agent card', ['signer', 'agentCard', 'agentEvm']);
    }
    if (p.disclosure !== null && p.envelope === undefined) {
      issue('a content key is disclosed only with the envelope it opens', ['disclosure']);
    }
    if (p.recipient !== undefined && Array.isArray(p.receipts)) {
      p.receipts.forEach((r, i) => {
        if (r?.signer !== p.recipient?.evm) {
          issue('receipts are signed by the disclosed recipient', ['receipts', i, 'signer']);
        }
      });
    }
  });

// --- ProofStatus (06 §2.4) -----------------------------------------------------------------------

/** ProofStatus `status`: a subset of the tool statuses (06 §1 rule 3). */
export const PROOF_STATUSES = freeze([
  'ok',
  'pending_approval',
  'needs_credits',
  'submitted',
  'error',
] as const);

/**
 * `ProofStatus.fee` (06 §2.4, 04 §2.4.1 as merged in #30). `token` is the Record's `feeToken`
 * (`0x` address; the zero address only for a native USD stablecoin, xDAI on Gnosis, which the core
 * checks against its chain list). `amount` is base units, a uint256 decimal: the signed `maxFee`
 * until the record is confirmed, then the fee charged. `usd` is its USD amount. `protocolUsd` and
 * `integratorUsd` split the charged fee, so they come together, only once it is known (status
 * `ok`, see checkProofStatus), and then `usd` is exactly their sum (12 §4.3, §5).
 */
export const proofFeeSchema = z
  .strictObject({
    token: evmAddress,
    amount: uint256Decimal,
    usd: usdAmountSchema,
    protocolUsd: usdAmountSchema.exactOptional(),
    integratorUsd: usdAmountSchema.exactOptional(),
  })
  .superRefine((f, ctx) => {
    if ((f.protocolUsd === undefined) !== (f.integratorUsd === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'protocolUsd and integratorUsd come together',
        path: ['protocolUsd'],
      });
      return;
    }
    if (
      isUsdAmount(f.usd) &&
      isUsdAmount(f.protocolUsd) &&
      isUsdAmount(f.integratorUsd) &&
      parseUsd(f.usd) !== parseUsd(f.protocolUsd) + parseUsd(f.integratorUsd)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'usd must equal protocolUsd + integratorUsd',
        path: ['usd'],
      });
    }
  });

export const proofStatusReceiptSchema = z.strictObject({
  type: z.enum(RECEIPT_TYPE_NAMES),
  at: utcTimestampSchema,
});

/** The ProofStatus fields, for a tool result that is a ProofStatus (06 §2.4, `toolResult`). */
export const proofStatusShape = {
  status: z.enum(PROOF_STATUSES),
  chain: chainKeySchema,
  recordId: bytes32Hex.exactOptional(),
  txHash: bytes32Hex.exactOptional(),
  fee: proofFeeSchema.exactOptional(),
  receipts: z
    .array(proofStatusReceiptSchema)
    .max(RECEIPT_TYPE_NAMES.length)
    .refine(receiptTypesValid, RECEIPTS_MESSAGE),
  explorerUrl: httpsUrlSchema.exactOptional(),
  verifyUrl: httpsUrlSchema.exactOptional(),
};

/**
 * ProofStatus rules (no clock): a confirmed proof (`ok`) has its `recordId` and `txHash`; a
 * `submitted` one has its `txHash`; receipts exist only on a record.
 */
export function checkProofStatus(
  s: { status?: unknown; recordId?: unknown; txHash?: unknown; receipts?: unknown; fee?: unknown },
  ctx: z.core.$RefinementCtx,
): void {
  const issue = (message: string, path: string[]) =>
    ctx.addIssue({ code: 'custom', message, path });
  // The split belongs to the charged fee: present exactly on a confirmed (`ok`) record's fee.
  if (s.fee !== null && typeof s.fee === 'object') {
    const hasSplit = (s.fee as { protocolUsd?: unknown }).protocolUsd !== undefined;
    if (s.status === 'ok' && !hasSplit) {
      issue('a confirmed fee carries protocolUsd and integratorUsd', ['fee', 'protocolUsd']);
    }
    if (s.status !== 'ok' && hasSplit) {
      issue('before confirmation the fee is maxFee, with no split', ['fee', 'protocolUsd']);
    }
  }
  if (s.status === 'ok' && s.recordId === undefined) issue('ok needs recordId', ['recordId']);
  if ((s.status === 'ok' || s.status === 'submitted') && s.txHash === undefined) {
    issue(`${s.status} needs txHash`, ['txHash']);
  }
  if (Array.isArray(s.receipts) && s.receipts.length > 0 && s.recordId === undefined) {
    issue('receipts need a recordId', ['receipts']);
  }
}

export const proofStatusSchema = z.strictObject(proofStatusShape).superRefine(checkProofStatus);

export type UtcTimestamp = z.infer<typeof utcTimestampSchema>;
export type RecordJson = z.infer<typeof recordSchema>;
export type ReceiptStructJson = z.infer<typeof receiptStructSchema>;
export type ProofPackReceipt = z.infer<typeof proofPackReceiptSchema>;
export type ProofPack = z.infer<typeof proofPackSchema>;
export type ProofFee = z.infer<typeof proofFeeSchema>;
export type ProofStatus = z.infer<typeof proofStatusSchema>;
