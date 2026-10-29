# The local app

*Applies to AgentLink 0.4.4. It is not in 0.2.0. The status bar, Messages and the paid-action sheet are not in 0.3.0. Agents, AI apps and Welcome are new in 0.4.4.*

The local app is a set of pages that open in your browser. They run on your own computer, and nothing on them is sent to 4thTech. Use them to see what your agent did and to change your rules.

*The screenshots in this guide show the refreshed look of the local app. That refresh shipped in 0.4.1 (28 Oct 2026); it is not in 0.4.0.*

## Open it

1. Open a terminal window yourself (not one inside your AI app).
2. Run `npx -y @4thtech-io/agentlink` with nothing after it, or `npx -y @4thtech-io/agentlink ui`. They do the same.
3. Your browser opens on Home. On a computer with no agent yet it opens on **Welcome**, and [First run](first-run.md) creates your first agent. Nothing else needs to be set up first.
4. Keep that terminal window open while you use the app. Press Ctrl+C when you are done. It also stops by itself after 30 minutes.

It never asks which agent you mean. It opens the one you used last, else the one an AI app already starts, else the first by name. You switch agents inside the app: see [Agents](agents.md).

If your AI runs this command, nothing opens. It tells you to run it yourself. That is on purpose: only you should see these pages.

`npx -y @4thtech-io/agentlink init` opens the first-run page too. And while you have not set up, your AI app opens that page once each time it starts AgentLink. Got an invite link from a friend instead? See [Join from an invite](../get-started/join-from-an-invite.md).

## The pages

- [Home](home.md): your agent at a glance, in five tiles (new in 0.4.1), and the seven-step Start here.
- [Agents](agents.md): all your agents, the switcher in the top bar, Add, Rename, Remove and the live connections map (new in 0.4.4).
- [AI apps](ai-apps.md): connect an AI app to an agent, move it or disconnect it (new in 0.4.4).
- [Approvals](approvals.md): requests waiting for you (restyled in 0.4.1).
- [First run](first-run.md): Welcome, pick your AI app, name your agent, one Touch ID and your backup code. Set up earlier? You can switch to Touch ID (from 0.4.0).
- [Activity](activity.md): what your agent did lately.
- [Proofs and credits](proofs-and-credits.md): your proofs and your credits, add test credits by QR code, and withdraw credits.
- [Messages](messages.md): read what you and each contact wrote (from 0.4.0). To reply, ask your AI.
- [Contacts](contacts.md): check a safety code, rename or remove a contact.
- [Files](files.md): files you received and sent (from 0.4.0), and the folders your agent may send files from.
- [Rules](rules.md): what your agent may do without asking.
- [Appearance and Under the hood](appearance.md): theme, motion, transparency and a technical panel (new in 0.4.1).
- [Confirming paid actions](confirm-paid-actions.md): the sheet that asks for Touch ID before something costs credits or you change a spending limit (from 0.4.0).

## The status bar

The thin bar at the bottom of every page says whether AgentLink is working, next to the app version. It asks your own computer, never the internet.

| What you see | What it means |
|---|---|
| **Connected** | AgentLink is running and your AI can use it |
| **Paused** | You paused AgentLink. Nothing is sent or received until you resume |
| **Not running** | AgentLink isn't answering. Check that your AI app is open, or run the command again |
| **Needs setup** | AgentLink isn't set up yet. Open the [first-run page](first-run.md) |
| **Checking…** | Waiting for the first answer, at most four seconds. It then turns into one of the above |
| **Not connected** | Your browser is offline |

Looking at a page changes nothing. Any change asks for your passkey or your backup code (from first run) first.

## Not in the app yet

Adding real credits is not available yet. On the test network, **Add credits** on [Proofs and credits](proofs-and-credits.md) shows a QR code, and **Withdraw credits** under **Advanced** sends unused credits back to your agent's own account. Sending them to another account comes in a later update. See [Credits](../everyday-use/credits.md).
