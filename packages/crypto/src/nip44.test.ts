// NIP-44 v2 (M1-1g). The official vectors run in test-vectors/ (suite `nip44`, five runtimes);
// these tests cover the refusals and the strictness that the vectors do not pin down.
import { chacha20 } from '@noble/ciphers/chacha.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import { bip340PublicKey } from './bip340.js';
import { concatBytes } from './bytes.js';
import { encodeUtf8 } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { KEY_LABELS, deriveSecretKey } from './keys.js';
import {
  NIP44_MAX_PLAINTEXT_BYTES,
  NIP44_MIN_PLAINTEXT_BYTES,
  nip44ConversationKey,
  nip44DecryptWithKey,
  nip44EncryptWithKey,
  nip44MessageKeys,
  nip44PaddedLength,
} from './nip44.js';

const KEY = new Uint8Array(32).fill(7);
const NONCE = new Uint8Array(32).fill(9);

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof CryptoInputError) return error.code;
    throw error;
  }
  return 'accepted';
}

// Test-local padded base64 (RFC 4648 §4), independent of the module under test.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = ((chunk[0] ?? 0) << 16) | ((chunk[1] ?? 0) << 8) | (chunk[2] ?? 0);
    const chars = [n >> 18, (n >> 12) & 63, (n >> 6) & 63, n & 63].map((x) => B64[x] as string);
    const kept = chunk.filter((x) => x !== undefined).length + 1;
    out += chars.slice(0, kept).join('') + '='.repeat(4 - kept);
  }
  return out;
}

function fromBase64(text: string): Uint8Array {
  const body = text.replace(/=+$/, '');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of body) {
    buffer = ((buffer << 6) | B64.indexOf(char)) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/**
 * A payload with a valid MAC over an arbitrary padded buffer, built here from the primitives so a
 * test can send exactly the malformed plaintext framing it wants (the sender holds the key).
 */
function forge(conversationKey: Uint8Array, padded: Uint8Array): string {
  const { chachaKey, chachaNonce, hmacKey } = nip44MessageKeys(conversationKey, NONCE);
  const ciphertext = chacha20(chachaKey, chachaNonce, padded);
  const mac = hmac(nobleSha256, hmacKey, concatBytes(NONCE, ciphertext));
  return toBase64(concatBytes(Uint8Array.of(2), NONCE, ciphertext, mac));
}

function framed(length: number, body: Uint8Array, total: number): Uint8Array {
  const out = new Uint8Array(total);
  out[0] = length >> 8;
  out[1] = length & 0xff;
  out.set(body, 2);
  return out;
}

describe('nip44PaddedLength', () => {
  it('follows the NIP-44 table at the chunk boundaries', () => {
    expect(nip44PaddedLength(1)).toBe(32);
    expect(nip44PaddedLength(32)).toBe(32);
    expect(nip44PaddedLength(33)).toBe(64);
    expect(nip44PaddedLength(256)).toBe(256);
    expect(nip44PaddedLength(257)).toBe(320);
    expect(nip44PaddedLength(65535)).toBe(65536);
  });

  it('refuses a length that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity, '32' as unknown as number]) {
      expect(codeOf(() => nip44PaddedLength(bad))).toBe('invalid_argument');
    }
  });

  it('exports the plaintext bounds of NIP-44 v2', () => {
    expect(NIP44_MIN_PLAINTEXT_BYTES).toBe(1);
    expect(NIP44_MAX_PLAINTEXT_BYTES).toBe(65535);
  });
});

