// Regression tests for the findings of independent review IR-M0-8-1. Each test reproduces a finding
// against the code that the review examined (it failed there) and pins the fix.

import { describe, expect, it } from 'vitest';
import { captureConsole } from './console.js';
import { createLogger, type Fields, type Level } from './logger.js';
import { isSensitiveKey, redact, REDACTED, redactString, stripUrls } from './redact.js';

const HEX64 = 'ef56'.repeat(16);

function capture() {
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', sink: (_level, line) => lines.push(line) });
  return { logger, lines, text: () => lines.join('\n') };
}

describe('F01: non-object fields are wrapped, never spread', () => {
  it('a thrown string containing a 64-hex secret is redacted', () => {
    const { logger, lines, text } = capture();
    try {
      throw `decrypt failed for key ${HEX64}`;
    } catch (thrown) {
      logger.error('failed', thrown as Error);
    }
    expect(text()).not.toContain(HEX64);
    expect(text()).not.toContain('ef56');
    expect(JSON.parse(lines[0]!)).toMatchObject({ value: `decrypt failed for key ${REDACTED}` });
  });

  it.each([
    ['number', 42, 42],
    ['bigint', 7n, '7'],
    ['array', [HEX64, 'ok'], [REDACTED, 'ok']],
    ['boolean', true, true],
    ['null', null, null],
  ])('a %s is logged under "value"', (_label, value, expected) => {
    const { logger, lines } = capture();
    logger.info('x', value as unknown as Fields);
    expect(JSON.parse(lines[0]!).value).toEqual(expected);
  });

  it('string bindings (createLogger and child) are wrapped too', () => {
    const lines: string[] = [];
    const logger = createLogger({
      sink: (_l, line) => lines.push(line),
      bindings: `root ${HEX64}` as unknown as Fields,
    });
    logger.child(`child ${HEX64}` as unknown as Fields).info('x');
    expect(lines.join('')).not.toContain('ef56');
  });
});

describe('F02: key-name matching is bounded', () => {
  it('a 16K-character key takes a few milliseconds and is redacted', () => {
    const key = 'a_'.repeat(8 * 1024);
    const start = performance.now();
    const out = redact({ [key]: 'value' }) as Record<string, unknown>;
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
    expect(Object.values(out)).toEqual([REDACTED]);
  });

  it('a 16K-character key through the logger stays fast', () => {
    const { logger } = capture();
    const start = performance.now();
    logger.info('x', { ['a_'.repeat(8 * 1024)]: 1 });
    expect(performance.now() - start).toBeLessThan(50);
  });

  it('keys over 256 characters are sensitive', () => {
    expect(isSensitiveKey('a'.repeat(257))).toBe(true);
    expect(isSensitiveKey('a'.repeat(256))).toBe(false);
  });
});

describe('F03: URLs are logged as their origin only', () => {
  it('drops the path (RPC API keys, drop object IDs)', () => {
    expect(stripUrls('rpc https://eth.example/v2/abcdefKEY123 down')).toBe(
      'rpc https://eth.example down',
    );
    expect(redact({ rpc: 'https://eth.example/v2/abcdefKEY123' })).toEqual({
      rpc: 'https://eth.example',
    });
  });

  it('url-named keys keep the origin; non-URL values under them are redacted', () => {
    expect(redact({ relayUrl: 'wss://relay.example/path?x=1' })).toEqual({
      relayUrl: 'wss://relay.example',
    });
    expect(redact({ url: 'not a url' })).toEqual({ url: REDACTED });
    expect(redact({ url: 42 })).toEqual({ url: REDACTED });
  });

  it('presigned and download URLs stay fully redacted', () => {
    expect(redact({ presignedUrl: 'https://r2.example/o' })).toEqual({ presignedUrl: REDACTED });
    expect(redact({ downloadUrl: 'https://r2.example/o' })).toEqual({ downloadUrl: REDACTED });
    expect(redact({ signedUrl: 'https://r2.example/o' })).toEqual({ signedUrl: REDACTED });
  });
});

describe('F04: key=value secrets inside strings', () => {
  it.each([
    ['password=hunter2hunter2 next', `password=${REDACTED} next`],
    ['{"privateKey":"shapeless-secret"}', `{"privateKey":"${REDACTED}"}`],
    ["token: 'two words' end", `token: '${REDACTED}' end`],
    ['agentPrivateKey = abc', `agentPrivateKey = ${REDACTED}`],
  ])('%s', (input, output) => {
    expect(redactString(input)).toBe(output);
  });

  it('leaves ordinary key: value prose alone', () => {
    expect(redactString('error: connection refused, host=relay.example')).toBe(
      'error: connection refused, host=relay.example',
    );
  });
});

describe('F05: Basic credentials outside an Authorization line', () => {
  it('header tuples', () => {
    const out = JSON.stringify(redact([['authorization-scheme', 'Basic Zm9vOmJhcg==']]));
    expect(out).not.toContain('Zm9vOmJhcg');
    expect(redactString('creds Basic Zm9vOmJhcg== end')).toBe(`creds Basic ${REDACTED} end`);
  });

  it('leaves the word Basic in prose alone', () => {
    expect(redactString('Basic authentication failed')).toBe('Basic authentication failed');
  });
});

