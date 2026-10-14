// M1-1e: canonical secp256k1 ECDSA (04 §2.4.1). Signatures are r || s || v with r and s in
// [1, n - 1], s <= n/2 (EIP-2) and v in {27, 28}; every other form is refused. viem is the
// independent oracle for signing and recovery (a devDependency, never shipped).
import { privateKeyToAccount, privateKeyToAddress } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  CryptoInputError,
  ECDSA_SIGNATURE_BYTES,
  decodeEcdsaSignature,
  encodeEcdsaSignature,
  encodeHex,
  encodeHex0x,
  encodeUtf8,
  keccak256,
  recoverEvmAddress,
} from './index.js';
import { signDigestEcdsa } from './keystore.js';

/** secp256k1 group order n. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_N = N >> 1n;

/** Test keys are derived at run time, so no key material sits in the source. */
const testKey = (label: string): Uint8Array => keccak256(encodeUtf8(`m11e/test/${label}`));
const digestOf = (label: string): Uint8Array => keccak256(encodeUtf8(`m11e/digest/${label}`));

const toBig = (bytes: Uint8Array): bigint => BigInt('0x' + encodeHex(bytes));
const fromBig = (value: bigint): Uint8Array => {
  const out = new Uint8Array(32);
  let rest = value;
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
};
const sigOf = (r: bigint, s: bigint, v: number): Uint8Array => {
  const out = new Uint8Array(65);
  out.set(fromBig(r), 0);
  out.set(fromBig(s), 32);
  out[64] = v;
  return out;
};
const parts = (sig: Uint8Array): { r: bigint; s: bigint; v: number } => ({
  r: toBig(sig.subarray(0, 32)),
  s: toBig(sig.subarray(32, 64)),
  v: sig[64] as number,
});

const expectInputError = (run: () => unknown, code: string): CryptoInputError => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CryptoInputError);
    expect((error as CryptoInputError).code).toBe(code);
    return error as CryptoInputError;
  }
  throw new Error('expected a CryptoInputError');
};

describe('signDigestEcdsa', () => {
  it('produces r || s || v with low s and v in {27, 28}', () => {
    expect(ECDSA_SIGNATURE_BYTES).toBe(65);
    const vs = new Set<number>();
    for (let i = 0; i < 32; i += 1) {
      const sig = signDigestEcdsa(digestOf(`low-s-${i}`), testKey('signer'));
      expect(sig).toHaveLength(65);
      const { r, s, v } = parts(sig);
      expect(r > 0n && r < N).toBe(true);
      expect(s > 0n && s <= HALF_N).toBe(true);
      expect([27, 28]).toContain(v);
      vs.add(v);
    }
    expect(vs).toEqual(new Set([27, 28])); // both parities occur over 32 digests
  });

  it('is deterministic (RFC 6979) and equals viem byte for byte', async () => {
    const key = testKey('viem');
    const account = privateKeyToAccount(encodeHex0x(key) as `0x${string}`);
    for (let i = 0; i < 8; i += 1) {
      const digest = digestOf(`viem-${i}`);
      const ours = encodeHex0x(signDigestEcdsa(digest, key));
      expect(encodeHex0x(signDigestEcdsa(digest, key))).toBe(ours);
      expect(await account.sign({ hash: encodeHex0x(digest) as `0x${string}` })).toBe(ours);
    }
  });

  it('refuses a key outside [1, n - 1] or of the wrong length, without echoing it', () => {
    const digest = digestOf('bad-key');
    for (const key of [
      new Uint8Array(32),
      fromBig(N),
      fromBig(N + 1n),
      new Uint8Array(31).fill(7),
    ]) {
      // The same codes as bip340Sign (IR-M1-1e-1 L-2): length, then range.
      const code = key.length === 32 ? 'invalid_argument' : 'invalid_length';
      const error = expectInputError(() => signDigestEcdsa(digest, key), code);
      if (key.length === 32 && toBig(key) !== 0n) {
        expect(error.message).not.toContain(encodeHex(key));
      }
    }
    expectInputError(
      () => signDigestEcdsa(digest, [1, 2] as unknown as Uint8Array),
      'invalid_argument',
    );
  });

  it('refuses a digest that is not 32 bytes', () => {
    expectInputError(() => signDigestEcdsa(new Uint8Array(31), testKey('d')), 'invalid_argument');
    expectInputError(() => signDigestEcdsa(new Uint8Array(33), testKey('d')), 'invalid_argument');
    expectInputError(
      () => signDigestEcdsa('00' as unknown as Uint8Array, testKey('d')),
      'invalid_argument',
    );
  });

  it('does not modify its inputs', () => {
    const key = testKey('inputs');
    const digest = digestOf('inputs');
    const keyCopy = key.slice();
    const digestCopy = digest.slice();
    signDigestEcdsa(digest, key);
    expect(key).toEqual(keyCopy);
    expect(digest).toEqual(digestCopy);
  });
});

