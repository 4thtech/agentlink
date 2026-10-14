import { describe, expect, it } from 'vitest';
import {
  isSensitiveKey,
  MAX_DEPTH,
  MAX_STRING_LENGTH,
  redact,
  REDACTED,
  redactString,
  SENSITIVE_KEYS,
  stripUrls,
} from './redact.js';

// Fake secrets are built at run time so the source holds no secret-shaped literal.
const HEX64 = 'ab12'.repeat(16);
const NSEC = `nsec1${'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(2)}`;
const NCRYPTSEC = `ncryptsec1${'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(5)}`;
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ0ZXN0In0', 'dGVzdC1zaWduYXR1cmU'].join('.');
const KEY_ONLY = 'shapeless-secret-value';

describe('redaction by key name', () => {
  const CARD_KEYS = [
    'seed',
    'secret',
    'privateKey',
    'fileKey',
    'cek',
    'salt',
    'url',
    'presigned',
    'payload',
    'plaintext',
    'body',
    'authorization',
    'token',
    'code',
  ];

  it('covers every key named on the M0-8 card', () => {
    expect(SENSITIVE_KEYS.slice(0, CARD_KEYS.length)).toEqual(CARD_KEYS);
  });

  it.each(CARD_KEYS)('redacts the value of "%s"', (key) => {
    expect(redact({ [key]: KEY_ONLY })).toEqual({ [key]: REDACTED });
  });

  it.each([
    'password',
    'passphrase',
    'mnemonic',
    'nsec',
    'credential',
    'cookie',
    'apiKey',
    'accessKey',
    'signature',
  ])('redacts the value of the extra key "%s"', (key) => {
    expect(redact({ [key]: KEY_ONLY })).toEqual({ [key]: REDACTED });
  });

  it.each([
    'PRIVATE_KEY',
    'private-key',
    'privatekey',
    'PrivateKey',
    'agentPrivateKey',
    'ownerSeed',
    'seeds',
    'accessToken',
    'refresh_tokens',
    'presignedUrl',
    'relayUrl',
    'requestBody',
    'recoveryCode',
    'statusCode',
    'X-Amz-Signature',
    'X-Amz-Credential',
    'x-amz-security-token',
    'Authorization',
    'set-cookie',
    'clientSecret',
    'key',
    'sig',
    't',
  ])('treats "%s" as sensitive (casing, separators, prefixes, plurals)', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    'publicKey',
    'keyId',
    'idempotencyKey',
    'status',
    'encoded',
    'decoder',
    'nobody',
    'host',
    'count',
    'tx',
  ])('keeps "%s" readable', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
    expect(redact({ [key]: 'plain' })).toEqual({ [key]: 'plain' });
  });

  it('replaces the whole value whatever its type', () => {
    expect(redact({ token: { nested: KEY_ONLY }, seed: [1, 2, 3], code: 1234, cek: null })).toEqual(
      {
        token: REDACTED,
        seed: REDACTED,
        code: REDACTED,
        cek: REDACTED,
      },
    );
  });

  it('applies at any depth, inside arrays and Maps', () => {
    const value = {
      a: { b: [{ c: { fileKey: KEY_ONLY } }] },
      m: new Map<string, unknown>([
        ['salt', KEY_ONLY],
        ['ok', 'fine'],
      ]),
    };
    expect(redact(value)).toEqual({
      a: { b: [{ c: { fileKey: REDACTED } }] },
      m: { salt: REDACTED, ok: 'fine' },
    });
  });
});

