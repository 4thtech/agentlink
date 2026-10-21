# @4thtech-io/log

The shared redacting logger (04 §1 I-7, §8 rule 4) and the secret-canary test helper. Zero dependencies; runs in Node, browsers and Workers. Every package logs through it; `console` is banned elsewhere by `eslint.config.mjs`.

```ts
import { createLogger } from '@4thtech-io/log';

const log = createLogger({ name: 'transport-nostr', level: 'info' });
log.info('relay connected', { relayUrl: 'wss://relay.example/' }); // logged as wss://relay.example
log.error('publish failed', err); // an Error is logged as `err`; anything else thrown, as `value`
```

Each record is one JSON line: `time`, `level`, `name`, `msg`, then the fields. Only a plain object is spread into fields; an Error becomes `err`, and any other value (a thrown string, a number, an array) becomes `value`. Sinks receive only the redacted line. The default console sink writes every level to stderr in Node, so a stdio MCP server's stdout stays clean; in browsers and Workers each level uses its own console method.

## What is redacted

Always, at every level (debug included); there is no switch to turn it off.

- **By key name:** `seed`, `secret`, `privateKey`, `fileKey`, `cek`, `salt`, `url`, `presigned`, `payload`, `plaintext`, `body`, `authorization`, `token`, `code`, plus `password`, `passphrase`, `mnemonic`, `nsec`, `credential`, `cookie`, `apiKey`, `accessKey`, `signature`, `privKey`, `priv`, `auth`, `jwt`, `pwd`, `session`, `xpriv`, and a bare `key`, `sig`, `t`, `sk`, `pass` or `pin`. Matching ignores case, separators and digit suffixes, and covers prefixed and plural forms (`agentPrivateKey`, `PRIVATE_KEY`, `accessTokens`, `X-Amz-Signature`, `seed2`). Keys over 256 characters are redacted without inspection. The whole value is replaced, whatever its type, with two exceptions:
  - `url`-named keys (`relayUrl`) keep only the URL's origin; anything that is not a URL is redacted, and `presigned`, `signed` and `download` URLs are redacted whole;
  - `code`-named keys (`statusCode`, `error.code`) keep only HTTP status codes (100–599) and system error codes (`ECONNREFUSED`, `ERR_INVALID_URL`). A component's own fixed codes reach the logs only through the allowlist: `createLogger({ codes: ['proof_mismatch'] })` or `logger.withCodes([...])` lets the top-level `code` field keep exactly those strings; an unlisted value is still redacted. Each listed code must be a snake-case identifier (all lower or all upper case, at most 64 characters) that redaction leaves unchanged, or the call throws.
- **By value pattern, in every string** (messages, values, object keys, error messages and stacks):
  - 64 or more hex digits (hashes and transaction IDs too: accepted over-redaction);
  - bech32 `nsec` and `ncryptsec`;
  - SigV4 `X-Amz-Signature`, `X-Amz-Credential` and `X-Amz-Security-Token`, also percent-encoded;
  - `AWS4-HMAC-SHA256` values and any `Authorization` header value;
  - `Bearer` and `Basic` credentials;
  - local-UI `?t=` tokens;
  - JWTs and `data:` URIs;
  - `name=value`, `name: value` and `"name":"value"` pairs whose name is a sensitive key. The value may be quoted (an escaped quote does not end it), part of JSON nested in a string up to four levels deep (`\"name\":\"value\"`), or an object or array (redacted up to the matching bracket). There is no length cap: a value that never closes is redacted to the end of its line (quoted) or of the string (object or array), and a bare value to its separator;
  - the recovery-code shape (24 base32 characters in equal groups; a heuristic until M1-1 pins the format).
- **URLs**, plain or percent-encoded, are logged as their origin only (scheme, host, port): paths carry API keys and object IDs, queries carry signatures, fragments carry file keys. A backslash ends the host like a slash (`https://host\v2\key`), JSON-escaped (`https:\/\/host\/v2`) and backslash (`https:\\host`) spellings are reduced too, and a protocol-relative URL keeps only its host (`//user:pw@host/v2/key` becomes `//host`; IPv6 hosts work). A scheme-less URL (`host.tld/v2/key`) is not recognised: an accepted residual risk, so never put one in a message.
- **Structure:** nested objects, arrays, Maps and Sets; `Error` name, message, stack, `cause` chain and `AggregateError` members; cycles (`[Circular]`); throwing getters and Proxy traps lose only their own value. Byte arrays are never logged. Budgets per record: depth 8, 10 000 objects, 1 000 entries per object or array, 256 KiB of strings, 16 KiB per string; anything beyond becomes `[Truncated]` or is replaced whole.

Pattern matching is a safety net. A secret with no recognisable shape is protected only by its key name, so put variable data in fields with honest names, never in the message.

A `Map` with object keys is logged under the key `"[object Object]"`: its values get only the value-pattern layer, never the key-name rule. Use string keys, or a plain object, for anything that may hold a secret.

## Secret canaries: adding yours

`@4thtech-io/log/testing` runs your code with a debug-level logger and the console (and, in Node, `process.stdout` and `process.stderr`) captured, and fails if any known fake secret (a canary) appears in any line at any level. Every package that handles secrets adds a canary test:

1. Define canaries: realistic fake secrets your package handles, built at run time so the secret scanner does not flag the source. Use printable ASCII, at least 8 characters; add other encodings (hex, base64) as `forms`.
2. Add `src/<area>.canary.test.ts`:

   ```ts
   import { assertNoCanaryLeaks, PATTERN_CANARIES } from '@4thtech-io/log/testing';

   it('no secret reaches the logs', async () => {
     await assertNoCanaryLeaks({
       canaries: [...PATTERN_CANARIES, { name: 'storage/secret-key', value: fakeSecretKey }],
       exercise: async ({ logger }) => {
         const adapter = createS3Adapter({ logger, credentials: fakeCredentials });
         await adapter.put(fakeFile).catch(() => undefined); // drive failure paths too
       },
       minLines: 3,
     });
   });
   ```

3. Drive the public API, not helpers, including errors and retries.
4. Keep a negative control: feed a deliberately leaking exercise to `runCanaryCheck` and expect a leak (see `src/testing.test.ts` and `test/leaky-fixture.ts`).

The tests run in `pnpm test`, so `ci-gate` blocks a merge that leaks.
