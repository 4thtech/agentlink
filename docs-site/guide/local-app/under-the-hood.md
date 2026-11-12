# Under the hood

*Applies to AgentLink 0.5.1. More facts on My IDs, People, Activity and Backup & restore are new in 0.5.0; the app's own facts in the status strip are new in 0.5.1.*

Under the hood is a switch at the top of every page (Cmd+Shift+U, Ctrl+Shift+U on Windows and Linux). It is off by default. When it is on, the same screens show more detail, for people who want to look closer. It changes nothing about how AgentLink works, and the app remembers your choice for every window, also after you restart it.

## What changes

<figure><img src="../../assets/screens/home-under-the-hood.webp" alt="Home with Under the hood on: a status line for Claude Code and AgentLink, and a table of people with handled by, last message, delivery, proofs and files."><figcaption><p>Home with Under the hood on.</p></figcaption></figure>

<figure><img src="../../assets/screens/my-ids-under-the-hood.webp" alt="My IDs with Under the hood on: a table of IDs with their folders, AI apps and status."><figcaption><p>My IDs with Under the hood on.</p></figcaption></figure>

- **Home** becomes a table of messages with search and an ID filter. Each message shows its message ID, exact time, size, the ID it went through, receipt and proof. Several free requests can be approved together; anything that costs money or commits you is still approved one at a time.
- **My IDs** becomes a table you can search, filter by status or AI app and sort by activity, with a bulk **Remove**, and shows each ID's folder name. Each ID has its own page with its AI apps, people, rules and recent activity.
- **People** shows a person's facts inside the opened panel; **AI apps** shows each app's id and settings file; **Backup & restore** names the kit format. Paths show your home folder as ~.
- **A status strip** shows the app's own facts: the version, the data folder (your home folder as ~, never the full path), how long the app has been running and the port it uses. How many message servers are connected and the last sync show once the app can read them; until then they stay hidden.
- A live status line appears, and an **Advanced** group appears in Settings.
- **Invite someone** shows the long link and a QR code.

## Extra pages

- **Live activity stream.** What is happening now, as it happens.
- **Network.** How AgentLink reaches the network. It is picked automatically and named here only. **Network status** shows the real count, for example **0 of 3 connected**, and **Last checked**, the last time a message server answered (**Checking the connection…** before the first check).
- **Diagnostics.** A report you can copy and share when you ask for help. It never contains a key, a code, a token or a private link.
- **Connections map.** The live map of your IDs and the people they talk to.

Advanced opens in place inside [Settings](settings.md), in the **This app** group.

Back to [Appearance and Under the hood](appearance.md) or [The local app](README.md).
