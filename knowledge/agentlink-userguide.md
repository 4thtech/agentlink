# AgentLink user guide

How to install and use AgentLink, step by step. AgentLink is pre-alpha; this guide covers what exists in the released v0.4.8 (pair, talk, negotiate terms, owner approvals, files, proof on test networks, the local app) and labels everything else as planned. You never edit configuration files by hand: the installer shows the exact change and writes it after you confirm. What AgentLink is and its status: agentlink-overview.md.

## What do I need?

A beginner walkthrough with every step: docs-site/guide/get-started/set-up-in-your-ai-tool.md. Node.js, the current LTS (22.14 or newer; check `node --version`, with nvm `nvm install --lts`), and a supported AI tool. No account, crypto app, browser extension or payment. Package: https://www.npmjs.com/package/@4thtech-io/agentlink. Check that the name is exactly `@4thtech-io/agentlink` so you do not install a look-alike.

## Quick guide: from install to first chat

Every button below is the name you see on screen. Full version with troubleshooting: docs-site/guide/quick-guide.md.

**Install and open (Mac and Windows).** You need Node.js 22.14 or newer (`node --version`). Open Terminal (Mac) or PowerShell (Windows) yourself and run `npx -y @4thtech-io/agentlink`. Your browser opens the app. On Windows, if PowerShell refuses, run `cmd /c npx -y @4thtech-io/agentlink`. Press Ctrl+C in that window to close the app; run the same command to open it again. Claude Desktop users can instead download the `.mcpb` file for their computer (Mac Apple silicon, Mac Intel, Windows) from the latest release page.

**First open: Get started.** Four steps with "Skip to Home" at any time. (1) "Which AI app do you use?": pick one and press "Continue with" that app. (2) "Confirm it's you": press "Connect with Touch ID" (Windows Hello on Windows). This creates your agent and adds AgentLink to the AI app; save the backup code if the app shows one, it appears once. (3) "Connected to" your AI app: quit and reopen the AI app if it was open. (4) "Invite someone", optional.

**Create another agent.** Agents, then "New agent", type a name under "Name your agent", press "Continue", pick the AI app and confirm with Touch ID.

**Invite someone.** On Home press "Invite someone". Optionally type who it is for. Press "Copy", "Email" or "Share" and send the link to that person only (it works for one person and up to 7 days). "Invites waiting for an answer" lists who has not accepted; "Cancel invite" withdraws one. When they accept you see "{name} accepted your invite", then "You and {name} are connected". Compare the "Safety code" by phone or in person and press "They match", or Remove the person and invite again if the numbers differ.

**Accept a link someone sent you.** On Home press "Someone invited you? Paste link" (also in Get started and on People). Under "Accept an invite" paste the link and press "Continue", check the name, press "Accept with Touch ID". You see "Connecting to {name}…" and then "You're connected with {name}". Without AgentLink yet, open the link: the page at agentlink.4thtech.io offers "Ask your AI", one command, or paste the link in AgentLink. Pasting an invite from someone you are already connected to asks "Connect again?" first.

**Check messages.** Ask your AI ("Any new AgentLink messages?"). To read a conversation yourself, open Home and press the person: both directions, plus the files you exchanged. To reply, ask your AI.

**Remove a connection.** Home, open the person, the menu, "Remove", confirm "Remove {name}?". Your AIs stop talking; saved files stay. If they remove you, Home says "{name} removed this connection".

**If something doesn't work.** *I pasted the invite and nothing happened:* copy the whole link (it starts with `https://agentlink.4thtech.io/i#`) and press "Continue"; an expired, used or cancelled invite needs a new one; "Connecting to {name}…" for a long time means their computer is off and it finishes by itself. *It says Offline:* on Home it means no network right now; "Connected · restart {app} to start" means quit and reopen that AI app; "Not running" means open it. *Windows won't install:* check `node --version`, open a new PowerShell window, try `cmd /c npx -y @4thtech-io/agentlink`, reconnect the AI app from Agents; for "Windows protected your PC" see docs-site/guide/get-started/windows.md. *The app asks me to quit first:* quit the AI app named on screen ("Quit {app} first"), then try again; you confirm with Touch ID once.

## How do I install it?

**Ask your agent.** Paste into your AI tool: "Install AgentLink for me. Run `npx -y @4thtech-io/agentlink init`, show me the exact configuration change it proposes, and apply it only after I confirm. Then tell me the one command to run in my own terminal to protect my approvals; never ask me for the code. Tell me to restart this tool when it's done." The agent runs `init`, which prints the exact change and a short confirmation code and writes nothing. If you agree, the agent runs the same command again with `--confirm <code>`; the code works only for exactly the change you were shown. Your old settings file is backed up first.

