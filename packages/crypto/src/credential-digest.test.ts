// M1-9i-b2: credentialDigest (04 §2.5.1 `storage.set`) and the `s3:<id>` item (04 §2.2). The
// exact bytes are the `recovery-kit` vectors (independent Python generator, D-82); these tests check
// the API contract: the byte-level JCS writer agrees with jcs.ts for every ASCII code point and
// tricky Unicode, inputs are never changed or kept, results are copies, and errors carry no input.
import { describe, expect, it } from 'vitest';
import {
  STORAGE_CREDENTIAL_SALT_LENGTH,
  credentialDigest,
  credentialDigestOfItem,
  encodeStorageCredentialItem,
  parseStorageCredentialItem,
} from './credential-digest.js';
import { decodeUtf8, encodeBase64url, encodeHex, encodeUtf8 } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { canonicalizeToBytes } from './jcs.js';
import { hmacSha256 } from './pairing.js';

const salt = Uint8Array.from({ length: 16 }, (_, i) => i * 7 + 1);
const text = (s: string) => encodeUtf8(s);
const fields = (accessKeyId: string, secretAccessKey: string, s = salt) => ({
  salt: s,
  accessKeyId: text(accessKeyId),
  secretAccessKey: text(secretAccessKey),
});

/** Strings whose JCS form exercises every escape rule and UTF-8 length. */
const TRICKY = [
  ...Array.from({ length: 0x80 }, (_, c) => `a${String.fromCharCode(c)}b`),
  'é',
  'é',
  '鍵',
  '🔑',
  '  ',
  ' ÿĀ߿ࠀ￿',
  '\u{10000}\u{10ffff}',
  '"\\/\b\f\n\r\t',
];

