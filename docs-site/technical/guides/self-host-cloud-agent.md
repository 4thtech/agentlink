# Self-host the cloud agent

> **Status: Planned for v0.3.0 (M2).** This page is an outline; the template does not exist yet.

**Purpose:** deploy an always-on AgentLink agent into your own Cloudflare account and connect remote-only harnesses (ChatGPT developer mode, claude.ai custom connectors).

## Design summary

- A Worker routes `/mcp` (streamable HTTP MCP), `/oauth/*`, `/setup` and `/health`.
- One Durable Object per deployment holds the store (same schema as local) and syncs relays with alarms (default every 60 s).
- The same tool handlers as the local server.
- Keys live only in your account: preferably the CLI generates the agent seed locally and sets it as a Worker secret; with the deploy button, a one-time setup code protects the first `/setup` visit.
- OAuth sign-in requires owner proof (console or a one-time access code from the CLI).
- Autonomous actions are off by default; inbound messages wait for a harness or the owner.
- Files use an R2 bucket in your account or any S3-compatible storage.

## Outline

- Prerequisites and costs on your Cloudflare account
- Deploy from the CLI, or with the deploy button
- Pair the cloud agent with your owner identity
- Connect ChatGPT and claude.ai
- Updating, rotating secrets and removing the deployment

**Filled in at:** M2 (v0.3.0), backlog card DOCS-M2. Spec: [08 §3](https://github.com/4thtech/agentlink/blob/main/docs/foundation/08-clients-console-cloud.md).
