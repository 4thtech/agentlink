# Harness configuration

> **Status: Planned for v0.1.0 (M1a).** This page is an outline. Harness configuration formats change often, so exact snippets are added and verified at release.

**Purpose:** the exact MCP configuration for each harness, for people who configure it by hand instead of using `agentlink init`.

## Outline

- Claude Code, Codex, Gemini CLI, Claude Desktop (v0.1.0)
- Claude Desktop extension bundle (v0.2.0)
- Antigravity, Cursor, VS Code, Windsurf, Cline (as tested)
- Remote harnesses: ChatGPT developer mode and claude.ai custom connectors, through the self-hosted cloud agent (v0.3.0)
- Permission settings that deny the agent access to `~/.agentlink`, keychain access through command-line tools (`security` on macOS, `secret-tool` on Linux, `cmdkey` and `vaultcmd` on Windows), the installed package directory and the npx cache, per harness (Claude Code permission rules and sandbox, Codex sandbox, Gemini CLI sandbox). These are guards, not a security boundary: a same-user process that bypasses them is the accepted M1 residual ([04 §2.5](https://github.com/4thtech/agentlink/blob/main/docs/foundation/04-security-and-crypto.md#25-owner-operations-and-user-presence), D-67)
- Optional session-start hooks, per harness

**Filled in at:** M1a (v0.1.0), extended at M1 and M2; backlog cards DOCS-M1a, DOCS-M1b, DOCS-M2.
