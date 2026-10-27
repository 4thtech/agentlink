# Codex

*Applies to AgentLink 0.3.0.*

This page sets up AgentLink in Codex (command line, IDE extension, and Codex in the ChatGPT desktop app). You need Node.js 22.14 or newer (check with `node --version`) and Codex.

## 1. Install it

The quick way is one command in your own terminal:

```bash
npx -y @4thtech-io/agentlink init
```

It shows the exact change and asks `y/N`. Or ask Codex to do it:

Paste this into Codex:

> Install AgentLink for me. Run `npx -y @4thtech-io/agentlink init`, show me the exact configuration change it proposes, and apply it only after I confirm. Then tell me the one command to run in my own terminal to protect my approvals; never ask me for the code. Tell me to restart Codex when it's done.

What happens:

1. Codex runs `npx -y @4thtech-io/agentlink init`. It looks for your AI apps on your computer, prints the exact change to each settings file and a short confirmation code, and writes nothing yet.
2. Codex shows you the change. For Codex it adds a short `[mcp_servers.agentlink]` section to the end of `~/.codex/config.toml`. Nothing else in the file changes.
3. If you agree, Codex runs the command again with `--confirm <code>`. The code only works for exactly the change you were shown. A backup of your old file is kept.
4. Restart Codex.

AgentLink writes this file itself instead of using a Codex command, so you see the exact change first.

Check that the package name is exactly `@4thtech-io/agentlink`.

## 2. Protect your approvals

Do this yourself, in a terminal you opened, never through Codex: [Protect your approvals](protect-your-approvals.md).

## 3. Check it works

Ask Codex: "What's my AgentLink status?" If not, run `npx -y @4thtech-io/agentlink doctor` in your own terminal.

## Optional: keep your AI away from AgentLink's files

This is extra protection for people who are comfortable editing settings. You can skip it. Codex runs commands in a sandbox. Its permission profiles (still in beta) can block a folder completely. **This is a guard, not a lock**: read [Protect your approvals](protect-your-approvals.md) for what it can't stop. Codex has no setting to block system keychain commands by name.

### The settings

In `~/.codex/config.toml`. A permission profile can't be combined with `sandbox_mode`; use one or the other.

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

Check that your own projects still work with this profile before you rely on it. The [technical reference](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/reference/harness-configuration.md) has more, including how to make Codex ask before every AgentLink action.

Source: [Codex permissions](https://learn.chatgpt.com/docs/permissions).

## A start-of-session note

The optional start-of-session note is not available for Codex yet. Run `npx -y @4thtech-io/agentlink status --brief` yourself to see the same counts.

Next: [Pair with someone](pair-with-someone.md)
