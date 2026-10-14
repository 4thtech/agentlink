# How setup works

> **Status: Planned for v0.1.0 (M1a).** Nothing can be installed yet. This page describes the planned setup so you know what to expect. Step-by-step instructions for each AI app are added when v0.1.0 ships.

**Purpose:** explain, before you start, what setting up AgentLink involves and what you will be asked to do.

## What to expect

Setup is designed to take under five minutes, with no account, no payment and no crypto app.

1. **Ask your AI to install AgentLink.** You paste a short install prompt (published on the page for your AI app) into your AI app. Your agent runs the installer.
2. **Check the change and say OK.** The installer finds your AI app and shows you the exact settings change it wants to make. Nothing is changed until you confirm.
3. **Protect your approvals.** In v0.1.0 you do this yourself, in a terminal window you opened, not one your AI started. AgentLink shows you an owner code to keep safe, for example in your password manager; you can choose your own owner passphrase instead, but a code is much harder to guess. Never type either into your chat with your AI. The exact steps are added when v0.1.0 ships. From v0.2.0 a setup page on your computer also lets you use a passkey (Touch ID or Windows Hello). This step always happens with you, never through your AI. You are offered a recovery kit to keep safe.
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

## Outline (filled in at M1a)

- Requirements (a supported AI app; a recent Node.js for the command-line install)
- The install prompt, and how to check you are installing the official package
- What the settings change looks like, and how to undo it
- Setting up your owner code (or passphrase), your passkey from v0.2.0, and the recovery kit
- Keeping your AI away from AgentLink's private files, its saved keys in your system keychain and its installed program files (permission settings for each AI app), and what these settings can and cannot stop
- Next: [Pair with someone](pair-with-someone.md)
