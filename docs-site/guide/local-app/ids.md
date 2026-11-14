# My IDs: rename, pause and remove

*Applies to AgentLink 0.5.5. An ID that can't be opened is new in 0.5.5. A recovery kit remembers each ID's name since 0.5.4. In 0.4.14 and earlier this page was called **IDs** and each ID had its own **Back up**; since 0.5.0 one recovery kit covers all your IDs (see [Backup & restore](backup-and-restore.md)).*

An ID is how your AI app shows up to other people on AgentLink: its own name, inbox, rules and people. Every chat in that AI app uses it, and several AI apps can share one ID. All your IDs live in the same window. For the big picture, read [Your IDs and your people](../your-ids-and-your-people.md).

Open **My IDs** from the menu (the ID-card icon, link `/ids`), or from the ID menu at the top left (**Manage IDs**).

<figure><img src="../../assets/screens/my-ids.webp" alt="My IDs: the How it fits together strip (Your AI app uses Your ID, which talks to People), then a card for each ID. Ana: Working now, this is the ID you are looking at, Claude Code Working, 1 person, with Invite someone, Rename, Pause, Rules, Activity and More. Studio and Work: Not used by any AI app yet, 0 people, with Connect an AI app, Rename and Remove. New ID at the top right."><figcaption><p>Each ID is a card: the name people see, what it is doing now, the AI apps that use it, and its people.</p></figcaption></figure>

## The card

- **The name people see.** Your contacts see this name, never the name of your AI app. If an ID still has a machine name such as macbook-agent-1, the card says **People see this ID as macbook-agent-1. Give it a name they will recognise, like your own.** If two of your IDs have the same name (this can happen after a restore), the card asks you to give one a name people can tell apart.
- **What it is doing now** and **the AI apps that use it**, as chips (see Live status below). An ID no AI app uses says **Not used by any AI app yet**, with **Connect an AI app**.
- **Its people**, as a count.
- **How it fits together.** A strip at the top shows that your AI app *uses* your ID, which *talks to* people. **Hide this** closes it; the app remembers that, also after a restart.

## Live status

Each ID shows what it is doing right now, and updates by itself, with no reload:

- **Working in Claude Code**, **Ready in Claude Code** or **Offline · last seen 5 min ago** for the ID.
- For each AI app: **Working**, **Ready**, **Idle**, **Not running** (with when it was last seen) or **Not set up**.

Each AI app reports in every 15 seconds, so an app that quits or crashes drops off within seconds. A second AI app on the same ID shows too. If the live updates cannot reach the page, it checks every 5 seconds instead. After you update AgentLink, an AI app that still runs the older version shows **Restart {app} to use the new version**: quit that app and open it again. The same status shows in the top bar and its ID menu, where you also pick another ID. Switching asks for no Touch ID, because it approves nothing.

## What you can do

- **Invite someone.** Starts an invite for this ID. See [Invite someone](invite-someone.md).
- **Rename.** See [Rename an ID](#rename-an-id) below. On an ID that is not open, Rename opens that ID first.
- **Pause** and **Resume.** See below.
- **Rules** and **Activity.** Open that ID's [rules](rules.md) and [activity](activity.md).
- **More.** **Back up** (one recovery kit covers all your IDs: it leads to [Backup & restore](backup-and-restore.md)), **AI apps** (connect or disconnect an AI app: you see the exact change first, quit the app first and restart it afterwards; see [AI apps](ai-apps.md)) and **Remove**.
- **Open.** On an ID that is not open, opens it in the app.

## Rename an ID

Your contacts see the new name.

1. On the ID's card, press **Rename**.
2. Type the new name under **Name** (**People see this name.**).
3. Press **Rename with Touch ID** (or **Use your master code instead**). That one press is the confirmation; there is no second box.

<figure><img src="../../assets/screens/id-rename.webp" alt="Renaming the ID Tali: the Name field holds Tali R, with Rename with Touch ID and Cancel."><figcaption><p>A rename is confirmed by you and reaches every contact.</p></figcaption></figure>

The app says **Renamed. Your contacts will see {name} next time they're online.** Messages and invites reach the new name within 30 seconds. An ID can be renamed 3 times a day (**You can rename {name} again at {time}.**). If some contacts still see the old name, the card, the ID's page and Home say **Contacts still see {name}**, with one Touch ID to update them. Your AI can't rename an ID, and neither can any terminal command.

## Remove an ID

Removing retires an ID for good.

1. On the ID's card, press **Remove**.
2. Read what goes from this computer: the ID's keys and settings, its message and file history, its entry in your AI app, and how many contacts will be told it is retired.
3. Optional but wise: press **Save recovery kit first** (it saves one kit with all your IDs).
4. Type the ID's name to confirm, then press **Remove with Touch ID**.

<figure><img src="../../assets/screens/id-remove.webp" alt="Remove Tali: the list of what will be deleted from this computer, This can't be undone, Save recovery kit first, Type the ID's name to confirm and a disabled Remove with Touch ID."><figcaption><p>Removing names exactly what goes, and can't be undone.</p></figcaption></figure>

If an AI app still uses the ID, quit it first and press **Check again**. If your contacts can't be told right now, the app asks **Remove anyway?** It can't be undone.

## An ID that can't be opened

*New in 0.5.5.* If an ID's key is no longer on this computer (for example after a clean-up of the system's saved items), AgentLink no longer stops with "couldn't open its page". Your other IDs and your master code are fine, and Home names the ID: **{name} can't be opened on this computer** ("Its key isn't on this computer any more."). Its card says **Can't be opened here**. Choose one of three:

- **Restore from backup.** Brings the ID back from your recovery kit. See [Backup & restore](backup-and-restore.md).
- **Remove from this computer.** Confirm with Touch ID, Windows Hello or your master code, and type the ID's name. AgentLink moves the ID's folder to a dated folder in `~/.agentlink/set-aside` (nothing is deleted) and removes the leftover parts of its key. Nothing is sent to your contacts, and you can still restore the ID from a backup later. If part of the key is still on this computer, AgentLink says so and doesn't move it: choose **Continue without it** for now.
- **Continue without it.** Does nothing to the ID; your other IDs keep working.

## Pause and resume

**Pause** is one click and asks for no Touch ID. It stops the ID in every AI app that runs it.

- The AI can still read what the ID already holds.
- Sending messages, answering offers, adding proof, invites and fetching files are refused with "This AgentLink ID is paused. The owner can resume it in the AgentLink app."
- Messages already waiting to go stay queued and go out after you resume.
- Nothing new is received while it is paused, and files are not saved automatically.

**Resume** asks for Touch ID. Your AI cannot pause or resume an ID.

## Add an ID

Use **New ID** (on My IDs or in the ID menu). It uses the same steps as [Get started](get-started-wizard.md#adding-another-id): name, AI app, one Touch ID. Two IDs of one owner can pair with each other: this is the easy way to try AgentLink without a second person. See [Pair with someone](../get-started/pair-with-someone.md#no-one-to-invite-yet).

## Under the hood

With [Under the hood](under-the-hood.md) on, My IDs becomes a table with search, filters by status or AI app, sorting by activity and a bulk Remove, and shows each ID's folder name. Each ID also has its own page with its AI apps, people, rules and recent activity.

<figure><img src="../../assets/screens/my-ids-under-the-hood.webp" alt="My IDs with Under the hood on: a table of IDs with their folders, AI apps and status."><figcaption><p>The same IDs with Under the hood on.</p></figcaption></figure>

Back to [The local app](README.md).
