// M1-1f: password(secret, secretKind) of 04 §2.8 (shared by ALKS, ALKO and the recovery code) and
// the generated 120-bit code. The byte-exact cases are the keystore-file vectors (`password`,
// `passwordBytes`); these tests pin the API and the I-7 rule that errors never carry the input.
import { describe, expect, it } from 'vitest';
import { CryptoInputError, SECRET_CODE_LENGTH, decodeUtf8, encodeUtf8 } from './index.js';
import { generateSecretCode, normalizeSecret } from './keystore.js';

const ascii = (text: string): Uint8Array => encodeUtf8(text);
const BASE32 = /^[A-Z2-7]{24}$/;

function refusedWith(run: () => unknown, code: string): CryptoInputError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CryptoInputError);
    expect((error as CryptoInputError).code).toBe(code);
    return error as CryptoInputError;
  }
  throw new Error('expected a refusal');
}

describe('generateSecretCode', () => {
  it('is 24 RFC 4648 base32 characters (15 CSPRNG bytes, exactly 120 bits)', () => {
    expect(SECRET_CODE_LENGTH).toBe(24);
    const code = generateSecretCode();
    expect(code).toBeInstanceOf(Uint8Array);
    expect(decodeUtf8(code)).toMatch(BASE32);
    expect(normalizeSecret(code, 1, 'prompt').length).toBe(15);
  });

  it('draws fresh randomness every time, with every alphabet character reachable', () => {
    const seen = new Set<string>();
    const codes = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const text = decodeUtf8(generateSecretCode());
      codes.add(text);
      for (const ch of text) seen.add(ch);
    }
    expect(codes.size).toBe(200);
    expect(seen.size).toBe(32);
  });

  it('round-trips: the decoded bytes re-encode to the same code', () => {
    const code = generateSecretCode();
    const spelled = decodeUtf8(code)
      .toLowerCase()
      .replace(/(.{4})(?!$)/g, '$1-');
    expect(normalizeSecret(ascii(spelled), 1, 'prompt')).toEqual(
      normalizeSecret(code, 1, 'prompt'),
    );
  });
});

describe('normalizeSecret, kind 1 (generated code)', () => {
  const canonical = 'OBIS7Q2MKXW4RT5ZLDNE3H6C';
  const expected = normalizeSecret(ascii(canonical), 1, 'prompt');

  it('accepts lower case, spaces, dashes and 0/1/8 for O/I/B', () => {
    for (const spelling of [
      'obis-7q2m-kxw4-rt5z-ldne-3h6c',
      'OBIS 7Q2M KXW4 RT5Z LDNE 3H6C',
      '0B1S 7Q2M KXW4 RT5Z LDNE 3H6C',
      'o8is7q2mkxw4rt5zldne3h6c',
    ]) {
      expect(normalizeSecret(ascii(spelling), 1, 'prompt'), spelling).toEqual(expected);
    }
  });

  it('removes exactly one trailing LF or CRLF from file input, nothing from prompt input', () => {
    expect(normalizeSecret(ascii(`${canonical}\n`), 1, 'file')).toEqual(expected);
    expect(normalizeSecret(ascii(`${canonical}\r\n`), 1, 'file')).toEqual(expected);
    refusedWith(() => normalizeSecret(ascii(`${canonical}\n`), 1, 'prompt'), 'invalid_secret');
    refusedWith(() => normalizeSecret(ascii(`${canonical}\n\n`), 1, 'file'), 'invalid_secret');
  });

  it('refuses a wrong length, another alphabet, padding, other separators and non-ASCII', () => {
    for (const bad of [
      canonical.slice(1),
      `${canonical}A`,
      `${canonical.slice(1)}9`,
      `${canonical.slice(1)}=`,
      'OBIS.7Q2M.KXW4.RT5Z.LDNE.3H6C',
      'OBIS\t7Q2M KXW4 RT5Z LDNE 3H6C',
      'OBIſ7Q2MKXW4RT5ZLDNE3H6C',
      'ＯBIS7Q2MKXW4RT5ZLDNE3H6C',
    ]) {
      refusedWith(() => normalizeSecret(ascii(bad), 1, 'prompt'), 'invalid_secret');
    }
  });

  it('never puts the input into the error (I-7)', () => {
    const error = refusedWith(
      () => normalizeSecret(ascii('ZZZZ-SECRETISH-CANARY'), 1, 'prompt'),
      'invalid_secret',
    );
    expect(error.message).not.toMatch(/ZZZZ|CANARY/i);
  });
});

describe('normalizeSecret, kind 2 (chosen passphrase)', () => {
  it('is the UTF-8 of NFKC, spaces kept', () => {
    expect(normalizeSecret(ascii('  two  spaces  '), 2, 'prompt')).toEqual(
      ascii('  two  spaces  '),
    );
    expect(normalizeSecret(ascii('Café ﬁle'), 2, 'prompt')).toEqual(ascii('Café file'));
    expect(normalizeSecret(ascii('Ｐａｓｓ'), 2, 'prompt')).toEqual(ascii('Pass'));
  });

  it('refuses C0 and C1 control characters, including a newline typed at a prompt', () => {
    for (const bad of ['a\nb', 'a\tb', 'a\u0000b', 'a\u001bb', 'a\u007fb', 'a\u0085b', 'a\u009f']) {
      refusedWith(() => normalizeSecret(ascii(bad), 2, 'prompt'), 'invalid_secret');
    }
    expect(normalizeSecret(ascii('long phrase\r\n'), 2, 'file')).toEqual(ascii('long phrase'));
    refusedWith(() => normalizeSecret(ascii('long phrase\r'), 2, 'file'), 'invalid_secret');
  });

  it('decodes UTF-8 fatally: invalid, overlong, surrogate and truncated input is refused', () => {
    for (const bad of [
      [0x61, 0xc3, 0x28],
      [0x61, 0x80],
      [0xc0, 0xaf],
      [0xc0, 0x80],
      [0xed, 0xa0, 0x80],
      [0xe2, 0x82],
      [0xff],
    ]) {
      refusedWith(() => normalizeSecret(Uint8Array.from(bad), 2, 'prompt'), 'invalid_secret');
    }
  });
});

describe('normalizeSecret arguments', () => {
  it('refuses an unknown kind or source and non-byte input', () => {
    refusedWith(() => normalizeSecret(ascii('long phrase'), 3 as 1, 'prompt'), 'invalid_argument');
    refusedWith(
      () => normalizeSecret(ascii('long phrase'), 2, 'env' as 'file'),
      'invalid_argument',
    );
    refusedWith(
      () => normalizeSecret('x' as unknown as Uint8Array, 2, 'prompt'),
      'invalid_argument',
    );
  });

  it('does not modify its input', () => {
    const input = ascii('obis-7q2m-kxw4-rt5z-ldne-3h6c\n');
    const copy = input.slice();
    normalizeSecret(input, 1, 'file');
    expect(input).toEqual(copy);
  });
});
