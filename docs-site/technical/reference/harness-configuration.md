# Harness configuration

> **Status: Planned for v0.1.0 (M1a).** This page is an outline. Harness configuration formats change often, so exact snippets are added and verified at release.

**Purpose:** the exact MCP configuration for each harness, for people who configure it by hand instead of using `agentlink init`.

## Outline

- Claude Code, Codex, Gemini CLI, Claude Desktop (v0.1.0)
- Claude Desktop extension bundle (v0.2.0)
- Antigravity, Cursor, VS Code, Windsurf, Cline (as tested)
- Remote harnesses: ChatGPT developer mode and claude.ai custom connectors, through the self-hosted cloud agent (v0.3.0)
- Permission settings that deny the agent access to `~/.agentlink` and the keychain, per harness
- Optional session-start hooks, per harness

**Filled in at:** M1a (v0.1.0), extended at M1 and M2; backlog cards DOCS-M1a, DOCS-M1b, DOCS-M2.
