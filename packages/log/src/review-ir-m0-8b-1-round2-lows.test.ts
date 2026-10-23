// Regression tests for the round 2 lows R2-L2 and R2-L4 of independent review IR-M0-8b-1 (M0-8c).
// Redaction must stay at least as strict as before: every case also asserts the secret is gone.

import { describe, expect, it } from 'vitest';
import { pairScanWork, redact, REDACTED, redactString, stripUrls } from './redact.js';

// Fake secrets are built at run time so the source holds no secret-shaped literal.
const SECRET = ['Zq9', 'vT4', 'kP7', 'wX2'].join('');
const BS = '\\';

describe('R2-L2: an apostrophe inside running text of a bracketed value is not a quote', () => {
  it("secret=[don't ...] ends at the closing bracket", () => {
    const out = redactString(`secret=[don't ${SECRET}] after`);
    expect(out).toBe(`secret=${REDACTED} after`);
  });

  it('an apostrophe inside an object value', () => {
    const out = redactString(`token={it's ${SECRET}} after`);
    expect(out).toBe(`token=${REDACTED} after`);
  });

  it('a Python-style repr string still hides a bracket inside it', () => {
    const out = redactString(`secret=['a]${SECRET}', 'b'] after`);
    expect(out).not.toContain(SECRET);
    expect(out).toBe(`secret=${REDACTED} after`);
  });

  it('a Python-style repr dict with apostrophes in strings', () => {
    const out = redactString(`secret={'k': 'v]${SECRET}'} after`);
    expect(out).not.toContain(SECRET);
    expect(out).toBe(`secret=${REDACTED} after`);
  });

  it('a real unclosed string still fails closed to the end', () => {
    const out = redactString(`secret=['abc ${SECRET}] after`);
    expect(out).not.toContain(SECRET);
    expect(out).toBe(`secret=${REDACTED}`);
  });

  it('the work bound still holds on a worst case', () => {
    const text = `secret=[${"'".repeat(8000)}`;
    expect(pairScanWork(text)).toBeLessThanOrEqual(40 * text.length);
  });
});

describe('R2-L4: a JSON-escaped protocol-relative URL is reduced to its host', () => {
  it('\\/\\/host\\/v2\\/KEY', () => {
    const text = `${BS}/${BS}/rpc.example.org${BS}/v2${BS}/${SECRET}`;
    const out = stripUrls(text);
    expect(out).not.toContain(SECRET);
    expect(out).toBe(`${BS}/${BS}/rpc.example.org`);
  });

  it('inside JSON text, with user info', () => {
    const text = `{"u":"${BS}/${BS}/bob:${SECRET}@h.example.org${BS}/p"}`;
    const out = redactString(text);
    expect(out).not.toContain(SECRET);
    expect(out).toContain('h.example.org');
  });

  it('the escape of a following quote is kept', () => {
    const text = `see ${BS}/${BS}/h.example.org${BS}/p${BS}"x`;
    const out = stripUrls(text);
    expect(out).toBe(`see ${BS}/${BS}/h.example.org${BS}"x`);
  });

  it('a drive letter or an absolute JSON-escaped URL is not rewritten twice', () => {
    expect(stripUrls(`C:${BS}/${BS}/Users`)).toBe(`C:${BS}/${BS}/Users`);
    const abs = `https:${BS}/${BS}/h.example.org${BS}/v2${BS}/${SECRET}`;
    expect(stripUrls(abs)).toBe(`https://h.example.org`);
  });
});

describe('optional: upload joins the capability words', () => {
  it('uploadUrl is redacted whole', () => {
    const out = redact({ uploadUrl: 'https://drop.example.org/o/abc' });
    expect(out).toEqual({ uploadUrl: REDACTED });
  });

  it('a plain relayUrl still keeps its origin', () => {
    expect(redact({ relayUrl: 'https://relay.example.org/x/y' })).toEqual({
      relayUrl: 'https://relay.example.org',
    });
  });
});

// Fix round 1 (IR-M0-8c-1): the apostrophe rule must never redact less than before.
describe('R2-L2 fail closed: an apostrophe opens a string everywhere but inside a word', () => {
  const leaks: [string, string][] = [
    ['bytes repr', `secret=[b'${BS}x8a]${SECRET}${BS}x01'] after`],
    ['raw prefix', `secret=[r'a]${SECRET}'] after`],
    ['unicode prefix', `secret=[u'a]${SECRET}'] after`],
    ['dataclass repr', `secret=[Foo(x='a]${SECRET}')] after`],
    ['key=value in object', `secret={a='x]${SECRET}', b='z'} after`],
    ['after a word and space', `secret=[foo 'bar]${SECRET}'] after`],
    ['adjacent strings', `secret=['a' 'b]${SECRET}'] after`],
    ['after empty object', `secret=[{}'a]${SECRET}'] after`],
    ['after empty array', `secret=[[]'a]${SECRET}'] after`],
    ['after colon', `secret={k:'a]${SECRET}'} after`],
    ['after comma', `secret=['x','a]${SECRET}'] after`],
  ];
  it.each(leaks)('%s never leaks', (_name, text) => {
    expect(redactString(text)).not.toContain(SECRET);
  });

  it('never leaks on a corpus of apostrophe positions', () => {
    const shapes = ["'", " '", "('", "='", "b'", "]'", "}'", ",'", ":'"];
    for (const first of shapes) {
      for (const second of shapes) {
        const text = `secret=[${first}a]${SECRET}${second}x] after`;
        expect(redactString(text), JSON.stringify(text)).not.toContain(SECRET);
      }
    }
  });
});

describe('URL-named keys with a value that is not an absolute URL are redacted in text', () => {
  it('rpcUrl=host/v2/KEY in free text', () => {
    expect(redactString(`rpcUrl=rpc.example.org/v2/${SECRET} next`)).not.toContain(SECRET);
  });

  it('{"rpcUrl":"host/v2/KEY"} in JSON text', () => {
    expect(redactString(`{"rpcUrl":"rpc.example.org/v2/${SECRET}"}`)).not.toContain(SECRET);
  });

  it('an absolute URL under a URL-named key keeps its origin', () => {
    expect(redactString(`relayUrl=https://relay.example.org/v2/${SECRET} next`)).toBe(
      'relayUrl=https://relay.example.org next',
    );
  });
});
