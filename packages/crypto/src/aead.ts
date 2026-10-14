// M1-1c RED stub: the payload AEAD API, not implemented yet. The next commit implements it.
import type { Envelope, EnvelopeAead, EnvelopeHeader, UnsignedEnvelope } from './envelope.js';

const todo = (): never => {
  throw new Error('M1-1c: not implemented');
};

export function generateCek(): Uint8Array {
  return todo();
}
export function encryptPayload(
  _header: EnvelopeHeader,
  _cek: Uint8Array,
  _plaintext: Uint8Array,
): Promise<EnvelopeAead> {
  return Promise.resolve().then(todo);
}
export function decryptPayload(
  _envelope: UnsignedEnvelope | Envelope,
  _cek: Uint8Array,
): Promise<Uint8Array> {
  return Promise.resolve().then(todo);
}
export function encryptPayloadWithIv(
  _header: EnvelopeHeader,
  _cek: Uint8Array,
  _iv: Uint8Array,
  _plaintext: Uint8Array,
): Promise<EnvelopeAead> {
  return Promise.resolve().then(todo);
}
