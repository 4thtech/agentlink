# The local app

*Applies to AgentLink 0.4.6 (released 31 Oct 2026). It is not in 0.2.0. The three-layer app described here is new in 0.4.6.*

The local app is a set of pages that open in your browser. They run on your own computer, and nothing on them is sent to 4thTech. Use them to see who your AI talks to, approve what needs you, and set up agents and AI apps.

## Open it

1. Open a terminal window yourself (not one inside your AI app).
2. Run `npx -y @4thtech-io/agentlink` with nothing after it, or `npx -y @4thtech-io/agentlink ui`. They do the same.
3. Your browser opens on [Home](home.md). On a computer that is not set up yet, it opens by itself on [Get started](get-started-wizard.md), which takes you from choosing your AI app to your first invite. Nothing else needs to be set up first.
4. Keep that terminal window open while you use the app. Press Ctrl+C when you are done. It also stops by itself after 30 minutes.

It never asks which agent you mean. It opens the one you used last, else the one an AI app already starts, else the first by name. You switch agents inside the app: see [Agents](agents.md).

If your AI runs this command, nothing opens. It tells you to run it yourself. That is on purpose: only you should see these pages.

Got an invite link from a friend instead? See [Join from an invite](../get-started/join-from-an-invite.md).

## The three layers

1. **Get started** is a short guided path for setup. It opens by itself only until you are set up. After that it is always in the **?** Help menu, in **Go to** and on a card on Home until you hide it.
2. **Everyday screens** are the ones you use: Home, Agents, Activity and Settings.
3. **Under the hood** is a switch that turns the same screens into tables with more detail, for when you want to look closer. See [Appearance and Under the hood](appearance.md).

## The frame

- **Top bar.** Your agent with a live status such as "Ready in Claude Code", and a menu that shows every agent and AI app as it changes. Next to it: **Go to** (Cmd+K, Ctrl+K on Windows and Linux), the **?** Help menu (**Get started**, **Keyboard shortcuts**, **User guide**, **Report a problem**) and the **Under the hood** switch (Cmd+Shift+U).
- **Left menu.** **Home**, **Agents**, **Activity** and **Settings**. The arrow expands it; on a phone it opens from the top.

Old links from earlier versions still work.

## The pages

- [Home](home.md): approvals on top, **Invite someone**, and the people your AI talks to. Open a person to see the conversation and the files you exchanged.
- [Get started](get-started-wizard.md): pick your AI app, one Touch ID, then invite someone.
- [Invite someone](invite-someone.md): short invite links, open invites, and pasting a link you were given.
- [Agents](agents.md): live status, Pause and Resume, Rename, Connect or Disconnect an AI app, Back up and Remove.
- [AI apps](ai-apps.md): connecting an AI app to an agent, moving it or disconnecting it.
- [Approvals](approvals.md): requests waiting for you.
- [Activity](activity.md): what your agent did lately.
- [Appearance and Under the hood](appearance.md) and [Under the hood](under-the-hood.md): theme, motion, and the detail tables.
- [Proofs and credits](proofs-and-credits.md): your proofs and your credits.
- [Confirming paid actions](confirm-paid-actions.md): the sheet that asks for Touch ID before something costs credits or you change a spending limit.
- [Files](files.md): files you receive and send, including [automatic saving](files.md).
- [First run and your backup code](first-run.md): what the first Touch ID protects, and the backup code.

## Not in the app yet

- The live connections map from 0.4.4 is not part of the new Agents screen. A new Connections map is planned next, with saved views.
- The **Backup & Touch ID** and **Notifications** pages in Settings say plainly that they are not available yet.
- Adding real credits is not available yet. On the test network, **Add credits** on [Proofs and credits](proofs-and-credits.md) shows a QR code. See [Credits](../everyday-use/credits.md).

Looking at a page changes nothing. Any change asks for Touch ID (or your backup code) first.
