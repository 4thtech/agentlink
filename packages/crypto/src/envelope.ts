// M1-1c RED stub: the envelope API, not implemented yet. The next commit implements it.
export const ENVELOPE_VERSION = 1;
export const ENVELOPE_ID_LENGTH = 16;
export const THREAD_ID_LENGTH = 16;
export const KID_LENGTH = 16;
export const HPKE_ENC_LENGTH = 32;
export const WRAPPED_CEK_LENGTH = 48;
export const CEK_LENGTH = 32;
export const AEAD_ALG = 'A256GCM';
export const AEAD_IV_LENGTH = 12;
export const AEAD_TAG_LENGTH = 16;

export interface EnvelopeRecipient {
  readonly kid: string;
  readonly enc: string;
  readonly wk: string;
}
export interface EnvelopeAead {
  readonly alg: typeof AEAD_ALG;
  readonly iv: string;
  readonly ct: string;
}
export interface EnvelopeHeader {
  readonly v: typeof ENVELOPE_VERSION;
  readonly id: string;
  readonly thread: string;
  readonly from: string;
  readonly createdAt: number;
  readonly recipients: readonly EnvelopeRecipient[];
}
export interface UnsignedEnvelope extends EnvelopeHeader {
  readonly aead: EnvelopeAead;
}
export interface Envelope extends UnsignedEnvelope {
  readonly sig: string;
}

const todo = (): never => {
  throw new Error('M1-1c: not implemented');
};

export function parseEnvelopeHeader(_value: unknown): EnvelopeHeader {
  return todo();
}
export function parseUnsignedEnvelope(_value: unknown): UnsignedEnvelope {
  return todo();
}
export function parseEnvelope(_value: unknown): Envelope {
  return todo();
}
export function envelopeHash(_envelope: UnsignedEnvelope | Envelope): Uint8Array {
  return todo();
}
export function envelopeAad(
  _headerOrEnvelope: EnvelopeHeader | UnsignedEnvelope | Envelope,
): Uint8Array {
  return todo();
}
export function envelopeSignatureInput(_envelopeHash: Uint8Array): Uint8Array {
  return todo();
}
export function verifyEnvelope(_envelope: Envelope): boolean {
  return todo();
}
export function signEnvelopeHash(
  _secretKey: Uint8Array,
  _envelopeHash: Uint8Array,
  _auxRand?: Uint8Array,
): Uint8Array {
  return todo();
}
