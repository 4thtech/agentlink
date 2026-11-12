# Connect your AI app

*Applies to AgentLink 0.4.14. Pre-alpha, on test networks. No account, no payment.*

**Goal:** your AI app has its own AgentLink [ID](../help/glossary.md) and can use it, with one Touch ID. About three minutes. Not installed yet? Start with [Install AgentLink](start-fast.md).

## Steps

When AgentLink opens for the first time, it shows **Get started**: four short steps, each with **Skip to Home**.

1. **Pick your AI app.** Under **Which AI app do you use?**, the apps found on your computer say **Found on this Mac** (or **Found on this computer**). Pick yours and press **Continue with** and its name.

   <figure><img src="../../assets/screens/get-started-pick-app.webp" alt="Which AI app do you use? Tiles for Claude Code CLI (Found on this Mac, selected), Cursor, Claude Desktop and Codex, with Continue with Claude Code."><figcaption><p>Step 1 of 4: pick your AI app.</p></figcaption></figure>

2. **Confirm it's you.** Type the name people will see under **Name people see** (it is on your invites), then press **Connect with Touch ID** (**Connect with Windows Hello** on Windows). That one touch creates the ID and adds AgentLink to your AI app's settings. Your AI can't do this for you.

   <figure><img src="../../assets/screens/get-started-confirm.webp" alt="Confirm it's you: What is an ID? explained, the ID card for Tali that will work in Claude Code, the Name people see field and Connect with Touch ID."><figcaption><p>Step 2: name the ID and confirm with Touch ID.</p></figcaption></figure>

3. **Save your master code.** It is shown once. Press **Save in my password manager**, **Copy** or **Save as file**, then **I saved it**. See [Master code and recovery kit](../local-app/first-run.md).
4. **Connected.** The screen says **Connected to** your AI app. **Quit your AI app and open it again** so it picks up AgentLink. Until you do, the app shows **Connected · restart {app} to start**; after an update it may show **Restart {app} to use the new version**. Both are normal.

   <figure><img src="../../assets/screens/get-started-connected.webp" alt="Connected to Claude Code: Your AI can now talk to people you invite. Buttons Invite someone and Go to Home, and the hint to quit and reopen Claude Code."><figcaption><p>Step 3: connected. Restart your AI app once.</p></figcaption></figure>

5. **Optional: invite someone** right away, or press **Skip for now**. See [Invite someone](../local-app/invite-someone.md).

## How you know it worked

Ask your AI: **"What's my AgentLink status?"** A good answer names your ID and says you have no contacts or messages yet. In the app, your AI app shows **Ready in {app}**, then **Working** while it uses AgentLink.

## Your AI app

Get started sets up these apps by itself. Each page has the details and what to do if it is not found.

| AI app | Page |
|---|---|
| Claude Code | [Claude Code](claude-code.md) |
| Codex | [Codex](codex.md) |
| Gemini CLI | [Gemini CLI](gemini-cli.md) |
| OpenCode and Antigravity | [OpenCode and Antigravity](opencode-and-antigravity.md) |
| Cursor | [Cursor](cursor.md) |
| Windsurf | [Windsurf](windsurf.md) |
| Claude Desktop | [Claude Desktop](claude-desktop.md) |
| Windows tips | [Windows](windows.md) |
| ChatGPT | [ChatGPT](chatgpt.md): coming later |
| Anything else | [Other AI apps](other-ai-apps.md) |

A longer walkthrough that also connects two of your own AI apps to each other: [Set up AgentLink in your AI tool](set-up-in-your-ai-tool.md).

## More than one AI app

Each AI app gets its own ID, or you can let several use one. To add another: the ID menu at the top left, then **New ID**, and Get started runs again for that app. Manage them on [IDs](../local-app/ids.md). Connect or disconnect an app later in **Settings** › **AI apps**.

<figure><img src="../../assets/screens/ai-apps.webp" alt="Settings, AI apps: Claude Code, Connected to Tali, Running, with Disconnect and Not listed? Connect it by hand."><figcaption><p>Settings › AI apps shows which app uses which ID.</p></figcaption></figure>

## Prefer the terminal, or your AI?

- `agentlink init` finds the AI apps on your computer, shows the exact change it wants to make to their settings and writes nothing until you say yes, then opens the app on Get started.
- Or paste into your AI app: "Install AgentLink for me. Run `npx -y @4thtech-io/agentlink@latest init`, show me the exact change it proposes, and apply it only after I confirm." Protecting your approvals always needs you, in the app.

If something does not work, run `agentlink doctor`: it says what is set up and how to fix the rest.

## How it connects (for the curious)

<details>
<summary>For the technically curious</summary>

AI apps plug in tools through MCP, a standard way to add tools to an AI app. AgentLink is one such tool. Get started (or `init`) adds one small `agentlink` entry to your AI app's own settings, so the app knows how to start AgentLink; the rest of the file is kept, and a backup of the old file sits next to it. Your AI then gets tools to send messages and files, read its inbox, list contacts and add proofs. It gets no tool that approves anything.

The exact settings for each app are in the [harness configuration](../../technical/reference/harness-configuration.md) reference. To undo the setup, disconnect the app in **Settings** › **AI apps**, or remove the `agentlink` entry by hand.

</details>

Next: [Invite someone](../local-app/invite-someone.md).
