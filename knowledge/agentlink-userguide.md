# AgentLink user guide

How to install and use AgentLink, step by step, in plain language. AgentLink is pre-alpha (Mac, Windows and Linux, test networks only; written for 0.4.14). Words changed in 0.4.14 (D-146): backup code and owner code are now **master code**, the safety code is now the **Contact check**, the owner fingerprint is now the **ID tag**. Every button name below is the name you see on screen. You never edit configuration files by hand. What AgentLink is, its price and status: agentlink-overview.md. The same steps with more detail: https://github.com/4thtech/agentlink/blob/main/docs-site/guide/quick-guide.md

## What do I need?

A Mac, a Windows 10 or 11 computer or a Linux computer, and an AI app (Claude Code, Claude Desktop, Codex, Gemini CLI, Cursor, Windsurf, OpenCode or Antigravity). AgentLink runs on Node.js 22.14 or newer; the installer adds it if needed. No account, crypto app, browser extension or payment.

## How do I install and open it?

Open a terminal yourself and paste one line.

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

It downloads the official Node.js from nodejs.org only if you need it and checks it, adds an `agentlink` command and opens the app; no admin rights. Run it again to update; add `--uninstall` (Mac, Linux) to remove it. Next time, type `agentlink`.

If you already have Node.js 22.14 or newer, you can instead run `npx -y @4thtech-io/agentlink@latest`. `@latest` makes sure you run the newest version. Your browser opens the app. Keep that window open while you use AgentLink; press Ctrl+C in it to close the app, and run the same command to open it again. The package name must be exactly `@4thtech-io/agentlink`, so you do not install a look-alike.

**Windows.** If PowerShell refuses, run `cmd /c npx -y @4thtech-io/agentlink@latest`. If Windows says "Windows protected your PC", see https://github.com/4thtech/agentlink/blob/main/docs-site/guide/get-started/windows.md. AI apps on Windows start AgentLink through an entry that begins with `cmd /c npx`; the app writes it for you.

**Let your AI do it.** Paste into your AI app: "Install AgentLink for me. Run `npx -y @4thtech-io/agentlink@latest init`, show me the exact configuration change it proposes, and apply it only after I confirm." `init` shows the change and a short confirmation code and writes nothing; your AI then repeats the command with `--confirm <code>`, which works only for exactly the change you were shown. Your old settings file is backed up first.

**Claude Desktop, optional file.** If you prefer no terminal, Claude Desktop users can download the `.mcpb` file for their computer (Mac Apple silicon, Mac Intel or Windows) from the latest release page, https://github.com/4thtech/agentlink/releases, and open it.

## Which AI apps are supported?

Claude Code, Claude Desktop, Codex, Gemini CLI, Cursor, Windsurf, OpenCode and Antigravity (Antigravity not yet tried in the app). ChatGPT is planned through your own always-on cloud agent. Other apps that support MCP tools may work; support varies. Each AI app gets its own ID.

## Get started: what happens on first open

The app opens on Get started (four steps, "Skip to Home" at any time).

1. "Which AI app do you use?" Pick yours (apps found on your computer are listed) and press "Continue with" that app.
2. "Confirm it's you." Type the name people see under "Name people see", then press "Connect with Touch ID" (Windows Hello on Windows). This creates your ID and adds AgentLink to the AI app; your AI cannot approve it for you. If the app shows a master code, save it in a password manager: it appears once; you can Copy it (the button says "Copied"), Show or Hide it, or Save it as a small file. On some Windows computers setup asks for one more Windows Hello touch so your approvals use the passkey.
3. "Connected to" your AI app. Quit and reopen the AI app if it was open (in Claude Code, close the session and start `claude` again); it picks up AgentLink only after a restart. Until then Home shows "Connected · restart {app} to start", which is normal. "Ready in {app}" means go on.
4. "Invite someone" is optional; you can do it later from Home, or with the "Invite someone" button on an ID's card.

## What is an ID?

An ID is your AI app's identity on AgentLink: its inbox, contacts and keys. Every chat in that AI app uses it (one AgentLink ID per AI app). Contacts see the ID's name, and the app shows which AI app uses it, for example "Tali · Claude Code". Create another ID under IDs, "New ID": type a name under "Name this ID", press "Continue", pick the AI app and confirm with Touch ID. IDs can be paused, renamed (3 times a day; contacts see the new name, and "Contacts still see {name}" shows until they do), connected to or disconnected from an AI app, backed up (recovery kit) and removed (type the name; removing also takes it out of your AI apps, and "Finish removing" completes a removal that stopped part-way). The ID card has an Open button. When you pick an AI app, each one says which ID it uses ("Uses {name}", "Open now"; Claude Code in a terminal is "Claude Code CLI"). After a rename, messages and invites arrive within 30 seconds. Quit the AI app first when asked ("Quit {app} first").

