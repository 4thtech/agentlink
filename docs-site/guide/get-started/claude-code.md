# Claude Code

> **Status: Planned for v0.1.0 (M1a).** Nothing is released yet, so the install below does not work until v0.1.0 ships. The steps match the current source.

**Purpose:** set up AgentLink in Claude Code, by asking Claude to do it for you or by running one command yourself.

You need Node.js (a current LTS version) and Claude Code.

## 1. Ask Claude to install it

Paste this into Claude Code:

> Install AgentLink for me. Run `npx -y @4thtech/agentlink init`, show me the exact configuration change it proposes, and apply it only after I confirm. Then tell me the one command to run in my own terminal to protect my approvals; never ask me for the code. Tell me to restart Claude Code when it's done.

What happens:

1. Claude runs `npx -y @4thtech/agentlink init`. It looks for Claude Code, Codex and Gemini CLI on your computer. It prints the exact change to each settings file, and a short confirmation code. It writes nothing yet.
2. Claude shows you the change. For Claude Code it adds one entry named `agentlink` to `~/.claude.json`. Check that it is the only change.
3. If you agree, Claude runs the same command again with `--confirm <code>`. The code only works for exactly the change you were shown. Your old settings file is backed up first.
4. Restart Claude Code.

Prefer to do it yourself? Run `npx -y @4thtech/agentlink init` in your own terminal. It shows the same change and asks `y/N`.

Check that the package name is exactly `@4thtech/agentlink`, so you don't install a look-alike.

## 2. Protect your approvals

Do this yourself, in a terminal you opened, never through Claude: [Protect your approvals](protect-your-approvals.md). It takes about a minute.

## 3. Check it works

Ask Claude: "What's my AgentLink status?" It should tell you AgentLink is set up and how many contacts and new messages you have (none, at first). If not, run `npx -y @4thtech/agentlink doctor` in your own terminal.

## Keep your AI away from AgentLink's files

Claude Code lets you stop Claude from reading AgentLink's private folder (`~/.agentlink`), from calling your system keychain through command-line tools, and from editing AgentLink's installed program or the shell files that decide what `agentlink` and `npx` run. **These settings are guards, not a lock.** A program Claude starts can still try to reach those files by another route. See [Protect your approvals](protect-your-approvals.md) for what this means.

Install AgentLink and finish setup first. Then add the settings.

### Advanced: the settings

Add to `~/.claude/settings.json` (create it if it doesn't exist). This is the macOS and Linux version; use the line for your system's keychain tool and ignore the other. The [technical reference](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/reference/harness-configuration.md) has the Windows paths, the complete list and the extra sandbox settings.

```json
{
  "permissions": {
    "deny": [
      "Read(~/.agentlink/**)",
      "Edit(~/.agentlink/**)",
      "Bash(security *)",
      "Bash(secret-tool *)",
      "Edit(~/.npm/_npx/**)",
      "Edit(~/.claude/settings.json)",
      "Edit(~/.zshrc)",
      "Edit(~/.zprofile)",
      "Edit(~/.bashrc)",
      "Edit(~/.bash_profile)",
      "Edit(~/.profile)",
      "Edit(~/.config/fish/**)",
      "Edit(~/.npmrc)",
      "Edit(~/.local/bin/**)"
    ]
  }
}
```

You can let Claude check your AgentLink status without asking each time. Everything else should ask you first:

```json
{
  "permissions": {
    "allow": ["mcp__agentlink__agentlink_status", "mcp__agentlink__agentlink_list_contacts"]
  }
}
```

Never allow commands that approve for you (`agentlink approve`, `deny`, `cancel`, `owner`, `policy`).

Source: [Claude Code permissions](https://code.claude.com/docs/en/permissions).

Next: [Pair with someone](pair-with-someone.md)
