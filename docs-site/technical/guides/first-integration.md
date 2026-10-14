# Your first integration

> **Status: Planned for v0.2.0 (M1).** This page is an outline; no package is published yet. The `@agentlink/*` libraries first appear with v0.1.0 (M1a), but their API is not stable before 1.0.0.

**Purpose:** a tutorial that takes a developer from an empty project to two programmatic agents that pair, exchange a message and, from v0.2.0, notarize it on a testnet.

## Outline

- Prerequisites (Node.js LTS; a test relay or public relays)
- Install `@agentlink/core` and `@agentlink/node`
- Create two identities with an in-memory or keychain `KeyStore`
- Create and accept an invite; compare safety codes
- Send and receive a typed message; handle untrusted content correctly
- Notarize on a testnet with free faucet credits, and export a proof pack (v0.2.0)
- Pass an `appId` to earn integrator fees (M3)
- Next steps: the [SDK packages](../reference/sdk-packages.md) reference

**Filled in at:** M1 (v0.2.0), backlog card DOCS-M1b.