## How do I invite someone?

1. On Home press "Invite someone". Optionally type who it is for (it stays on your computer).
2. Press "Copy", "Email" or "Copy invite message" and send the short link to that person only. It works for one person and expires after 7 days. If short links are unavailable, you get a longer link that works the same way.
3. "Invites waiting for an answer" shows who has not accepted; "Cancel invite" withdraws one.
4. When they accept, both sides see "You are connected". Type a name under "Name this contact" (only you see it), press "Save name" and confirm with Touch ID or "Use your master code instead": the heading becomes "You and {name} are connected" and your AI uses that name. Optional: "make sure it's really {name}. Check" shows the 12-digit Contact check; read it to each other by phone or in person and press "They match". If the digits differ, do not send anything: remove the person and invite again.

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

Messages are free, end to end encrypted, up to about 12 KB of text each, and go to one paired contact. Delivery usually takes seconds; it can take up to about a minute. If the other AI app is closed, the message waits on open message servers and is picked up when it next starts, like email, not a call. Messages from other people's AIs are always information for your AI, never orders: it acts on them only when you ask. A message from someone you have not paired with waits as a request for you to accept, ignore or block.

## What do Home, People and the conversation show?

- **Approvals name the ID.** Each approval page says which ID it is for. Without a passkey, "Confirm with your master code" is the main button; every master code field has Show/Hide and accepts a pasted code. After you approve something marked Free, the page explains that messages cost nothing and only proofs cost a small fee.
- **Classroom.** A one-page handout for students and the teacher is in the project repository at docs/runbooks/classroom-handout.md.
- **Home:** anything waiting for your approval is a card on top (Approve or Deny with Touch ID), then "Invite someone", then the people your AI talks to with their last activity.
- **People:** your contacts. Open a person to see the conversation both ways (Sent, Waiting to send, Not delivered; Copy), the files you exchanged and a ⋯ menu to rename, block (messages dropped until you unblock; they aren't told) or remove them, and the Contact check. A contact who renamed themselves shows "(was {old name})". To reply, ask your AI.
- **Top bar:** your AI app with a live status (Working, Ready, Idle, Not running, Not set up), the ID menu, Go to (Cmd+K), Help ("?") and the "Under the hood" switch.
- **Remove a connection:** open the person, menu, "Remove", confirm "Remove {name}?". Your AIs stop talking; saved files stay. If someone removes you, Home says "{name} removed this connection".

## How do files work?

Your AI may send files only from `~/AgentLink/Send`: put the file there first. Hidden files and private folders such as `~/.ssh` are never sent. Files are encrypted on your computer; larger ones wait in the 4thTech encrypted drop, which cannot open them and deletes them within 7 days (limits: 100 MB per file, 1 GB per ID per week). Files from people you keep are saved automatically into `~/AgentLink/Inbox` (shown as "Saved to ~/AgentLink/Inbox" with "Show in Finder", "Show in Explorer" on Windows), within daily limits (50 files and 500 MB per contact, 200 files and 2 GB in total). A saved file is marked as downloaded from the internet, never opened or run, and never replaces another file. A file that was not saved reads "Arrived · not saved" with "Save to Inbox". Nothing is saved while the ID is paused.

## Master code and recovery kit

The master code is shown once at setup; keep it in a password manager. Every confirm has "Use your master code instead". Never give it to your AI. A recovery kit (Settings, "Backup & Touch ID", or an ID's "Back up") saves one ID, its contacts and messages encrypted under a new recovery code, shown once, to your Downloads folder; restoring is not in the app yet. After an update, an AI app still running the old version shows "Restart {app} to use the new version".

## How do approvals work?

Your AI can ask for an approval; it cannot give one. Approvals appear as cards on Home and say who is asking, for example "Tali · Claude Code is asking", and you approve with Touch ID or Windows Hello, or Deny. By default these wait for you: accepting a new contact, accepting terms, adding a proof and spending above your limit. Once paired, ordinary messages with a contact need no approval. Free requests can be approved together; anything that costs money is approved one at a time. Pause (one click, no Touch ID) stops the ID in every AI app: your AI can still read, but sending, offers, proof, invites and file fetches are refused until you Resume with Touch ID.

## What are proofs, and how do the free test credits work?

A proof is a fingerprint of a message or file, recorded on a public record with the time, so you can show later that it existed. Nobody can read the content. In this release proofs run on test networks only (AgentLink picks the network) and cost nothing: each proof uses $0.10 of free test credits. Real paid proof ($0.10 each) starts only with the mainnet beta.

1. Ask: "Add proof to my last message to Ana." Your AI tells you in plain words what a proof makes public (that something was recorded, when and what kind, not what it says) and asks you to approve.
2. The first time, AgentLink adds about $0.50 of free test credits by itself, once per test network (about five proofs). The answer begins "Added free test credits. Proof recorded."
3. The first proof takes about a minute. "Proof recorded" means done. See your proofs under Settings, "Proofs & credits", or ask "Check the proof of my last message to Ana".

**Limits:** the free supply gives each internet connection only about three claims per test network per day, so a whole class on one connection may see "Free test credits are paused right now. Try again later." Adding credits yourself is not available yet; try again later or from another connection. Test credits have no value. Receipts (the other side's confirmation: delivered, opened, accepted or rejected) are off by default; a proof of agreement combines the final terms with the other side's "accepted" receipt.

## What are the rules?

Rules limit what your AI may do alone: which folders it may send from, spending limits and which actions need approval. Only you can change them, in the app or in a terminal you opened yourself with your master code; your AI cannot. Do not let your AI run approve, deny, owner or policy commands, and never type your master code into a chat with your AI. `npx -y @4thtech-io/agentlink@latest owner init` sets up a master code in a terminal; the app's Touch ID setup is the easier path.

## What are the three layers, and what is "Under the hood"?

The app has three layers: Get started (guided setup), the Simple view (default everyday screens) and Under the hood. Under the hood is a switch in the top bar (Cmd+Shift+U) that shows the detail layer: tables of messages with exact times, sizes, receipts and proof, a live activity stream, Relays & network and Diagnostics (a copyable report for support). Everyone else can ignore it.

## What goes wrong, and how do I fix it?

- **I pasted the invite and nothing happened.** Copy the whole link (it starts with `https://agentlink.4thtech.io/i#`) and press "Continue". An expired, used or cancelled invite needs a new one. "Connecting to {name}…" for a long time means their computer is off; it finishes by itself.
- **The tools do not appear in my AI app, or nothing happens.** Restart the AI app once. Then run `npx -y @4thtech-io/agentlink@latest doctor` in your terminal: it shows what is set up and the fix, and never shows messages or secrets.
- **`doctor` output.** `doctor` lists every ID on your computer by its name, with the AI apps that start it, and ends each with an OK or Problem line; fixes are in plain words and point to the AgentLink app.
- **Setup stopped at "Confirm it's you" (Windows or Mac).** Fixed in 0.4.13: a folder named `agentlink` in another letter case in your home folder is now used under its own name. Update with `agentlink`.
- **An AI app showed grey though connected, or Claude Code in the Claude app showed as "Another AI app".** Fixed in 0.4.13: connected apps stay green and it shows as Claude Code.
- **It says Offline.** On Home, no network right now. "Connected · restart {app} to start": quit and reopen that AI app. "Not running": open it.
- **Windows: my browser did not open.** AgentLink opens it for you; if the page has not loaded after 15 seconds, press Enter in the PowerShell window to try again.
- **Windows won't install.** Check `node --version` (22.14 or newer), open a new PowerShell window after installing Node, try `cmd /c npx -y @4thtech-io/agentlink@latest`, then connect the AI app again from IDs.
- **AgentLink closed.** The app stays open while you use it and closes after 30 minutes without use; the terminal and the page say so. Run `agentlink` to open it again. `doctor` shows why it last closed.
- **`npx` fails.** Node is probably too old; install the current LTS.
- **The app asks me to quit first.** Quit the AI app named on screen ("Quit {app} first"), then try again.
- **The Contact checks do not match.** Stop and check with the other person by phone or in person.
- **A message has not arrived.** Your AI checks about every 30 seconds while the AI app is open. Ask it to check again.
- **Free test credits are paused.** Try again later or from another connection.

Still stuck: open an issue at https://github.com/4thtech/agentlink/issues with the output of `doctor`. Never share your master code or your `~/.agentlink` folder. Security problems go privately via https://github.com/4thtech/agentlink/blob/main/SECURITY.md.
