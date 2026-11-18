// SEC-CARD-FULLTEXT: the approval card's content helpers (08 §1; 11 §5, §6.2.1; 04 §2.5.3; I-5).
import { describe, expect, it } from 'vitest';
import {
  CHECK_CODE_ALPHABET,
  CHECK_CODE_BITS,
  CHECK_CODE_PATTERN,
  PRESENCE_DETAIL_MAX,
  checkCode,
  inertText,
  isInertText,
  presencePromptDetail,
  textLength,
} from './ui-contract/approval-content.js';

const H1 = 'a3'.repeat(32);
const H2 = `0x${'a3'.repeat(9)}a4${'a3'.repeat(22)}`;

describe('check codes (SEC-CARD-FULLTEXT)', () => {
  it('carry at least 80 bits: 16 base32 characters in four groups', () => {
    expect(CHECK_CODE_BITS).toBeGreaterThanOrEqual(80);
    expect(CHECK_CODE_ALPHABET).toHaveLength(32);
    const code = checkCode(H1);
    expect(code).toMatch(CHECK_CODE_PATTERN);
    expect(code.replace(/ /g, '')).toHaveLength(16);
  });

  it('are stable: the same hash gives the same code, with or without 0x, any case', () => {
    expect(checkCode(H1)).toBe(checkCode(`0x${H1.toUpperCase()}`));
    // A fixed vector, so both sides of an exchange compute the same code across releases.
    expect(checkCode('00'.repeat(32))).toBe('0000 0000 0000 0000');
    expect(checkCode(`${'ff'.repeat(10)}${'00'.repeat(22)}`)).toBe('ZZZZ ZZZZ ZZZZ ZZZZ');
    expect(checkCode(`0123456789abcdef0123${'00'.repeat(22)}`)).toBe('04HM ASW9 NF6Y Y093');
  });

  it('differ when any of the first 80 bits differ', () => {
    expect(checkCode(H1)).not.toBe(checkCode(H2));
  });

  it('refuse anything that is not a 32-byte hex hash', () => {
    for (const bad of ['', 'zz'.repeat(32), 'a3'.repeat(31), `${'a3'.repeat(32)}00`]) {
      expect(() => checkCode(bad)).toThrow(TypeError);
    }
  });
});

describe('inert full text (SEC-CARD-FULLTEXT, I-5)', () => {
  it('keeps every character, line breaks and tabs; never cuts', () => {
    const long = `${'word '.repeat(2_000)}end`;
    expect(inertText(long)).toBe(long);
    expect(inertText('one\r\ntwo\rthree\n\tfour')).toBe('one\ntwo\nthree\n\tfour');
    expect(textLength('héllo 👋')).toBe(7);
  });

  it('shows bidi, zero-width and control characters as visible markers', () => {
    const hostile = 'pay \u202Eevil\u202C to\u200B Bob\u0007\u2028end';
    const shown = inertText(hostile);
    expect(shown).toBe('pay [U+202E]evil[U+202C] to[U+200B] Bob[U+0007][U+2028]end');
    expect(isInertText(shown)).toBe(true);
    expect(isInertText(hostile)).toBe(false);
    for (const cp of [0x202e, 0x2066, 0x200b, 0x0007, 0x2028]) {
      expect(shown).not.toContain(String.fromCodePoint(cp));
    }
  });
});

describe('the presence prompt detail (SEC-CARD-FULLTEXT, 04 §2.5.3)', () => {
  it('names who and the cost', () => {
    expect(presencePromptDetail('Ana', '$0.10')).toBe('for Ana, $0.10');
    expect(presencePromptDetail('Ana', 'Free')).toBe('for Ana, free');
  });

  it('is one line, without control or bidi characters, and capped', () => {
    const detail = presencePromptDetail(`An\u202Ea\n${'x'.repeat(200)}`, '$12.50');
    // eslint-disable-next-line no-control-regex -- the test looks for control characters
    expect(detail).not.toMatch(/[\u0000-\u001f\u202A-\u202E\u2066-\u2069]/u);
    expect(Array.from(detail).length).toBeLessThanOrEqual(PRESENCE_DETAIL_MAX);
    expect(detail).toContain('$12.50');
    expect(detail.startsWith('for Ana x')).toBe(true);
  });

  it('drops $ and , from the name, so it cannot read as another amount or party', () => {
    expect(presencePromptDetail('Ana, $0.01', '$9.00')).toBe('for Ana 0.01, $9.00');
  });

  it('leaves out a cost that is not an exact amount (never AI text)', () => {
    expect(presencePromptDetail('Ana', 'about 3 dollars, approve now')).toBe('for Ana');
  });
});
