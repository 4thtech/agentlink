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
- `policy show`, `policy allow-folder <path>`, `policy remove-folder <path>` (owner operations, next release, M1-9m: the folders your agent may send files from; the canonical realpath is stored in a new owner-signed `policy.set`, and symbolic links, relative paths, the root, the home folder and folders above it, hidden and protected folders, and a folder that contains a protected folder (M1-9m-b, D-99: the refusal names it and suggests a narrower one; compared by realpath and ignoring case) are refused). `policy set <key> <value>` (owner operation) is not available yet
- `policy recover` (owner operation, next release, M1-9m-b, D-100, D-103): repairs a policy that fails closed. It is refused while the policy is valid; it shows only the kind of failure; the owner reviews the full policy it will sign (the stored one when it parses and its signature verifies, after a rollback or a mark mismatch, otherwise the defaults); after `y` and the owner code it signs a complete policy at version max(mark, stored) + 1, above both the stored version mark and the stored policy's version (D-103). `doctor` names it when the policy fails closed
- `verify <proof.json>` (next release, M1-9h): checks a proof file. The file must be inside your proofs folder or inbox folder (a relative path is taken from the current folder; any other place is refused without reading it, D-87). It reads only the official record keeper of a network this release ships, through the address-checked RPC fetch; you configure nothing. It prints the verdict first (`Verified`, `Record only`, never shown as a pass, or `Failed` with the specific reason), then a `Test network` line with the network ID for every test-network proof (a test proof is never shown as a live one), one line per check (the record, who recorded it, receipts, content, owner approval, notices such as D-96), the record and agent IDs, and the disclosed content last, inside the marked untrusted region. It never prints a URL or a key. Exit codes (D-108): `0` verified, `3` record only, `1` does not check out, `4` not checked (file not allowed, too large or unreadable, or the network did not answer), `2` usage
- `credits [--topup]` (next release, M1-9h): your agent ID, your credits in dollars over every proof network, and the price of adding proof; no network or token is named. `--topup` runs the automatic selection (cheapest supported network) and says whether you have enough or how much to add, then, once the pay page is live (the shipped config says not yet, so today it says adding credits is not available), prints the top-up link and a QR code of the agent ID (M1-26-e)
- `doctor` also checks the proof network (next release, M1-9h): how many of the shipped networks answer a block read, as a count only
- `ui` (local approval and settings UI; not available yet), and the passkey option and recovery-kit offer of `init` (not available yet)
- `storage connect`, `backup` (v0.2.0)
- `cloud deploy`, `cloud login` (v0.3.0)
- `doctor` (diagnostics)
- Exit codes and machine-readable output

**Filled in at:** M1a (v0.1.0), extended at M1 and M2; backlog cards DOCS-M1a, DOCS-M1b, DOCS-M2.
