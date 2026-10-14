// Payload (04 §3.4): the plaintext inside `aead.ct`, with a strict body per type (04 §3.4, §3.4.1,
// §3.6) and file entries (04 §3.4, §4).
//
// Everything here except the owner-signed objects is untrusted content from another party (I-5):
// these schemas bound and shape it; they never make it safe to execute or to show unwrapped.
import { z } from 'zod';
import {
  APPROVAL_SUMMARY_MAX_CHARS,
  APPROVAL_TOOL_NAMES,
  BYTE_LENGTHS,
  FILE_PAYLOAD_TYPES,
  MAX_ENVELOPE_BYTES,
  MAX_FILE_NAME_CODE_POINTS,
  MAX_FILES_PER_PAYLOAD,
  MAX_INLINE_CIPHERTEXT_BYTES,
  MAX_INLINE_FILE_BYTES,
  MAX_MIME_LENGTH,
  MAX_TERMS_NOTE_CODE_POINTS,
  MAX_URL_LENGTH,
  type PayloadType,
} from './constants.js';
import { agentCardSchema, cardSigSchema, displayNameSchema, relayListSchema } from './card.js';
import {
  approvalIdSchema,
  base64url,
  base64urlBounded,
  evmAddress,
  ijsonString,
  isWellFormedString,
  jsonByteLength,
  jsonObjectSchema,
  sha256Hex,
  uint53,
} from './encoding.js';
import {
  signedAgentRevokeSchema,
  signedApprovalDecideSchema,
  signedPolicySetSchema,
} from './owner-action.js';

const envelopeId = base64url(BYTE_LENGTHS.id);

// --- file entries (04 §3.4, §4) ------------------------------------------------------------------

// type "/" subtype, RFC 6838 restricted names; no parameters, no whitespace.
const MIME = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;

/**
 * A download URL (presigned GET, drop or share link). It is a secret (I-7) and comes from another
 * party, so it is bounded and must be https with a host and no user info; the SSRF rules (04 §4) are
 * still applied when it is fetched.
 */
const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:[/?#][\x21-\x7e]*)?$/;
export const downloadUrlSchema = z.string().max(MAX_URL_LENGTH).regex(HTTPS_URL, {
  message: 'must be an https URL without user info, whitespace or control characters',
});

export const fileEntrySchema = z
  .strictObject({
    name: ijsonString({ min: 1, max: MAX_FILE_NAME_CODE_POINTS }),
    size: uint53,
    mime: z.string().max(MAX_MIME_LENGTH).regex(MIME, 'must be a MIME type without parameters'),
    plaintextSha256: sha256Hex,
    ciphertextSha256: sha256Hex,
    // The ALF1 ciphertext of a file up to 12 KB (see MAX_INLINE_CIPHERTEXT_BYTES).
    inline: base64urlBounded(0, MAX_INLINE_CIPHERTEXT_BYTES).nullable(),
    url: downloadUrlSchema.nullable(),
    fileKey: base64url(BYTE_LENGTHS.key),
    expiresAt: uint53,
  })
  .superRefine((f, ctx) => {
    if ((f.inline === null) === (f.url === null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'exactly one of inline and url must be set',
        path: ['inline'],
      });
    }
    if (f.inline !== null && f.size > MAX_INLINE_FILE_BYTES) {
      ctx.addIssue({
        code: 'custom',
        message: `inline files are at most ${MAX_INLINE_FILE_BYTES} bytes`,
        path: ['size'],
      });
    }
  });

// --- bodies --------------------------------------------------------------------------------------

/** Free text or a JSON object (02 F-22: "optional JSON body"). Bounded by the payload size. */
const messageText = z
  .string()
  .max(MAX_ENVELOPE_BYTES)
  .refine(isWellFormedString, 'string contains a lone surrogate (not I-JSON)');
export const messageBodySchema = z.union([messageText, jsonObjectSchema]);

