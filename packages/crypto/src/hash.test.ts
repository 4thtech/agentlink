// M1-1a: SHA-256, keccak-256 (via @noble/hashes), BIP-340 tagged hashes (04 §2.5.1, §3.1) and the
// constant-time byte comparison.
import { describe, expect, it } from 'vitest';
import {
  CryptoInputError,
  TAGS,
  concatBytes,
  decodeHex,
  encodeHex,
  encodeUtf8,
  equalBytes,
  keccak256,
  sha256,
  taggedHash,
} from './index.js';

const ascii = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0));

describe('sha256', () => {
  // FIPS 180-2 Appendix B and the empty message.
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
  ])('hashes %j', (message, digest) => {
    expect(encodeHex(sha256(ascii(message)))).toBe(digest);
  });

  it('refuses a non-bytes argument', () => {
    expect(() => sha256('abc' as unknown as Uint8Array)).toThrow(CryptoInputError);
  });
});

describe('keccak256 (Ethereum, not SHA3-256)', () => {
  it.each([
    ['', 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'],
    ['abc', '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45'],
  ])('hashes %j', (message, digest) => {
    expect(encodeHex(keccak256(ascii(message)))).toBe(digest);
  });

  it('refuses a non-bytes argument', () => {
    expect(() => keccak256([1, 2] as unknown as Uint8Array)).toThrow(CryptoInputError);
  });
});

describe('taggedHash (BIP-340)', () => {
  it('names the protocol tags of 04 §3.1 and §2.5.1', () => {
    expect(TAGS.envelope).toBe('agentlink/envelope/v1');
    expect(TAGS.ownerAction).toBe('agentlink/owner-action/v1');
  });

  it('is sha256(sha256(tag) || sha256(tag) || message)', () => {
    const message = decodeHex('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    // The committed tagged-hash vector `envelope-hash32` (tools/vectors/generate_tagged_hash.py).
    expect(encodeHex(taggedHash(TAGS.envelope, message))).toBe(
      'e81b98dd0ebe8945f7f5ecda128c830edd2b35fcd68dc7f28d58300ee2a88e65',
    );
    const tagHash = sha256(encodeUtf8(TAGS.ownerAction));
    expect(taggedHash(TAGS.ownerAction, message)).toEqual(
      sha256(concatBytes(tagHash, tagHash, message)),
    );
  });

  it('separates the envelope and owner-action domains', () => {
    const message = new Uint8Array(32);
    expect(
      equalBytes(taggedHash(TAGS.envelope, message), taggedHash(TAGS.ownerAction, message)),
    ).toBe(false);
  });

  it('refuses a tag that is not well-formed text and a non-bytes message', () => {
    expect(() => taggedHash('agentlink/\ud800', new Uint8Array(0))).toThrow(CryptoInputError);
    expect(() => taggedHash(TAGS.envelope, 'x' as unknown as Uint8Array)).toThrow(CryptoInputError);
    expect(() => taggedHash(1 as unknown as string, new Uint8Array(0))).toThrow(CryptoInputError);
  });
});

describe('equalBytes', () => {
  it('compares contents, not identity', () => {
    expect(equalBytes(new Uint8Array(0), new Uint8Array(0))).toBe(true);
    expect(equalBytes(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3))).toBe(true);
    expect(equalBytes(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 4))).toBe(false);
    expect(equalBytes(Uint8Array.of(9, 2, 3), Uint8Array.of(1, 2, 3))).toBe(false);
    expect(equalBytes(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2))).toBe(false);
    expect(equalBytes(Uint8Array.of(0), new Uint8Array(0))).toBe(false);
  });

  it('compares views by their visible bytes', () => {
    const backing = Uint8Array.of(7, 1, 2, 3, 7);
    expect(equalBytes(backing.subarray(1, 4), Uint8Array.of(1, 2, 3))).toBe(true);
  });

  it('refuses non-bytes arguments', () => {
    expect(() => equalBytes('ab' as unknown as Uint8Array, Uint8Array.of(1))).toThrow(
      CryptoInputError,
    );
  });
});

describe('concatBytes', () => {
  it('joins in order into a new array', () => {
    const a = Uint8Array.of(1, 2);
    const joined = concatBytes(a, new Uint8Array(0), Uint8Array.of(3));
    expect(joined).toEqual(Uint8Array.of(1, 2, 3));
    joined[0] = 9;
    expect(a[0]).toBe(1);
    expect(concatBytes()).toEqual(new Uint8Array(0));
  });
});
