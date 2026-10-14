# Repository reference — stack, layout, commands, testing

Moved out of `AGENTS.md` to keep the auto-loaded context lean. Open this when you need it.

## Stack

TypeScript (strict, ESM) · pnpm + Turborepo · viem (not ethers) · @noble/* + @hpke/core · nostr-tools · official MCP TypeScript SDK · Cloudflare Workers / Durable Objects / R2 · SQLite (better-sqlite3) · Vitest · Playwright · Miniflare. Contracts are in the separate private `occ-v2-contracts` repo (Foundry).

Shared packages must run in Node LTS, browsers and Workers: use `globalThis.crypto`, `fetch`, `Uint8Array`; no Node built-ins outside `@agentlink/node` and `apps/cli`.

## Repository layout

```
agentlink/
├─ AGENTS.md                     # this file (canonical agent instructions)
├─ CLAUDE.md                     # imports AGENTS.md for Claude Code
├─ docs/foundation/              # specs — source of truth (01 and 09 are kept private)
├─ docs/process/                 # development process, audit rules, release & deployment, CI/CD, backlog
├─ packages/
│  ├─ types/                     # shared types + zod schemas
│  ├─ crypto/                    # key derivation, HPKE, AES-GCM, STREAM, JCS, BIP-340, EIP-712
│  ├─ chain/                     # viem clients, OCC v2 bindings (ABIs from @agentlink/occ-v2-abi)
│  ├─ transport-nostr/           # NIP-17/59 gift wraps, relay pool, sync
│  ├─ storage/                   # inline, drop and S3 (aws4fetch) adapters; Drive/Dropbox/OneDrive connectors (M2)
│  ├─ core/                      # AgentLinkClient, policies, approvals, KeyStore/Store interfaces
│  ├─ node/                      # keychain KeyStore, SQLite Store, local approval server
│  └─ ui/                        # shared React components (design system)
├─ apps/
│  ├─ cli/                       # @4thtech/agentlink (CLI + MCP stdio + local UI bundle)
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
pnpm test             # unit tests (all packages)
pnpm test:e2e         # multi-agent end-to-end (requires testnet RPC + relays)
pnpm lint && pnpm typecheck
pnpm vectors:check    # crypto + EIP-712 test vectors across runtimes
```

## Testing expectations

- Crypto, policy engine and anything that signs: tests first, including test vectors.
- Every MCP tool: schema test + behaviour test for each `status` value.
- New behaviour in core: unit tests plus an e2e scenario when it crosses agents.