/**
 * `request` with `kind: "refresh-link"` (04 §4, 07 §5.2): ask the sender for a fresh download URL.
 * PROPOSED shape (the spec names the kind only): the envelope that carried the file and the file's
 * `ciphertextSha256`, which identifies one entry without revealing anything new.
 */
export const refreshLinkRequestBodySchema = z.strictObject({
  kind: z.literal('refresh-link'),
  envelopeId,
  ciphertextSha256: sha256Hex,
});

const isRefreshLinkKind = (v: unknown) =>
  typeof v === 'object' && v !== null && (v as { kind?: unknown }).kind === 'refresh-link';

/** A `request` body: free form, except that anything claiming `kind: "refresh-link"` must be strict. */
export const requestBodySchema = z.union([
  messageText,
  refreshLinkRequestBodySchema,
  jsonObjectSchema.refine((o) => !isRefreshLinkKind(o), 'malformed refresh-link request'),
]);

/**
 * offer / accept / reject (04 §3.4). `terms` is a bounded JSON object until M1-21 lands its strict
 * schema and canonical-form rules; `termsHash` binds it (checked by the core, not here).
 */
const termsBody = <N extends z.ZodType>(note: N) =>
  z.strictObject({
    terms: jsonObjectSchema,
    termsHash: sha256Hex,
    note,
  });
const termsNote = ijsonString({ max: MAX_TERMS_NOTE_CODE_POINTS }).nullable();
export const offerBodySchema = termsBody(termsNote);
/** An accept never carries a note (04 §3.4, §3.4.2, D-55). */
export const acceptBodySchema = termsBody(z.null());
export const rejectBodySchema = termsBody(termsNote);

/** `handshake` (04 §3.6). `proof` = HMAC-SHA256 over the invite secret. */
export const handshakeBodySchema = z.strictObject({
  inviteId: base64url(BYTE_LENGTHS.inviteId),
  card: agentCardSchema,
  cardSig: cardSigSchema,
  name: displayNameSchema,
  relays: relayListSchema,
  proof: base64url(BYTE_LENGTHS.hmac),
});

/** `handshake-ack` (04 §3.4.1). `handshakeId` is B's handshake envelope `id`. */
export const handshakeAckBodySchema = z.strictObject({
  inviteId: base64url(BYTE_LENGTHS.inviteId),
  handshakeId: envelopeId,
});

/**
 * `proof` (04 §3.4). `recordId` and `salt` are bytes32; with no other encoding noted they follow the
 * 04 §3.1 default (base64url without padding).
 */
export const proofBodySchema = z.strictObject({
  envelopeId,
  chainId: uint53.refine((n) => n > 0, 'chainId must be positive'),
  recordId: base64url(32),
  salt: base64url(32),
});

/** `card-update` (04 §3.4.1): the handshake shapes. */
export const cardUpdateBodySchema = z.strictObject({
  card: agentCardSchema,
  cardSig: cardSigSchema,
  name: displayNameSchema,
  relays: relayListSchema,
});

export const approvalBodySchema = z.strictObject({ signed: signedApprovalDecideSchema });
export const policyBodySchema = z.strictObject({ signed: signedPolicySetSchema });
export const revokeBodySchema = z.strictObject({ signed: signedAgentRevokeSchema });

// `summary` is core-generated template text: no control or format characters (newlines, bidi,
// zero-width), so it can never fake structure in the console (I-5).
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const approvalSummary = ijsonString({ min: 1, max: APPROVAL_SUMMARY_MAX_CHARS }).refine(
  (s) => !CONTROL_OR_FORMAT.test(s),
  'summary must not contain control or format characters',
);

/**
 * `approval-request` (04 §3.4.1). `action.args` is the tool input and `action.context` the facts the
 * core bound; their per-tool schemas (and the commitment scope, 04 §3.4.2) plug in from M1-2b.
 */
