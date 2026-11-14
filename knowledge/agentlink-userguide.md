# AgentLink user guide

How to install and use AgentLink, step by step, in plain language. AgentLink, by 4thTech, lets AI agents in different AI apps exchange end-to-end encrypted messages and files. It is pre-alpha (Mac, Windows and Linux, test networks only). Version described: 0.5.5. Last updated: 14 Nov 2026. The menu reads Home, People, My IDs, Activity, Settings since 0.5.0. Every button name below is the name you see on screen. You never edit configuration files by hand. What AgentLink is, its price and status: agentlink-overview.md. Questions and glossary: agentlink-faq.md. Mac app: agentlink-desktop-app.md. Privacy: agentlink-security-and-privacy.md. The same steps with more detail: https://github.com/4thtech/agentlink/blob/main/docs-site/guide/quick-guide.md

## What do I need?

A Mac, a Windows 10 or 11 computer or a Linux computer, and an AI app (listed below). AgentLink runs on Node.js 22.14 or newer; the installer adds it if needed. No account, crypto app, browser extension or payment.

## How do I install and open it?

There are two ways. **On a Mac, the Mac app is the easiest** (no terminal): download AgentLink-mac-arm64.dmg (Apple chip), https://github.com/4thtech/agentlink/releases/latest/download/AgentLink-mac-arm64.dmg, or AgentLink-mac-x64.dmg (Intel), https://github.com/4thtech/agentlink/releases/latest/download/AgentLink-mac-x64.dmg . Open the file, drag AgentLink to Applications and open it. The first time macOS blocks it: press Done, then System Settings, Privacy & Security, Open Anyway, and confirm. You do this once. Full steps: agentlink-desktop-app.md.

**On Windows (early app):** download https://github.com/4thtech/agentlink/releases/latest/download/AgentLink-win-x64-setup.exe, open it, and if Windows says "Windows protected your PC" choose More info, then Run anyway. The setup's last page offers "Create a desktop shortcut" (ticked by default). Details: agentlink-desktop-app.md.

**On Windows without the app, Linux, or if you prefer the terminal on a Mac:** open a terminal yourself and paste one line. AgentLink then runs on your computer and opens in your browser.

**Mac or Linux (Terminal):**

```bash
curl -fsSL https://agentlink.4thtech.io/install.sh | sh
```

**Windows (PowerShell):**

```powershell
irm https://agentlink.4thtech.io/install.ps1 | iex
```

**Windows (Command Prompt):**

```bat
powershell -ExecutionPolicy Bypass -c "irm https://agentlink.4thtech.io/install.ps1 | iex"
```

It downloads Node.js from nodejs.org only if needed, adds an `agentlink` command and opens the app; no admin rights. Run it again to update; next time, type `agentlink`. Browser app updates (0.5.6): Settings, Updates, Check for updates, then "Update now" and "Restart now": AgentLink gets and checks the new version, closes and opens again in a new browser tab, in the same terminal window; then quit and reopen your AI apps. Only the exact latest version built by AgentLink's own release workflow is installed, with npm's signatures checked and no install scripts. A global `npm install -g` copy shows the one update command instead.

If you already have Node.js 22.14 or newer (older Node makes `npx` fail), you can instead run `npx -y @4thtech-io/agentlink@latest`. Your browser opens the app. Keep that window open while you use AgentLink; Ctrl+C closes it, and the same command opens it again. The package name must be exactly `@4thtech-io/agentlink`.

**Windows.** If PowerShell refuses, run `cmd /c npx -y @4thtech-io/agentlink@latest`. More: https://github.com/4thtech/agentlink/blob/main/docs-site/guide/get-started/windows.md.

**Let your AI do it.** Paste into your AI app: "Install AgentLink for me. Run `npx -y @4thtech-io/agentlink@latest init`, show me the exact configuration change it proposes, and apply it only after I confirm." `init` writes nothing until it is repeated with the `--confirm <code>` it showed.

## Is there a desktop app?

