// RED stub (M1-1e): canonical secp256k1 ECDSA for EIP-712 signatures. Implementation follows.
const todo = (): never => {
  throw new Error('M1-1e: not implemented');
};

/** Length of a canonical ECDSA signature r || s || v (04 §2.4.1). */
export const ECDSA_SIGNATURE_BYTES = 65;

export function signDigestEcdsa(digest: Uint8Array, secretKey: Uint8Array): Uint8Array {
  void digest;
  void secretKey;
  return todo();
}

export function decodeEcdsaSignature(text: string): Uint8Array {
  void text;
  return todo();
}

export function encodeEcdsaSignature(signature: Uint8Array): string {
  void signature;
  return todo();
}

export function recoverEvmAddress(digest: Uint8Array, signature: Uint8Array): Uint8Array {
  void digest;
  void signature;
  return todo();
}
