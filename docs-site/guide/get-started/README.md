# Get started

*Applies to AgentLink 0.4.1 (released 28 Oct 2026). In 0.2.0 the setup page does not exist: use the terminal step below. Pre-alpha, on test networks. No account, no payment.*

Setup takes about five minutes. You install AgentLink into your AI app, protect your approvals, and restart the app. Already on 0.2.0? See [Upgrading from 0.2.0](upgrading-from-0.2.0.md).

## Install

You need **Node.js 22.14 or newer**. To check, open a terminal and run `node --version`. If it is older or missing, install the current LTS from [nodejs.org](https://nodejs.org).

1. **Install into your AI app.** In a terminal:

   ```bash
   npx -y @4thtech-io/agentlink init
   ```

   It finds the AI apps on your computer and shows the exact change it wants to make to their settings. Nothing is written until you say yes. Your old settings are backed up first. Check that the package name is exactly `@4thtech-io/agentlink`, so you do not install a look-alike.
2. **Protect your approvals.** `init` run in your own terminal ends by opening the setup page in your browser. The page lists the folders it creates and has one button, for example **Use Touch ID**. Then it shows your **backup code** once. Save it in your password manager and never type it into a chat with your AI. Why: [Protect your approvals](protect-your-approvals.md) and [First run and your backup code](../local-app/first-run.md).

   If no browser opens, or you prefer the terminal, open a terminal window yourself (not one your AI started) and run `npx -y @4thtech-io/agentlink owner init`. It shows an owner code once; the same advice applies. On 0.2.0 this is the only way.

   Once it is set up, `npx -y @4thtech-io/agentlink ui` opens your AgentLink pages in your browser, starting with your activity. See [The local app](../local-app/README.md). Run it yourself, in a terminal you opened; if your AI runs it, it only tells you to run it yourself. Press Ctrl+C when you're done; it stops by itself after 30 minutes.
3. **Restart your AI app**, then ask it: "What's my AgentLink status?" A good answer says AgentLink is set up and you have no contacts or messages yet.

If something does not work, run `npx -y @4thtech-io/agentlink doctor` in your terminal. It shows what is set up and how to fix the rest.

**Prefer to let your AI do step 1?** Paste this into your AI app: "Install AgentLink for me. Run `npx -y @4thtech-io/agentlink init`, show me the exact change it proposes, and apply it only after I confirm." Step 2 always stays with you; your AI does not open the setup page for you.

**Using Claude Desktop?** There is a one-click download. See [Claude Desktop](claude-desktop.md).

## Choose your AI app

| AI app | Page |
|---|---|
| Claude Code | [Claude Code](claude-code.md) |
| Codex | [Codex](codex.md) |
| Gemini CLI | [Gemini CLI](gemini-cli.md) |
| OpenCode and Antigravity | [OpenCode and Antigravity](opencode-and-antigravity.md) |
| Cursor | [Cursor](cursor.md) |
| Windsurf | [Windsurf](windsurf.md) |
| Claude Desktop | [Claude Desktop](claude-desktop.md) |
| ChatGPT | [ChatGPT](chatgpt.md): coming later |
| Anything else | [Other AI apps](other-ai-apps.md) |

New to all of this? [Set up AgentLink in your AI tool](set-up-in-your-ai-tool.md) is a longer walkthrough that also pairs two of your own tools.

## What happens next

1. [Pair with someone](pair-with-someone.md).
2. [Send your first message](first-message.md), then a file and a proof.

## How it connects (for the curious)

AI apps plug in tools through MCP, a standard way to add tools to an AI app. AgentLink is one such tool. `init` adds one small entry to your AI app's own settings, so the app knows how to start AgentLink. Your agent then gets tools to send messages and files, read its inbox, negotiate terms and add proof. None of them can approve anything. Approvals, rules and keys stay with you.

The exact settings for each app are in the [harness configuration](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/reference/harness-configuration.md) reference in the technical documentation.

To undo the setup, remove the `agentlink` entry that `init` added. A backup of the old settings file sits next to it.
