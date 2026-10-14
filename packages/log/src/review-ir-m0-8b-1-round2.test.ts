// Regression tests for the round 2 findings R2-L1 and R2-L3 of independent review IR-M0-8b-1.

import { describe, expect, it } from 'vitest';
import { redact, REDACTED, redactString, stripUrls } from './redact.js';

// Fake secrets are built at run time so the source holds no secret-shaped literal.
const SECRET = ['Zq9', 'vT4', 'kP7', 'wX2'].join('');
const BS = '\\';

describe('R2-L1: an escaped bracket does not end a bracketed value', () => {
  it('an escaped closing square bracket', () => {
    expect(redactString(`secret=[a${BS}]${SECRET}] after`)).toBe(`secret=${REDACTED} after`);
  });

  it('an escaped closing brace', () => {
    expect(redactString(`secret={a${BS}}${SECRET}} after`)).toBe(`secret=${REDACTED} after`);
  });

  it('an escaped bracket in JSON that is nested in a string', () => {
    const q = `${BS}"`;
    const text = `{${q}token${q}:[${q}a${BS}${BS}]${q},${q}${SECRET}${q}],${q}user${q}:${q}bob${q}}`;
    const out = redactString(text);
    expect(out).not.toContain(SECRET);
    expect(out).toContain('bob');
  });

  it('a bracket after an escaped backslash is still a real bracket', () => {
    // "a\\" then "]": the backslashes escape each other, but the value is only redacted further
    // (never less), so the text after the real bracket is kept or redacted, never the secret.
    const out = redactString(`secret=[a${BS}${BS}]${SECRET} after`);
    expect(out).not.toContain(`${BS}${BS}]${SECRET}`);
  });
});

describe('R2-L3: URL handling does not rewrite text that is not a URL', () => {
  it('"failed:" followed by an escaped backslash and "n" is left alone', () => {
    const text = `failed:${BS}${BS}nretry`;
    expect(stripUrls(text)).toBe(text);
    expect(redactString(text)).toBe(text);
  });

  it('other words with a colon and two backslashes are left alone', () => {
    const text = `see note:${BS}${BS}tab and C:${BS}${BS}Users${BS}${BS}bob`;
    expect(stripUrls(text)).toBe(text);
  });

  it('a non-URL under a URL-named field is redacted, not rewritten', () => {
    expect(redact({ rpcUrl: `failed:${BS}${BS}nretry` })).toEqual({ rpcUrl: REDACTED });
  });

  it('a backslash separator still works for web schemes', () => {
    expect(stripUrls(`http:${BS}${BS}h.example${BS}v2${BS}${SECRET}`)).toBe('http://h.example');
    expect(stripUrls(`wss:${BS}${BS}h.example:8080${BS}v2`)).toBe('wss://h.example:8080');
  });

  it('JSON-escaped slashes still work for any scheme', () => {
    expect(stripUrls(`redis:${BS}/${BS}/h.example${BS}/0${BS}/${SECRET}`)).toBe(
      'redis://h.example',
    );
  });
});
