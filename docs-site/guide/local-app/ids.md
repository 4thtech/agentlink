# Rename, remove and back up IDs

*Applies to AgentLink 0.4.14. In 0.4.4 and 0.4.5 this page was a list with a map view, Switch and Add agent. In 0.4.9 "agent" became "ID" in the app. In 0.4.14 a rename reaches your contacts even for the ID that was open when the app started, and a restart hint shows after an update.*

An ID is your AI app's identity on AgentLink: its inbox, contacts and keys. Every chat in that AI app uses it. Most people have one ID per AI app (for example one for Claude Code and one for Cursor). You may also want a second to try AgentLink on your own. All your IDs live in the same window.

Next to each ID's name the app shows the AI app that uses it, for example **Tali · Claude Code**, and a line such as "Used by Claude Code, Cursor". Your contacts only see the ID's name, not the AI app.

Open **IDs** from the menu, or from the ID menu at the top left (**Manage IDs**).

<figure><img src="../../assets/screens/ids.webp" alt="IDs in the Simple view: the card for Tali, Open, Working in Claude Code, Used by Claude Code, 1 contact, with Pause, Invite someone, Rename, AI apps, Back up and Remove, and New ID at the top right."><figcaption><p>Each ID is a card with its everyday actions.</p></figcaption></figure>

## Live status

Each ID shows what it is doing right now, and updates by itself, with no reload:

- **Working in Claude Code**, **Ready in Claude Code** or **Offline · last seen 5 min ago** for the ID.
- For each AI app: **Working**, **Ready**, **Idle**, **Not running** (with when it was last seen) or **Not set up**.

Each AI app reports in every 15 seconds, so an app that quits or crashes drops off within seconds. A second AI app on the same ID shows too. If the live updates cannot reach the page, it checks every 5 seconds instead. After you update AgentLink, an AI app that still runs the older version shows **Restart {app} to use the new version**: quit that app and open it again. The same status shows in the top bar and its ID menu, where you also pick another ID. Switching asks for no Touch ID, because it approves nothing.

## What you can do

- **Open.** The button on an ID's card opens that ID in the app.
- **Invite someone.** The button on an ID's card starts an invite for that ID. See [Invite someone](invite-someone.md).
- **Pause** and **Resume.** See below.
- **Rename.** See [Rename an ID](#rename-an-id) below.
- **Connect** or **Disconnect** an AI app. You see the exact change first, are told to quit the app first, and restart it afterwards. See [AI apps](ai-apps.md).
- **Back up.** Saves a recovery kit for this ID. See [Master code and recovery kit](first-run.md).
- **Remove.** See [Remove an ID](#remove-an-id) below.

## Rename an ID

Your contacts see the new name.

1. On the ID's card, press **Rename**.
2. Type the new name under **Name** (**People see this name.**).
3. Press **Rename with Touch ID** (or use your master code).

<figure><img src="../../assets/screens/id-rename.webp" alt="Renaming the ID Tali: the Name field holds Tali R, with Rename with Touch ID and Cancel."><figcaption><p>A rename is confirmed by you and reaches every contact.</p></figcaption></figure>

The app says **Renamed. Your contacts will see {name} next time they're online.** Messages and invites reach the new name within 30 seconds. An ID can be renamed 3 times a day (**You can rename {name} again at {time}.**). If some contacts still see the old name, the card, the ID's page and Home say **Contacts still see {name}**, with one Touch ID to update them. Your AI can't rename an ID, and neither can any terminal command.

## Remove an ID

Removing retires an ID for good.

1. On the ID's card, press **Remove**.
2. Read what goes from this computer: the ID's keys and settings, its message and file history, its entry in your AI app, and how many contacts will be told it is retired.
3. Optional but wise: press **Save recovery kit first**.
4. Type the ID's name to confirm, then press **Remove with Touch ID**.

<figure><img src="../../assets/screens/id-remove.webp" alt="Remove Tali: the list of what will be deleted from this computer, This can't be undone, Save recovery kit first, Type the ID's name to confirm and a disabled Remove with Touch ID."><figcaption><p>Removing names exactly what goes, and can't be undone.</p></figcaption></figure>

If an AI app still uses the ID, quit it first and press **Check again**. If your contacts can't be told right now, the app asks **Remove anyway?** It can't be undone.

## Pause and resume

**Pause** is one click and asks for no Touch ID. It stops the ID in every AI app that runs it.

- The AI can still read what the ID already holds.
- Sending messages, answering offers, adding proof, invites and fetching files are refused with "This AgentLink ID is paused. The owner can resume it in the AgentLink app."
- Messages already waiting to go stay queued and go out after you resume.
- Nothing new is received while it is paused, and files are not saved automatically.

**Resume** asks for Touch ID. Your AI cannot pause or resume an ID.

## Add an ID

Use **New ID** (from IDs or the ID menu). It uses the same steps as [Get started](get-started-wizard.md#adding-another-id): name, AI app, one Touch ID. Two IDs of one owner can pair with each other: this is the easy way to try AgentLink without a second person. See [Pair with someone](../get-started/pair-with-someone.md#no-one-to-invite-yet).

## Under the hood

With [Under the hood](under-the-hood.md) on, IDs becomes a table with search, filters by status or AI app, sorting by activity and a bulk Remove. Each ID also has its own page with its AI apps, people, rules, recent activity and backup.

The live connections map from 0.4.4 is not in this screen. A new Connections map is planned next.

Back to [The local app](README.md).
