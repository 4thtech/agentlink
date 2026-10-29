# Repository reference — stack, layout, commands, testing

Moved out of `AGENTS.md` to keep the auto-loaded context lean. Open this when you need it.

## Stack

TypeScript (strict, ESM) · pnpm + Turborepo · viem (not ethers) · @noble/* + @hpke/core · nostr-tools · official MCP TypeScript SDK · Cloudflare Workers / Durable Objects / R2 · SQLite (better-sqlite3) · Vitest · Playwright · Miniflare. Contracts are in the separate private `occ-v2-contracts` repo (Foundry).

Shared packages must run in Node LTS, browsers and Workers: use `globalThis.crypto`, `fetch`, `Uint8Array`; no Node built-ins outside `@4thtech-io/node` and `apps/cli`.

## Repository layout

```
agentlink/
├─ AGENTS.md                     # this file (canonical agent instructions)
├─ CLAUDE.md                     # imports AGENTS.md for Claude Code
├─ docs/foundation/              # specs — source of truth (01 and 09 are kept private)
├─ docs/process/                 # development process, audit rules, release & deployment, CI/CD, backlog
├─ packages/
│  ├─ types/                     # shared types + zod schemas
│  ├─ log/                       # redacting logger + secret-canary test helper (zero dependencies)
│  ├─ crypto/                    # key derivation, HPKE, AES-GCM, STREAM, JCS, BIP-340, EIP-712
│  ├─ occ-v2-abi/                # vendored contracts release (ABIs, testnet addresses, manifest; private, D-83)
│  ├─ chain/                     # viem clients, OCC v2 bindings (ABIs from @4thtech-io/occ-v2-abi)
│  ├─ transport-nostr/           # NIP-17/59 gift wraps, relay pool, sync
│  ├─ storage/                   # inline, drop and S3 (aws4fetch) adapters; Drive/Dropbox/OneDrive connectors (M2)
│  ├─ core/                      # AgentLinkClient, policies, approvals, Store interface (KeyStore types: @4thtech-io/crypto, G-2)
│  ├─ mcp-tools/                 # runtime-agnostic MCP tool handlers (moved from apps/cli/src/tools/, M2-3t)
│  ├─ node/                      # keychain KeyStore, SQLite Store, local approval server
│  └─ ui/                        # shared React components (design system)
├─ apps/
│  ├─ cli/                       # @4thtech-io/agentlink (CLI + MCP stdio + local UI bundle)
│  ├─ console/                   # owner console PWA
│  ├─ verify/                    # verify page
│  ├─ invite/                    # invite landing
│  ├─ cloud-agent/               # Worker + Durable Object + remote MCP
│  ├─ submitter/                 # Worker
│  └─ drop/                      # encrypted drop Worker + R2 (D-48)
├─ skills/agentlink/SKILL.md     # harness skill / AGENTS.md snippet
├─ test-vectors/                 # canonical crypto + EIP-712 vectors (contracts repo checks parity)
└─ e2e/                          # multi-agent end-to-end tests
```

## Commands

```
pnpm install
pnpm build            # turbo build
pnpm test             # unit tests (all packages); packages/types also runs in Chromium, Firefox, WebKit and workerd; crypto, transport-nostr, chain and mcp-tools also run their `*.workerd.test.ts` smoke tests in workerd, M2-3t-w (needs `pnpm exec playwright install chromium firefox webkit` once; `pnpm test:node` inside the package runs Node only)
pnpm test:e2e         # multi-agent end-to-end (requires testnet RPC + relays)
pnpm lint && pnpm typecheck
pnpm vectors:check    # crypto + EIP-712 test vectors across runtimes
pnpm verify           # the local gate: what CI's `checks` runs for the packages your change affects (W4-VERIFY)
```

### `pnpm verify` (the local gate)

Run it before you push. It lists the files you changed (committed against the merge base with `origin/wave-4`, or `origin/main` when the branch is not on `wave-4`, plus uncommitted and untracked files; `--base <ref>` overrides) and picks the packages with `tools/ci/select-affected.mjs`, the same rules as CI. Then, stopping at the first red step:

1. one `turbo run build typecheck lint check test` call with the affected `--filter`s (no filter on a global trigger or an empty diff);
2. `prettier --check` on the changed files (prose and `.prettierignore` paths are skipped);
3. `node tools/deps-check/index.mjs`;
4. the journey e2e (`CI=1`, `e2e/test/journey` and `test/local-app-wave3.test.ts`, whichever exist) when `@4thtech-io/e2e` is selected.

It ends with a block of at most 30 lines (base, scope, each step with its time, PASS or FAIL): paste it into the PR. A change under `tools/`, `.github/`, a shared package or a root file is a full run, as in CI. Browser tests run in Chromium only (`VERIFY_BROWSERS=chromium`, read by `packages/types/vitest.config.ts`; CI never sets it); `pnpm verify --browsers all` keeps the full matrix. It does not replace the CI-only jobs (vectors, keychain, relays, MinIO, bundle check).

## Architecture boundary guards (M0-10)

One policy file, `tools/deps-check/policy.mjs`, says which package may import which, which package may use each crypto library (04 §8.1), where Node built-ins and `crypto.subtle` are allowed, and the runtime-dependency allowlist per package. It is read by `eslint.config.mjs` (zones plus the local `boundaries/no-bypass` rule for dynamic `import()`, `require()`, relative paths that leave a package and `crypto.subtle`) and by `tools/deps-check`, which scans manifests and sources and runs inside `pnpm lint` (turbo task `check`), therefore in `ci-gate`. An inline `eslint-disable` cannot switch the boundary off: deps-check fails on it.

Changing the policy is a reviewed S1 change. A new dependency needs an `external` entry with a `reason` line; a new package needs a `ZONES` entry; a widened layering or library zone needs a justification in the PR.

## Testing expectations

- Crypto, policy engine and anything that signs: tests first, including test vectors.
- Every MCP tool: schema test + behaviour test for each `status` value.
- New behaviour in core: unit tests plus an e2e scenario when it crosses agents.
- Status docs (single source): `docs/status.yaml` holds the milestone, phase, per-area component states with PR refs, the testnet deploy state and the version. `tools/docs-status` renders it into marked blocks (`<!-- NAME:start -->` … `<!-- NAME:end -->`) in `README.md` (Status, Roadmap), `docs-site/technical/project/status-and-roadmap.md` and, `knowledge/agentlink-overview.md`. `node tools/docs-status/index.mjs` regenerates; `node tools/docs-status/index.mjs --check` (also part of `pnpm lint`, via the tools `check` script) fails when a block differs from the source. The same tool prints the M0/M1 (M1a, M1b)/M2/M3 card counts of `docs/process/backlog.md` on demand with `node tools/docs-status/index.mjs --counts` (not the §1 example, split parents or cards with a "later" Phase). The counts are not committed, because a stored count goes stale whenever another PR merges first; `--check` fails if a `backlog-counts` block is committed again. The reader is a small YAML subset parser (`tools/docs-status/yaml.mjs`), so there is no YAML dependency.
- Test timeout policy (M0-10e): every `packages/*` has a `vitest.config.ts` with `testTimeout: 20_000` (the 5 s Vitest default flakes on loaded CI runners); `tools/` uses the same value. A longer limit is allowed where measured (crypto Argon2id files 60 s, types 30 s); never lower one. A new package copies the config of an existing one. (A shared base file cannot be imported: the boundary guard forbids a relative import that leaves a package.)
