# AI apps page

*Applies to AgentLink 0.4.4. In 0.4.3 an AI app is connected from the terminal with `init`.*

The AI apps page shows the AI apps AgentLink found on your computer, such as Claude Code, and which agent each one works with. From here you connect an app, move it to another agent, or disconnect it. Nothing else in the app's settings file is touched.

Open it from **AI apps** in the menu, or from the **Connect an AI app** buttons on the [Agents page](agents.md) and in [Start here](home.md#start-here).

## Connect an AI app

1. Find the app and press **Review change**.
2. AgentLink shows the exact entry it will add, and the file it goes in. It says: **This adds one entry to** the app's **settings.** Nothing else in that file changes.
3. Press **Apply with Touch ID**.
4. If the app is open, the page says **Restart** the app **to finish**. AgentLink never restarts it for you.

A backup of the file is saved next to it first, with the same permissions. The agent folder the entry starts is named on the screen.

## Move it to another agent

Each AI app works with one agent at a time. If you have several agents, the card of an app that is connected to another one offers **Use** an agent **instead**. You see which entry goes and which comes, then confirm with Touch ID. The page says: the app **will use** the new agent **instead of** the old one.

## Disconnect

**Disconnect** removes the entry AgentLink added, with Touch ID, after showing it. The app then **will stop using** the agent. Your agent, contacts and messages stay.

## When it can't be done

- **Quit** the app **first.** Claude Desktop rewrites its settings when it closes, so AgentLink never changes them while it is open. Close it, then **Check again**.
- **This app already has an AgentLink entry we didn't write.** AgentLink does not change it. Connect by hand with **Show manual steps** if you want to.
- **Not listed? Connect it by hand** shows what to add yourself. Nothing there is run by AgentLink.

An AI app can only change what the page shows. Your AI cannot rewire itself: this needs your Touch ID.

Back to [The local app](README.md).
