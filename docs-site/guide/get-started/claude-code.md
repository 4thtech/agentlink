# Claude Code

*Applies to AgentLink 0.4.3.*

This page sets up AgentLink in Claude Code. You can ask Claude to do it, or run one command yourself. You need Node.js 22.14 or newer (check with `node --version`) and Claude Code.

## 1. Install it

The quick way is one command in your own terminal:

```bash
npx -y @4thtech-io/agentlink init
```

It shows the exact change and asks `y/N`. Or ask Claude to do it:

Paste this into Claude Code:

> Install AgentLink for me. Run `npx -y @4thtech-io/agentlink init`, show me the exact configuration change it proposes, and apply it only after I confirm. Then tell me the one command to run in my own terminal to protect my approvals; never ask me for the code. Tell me to restart Claude Code when it's done.

What happens:

1. Claude runs `npx -y @4thtech-io/agentlink init`. It looks for your AI apps on your computer. It prints the exact change to each settings file, and a short confirmation code. It writes nothing yet.
2. Claude shows you the change. For Claude Code it adds one entry named `agentlink` to `~/.claude.json`. Check that it is the only change.
3. If you agree, Claude runs the same command again with `--confirm <code>`. The code only works for exactly the change you were shown. Your old settings file is backed up first.
4. Restart Claude Code.

Check that the package name is exactly `@4thtech-io/agentlink`, so you don't install a look-alike.

## 2. Protect your approvals

Do this yourself, in a terminal you opened, never through Claude: [Protect your approvals](protect-your-approvals.md). It takes about a minute.

## 3. Check it works

Ask Claude: "What's my AgentLink status?" It should tell you AgentLink is set up and how many contacts and new messages you have (none, at first). If not, run `npx -y @4thtech-io/agentlink doctor` in your own terminal.

## Optional: keep your AI away from AgentLink's files

This is extra protection for people who are comfortable editing settings. You can skip it. Claude Code lets you stop Claude from reading AgentLink's private folder (`~/.agentlink`), from calling your system keychain through command-line tools, and from editing AgentLink's installed program or the shell files that decide what `agentlink` and `npx` run. **These settings are guards, not a lock.** A program Claude starts can still try to reach those files by another route. See [Protect your approvals](protect-your-approvals.md) for what this means.

Install AgentLink and finish setup first. Then add the settings.

**Read and Edit rules alone do not stop scripts.** They cover Claude's own file tools and the file commands it recognizes (such as `cat` and `sed`), not a script that opens a file itself. On macOS, Linux and WSL2 the sandbox below closes that gap for shell commands, so turn it on too.

### The settings

Add to `~/.claude/settings.json` (create it if it doesn't exist). This is the macOS and Linux version; use the line for your system's keychain tool and ignore the other. The [technical reference](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/reference/harness-configuration.md) has the Windows paths, the complete list and the global install paths.

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
  },
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

The `Bash(...)` lines match the command text only, so a script can still get around them. The owner commands also refuse to run in a terminal your AI controls. Both are guards.


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

## A start-of-session note (optional)

AgentLink can tell Claude Code at the start of each session who has written to you, in a line or two. It only lists counts and contact names. It never includes message text, and it does not read, answer or change anything.

This is off until you ask for it. First install AgentLink on this computer, so the note runs a fixed copy and not whatever `npx` would download at that moment:

```
npm install -g @4thtech-io/agentlink
npx -y @4thtech-io/agentlink init --hook
```

AgentLink shows you the exact change to `~/.claude/settings.json` and writes it only after you confirm. If you ask your AI to run it, it prints the change and a one-time code; you check the change and give the code back. A settings file that isn't valid is left alone.

To turn it off, open `~/.claude/settings.json`, delete the AgentLink item under `SessionStart` (its command ends in `status --brief`) and restart Claude Code. You can instead copy back the backup AgentLink made next to the file, named `settings.json.agentlink-backup-` followed by a number; that also undoes any later change you made to the settings.

To see what the note prints, run `npx -y @4thtech-io/agentlink status --brief` yourself.

Next: [Pair with someone](pair-with-someone.md)
