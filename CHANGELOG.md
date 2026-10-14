# Changelog

All notable changes to AgentLink are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html). How versions, tags and releases work is described in [`docs/process/versioning.md`](docs/process/versioning.md). Until 1.0.0 (the M3 mainnet beta), a minor version may contain breaking changes; each is marked **BREAKING:**.

## [Unreleased]

### Added

- Monorepo skeleton (M0-2d): pnpm workspace with Turborepo, strict ESM TypeScript with project references, ESLint, Prettier, Vitest and Changesets; a stub package for every directory in the repository layout; manifest checks (MIT licence, no install scripts) inside `pnpm lint`; and CI strict mode (`.github/ci-strict`), so a missing root script now fails CI. All packages are private stubs and nothing is published yet.
- Architecture boundary guards (M0-10): package layering (which package may import which, no cycles), primitive libraries (`@noble/*`, `@hpke/*`, `nostr-tools`, `viem`, `aws4fetch`) and `crypto.subtle` confined to their packages, Node built-ins confined to `@agentlink/node` and `apps/cli`, and a per-package runtime-dependency allowlist where every entry carries a justification. Enforced twice: ESLint zones (including dynamic `import()`, `require()` and relative paths that leave a package) and `tools/deps-check`, which runs in `pnpm lint` and therefore in `ci-gate`. The policy lives in `tools/deps-check/policy.mjs`.
- Build plan "At a glance" (building blocks, stages, external services) and plain-language explainers on messaging, files and payments under `docs/explainers/`.
- Public documentation source under `docs-site/`: a user guide and technical docs (one GitBook space each, for publishing through Git Sync), organised by Diátaxis. Concept, security and pricing pages describe the published design; every other page is an outline marked planned with the version that fills it in. Upkeep rules in `docs-site/MAINTAINING.md`, a docs pass per milestone (backlog cards DOCS-M1a to DOCS-M3), and a Definition of done rule that a milestone or release is done only when the public docs are updated.
- Process (DOCS-RB): runbooks for every repeatable procedure (`docs/runbooks/`), lessons learned (`docs/lessons/`), a role-based "Start here" map with a time-boxed onboarding track (`docs/README.md`), and a `GEMINI.md` pointer so Gemini CLI loads `AGENTS.md`.

### Changed

- Process (D-57, proposed; amends D-29): public docs are published continuously from `docs-site/` on `main` through GitBook Git Sync (no editing in GitBook), with an honest status line on every page; `docs-site/**` is security class S1; changes to the publishing setup are owner-only; rollback is a revert of the PR.
- Process (D-52): one automated delivery pipeline for every task (develop, independent audit, green required checks, auto-merge). S2 and sensitive paths need only Tali's "merge" in chat, with no non-author GitHub approval. Services (Workers, sites) now deploy to production automatically once staging and smoke tests are green, replacing the owner approval click of D-25 for them; npm `latest` keeps the owner's approval click; `DEPLOY_FREEZE` still halts everything. New `docs/process/delivery-process.md`: roles, 14-step lifecycle, safety nets, owner go-ahead model and definition of done.
- Specification (D-48): files over 12 KB go through a zero-knowledge 4thTech encrypted drop by default (ciphertext only, signed uploads, 7-day expiry, per-agent quotas), so file exchange needs no setup; own storage becomes optional. Resolves D-13 and amends D-05 and core principle 5.
- Specification (D-49): one-click Google Drive, Dropbox and OneDrive storage connectors are planned for the M2 desktop apps, with OAuth tokens kept only in the OS keychain; S3-compatible storage stays the Advanced option.
- Specification (D-50): phased revenue operations: a monthly revenue report from on-chain events in beta, an internal read-only finance dashboard later, and invoices on request through opt-in billing profiles.
- Specification (review IR-D48-1): the encrypted drop uses a dedicated drop signing key, encrypts each file once and sends the ciphertext hash at commit, keeps no request URLs or signatures in logs, and follows `files.deleteAfter` (default: keep until expiry); consumer-connector links are revoked at expiry on a best-effort basis; `apps/drop/**` is S2.
- Specification (D-54): on machines without an OS keychain (containers, WSL, SSH sessions), users can opt in to a passphrase-locked file for the agent's identity, unlocked from a run-time secret file or an environment variable; the keychain stays the default, and approvals still need an owner code typed in the owner's own terminal, or (from M2) the owner's own device. Resolves G-31.
- Specification (D-56): the product name is AgentLink, by 4thTech, with working domain myagentlink.xyz (final after the trademark check); the design brief now covers the full brand system and every surface per platform (desktop apps for macOS, Windows and Linux, cloud agent pages, terminal copy, printed proof records), and `docs/design/claude-design-handoff.md` is the single file to give Claude Design.
- Process (D-51, simplified): agents work under the owner's GitHub account; code-owner review is not required and Denis's approval is optional. S0/S1 pull requests auto-merge when all checks are green; S2 and sensitive-path pull requests merge only after CI, the independent AI review and the owner's explicit go-ahead (a process control, revisited before mainnet).
- Specification (D-53): the MCP tool surface is frozen before 0.1.0 at 13 `agentlink_`-prefixed tools with MCP annotations and `approvalId` on every tool that can need approval; one invite link installs AgentLink and pairs; agents check AgentLink at session start (counts only) and offer a handoff at session end.

## [0.0.1] - 2026-10-12

M0 Foundations: specifications (spec pack v0.3), development and audit process, CI/security workflows, versioning framework, agent instructions; no product code yet.

### Added

- Specification pack under `docs/foundation/`: product, architecture, security and cryptography (invariants I-1 to I-10), OCC v2 contracts, MCP server, SDK/transport/storage, clients, build plan and design brief, with a decision log (D-01 to D-44).
- Development process (orchestrated AI agents, task lifecycle, definition of done), audit rules (security classes S0 to S2, independent reviews) and a sync protocol for collaborators, under `docs/process/`.
- Release and deployment process: continuous delivery to staging and testnet, one owner approval click for production, rollback matrix and `DEPLOY_FREEZE`.
- GitHub Actions workflows for CI, security checks, secret scanning, pull-request hygiene, the review gate and the release pipeline (npm trusted publishing with provenance), all pinned to commit SHAs and dormant until the monorepo skeleton exists.
- Versioning framework (D-43): SemVer 2.0, one product version during beta, milestone-to-version map, npm `next` and `latest` channels, wire-format compatibility table and this changelog.
- Agent instructions (`AGENTS.md` and the per-tool files that point to it) and the backlog of task cards.
- Public repository files: README with status, `LICENSE`, `SECURITY.md`, Renovate configuration and the documentation map (D-44).

### Security

- Audit of the CI and release workflows: actions pinned to full commit SHAs, least-privilege token permissions per job, no untrusted event data in scripts, no long-lived npm token, and publishing only from `main` through GitHub Environments with provenance.

[Unreleased]: https://github.com/4thtech/agentlink/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/4thtech/agentlink/releases/tag/v0.0.1
