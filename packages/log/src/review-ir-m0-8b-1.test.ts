// Regression tests for the findings L1-L7 of independent review IR-M0-8b-1. Each test fails on
// the code that the review examined (00a2794) and pins the fix.

import { describe, expect, it } from 'vitest';
import {
  PAIR_FINDER_SOURCE,
  pairScanWork,
  redact,
  REDACTED,
  redactString,
  stripUrls,
} from './redact.js';

// Fake secrets are built at run time so the source holds no secret-shaped literal.
const SECRET = ['Zq9', 'vT4', 'kP7', 'wX2'].join('');
const BS = '\\';
const Q = '"';

/** One more level of JSON encoding: what JSON.stringify puts inside a string. */
const encode = (text: string): string => JSON.stringify(text).slice(1, -1);
const encodeTimes = (text: string, times: number): string =>
  times === 0 ? text : encodeTimes(encode(text), times - 1);

describe('L1 and L4: JSON strings nested up to four levels deep', () => {
  // Inner values with every character that could end a scan early, including a trailing backslash.
  const NASTY = `a}"]b${BS}`;
  const LEVELS = [0, 1, 2, 3, 4];

  it.each(LEVELS)('an object under a sensitive key, %d encodings deep', (times) => {
    const json = JSON.stringify({
      privateKey: { kty: NASTY, d: SECRET, e: `}]${NASTY}` },
      user: 'bob',
    });
    const out = redactString(encodeTimes(json, times));
    expect(out).not.toContain(SECRET);
    expect(out).toBe(encodeTimes(`{"privateKey":${REDACTED},"user":"bob"}`, times));
  });

  it.each(LEVELS)('an array under a sensitive key, %d encodings deep', (times) => {
    const json = JSON.stringify({ token: [NASTY, SECRET, [NASTY]], user: 'bob' });
    const out = redactString(encodeTimes(json, times));
    expect(out).not.toContain(SECRET);
    expect(out).toBe(encodeTimes(`{"token":${REDACTED},"user":"bob"}`, times));
  });

  it.each(LEVELS)('a string whose value ends in a backslash, %d encodings deep', (times) => {
    const json = JSON.stringify({ password: `${NASTY}${SECRET}${BS}`, user: 'bob' });
    const out = redactString(encodeTimes(json, times));
    expect(out).not.toContain(SECRET);
    expect(out).toContain('bob');
    expect(out).toBe(encodeTimes(`{"password":"${REDACTED}","user":"bob"}`, times));
  });

  it('a closing bracket inside an inner string of double-encoded JSON (the review probe)', () => {
    const q = BS + Q;
    const text = `{${q}privateKey${q}:{${q}kty${q}:${q}a}${q},${q}d${q}:${q}${SECRET}${q}}}`;
    expect(redactString(text)).toBe(`{${q}privateKey${q}:${REDACTED}}`);
    const array = `{${q}token${q}:[${q}a]${q},${q}${SECRET}${q}]}`;
    expect(redactString(array)).toBe(`{${q}token${q}:${REDACTED}}`);
  });
});

describe('L2: a value past the old 2048-character cap fails closed', () => {
  it('a long quoted value is redacted whole', () => {
    const out = redactString(`password="${'x'.repeat(2100)}${SECRET}",user=bob`);
    expect(out).toBe(`password="${REDACTED}",user=bob`);
  });

  it('the private part of a long key object is redacted', () => {
    const json = JSON.stringify({ privateKey: { n: 'a'.repeat(2100), d: SECRET }, user: 'bob' });
    expect(redactString(json)).toBe(`{"privateKey":${REDACTED},"user":"bob"}`);
  });

  it('a long bare value is redacted whole', () => {
    expect(redactString(`token=${'x'.repeat(600)}${SECRET} next`)).toBe(`token=${REDACTED} next`);
  });

  it('an unclosed object or array is redacted to the end of the string', () => {
    expect(redactString(`secret={${'x'.repeat(3000)}${SECRET}`)).toBe(`secret=${REDACTED}`);
    expect(redactString(`secret=[${'x'.repeat(3000)}${SECRET}`)).toBe(`secret=${REDACTED}`);
  });

  it('an unclosed quote is redacted to the end of the line, not further', () => {
    expect(redactString(`token="${'x'.repeat(3000)}${SECRET}\nnext=1`)).toBe(
      `token="${REDACTED}\nnext=1`,
    );
  });
});

