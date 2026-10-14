# test-vectors

Canonical test vectors for AgentLink's crypto and EIP-712 code, and the harness that checks them in every runtime the shared packages support (04 §8.2, task M0-9). The vectors are public. The private contracts repo pins a commit of this directory and checks parity (`docs/process/development-process.md` §9.1).

```
pnpm vectors:check
```

This runs `tools/vectors/check.mjs` directly (not through a package script, so no manifest can turn it into a no-op). It runs every suite in five runtimes: Node (Vitest), Chromium, Firefox and WebKit (Vitest browser mode on Playwright), and workerd (`@cloudflare/vitest-plugin`, the renamed `@cloudflare/vitest-pool-workers`). It fails unless every runtime passes every case. Install the browsers once with `pnpm exec playwright install chromium firefox webkit`.

## Rules

1. **An independent generator produces the vectors.** The generator is a Python script directly under `tools/vectors/` that does not use the TypeScript code under test, for example Python's `hashlib`, `openssl`, or a reference implementation in another language. Each file records it in `generator.script`, and the libraries it used, at their pinned versions, in `generator.tool`. Every generator supports `--check [FILE]`, which writes nothing and exits non-zero unless FILE equals its output byte for byte (only `generator.version`, the Python version, may differ). CI runs `node tools/vectors/check-generators.mjs`, which does that for every committed `vectors.json`.
   - The protocol generators (M1-1h) use well-known Python libraries, pinned with hashes in `tools/vectors/requirements.txt`: `cryptography`, `coincurve`, `pycryptodome`, `pyhpke` and `rfc8785`. They share `tools/vectors/vectorlib.py`. Where published vectors exist, the generator reproduces them and refuses to write on any difference. Copies of published vector files live in `tools/vectors/sources/`, checked against a recorded SHA-256.
   - Set up once, outside the repository or in the ignored `.venv-vectors/`:
     ```
     python3.12 -m venv .venv-vectors
     .venv-vectors/bin/pip install --require-hashes --only-binary=:all: --no-deps -r tools/vectors/requirements.txt
     VECTORS_PYTHON=.venv-vectors/bin/python node tools/vectors/check-generators.mjs
     ```
2. **Vectors are committed, and tests only read them.** No test writes or regenerates a vector file. `pnpm vectors:check` fails if a run creates, changes or deletes anything under `test-vectors/`, and CI checks the same with `git status` afterwards.
3. **Vectors change only together with a spec change.** Bump the file's `version` in the same PR.
4. **Every runtime reports its own identity.** Each project in `vitest.config.ts` states the runtime it expects. `harness/runtime.ts` reads the actual runtime from the engine (`navigator.userAgent`, `process.versions.node`, workerd's `WebSocketPair`). A project that silently falls back to Node fails its identity test. `tools/vectors/check.mjs` then requires a passing identity test and a passing result for every committed case in each of `node`, `chromium`, `firefox`, `webkit` and `workerd`. So dropping a runtime from the config also fails the check.
5. **Suites use only what all runtimes have.** They use WebCrypto, `TextEncoder` and `Uint8Array`, and no Node built-ins. They reach crypto through `@agentlink/crypto` (04 §8.1). `eslint.config.mjs` here enforces both rules for `harness/`.

## File format

Each suite has its own directory, `<suite>/`, which holds:

- `vectors.json`: `{ suite, version, generator: { tool, version, script }, cases[] }`. This is validated against `schema/vector-file.schema.json`. Every case has a unique `id`, a `source` (the publication or spec section), an `input` and an `expected`.
- `case.schema.json`: the exact shape of this suite's cases.

Each suite also has a module in `harness/suites/`, registered in `harness/suites/index.ts`, or it is **pending**. The module runs one case through the code under test and returns `{ field, actual }` for every field of the case's `expected`. It never supplies expected values. `harness/compare.ts` reads them from the committed vector and requires exactly the expected fields, no more and no fewer, in the same way for every suite. A suite with no cases fails.

## Pending suites

Vectors can land before the code they test (M1-1h, tests first). Such a suite is listed in `pendingSuites` in `harness/suites/index.ts` with the card that will implement it. It runs no cases: every runtime records a passing `pending` marker instead, and `pnpm vectors:check` lists it as pending and does not fail. It fails closed:

- A suite in `pendingSuites` that also has a module fails, so the card that adds the module removes the entry, and from then on every case must pass in every runtime.
- A runtime without the pending marker still needs a passing result for every case, and a suite with both a marker and case results fails (`tools/vectors/rules.mjs`).
- A `pendingSuites` entry without a committed vector file fails.

## Suites

| Suite | Status | Content |
|---|---|---|
| `placeholder-sha256` | committed | SHA-256 over published NIST CAVP, FIPS 180-2 and RFC 6234 values. It proves the harness. Generator: `tools/vectors/generate_sha256.py` (CPython `hashlib`, cross-checked against the published digests). |
| `jcs` | pending (M1-1a) | RFC 8785: the RFC's samples and Appendix B numbers, AgentLink shapes; lone surrogates, NaN and Infinity rejected |
| `tagged-hash` | pending (M1-1a) | BIP-340 tagged hashes under `agentlink/envelope/v1`, `agentlink/owner-action/v1` and BIP-340 tags |
| `hkdf-derive` | pending (M1-1b) | RFC 5869; 04 §2.1 derivation (labels × epochs 0–2, counters, u32/u8 bounds); public identities (EIP-55 address, x-only keys, X25519 and `kid`) |
| `bip340` | pending (M1-1b) | The 19 official BIP-340 vectors (sign and verify) |
| `hpke` | pending (M1-1c) | The CFRG RFC 9180 vector for X25519/HKDF-SHA256/AES-256-GCM; 04 §3.3 CEK wrap with fixed ephemeral keys and its rejections |
| `aead-envelope` | pending (M1-1c) | 04 §3.1 envelope hash, AAD, payload AEAD, envelope signature, and changes to covered fields |
| `eip712` | pending (M1-1e) | The EIP-712 "Ether Mail" example; AgentCard under the chain-agnostic domain, nameHash/relaysHash, card signatures |
| `pairing` | pending (M1-1f) | RFC 4231 HMAC-SHA256 (the pairing construction waits for spec answers; the safety code for G-28) |
| `owner-wrap` | pending (M1-1f) | Argon2id: RFC 9106 and the owner-wrap and KeyStore parameters (the `ALKO` blob waits for its format) |
| `keystore-file` | pending (M1-1f) | 04 §2.8 `ALKS` v1 files (secretKind 2), code and passphrase normalisation, every format refusal |
| `nip44` | pending (M1-1g) | The official NIP-44 v2 vectors |
| `owner-action` | pending (M1-7d) | 04 §2.5.1 `SignedOwnerAction` (`agent.revoke`) signing and rejection of every non-canonical form |
| `stream` | planned (M1-1i) | STREAM file encryption |

## Adding a suite

1. Write the generator under `tools/vectors/`, with `--write` and `--check [FILE]`. It must not import repository TypeScript. Where published values exist, cross-check against them.
2. Run it once to write `<suite>/vectors.json`. Add `<suite>/case.schema.json`.
3. Add the suite module under `harness/suites/` and register it.
4. If the code under test does not exist yet, list the suite in `pendingSuites` with its card instead of adding a module. Otherwise commit the failing tests first (S2), then the implementation. Record the negative control: mutate one vector, and every runtime fails. Step-by-step: runbook RB-06 (`docs/runbooks/test-vectors.md`).
