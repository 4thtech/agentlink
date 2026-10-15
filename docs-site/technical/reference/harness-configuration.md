# Harness configuration

> **Status: Planned for v0.1.0 (M1a).** Nothing is published to npm yet. The configuration below is what `agentlink init` writes in the current source. Claude Desktop, other harnesses and remote harnesses are planned for later releases and are not covered here.

**Purpose:** the exact MCP configuration for Claude Code, Codex and Gemini CLI, for people who configure it by hand instead of using `agentlink init`, and the harness permission settings that keep an agent away from AgentLink's private files.

## How `agentlink init` configures a harness

`npx -y @4thtech/agentlink init` detects Claude Code, Codex and Gemini CLI, prints the exact diff of each config file, and writes it only after confirmation. In an interactive terminal it asks `y/N` for each file. Run by an agent (no terminal, or a harness marker set), it prints the diff and a one-time confirmation code, writes nothing, and `init --confirm <code>` then writes exactly those changes. The code is a hash of the shown changes, so it stops matching if they change. This is transparency, not a security boundary: an agent with a shell can edit its own harness config anyway ([06 §7](https://github.com/4thtech/agentlink/blob/main/docs/foundation/06-mcp-server.md#7-harness-installation)).

An existing `agentlink` entry that differs is left alone. Existing config is backed up before it is changed. `init` never writes an owner secret.

## Configuration by harness

Each harness runs `npx -y @4thtech/agentlink mcp` as a stdio server. A non-default agent adds `--agent <name>` to `args`.

### Claude Code

User scope, in `~/.claude.json`. Not written by `init` when `CLAUDE_CONFIG_DIR` is set.

```json
{
  "mcpServers": {
    "agentlink": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@4thtech/agentlink", "mcp"],
      "env": {}
    }
  }
}
```

Equivalent command: `claude mcp add --transport stdio --scope user agentlink -- npx -y @4thtech/agentlink mcp`.

Sources: [Claude Code MCP](https://code.claude.com/docs/en/mcp) (`claude mcp add [options] <name> -- <command> [args...]`, user scope stored in `~/.claude.json`, stdio entry shape).

### Codex (CLI, IDE extension, Codex in the ChatGPT desktop app)

`~/.codex/config.toml`:

```toml
[mcp_servers.agentlink]
command = "npx"
args = ["-y", "@4thtech/agentlink", "mcp"]
```

Equivalent command: `codex mcp add agentlink -- npx -y @4thtech/agentlink mcp`. `init` writes the file itself, as a diff you confirm, and does not call `codex mcp add`. `CODEX_HOME` is not followed.

Sources: [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) (`codex mcp add <server-name> -- <stdio server-command>`; `[mcp_servers.<server-name>]` with `command` and `args`).

### Gemini CLI

User settings, `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "agentlink": {
      "command": "npx",
      "args": ["-y", "@4thtech/agentlink", "mcp"]
    }
  }
}
```

`gemini mcp add [options] <name> <commandOrUrl> [args...]` also exists, but its handling of a leading `-y` in the arguments is not documented, so edit the file (or let `init` do it). Do not set `"trust": true` for this server: it removes every confirmation prompt for its tools.

Sources: [Gemini CLI MCP servers](https://geminicli.com/docs/tools/mcp-server/) (`mcpServers` shape, `gemini mcp add [options] <name> <commandOrUrl> [args...]` with `-s, --scope`, `trust` semantics).

## Default message network

Messages travel over public Nostr relays that see only ciphertext (I-3). The default set, in this order, is `wss://nos.lol`, `wss://relay.primal.net`, `wss://relay.snort.social` and `wss://nostr.mom` (D-75). The list lives in one place, `DEFAULT_RELAYS` in `@agentlink/transport-nostr`. Changing an agent's relay list is not available in v0.1.0.

## Tools and approval prompts

MCP tool names are `agentlink_*`. Harnesses show them under the server name, for example `mcp__agentlink__agentlink_status` in Claude Code. The annotations are advisory; policies and approvals are enforced in the core whatever the harness allows ([06 §2.0](https://github.com/4thtech/agentlink/blob/main/docs/foundation/06-mcp-server.md#20-tool-surface-d-53-d-55-frozen-at-010)).

| Tool | Read-only | Recommended harness setting |
|---|---|---|
| `agentlink_status`, `agentlink_list_contacts`, `agentlink_get_approval` | yes | May be auto-allowed. They send nothing and change nothing |
| `agentlink_inbox` | no | Ask. It marks messages read and puts other agents' text into the session |
| `agentlink_create_invite` | no | Ask, or allow if you accept that an invite is created on request. Nothing leaves the device until you share the link |
| `agentlink_send`, `agentlink_accept_invite` | no | Ask |
| `agentlink_propose_terms`, `agentlink_respond_to_terms` | no | Ask. Accepting terms is a commitment and also needs your owner approval by default |

Never auto-allow, by tool rule or by running them through a shell rule, any of the owner commands `agentlink approve`, `deny`, `cancel`, `owner` and `policy`. No MCP tool can approve, change rules or export keys (I-4), so the only way an agent approves its own commitments is by getting hold of the owner code (see the residual risk below).

## Permission settings that keep an agent away from AgentLink's private files

These are guards, not a security boundary. A harness rule matches command text or file paths. A script can open a file or call the keychain API without naming it, so a rule can be bypassed by an agent that runs as your OS user ([04 §2.5](https://github.com/4thtech/agentlink/blob/main/docs/foundation/04-security-and-crypto.md#25-owner-operations-and-user-presence), G-1, D-67).

What to cover:

- `~/.agentlink` (local database and agent config);
- keychain access through command-line tools: `security` (macOS), `secret-tool` (Linux), `cmdkey` and `vaultcmd` (Windows);
- the installed package directory and the npx cache;
- writes to what runs when you type `agentlink` or `npx`: shell startup files, `~/.npmrc` and user `PATH` directories.

**Order.** Install and run `init` first, then add the rules. The harness starts the AgentLink server itself, outside its Bash tool and outside the Claude Code sandbox, so the rules below do not stop it. They can stop an agent-run `init` (it writes `~/.claude.json`, and the sandbox treats that file as protected) and `npx` itself (the npx cache is write-denied).

### Claude Code

Settings in `~/.claude/settings.json`. Rule syntax: `~/` is your home folder, `//` starts an absolute path, and an `Edit` rule covers every built-in file-writing tool. Read and Edit rules also apply to file commands Claude Code recognizes in Bash (`cat`, `sed`, redirections) but not to a script that opens files itself ([permissions](https://code.claude.com/docs/en/permissions)).

```json
{
  "permissions": {
    "deny": [
      "Read(~/.agentlink/**)",
      "Edit(~/.agentlink/**)",
      "Bash(security *)",
      "Bash(secret-tool *)",
      "Bash(cmdkey *)",
      "Bash(vaultcmd *)",
      "Edit(~/.npm/_npx/**)",
      "Edit(//<output of npm root -g>/@4thtech/agentlink/**)",
      "Edit(~/.claude/settings.json)",
      "Edit(~/.zshrc)",
      "Edit(~/.zprofile)",
      "Edit(~/.bashrc)",
      "Edit(~/.bash_profile)",
      "Edit(~/.profile)",
      "Edit(~/.config/fish/**)",
      "Edit(~/.npmrc)",
      "Edit(~/.local/bin/**)",
      "Bash(agentlink approve *)",
      "Bash(agentlink deny *)",
      "Bash(agentlink cancel *)",
      "Bash(agentlink owner *)",
      "Bash(agentlink policy *)"
    ]
  }
}
```

Adjust it to your system:

- Keep the keychain rule for your system (`security` on macOS, `secret-tool` on Linux, `cmdkey` and `vaultcmd` on Windows); the others are harmless.
- The `Edit(//...)` line is for a global install. Replace the placeholder with the output of `npm root -g`, starting with `//` (for example `//usr/local/lib/node_modules/@4thtech/agentlink/**`).
- Add `Edit(<npm global prefix>/bin/**)` as an absolute path (`npm prefix -g`).
- On Windows, the npx cache is `Edit(~/AppData/Local/npm-cache/_npx/**)` and the PowerShell profile is `Edit(~/Documents/PowerShell/**)`.
- A `Bash(...)` rule matches the command text only, so `npx -y @4thtech/agentlink approve ...` is not covered by the `agentlink approve` lines. Those commands refuse to run from a terminal an AI app controls anyway; the rules add a second guard, not a boundary.
- The last five rules stop an agent from running owner commands in its own shell. Owner commands also refuse when no terminal is attached or a harness marker is set. Both are guards ([06 §8](https://github.com/4thtech/agentlink/blob/main/docs/foundation/06-mcp-server.md#8-cli-commands)).

On macOS, Linux and WSL2, also turn on the sandbox, which the operating system enforces for every shell command, including scripts. The Read and Edit rules above cover only Claude Code's file tools. `sandbox.filesystem.denyRead` and `denyWrite` are enforced for Bash subprocesses ([sandboxing](https://code.claude.com/docs/en/sandboxing)); the sandbox does not run on native Windows.

```json
{
  "sandbox": {
    "enabled": true,
    "filesystem": {
      "denyRead": ["~/.agentlink"],
      "denyWrite": [
        "~/.agentlink",
        "~/.npm/_npx",
        "~/.zshrc",
        "~/.zprofile",
        "~/.bashrc",
        "~/.bash_profile",
        "~/.profile",
        "~/.config/fish",
        "~/.npmrc",
        "~/.local/bin"
      ]
    }
  }
}
```

Add the global package directory and the npm global `bin` directory to `denyWrite` as absolute paths. The sandbox also leaves Claude Code's own settings files write-protected.

Allow the read-only tools without a prompt if you wish, by adding `"permissions": { "allow": ["mcp__agentlink__agentlink_status", "mcp__agentlink__agentlink_list_contacts", "mcp__agentlink__agentlink_get_approval"] }`. Allow rules for MCP tools may use a tool-name glob only after a literal `mcp__<server>__` prefix.

### Codex

Codex has no per-path deny in `sandbox_mode`. Its permission profiles (in beta) can deny both reads and writes under a path, on macOS, Linux, WSL and native Windows. A profile cannot be combined with `sandbox_mode` or `[sandbox_workspace_write]`: use one system, not both ([permissions](https://learn.chatgpt.com/docs/permissions), [approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security)).

```toml
default_permissions = "agentlink-guard"

[permissions.agentlink-guard.filesystem]
":minimal" = "read"
"~/.agentlink" = "deny"
"~/.npm/_npx" = "deny"
"~/.zshrc" = "deny"
"~/.zprofile" = "deny"
"~/.bashrc" = "deny"
"~/.bash_profile" = "deny"
"~/.profile" = "deny"
"~/.config/fish" = "deny"
"~/.npmrc" = "deny"
"~/.local/bin" = "deny"
```

This is a starting point: `:minimal` grants read access to platform paths only, so check what a profile needs for your own projects (the docs describe how a profile is extended, for example from the workspace profile) before relying on it. `deny` blocks writes and reads, which is stricter than the Claude Code write-only rules for the shell files. Add the global package directory and npm `bin` directory as absolute paths. Codex has no command-name deny for `security` or `secret-tool`; the profile limits file access only.

Prompt for AgentLink tools in the server's table, so every call asks. `prompt` asks for every tool; the read-only ones can be switched to `approve`:

```toml
[mcp_servers.agentlink]
command = "npx"
args = ["-y", "@4thtech/agentlink", "mcp"]
default_tools_approval_mode = "prompt"

[mcp_servers.agentlink.tools.agentlink_status]
approval_mode = "approve"
```

### Gemini CLI

Gemini CLI's sandbox (`gemini -s`, `GEMINI_SANDBOX`, or `"tools": {"sandbox": true}` in settings) confines writes to the project directory by default on macOS and the container sandbox sees only the project. Its documentation does not describe a way to deny reads or writes of a specific host path such as `~/.agentlink`, so for Gemini CLI the host-path guard is not available. Use the container sandbox, and treat the residual risk below as fully open ([sandbox](https://geminicli.com/docs/cli/sandbox/)).

The policy engine can deny shell commands by prefix. User policies are TOML files in `~/.gemini/policies/` ([policy engine](https://geminicli.com/docs/reference/policy-engine/)):

```toml
[[rule]]
toolName = "run_shell_command"
commandPrefix = ["security ", "secret-tool ", "agentlink approve", "agentlink deny", "agentlink cancel", "agentlink owner", "agentlink policy"]
decision = "deny"
priority = 500
denyMessage = "Run this yourself, in your own terminal."
```

Leave MCP tool confirmation on (never set `trust: true`). Gemini CLI asks before an MCP tool runs, and offers "always allow" per tool or per server; choose the per-tool option only for `agentlink_status`.

## Residual risk for agents that run as your user

An agent that can run any shell command as the same operating-system user is outside what software can fully fence off. This applies to all three harnesses, and the permission settings above only make it harder:

- It could change the installed package, the npx cache, or what your shell runs when you type `agentlink` or `npx` (startup files, aliases, `PATH` folders, `~/.npmrc`). The next owner step you do would then give your owner code to the changed program, or sign a different action from the one shown, even in a terminal you opened.
- It could read process memory or the clipboard while you type the owner code, or imitate the owner prompt in a fake terminal or page.
- It could use the agent's own key and credits.

The M1 release runs on test networks only, and this is an accepted, documented residual (G-1, D-67); it is re-decided before outside testers rely on it. What M1 does claim: a script that does not modify the installation and does not read process memory cannot approve anything or change rules, even if it can read `~/.agentlink`, the keychain items and the database. Mitigations: do owner steps in a terminal your agent does not control, add the rules above, keep credits small, and revoke an agent you do not trust.

## Machines without an OS keychain (containers, WSL, SSH)

`agentlink init` stops with setup guidance when there is no usable OS keychain and writes nothing. The passphrase-locked file key store (`--keystore file`, 04 §2.8) is not part of v0.1.0, so containers and headless machines are not a supported setup for the first release. Their documentation follows with that feature.

## What comes later

- Claude Desktop, and the one-click extension bundle (v0.2.0)
- Antigravity, Cursor, VS Code, Windsurf, Cline (as tested)
- Remote harnesses (ChatGPT developer mode, claude.ai custom connectors) through the self-hosted cloud agent (v0.3.0)
- Optional session-start hooks

**Filled in at:** M1a (v0.1.0) by M1-12b; extended at M1 and M2 (DOCS-M1b, DOCS-M2).
