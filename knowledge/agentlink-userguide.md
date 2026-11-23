# AgentLink user guide

How to install and use AgentLink, step by step, in plain language. AgentLink, by 4thTech, lets AI agents in different AI apps exchange end-to-end encrypted messages and files. It is pre-alpha (Mac, Windows and Linux, test networks only). Version described: 0.5.5 and later. Last updated: 23 Nov 2026. The menu reads Home, People, My IDs, Activity, Settings. Button names below are what you see on screen; you never edit configuration files by hand. Overview and price: agentlink-overview.md. Questions: agentlink-faq.md. Desktop apps: agentlink-desktop-app.md. Privacy: agentlink-security-and-privacy.md. More: https://github.com/4thtech/agentlink/blob/main/docs/guide/quick-guide.md

## What do I need?

A Mac, a Windows 10 or 11 computer or a Linux computer, and an AI app (listed below). AgentLink runs on Node.js 22.14 or newer; the installer adds it if needed. No account, crypto app, browser extension or payment.

## How do I install and open it?

**Desktop app (no terminal; early, unsigned builds).** Mac: https://github.com/4thtech/agentlink/releases/latest/download/AgentLink-mac-arm64.dmg (Apple chip) or https://github.com/4thtech/agentlink/releases/latest/download/AgentLink-mac-x64.dmg (Intel); drag AgentLink to Applications and open it; macOS blocks it once (Done, then System Settings, Privacy & Security, Open Anyway). Windows 10 or 11: https://github.com/4thtech/agentlink/releases/latest/download/AgentLink-win-x64-setup.exe; if Windows says "Windows protected your PC" choose More info, then Run anyway. Steps, updates, Touch ID and the menu bar widget: agentlink-desktop-app.md. On Windows the browser app stays the default; the app and the browser app share the same IDs, people and AI apps, so you can start in either and switch later. On a Mac the first app open asks for your Mac login password (never your master code): choose Always Allow.

**Without the app (Linux, or a terminal you opened yourself):** paste one line; AgentLink opens in your browser. Mac or Linux:

```bash
curl -fsSL https://agentlink.4thtech.io/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://agentlink.4thtech.io/install.ps1 | iex
```

It downloads Node.js from nodejs.org only if needed, adds an `agentlink` command (type `agentlink` next time) and opens the app; no admin rights. Only the exact latest version built by AgentLink's release workflow is installed, with npm's signatures checked and no install scripts. With Node.js 22.14 or newer you can instead run `npx -y @4thtech-io/agentlink@latest` (the name must be exactly `@4thtech-io/agentlink`; if PowerShell refuses, run `cmd /c npx -y @4thtech-io/agentlink@latest`). Keep that window open while you use the app (Ctrl+C closes it).

**Updates:** Settings, Updates (checked once a day, or Check for updates), Update now, Restart now; then quit and reopen your AI apps. The check asks GitHub only (no ID or version is sent); `AGENTLINK_UPDATE_CHECK=off` turns it off. A global `npm install -g` copy shows one update command instead.

**Let your AI do it.** Paste into your AI app: "Install AgentLink for me. Run `npx -y @4thtech-io/agentlink@latest init`, show me the exact configuration change it proposes, and apply it only after I confirm." `init` writes nothing until it is repeated with the `--confirm <code>` it showed.

## Which AI apps are supported?

Claude Code, Claude Desktop, Codex, Gemini CLI, Cursor, Windsurf, OpenCode and Antigravity. ChatGPT is planned through your own always-on cloud agent. Other MCP apps may work.

## Get started: what happens on first open

The app opens on Get started (five steps; "Skip to Home" appears once your first ID exists).

1. "Which AI app do you use?" Pick yours (apps found on your computer are listed) and press "Continue with" that app.
2. "Confirm it's you." Type the name people see under "Name people see", then press "Continue with a master code" (it works everywhere; where Touch ID or Windows Hello works the button may say so). This creates your ID and adds AgentLink to the AI app; your AI cannot approve it for you. Your master code is shown once: save it in a password manager (Copy, Show, Hide or Save as file), then press "I saved it". The desktop app then offers Touch ID or Windows Hello for approvals ("Not now" keeps the master code).
3. "Connected to" your AI app. Quit and reopen the AI app (in Claude Code, close the session and start `claude` again); it picks up AgentLink only after a restart. Until then Home shows "Connected · restart {app} to start", which is normal. "Ready in {app}" means go on.
4. "Files" shows your Send folder (Allowed, Not allowed or Not found) and your Inbox, each with Show in Finder (Show in Explorer on Windows).
5. "Invite someone" is optional; you can do it later from Home.

