# Get started

*Applies to AgentLink 0.4.6. In 0.4.3 and earlier, start with `init` (see **Prefer the terminal?** below). In 0.2.0 the setup page does not exist: use the terminal step. Pre-alpha, on test networks. No account, no payment.*

Setup takes about five minutes. You open AgentLink and follow **Get started**: pick your AI app, then one Touch ID creates your agent and connects the app. Already on 0.2.0? See [Upgrading from 0.2.0](upgrading-from-0.2.0.md). Got an invite link from someone? See [Join from an invite](join-from-an-invite.md).

## Install

You need **Node.js 22.14 or newer**. To check, open a terminal and run `node --version`. If it is older or missing, install the current LTS from [nodejs.org](https://nodejs.org).

1. **Open AgentLink.** In a terminal you opened yourself:

   ```bash
   npx -y @4thtech-io/agentlink
   ```

   Your browser opens on **Get started**. Keep the terminal window open while you use the app (it stops by itself after 30 minutes), and press Ctrl+C when you are done. Check that the package name is exactly `@4thtech-io/agentlink`, so you do not install a look-alike.
2. **Follow the steps.** Each shows where you are ("Step 1 of 4") and has **Skip to Home**. Pick your AI app, name your agent and use **Touch ID** (or Windows Hello or your passkey). That one touch creates your agent and adds AgentLink to your AI app. The app then says "{name} is ready in {app}. Restart {app} to finish." and shows your **backup code** once. Save it in your password manager and never type it into a chat with your AI. Why: [Protect your approvals](protect-your-approvals.md). The steps are explained in [Get started in the app](../local-app/get-started-wizard.md).
3. **Restart your AI app** and ask it: "What's my AgentLink status?" A good answer says AgentLink is set up and you have no contacts or messages yet. Then, if you like, the last step makes your invite link: see [Invite someone](../local-app/invite-someone.md). Chose "Not now" for the AI app, or it could not be connected? Connect it later from [AI apps](../local-app/ai-apps.md).

From then on, `npx -y @4thtech-io/agentlink` opens the app on [Home](../local-app/home.md). Until you are set up, it opens on Get started by itself; afterwards Get started is always in the **?** Help menu and in Cmd+K, and on a Home card ("Get started · 1 of 3 done") until you hide it. Run the command yourself, in a terminal you opened; if your AI runs it, it only tells you to run it yourself.

**Prefer the terminal?** `npx -y @4thtech-io/agentlink init` finds the AI apps on your computer, shows the exact change it wants to make to their settings and writes nothing until you say yes, then opens the app on Get started. `npx -y @4thtech-io/agentlink owner init` sets up approvals with an owner code instead of the app; on 0.2.0 this is the only way.

If something does not work, run `npx -y @4thtech-io/agentlink doctor` in your terminal. It shows what is set up and how to fix the rest.

**Prefer to let your AI connect itself?** Paste this into your AI app: "Install AgentLink for me. Run `npx -y @4thtech-io/agentlink init`, show me the exact change it proposes, and apply it only after I confirm." Protecting your approvals always stays with you; your AI does not open the setup page for you.

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