export const approvalActionSchema = z.strictObject({
  tool: z.enum(APPROVAL_TOOL_NAMES),
  args: jsonObjectSchema,
  context: jsonObjectSchema,
});

export const approvalRequestBodySchema = z
  .strictObject({
    approvalId: approvalIdSchema,
    agent: evmAddress,
    action: approvalActionSchema,
    actionDigest: sha256Hex,
    summary: approvalSummary,
    requestedAt: uint53,
    expiresAt: uint53,
  })
  .refine((b) => b.expiresAt > b.requestedAt, {
    message: 'expiresAt must be after requestedAt',
    path: ['expiresAt'],
  });

// --- Payload -------------------------------------------------------------------------------------

const BODIES = {
  text: messageBodySchema,
  request: requestBodySchema,
  offer: offerBodySchema,
  accept: acceptBodySchema,
  reject: rejectBodySchema,
  delivery: messageBodySchema,
  note: messageBodySchema,
  file: messageBodySchema,
  ack: messageBodySchema,
  handshake: handshakeBodySchema,
  'handshake-ack': handshakeAckBodySchema,
  proof: proofBodySchema,
  approval: approvalBodySchema,
  'approval-request': approvalRequestBodySchema,
  policy: policyBodySchema,
  'card-update': cardUpdateBodySchema,
  revoke: revokeBodySchema,
} as const satisfies Record<PayloadType, z.ZodType>;

const filesAllowed = new Set<string>(FILE_PAYLOAD_TYPES);

const payloadOf = <T extends PayloadType>(type: T) =>
  z
    .strictObject({
      type: z.literal(type),
      body: BODIES[type],
      replyTo: envelopeId.nullable(),
      files: z.array(fileEntrySchema).max(MAX_FILES_PER_PAYLOAD),
    })
    .refine((p) => p.files.length === 0 || filesAllowed.has(p.type), {
      message: 'this payload type carries no files',
      path: ['files'],
    })
    .refine((p) => jsonByteLength(p) <= MAX_ENVELOPE_BYTES, {
      message: `payload exceeds ${MAX_ENVELOPE_BYTES} bytes`,
    });

export const payloadSchema = z.discriminatedUnion('type', [
  payloadOf('text'),
  payloadOf('request'),
  payloadOf('offer'),
  payloadOf('accept'),
  payloadOf('reject'),
  payloadOf('delivery'),
  payloadOf('note'),
  payloadOf('file'),
  payloadOf('ack'),
  payloadOf('handshake'),
  payloadOf('handshake-ack'),
  payloadOf('proof'),
  payloadOf('approval'),
  payloadOf('approval-request'),
  payloadOf('policy'),
  payloadOf('card-update'),
  payloadOf('revoke'),
]);

export type FileEntry = z.infer<typeof fileEntrySchema>;
export type MessageBody = z.infer<typeof messageBodySchema>;
export type RefreshLinkRequestBody = z.infer<typeof refreshLinkRequestBodySchema>;
export type RequestBody = z.infer<typeof requestBodySchema>;
export type OfferBody = z.infer<typeof offerBodySchema>;
export type AcceptBody = z.infer<typeof acceptBodySchema>;
export type RejectBody = z.infer<typeof rejectBodySchema>;
export type HandshakeBody = z.infer<typeof handshakeBodySchema>;
export type HandshakeAckBody = z.infer<typeof handshakeAckBodySchema>;
export type ProofBody = z.infer<typeof proofBodySchema>;
export type CardUpdateBody = z.infer<typeof cardUpdateBodySchema>;
export type ApprovalBody = z.infer<typeof approvalBodySchema>;
export type PolicyBody = z.infer<typeof policyBodySchema>;
export type RevokeBody = z.infer<typeof revokeBodySchema>;
export type ApprovalAction = z.infer<typeof approvalActionSchema>;
export type ApprovalRequestBody = z.infer<typeof approvalRequestBodySchema>;
export type Payload = z.infer<typeof payloadSchema>;