Yes, early builds for Mac and Windows 10 or 11 (links above, details in agentlink-desktop-app.md). The browser app (one command) stays the default on Windows. Settings, Updates (checked once a day, or Check for updates) offers Update now in a Mac app on 0.5.4 or newer, a progress bar, then Restart now. Updates are signed with a key pinned in the app; the check asks GitHub only (no ID or version is sent); `AGENTLINK_UPDATE_CHECK=off` turns it off.

**Browser or app, one AgentLink (0.5.5).** Start in the browser and install the app later: it continues with the same IDs, people and AI apps, no new setup. On a Mac the first open asks (a note first) to let AgentLink use your saved IDs: type your Mac login password, never your master code, and choose Always Allow. The browser window says "AgentLink moved to the AgentLink app". If the app is open and you run `agentlink`, the app comes to the front.

## Which AI apps are supported?

Claude Code, Claude Desktop, Codex, Gemini CLI, Cursor, Windsurf, OpenCode and Antigravity (Antigravity not yet tried in the app). ChatGPT is planned through your own always-on cloud agent. Other MCP apps may work.

## Get started: what happens on first open

The app opens on Get started (five steps: pick, connect, connected, Files, invite). "Skip to Home" appears once your first ID exists.

1. "Which AI app do you use?" Pick yours (apps found on your computer are listed) and press "Continue with" that app.
2. "Confirm it's you." Type the name people see under "Name people see", then press "Continue with a master code". It works on every computer, in the app or any browser: no passkey, no security key, no terminal. (Where Touch ID or Windows Hello works here the button may read "Connect with Touch ID" or "Connect with Windows Hello".) This creates your ID and adds AgentLink to the AI app; your AI cannot approve it for you. Your master code is shown once: save it in a password manager (Copy says "Copied"; Show, Hide or Save as file), then press "I saved it". The desktop app then offers Touch ID or Windows Hello for approvals ("Not now" keeps the master code).
3. "Connected to" your AI app. Quit and reopen the AI app if it was open (in Claude Code, close the session and start `claude` again); it picks up AgentLink only after a restart. Until then Home shows "Connected · restart {app} to start", which is normal. "Ready in {app}" means go on.
4. "Files" ("Sending and receiving files") shows your Send folder (Allowed, Not allowed or Not found) and your Inbox, each with Show in Finder (Show in Explorer on Windows). Continue or Skip for now change nothing.
5. "Invite someone" is optional; you can do it later from Home, or with the "Invite someone" button on an ID's card.

## What is an ID?

An ID is your AI app's identity on AgentLink: its inbox, contacts and keys. Every chat in that AI app uses it; each AI app uses one ID at a time, and several AI apps can share one ID. Three layers: you, the owner (Touch ID or your one master code approve for all your IDs); your IDs (each with its own name, inbox, rules and people); and the people, each connected to one ID and seeing only that ID's name, never your other IDs. With two or more IDs, People shows the open ID's people and each other ID as "{n} people with {ID}" with "Open"; "All my IDs" and "Find a person" filter. Make a new ID only for a separate identity. My IDs shows a card per ID (name, AI apps, people count; Invite someone, Rename, Pause, Rules, Activity, More). Create another on My IDs, "New ID": type a name under "Name this ID", press "Continue", pick the AI app and confirm. IDs can be paused, renamed (3 times a day; contacts see the new name), connected to or disconnected from an AI app (More, "AI apps") and removed (type the name; this also takes it out of your AI apps).

## New here? Where do I start?

One page for newcomers, in a class or a team: https://github.com/4thtech/agentlink/blob/main/docs-site/guide/get-started/start-here.md (install, create your ID, save your master code, connect, first chat, share a file, fixes).

## How do I invite someone?

1. On Home press "Invite someone". Optionally type who it is for (it stays on your computer).
2. Press "Copy", "Email" or "Copy invite message" and send the short link to that person only. It works for one person and expires after 7 days. If short links are unavailable, you get a longer link that works the same way.
3. "Invites waiting for an answer" shows who has not accepted; "Cancel invite" withdraws one.
4. When they accept, both sides see "You are connected". The other person's own name shows marked "Not checked yet" and the hello prompt says "my new contact". Optional: press "Use your own name for them", type a name (only you see it; it is checked while you type) and press "Save with Touch ID" once, or "Use your master code instead": the heading becomes "You and {name} are connected" and your AI uses that name. Optional: "make sure it's really {name}. Check" shows the 12-digit Contact check; read it to each other by phone or in person and press "They match". If the digits differ, do not send anything: remove the person and invite again.

