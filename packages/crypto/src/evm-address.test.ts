// M1-1b (for M1-1e): the EVM address of a secp256k1 public key, 04 §2.9 (`agentId`) and §2.4.1
// (`0x` + 40 lowercase hex; EIP-55 for display only). Public and non-secret. The agent ID and the
// hkdf-derive `key`/`agentId` vectors go through the same function.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { describe, expect, it } from 'vitest';
import {
  CryptoInputError,
  KEY_LABELS,
  decodeHex,
  encodeHex,
  evmAddressChecksummed,
  evmAddressFromPublicKey,
  type CryptoInputErrorCode,
} from './index.js';
import { deriveAgentId, deriveSecretKey } from './keystore.js';

// The generator G (secret key 1); its address is the well-known 0x7E5F…5Bdf.
const G_COMPRESSED = decodeHex(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
);
const G_UNCOMPRESSED = decodeHex(
  '0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' +
    '483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8',
);
const G_ADDRESS = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf';
const SEED_A = decodeHex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
const P_HEX = 'fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f';

function refusedWith(run: () => unknown): CryptoInputError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CryptoInputError);
  return caught as CryptoInputError;
}

const withByte = (bytes: Uint8Array, index: number, value: number): Uint8Array => {
  const copy = Uint8Array.from(bytes);
  copy[index] = value;
  return copy;
};

describe('evmAddressFromPublicKey', () => {
  it('derives the address of G from its compressed and uncompressed forms', () => {
    expect(evmAddressFromPublicKey(G_UNCOMPRESSED)).toBe(G_ADDRESS);
    expect(evmAddressFromPublicKey(G_COMPRESSED)).toBe(G_ADDRESS);
    expect(evmAddressChecksummed(G_ADDRESS)).toBe('0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
  });

  it('gives the agent ID for the agent EVM key (the same path as deriveAgentId)', () => {
    const secretKey = deriveSecretKey(SEED_A, KEY_LABELS.evm, 0);
    const agentId = deriveAgentId(SEED_A);
    expect(agentId).toBe('0xe8118b7407afbd4a12c0df832c67ce0e2eb20cd6');
    expect(evmAddressFromPublicKey(secp256k1.getPublicKey(secretKey, false))).toBe(agentId);
    expect(evmAddressFromPublicKey(secp256k1.getPublicKey(secretKey, true))).toBe(agentId);
  });

  it('returns 0x + 40 lowercase hex and leaves the input untouched', () => {
    const input = Uint8Array.from(G_UNCOMPRESSED);
    expect(evmAddressFromPublicKey(input)).toMatch(/^0x[0-9a-f]{40}$/);
    expect(encodeHex(input)).toBe(encodeHex(G_UNCOMPRESSED));
  });

  it('refuses a value that is not bytes: invalid_argument', () => {
    for (const value of ['02' + 'ab'.repeat(32), null, undefined, [2, 3], G_COMPRESSED.buffer]) {
      expect(refusedWith(() => evmAddressFromPublicKey(value as unknown as Uint8Array)).code).toBe(
        'invalid_argument',
      );
    }
  });

  it('refuses any length other than 33 or 65 bytes: invalid_length', () => {
    for (const length of [0, 1, 20, 32, 34, 64, 66]) {
      const error = refusedWith(() => evmAddressFromPublicKey(new Uint8Array(length).fill(2)));
      expect(error.code).toBe('invalid_length');
    }
  });

  it('refuses encodings that are not a valid point: invalid_public_key', () => {
    const xAboveP = Uint8Array.from([0x02, ...decodeHex(P_HEX)]);
    const xNotOnCurve = Uint8Array.from([
      0x02,
      ...decodeHex('eefdea4cdb677750a420fee807eacf21eb9898ae79b9768766e4faa04a2d4a34'),
    ]);
    const cases: Record<string, Uint8Array> = {
      'uncompressed, y changed (off the curve)': withByte(G_UNCOMPRESSED, 64, 0xb9),
      'uncompressed, x changed (off the curve)': withByte(G_UNCOMPRESSED, 1, 0x7a),
      'compressed, x with no point': xNotOnCurve,
      'compressed, x = p': xAboveP,
      'compressed, prefix 0x04': withByte(G_COMPRESSED, 0, 0x04),
      'compressed, prefix 0x00': withByte(G_COMPRESSED, 0, 0x00),
      'compressed, prefix 0x05': withByte(G_COMPRESSED, 0, 0x05),
      'uncompressed, prefix 0x02': withByte(G_UNCOMPRESSED, 0, 0x02),
      'uncompressed, hybrid prefix 0x06': withByte(G_UNCOMPRESSED, 0, 0x06),
      'uncompressed, hybrid prefix 0x07': withByte(G_UNCOMPRESSED, 0, 0x07),
      'all zero, 33 bytes (no point at infinity)': new Uint8Array(33),
      'all zero, 65 bytes (no point at infinity)': new Uint8Array(65),
    };
    for (const [name, publicKey] of Object.entries(cases)) {
      const error = refusedWith(() => evmAddressFromPublicKey(publicKey));
      expect(error.code, name).toBe('invalid_public_key' satisfies CryptoInputErrorCode);
      expect(error.message, name).toBe('evmAddressFromPublicKey: not a point on secp256k1');
      expect(error.cause, name).toBeUndefined();
    }
  });
});

describe('evmAddressChecksummed error codes (stable, for M1-1e)', () => {
  it('uses invalid_hex for a non-canonical spelling and invalid_length for a wrong size', () => {
    expect(refusedWith(() => evmAddressChecksummed('0x' + 'AB'.repeat(20))).code).toBe(
      'invalid_hex',
    );
    expect(refusedWith(() => evmAddressChecksummed('ab'.repeat(20))).code).toBe('invalid_hex');
    expect(refusedWith(() => evmAddressChecksummed('0x' + 'ab'.repeat(19))).code).toBe(
      'invalid_length',
    );
    expect(refusedWith(() => evmAddressChecksummed(42 as unknown as string)).code).toBe(
      'invalid_argument',
    );
  });
});
