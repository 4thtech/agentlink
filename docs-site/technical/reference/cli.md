# CLI

> **Status: Planned for v0.1.0 (M1a)**, with more commands in v0.2.0 (M1) and v0.3.0 (M2). This page is an outline; the command list in [06 §8](https://github.com/4thtech/agentlink/blob/main/docs/foundation/06-mcp-server.md) is the planned design and may change.

**Purpose:** reference for the `agentlink` command.

Commands that are **owner operations** (policies, approvals, backups, storage credentials) need owner presence and cannot be completed by an agent running shell commands.

## Outline

- `init` (identity and harness setup, with diff and confirmation)
- `status`, `invite`, `accept`, `contacts`
- `approve`, `deny`, `policy` (owner operations)
- `ui` (local approval and settings UI)
- `storage connect`, `backup`, `credits`, `verify` (v0.2.0)
- `cloud deploy`, `cloud login` (v0.3.0)
- `doctor` (diagnostics)
- Exit codes and machine-readable output

**Filled in at:** M1a (v0.1.0), extended at M1 and M2; backlog cards DOCS-M1a, DOCS-M1b, DOCS-M2.
