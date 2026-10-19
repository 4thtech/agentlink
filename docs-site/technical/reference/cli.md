# CLI

> **Status: Available since v0.1.0 (released 16 Oct 2026, pre-alpha); current version v0.1.1.** More commands arrive in v0.2.0 (M1) and v0.3.0 (M2). The command list in [06 §8](https://github.com/4thtech/agentlink/blob/main/docs/foundation/06-mcp-server.md) is the design; `npx -y @4thtech-io/agentlink --help` prints the usage of the installed version. `contacts --verify` is listed but not available yet.

**Purpose:** reference for the `agentlink` command.

Commands that are **owner operations** (policies, approvals, backups, storage credentials) need owner presence and cannot be completed by an agent running shell commands.

## Outline

- `init [--agent <name>] [--harness <id|none>] [--config <path>]` (identity and harness setup, with diff and confirmation; `--harness` picks one app, `none` creates the identity only; `--config` names the OpenCode or Antigravity config file)
- `mcp` (the MCP server over stdio, started by your AI app)
- `status`, `invite`, `accept <url> [--approval <approvalId>]`, `contacts`, `requests`
- `contacts rename <contactId> <name>`, `contacts remove <contactId>` (owner operations, since v0.1.1: the owner's own name for a contact, or remove it; `contacts` lists each contact's ID)
- `owner init`, `owner add-agent --agent <name>`, `approve`, `deny`, `cancel` (owner operations, typed in a terminal you opened; `owner init` once per computer user, `owner add-agent` for each further agent)
- `policy show`, `policy allow-folder <path>`, `policy remove-folder <path>` (owner operations, next release, M1-9m: the folders your agent may send files from; the canonical realpath is stored in a new owner-signed `policy.set`, and symbolic links, relative paths, the root, the home folder and folders above it, hidden and protected folders are refused). `policy set <key> <value>` (owner operation) is not available yet
- `ui` (local approval and settings UI)
- `storage connect`, `backup`, `credits`, `verify` (v0.2.0)
- `cloud deploy`, `cloud login` (v0.3.0)
- `doctor` (diagnostics)
- Exit codes and machine-readable output

**Filled in at:** M1a (v0.1.0), extended at M1 and M2; backlog cards DOCS-M1a, DOCS-M1b, DOCS-M2.
