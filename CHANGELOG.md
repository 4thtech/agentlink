# Changelog

All notable changes to AgentLink are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html). How versions, tags and releases work is described in [`docs/process/versioning.md`](docs/process/versioning.md). Until 1.0.0 (the M3 mainnet beta), a minor version may contain breaking changes; each is marked **BREAKING:**.

## [Unreleased]

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