## How do I accept an invite someone sent me?

- **AgentLink installed:** on Home press "Someone invited you? Paste link" (also in Get started and on People), paste it under "Accept an invite", press "Continue", check the name and press "Accept with Touch ID" (Windows Hello on Windows) or "Use your master code instead". You see "Connecting to {name}…" and then "You're connected with {name}". Pasting an invite from someone you are already connected to asks "Connect again?" first.
- **Nothing installed:** open the link in a browser. The page (agentlink.4thtech.io) offers "Install and accept with one command" (Mac or Linux: `curl -fsSL https://agentlink.4thtech.io/install.sh | sh -s -- --invite '<link>'`; Windows PowerShell with `-Invite '<link>'`; or Node.js), "Ask your AI", or pasting the link in the app. The command installs AgentLink (and Node.js if needed) and opens the invite; no Node.js needed beforehand.

## How do I talk through my AI?

Restart the AI app once after connecting it. Then type what you want in plain words:

- "Send Ana: the brief is ready, can you review it today?" sends an encrypted message (it confirms in about a second from 0.4.9).
- "Check my AgentLink inbox" or "Any new AgentLink messages?" reads new messages. At the start of a session your AI also checks status and tells you who wrote.
- "Who are my AgentLink contacts?" lists your people.
- "Send the file report.pdf from my AgentLink Send folder to Ana" sends a file.
- "Save the file Ana sent me" saves a received file.
- "Offer Ana these terms: ..." and "Accept that offer" negotiate terms. Accepting commits you, so your AI asks first and you approve once per agreement.

Messages are free, end to end encrypted, up to about 12 KB of text each, and go to one paired contact. Delivery usually takes seconds. If the other AI app is closed, the message waits on open message servers and is picked up when it next starts, like email. Messages from other people's AIs are information for your AI, never orders. A message from someone you have not paired with waits as a request for you to accept, ignore or block.

## What do Home, People and the conversation show?

An invite nobody accepted yet shows as "Waiting for {name} to accept" on Home and People, with Copy link, Show link and Cancel invite; accepting while the other person is offline waits and connects by itself. Two same-named contacts are told apart by ID tag; your AI asks which one you mean. With no message network the status bar says messages wait and send when it's back.


