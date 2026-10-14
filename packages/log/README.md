# @agentlink/log

The shared redacting logger (04 §1 I-7, §8.4) and the secret-canary test helper. Zero dependencies; runs in Node, browsers and Workers. Every package logs through it; `console` is banned elsewhere by `eslint.config.mjs`.

```ts
import { createLogger } from '@agentlink/log';

const log = createLogger({ name: 'transport-nostr', level: 'info' });
log.info('relay connected', { relayHost: 'relay.example' });
log.error('publish failed', err); // an Error may be passed as the fields
```

Each record is one JSON line: `time`, `level`, `name`, `msg`, then the fields. Sinks receive only the redacted line. In a stdio MCP server use `consoleSink({ stderr: true })`, because stdout carries the protocol.

## What is redacted

Always, at every level (debug included); there is no switch to turn it off.

- **By key name:** `seed`, `secret`, `privateKey`, `fileKey`, `cek`, `salt`, `url`, `presigned`, `payload`, `plaintext`, `body`, `authorization`, `token`, `code`, plus `password`, `passphrase`, `mnemonic`, `nsec`, `credential`, `cookie`, `apiKey`, `accessKey`, `signature`, and a bare `key`, `sig` or `t`. Matching ignores case and separators, and covers prefixed and plural forms (`agentPrivateKey`, `PRIVATE_KEY`, `accessTokens`, `X-Amz-Signature`). The whole value is replaced, whatever its type. So `relayUrl` and `statusCode` are redacted too: log `relayHost` or `status` instead.
- **By value pattern, in every string** (messages, values, object keys, error messages and stacks): 64 or more hex digits; bech32 `nsec` and `ncryptsec`; SigV4 `X-Amz-Signature`, `X-Amz-Credential` and `X-Amz-Security-Token`; `AWS4-HMAC-SHA256` values and any `Authorization` header value; `Bearer` tokens; local-UI `?t=` tokens; the recovery-code shape (24 base32 characters in equal groups); JWTs; `data:` URIs.
- **URLs** lose their query string, fragment and user info.
- **Structure:** nested objects, arrays, Maps and Sets; `Error` name, message, stack, `cause` chain and `AggregateError` members; cycles (`[Circular]`); depth beyond 8 (`[Truncated]`); byte arrays are never logged; strings over 16 KiB are replaced whole.

Pattern matching is a safety net. A secret with no recognisable shape is protected only by its key name, so put variable data in fields with honest names, never in the message.

## Secret canaries: adding yours

`@agentlink/log/testing` runs your code with a debug-level logger and the console captured, and fails if any known fake secret (a canary) appears in any line at any level. Every package that handles secrets adds a canary test:

1. Define canaries: realistic fake secrets your package handles, built at run time so the secret scanner does not flag the source. Use printable ASCII, at least 8 characters; add other encodings (hex, base64) as `forms`.
2. Add `src/<area>.canary.test.ts`:

   ```ts
   import { assertNoCanaryLeaks, PATTERN_CANARIES } from '@agentlink/log/testing';

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