describe('nip44ConversationKey', () => {
  const seedA = new Uint8Array(32).fill(1);
  const seedB = new Uint8Array(32).fill(2);
  const skA = deriveSecretKey(seedA, KEY_LABELS.nostr, 0);
  const skB = deriveSecretKey(seedB, KEY_LABELS.nostr, 0);

  it('is symmetric', () => {
    expect(nip44ConversationKey(skA, bip340PublicKey(skB))).toEqual(
      nip44ConversationKey(skB, bip340PublicKey(skA)),
    );
  });

  it('refuses a key of the wrong type or length, with stable codes', () => {
    expect(codeOf(() => nip44ConversationKey('ab' as unknown as Uint8Array, KEY))).toBe(
      'invalid_argument',
    );
    expect(codeOf(() => nip44ConversationKey(skA.subarray(1), bip340PublicKey(skB)))).toBe(
      'invalid_length',
    );
    expect(codeOf(() => nip44ConversationKey(skA, new Uint8Array(33)))).toBe('invalid_length');
  });

  it('refuses a public key that is not on the curve', () => {
    expect(codeOf(() => nip44ConversationKey(skA, new Uint8Array(32)))).toBe('invalid_public_key');
  });

  it('leaves its inputs unchanged', () => {
    const sk = skA.slice();
    const pub = bip340PublicKey(skB);
    const pubCopy = pub.slice();
    nip44ConversationKey(sk, pub);
    expect(sk).toEqual(skA);
    expect(pub).toEqual(pubCopy);
  });
});

describe('nip44MessageKeys', () => {
  it('refuses a conversation key or nonce that is not 32 bytes', () => {
    expect(codeOf(() => nip44MessageKeys(new Uint8Array(31), NONCE))).toBe('invalid_length');
    expect(codeOf(() => nip44MessageKeys(KEY, new Uint8Array(33)))).toBe('invalid_length');
  });
});

