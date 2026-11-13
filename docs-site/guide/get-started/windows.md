# Windows

*Applies to AgentLink 0.4.13. Windows 10 and 11. Windows support for AI apps arrived in 0.4.7. Pre-alpha, on test networks. No account, no payment.*

AgentLink works on Windows the same way as on a Mac. These are the Windows details.

## What you need

- **Node.js 22.14 or newer.** Open PowerShell and run `node --version`. If it is older or missing, install the current LTS from [nodejs.org](https://nodejs.org), then open a new PowerShell window.
- **PowerShell** (the blue "Windows PowerShell" or "PowerShell" in the Start menu). Open it yourself; do not let your AI open it for you.

## Install

In PowerShell:

```powershell
npx -y @4thtech-io/agentlink@latest
```

Your browser opens on **Welcome**. The first line in the window says "Opening AgentLink in your browser…". If the page has not loaded after 15 seconds, the window says "Your browser didn't open AgentLink. Press Enter here to try again." Set up there, as in [Get started](README.md). Keep the PowerShell window open while you use the app. AgentLink stays open while you use it and closes after 30 minutes without use; the window and the page both say "AgentLink closed. Run `agentlink` to open it again." Press Ctrl+C to close it yourself. Check that the package name is exactly `@4thtech-io/agentlink`.

If PowerShell refuses to run it, run the command from **Command Prompt** (`cmd`) instead, or run `cmd /c npx -y @4thtech-io/agentlink@latest` in PowerShell.

## Prefer an app? (early build)

From 0.5.3 there is also an early **Windows app**: AgentLink in its own window, no Node.js and no PowerShell needed. Download [AgentLink-win-x64-setup.exe](https://github.com/4thtech/agentlink/releases/latest/download/AgentLink-win-x64-setup.exe) and open it. It is not signed yet, so Windows may say "Windows protected your PC": choose **More info**, then **Run anyway**. If Smart App Control blocks it, use the command above instead. Steps and details: [Desktop app, Windows](../apps/desktop-app.md#windows).

## How your AI app starts AgentLink

On Windows, AgentLink adds this to your AI app's settings: `cmd /c npx -y @4thtech-io/agentlink mcp`. The `cmd /c` part is needed because many AI apps cannot start `npx` directly on Windows. If you connected AgentLink with an earlier version and your AI app says it cannot start it ("spawn npx ENOENT"), open AgentLink and connect the app again from [AI apps](../local-app/ai-apps.md), or run `npx -y @4thtech-io/agentlink@latest init` once more. It shows the exact change before it writes anything.

If your home folder already has a folder named `agentlink` in another letter case (for example `Agentlink`), setup now uses that folder under its own name instead of stopping at "Confirm it's you". This also applies on a Mac, which ignores letter case by default.

## Windows security prompts

- **SmartScreen.** Windows may say "Windows protected your PC" when you open a downloaded file. That is not specific to AgentLink: it appears for any file that few people have downloaded yet. Check the file against `SHA256SUMS` on the release page (`certutil -hashfile <file> SHA256`), then choose **More info** and **Run anyway** only if the fingerprint matches.
- **Smart App Control** (some Windows 11 computers) blocks apps that are not signed, with no way to allow them. The early Windows app is not signed yet, so where Smart App Control is on, use the command above. Do not turn Smart App Control off for AgentLink.
- **The `.mcpb` download is not signed with a certificate Windows knows.** 4thTech signs it with its own beta certificate, so Windows and Claude Desktop can warn. The one-click download for Claude Desktop is optional; the command line works without it. See [Claude Desktop](claude-desktop.md).
- **Windows Hello.** Use it as your passkey when the setup page asks. On some Windows computers setup asks for one more touch right away; that lets your approvals use the passkey instead of the master code. See [Protect your approvals](protect-your-approvals.md).

## If something does not work

Run `npx -y @4thtech-io/agentlink@latest doctor` in PowerShell. It shows what is set up, why AgentLink last closed, whether anything was left behind, and how to fix the rest.