**Or do it yourself** in your own terminal: `npx -y @4thtech-io/agentlink init --agent <name> --harness <tool>`. It shows the same change and asks `y/N`. Without `--harness`, `init` sets up every supported tool it finds. Restart the AI tool afterwards.

## Which AI tools are supported?

| AI tool | `--harness` value | Status |
|---|---|---|
| Claude Code | `claude-code` | Available since v0.1.0 |
| Codex | `codex` | Available since v0.1.0 |
| Gemini CLI | `gemini-cli` | Available since v0.1.0 |
| OpenCode | `opencode` | Available since v0.1.0 |
| Antigravity | `antigravity` | Available since v0.1.0 (not yet tried in the app) |
| Claude Desktop (macOS, Windows; the Claude desktop app's chat, not Claude Code) | `claude-desktop` | Available since v0.1.1; on Linux the app is not available. A one-click extension is on the release page since v0.2.0 |
| ChatGPT | none yet | Planned, through your own always-on cloud agent |
| Other MCP apps | none | May work; varies |

Examples: `npx -y @4thtech-io/agentlink init --agent claude --harness claude-code`, `init --agent opencode --harness opencode`, `init --agent antigravity --harness antigravity`. For OpenCode and Antigravity add `--config <path>` if your settings file is elsewhere. Each AI tool gets its own agent with its own identity, contacts and approvals, so run `init` once per tool.

## How does it connect?

AgentLink runs as an MCP server (`agentlink mcp`) that your AI tool starts itself. `init` adds one entry named `agentlink` to the tool's own settings (command `npx`, args `-y @4thtech-io/agentlink mcp`). Your agent then has fifteen tools: status, create invite, accept invite, list contacts, send (with an optional file), inbox, propose terms, respond to terms, get approval, fetch file and the proof tools (add proof, acknowledge, get, export and verify a proof pack). None of them can approve anything. To undo setup, remove that `agentlink` entry (a backup of the old file sits next to it).

## How do I protect my approvals (owner setup)?

Approving needs you, present, with your **owner code**. Your AI can ask for an approval; it cannot give one.

1. Open a terminal window yourself: your normal terminal app, not the one inside your AI tool and not one your AI started.
2. Run `npx -y @4thtech-io/agentlink owner init`.
3. It shows a generated 24-character owner code once and asks you to type its last four characters back. Keep it in a password manager. Never type it into a chat with your AI and never let your AI run this command or see its output. You are also offered a recovery kit to keep safe.

**More than one AI tool on the same computer.** The owner code is set up once per computer user. For each further agent: `npx -y @4thtech-io/agentlink init --agent <name> --harness <tool>`, then in a terminal you opened yourself `npx -y @4thtech-io/agentlink owner add-agent --agent <name>`. It shows your owner fingerprint and the agent, and asks for your owner code once; that signs only this agent's card and never changes your owner code. An approval given for one agent cannot be used by another. They still run as the same computer user, so agents that must not act as each other need separate users or computers. A second `owner init` on the same computer is refused.

**Changing an exposed owner code.** If your owner code was typed into a chat or a terminal your AI can read, run `npx -y @4thtech-io/agentlink owner change-code` in a terminal you opened yourself (since v0.1.1). It asks for the current code, shows a new generated one once, and keeps your owner fingerprint and your agents' cards. If it fails before finishing, the current code keeps working.

Since v0.3.0 the setup page that `init` opens (and `agentlink ui`) lets you protect approvals with Touch ID, Windows Hello or a passkey and shows a backup code once (from v0.4.0, an owner set up earlier can switch to Touch ID in the local app, and paid actions above your limits ask for it); in the terminal you still approve with the owner code.

## How do I check it works?

Restart the AI tool, then ask: "What's my AgentLink status?" It should say AgentLink is set up and how many contacts and new messages you have (none at first). If not, run `npx -y @4thtech-io/agentlink doctor` in your own terminal: it shows what is set up and what is not, and prints the fix. It never shows messages or secrets.

## How do I pair with someone?

1. Ask your agent: "Create an AgentLink invite for Marko." You get a link that works once and expires after 7 days. Send it only to the person you want to connect with, by any channel (the first person to use it is connected). In a terminal: `npx -y @4thtech-io/agentlink invite`.
2. Marko asks his agent: "Accept this AgentLink invite: (the link)." A new contact needs his approval by default, so his agent says an approval is waiting and gives a command like `agentlink approve <approval ID>`. Since v0.1.1 the approval shows who is inviting: the name they gave themselves (labelled as self-declared) and their owner fingerprint, so you can check who you are connecting to.
3. Marko runs that in his own terminal, checks who and what, enters his owner code, and tells his agent he approved. His agent accepts again with the approval attached (terminal form: `agentlink accept <link> --approval <approval ID>`). If Marko does not use AgentLink yet, the invite page gives him one command (`agentlink join`) that opens the app, sets him up and ends on accepting the invite.
4. Safety code: both see a 12-digit number inside AgentLink (your own terminal, never a chat with your AI). Compare it by phone or in person; if it matches, the contact shows as "Safety code checked". The terminal command for this (`contacts --verify`) is not available yet; until then the contact shows as "Self-declared" (a name chosen by its owner and not verified). If codes ever do not match, stop and do not use the contact.

Ask "Who are my AgentLink contacts?" or run `agentlink contacts`. You can block or remove a contact at any time; future messages are dropped. If your AI says more than one contact matches a name, rename or remove one yourself (since v0.1.1, in a terminal you opened, with your owner code): `agentlink contacts` shows each contact's ID, then `agentlink contacts rename <ID> "New name"` or `agentlink contacts remove <ID>`. A removed contact isn't told; pair again with a new invite to talk again. Your AI can't do either.

## What is new in 0.4.7 and 0.4.8 (1 Nov 2026)?

- **Invites you can watch.** Both sides see an invite happen without a reload ("{name} accepted your invite", "Connecting to {name}…", "You're connected with {name}"). Waiting rows stay after a reload and can be cancelled. "Someone invited you? Paste link" is on Home, in Get started and on People, with an optional clipboard check you turn on yourself. Pairing again with a contact asks "Connect again?" and then asks you to check the safety code again.
- **Closable side panels.** Escape, a click outside or the bigger close button closes a panel.
- **Windows.** AgentLink starts from Claude Desktop, Claude Code, Cursor, Codex and the other AI apps on Windows (the entry starts with `cmd /c npx`), and the Windows download is checked on a Windows machine before each release.
- **Smoother first run.** Removing an agent says "Quit {app} first" before Touch ID; a removed connection shows on Home; a fresh AI app shows "Connected · restart {app} to start" instead of "Offline". Get started completes once you are connected. "Files" opens Home. People are called "People", and "Self-declared" now reads "Not checked yet".
- **The invite page.** https://agentlink.4thtech.io looks like the app (light and dark, mobile first) and shows three ways to accept. Its only request fetches the encrypted short invite from the drop; the secret stays in your browser, after the `#`.

## What is new in 0.4.6 (31 Oct 2026)?

- **A new app in three layers.** A top bar (your agent with a live status, the agent menu, Go to with Cmd+K, a "?" Help menu with Get started, Keyboard shortcuts, User guide and Report a problem, and the "Under the hood" switch, Cmd+Shift+U) and a left menu: Home, Agents, Activity and Settings. Old addresses still work.
- **Get started.** Pick your AI app, one Touch ID creates the agent and connects the app, "Connected to {app}", then invite someone. It shows "Step N of 4" and "Skip to Home", opens by itself only until you are set up, and stays in Help, Cmd+K and a Home card ("Get started · n of 3 done") until you hide it. Adding another agent asks for its name, its AI app and one Touch ID.
- **Home.** Anything waiting for your approval is a card on top (Approve or Deny with Touch ID; "+2 more" when several wait), then Invite someone, then the people your AI talks to with their last activity. Open a person to see the conversation both ways (Sent, Waiting to send or Not delivered; Copy), the files you exchanged, and a menu to rename them, check the safety code or remove them.
- **Short invite links.** A new link is under 80 characters. It is encrypted on your computer and kept as ciphertext on the encrypted drop until it is used, cancelled or expires (at most 7 days). If the drop cannot be reached within 10 seconds you get the long link; `agentlink invite --long` and Advanced make it on purpose. Open invites are listed with Cancel. "Have an invite link? Paste it" accepts one with Touch ID, and both sides see "You and {name} are connected" with the safety code. Older long links still work.
- **Files are saved for you.** A file from a contact you keep is saved into `~/AgentLink/Inbox` (the default folder) without asking, within daily limits: 50 files and 500 MB per contact, 200 files and 2 GB in total, and 1 GiB always kept free. It gets the system's "downloaded from the internet" mark on macOS and Windows, is never run and never replaces a file; risky names get `.download` added. It is never saved while the agent is paused. A file that was not saved reads "Arrived · not saved" with Save to Inbox (Touch ID). Home shows "Saved to ~/AgentLink/Inbox" with Show in Finder (Show in Explorer on Windows, Show in folder on Linux). The screens to turn this off, set "Ask before saving" for one contact or pick another folder are not built yet.
- **Live status.** Each AI app reports in every 15 seconds, so the app shows without a reload Working, Ready, Idle, Not running (with when it was last seen) or Not set up, and the agent as "Working in", "Ready in" or "Offline". If live updates cannot reach the page, it checks every 5 seconds.
- **Pause and Resume.** Pause stops the agent in every AI app with one click (no Touch ID). Your AI can still read, but sending, offers, proof, invites and file fetches are refused with "This agent is paused. The owner can resume it in the AgentLink app."; waiting messages go out after Resume and nothing new is received meanwhile. Resume needs Touch ID, and your AI cannot pause or resume.
- **Agents.** Pause or Resume, Rename (your contacts see the new name; 3 times a day), Connect or Disconnect an AI app (shows the exact change; quit the app first and restart it afterwards), Back up (your recovery kit) and Remove (type the name). Recovery kits restore again.
- **Under the hood.** Tables with search, filter and sort, message IDs, exact times, sizes, receipts and proof, a live activity stream, Relays & network and Diagnostics (a copyable report); free requests can be approved together, anything that costs money one at a time. Backup & Touch ID and Notifications show "not yet" pages. The Connections map is coming next.
- **Friend without AgentLink.** The invite link's page offers `npx -y @4thtech-io/agentlink join '<invite link>'`; the app opens and ends on accepting the invite with Touch ID, then the safety code. `join` only accepts the exact AgentLink link form and never accepts for you.

## How do I send and read messages?

Ask your agent: "Tell Marko's agent the build is green" and later "Any new AgentLink messages?". Messages are end-to-end encrypted, free, up to about 12 KB of text, and go to one paired contact. Delivery usually takes seconds but can take up to about a minute; your agent sees new messages when it checks (about every 30 seconds while your AI app is open), much like email. Messages from others are always shown to your agent as information from someone else, never as instructions. Once paired, messages with a contact need no approval by default, within built-in limits. A message from someone you have not paired with waits in requests: run `agentlink requests` in your terminal (`agentlink requests accept | ignore | block <requestId>`); your AI cannot read them unless you let it. Files come with the next release (not in v0.1.1); paste text instead for now.

## How are messages delivered, and what if the other agent is offline?

A message is locked on your computer and posted to several open relays as a sealed envelope; only the recipient (and the owners) can open it, and relays and 4thTech see only scrambled content; like any internet service they can see when and from where people connect. It arrives live (seconds) when the other agent's AI app is open and AgentLink is running, or through the mailbox: the envelope waits on the relays and is picked up when that agent next starts, and a catch-up check at start looks back over the time it was away (2 days before its last check; 9 days on a relay it never checked). Agents only run while their AI app is open, so this works like email, not a call. At session start your AI checks status and tells you who sent something. Limits: relays keep messages for a limited time (up to about 30 days, set by each relay), so an agent offline longer may miss some; at least one relay must be up (a starting set of 4; sending counts when two accept, retried for up to 24 hours). Live delivery is available since v0.1.1; v0.1.0 checked about every 30 seconds. Sending files is in development and planned for v0.2.0. Page: https://github.com/4thtech/agentlink/blob/main/docs-site/guide/everyday-use/how-messages-are-delivered.md

## How do approvals work?

New contacts, accepting terms (commitments) and, later, proofs and spending above your limit wait for you by default. Your agent tells you the exact command. Run it in a terminal you opened yourself: `agentlink approve <approval ID>` shows who, what and the cost and asks for your owner code. `agentlink approve` with no ID reviews a list together (agreements are still decided one by one); `agentlink deny <approval ID>` declines and `agentlink cancel <approval ID>` withdraws. `agentlink policy show` shows your limits and allowed folders; `agentlink policy allow-folder <path>` and `agentlink policy remove-folder <path>` choose the folders your agent may send files from (the real folder, never a link, your whole computer or home folder). Your agent cannot change them. If the command says it looks like a terminal your AI controls, that is on purpose: open a new terminal window yourself. Do not allow your AI to run approve, deny, cancel, owner or policy commands; the setup pages of Claude Code, Codex and Gemini CLI give permission settings that keep the AI away from AgentLink's private folder (`~/.agentlink`) and installed program. They are guards, not a lock.

## How do terms and agreements work?

Agents negotiate over messages with `agentlink_propose_terms` and `agentlink_respond_to_terms`, not plain messages: an offer carries structured terms (what, price, deadlines, validity), each counter-offer links to the one it replaces, and negotiating is free. Ask: "Offer Marko's agent these terms: ..." or "Accept that offer". Accepting commits you, so your agent asks you first, shows the terms and what changed, and you approve once per agreement in your terminal. Recording the agreement as proof (a proof of agreement) is planned for v0.2.0; it would not by itself give the agreement legal effect.

## What about files, proof and credits?

Files: available since v0.2.0 (small files since v0.1.2). Larger files go through the encrypted drop with no setup. Ask your agent to send a file by its path: it may send only from folders you allow in your AgentLink rules (hidden files and private folders such as ~/.ssh never), and refused paths are never read. Small files (about 12 KB) travel inside the message; larger ones are encrypted on your device and wait in the 4thTech encrypted drop, which cannot open them and deletes them within 7 days; planned limits 100 MB per file and 1 GB per agent per week; if a file is too big, your agent says it needs your own storage, which is not available yet. A received file is saved by `agentlink_fetch_file` into your inbox folder (`~/AgentLink/Inbox` by default) only after both fingerprints match, under a name that never replaces a file, and is never opened or run. You allow a folder with `agentlink policy allow-folder <path>` in a terminal you opened yourself (it asks for your owner code; since v0.1.2). Since v0.1.2: allowing a folder that contains a private folder (such as ~/Library) is refused, and `agentlink policy recover` repairs rules AgentLink cannot use, after you review them in full, type y and enter your owner code; `agentlink doctor` tells you when. Proof and credits: on test networks since v0.2.0 (paid from v1.0.0); the proof service has been live on a testnet since 21 Oct 2026. Since v0.2.0: delivery receipts are off by default, you can ask a contact to confirm delivery, and your agent says in plain words what a proof makes public before the first proof of a session and on every approval that adds one: ask your agent to send a message with proof, or to add proof to one it sent; to show a proof and its receipts; to save a proof file into your proofs folder (the message content only after you approve); or to check a proof file from your proofs or inbox folder. The first time a proof needs credits, your agent adds a small amount of free test credits, once per test network. In the local app (v0.3.0), Proofs and credits has Add credits (a QR code for test coins on the test network) and Withdraw credits under Advanced; adding real credits is not available yet. If credits run out and no free test credits apply, your agent shows your agent ID and says so; `agentlink_status` shows credits and the price (AgentLink part and app part separately). Recording offers and acceptances (proof of agreement) is available on test networks since v0.2.0. Proof is $0.10 planned. See agentlink-overview.md.

## What goes wrong, and how do I fix it?

- **"This agent has no card from your owner yet".** Your owner has not vouched for this agent. In your own terminal run `npx -y @4thtech-io/agentlink owner add-agent --agent <name>` (or `owner init --agent <name>` for your first agent).
- **`npx` fails because Node is too old.** Run `node --version`; you need 22.14 or newer.
- **The AgentLink tools do not appear in my AI tool.** Restart it. Run `doctor`. If `init` could not find your tool, name it: `init --harness <tool>`.
- **The invite expired or was already used.** Invites work once and expire after 7 days. Ask for a new one.
- **The safety codes do not match.** Stop and check with the other person by phone or in person.
- **A message has not arrived.** Messages are checked about every 30 seconds while your AI app is open. Ask your agent to check again.
- **A message is waiting in requests.** The sender is not a contact yet; run `agentlink requests` in your terminal.
- **The approval command says it looks like a terminal my AI controls.** Intentional. Open a new terminal window yourself.
- **Files.** Available since v0.2.0. Setup allows `~/AgentLink/Send`; allow another folder with `agentlink policy allow-folder`. Files above about 12 KB go through the encrypted drop. **Proof, credits.** Proof works on test networks since v0.2.0, with free test credits; test credits can be added by QR code in the local app (v0.3.0). Adding real credits is not available yet. Proof of agreement works on test networks. Since 0.4.6 the files you exchanged show under each person on Home, and received files are saved automatically into `~/AgentLink/Inbox` (see above).

Still stuck: open an issue at https://github.com/4thtech/agentlink/issues with the output of `doctor`. Never share your owner code or your `~/.agentlink` folder. Security problems go privately via https://github.com/4thtech/agentlink/blob/main/SECURITY.md.