describe('nip44EncryptWithKey / nip44DecryptWithKey', () => {
  it('round-trips at both plaintext bounds, multi-byte text included', () => {
    for (const text of ['a', 'x'.repeat(65535), '🦄 ünïcödé', 'é'.repeat(32767)]) {
      expect(nip44DecryptWithKey(KEY, nip44EncryptWithKey(KEY, text))).toBe(text);
    }
  });

  it('uses a fresh random nonce when none is given', () => {
    expect(nip44EncryptWithKey(KEY, 'hello')).not.toBe(nip44EncryptWithKey(KEY, 'hello'));
  });

  it('refuses an empty or oversized plaintext and a lone surrogate', () => {
    expect(codeOf(() => nip44EncryptWithKey(KEY, ''))).toBe('invalid_length');
    expect(codeOf(() => nip44EncryptWithKey(KEY, 'x'.repeat(65536)))).toBe('invalid_length');
    // 21846 * 3 = 65538 UTF-8 bytes from 21846 UTF-16 code units.
    expect(codeOf(() => nip44EncryptWithKey(KEY, '€'.repeat(21846)))).toBe('invalid_length');
    expect(codeOf(() => nip44EncryptWithKey(KEY, 'a\ud800'))).toBe('invalid_utf8');
  });

  it('refuses a nonce that is not 32 bytes', () => {
    expect(codeOf(() => nip44EncryptWithKey(KEY, 'hi', new Uint8Array(12)))).toBe('invalid_length');
  });

  it('refuses a payload decrypted under another key (MAC)', () => {
    const payload = nip44EncryptWithKey(KEY, 'secret', NONCE);
    expect(codeOf(() => nip44DecryptWithKey(new Uint8Array(32).fill(8), payload))).toBe(
      'decrypt_failed',
    );
  });

  it('refuses any single flipped bit in the nonce, ciphertext or MAC', () => {
    const data = fromBase64(nip44EncryptWithKey(KEY, 'secret', NONCE));
    for (const index of [1, 32, 33, 40, data.length - 33, data.length - 32, data.length - 1]) {
      const tampered = data.slice();
      tampered[index] = (tampered[index] as number) ^ 0x01;
      expect(
        codeOf(() => nip44DecryptWithKey(KEY, toBase64(tampered))),
        String(index),
      ).toBe('decrypt_failed');
    }
  });

  it('refuses an unknown version byte and the reserved "#" prefix', () => {
    const data = fromBase64(nip44EncryptWithKey(KEY, 'secret', NONCE));
    for (const version of [0, 1, 3, 255]) {
      const other = data.slice();
      other[0] = version;
      expect(codeOf(() => nip44DecryptWithKey(KEY, toBase64(other)))).toBe('invalid_payload');
    }
    expect(codeOf(() => nip44DecryptWithKey(KEY, '#' + 'A'.repeat(131)))).toBe('invalid_payload');
  });

  it('refuses payloads outside the NIP-44 size bounds', () => {
    expect(codeOf(() => nip44DecryptWithKey(KEY, ''))).toBe('invalid_payload');
    expect(codeOf(() => nip44DecryptWithKey(KEY, 'A'.repeat(131)))).toBe('invalid_payload');
    expect(codeOf(() => nip44DecryptWithKey(KEY, 'A'.repeat(87473)))).toBe('invalid_payload');
  });

  it('refuses non-canonical or invalid base64 (strict decoding)', () => {
    const payload = nip44EncryptWithKey(KEY, 'secret', NONCE);
    const cases = [
      payload.replace(/=+$/, ''), // padding removed
      payload.slice(0, -4) + ' ' + payload.slice(-3), // whitespace
      payload.replace(/[+/]/, '-'), // base64url alphabet
      payload + '====',
    ];
    for (const bad of cases) {
      if (bad === payload) continue;
      expect(codeOf(() => nip44DecryptWithKey(KEY, bad))).toBe('invalid_payload');
    }
    // Non-zero trailing bits before the padding: the same bytes, a second spelling.
    const lastData = payload.replace(/=+$/, '');
    const pad = payload.slice(lastData.length);
    if (pad.length > 0) {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      const last = alphabet.indexOf(lastData.at(-1) as string);
      const twin = lastData.slice(0, -1) + (alphabet[last ^ 1] as string) + pad;
      expect(codeOf(() => nip44DecryptWithKey(KEY, twin))).toBe('invalid_payload');
    }
  });

  it('refuses a payload that is not a string', () => {
    expect(codeOf(() => nip44DecryptWithKey(KEY, 42 as unknown as string))).toBe(
      'invalid_argument',
    );
  });

  describe('padding (MAC valid, framing wrong)', () => {
    it('accepts the correct framing built by hand (control)', () => {
      const body = encodeUtf8('hello');
      expect(nip44DecryptWithKey(KEY, forge(KEY, framed(5, body, 34)))).toBe('hello');
    });

    it('refuses a declared length of 0', () => {
      expect(
        codeOf(() => nip44DecryptWithKey(KEY, forge(KEY, framed(0, new Uint8Array(0), 34)))),
      ).toBe('decrypt_failed');
    });

    it('refuses a declared length longer than the buffer', () => {
      const body = encodeUtf8('hello');
      expect(codeOf(() => nip44DecryptWithKey(KEY, forge(KEY, framed(40, body, 34))))).toBe(
        'decrypt_failed',
      );
    });

    it('refuses a padded size that does not match the declared length', () => {
      const body = encodeUtf8('hello');
      // 5 bytes pad to 32, so the buffer must be 34 bytes; 66 is the size for 33..64.
      expect(codeOf(() => nip44DecryptWithKey(KEY, forge(KEY, framed(5, body, 66))))).toBe(
        'decrypt_failed',
      );
    });

    it('refuses non-zero padding bytes', () => {
      const padded = framed(5, encodeUtf8('hello'), 34);
      padded[33] = 1;
      expect(codeOf(() => nip44DecryptWithKey(KEY, forge(KEY, padded)))).toBe('decrypt_failed');
    });

    it('refuses a plaintext that is not valid UTF-8', () => {
      const padded = framed(2, Uint8Array.of(0xc3, 0x28), 34);
      expect(codeOf(() => nip44DecryptWithKey(KEY, forge(KEY, padded)))).toBe('decrypt_failed');
    });
  });

  it('never echoes the plaintext, key or payload in an error message (I-7)', () => {
    const payload = nip44EncryptWithKey(KEY, 'canary-plaintext', NONCE);
    const tampered = fromBase64(payload);
    tampered[50] = (tampered[50] as number) ^ 1;
    const errors: unknown[] = [];
    for (const fn of [
      () => nip44DecryptWithKey(KEY, toBase64(tampered)),
      () => nip44EncryptWithKey(KEY, 'canary-plaintext'.repeat(5000)),
      () => nip44DecryptWithKey(KEY, 'canary-payload'),
    ]) {
      try {
        fn();
      } catch (error) {
        errors.push(error);
      }
    }
    expect(errors).toHaveLength(3);
    for (const error of errors) {
      const message = (error as Error).message;
      expect(message).not.toMatch(/canary/);
      expect(message).not.toContain(payload.slice(0, 16));
    }
  });
});
