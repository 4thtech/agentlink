# Install AgentLink

*Applies to AgentLink 0.5.1. Mac, Windows 10 or 11, and Linux. There is an early [Mac desktop app](../apps/desktop-app.md); otherwise AgentLink opens in your browser.*

**Goal:** AgentLink installed and its app open in your browser, in about two minutes. You need no account and no admin rights.

## Steps

1. **Open a terminal yourself.**
   - Mac: Cmd+Space, type **Terminal**, press Return.
   - Windows: Start menu, type **PowerShell**, press Enter.
   - Linux: your usual terminal.
2. **Paste one line and press Return** (Enter on Windows):

   Mac or Linux:

   ```bash
   curl -fsSL https://agentlink.4thtech.io/install.sh | sh
   ```

   Windows PowerShell:

   ```powershell
   irm https://agentlink.4thtech.io/install.ps1 | iex
   ```

   Windows Command Prompt instead:

   ```bat
   powershell -ExecutionPolicy Bypass -c "irm https://agentlink.4thtech.io/install.ps1 | iex"
   ```

3. **Your browser opens AgentLink** on **Get started**. Go on with [Connect your AI app](README.md).

The installer says **AgentLink is installed.**, then opens the app. Keep the terminal open while you use AgentLink; **Ctrl+C** closes it, and it also closes by itself after 30 minutes without use. Next time, open a new terminal and type:

```bash
agentlink
```

## What the installer does

```mermaid
flowchart LR
  A["Paste the line"] --> B{"Node.js 22.14+<br/>on this computer?"}
  B -- yes --> D["Add the agentlink command"]
  B -- no --> C["Download the official Node.js<br/>from nodejs.org, check it,<br/>keep it for AgentLink only"] --> D
  D --> E["Open the app in your browser"]
```

- It changes nothing outside its own folder and your PATH, and needs no admin rights.
- Run the same line again to update.
- To see what it would do first, add `--dry-run` (Mac or Linux: `curl -fsSL https://agentlink.4thtech.io/install.sh | sh -s -- --dry-run`). To remove it, use `--uninstall`; your IDs are kept. Details: [installer](https://github.com/4thtech/agentlink/blob/main/installer/README.md).

## Got an invite link?

Open the link instead. The invite page gives you the same installer with the invite built in: one command installs AgentLink and opens the invite. See [Accept an invite](join-from-an-invite.md).

## Already have Node.js 22.14 or newer?

You can skip the installer:

```bash
npx -y @4thtech-io/agentlink@latest
```

The package name is exactly `@4thtech-io/agentlink`; similar names are not ours. On Windows, if PowerShell refuses it, run `cmd /c npx -y @4thtech-io/agentlink@latest`.

## If something goes wrong

- **Windows says "Windows protected your PC"** or blocks the script: see [Windows](windows.md).
- **The browser didn't open:** the terminal prints a link; open it yourself.
- **Anything else:** run `agentlink doctor`. It says in plain words what is set up and what to do next. More in [Troubleshooting](../help/troubleshooting.md).

Next: [Connect your AI app](README.md).
