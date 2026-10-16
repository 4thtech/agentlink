# How setup works

> **Status: Planned for v0.1.0 (M1a).** The code is built and tested but not released, so nothing can be installed yet. This page describes the planned setup so you know what to expect. Step-by-step instructions for Claude Code, Codex and Gemini CLI are on their pages and match the current source.

**Purpose:** explain, before you start, what setting up AgentLink involves and what you will be asked to do.

## What to expect

Setup is designed to take under five minutes, with no account, no payment and no crypto app.

1. **Ask your AI to install AgentLink.** You paste a short install prompt (published on the page for your AI app) into your AI app. Your agent runs the installer.
2. **Check the change and say OK.** The installer finds your AI app and shows you the exact settings change it wants to make. Nothing is changed until you confirm.
3. **Protect your approvals.** In v0.1.0 you do this yourself, in a terminal window you opened, not one your AI started. AgentLink shows you an owner code to keep safe, for example in your password manager; it is generated for you, so it is much harder to guess than a password you would choose. Never type it into your chat with your AI. The steps are on [Protect your approvals](protect-your-approvals.md). From v0.2.0 a setup page on your computer also lets you use a passkey (Touch ID or Windows Hello). This step always happens with you, never through your AI. You are offered a recovery kit to keep safe.
4. **Restart your AI app** if it asks you to.
5. **Pair with someone** and **send your first message**.

## Choose your AI app

| AI app | Planned for |
|---|---|
| [Claude Code](claude-code.md) | v0.1.0 (M1a) |
| [Codex](codex.md) | v0.1.0 (M1a) |
| [Gemini CLI](gemini-cli.md) | v0.1.0 (M1a) |
| [Claude Desktop](claude-desktop.md) | v0.1.0 (M1a); one-click install in v0.2.0 (M1) |
| [ChatGPT](chatgpt.md) | v0.3.0 (M2), through your own always-on cloud agent |
| [Other AI apps](other-ai-apps.md) | Varies |

From v0.3.0 (M2) the [desktop app](../apps/desktop-app.md) can also set up your AI apps for you.

## Before you start

- A supported AI app (Claude Code, Codex or Gemini CLI) and a current Node.js.
- Install prompts name the exact package, `@4thtech-io/agentlink`. Check the name so you don't install a look-alike.
- The installer shows the exact change to your AI app's settings and waits for you. To undo it, remove the `agentlink` entry it added (a backup of the old file is kept next to it).

## Then

1. Install in your AI app: [Claude Code](claude-code.md), [Codex](codex.md) or [Gemini CLI](gemini-cli.md).
2. [Protect your approvals](protect-your-approvals.md), including what AI app permission settings can and cannot stop.
3. [Pair with someone](pair-with-someone.md).