describe('recoverEvmAddress', () => {
  it('recovers the signer address that viem derives from the key', () => {
    for (const label of ['a', 'b', 'c']) {
      const key = testKey(label);
      const digest = digestOf(label);
      const address = recoverEvmAddress(digest, signDigestEcdsa(digest, key));
      expect(encodeHex0x(address)).toBe(
        privateKeyToAddress(encodeHex0x(key) as `0x${string}`).toLowerCase(),
      );
    }
  });

  it('refuses every non-canonical form, including the malleated twin of a valid signature', () => {
    const digest = digestOf('malleable');
    const sig = signDigestEcdsa(digest, testKey('malleable'));
    const { r, s, v } = parts(sig);
    const bad: Array<[string, Uint8Array]> = [
      ['high s (n - s, v flipped)', sigOf(r, N - s, v === 27 ? 28 : 27)],
      ['s = n/2 + 1', sigOf(r, HALF_N + 1n, v)],
      ['v = 0', sigOf(r, s, v - 27)],
      ['v = 1', sigOf(r, s, 1)],
      ['v = 29', sigOf(r, s, 29)],
      ['v = 26', sigOf(r, s, 26)],
      ['r = 0', sigOf(0n, s, v)],
      ['s = 0', sigOf(r, 0n, v)],
      ['r = n', sigOf(N, s, v)],
      ['s = n', sigOf(r, N, v)],
      ['r = 2^256 - 1', sigOf((1n << 256n) - 1n, s, v)],
      ['64 bytes', sig.subarray(0, 64)],
      ['66 bytes', Uint8Array.of(...sig, 0)],
    ];
    for (const [, candidate] of bad) {
      expectInputError(() => recoverEvmAddress(digest, candidate), 'invalid_signature');
    }
  });

  it('treats s = n/2 as canonical and s = n/2 + 1 as not (the EIP-2 bound is inclusive)', () => {
    const { r } = parts(signDigestEcdsa(digestOf('half'), testKey('half')));
    expect(decodeEcdsaSignature(encodeHex0x(sigOf(r, HALF_N, 27)))).toHaveLength(65);
    expectInputError(
      () => decodeEcdsaSignature(encodeHex0x(sigOf(r, HALF_N + 1n, 27))),
      'invalid_signature',
    );
  });

  it('refuses a digest that is not 32 bytes', () => {
    const sig = signDigestEcdsa(digestOf('x'), testKey('x'));
    expectInputError(() => recoverEvmAddress(new Uint8Array(31), sig), 'invalid_argument');
  });
});

describe('decodeEcdsaSignature and encodeEcdsaSignature', () => {
  const sig = signDigestEcdsa(digestOf('codec'), testKey('codec'));
  const text = encodeHex0x(sig);

  it('round-trips the canonical 0x + 130 lowercase hex form', () => {
    expect(encodeEcdsaSignature(sig)).toBe(text);
    expect(text).toMatch(/^0x[0-9a-f]{130}$/);
    expect(decodeEcdsaSignature(text)).toEqual(sig);
  });

  it.each([
    ['upper case', '0x' + text.slice(2).toUpperCase()],
    ['no prefix', text.slice(2)],
    ['0X prefix', '0X' + text.slice(2)],
    ['64 bytes', text.slice(0, 130)],
    ['66 bytes', text + '00'],
    ['odd length', text.slice(0, 131)],
    ['whitespace', text + ' '],
    ['v = 0x00', text.slice(0, 130) + '00'],
    ['v = 0x1d', text.slice(0, 130) + '1d'],
    ['empty', ''],
  ])('refuses %s', (_, candidate) => {
    const error = expectInputError(() => decodeEcdsaSignature(candidate), 'invalid_signature');
    expect(error.message).not.toContain(text.slice(2, 20));
  });

  it('refuses a non-string', () => {
    expectInputError(() => decodeEcdsaSignature(sig as unknown as string), 'invalid_argument');
  });

  it('encode refuses a non-canonical signature', () => {
    const { r, s, v } = parts(sig);
    expectInputError(() => encodeEcdsaSignature(sigOf(r, N - s, v)), 'invalid_signature');
    expectInputError(() => encodeEcdsaSignature(sig.subarray(0, 64)), 'invalid_signature');
  });
});