describe('L3: stripping a URL keeps the backslash of a following escaped quote', () => {
  it('keeps trailing backslashes of a stripped URL', () => {
    expect(stripUrls(`https://h.example/p${BS}${Q}`)).toBe(`https://h.example${BS}${Q}`);
    expect(stripUrls(`x //h.example/p${BS}${BS}${BS}${Q}`)).toBe(
      `x //h.example${BS}${BS}${BS}${Q}`,
    );
  });

  it('a URL before an escaped quote does not end the value early', () => {
    const absolute = `{"password":"x https://h.example/p${BS}${Q}${SECRET}"}`;
    expect(redactString(absolute)).toBe(`{"password":"${REDACTED}"}`);
    const relative = `{"password":"x //h.example/p${BS}${Q}${SECRET}"}`;
    expect(redactString(relative)).toBe(`{"password":"${REDACTED}"}`);
  });
});

describe('L5: JSON-escaped and backslash-scheme URLs are reduced to their origin', () => {
  it('JSON-escaped slashes (PHP json_encode style)', () => {
    const text = `"https:${BS}/${BS}/h.example${BS}/v2${BS}/${SECRET}"`;
    expect(stripUrls(text)).toBe(`"https://h.example"`);
  });

  it('a backslash scheme separator', () => {
    expect(stripUrls(`https:${BS}${BS}h.example${BS}v2${BS}${SECRET}`)).toBe('https://h.example');
  });

  it('URL-named fields', () => {
    expect(redact({ rpcUrl: `https:${BS}/${BS}/h.example${BS}/v2${BS}/${SECRET}` })).toEqual({
      rpcUrl: 'https://h.example',
    });
    expect(redact({ rpcUrl: `https:${BS}${BS}h.example${BS}v2${BS}${SECRET}` })).toEqual({
      rpcUrl: 'https://h.example',
    });
  });

  it('a Windows path is not mistaken for a URL', () => {
    expect(stripUrls(`C:${BS}${BS}Users${BS}${BS}bob`)).toBe(`C:${BS}${BS}Users${BS}${BS}bob`);
    expect(stripUrls(`C:${BS}Users${BS}bob`)).toBe(`C:${BS}Users${BS}bob`);
  });
});

describe('L6: the pair finder regex has no unbounded quantifier', () => {
  it('has no star, plus or open-ended range', () => {
    // A regex-engine step is invisible to the work meter, so the source is checked instead: every
    // repeat in the finder is bounded, so it cannot backtrack more than a constant per position.
    const source = PAIR_FINDER_SOURCE.replace(/\\./g, '');
    expect(source).not.toMatch(/[*+]/);
    expect(source).not.toMatch(/\{\d+,\}/);
  });

  it('the scanner cost stays linear on the review worst cases', () => {
    for (const text of [
      'a.'.repeat(8192),
      `a${BS.repeat(16)}`.repeat(1024),
      'code=['.repeat(2700),
    ]) {
      expect(pairScanWork(text)).toBeLessThanOrEqual(3 * text.length);
    }
  });
});

describe('L7: protocol-relative URLs with user info and IPv6 hosts', () => {
  it('drops user info, including a password that looks like a port', () => {
    expect(stripUrls(`//admin:98765${SECRET}@host.example/x`)).toBe('//host.example');
    expect(stripUrls(`call //admin:98765@host.example:8080/x?y=1 failed`)).toBe(
      'call //host.example:8080 failed',
    );
  });

  it('keeps an IPv6 host with its port and drops the path', () => {
    expect(stripUrls(`//[::1]:8080/v2/${SECRET}`)).toBe('//[::1]:8080');
  });

  it('still leaves ordinary text alone', () => {
    expect(stripUrls('a//b and /v2//x and // comment')).toBe('a//b and /v2//x and // comment');
  });
});
