# Harness configuration

> **Status: Available since v0.1.0 (released 16 Oct 2026, pre-alpha); current version v0.4.1, 28 Oct 2026.** The configuration below is what `agentlink init` writes. Other harnesses and remote harnesses are planned for later releases and are not covered here.

**Purpose:** the exact MCP configuration for Claude Code, Claude Desktop, Codex, Gemini CLI, OpenCode and Antigravity, for people who configure it by hand instead of using `agentlink init`, and the harness permission settings that keep an agent away from AgentLink's private files.

## How `agentlink init` configures a harness

`npx -y @4thtech-io/agentlink init` detects Claude Code, Claude Desktop, Codex, Gemini CLI, OpenCode, Antigravity, Cursor and Windsurf, prints the exact diff of each config file, and writes it only after confirmation. `init --harness <id>` (`claude-code`, `claude-desktop`, `codex`, `gemini-cli`, `opencode`, `antigravity`, `cursor`, `windsurf`) proposes that one app only (`claude-desktop` and the stricter Gemini CLI detection are available since v0.1.1), and `init --harness none` creates the agent identity only. Answering no to every proposed change writes no config but keeps the agent identity. In an interactive terminal it asks `y/N` for each file. Run by an agent (no terminal, or a harness marker set), it prints the diff and a one-time confirmation code, writes nothing, and `init --confirm <code>` then writes exactly those changes. The code is a hash of the shown changes, so it stops matching if they change. This is transparency, not a security boundary: an agent with a shell can edit its own harness config anyway ([06 §7](https://github.com/4thtech/agentlink/blob/main/docs/foundation/06-mcp-server.md#7-harness-installation)).

An existing `agentlink` entry that differs is left alone. Existing config is backed up before it is changed. `init` never writes an owner secret.

`--config <path>` names the config file for OpenCode, Antigravity or Windsurf when it is not in the default place. The folder must exist and is resolved with `realpath`; the file must be a `.json` file and not a link, never under `~/.agentlink`, `~/.ssh` or the keychain folders. It is written like every other config: as a diff you confirm, through a temporary file renamed over the old one, with a backup. These checks stop accidents and misdirected paths; they can't stop a program running as you from swapping a folder in between ([06 §7](https://github.com/4thtech/agentlink/blob/main/docs/foundation/06-mcp-server.md#7-harness-installation)).

### Several agents on one computer

Each app's config holds one `agentlink` entry, so each app runs one agent. Give each app its own agent with `init --agent <name> --harness <id>`; its entry then ends in `--agent <name>`. The owner key is set up once per computer user (`owner init`); every further agent gets its card from it with `agentlink owner add-agent --agent <name>`, run in your own terminal, one owner code entry for exactly that agent ([04 §2.8](https://github.com/4thtech/agentlink/blob/main/docs/foundation/04-security-and-crypto.md), D-78). An approval for one agent is refused by every other. The agents still run as the same user, so this is logical isolation, not a security boundary.

## Configuration by harness

Each harness runs `npx -y @4thtech-io/agentlink mcp` as a stdio server. A non-default agent adds `--agent <name>` to `args`.

### Claude Code

User scope, in `~/.claude.json`. Not written by `init` when `CLAUDE_CONFIG_DIR` is set.

```json
{
  "mcpServers": {
    "agentlink": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@4thtech-io/agentlink", "mcp"],
      "env": {}
    }
  }
}
```

Equivalent command: `claude mcp add --transport stdio --scope user agentlink -- npx -y @4thtech-io/agentlink mcp`.

Sources: [Claude Code MCP](https://code.claude.com/docs/en/mcp) (`claude mcp add [options] <name> -- <command> [args...]`, user scope stored in `~/.claude.json`, stdio entry shape).

### Claude Desktop (the Claude app)

The Claude desktop app (chat) has its own file, separate from Claude Code's `~/.claude.json`. Setting up one does not set up the other: run `init --harness claude-code` for Claude Code and `init --harness claude-desktop` (since v0.1.1) for the app.

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json` (`init` uses `~/AppData/Roaming/Claude`; the `APPDATA` variable is not followed)
- The Microsoft Store build of Claude on Windows, or a redirected `APPDATA`, keeps the file elsewhere. `init` always uses the path above, so Claude may not read what it wrote; add the entry to the file your Claude reads by hand instead.
- Linux: there is no Claude desktop app, so `init` says so and writes nothing.

```json
{
  "mcpServers": {
    "agentlink": {
      "command": "npx",
      "args": ["-y", "@4thtech-io/agentlink", "mcp"]
    }
  }
}
```

After `init`, quit and reopen the Claude app; AgentLink appears under Connectors. A one-click extension bundle is planned for v0.2.0.

Sources: [06 §7](https://github.com/4thtech/agentlink/blob/main/docs/foundation/06-mcp-server.md#7-harness-installation) (Claude Desktop row). Not yet tried in the app.

### Codex (CLI, IDE extension, Codex in the ChatGPT desktop app)

`~/.codex/config.toml`:

```toml
[mcp_servers.agentlink]
command = "npx"
args = ["-y", "@4thtech-io/agentlink", "mcp"]
```

Equivalent command: `codex mcp add agentlink -- npx -y @4thtech-io/agentlink mcp`. `init` writes the file itself, as a diff you confirm, and does not call `codex mcp add`. `CODEX_HOME` is not followed.

Sources: [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) (`codex mcp add <server-name> -- <stdio server-command>`; `[mcp_servers.<server-name>]` with `command` and `args`).

### Gemini CLI

`init` detects Gemini CLI by the `gemini` program on `PATH` or `~/.gemini/settings.json`; a `~/.gemini` folder alone (Antigravity keeps its config there too) proposes nothing. User settings, `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "agentlink": {
      "command": "npx",
      "args": ["-y", "@4thtech-io/agentlink", "mcp"]
    }
  }
}
```

`gemini mcp add [options] <name> <commandOrUrl> [args...]` also exists, but its handling of a leading `-y` in the arguments is not documented, so edit the file (or let `init` do it). Do not set `"trust": true` for this server: it removes every confirmation prompt for its tools.

Sources: [Gemini CLI MCP servers](https://geminicli.com/docs/tools/mcp-server/) (`mcpServers` shape, `gemini mcp add [options] <name> <commandOrUrl> [args...]` with `-s, --scope`, `trust` semantics).

### OpenCode

Global config, `~/.config/opencode/opencode.json`, under `mcp` (not `mcpServers`). `command` is one array, the program and its arguments together; a named agent appends `"--agent", "<name>"` to it.

```json
{
  "mcp": {
    "agentlink": {
      "type": "local",
      "command": ["npx", "-y", "@4thtech-io/agentlink", "mcp"],
      "enabled": true
    }
  }
}
```

Sources: [OpenCode MCP servers](https://opencode.ai/docs/mcp-servers/) (checked 2026-10-16: `mcp.<name>` with `type: "local"`, `command` array, `enabled`).

### Antigravity

Global config, `~/.gemini/config/mcp_config.json` (not the Gemini CLI file `~/.gemini/settings.json`). Older builds read `~/.gemini/antigravity/mcp_config.json`; in the app, "Manage MCP Servers", then "View raw config" opens the file yours reads, and `init --harness antigravity --config <that path>` writes there.

```json
{
  "mcpServers": {
    "agentlink": {
      "command": "npx",
      "args": ["-y", "@4thtech-io/agentlink", "mcp"]
    }
  }
}
```

Sources: [Antigravity MCP](https://antigravity.google/docs/mcp) (checked 2026-10-16: global `~/.gemini/config/mcp_config.json`, `mcpServers` with `command` and `args`). Documentation-verified; not yet tried in the app.

### Cursor

Global config, `~/.cursor/mcp.json`. `init --harness cursor` writes it after you confirm the diff.

```json
{
  "mcpServers": {
    "agentlink": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@4thtech-io/agentlink", "mcp"]
    }
  }
}
```

Sources: [Cursor MCP](https://cursor.com/docs/context/mcp) (checked 2026-10-22: global `~/.cursor/mcp.json`, `mcpServers` with `type`, `command`, `args`). Documentation-verified; not yet tried in the app.

### Windsurf

Cascade's config, `~/.config/devin/mcp_config.json` on macOS and Linux, `%AppData%/devin/mcp_config.json` on Windows (`~/AppData/Roaming/devin/mcp_config.json`). If `XDG_CONFIG_HOME` (macOS, Linux) or `APPDATA` (Windows) is set to an absolute path inside your home folder, `init` uses `devin/mcp_config.json` there, as Windsurf does; an empty or relative value is ignored, and one outside your home folder is refused. Older installs keep `~/.codeium/windsurf/mcp_config.json`: `init` still detects them, and `init --harness windsurf --config <that path>` writes there.

```json
{
  "mcpServers": {
    "agentlink": {
      "command": "npx",
      "args": ["-y", "@4thtech-io/agentlink", "mcp"]
    }
  }
}
```

Sources: [Windsurf MCP](https://docs.devin.ai/windsurf/plugins/cascade/mcp) (checked 2026-10-22: `mcpServers` with `command` and `args`; the docs name two files and say to use the one "Open MCP config file" opens for your install). Documentation-verified; not yet tried in the app.

## Optional SessionStart hook

`agentlink init --hook [--agent <name>]` adds a start-of-session hook to Claude Code's user settings (`~/.claude/settings.json`). It is a separate opt-in from the `agentlink` entry: plain `init` never writes it, and no MCP tool installs or changes hooks. It follows the same rules as the entry: the exact diff is shown first, an interactive terminal asks `y/N`, an agent run prints the diff and a one-time code (`init --hook --confirm <code>`; a code from the entry's diff never matches), the old file is backed up, and a settings file that is not valid JSON, or not in a form that can be changed exactly, is left alone with no write. `CLAUDE_CONFIG_DIR` is not followed: when it is set, nothing is written.

The hook runs code at every session start, so it points at the absolute path of the installed program and never at `npx`, which could fetch a newer package. `init --hook` refuses while only a temporary `npx` copy is running; run `npm install -g @4thtech-io/agentlink` first. It writes:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "\"<absolute path to node>\" \"<absolute path to the installed agentlink.js>\" status --brief",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

`status --brief` prints one or two lines: unread counts, the number of requests from unknown senders and contact names (an alias you set, or a restricted name with its label). It never prints message text, and it only fetches and stores incoming messages. It marks nothing read, adds no contact, answers nothing and signs nothing, needs no owner presence, and finishes within 3 seconds. Claude Code adds its output to the session.

Sources: [Claude Code hooks](https://code.claude.com/docs/en/hooks) (`SessionStart`, `matcher`, `type: "command"`, `timeout` in seconds, standard output added to the session).

### Removing the hook

Open `~/.claude/settings.json` and delete the AgentLink entry from `hooks.SessionStart` (the item whose command ends in `status --brief`), then restart Claude Code. Or restore the backup that `init --hook` made next to the file: `~/.claude/settings.json.agentlink-backup-<unix time>` (a `-1`, `-2` suffix is added if that name was taken). Restoring the backup also drops any change you made to the settings after the hook was added. There is no backup when the file did not exist before.

Codex, Gemini CLI, OpenCode and Antigravity: not available. AgentLink has not verified a session-start hook for them in this release, so `init --hook` accepts Claude Code only. Run `agentlink status --brief` by hand, or ask your AI to call `agentlink_status`.

## Default message network

Messages travel over public Nostr relays that see only ciphertext (I-3). The default set, in this order, is `wss://nos.lol`, `wss://relay.primal.net`, `wss://relay.snort.social` and `wss://nostr.mom` (D-75). The list lives in one place, `DEFAULT_RELAYS` in `@4thtech-io/transport-nostr`. Changing an agent's relay list is not available yet.

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
      "Edit(//<output of npm root -g>/@4thtech-io/agentlink/**)",
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
      "Bash(agentlink policy *)",
      "Bash(npx *@4thtech-io/agentlink owner *)",
      "Bash(npx *@4thtech-io/agentlink approve *)",
      "Bash(npx *@4thtech-io/agentlink deny *)",
      "Bash(npx *@4thtech-io/agentlink cancel *)",
      "Bash(npx *@4thtech-io/agentlink policy *)"
    ]
  }
}
```

Adjust it to your system:

- Keep the keychain rule for your system (`security` on macOS, `secret-tool` on Linux, `cmdkey` and `vaultcmd` on Windows); the others are harmless.
- The `Edit(//...)` line is for a global install. Replace the placeholder with the output of `npm root -g`, starting with `//` (for example `//usr/local/lib/node_modules/@4thtech-io/agentlink/**`).
- Add `Edit(<npm global prefix>/bin/**)` as an absolute path (`npm prefix -g`).
- On Windows, the npx cache is `Edit(~/AppData/Local/npm-cache/_npx/**)` and the PowerShell profile is `Edit(~/Documents/PowerShell/**)`.
- A `Bash(...)` rule matches the command text only. Those commands refuse to run from a terminal an AI app controls anyway; the rules add a second guard, not a boundary.
- The last five rules stop an agent from running owner commands in its own shell. Owner commands also refuse when no terminal is attached or a harness marker is set. Both are guards ([06 §8](https://github.com/4thtech/agentlink/blob/main/docs/foundation/06-mcp-server.md#8-cli-commands)).

On macOS, Linux and WSL2, also turn on the sandbox, which the operating system enforces for every shell command, including scripts. The Read and Edit rules above cover only Claude Code's file tools. `sandbox.filesystem.denyRead` and `denyWrite` are enforced for Bash subprocesses ([sandboxing](https://code.claude.com/docs/en/sandboxing)); the sandbox does not run on native Windows.

```json
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
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
args = ["-y", "@4thtech-io/agentlink", "mcp"]
default_tools_approval_mode = "prompt"

[mcp_servers.agentlink.tools.agentlink_status]
approval_mode = "approve"
```

Source: [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), which documents `default_tools_approval_mode` (`auto`, `prompt`, `writes`, `approve`) and the per-tool `tools.<tool>.approval_mode` override.

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

`agentlink init` stops with setup guidance when there is no usable OS keychain and writes nothing. The passphrase-locked file key store (`--keystore file`, 04 §2.8) is not part of the released versions, so containers and headless machines are not a supported setup for the first release. Their documentation follows with that feature.

## What comes later

- The one-click Claude Desktop extension bundle (v0.2.0)
- Cursor, VS Code, Windsurf, Cline (as tested)
- Claude custom connectors (claude.ai and the Claude iOS and Android apps) through the self-hosted cloud agent (planned for v0.5.0, D-131); ChatGPT web developer mode later
- Optional session-start hooks

**Filled in at:** M1a (v0.1.0) by M1-12b; extended at M1 and M2 (DOCS-M1b, DOCS-M2).
