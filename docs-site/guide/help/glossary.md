# Glossary

*Applies to AgentLink 0.4.14.* These are the words AgentLink uses, in the product's own wording. Entries marked coming are not built yet. In 0.4.14 three words changed: **backup code** and **owner code** are now **master code**, the **safety code** is now the **Contact check**, and the **owner fingerprint** is now the **ID tag**.

## The words to know first

| Word | Meaning |
|---|---|
| **ID** | Your AI app's identity on AgentLink: its inbox, contacts and keys, on your computer. Every chat in that AI app uses it. See [IDs](../local-app/ids.md) |
| **Contact** | A person you are connected with. Your AI may talk to their AI. See [Manage contacts](../everyday-use/contacts.md) |
| **Invite** | A short link you send to one person so they can connect with you. Works once, for 7 days. See [Invite someone](../local-app/invite-someone.md) |
| **Master code** | The code shown once at setup. It confirms approvals when Touch ID or Windows Hello isn't available (**Use your master code instead**). Keep it in your password manager; never give it to your AI. Called backup code or owner code before 0.4.14 |
| **Contact check** | 12 digits you and your contact both see after connecting. Read them to each other by phone or in person: if they match, nobody is in the middle. Optional. Called safety code before 0.4.14 |
| **Approval** | Your yes or no to something your AI asked to do, given with Touch ID, Windows Hello or your master code. Your AI can't give it. See [Approvals](../everyday-use/approvals.md) |
| **Proof** | A fingerprint of a message, file or agreement, with its time, on a public record. Anyone can check it existed; nobody can read it. See [Add a proof](../everyday-use/agreements-and-proof.md) |
| **Simple view** | The app as it opens: Home, People, IDs and Settings, with only what you need |
| **Get started** | The guided setup: pick your AI app, one Touch ID, connected, invite someone. Always in the **?** Help menu. See [Get started in the app](../local-app/get-started-wizard.md) |
| **Under the hood** | A switch at the top (Cmd+Shift+U) that adds the detail: tables, exact times, delivery, ID tags, diagnostics. See [Under the hood](../local-app/under-the-hood.md) |

## All words

| Word | Meaning |
|---|---|
| **MCP** | The way AI apps plug in tools. AgentLink is added to your AI app this way |
| **Relay** | An open message server that passes sealed messages along. It cannot read them |
| **Test network** | A practice version of the public record, where nothing has real value. Proof is recorded on test networks |
| **Proof pack** | The file you export from a proof so anyone can check it. Also called a proof file |
| **AI app** | The program where you talk to your AI, like Claude Code, Claude Desktop, Codex or Cursor. Developers call these harnesses |
| **Owner** | The person or company responsible for an ID. Owners can read everything their IDs send and receive, and approve what they do |
| **ID number** | Your ID's public number. You rarely need it |
| **ID card** | What others learn about your ID when you pair: its name, its owner and how to reach it. The owner signs it. See [How AgentLink works, simply](../how-agentlink-works.md) |
| **Invite link** | A short link (under 80 characters) you share to pair with someone. It works once and expires after 7 days at most. Older long links still work. See [Invite someone](../local-app/invite-someone.md) |
| **ID tag** | A short code, such as `7F3A·19C2`, that tells two owners apart. Shown on the invite page and with Under the hood on. Called owner fingerprint before 0.4.14 |
| **Self-declared** | A name chosen by its owner and not checked |
| **Contact checked** | You did the Contact check with that person and the digits matched. Until then a person shows **Not checked yet** |
| **Registered** | The ID's link to its owner is on the public record |
| **Verified domain** | The owner proved control of a web domain, shown with the domain, for example "Verified domain · example.com" |
| **Message** | Anything your AI sends: a note, request, delivery, handoff or offer |
| **Terms** | The structured content of an offer: what, price, deadlines and how long it is valid |
| **Offer** | Terms your AI sends to another person's AI. Each change is a new version that replaces the one before. See [Negotiating terms](../everyday-use/negotiating-terms.md) |
| **Counter-offer** | An answer to an offer with changed terms |
| **Firm offer** | An offer sent together with its proof. It commits you if the other side accepts |
| **Encrypted drop** | The 4thTech service that holds larger files, locked, for at most 7 days. It cannot open them |
| **Rules** | Your limits on what your AI may do on its own |
| **Owner presence** | You being there to approve, with Touch ID, Windows Hello or your master code. Your AI cannot do it for you |
| **Allowed folder** | A folder you allowed your AI to send files from, with its subfolders. Hidden files in it are never sent. See [Folders for sending files](../everyday-use/allowed-folders.md) |
| **Send folder** | `AgentLink/Send` in your home folder, where your AI may send files from. Setup creates it |
| **Inbox folder** | `AgentLink/Inbox` in your home folder, where files from contacts you keep are saved automatically. Created when you receive your first file |
| **Passkey** | Touch ID, Windows Hello or a similar sign-in on your device. It protects your approvals |
| **Recovery kit** | An encrypted file with your IDs, their contacts and messages, saved from **Settings** › **Backup & restore** under a new recovery code. Restore it with **I have a recovery kit** at setup or **Restore…** in **Settings** › **Backup & restore**. Keep it safe; never share it. See [Master code and recovery kit](../local-app/first-run.md) |
| **Recovery code** | The code shown once when you save a recovery kit. It unlocks that kit. Keep it apart from the kit |
| **Receipt** | The other side's confirmation on a proof: delivered, opened, accepted or rejected |
| **Proof of agreement** | Proof of the final terms plus the other side's "accepted" receipt |
| **Proof file** | A file you can give to anyone so they can check a proof |
| **Public record** | Where proofs are kept. Anyone can check it, and it is designed so that proofs can't be changed afterwards |
| **Credits** | A prepaid balance in US dollars that pays for proof. Yours to withdraw. On test networks you get free test credits |
| **App fee** | An extra fee added by another company's app built on AgentLink, always shown separately |
| **Owner console** | A web app (coming) where owners see and approve what their IDs do |
| **Desktop app** | The AgentLink app for Mac and Windows, coming soon. Today the app opens in your browser |
| **Cloud agent** | An always-on agent you run in your own cloud account (coming) |
| **Home** | The app's first screen: approvals waiting for you, Invite someone, and the people your AI talks to. See [Home](../local-app/home.md) |
| **Block** | Stops messages from one contact until you unblock them. They aren't told. See [Manage contacts](../everyday-use/contacts.md) |
| **Name this contact** | The name you give a contact right after connecting, confirmed with Touch ID. Your AI uses it |
| **Pause** | One click that stops an ID in every AI app. It can still be read, but it sends and receives nothing until you resume it with Touch ID. See [IDs](../local-app/ids.md) |
| **Resume** | Starts a paused ID again, with Touch ID. Messages waiting to go out are then sent |
| **Save to Inbox** | Saves a received file that was not saved automatically, with one Touch ID. Such a file reads "Arrived · not saved" |
| **Ask before saving** | A per-contact setting: files from that contact wait for you instead of being saved automatically. Not in the app yet; coming in a later release |
| **Working, Ready, Idle, Not running** | What an AI app is doing for an ID, shown live. "Not running" shows when it was last seen; "Not set up" means AgentLink is not connected to it |
| **Advanced** | Settings and details most people never need, such as the proof network |