describe('redaction by value pattern', () => {
  it('hex64: 64+ hex digits, any case, with or without 0x', () => {
    expect(redactString(`k=${HEX64}`)).toBe(`k=${REDACTED}`);
    expect(redactString(`0x${HEX64.toUpperCase()}`)).toBe(REDACTED);
    expect(redactString(`${HEX64}${HEX64}`)).toBe(REDACTED);
    expect(redactString(`x${HEX64}y`)).not.toContain(HEX64);
  });

  it('hex64: shorter hex (addresses, short IDs) stays', () => {
    const address = `0x${'ab12'.repeat(10)}`;
    expect(redactString(address)).toBe(address);
    expect(redactString('ab12'.repeat(15) + 'abc')).toBe('ab12'.repeat(15) + 'abc');
  });

  it('bech32 nsec', () => {
    expect(redactString(`key ${NSEC} end`)).toBe(`key ${REDACTED} end`);
    expect(redactString(NSEC.toUpperCase())).toBe(REDACTED);
  });

  it('bech32 ncryptsec', () => {
    expect(redactString(`backup ${NCRYPTSEC}`)).toBe(`backup ${REDACTED}`);
  });

  it('bech32: public npub stays', () => {
    const npub = `npub1${'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(2)}`;
    expect(redactString(npub)).toBe(npub);
  });

  it('SigV4 X-Amz-Signature', () => {
    expect(redactString('/b/o?X-Amz-Signature=abc123def&x=1')).toBe(
      `/b/o?X-Amz-Signature=${REDACTED}&x=1`,
    );
    expect(redactString('x-amz-signature: abc123def')).toBe(`x-amz-signature: ${REDACTED}`);
  });

  it('SigV4 X-Amz-Credential', () => {
    expect(redactString('/b/o?X-Amz-Credential=KEYID%2F20261014%2Fauto%2Fs3%2Faws4_request')).toBe(
      `/b/o?X-Amz-Credential=${REDACTED}`,
    );
  });

  it('SigV4 X-Amz-Security-Token', () => {
    expect(redactString('/b/o?X-Amz-Security-Token=sessiontoken')).toBe(
      `/b/o?X-Amz-Security-Token=${REDACTED}`,
    );
  });

  it('Authorization: AWS4-HMAC-SHA256 header', () => {
    const header =
      'Authorization: AWS4-HMAC-SHA256 Credential=KEYID/20261014/auto/s3/aws4_request, Signature=abc';
    expect(redactString(header)).toBe(`Authorization: ${REDACTED}`);
    expect(redactString('AWS4-HMAC-SHA256 Credential=KEYID, Signature=abc')).toBe(
      `AWS4-HMAC-SHA256 ${REDACTED}`,
    );
  });

  it('Authorization header with any scheme, only to the end of its line', () => {
    expect(redactString('authorization = Basic dXNlcjpwYXNz\nnext line')).toBe(
      `authorization = ${REDACTED}\nnext line`,
    );
  });

  it('Bearer tokens', () => {
    expect(redactString('sent Bearer abc.def-ghi to relay')).toBe(
      `sent Bearer ${REDACTED} to relay`,
    );
    expect(redactString('bearer abc.def-ghi')).toBe(`Bearer ${REDACTED}`);
  });

  it('local-UI ?t= token in a relative URL', () => {
    expect(redactString('opened /approve?t=sessiontoken42&x=1')).toBe(
      `opened /approve?t=${REDACTED}&x=1`,
    );
    expect(redactString('/?t=sessiontoken42')).toBe(`/?t=${REDACTED}`);
    expect(redactString('/a?b=1&t=sessiontoken42')).toBe(`/a?b=1&t=${REDACTED}`);
  });

  it.each([
    ['six groups of four, hyphens', 'ABCD-EFGH-IJKL-MNOP-QRST-UV23'],
    ['four groups of six, hyphens', 'ABCDEF-GHIJKL-MNOPQR-STUV23'],
    ['three groups of eight, lower case', 'abcdefgh-ijklmnop-qrstuv23'],
    ['six groups of four, spaces', 'ABCD EFGH IJKL MNOP QRST UV23'],
    ['no separators', 'ABCDEFGHIJKLMNOPQRSTUV23'],
  ])('recovery code: %s', (_label, code) => {
    expect(redactString(`code is ${code}.`)).toBe(`code is ${REDACTED}.`);
  });

  it('recovery code: UUIDs, dates and prose stay', () => {
    const text = 'request 123e4567-e89b-12d3-a456-426614174000 on 2026-10-14: the relay is OK NOW';
    expect(redactString(text)).toBe(text);
    expect(redactString('createAgentLinkClientNow')).toBe('createAgentLinkClientNow');
  });

  it('JWT', () => {
    expect(redactString(`jwt ${JWT} end`)).toBe(`jwt ${REDACTED} end`);
  });

  it('data: URIs (inline file content)', () => {
    expect(redactString('img data:text/plain;base64,aGVsbG8gd29ybGQ= end')).toBe(
      `img data:${REDACTED} end`,
    );
  });

  it('strings over the size cap are replaced whole', () => {
    const big = 'a'.repeat(MAX_STRING_LENGTH + 1);
    expect(redactString(big)).toBe(`${REDACTED} (string of ${big.length} characters)`);
  });

  it('pattern redaction applies to field values and object keys', () => {
    expect(redact({ note: `see ${HEX64}`, [HEX64]: 1 })).toEqual({
      note: `see ${REDACTED}`,
      [REDACTED]: 1,
    });
  });
});