describe('credentialDigest (04 §2.5.1)', () => {
  it('is HMAC-SHA256 under the salt over JCS({accessKeyId, secretAccessKey}), as 64 lowercase hex', () => {
    const digest = credentialDigest(fields('key-id', 'se"cret\n'));
    const message = canonicalizeToBytes({ accessKeyId: 'key-id', secretAccessKey: 'se"cret\n' });
    expect(digest).toBe(encodeHex(hmacSha256(salt, message)));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('agrees with the string JCS writer for every ASCII code point and tricky Unicode', () => {
    for (const value of TRICKY) {
      const expected = encodeHex(
        hmacSha256(salt, canonicalizeToBytes({ accessKeyId: value, secretAccessKey: value })),
      );
      expect(credentialDigest(fields(value, value)), JSON.stringify(value)).toBe(expected);
    }
  });

  it('depends on the salt and on which value is which', () => {
    const other = salt.map((b) => b ^ 0xff);
    expect(credentialDigest(fields('a', 'b'))).not.toBe(credentialDigest(fields('a', 'b', other)));
    expect(credentialDigest(fields('a', 'b'))).not.toBe(credentialDigest(fields('b', 'a')));
  });

  it('never normalises: NFC and NFD give different digests', () => {
    expect(credentialDigest(fields('k', 'café'))).not.toBe(credentialDigest(fields('k', 'café')));
  });

  it('leaves its inputs unchanged', () => {
    const f = fields('key-id', 'secret');
    const copies = [f.salt.slice(), f.accessKeyId.slice(), f.secretAccessKey.slice()];
    credentialDigest(f);
    encodeStorageCredentialItem(f);
    expect([f.salt, f.accessKeyId, f.secretAccessKey]).toEqual(copies);
  });

  it('refuses a salt of another length, an empty value and bytes that are not UTF-8', () => {
    expect(STORAGE_CREDENTIAL_SALT_LENGTH).toBe(16);
    const bad = [
      { ...fields('a', 'b'), salt: salt.subarray(0, 15) },
      { ...fields('a', 'b'), salt: new Uint8Array(17) },
      fields('', 'b'),
      fields('a', ''),
      { ...fields('a', 'b'), secretAccessKey: Uint8Array.of(0x61, 0xff) },
      { ...fields('a', 'b'), secretAccessKey: Uint8Array.of(0xc0, 0xaf) },
      { ...fields('a', 'b'), secretAccessKey: Uint8Array.of(0xed, 0xa0, 0x80) },
      { ...fields('a', 'b'), secretAccessKey: Uint8Array.of(0xf4, 0x90, 0x80, 0x80) },
      { ...fields('a', 'b'), accessKeyId: Uint8Array.of(0xe2, 0x82) },
    ];
    for (const f of bad) {
      expect(() => credentialDigest(f)).toThrow(CryptoInputError);
      expect(() => encodeStorageCredentialItem(f)).toThrow(CryptoInputError);
    }
  });

  it('refuses values that are not byte arrays (the secret never travels as a JS string)', () => {
    const asString = {
      salt,
      accessKeyId: text('a'),
      secretAccessKey: 'b',
    } as unknown as Parameters<typeof credentialDigest>[0];
    expect(() => credentialDigest(asString)).toThrow(CryptoInputError);
    expect(() => credentialDigest(null as never)).toThrow(CryptoInputError);
  });
});

describe('the s3:<id> item (04 §2.2)', () => {
  it('is the JCS JSON {"v":1,"salt","accessKeyId","secretAccessKey"} with salt as base64url', () => {
    for (const value of TRICKY) {
      const item = encodeStorageCredentialItem(fields(value, `${value}!`));
      const expected = canonicalizeToBytes({
        v: 1,
        salt: encodeBase64url(salt),
        accessKeyId: value,
        secretAccessKey: `${value}!`,
      });
      expect(item, JSON.stringify(value)).toEqual(expected);
    }
  });

  it('reads back to the same fields as fresh copies, and its digest is the fields digest', () => {
    for (const value of TRICKY) {
      const f = fields(`id-${value}`, `secret-${value}`);
      const item = encodeStorageCredentialItem(f);
      const parsed = parseStorageCredentialItem(item);
      expect(parsed).toEqual({
        salt,
        accessKeyId: f.accessKeyId,
        secretAccessKey: f.secretAccessKey,
      });
      expect(credentialDigestOfItem(item)).toBe(credentialDigest(f));
      item.fill(0);
      expect(parsed.secretAccessKey).toEqual(f.secretAccessKey);
    }
  });

  it('refuses every form but the canonical one', () => {
    const good = encodeStorageCredentialItem(fields('id', 'secret'));
    const goodText = decodeUtf8(good);
    const variants = [
      goodText.replace('"v":1', '"v": 1'),
      `${goodText}\n`,
      goodText.replace('"v":1', '"v":2'),
      goodText.replace('"v":1', '"v":1.0'),
      goodText.replace('"v":1', '"v":"1"'),
      goodText.replace('"secret"', '"\\u0073ecret"'),
      goodText.replace('"secret"', '"sec\\/ret"'),
      goodText.replace('"secret"', '"a\\u000Ab"'),
      goodText.replace('"secret"', '"a\\u000ab"'),
      goodText.replace('"secret"', '"a\\ud800b"'),
      goodText.replace('"secret"', '""'),
      goodText.replace('"secret"', '7'),
      goodText.replace('"secret"', '"a\nb"'),
      goodText.replace(',"v":1}', ',"sessionToken":"t","v":1}'),
      goodText.replace(',"v":1}', '}'),
      `{"v":1,${goodText.slice(1).replace(',"v":1}', '}')}`,
      goodText.replace(encodeBase64url(salt), `${encodeBase64url(salt)}==`),
      goodText.replace(encodeBase64url(salt), encodeBase64url(salt.subarray(0, 15))),
      '[]',
      '',
    ];
    for (const variant of variants) {
      expect(() => credentialDigestOfItem(text(variant)), variant).toThrow(CryptoInputError);
      expect(() => parseStorageCredentialItem(text(variant)), variant).toThrow(CryptoInputError);
    }
    const notUtf8 = good.slice();
    notUtf8[notUtf8.length - 10] = 0xff;
    expect(() => credentialDigestOfItem(notUtf8)).toThrow(CryptoInputError);
  });

  it('names no part of the input in an error (I-7)', () => {
    const secret = 'MY-SECRET-VALUE-42';
    const item = text(
      decodeUtf8(encodeStorageCredentialItem(fields('KEY-ID-XYZ', secret))).replace(
        '"v":1',
        '"v":3',
      ),
    );
    for (const run of [
      () => credentialDigestOfItem(item),
      () => credentialDigest({ ...fields('KEY-ID-XYZ', secret), salt: new Uint8Array(3) }),
      () => credentialDigest(fields('KEY-ID-XYZ', '')),
    ]) {
      try {
        run();
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(CryptoInputError);
        const message = (error as Error).message;
        expect(message).not.toContain(secret);
        expect(message).not.toContain('KEY-ID-XYZ');
      }
    }
  });
});
