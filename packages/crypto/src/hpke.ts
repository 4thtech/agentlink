// M1-1c RED stub: the CEK wrap API, not implemented yet. The next commit implements it.
export const CEK_INFO_LABEL = 'agentlink/v1/cek';

export interface WrappedCek {
  readonly enc: Uint8Array;
  readonly wk: Uint8Array;
}
export interface HpkeSealed {
  readonly enc: Uint8Array;
  readonly ciphertexts: readonly Uint8Array[];
}

const todo = (): never => {
  throw new Error('M1-1c: not implemented');
};

export function cekInfo(_envelopeId: Uint8Array): Uint8Array {
  return todo();
}
export function wrapCek(
  _recipientEncPublicKey: Uint8Array,
  _envelopeId: Uint8Array,
  _cek: Uint8Array,
): Promise<WrappedCek> {
  return Promise.resolve().then(todo);
}
export function unwrapCek(
  _recipientEncSecretKey: Uint8Array,
  _envelopeId: Uint8Array,
  _wrapped: WrappedCek,
): Promise<Uint8Array> {
  return Promise.resolve().then(todo);
}
export function wrapCekWithEphemeralKey(
  _recipientEncPublicKey: Uint8Array,
  _envelopeId: Uint8Array,
  _cek: Uint8Array,
  _ephemeralSecretKey: Uint8Array,
): Promise<WrappedCek> {
  return Promise.resolve().then(todo);
}
export function hpkeSealSequence(
  _recipientPublicKey: Uint8Array,
  _ephemeralSecretKey: Uint8Array,
  _info: Uint8Array,
  _messages: readonly { readonly aad: Uint8Array; readonly plaintext: Uint8Array }[],
): Promise<HpkeSealed> {
  return Promise.resolve().then(todo);
}
export function hpkeOpen(
  _recipientSecretKey: Uint8Array,
  _enc: Uint8Array,
  _info: Uint8Array,
  _aad: Uint8Array,
  _ciphertext: Uint8Array,
): Promise<Uint8Array> {
  return Promise.resolve().then(todo);
}
