# test-vectors

Canonical test vectors for AgentLink's crypto and EIP-712 code, and the harness that checks them in every runtime the shared packages support (04 §8.2, task M0-9). The vectors are public. The private contracts repo pins a commit of this directory and checks parity (`docs/process/development-process.md` §9.1).

```
pnpm vectors:check
```

This runs every suite in five runtimes: Node (Vitest), Chromium, Firefox and WebKit (Vitest browser mode on Playwright), and workerd (`@cloudflare/vitest-plugin`, the renamed `@cloudflare/vitest-pool-workers`). It fails unless every runtime passes every case. Install the browsers once with `pnpm exec playwright install chromium firefox webkit`.

## Rules

1. **An independent generator produces the vectors.** The generator is a script under `tools/vectors/` that does not use the TypeScript code under test, for example Python's `hashlib`, `openssl`, or a reference implementation in another language. Each file records it in `generator`.
2. **Vectors are committed, and tests only read them.** No test writes or regenerates a vector file. `pnpm vectors:check` fails if a run creates, changes or deletes anything under `test-vectors/`, and CI checks the same with `git status` afterwards.
3. **Vectors change only together with a spec change.** Bump the file's `version` in the same PR.
4. **Every runtime reports its own identity.** Each project in `vitest.config.ts` states the runtime it expects. `harness/runtime.ts` reads the actual runtime from the engine (`navigator.userAgent`, `process.versions.node`, workerd's `WebSocketPair`). A project that silently falls back to Node fails its identity test. `tools/vectors/check.mjs` then requires a passing identity test and a passing result for every committed case in each of `node`, `chromium`, `firefox`, `webkit` and `workerd`. So dropping a runtime from the config also fails the check.
5. **Suites use only what all runtimes have.** They use WebCrypto, `TextEncoder` and `Uint8Array`, and no Node built-ins. They reach crypto through `@agentlink/crypto` (04 §8.1). `eslint.config.mjs` here enforces both rules for `harness/`.

## File format

Each suite has its own directory, `<suite>/`, which holds:

- `vectors.json`: `{ suite, version, generator: { tool, version, script }, cases[] }`. This is validated against `schema/vector-file.schema.json`. Every case has a unique `id`, a `source` (the publication or spec section), an `input` and an `expected`.
- `case.schema.json`: the exact shape of this suite's cases.

Each suite also has a module in `harness/suites/`, registered in `harness/suites/index.ts`. The module runs one case through the code under test and returns the computed values. `harness/vectors.test.ts` compares them with `expected` in the same way for every suite.

## Suites

| Suite | Status | Content |
|---|---|---|
| `placeholder-sha256` | committed | SHA-256 over published NIST CAVP, FIPS 180-2 and RFC 6234 values. It proves the harness. Generator: `tools/vectors/generate_sha256.py` (CPython `hashlib`, cross-checked against the published digests). |
| `hkdf-derive` | planned | Key derivation |
| `hpke` | planned | HPKE wrapping |
| `jcs` | planned | JSON canonicalisation |
| `aead-envelope` | planned | Envelope hashing, signing and AEAD |
| `stream` | planned | STREAM file encryption |
| `bip340` | planned | Schnorr signatures |
| `nip44` | planned | NIP-44 encryption |
| `eip712` | planned | EIP-712 hashes, including the chain-agnostic AgentCard domain |
| `pairing` | planned | Pairing proof |
| `safety-code` | planned | Safety codes |
| `owner-wrap` | planned | Owner key wrapping |

## Adding a suite

1. Write the generator under `tools/vectors/`. It must not import repository TypeScript. Where published values exist, cross-check against them.
2. Run it once to write `<suite>/vectors.json`. Add `<suite>/case.schema.json`.
3. Add the suite module under `harness/suites/` and register it.
4. Commit the failing tests first (S2), then the implementation. Record the negative control: mutate one vector, and every runtime fails.