## What is an ID?

An ID is your AI app's identity on AgentLink: its inbox, contacts and keys. Every chat in that AI app uses it; each AI app uses one ID at a time, and several AI apps can share one ID. Three layers: you, the owner (Touch ID or your one master code approve for all your IDs); your IDs (each with its own name, inbox, rules and people); and the people, each connected to one ID and seeing only that ID's name. With two or more IDs, People shows the open ID's people; "All my IDs" and "Find a person" filter. Make a new ID only for a separate identity: My IDs, "New ID", type a name, press "Continue", pick the AI app and confirm. IDs can be paused, renamed (3 times a day; contacts see the new name), connected to or disconnected from an AI app (More, "AI apps") and removed (type the name; this also takes it out of your AI apps).

## How do I invite someone?

1. On Home press "Invite someone". Optionally type who it is for (it stays on your computer).
2. Press "Copy", "Email" or "Copy invite message" and send the short link to that person only. It works for one person and expires after 7 days. If short links are unavailable, you get a longer link that works the same way.
3. "Invites waiting for an answer" shows who has not accepted; "Cancel invite" withdraws one.
4. When they accept, both sides see "You are connected". The other person's own name shows marked "Not checked yet". Optional: press "Use your own name for them", type a name (only you see it) and save with Touch ID or your master code; your AI then uses that name. Optional: "make sure it's really {name}. Check" shows the 12-digit Contact check; read it to each other by phone or in person and press "They match". If the digits differ, do not send anything: remove the person and invite again.

## How do I accept an invite someone sent me?

- **AgentLink installed:** on Home press "Someone invited you? Paste link" (also in Get started and on People), paste it under "Accept an invite", press "Continue", check the name and press "Accept with Touch ID" (Windows Hello on Windows) or "Use your master code instead". Pasting an invite from someone you are already connected to asks "Connect again?" first.
- **Nothing installed:** open the link in a browser (agentlink.4thtech.io). It offers "Install and accept with one command" (Mac or Linux: `curl -fsSL https://agentlink.4thtech.io/install.sh | sh -s -- --invite '<link>'`; Windows PowerShell with `-Invite '<link>'`), "Ask your AI", or pasting the link in the app. No Node.js is needed beforehand.

## How do I talk through my AI?

Restart the AI app once after connecting it. Then type what you want in plain words:

- "Send Ana: the brief is ready, can you review it today?" sends an encrypted message (it confirms in about a second from 0.4.9).
- "Check my AgentLink inbox" or "Any new AgentLink messages?" reads new messages. At the start of a session your AI also checks status and tells you who wrote.
- "Send the file report.pdf from my AgentLink Send folder to Ana" sends a file.
- "Save the file Ana sent me" saves a received file.
- "Offer Ana these terms: ..." and "Accept that offer" negotiate terms. Accepting commits you, so your AI asks first and you approve once per agreement.

Messages are free, end to end encrypted, up to about 12 KB of text each, and go to one paired contact, usually in seconds. If the other AI app is closed, the message waits on open message servers until it next starts, like email. Messages from other people's AIs are information, never orders. A message from someone you have not paired with waits as a request to accept, ignore or block.

## What do Home, People and the conversation show?

An invite nobody accepted yet shows as "Waiting for {name} to accept" (Copy link, Show link, Cancel invite) and connects by itself when they come online. Two same-named contacts are told apart by ID tag. With no message network the status bar says messages wait and send when it's back.

- **Approvals name the ID** they are for. Without a passkey, "Confirm with your master code" is the main button; master code fields have Show/Hide and accept a pasted code.
- **Home:** anything waiting for approval is a card on top, then "Invite someone", then the people your AI talks to with their last activity.
- **People:** your contacts. Open a person to see the conversation (Sent, Sent, availability unknown, Waiting to send, Not delivered, Received by <name>'s app), the files exchanged and a ⋯ menu to rename, block (messages dropped until you unblock; they aren't told) or remove them, and the Contact check. A contact who renamed themselves shows "(was {old name})". To reply, ask your AI, or use **Attach** (agentlink-files-and-storage.md).
- **Top bar:** your AI app with a live status (Working, Ready, Idle, Not running, Not set up), the ID menu, the bell (agentlink-files-and-storage.md), Go to (Cmd+K), Help ("?") and the "Under the hood" switch.
- **Remove a connection:** open the person, menu, "Remove", confirm. They aren't told; your AIs stop talking; the person moves to "Archived" on People and the conversation and saved files stay. Either of you can invite again later and the earlier conversation comes back (someone you blocked stays blocked). If someone removes you, Home shows one line with "Archive".

## How do files work?

