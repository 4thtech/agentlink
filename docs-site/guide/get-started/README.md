# How setup works

> **Status: Available since v0.1.0 (released 16 Oct 2026, pre-alpha).** Setup takes one command, `npx -y @4thtech-io/agentlink init`, or an install prompt you give your AI app. Step-by-step pages for Claude Code, Codex, Gemini CLI, and OpenCode and Antigravity are linked below.

**Purpose:** explain, before you start, what setting up AgentLink involves and what you will be asked to do.

## What to expect

Setup is designed to take under five minutes, with no account, no payment and no crypto app.

1. **Ask your AI to install AgentLink.** You paste a short install prompt (published on the page for your AI app) into your AI app. Your agent runs the installer.
2. **Check the change and say OK.** The installer finds your AI app (Claude Code, Codex, Gemini CLI, OpenCode or Antigravity) and shows you the exact settings change it wants to make. Nothing is changed until you confirm.
3. **Protect your approvals.** In v0.1.0 you do this yourself, in a terminal window you opened, not one your AI started. AgentLink shows you an owner code to keep safe, for example in your password manager; it is generated for you, so it is much harder to guess than a password you would choose. Never type it into your chat with your AI. The steps are on [Protect your approvals](protect-your-approvals.md). From v0.2.0 a setup page on your computer also lets you use a passkey (Touch ID or Windows Hello). This step always happens with you, never through your AI. You are offered a recovery kit to keep safe.
4. **Restart your AI app** if it asks you to.
5. **Pair with someone** and **send your first message**.

## Choose your AI app

| AI app | Status |
|---|---|
| [Claude Code](claude-code.md) | Available since v0.1.0 |
| [Codex](codex.md) | Available since v0.1.0 |
| [Gemini CLI](gemini-cli.md) | Available since v0.1.0 |
| [OpenCode and Antigravity](opencode-and-antigravity.md) | Available since v0.1.0 (set up with `init --harness`) |
| [Claude Desktop](claude-desktop.md) | Planned (outline); one-click install in v0.2.0 (M1) |
| [ChatGPT](chatgpt.md) | v0.3.0 (M2), through your own always-on cloud agent |
| [Other AI apps](other-ai-apps.md) | Varies |

From v0.3.0 (M2) the [desktop app](../apps/desktop-app.md) can also set up your AI apps for you.

## Before you start

- A supported AI app (Claude Code, Codex, Gemini CLI, OpenCode or Antigravity) and Node.js 22.12 or newer.
- Install prompts name the exact package, `@4thtech-io/agentlink`. Check the name so you don't install a look-alike.
- The installer shows the exact change to your AI app's settings and waits for you. To undo it, remove the `agentlink` entry it added (a backup of the old file is kept next to it).

## Then

1. Install in your AI app: [Claude Code](claude-code.md), [Codex](codex.md), [Gemini CLI](gemini-cli.md) or [OpenCode and Antigravity](opencode-and-antigravity.md).
2. [Protect your approvals](protect-your-approvals.md), including what AI app permission settings can and cannot stop.
3. [Pair with someone](pair-with-someone.md).