describe('F06: percent-encoded presigned URLs', () => {
  it('encoded X-Amz parameters', () => {
    const text =
      'next=%2Fo%3FX-Amz-Security-Token%3Dsessiontok%26X-Amz-Credential%253DKEYID%252F2026';
    const out = redactString(text);
    expect(out).not.toContain('sessiontok');
    expect(out).not.toContain('KEYID');
  });

  it('an encoded URL keeps only its origin', () => {
    expect(redactString('redirect=https%3A%2F%2Fr2.example%2Fbucket%2Fobj%3Fsig%3Dabc end')).toBe(
      'redirect=https%3A%2F%2Fr2.example end',
    );
  });
});

describe('F07: one hostile value does not drop the whole record', () => {
  it('a Proxy with a throwing getPrototypeOf trap only loses itself', () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('trap');
        },
      },
    );
    expect(redact({ ok: 1, hostile })).toEqual({ ok: 1, hostile: '[Unserializable]' });
  });
});

describe('F08: node and key budget', () => {
  it('fan-out of shared references is capped', () => {
    let node: unknown = { leaf: 1 };
    for (let i = 0; i < 7; i += 1) node = [node, node, node, node, node];
    const start = performance.now();
    const text = JSON.stringify(redact(node));
    expect(performance.now() - start).toBeLessThan(200);
    expect(text.length).toBeLessThan(400_000);
    expect(text).toContain('[Truncated]');
  });

  it('objects keep at most 1000 keys', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 5000; i += 1) wide[`k${i}`] = i;
    const out = redact(wide) as Record<string, unknown>;
    expect(Object.keys(out).length).toBeLessThanOrEqual(1001);
    expect(out['…']).toBe('[Truncated]');
  });
});

describe('F09: key-name gaps', () => {
  it.each([
    'seed2',
    'key1',
    'privKey',
    'priv',
    'auth',
    'jwt',
    'pwd',
    'sessionId',
    'xpriv',
    'sk',
    'pass',
    'pin',
  ])('%s is sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(['author', 'sha256', 'base64', 'keyId'])('%s stays readable', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe('decision: status and error codes allowlisted by value shape only', () => {
  it('HTTP status integers and Node/system error codes stay readable', () => {
    expect(redact({ statusCode: 404, code: 'ECONNREFUSED' })).toEqual({
      statusCode: 404,
      code: 'ECONNREFUSED',
    });
    expect(redact({ code: 'ERR_INVALID_URL' })).toEqual({ code: 'ERR_INVALID_URL' });
  });

  it('anything else under a code key is redacted', () => {
    expect(redact({ code: 123456, recoveryCode: 'ABCD-EFGH', statusCode: '404' })).toEqual({
      code: REDACTED,
      recoveryCode: REDACTED,
      statusCode: REDACTED,
    });
  });

  it('the allowlist never applies to keys sensitive for another reason', () => {
    expect(redact({ tokenCode: 404, secret: 'ENOENT' })).toEqual({
      tokenCode: REDACTED,
      secret: REDACTED,
    });
  });
});

describe('F10: direct stdout/stderr writes are captured', () => {
  it('captureConsole also captures process.stdout.write and process.stderr.write', () => {
    const proc = (globalThis as { process?: { stdout: { write: (s: string) => boolean } } })
      .process;
    if (proc === undefined) return;
    const seen: string[] = [];
    const restore = captureConsole((method, data) => seen.push(`${method}:${String(data[0])}`));
    try {
      proc.stdout.write('direct');
    } finally {
      restore();
    }
    expect(seen).toEqual(['stdout:direct']);
  });
});

describe('F12: the default console sink keeps stdout clean in Node', () => {
  it('writes every level to the error stream by default in Node', () => {
    const methods: string[] = [];
    const restore = captureConsole((method) => methods.push(method));
    try {
      const logger = createLogger({ level: 'debug' });
      for (const level of ['debug', 'info', 'warn', 'error'] as Level[]) logger[level]('x');
    } finally {
      restore();
    }
    expect(methods).toEqual(['error', 'error', 'error', 'error']);
  });
});

describe('F13: a broken clock or bindings getter never throws to the caller', () => {
  it('clock that throws', () => {
    const lines: string[] = [];
    const logger = createLogger({
      sink: (_l, line) => lines.push(line),
      now: () => {
        throw new Error('clock');
      },
    });
    expect(() => logger.info('x')).not.toThrow();
    expect(JSON.parse(lines[0]!).time).toBe('1970-01-01T00:00:00.000Z');
  });

  it('clock that returns an invalid date', () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (_l, line) => lines.push(line), now: () => new Date(NaN) });
    expect(() => logger.info('x')).not.toThrow();
    expect(lines).toHaveLength(1);
  });

  it('child bindings with a throwing getter', () => {
    const { logger } = capture();
    const bindings = {
      get boom(): string {
        throw new Error('getter');
      },
    };
    expect(() => logger.child(bindings).info('x')).not.toThrow();
  });
});
