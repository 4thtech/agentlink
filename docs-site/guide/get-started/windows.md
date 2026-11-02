# Windows

*Applies to AgentLink 0.4.8. Windows 10 and 11. Windows support for AI apps arrived in 0.4.7. Pre-alpha, on test networks. No account, no payment.*

AgentLink works on Windows the same way as on a Mac. These are the Windows details.

## What you need

- **Node.js 22.14 or newer.** Open PowerShell and run `node --version`. If it is older or missing, install the current LTS from [nodejs.org](https://nodejs.org), then open a new PowerShell window.
- **PowerShell** (the blue "Windows PowerShell" or "PowerShell" in the Start menu). Open it yourself; do not let your AI open it for you.

## Install

In PowerShell:

```powershell
npx -y @4thtech-io/agentlink
```

Your browser opens on **Welcome**. Set up there, as in [Get started](README.md). Keep the PowerShell window open while you use the app and press Ctrl+C when you are done. Check that the package name is exactly `@4thtech-io/agentlink`.

If PowerShell refuses to run it, run the command from **Command Prompt** (`cmd`) instead, or run `cmd /c npx -y @4thtech-io/agentlink` in PowerShell.

## How your AI app starts AgentLink

On Windows, AgentLink adds this to your AI app's settings: `cmd /c npx -y @4thtech-io/agentlink mcp`. The `cmd /c` part is needed because many AI apps cannot start `npx` directly on Windows. If you connected AgentLink with an earlier version and your AI app says it cannot start it ("spawn npx ENOENT"), open AgentLink and connect the app again from [AI apps](../local-app/ai-apps.md), or run `npx -y @4thtech-io/agentlink init` once more. It shows the exact change before it writes anything.

## Windows security prompts

- **SmartScreen.** Windows may say "Windows protected your PC" when you open a downloaded file. That is not specific to AgentLink: it appears for any file that few people have downloaded yet. Check the file against `SHA256SUMS` on the release page (`certutil -hashfile <file> SHA256`), then choose **More info** and **Run anyway** only if the fingerprint matches.
- **The `.mcpb` download is not signed with a certificate Windows knows.** 4thTech signs it with its own beta certificate, so Windows and Claude Desktop can warn. The one-click download for Claude Desktop is optional; the command line works without it. See [Claude Desktop](claude-desktop.md).
- **Windows Hello.** Use it as your passkey when the setup page asks. See [Protect your approvals](protect-your-approvals.md).

## If something does not work

Run `npx -y @4thtech-io/agentlink doctor` in PowerShell. It shows what is set up and how to fix the rest.
