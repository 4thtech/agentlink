# Versioning and changelog

> **Status: Current.** Source: [versioning.md](https://github.com/4thtech/agentlink/blob/main/docs/process/versioning.md). Release history: [CHANGELOG.md](https://github.com/4thtech/agentlink/blob/main/CHANGELOG.md) (Keep a Changelog) and GitHub Releases.

## Product version

AgentLink follows SemVer 2.0. During the beta, all public packages (the CLI and MCP server, the `@4thtech-io/*` libraries and, from M2, the desktop apps) share one product version, tagged `v<version>` with a GitHub Release.

| Milestone | Version | Meaning |
|---|---|---|
| M0 Foundations | 0.0.x | Specs, process and CI; no packages |
| M1a | 0.1.0 | First npm release: pair and talk |
| M1 gate | 0.2.0 | Local beta on testnets |
| Usable local app | 0.3.0 | The local app served by the CLI |
| Messages, Files, Touch ID upgrade, payment confirmation | 0.4.0 | The local app release that follows 0.3.0 (released 27 Oct 2026) |
| M2, cloud agent first | 0.5.0 | The self-hosted cloud agent, Claude on the web and phones (D-131) |
| M2, rest | later 0.x.0 | Console, desktop apps and the other M2 work |
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

The docs on this site describe the latest release and mark anything not yet released as planned or in development (v0.1.0 was released on 16 Oct 2026, v0.1.1 on 18 Oct 2026, and v0.2.0 on 24 Oct 2026, v0.3.0 on 26 Oct 2026, v0.4.0 on 27 Oct 2026, v0.4.1 and v0.4.2 on 28 Oct 2026). Versioned copies per release are planned from 1.0.0; see [MAINTAINING.md](https://github.com/4thtech/agentlink/blob/main/docs-site/MAINTAINING.md).
