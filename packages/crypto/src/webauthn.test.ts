// M1-PAY-CONFIRM-a (04 §2.5.3 rule 5): the WebAuthn assertion signature check.
import { ed25519 } from '@noble/curves/ed25519.js';
import { p256 } from '@noble/curves/nist.js';
import { describe, expect, it } from 'vitest';
import { concatBytes } from './bytes.js';
import { encodeUtf8 } from './encoding.js';
import { sha256 } from './hash.js';
import { randomBytes } from './random.js';
import {
  decodeWebauthnPublicKey,
  verifyWebauthnSignature,
  webauthnPublicKeyFromAuthenticatorData,
} from './webauthn.js';

const bstr = (b: Uint8Array) => concatBytes(new Uint8Array([0x58, b.length]), b);
/** COSE_Key for P-256: {1: 2, 3: -7, -1: 1, -2: x, -3: y}. */
function es256Key(publicKey: Uint8Array): Uint8Array {
  const x = publicKey.subarray(1, 33);
  const y = publicKey.subarray(33, 65);
  return concatBytes(
    new Uint8Array([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21]),
    bstr(x),
    new Uint8Array([0x22]),
    bstr(y),
  );
}
/** COSE_Key for Ed25519: {1: 1, 3: -8, -1: 6, -2: x}. */
function eddsaKey(publicKey: Uint8Array): Uint8Array {
  return concatBytes(
    new Uint8Array([0xa4, 0x01, 0x01, 0x03, 0x27, 0x20, 0x06, 0x21]),
    bstr(publicKey),
  );
}

const authData = (flags = 0x05) =>
  concatBytes(sha256(encodeUtf8('localhost')), new Uint8Array([flags, 0, 0, 0, 1]));
const clientData = encodeUtf8(JSON.stringify({ type: 'webauthn.get', challenge: 'abc' }));
const message = (a: Uint8Array, c: Uint8Array) => concatBytes(a, sha256(c));

describe('verifyWebauthnSignature (rule 5)', () => {
  it('accepts an ES256 signature over authenticatorData ‖ SHA-256(clientDataJSON) (DER, high S too)', () => {
    const { secretKey, publicKey } = p256.keygen();
    const key = es256Key(p256.getPublicKey(secretKey, false));
    const a = authData();
    const sig = p256.sign(message(a, clientData), secretKey, { format: 'der', lowS: false });
    expect(verifyWebauthnSignature(key, a, clientData, sig)).toBe(true);
    expect(publicKey.length).toBe(33);
  });

  it('accepts an EdDSA signature', () => {
    const { secretKey, publicKey } = ed25519.keygen();
    const a = authData();
    const sig = ed25519.sign(message(a, clientData), secretKey);
    expect(verifyWebauthnSignature(eddsaKey(publicKey), a, clientData, sig)).toBe(true);
  });

  it('refuses a forged, absent or moved signature, another key, and changed data', () => {
    const { secretKey } = p256.keygen();
    const key = es256Key(p256.getPublicKey(secretKey, false));
    const other = es256Key(p256.getPublicKey(p256.keygen().secretKey, false));
    const a = authData();
    const sig = p256.sign(message(a, clientData), secretKey, { format: 'der' });
    expect(verifyWebauthnSignature(key, a, clientData, new Uint8Array(0))).toBe(false);
    expect(verifyWebauthnSignature(key, a, clientData, randomBytes(70))).toBe(false);
    expect(verifyWebauthnSignature(other, a, clientData, sig)).toBe(false);
    expect(verifyWebauthnSignature(key, authData(0x01), clientData, sig)).toBe(false);
    expect(verifyWebauthnSignature(key, a, encodeUtf8('{}'), sig)).toBe(false);
    expect(verifyWebauthnSignature(new Uint8Array([0xa0]), a, clientData, sig)).toBe(false);
  });
});

describe('the credential public key (COSE_Key)', () => {
  it('is read from the attested credential data for this credential ID', () => {
    const { secretKey } = p256.keygen();
    const key = es256Key(p256.getPublicKey(secretKey, false));
    const credentialId = randomBytes(16);
    const auth = concatBytes(
      sha256(encodeUtf8('localhost')),
      new Uint8Array([0x45, 0, 0, 0, 0]),
      new Uint8Array(16),
      new Uint8Array([0, 16]),
      credentialId,
      key,
    );
    expect(webauthnPublicKeyFromAuthenticatorData(auth, credentialId)).toEqual(key);
    expect(() => webauthnPublicKeyFromAuthenticatorData(auth, randomBytes(16))).toThrow();
    expect(() => webauthnPublicKeyFromAuthenticatorData(authData(), credentialId)).toThrow();
  });

  it('refuses another algorithm, an extra key, trailing bytes and a point off the curve', () => {
    const { secretKey } = p256.keygen();
    const key = es256Key(p256.getPublicKey(secretKey, false));
    expect(decodeWebauthnPublicKey(key).alg).toBe(-7);
    expect(() => decodeWebauthnPublicKey(concatBytes(key, new Uint8Array([0])))).toThrow();
    const rs256 = Uint8Array.from(key);
    rs256[4] = 0x39; // alg: a two-byte negative integer head, not -7
    expect(() => decodeWebauthnPublicKey(rs256)).toThrow();
    const off = Uint8Array.from(key);
    off[off.length - 1] = (off[off.length - 1] as number) ^ 1;
    expect(() => decodeWebauthnPublicKey(off)).toThrow();
  });
});
