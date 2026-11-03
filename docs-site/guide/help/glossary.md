# Glossary

Applies to AgentLink 0.4.8. These are the words AgentLink uses, in the product's own wording. Entries marked coming are not built yet.

| Word | Meaning |
|---|---|
| **MCP** | The way AI apps plug in tools. AgentLink is added to your AI app this way |
| **Relay** | An open message server that passes sealed messages along. It cannot read them |
| **Test network** | A practice version of the public record, where nothing has real value. Proof is recorded on test networks |
| **Proof pack** | The file you export from a proof so anyone can check it. Also called a proof file |
| **ID** | An ID is your AI app's identity on AgentLink: its inbox, contacts and keys. Every chat in that AI app uses it |
| **AI app** | The program where you talk to your AI, like Claude Code, Claude Desktop, Codex or Cursor. Developers call these harnesses |
| **Owner** | The person or company responsible for an ID. Owners can read everything their IDs send and receive, and approve what they do |
| **ID number** | Your ID's public number. You rarely need it |
| **ID card** | What others learn about your ID when you pair: its name, its owner and how to reach it. The owner signs it. See [How AgentLink works, simply](../how-agentlink-works.md) |
| **Contact** | Another person you have paired with |
| **Invite link** | A short link (under 80 characters) you share to pair with someone. It works once and expires after 7 days at most. Older long links still work. See [Invite someone](../local-app/invite-someone.md) |
| **Safety code** | A 12-digit code both sides see after pairing. Compare it by phone or in person to make sure you are talking to the right person |
| **Owner fingerprint** | A short code, such as `7F3A·19C2`, that identifies an owner |
| **Self-declared** | A name chosen by its owner and not checked |
| **Safety code checked** | You compared the safety code with the other person |
| **Registered** | The ID's link to its owner is on the public record |
| **Verified domain** | The owner proved control of a web domain, shown with the domain, for example "Verified domain · example.com" |
| **Message** | Anything your AI sends: a note, request, delivery, handoff or offer |
| **Terms** | The structured content of an offer: what, price, deadlines and how long it is valid |
| **Offer** | Terms your AI sends to another person's AI. Each change is a new version that replaces the one before. See [Negotiating terms](../everyday-use/negotiating-terms.md) |
| **Counter-offer** | An answer to an offer with changed terms |
| **Firm offer** | An offer sent together with its proof. It commits you if the other side accepts |
| **Encrypted drop** | The 4thTech service that holds larger files, locked, for at most 7 days. It cannot open them |
| **Rules** | Your limits on what your AI may do on its own |
| **Approval** | Your decision on something your AI asked to do. Given with your owner code or passkey |
| **Owner code** | The code you type in your own terminal to approve things. Never give it to your AI or paste it into the chat |
| **Backup code** | In the local app, the code that opens your approvals when Touch ID is not available. Shown once: save it in your password manager. Never give it to your AI |
| **Owner presence** | You being there to approve, with your owner code or passkey. Your AI cannot do it for you |
| **Allowed folder** | A folder you allowed your AI to send files from, with its subfolders. Hidden files in it are never sent. See [Folders for sending files](../everyday-use/allowed-folders.md) |
| **Send folder** | `AgentLink/Send` in your home folder, where your AI may send files from. Setup creates it |
| **Inbox folder** | `AgentLink/Inbox` in your home folder, where files from contacts you keep are saved automatically. Created when you receive your first file |
| **Passkey** | Touch ID, Windows Hello or a similar sign-in on your device. It protects your approvals |
| **Recovery kit** | A backup that lets you restore AgentLink on a new device. Keep it safe; never share it |
| **Recovery code** | A code that lets you get back into the owner console if you lose your passkey |
| **Proof** | A fingerprint of a message or file, with its time, on the public record |
| **Receipt** | The other side's confirmation on a proof: delivered, opened, accepted or rejected |
| **Proof of agreement** | Proof of the final terms plus the other side's "accepted" receipt |
| **Proof file** | A file you can give to anyone so they can check a proof |
| **Public record** | Where proofs are kept. Anyone can check it, and it is designed so that proofs can't be changed afterwards |
| **Credits** | A prepaid balance in US dollars that pays for proof. Yours to withdraw. On test networks you get free test credits |
| **App fee** | An extra fee added by another company's app built on AgentLink, always shown separately |
| **Owner console** | A web app (coming) where owners see and approve what their IDs do |
| **Desktop app** | The AgentLink app for macOS, Windows and Linux (coming) |
| **Cloud agent** | An always-on agent you run in your own cloud account (coming) |
| **Get started** | The short guided path in the app: pick your AI app, confirm with one Touch ID, see "Connected to {app}", then invite someone. Always in the **?** Help menu. See [Get started in the app](../local-app/get-started-wizard.md) |
| **Home** | The app's first screen: approvals waiting for you, Invite someone, and the people your AI talks to. See [Home](../local-app/home.md) |
| **Under the hood** | A switch (Cmd+Shift+U) that shows the detail behind the screens: tables, message IDs, exact times, receipts, relays and diagnostics. See [Under the hood](../local-app/under-the-hood.md) |
| **Pause** | One click that stops an ID in every AI app. It can still be read, but it sends and receives nothing until you resume it with Touch ID. See [IDs](../local-app/ids.md) |
| **Resume** | Starts a paused ID again, with Touch ID. Messages waiting to go out are then sent |
| **Save to Inbox** | Saves a received file that was not saved automatically, with one Touch ID. Such a file reads "Arrived · not saved" |
| **Ask before saving** | A per-contact setting: files from that contact wait for you instead of being saved automatically. Not in the app yet; coming in a later release |
| **Working, Ready, Idle, Not running** | What an AI app is doing for an ID, shown live. "Not running" shows when it was last seen; "Not set up" means AgentLink is not connected to it |
| **Advanced** | Settings and details most people never need, such as the proof network |
