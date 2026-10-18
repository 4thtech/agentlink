// M1-4a: record IDs, nonces and salts (05 §3.3 step 2; 04 §5; D-61).
//
// The vector values below are verbatim copies from test-vectors/eip712-proof/vectors.json (this
// package may not read files outside itself, deps-check; tools/vectors/chain-inline-copies.test.mjs
// checks the copies). The recordId of `receipt-delivered` is an input the vector generator computed
// for `record-message` with its own Python implementation of 05 §3.3 step 2; the generator marks it
// "not an expected value", and no contract run checked it. Matching it is an independent
// cross-check (with viem as a second oracle below), not contract parity.
import { encodeAbiParameters, keccak256 as viemKeccak256 } from 'viem';
import { describe, expect, it } from 'vitest';
import { computeRecordId, randomNonce, randomSalt } from './index.js';

// vector-copies:start (checked by tools/vectors/chain-inline-copies.test.mjs)
// record-message (domain and record) and receipt-delivered (recordId).
const VECTOR = {
  chainId: 84532,
  notary: '0x252d9a9c22652a8c08b12eda14d30906850542c9',
  signer: '0x52eaefebe4ec263f7ffd6ca678613e4d6195868a',
  nonce: 53413080818580974331135570314775698628850412394171742376625802275545193048131n,
  recordId: '0xe24e95611787c13ff990f930ae7f5e4fd5aabbbc6c493929691180d708efe1a6',
} as const;
// vector-copies:end

const MAX_UINT256 = (1n << 256n) - 1n;

describe('computeRecordId (05 §3.3: keccak256(abi.encode(chainid, notary, signer, nonce)))', () => {
  it('equals the recordId the shared vectors give for record-message', () => {
    expect(computeRecordId(VECTOR.chainId, VECTOR.notary, VECTOR.signer, VECTOR.nonce)).toBe(
      VECTOR.recordId,
    );
  });

  it('accepts the EIP-55 spelling of the same addresses and gives the same ID', () => {
    expect(
      computeRecordId(
        VECTOR.chainId,
        '0x252D9A9c22652a8C08B12eda14D30906850542C9',
        VECTOR.signer,
        VECTOR.nonce,
      ),
    ).toBe(VECTOR.recordId);
  });

  it('matches viem as an independent oracle for random inputs, and binds every input', () => {
    for (let i = 0; i < 16; i++) {
      const nonce = randomNonce();
      const signer = randomSalt().slice(0, 42) as `0x${string}`;
      const expected = viemKeccak256(
        encodeAbiParameters(
          [{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
          [84532n, VECTOR.notary, signer, nonce],
        ),
      );
      expect(computeRecordId(84532, VECTOR.notary, signer, nonce)).toBe(expected);
    }
    const base = computeRecordId(VECTOR.chainId, VECTOR.notary, VECTOR.signer, VECTOR.nonce);
    expect(computeRecordId(10200, VECTOR.notary, VECTOR.signer, VECTOR.nonce)).not.toBe(base);
    expect(computeRecordId(VECTOR.chainId, VECTOR.signer, VECTOR.signer, VECTOR.nonce)).not.toBe(
      base,
    );
    expect(computeRecordId(VECTOR.chainId, VECTOR.notary, VECTOR.notary, VECTOR.nonce)).not.toBe(
      base,
    );
    expect(
      computeRecordId(VECTOR.chainId, VECTOR.notary, VECTOR.signer, VECTOR.nonce + 1n),
    ).not.toBe(base);
  });

  it('refuses inputs the contract could not have used, without echoing them', () => {
    const bad: [number, string, string, bigint][] = [
      [0, VECTOR.notary, VECTOR.signer, 1n],
      [-1, VECTOR.notary, VECTOR.signer, 1n],
      [1.5, VECTOR.notary, VECTOR.signer, 1n],
      [84532, '0x252d', VECTOR.signer, 1n],
      [84532, VECTOR.notary, 'not-an-address', 1n],
      // a mixed-case spelling that is not the EIP-55 checksum
      [84532, '0x252D9A9C22652A8C08B12EDA14D30906850542c9', VECTOR.signer, 1n],
      [84532, VECTOR.notary, VECTOR.signer, -1n],
      [84532, VECTOR.notary, VECTOR.signer, MAX_UINT256 + 1n],
    ];
    for (const [chainId, notary, signer, nonce] of bad) {
      expect(() => computeRecordId(chainId, notary, signer, nonce)).toThrow();
      try {
        computeRecordId(chainId, notary, signer, nonce);
      } catch (error) {
        expect(String((error as Error).message)).not.toContain('not-an-address');
      }
    }
    expect(computeRecordId(84532, VECTOR.notary, VECTOR.signer, MAX_UINT256)).toMatch(
      /^0x[0-9a-f]{64}$/,
    );
  });
});

describe('randomNonce and randomSalt (04 §5, D-61: CSPRNG, never derived)', () => {
  it('a nonce is a 256-bit integer and two draws differ', () => {
    const seen = new Set<bigint>();
    for (let i = 0; i < 64; i++) {
      const n = randomNonce();
      expect(typeof n).toBe('bigint');
      expect(n >= 0n && n <= MAX_UINT256).toBe(true);
      seen.add(n);
    }
    expect(seen.size).toBe(64);
  });

  it('a salt is 0x + 64 lowercase hex and two draws differ', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64; i++) {
      const s = randomSalt();
      expect(s).toMatch(/^0x[0-9a-f]{64}$/);
      seen.add(s);
    }
    expect(seen.size).toBe(64);
  });

  it('draws from globalThis.crypto.getRandomValues and fails closed without it', () => {
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      expect(() => randomNonce()).toThrow();
      expect(() => randomSalt()).toThrow();
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
    }
  });
});
