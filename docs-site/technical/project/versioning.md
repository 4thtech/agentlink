# Versioning and changelog

> **Status: Current.** Source: [versioning.md](https://github.com/4thtech/agentlink/blob/main/docs/process/versioning.md). Release history: [CHANGELOG.md](https://github.com/4thtech/agentlink/blob/main/CHANGELOG.md) (Keep a Changelog) and GitHub Releases.

## Product version

AgentLink follows SemVer 2.0. During the beta, all public packages (the CLI and MCP server, the `@agentlink/*` libraries and, from M2, the desktop apps) share one product version, tagged `v<version>` with a GitHub Release.

| Milestone | Version | Meaning |
|---|---|---|
| M0 Foundations | 0.0.x | Specs, process and CI; no packages |
| M1a | 0.1.0 | First npm release: pair and talk |
| M1 gate | 0.2.0 | Local beta on testnets |
| M2 | 0.3.0 | Console, desktop apps, self-host |
| M3 mainnet beta | 1.0.0 | First strict SemVer promise |

Before 1.0.0 a minor version may contain breaking changes; each is marked **BREAKING** in the changelog. Prereleases go to the npm `next` tag; only milestone versions and their patches reach `latest`.

## Format versions

Wire and storage formats are versioned independently of the product:

| Format | Version | First shipped in (planned) |
|---|---|---|
| Envelope | v1 | 0.1.0 |
| Payload and terms | v1 | 0.1.0 |
| Agent card | v1 | 0.1.0 |
| Invite | v1 | 0.1.0 |
| Proof pack | v1 | 0.2.0 |
| OCC v2 records and receipts | EIP-712 domain `"2"` | 0.2.0 (testnets) |

Unknown versions are refused visibly, never guessed at. Proof packs and receipts are long-lived evidence, so verification reads every pack version ever issued. Deprecations are announced one minor version ahead.

## This documentation

The docs on this site describe the latest release and mark anything not yet released as planned. Versioned copies per release are planned from 1.0.0; see [MAINTAINING.md](https://github.com/4thtech/agentlink/blob/main/docs-site/MAINTAINING.md).
