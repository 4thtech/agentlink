// Envelope v1 (04 §3.1). Binary values are base64url without padding, except `from` and `sig`, which
// are lowercase hex. Byte lengths follow the HPKE suite of 04 §3.3: DHKEM(X25519) `enc` is 32 bytes,
// and the wrapped CEK is the 32-byte key plus a 16-byte AES-GCM tag.
//
// `envelopeHash = sha256(JCS(envelope without sig))` and the AEAD data are computed in
// @4thtech-io/crypto; `unsignedEnvelopeSchema` is the shape they hash.
import { z } from 'zod';
import {
  BYTE_LENGTHS,
  MAX_ENVELOPE_BYTES,
  MAX_RECIPIENTS,
  MIN_RECIPIENTS,
  PROTOCOL_VERSION,
} from './constants.js';
import {
  base64url,
  base64urlBounded,
  bip340SigHex,
  jsonByteLength,
  nostrPubkeyHex,
  uint53,
} from './encoding.js';

export const recipientSchema = z.strictObject({
  kid: base64url(BYTE_LENGTHS.kid),
  enc: base64url(BYTE_LENGTHS.hpkeEnc),
  wk: base64url(BYTE_LENGTHS.wrappedCek),
});

// 04 §3.1 (G-46, D-66): exactly {alg, iv, kc, ct}; alg A256GCM-KC and a 32-byte key commitment, so
// the earlier form (alg A256GCM, no kc) is refused.
export const aeadSchema = z.strictObject({
  alg: z.literal('A256GCM-KC'),
  iv: base64url(BYTE_LENGTHS.iv),
  kc: base64url(BYTE_LENGTHS.keyCommitment),
  // ciphertext ‖ 16-byte tag; the envelope size cap bounds the rest.
  ct: base64urlBounded(BYTE_LENGTHS.tag, MAX_ENVELOPE_BYTES),
});

const recipients = z
  .array(recipientSchema)
  .min(MIN_RECIPIENTS)
  .max(MAX_RECIPIENTS)
  .refine(
    (list) => new Set(list.map((r) => r.kid)).size === list.length,
    'recipient kids must be unique (the wrap is picked by kid)',
  );

const unsignedShape = {
  v: z.literal(PROTOCOL_VERSION),
  id: base64url(BYTE_LENGTHS.id),
  thread: base64url(BYTE_LENGTHS.thread),
  from: nostrPubkeyHex,
  createdAt: uint53,
  recipients,
  aead: aeadSchema,
};

const withinSize = {
  message: `serialized envelope exceeds ${MAX_ENVELOPE_BYTES} bytes (04 §3.5)`,
};

/** The envelope without `sig`: the input of `envelopeHash` (04 §3.1). */
export const unsignedEnvelopeSchema = z
  .strictObject(unsignedShape)
  .refine((e) => jsonByteLength(e) <= MAX_ENVELOPE_BYTES, withinSize);

/**
 * The signed envelope. The size cap applies to the compact JSON form; every field is ASCII after
 * validation, so that form and the JCS form have the same length.
 */
export const envelopeSchema = z
  .strictObject({ ...unsignedShape, sig: bip340SigHex })
  .refine((e) => jsonByteLength(e) <= MAX_ENVELOPE_BYTES, withinSize);

export type Recipient = z.infer<typeof recipientSchema>;
export type Aead = z.infer<typeof aeadSchema>;
export type UnsignedEnvelope = z.infer<typeof unsignedEnvelopeSchema>;
export type Envelope = z.infer<typeof envelopeSchema>;
