// M1-1b: BIP-340 Schnorr helpers for KeyStore implementations (04 §2.1, §3.1, §8.1). The full
// BIP-340 vector set runs cross-runtime in test-vectors/bip340; these tests pin the API rules:
// strict lengths, secret-key range, x-only keys that must lift onto the curve, signatures with
// r < p and s < n, and refusals that never echo a secret.
import { describe, expect, it } from 'vitest';
import {
  CryptoInputError,
  bip340Verify,
  decodeHex,
  encodeHex,
  isBip340PublicKey,
  sha256,
} from './index.js';
import { bip340PublicKey, bip340Sign } from './keystore.js';

const N_HEX = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141';
const P_HEX = 'fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f';

// BIP-340 test-vectors.csv, index 1.
const SK1 = decodeHex('b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef');
const PK1 = decodeHex('dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659');
const AUX1 = decodeHex('0000000000000000000000000000000000000000000000000000000000000001');
const MSG1 = decodeHex('243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89');
const SIG1 = decodeHex(
  '6896bd60eeae296db48a229ff71dfe071bde413e6d43f917dc8dcf8c78de3341' +
    '8906d11ac976abccb20b091292bff4ea897efcb639ea871cfa95f6de339e4b0a',
);
// Index 5: not on the curve. Index 14: x >= p.
const PK_OFF_CURVE = decodeHex('eefdea4cdb677750a420fee807eacf21eb9898ae79b9768766e4faa04a2d4a34');
const PK_ABOVE_P = decodeHex('fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc30');

const scalar = (value: bigint): Uint8Array => decodeHex(value.toString(16).padStart(64, '0'));
const N = BigInt('0x' + N_HEX);

function expectRefused(run: () => unknown): CryptoInputError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CryptoInputError);
  return caught as CryptoInputError;
}

describe('bip340Sign and bip340PublicKey', () => {
  it('reproduces BIP-340 vector 1', () => {
    expect(encodeHex(bip340PublicKey(SK1))).toBe(encodeHex(PK1));
    expect(encodeHex(bip340Sign(SK1, MSG1, AUX1))).toBe(encodeHex(SIG1));
  });

  it('draws fresh aux randomness by default, and the signature verifies', () => {
    const a = bip340Sign(SK1, MSG1);
    const b = bip340Sign(SK1, MSG1);
    expect(encodeHex(a)).not.toBe(encodeHex(b));
    expect(bip340Verify(PK1, MSG1, a)).toBe(true);
    expect(bip340Verify(PK1, MSG1, b)).toBe(true);
  });

  it('signs messages of any length (BIP-340 vectors 15-18), including the empty one', () => {
    for (const message of [
      new Uint8Array(0),
      Uint8Array.of(0x11),
      new Uint8Array(100).fill(0x99),
    ]) {
      expect(bip340Verify(PK1, message, bip340Sign(SK1, message, AUX1))).toBe(true);
    }
  });

  it('refuses a secret key of 0, n, above n, or the wrong length', () => {
    for (const secretKey of [
      new Uint8Array(32),
      scalar(N),
      scalar(N + 1n),
      new Uint8Array(32).fill(0xff),
      new Uint8Array(31).fill(1),
      new Uint8Array(33).fill(1),
    ]) {
      expectRefused(() => bip340PublicKey(secretKey));
      expectRefused(() => bip340Sign(secretKey, MSG1, AUX1));
    }
    expect(bip340PublicKey(scalar(N - 1n))).toHaveLength(32);
    expect(bip340PublicKey(scalar(1n))).toHaveLength(32);
  });

  it('refuses an out-of-range key with its own check, before the library sees it (IR-M1-1b-1 I-1)', () => {
    for (const secretKey of [new Uint8Array(32), scalar(N), scalar(N + 1n)]) {
      for (const error of [
        expectRefused(() => bip340PublicKey(secretKey)),
        expectRefused(() => bip340Sign(secretKey, MSG1, AUX1)),
      ]) {
        expect(error.code).toBe('invalid_argument');
        expect(error.message).toBe('bip340: the secret key is out of range');
      }
    }
  });

  it('refuses aux randomness that is not 32 bytes and a message that is not bytes', () => {
    expectRefused(() => bip340Sign(SK1, MSG1, new Uint8Array(31)));
    expectRefused(() => bip340Sign(SK1, MSG1, new Uint8Array(33)));
    expectRefused(() => bip340Sign(SK1, encodeHex(MSG1) as unknown as Uint8Array, AUX1));
  });

  it('does not modify the secret key, the message or the aux bytes', () => {
    const sk = Uint8Array.from(SK1);
    const msg = Uint8Array.from(MSG1);
    const aux = Uint8Array.from(AUX1);
    bip340Sign(sk, msg, aux);
    bip340PublicKey(sk);
    expect(encodeHex(sk)).toBe(encodeHex(SK1));
    expect(encodeHex(msg)).toBe(encodeHex(MSG1));
    expect(encodeHex(aux)).toBe(encodeHex(AUX1));
  });

  it('never echoes the secret key in an error (I-7)', () => {
    const bad = scalar(N + 0x1234n);
    for (const error of [
      expectRefused(() => bip340PublicKey(bad)),
      expectRefused(() => bip340Sign(bad, MSG1, AUX1)),
    ]) {
      const text = `${error.message} ${String(error)} ${JSON.stringify(error)}`;
      expect(text).not.toContain(encodeHex(bad).slice(0, 16));
      expect(text).not.toContain(encodeHex(bad).slice(-16));
    }
  });
});

