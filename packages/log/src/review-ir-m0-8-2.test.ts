// Regression tests for the Low findings L1-L3 of independent review IR-M0-8-2 (task M0-8b). Each
// test fails on the code that the review examined and pins the fix. L4 is a README note.

import { describe, expect, it } from 'vitest';
import { pairScanWork, redact, REDACTED, redactString, stripUrls } from './redact.js';

// Fake secrets are built at run time so the source holds no secret-shaped literal.
const SECRET = ['Zq9', 'vT4', 'kP7', 'wX2'].join('');
const OTHER = ['Hn5', 'bR8', 'cL3', 'dM6'].join('');
const BS = '\\';

describe('L1: the key=value scanner handles JSON escapes and nesting', () => {
  it('an escaped quote does not end the value', () => {
    const text = `{"password":"ab${BS}"${SECRET}","user":"bob"}`;
    expect(redactString(text)).toBe(`{"password":"${REDACTED}","user":"bob"}`);
  });

  it('an escaped backslash before the closing quote still ends the value', () => {
    const text = `{"password":"ab${BS}${BS}","user":"bob"}`;
    expect(redactString(text)).toBe(`{"password":"${REDACTED}","user":"bob"}`);
  });

  it('double-encoded JSON is redacted and keeps its structure', () => {
    const q = `${BS}"`;
    const text = `{${q}password${q}:${q}${SECRET}${q},${q}user${q}:${q}bob${q}}`;
    expect(redactString(text)).toBe(
      `{${q}password${q}:${q}${REDACTED}${q},${q}user${q}:${q}bob${q}}`,
    );
  });

  it('double-encoded JSON with an escaped quote inside the value', () => {
    const q = `${BS}"`;
    const inner = `ab${BS}${BS}${BS}"${SECRET}`;
    const text = `{${q}token${q}:${q}${inner}${q},${q}user${q}:${q}bob${q}}`;
    const out = redactString(text);
    expect(out).not.toContain(SECRET);
    expect(out).toBe(`{${q}token${q}:${q}${REDACTED}${q},${q}user${q}:${q}bob${q}}`);
  });

  it('triple-encoded JSON is redacted', () => {
    const q = `${BS}${BS}${BS}"`;
    const text = `{${q}password${q}:${q}${SECRET}${q},${q}user${q}:${q}bob${q}}`;
    const out = redactString(text);
    expect(out).not.toContain(SECRET);
    expect(out).toContain('bob');
  });

  it('a sensitive key holding an object is redacted up to the matching brace', () => {
    const text = `{"privateKey":{"d":"${SECRET}","x":["${OTHER}"]},"user":"bob"}`;
    expect(redactString(text)).toBe(`{"privateKey":${REDACTED},"user":"bob"}`);
  });

  it('braces inside strings of the object do not end it early', () => {
    const text = `{"secret":{"a":"}${SECRET}","b":"{"},"user":"bob"}`;
    expect(redactString(text)).toBe(`{"secret":${REDACTED},"user":"bob"}`);
  });

  it('a sensitive key holding an array is redacted up to the matching bracket', () => {
    const text = `token: [ "${SECRET}", ["${OTHER}"] ] after`;
    expect(redactString(text)).toBe(`token: ${REDACTED} after`);
  });

  it('an object under a code-named key is redacted too', () => {
    expect(redactString(`{"code":{"d":"${SECRET}"},"user":"bob"}`)).toBe(
      `{"code":${REDACTED},"user":"bob"}`,
    );
  });

  it('an object that never closes is redacted to the end of the string (fails closed)', () => {
    expect(redactString(`secret={${'x'.repeat(6000)}`)).toBe(`secret=${REDACTED}`);
  });

  it('a harmless key holding an object still lets inner pairs be seen', () => {
    const out = redactString(`{"meta":{"password":"${SECRET}"}}`);
    expect(out).toBe(`{"meta":{"password":"${REDACTED}"}}`);
  });

  it('structured values with escaped strings stay redacted', () => {
    const out = redact({ message: `failed {"password":"a${BS}"${SECRET}"}` });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });
});

describe('L2: URL paths are dropped in backslash and protocol-relative forms', () => {
  it('a backslash path is dropped', () => {
    expect(stripUrls(`https://host.example${BS}v2${BS}${SECRET}`)).toBe('https://host.example');
    expect(redactString(`call https://host.example:8545${BS}v2${BS}${SECRET} failed`)).toBe(
      'call https://host.example:8545 failed',
    );
  });

  it('a URL field with a backslash path keeps only the origin', () => {
    expect(redact({ rpcUrl: `https://host.example${BS}v2${BS}${SECRET}` })).toEqual({
      rpcUrl: 'https://host.example',
    });
  });

  it('a protocol-relative URL keeps only the host', () => {
    expect(stripUrls(`fetch //cdn.example/v2/${SECRET} failed`)).toBe('fetch //cdn.example failed');
    expect(stripUrls(`//cdn.example:8080/v2/${SECRET}?k=${OTHER}`)).toBe('//cdn.example:8080');
    expect(stripUrls(`src="//cdn.example/v2/${SECRET}"`)).toBe('src="//cdn.example"');
    expect(redactString(`(//cdn.example/v2/${SECRET})`)).toBe('(//cdn.example');
  });

  it('absolute URLs and ordinary text with slashes are not touched twice', () => {
    expect(stripUrls('https://host.example/path')).toBe('https://host.example');
    expect(stripUrls('file:///etc/hosts')).toBe('file://');
    expect(stripUrls('a//b and /v2//x and // comment')).toBe('a//b and /v2//x and // comment');
  });

  it('a scheme-less URL stays an accepted residual risk', () => {
    expect(stripUrls('host.example/v2/path')).toBe('host.example/v2/path');
  });
});

describe('L3: the cost of the pair scanner has a deterministic bound', () => {
  const WORST: Record<string, (n: number) => string> = {
    'a:': (n) => 'a:'.repeat(n / 2),
    'a=a=': (n) => 'a=a='.repeat(n / 4),
    'token=': (n) => 'token='.repeat(n / 6),
    'password="': (n) => 'password="'.repeat(n / 10),
    'secret={': (n) => 'secret={'.repeat(n / 8),
    'token: [': (n) => 'token: ['.repeat(n / 8),
    'escaped quotes': (n) => `password=${BS}"`.repeat(Math.floor(n / 11)),
    'unclosed quote': (n) => `token='${'x'.repeat(n - 7)}`,
    'long bare value': (n) => `token=${'x'.repeat(n - 6)}`,
    'allowed code': (n) => 'code="ENOENT" '.repeat(Math.floor(n / 14)),
    'code=[': (n) => 'code=['.repeat(n / 6),
    'code="': (n) => 'code="'.repeat(n / 6),
    escapes: (n) => `a${BS.repeat(16)}`.repeat(Math.floor(n / 17)),
  };
  const C = 3;

  it('does no work on an empty string', () => {
    expect(pairScanWork('')).toBe(0);
  });

  it.each(Object.keys(WORST))(`work is at most ${C} x length for "%s"`, (name) => {
    const make = WORST[name]!;
    for (const length of [4096, 16 * 1024]) {
      const text = make(length);
      expect(pairScanWork(text)).toBeLessThanOrEqual(C * text.length);
    }
  });

  it.each(Object.keys(WORST))('work grows linearly for "%s"', (name) => {
    const make = WORST[name]!;
    const small = pairScanWork(make(4096));
    const large = pairScanWork(make(16 * 1024));
    // Four times the input: at most about four times the work (quadratic would be sixteen).
    expect(large).toBeLessThanOrEqual(small * 5 + 64);
  });
});