describe('URLs', () => {
  it('drops the query string', () => {
    expect(stripUrls('https://r2.example/bucket/obj?X-Amz-Signature=s&X-Amz-Credential=c')).toBe(
      'https://r2.example/bucket/obj',
    );
  });

  it('drops the fragment', () => {
    expect(stripUrls('https://verify.example/p#filekey')).toBe('https://verify.example/p');
  });

  it('drops user info and keeps host, port and path', () => {
    expect(stripUrls('wss://user:pass@relay.example:7447/path/x?y=1')).toBe(
      'wss://relay.example:7447/path/x',
    );
  });

  it('handles several URLs in one string and leaves other text alone', () => {
    expect(redactString('from http://127.0.0.1:4242/?t=abc to https://a.example/b?c=d done')).toBe(
      'from http://127.0.0.1:4242/ to https://a.example/b done',
    );
  });

  it('handles URL objects', () => {
    const URLCtor = (globalThis as unknown as { URL: new (input: string) => object }).URL;
    expect(redact({ link: new URLCtor('https://u:p@a.example/b?q=secret#f') })).toEqual({
      link: 'https://a.example/b',
    });
  });
});

describe('errors', () => {
  it('scrubs the message and the stack', () => {
    const error = new Error(`failed with ${HEX64}`);
    const out = redact(error) as Record<string, string>;
    expect(out.name).toBe('Error');
    expect(out.message).toBe(`failed with ${REDACTED}`);
    expect(out.stack).toContain(REDACTED);
    expect(JSON.stringify(out)).not.toContain(HEX64);
  });

  it('follows the cause chain and AggregateError members', () => {
    const inner = new Error(`inner ${NSEC}`);
    const outer = new Error('outer', { cause: inner });
    const aggregate = new AggregateError([outer, new Error(JWT)], 'many');
    const text = JSON.stringify(redact(aggregate));
    expect(text).not.toContain(NSEC);
    expect(text).not.toContain(JWT);
    expect(text).toContain('outer');
  });

  it('applies the key rule to own properties (response bodies, request config)', () => {
    const error = Object.assign(new Error('http 500'), {
      status: 500,
      body: KEY_ONLY,
      config: { url: 'https://x' },
    });
    expect(redact(error)).toMatchObject({ status: 500, body: REDACTED, config: { url: REDACTED } });
  });
});

describe('structure', () => {
  it('handles cycles without marking repeated siblings', () => {
    const shared = { v: 1 };
    const node: Record<string, unknown> = { a: shared, b: shared };
    node.self = node;
    expect(redact(node)).toEqual({ a: { v: 1 }, b: { v: 1 }, self: '[Circular]' });
  });

  it('handles cycles through arrays', () => {
    const list: unknown[] = [1];
    list.push(list);
    expect(redact(list)).toEqual([1, '[Circular]']);
  });

  it('truncates past the depth limit', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < MAX_DEPTH + 2; i += 1) deep = { next: deep };
    expect(JSON.stringify(redact(deep))).toContain('[Truncated]');
  });

  it('never logs raw bytes', () => {
    const out = redact({ data: new Uint8Array([1, 2, 3]), buffer: new ArrayBuffer(4) });
    expect(out).toEqual({ data: `${REDACTED} (bytes)`, buffer: `${REDACTED} (bytes)` });
  });

  it('survives getters that throw and does not call toJSON', () => {
    const tricky = {
      get boom(): string {
        throw new Error('no');
      },
      toJSON: () => ({ leaked: KEY_ONLY }),
      ok: 1,
    };
    const out = redact(tricky);
    expect(out).toEqual({ boom: '[Unreadable]', toJSON: '[Function]', ok: 1 });
  });

  it('converts other types to JSON-safe values', () => {
    expect(
      redact({ n: 1n, u: undefined, d: new Date(0), s: new Set(['a']), inf: Infinity }),
    ).toEqual({
      n: '1',
      u: null,
      d: '1970-01-01T00:00:00.000Z',
      s: ['a'],
      inf: 'Infinity',
    });
  });

  it('does not mutate its input', () => {
    const input = { token: KEY_ONLY, nested: { note: HEX64 } };
    const copy = JSON.parse(JSON.stringify(input));
    redact(input);
    expect(input).toEqual(copy);
  });
});