describe('bip340Verify', () => {
  it('accepts BIP-340 vector 1', () => {
    expect(bip340Verify(PK1, MSG1, SIG1)).toBe(true);
  });

  it('rejects a changed message, key or signature byte', () => {
    const msg = Uint8Array.from(MSG1);
    msg[0] = (msg[0] as number) ^ 1;
    expect(bip340Verify(PK1, msg, SIG1)).toBe(false);
    for (const index of [0, 31, 32, 63]) {
      const sig = Uint8Array.from(SIG1);
      sig[index] = (sig[index] as number) ^ 1;
      expect(bip340Verify(PK1, MSG1, sig)).toBe(false);
    }
    expect(bip340Verify(bip340PublicKey(scalar(3n)), MSG1, SIG1)).toBe(false);
  });

  it('rejects x-only keys that are not on the curve or not below p', () => {
    expect(bip340Verify(PK_OFF_CURVE, MSG1, SIG1)).toBe(false);
    expect(bip340Verify(PK_ABOVE_P, MSG1, SIG1)).toBe(false);
    expect(bip340Verify(decodeHex(P_HEX), MSG1, SIG1)).toBe(false);
    expect(bip340Verify(new Uint8Array(32), MSG1, SIG1)).toBe(false);
  });

  it('rejects r >= p, s >= n and s = 0', () => {
    const r = SIG1.subarray(0, 32);
    const s = SIG1.subarray(32);
    const withR = (value: Uint8Array): Uint8Array => Uint8Array.from([...value, ...s]);
    const withS = (value: Uint8Array): Uint8Array => Uint8Array.from([...r, ...value]);
    expect(bip340Verify(PK1, MSG1, withR(decodeHex(P_HEX)))).toBe(false);
    expect(bip340Verify(PK1, MSG1, withS(scalar(N)))).toBe(false);
    expect(bip340Verify(PK1, MSG1, withS(new Uint8Array(32).fill(0xff)))).toBe(false);
    expect(bip340Verify(PK1, MSG1, withS(new Uint8Array(32)))).toBe(false);
  });

  it('has no s-malleability: the negated s (n - s) does not verify', () => {
    // BIP-340 fixes R to an even y, so there is no high-s/low-s pair as in ECDSA (04 §2.4.1 low-s
    // applies to ECDSA only). The only other s for the same r would be n - s; it must fail.
    const s = BigInt('0x' + encodeHex(SIG1.subarray(32)));
    const negated = Uint8Array.from([...SIG1.subarray(0, 32), ...scalar(N - s)]);
    expect(bip340Verify(PK1, MSG1, negated)).toBe(false);
  });

  it('refuses a key that is not 32 bytes and a signature that is not 64 bytes', () => {
    expectRefused(() => bip340Verify(new Uint8Array(33), MSG1, SIG1));
    expectRefused(() => bip340Verify(PK1, MSG1, SIG1.subarray(0, 63)));
    expectRefused(() => bip340Verify(PK1, MSG1, new Uint8Array(65)));
    expectRefused(() => bip340Verify(PK1, encodeHex(MSG1) as unknown as Uint8Array, SIG1));
  });

  it('verifies a protocol signature over a tagged digest', () => {
    const digest = sha256(Uint8Array.of(1, 2, 3));
    expect(bip340Verify(PK1, digest, bip340Sign(SK1, digest))).toBe(true);
  });
});

describe('isBip340PublicKey', () => {
  it('accepts a key that lifts onto the curve, and nothing else', () => {
    expect(isBip340PublicKey(PK1)).toBe(true);
    expect(isBip340PublicKey(PK_OFF_CURVE)).toBe(false);
    expect(isBip340PublicKey(PK_ABOVE_P)).toBe(false);
    expect(isBip340PublicKey(new Uint8Array(32))).toBe(false);
    expect(isBip340PublicKey(new Uint8Array(33))).toBe(false);
    expect(isBip340PublicKey(encodeHex(PK1) as unknown as Uint8Array)).toBe(false);
  });
});
