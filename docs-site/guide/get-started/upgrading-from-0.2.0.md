# Upgrading from 0.2.0

*Applies to AgentLink 0.4.6 (released 31 Oct 2026), 0.4.4 (29 Oct 2026) and 0.4.3 (28 Oct 2026). `npx` gives you the newest version.*

You already use AgentLink 0.2.0. Moving to 0.4.6 ([release notes](https://github.com/4thtech/agentlink/releases/tag/v0.4.6)) keeps your agent, your contacts and your owner code. There is nothing to export or import.

## What to do

1. Open a terminal window yourself (not one inside your AI app).
2. Run `npx -y @4thtech-io/agentlink@latest init`. The `@latest` makes sure you get the newest version rather than one `npx` kept from before. It reuses the agent you already have and shows the exact change it wants to make to your AI app's settings. Nothing is written until you say yes. If your AI app's settings already have the `agentlink` entry, nothing needs to change.
3. Restart your AI app, then ask it: "What's my AgentLink status?"
4. To see the local app, run `npx -y @4thtech-io/agentlink` yourself (`ui` does the same). Your browser opens on Home (or on Get started, until you are set up). Press Ctrl+C when you are done. See [The local app](../local-app/README.md).

## What stays the same

- **Your agent and your contacts.** `init` reuses the agent you have and never makes a second one by itself. The stored data is not migrated: 0.4.6 reads it as it is.
- **Your owner code.** If you set up an owner with 0.2.0, you keep using your owner code to approve. Nothing resets it. Keep it where you keep it now.
- **Your rules.** They are not changed.

## What is different for you

- **Switching to Touch ID.** The first-run page is for a new setup and does not open for a computer that already has an owner. In 0.4.0 the local app shows **Switch to Touch ID** (or Windows Hello, or a passkey). It asks for your owner code once, then one touch. Your agent keeps the same owner, and the code keeps working as your backup code.
- **Sending files.** The `AgentLink/Send` folder is where your AI may send files from. If your AI says no folder is allowed, run `npx -y @4thtech-io/agentlink policy allow-send-folder` in your own terminal. It creates the folder if it is missing and asks for your owner code. It adds only that folder. If your rules still have delivery receipts on from an older default, it asks about them first and turns them off unless you choose to keep them; rules made by 0.2.0 already have them off, so this only affects older rules. See [Folders for sending files](../everyday-use/allowed-folders.md).
- **New in 0.3.0.** The [local app](../local-app/README.md), first as separate pages for Activity, Proofs and credits (add test credits by QR code, withdraw credits), Contacts, Files and Rules, and a plainer approval page.
- **New in 0.4.0.** Messages, Files tabs for what you received and sent, a status bar, a confirmation sheet for paid actions, and a notice when you paired twice with the same person.

## Upgrading to 0.4.3 and later

The first time 0.4.3 or a later version runs, it upgrades your local data. After that, older versions can't open it, so you can't go back to 0.3.x. Your contacts, messages and files are kept.

## Upgrading to 0.4.4

You do not have to do anything. `npx -y @4thtech-io/agentlink` (or `ui`) opens the app on your newest version.

- **All your agents are there.** Every agent folder that 0.4.3 left on your computer is listed on the [Agents page](../local-app/agents.md), under the name it had. None is lost, renamed or changed by the update.
- **Switching shows each one's own history.** Pick an agent in the top bar and its contacts, messages and files are the ones it had. Switching asks for no Touch ID.
- **No question in the terminal.** The terminal no longer asks which agent you mean. The app opens the one you used last, else the one an AI app already starts, else the first by name; `--agent <name>` still works if you want to choose.
- **Your AI apps keep working.** Their settings are not touched by the update. Connect, move or disconnect them later from [AI apps](../local-app/ai-apps.md).

## Upgrading to 0.4.6

You do not have to do anything. Your agents, contacts, messages and files are kept, and old links to app pages still work. What looks different:

- **A new three-layer app.** Home is the first screen: approvals waiting for you, Invite someone, and the people your AI talks to. The left menu is Home, Agents, Activity and Settings. The old Start here checklist is replaced by [Get started](../local-app/get-started-wizard.md), which is always in the **?** Help menu. See [The local app](../local-app/README.md).
- **Under the hood.** The tables, message IDs, exact times and receipts moved behind one switch (Cmd+Shift+U). See [Under the hood](../local-app/under-the-hood.md).
- **Received files are saved for you.** Files from contacts you keep go to `~/AgentLink/Inbox` by themselves. A file that is not saved reads "Arrived · not saved" with **Save to Inbox**.
- **Pause.** One click on Agents stops an agent in every AI app. Resume asks for Touch ID.
- **Short invite links.** New invites are under 80 characters. Older long links still work.

## If something does not work

Run `npx -y @4thtech-io/agentlink doctor` in your terminal. It shows what is set up and how to fix the rest. More help: [Troubleshooting](../help/troubleshooting.md).

<details>
<summary>For the technically curious</summary>

| On this page | What the code does | Where it is built |
|---|---|---|
| `init` reuses your agent | An existing agent is always reused; a new one is created only on a computer with none | [`apps/cli/src/commands/init.ts`](https://github.com/4thtech/agentlink/blob/main/apps/cli/src/commands/init.ts) `defaultAgentName` |
| The first-run page does not open for an existing owner | Owner setup is offered only while no owner exists anywhere (no card, no owner keychain item, no other agent folder) | [`apps/cli/src/mcp/local-ui-wiring.ts`](https://github.com/4thtech/agentlink/blob/main/apps/cli/src/mcp/local-ui-wiring.ts), [`apps/cli/src/commands/first-run.ts`](https://github.com/4thtech/agentlink/blob/main/apps/cli/src/commands/first-run.ts) |
| Your data is read as it is | The store schema version is unchanged since 0.2.0 | `STORE_SCHEMA_VERSION` in `@4thtech-io/core`, [`packages/node/src/sqlite-schema.ts`](https://github.com/4thtech/agentlink/blob/main/packages/node/src/sqlite-schema.ts) |
| Touch ID for 0.2.0 owners | Backlog card M1-UX-FIRSTRUN-V2-c, not built | [`docs/process/backlog.md`](https://github.com/4thtech/agentlink/blob/main/docs/process/backlog.md) |
| `policy allow-send-folder` | Adds only `~/AgentLink/Send` to the rules, through an owner operation | [`packages/node/src/owner-send-folder.ts`](https://github.com/4thtech/agentlink/blob/main/packages/node/src/owner-send-folder.ts) |

</details>

Back to [Get started](README.md).