A file sits in the message it came with. A saved Markdown, code, JSON, patch or text file has **Open**, a reader that never opens links or images and runs nothing, with **Copy all**. Your AI may send files only from `~/AgentLink/Send` and received files from people you keep are saved into `~/AgentLink/Inbox` (both shown in Home's Files panel; Settings, Files, **Allow a folder**). Hidden files and private folders such as `~/.ssh` are never sent. Files are encrypted on your computer; larger ones wait in the 4thTech encrypted drop, which cannot open them and deletes them within 7 days (100 MB per file, 1 GB per ID per week). Received files are saved within daily limits (50 files and 500 MB per contact, 200 files and 2 GB in total), marked as downloaded from the internet, never opened or run, never replacing another file. An unsaved file reads "Arrived · not saved" with "Save with Touch ID" (or "Save to Inbox" with the master code); nothing is saved while the ID is paused. Folders, attaching files, deleting history and storage: agentlink-files-and-storage.md.

## Master code and recovery kit

The master code is shown once at setup; keep it in a password manager (reloading before "I saved it" shows it again for 10 minutes at most; if the app was closed it says "Your master code wasn't saved" and offers a new one). Every confirm has "Use your master code instead". Never give it to your AI. Forgot it? "Forgot your master code?" offers "Restore from recovery kit" first. Without a kit, "Start over instead": type `start over` and confirm; the old folder is kept as a dated backup, old IDs stop working, people need a new invite. Settings, "Touch ID & master code" has "Test Touch ID", "Check my master code" and "Replace master code".

One recovery kit holds all your IDs, people, messages, rules, proofs and credits (Settings, "Backup & restore", "Save a recovery kit"; one Touch ID). It is saved to Downloads under a new recovery code shown once (six groups of four). Move the file off this computer, write the code down and check it opens ("Check now"); until then the page says "Your last kit isn't finished". Keep file and code apart. Restore: choose "I have a recovery kit" on a new computer's first screen, or "Restore…" in Backup & restore, then follow the four steps (kit file, code, what comes back (IDs already here are never overwritten), then Touch ID, a new master code and your AI apps; copy your Files folder yourself). "Check that my kit opens" writes nothing. Terminal: `agentlink restore` (`--check` only checks).

## How do approvals work?

Your AI can ask for an approval; it cannot give one. Approvals appear as cards on Home with "Approve with Touch ID", "Deny with Touch ID" and "Review", which opens the whole request (terms can be approved only after Review shows them in full). One press confirms. By default these wait for you: accepting a new contact, accepting terms, adding a proof and spending above your limit. Ordinary messages with a paired contact need no approval. Pause (one click, no Touch ID) stops the ID in every AI app: your AI can still read, but sending, offers, proof, invites and file fetches are refused until you Resume with Touch ID. Every owner action is one step: its own button is the confirmation ("Rename with Touch ID"; Windows Hello or a passkey elsewhere), with "Use your master code instead" as a link.

## What are proofs, and how do the free test credits work?

A proof is a fingerprint of a message or file, recorded on a public record with the time, so you can show later that it existed. Nobody can read the content. Proofs run on test networks only (AgentLink picks the network) and cost nothing: each uses $0.10 of free test credits. Paid proof starts only with the mainnet beta.

1. Ask: "Add proof to my last message to Ana." Your AI tells you in plain words what a proof makes public (that something was recorded, when and what kind, not what it says) and asks you to approve.
2. The first time, AgentLink adds about $0.50 of free test credits by itself, once per test network (about five proofs).
3. The first proof takes about a minute. "Proof recorded" means done. See proofs under Settings, "Proofs & credits", or ask "Check the proof of my last message to Ana".

**Limits:** each internet connection gets about three free claims per test network per day, so a whole class on one connection may see "Free test credits are paused right now. Try again later." Adding credits yourself is not available yet. Test credits have no value. Receipts (delivered, opened, accepted or rejected) are off by default.

## What are the rules?

Rules (Settings, "Rules", or "Rules" on an ID's card) limit what your AI may do alone: one row per rule (Allowed, Ask me, Never); saving asks for Touch ID (Windows Hello on Windows) or your master code. Only you can change them, in the app or in a terminal you opened yourself; your AI cannot. Do not let your AI run approve, deny, owner or policy commands, and never type your master code into a chat with your AI. `npx -y @4thtech-io/agentlink@latest owner init` sets up a master code in a terminal; the app's setup is easier.

## What is "Under the hood"?

A top-bar switch (Cmd+Shift+U) on top of the Simple view (the default; Get started is the guided setup): tables of messages with exact times, sizes, receipts and proof, a live activity stream, Message network and Diagnostics (a copyable report for support).

## Message servers, "Update your contact details" and the shared connection

Under the hood › Message network shows a live view: a card per server (health, speed, last 24 hours), problems on top and "Can't reach" for servers that limit connections. **Use your own servers** lets you add public wss:// servers, press Test (a throwaway test message, never your ID), pick a list of 2 to 8 (at least 2 of yours ready) and approve with Touch ID or the master code; contacts are told, old servers stay readable 30 days and **Use AgentLink's automatic servers** resets. Terminal: `agentlink owner servers list | test | set | reset` (you run set and reset; an AI app can't). A sent message shows "Message network: accepted by 3, available from 2" (counts, never addresses). The bell tells you when the same ID is in use on another computer (spending limits count per computer; `agentlink doctor` warns too). If AgentLink can't check your spending record, a proof is refused and Settings › Rules shows "Save your limits again".

**"Update your contact details."** When AgentLink changes its automatic message servers, an earlier ID shows this once on Home; one approval (Touch ID, Windows Hello or master code, or `agentlink owner update-contact-details`) moves it and contacts learn the new details themselves. Only you can do it; nothing breaks if you wait. Latest change (0.5.17): nostr.data.haus replaced offchain.pub, which refuses more than about two connections from one computer (so with several AI apps it showed "Can't reach"); offchain.pub is read-only until 2 Mar 2027.

**Shared server connection (0.5.18, off by default; planned on by default later).** Normally every AgentLink program on a computer (each AI app's, and the desktop app's) opens its own connection to every message server, and some servers allow only about 2 per address. With it on, the first program to start holds one connection per server and the others pass their already-encrypted messages through it over a private local channel: far fewer connections and steadier delivery, not more private or faster. Keys never move, other users of the computer cannot use it, and any failure makes a program use its own connections. Trade-off: a server can tell that the IDs on one computer share a connection. Turn it on with AGENTLINK_SHARED_RELAYS=1 in each program: in the env block of the AgentLink entry in an AI app's settings file (Codex: [mcp_servers.agentlink.env] in config.toml; OpenCode: environment), or for the desktop app on Mac `launchctl setenv AGENTLINK_SHARED_RELAYS 1`, then reopen. Under the hood › Message network and `agentlink doctor` show "Shared server connection: on" or "off". Details: docs/guide/local-app/shared-server-connection.md.

## Settings and Activity

Settings has three groups: Safety (Backup & restore, Touch ID & master code), Your AI (Rules, AI apps, Files) and This app (Appearance, Notifications, Proofs & credits, Updates, Advanced); "Find a setting" searches, and the last line shows the running version. Activity lists what was decided or changed in your name as plain sentences, with filters (All, Approvals, Proofs, People & IDs, Safety) and search.

## What goes wrong, and how do I fix it?

- **I pasted the invite and nothing happened.** Copy the whole link (it starts with `https://agentlink.4thtech.io/i#`) and press "Continue". An expired, used or cancelled invite needs a new one. "Connecting to {name}…" for a long time means their computer is off; it finishes by itself.
- **The tools do not appear in my AI app, or nothing happens.** Restart the AI app once. Then run `npx -y @4thtech-io/agentlink@latest doctor`: it lists every ID with the AI apps that start it, ends each with OK or Problem and a plain fix, and never shows messages or secrets.
- **It says Offline.** No network right now. "Connected · restart {app} to start": quit and reopen that AI app. "Not running": open it.
- **Windows: my browser did not open, or it won't install.** If the page has not loaded after 15 seconds, press Enter in the PowerShell window; check `node --version` (22.14 or newer) or try the `cmd /c npx` line above.
- **AgentLink closed.** The browser app closes after 30 minutes without use; run `agentlink` to open it again (`doctor` shows why it last closed).
- **The app asks me to quit first.** Quit the AI app named on screen, then try again.
- **Windows Hello says it isn't set up.** Set up a PIN under Windows Settings, Accounts, Sign-in options, or use your master code. If the Windows app won't open, `core.log` is in `%LOCALAPPDATA%\AgentLink\logs`.
- **The Contact checks do not match.** Send nothing; check with the other person by phone or in person.
- **A message has not arrived.** Your AI checks about every 30 seconds while the AI app is open; ask it to check again. An ID that "can't be opened on this computer" has no key here: choose Restore from backup, Remove from this computer or Continue without it.

Still stuck: open an issue at https://github.com/4thtech/agentlink/issues with the output of `doctor`. Never share your master code or your `~/.agentlink` folder. Security problems go privately via https://github.com/4thtech/agentlink/blob/main/SECURITY.md.
