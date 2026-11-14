# AI apps page

*Applies to AgentLink 0.5.5. In 0.4.3 an AI app is connected from the terminal with `init`.*

The AI apps page shows the AI apps AgentLink found on your computer, such as Claude Code, and which ID each one works with. From here you connect an app, move it to another ID, or disconnect it. Nothing else in the app's settings file is touched.

Open it from **Connect** on an ID in [IDs](ids.md), or from [Get started](get-started-wizard.md). Getting started connects the AI app you pick for you, with the same one Touch ID that creates your ID.

Each app on the list shows which ID it uses now: **Uses** the ID's name, **Uses a removed ID**, or **Set up by hand**. An app that is open at the moment says **Open now**. Claude Code in a terminal is listed as **Claude Code CLI**. Claude Code run inside the Claude app (its Code tab) shows as **Claude Code**, not "Another AI app". An app that is connected stays green with "Connected", even when it has made no request for a while. If you pick an app that another ID uses, the confirm screen tells you before Touch ID: the app will use the new ID instead of the old one. A removed ID is also removed from your AI apps.

## Connect an AI app

1. Choose **Connect** and pick the app.
2. AgentLink shows the exact entry it will add, and the file it goes in. It says: **This adds one entry to** the app's **settings.** Nothing else in that file changes.
3. Press **Apply with Touch ID**.
4. If the app is open, the page says **Restart** the app **to finish**. AgentLink never restarts it for you.

A backup of the file is saved next to it first, with the same permissions. The ID folder the entry starts is named on the screen.

## Move it to another ID

Each AI app works with one ID at a time. If an app is connected to another ID, it shows **Uses another ID** and you are offered **Use** this ID **instead**. You see which entry goes and which comes, then confirm with Touch ID. The page says: the app **will use** the new ID **instead of** the old one.

## Disconnect

**Disconnect** removes the entry AgentLink added, with Touch ID, after showing it. The app then **will stop using** the ID. Your ID, contacts and messages stay.

## When it can't be done

- **Quit** the app **first.** Claude Desktop rewrites its settings when it closes, so AgentLink never changes them while it is open. Close it, then **Check again**.
- **This app already has an AgentLink entry we didn't write.** AgentLink does not change it. Connect by hand with **Show manual steps** if you want to.
- **Not listed? Connect it by hand** shows what to add yourself. Nothing there is run by AgentLink. **Connect by hand** names the exact settings file, with a **Copy path** button.

Whether an app is **Working**, **Ready**, **Idle**, **Not running** or **Not set up** shows live; see [IDs](ids.md#live-status).

An AI app can only change what the page shows. Your AI cannot rewire itself: this needs your Touch ID.

Back to [The local app](README.md).