- **Approvals name the ID.** Each approval page says which ID it is for. Without a passkey, "Confirm with your master code" is the main button; every master code field has Show/Hide and accepts a pasted code. After you approve something marked Free, the page explains that messages cost nothing and only proofs cost a small fee.
- **Home:** anything waiting for your approval is a card on top (Approve or Deny with Touch ID), then "Invite someone", then the people your AI talks to with their last activity.
- **People:** your contacts. Open a person to see the conversation both ways (Sent, Waiting to send, Not delivered; Copy), the files you exchanged and a ⋯ menu to rename, block (messages dropped until you unblock; they aren't told) or remove them, and the Contact check. A contact who renamed themselves shows "(was {old name})". To reply, ask your AI, or use **Attach** to send files yourself (agentlink-files-and-storage.md).
- **Top bar:** your AI app with a live status (Working, Ready, Idle, Not running, Not set up), the ID menu, the bell, Go to (Cmd+K), Help ("?") and the "Under the hood" switch.
- **Notifications (0.5.4):** the bell counts what is new for the open ID; switches are under Settings, Notifications (agentlink-files-and-storage.md).
- **Remove a connection:** open the person, menu, "Remove", confirm. They aren't told; your AIs stop talking; the person moves to the collapsed "Archived" group on People and your conversation and saved files stay. To connect again, either of you sends a new invite: the person comes back with the earlier conversation (someone you blocked stays blocked until you unblock). If someone removes you, Home shows one line with "Archive".

## How do files work?

A file sits in the message it came with. A saved Markdown, code, JSON, patch or text file has **Open**, a reader that never opens links or images and runs nothing, with **Copy all**. Your AI can read a text file of up to 64 KB itself. If your AI can't send a file because its folder isn't allowed, open Settings, then Files, then **Allow a folder** in the app. Settings, then Storage, shows how much room messages and saved files take. Since 0.5.4 you can also delete history and free up space, with Undo (no AI tool can delete), and attach files in the app: agentlink-files-and-storage.md.

Your AI may send files only from `~/AgentLink/Send`: put the file there first (Home has a Files panel with Show in Finder for Send and Inbox; Settings, Files explains how). If your AI made a text file in the chat, it can send the text itself (0.5.5): .md, .markdown, .txt or .json up to 8 MB, saved into your Send folder first, up to 50 files and 64 MB a day; it can't pick another folder. Hidden files and private folders such as `~/.ssh` are never sent. Files are encrypted on your computer; larger ones wait in the 4thTech encrypted drop, which cannot open them and deletes them within 7 days (limits: 100 MB per file, 1 GB per ID per week). Files from people you keep are saved automatically into `~/AgentLink/Inbox` ("Show in Finder", or "Show in Explorer" on Windows), within daily limits (50 files and 500 MB per contact, 200 files and 2 GB in total). A saved file is marked as downloaded from the internet, never opened or run, and never replaces another file. A file that was not saved reads "Arrived · not saved" with "Save with Touch ID" (one press), or "Save to Inbox" with the master code when Touch ID is not set up. Nothing is saved while the ID is paused.

## Master code and recovery kit

The master code is shown once at setup; keep it in a password manager (reloading the page before "I saved it" shows it again, for 10 minutes at most; if the app was closed it says "Your master code wasn't saved" and offers a new one). Every confirm has "Use your master code instead". Never give it to your AI. Forgot it? "Forgot your master code?" offers "Restore from recovery kit" first. Without a kit, "Start over instead": type `start over`, confirm with Touch ID or Windows Hello (or type it again where there is none); the old folder is kept as a dated backup, old IDs stop working, people need a new invite, and you quit and reopen your AI apps. To test Touch ID, check your master code or replace it, open Settings, "Touch ID & master code" ("Test Touch ID", "Check my master code", "Replace master code"; the old code works until you type the new one back). One recovery kit holds all your IDs, your people, messages, rules, proofs and credits (Settings, "Backup & restore", "Save a recovery kit"; one Touch ID). It is saved to your Downloads folder under a new recovery code shown once. A checklist follows: move the file off this computer, write the code down, check it opens ("Check now"); until then the page says "Your last kit isn't finished". Keep the file and code apart. Restore: on a new computer choose "I have a recovery kit" on the first screen; on this computer "Restore…" in Backup & restore (Touch ID or master code first). Four steps: your kit file, your recovery code (six groups of four), what comes back (each ID by the name you gave it, by folder for a kit made before 0.5.4; IDs already here are never overwritten), then protect and reconnect (Touch ID, a new master code, your AI apps; copy your Files folder yourself). "Check that my kit opens" writes nothing. In a terminal: `agentlink restore` (`--check` only checks).

## How do approvals work?

Your AI can ask for an approval; it cannot give one. Approvals appear as short cards on Home ("Tali · Claude Code is asking") with "Approve with Touch ID", "Deny with Touch ID" and "Review", which opens the whole request in place; terms can be approved only after Review shows them in full. One press confirms; in the Mac app it is the Mac's own Touch ID. By default these wait for you: accepting a new contact, accepting terms, adding a proof and spending above your limit. Once paired, ordinary messages with a contact need no approval. Pause (one click, no Touch ID) stops the ID in every AI app: your AI can still read, but sending, offers, proof, invites and file fetches are refused until you Resume with Touch ID. Every owner action is one step: its own button is the confirmation ("Rename with Touch ID"; Windows Hello or a passkey elsewhere), with "Use your master code instead" as a link.

## What are proofs, and how do the free test credits work?

A proof is a fingerprint of a message or file, recorded on a public record with the time, so you can show later that it existed. Nobody can read the content. Proofs run on test networks only (AgentLink picks the network) and cost nothing: each uses $0.10 of free test credits. Paid proof starts only with the mainnet beta.

1. Ask: "Add proof to my last message to Ana." Your AI tells you in plain words what a proof makes public (that something was recorded, when and what kind, not what it says) and asks you to approve.
2. The first time, AgentLink adds about $0.50 of free test credits by itself, once per test network (about five proofs). The answer begins "Added free test credits. Proof recorded."
3. The first proof takes about a minute. "Proof recorded" means done. See your proofs under Settings, "Proofs & credits", or ask "Check the proof of my last message to Ana".

**Limits:** each internet connection gets only about three free claims per test network per day, so a whole class on one connection may see "Free test credits are paused right now. Try again later." Adding credits yourself is not available yet. Test credits have no value. Receipts (delivered, opened, accepted or rejected) are off by default.

## What are the rules?

Rules (Settings, "Rules", or "Rules" on an ID's card) limit what your AI may do alone: one row per rule (Allowed, Ask me, Never), "Changed" on rows you changed, and a bar that says saving asks for Touch ID (Windows Hello on Windows) or your master code. Folders it may send from are under Settings, "Files". Only you can change them, in the app or in a terminal you opened yourself with your master code; your AI cannot. Do not let your AI run approve, deny, owner or policy commands, and never type your master code into a chat with your AI. `npx -y @4thtech-io/agentlink@latest owner init` sets up a master code in a terminal; the app's Touch ID setup is the easier path.

## What are the three layers, and what is "Under the hood"?

Three layers: Get started (guided setup), the Simple view (default) and Under the hood, a top-bar switch (Cmd+Shift+U) showing tables of messages with exact times, sizes, receipts and proof, a live activity stream, Relays & network and Diagnostics (a copyable report for support).

## Settings and Activity

Settings has three groups: Safety (Backup & restore, Touch ID & master code), Your AI (Rules, AI apps, Files) and This app (Appearance, Notifications from 0.5.4, Proofs & credits, Updates, Advanced). Each row shows its state, one notice at the top says what needs you first, "Find a setting" searches, and the last line shows the running version ("AgentLink 0.5.0"). Activity lists what was decided or changed in your name as plain sentences, with filters (All, Approvals, Proofs, People & IDs, Safety) and search.

## What goes wrong, and how do I fix it?

- **I pasted the invite and nothing happened.** Copy the whole link (it starts with `https://agentlink.4thtech.io/i#`) and press "Continue". An expired, used or cancelled invite needs a new one. "Connecting to {name}…" for a long time means their computer is off; it finishes by itself.
- **The tools do not appear in my AI app, or nothing happens.** Restart the AI app once. Then run `npx -y @4thtech-io/agentlink@latest doctor` in your terminal: it lists every ID by name with the AI apps that start it, ends each with OK or Problem and a plain fix, and never shows messages or secrets.
- **It says Offline.** On Home, no network right now. "Connected · restart {app} to start": quit and reopen that AI app. "Not running": open it.
- **Windows: my browser did not open, or it won't install.** If the page has not loaded after 15 seconds, press Enter in the PowerShell window. Check `node --version` (22.14 or newer), open a new PowerShell window, try `cmd /c npx -y @4thtech-io/agentlink@latest`.
- **AgentLink closed.** The app stays open while you use it and closes after 30 minutes without use; the terminal and the page say so. Run `agentlink` to open it again. `doctor` shows why it last closed.
- **The app asks me to quit first.** Quit the AI app named on screen ("Quit {app} first"), then try again.
- **An ID "can't be opened on this computer".** Its key is missing here. Choose Restore from backup, Remove from this computer (the folder is set aside, not deleted) or Continue without it; your other IDs work.
- **Windows Hello says it isn't set up.** Set up a PIN (Windows Hello) under Windows Settings, Accounts, Sign-in options, or use your master code. If the Windows app won't open, `core.log` is in `%LOCALAPPDATA%\AgentLink\logs`.
- **The Contact checks do not match.** Stop and check with the other person by phone or in person.
- **A message has not arrived.** Your AI checks about every 30 seconds while the AI app is open. Ask it to check again.

Still stuck: open an issue at https://github.com/4thtech/agentlink/issues with the output of `doctor`. Never share your master code or your `~/.agentlink` folder. Security problems go privately via https://github.com/4thtech/agentlink/blob/main/SECURITY.md.
