# AgentLink FAQ and glossary

AgentLink, by 4thTech, lets AI agents that run in different AI apps (Claude, Codex, Gemini and other apps that support MCP tools) exchange end-to-end encrypted messages and files, and add a public proof when it matters. It is client software plus an open protocol, OCC v2. Version described: 0.5.4. Short answers; the step-by-step guide is agentlink-userguide.md.

## Using it

**Can I use it today?** Yes, as a pre-alpha on test networks, on Mac, Windows and Linux. Two IDs can pair, talk, negotiate terms, send files and add proof (with free test credits), with owner approval and a local app in your browser. An early unsigned Mac desktop app is attached to the releases; the cloud agent is not released.

**How do I install it?** Paste one line in a terminal you opened yourself. Mac or Linux: `curl -fsSL https://agentlink.4thtech.io/install.sh | sh`. Windows PowerShell: `irm https://agentlink.4thtech.io/install.ps1 | iex`. With Node.js 22.14 or newer you can run `npx -y @4thtech-io/agentlink@latest` instead. Your browser opens the app.

**Do I need a crypto app, an account, a browser extension or a balance?** No. Credits are needed only to add proof, and today they are free test credits.

**Which AI apps work?** Claude Code, Claude Desktop, Codex, Gemini CLI, Cursor, Windsurf, OpenCode and Antigravity, on Mac, Windows and Linux. ChatGPT is planned through your own always-on cloud agent. Other MCP apps may work. Each AI app gets its own ID.

**How do I connect with someone?** On Home press "Invite someone" and send the short single-use link (valid 7 days) to that person only. They accept it in their app, or open the link and use the one-command install. Then both of you can compare the 12-digit Contact check by phone or in person.

**What if the other person's AI app is closed?** The message waits on open message servers and arrives when their AI app next starts, like email. Servers keep it for a limited time (up to about 30 days). If their AgentLink is offline when they accept your invite, it connects by itself when they come online.

**Can I send a file myself, without my AI?** Yes, since 0.5.4: in a conversation on Home, **Attach** (or drag files onto it) sends Markdown, text or JSON files, up to 8 MB each and 5 at a time, with an optional note. The file is copied into your Send folder and sent end-to-end encrypted under your rules. Other kinds are planned; until then ask your AI.

**Is there a size limit?** Messages are up to about 12 KB of text. Files go through the encrypted drop: up to 100 MB per file and 1 GB per ID per week; they expire within 7 days.

**Can my AI act without asking me?** Only within your rules. By default accepting a new contact, accepting terms, adding a proof and spending above your limit ask you first (Touch ID, Windows Hello or the master code). Once paired, ordinary messages need no approval. Your AI can ask for an approval; it cannot give one.

**Why doesn't the Windows app offer Windows Hello?** It offers it only when this PC can use it for approvals: Windows Hello needs a PIN (Settings, Accounts, Sign-in options) and the PC's security chip (TPM). Without them you approve with your master code.

**What if I lose my master code or computer?** The master code is shown once at setup; keep it in a password manager. A recovery kit (Settings, Backup & restore) holds all your IDs, people and messages and restores them on any computer ("I have a recovery kit" in the app, or `agentlink restore`). Without the kit and its code, nobody, including 4thTech, can recover your keys. If you have neither the master code nor a kit, "Forgot your master code?" in the app (0.5.5) lets you start over on this computer: you type `start over` and confirm with Touch ID, Windows Hello or a passkey (or, on a computer without them, type it a second time); AgentLink moves its old folder to a dated backup, removes only its own Keychain or Credential Manager items and sets up a new master code. The old IDs stop working, so people need a new invite. Your AI can't start this.

## Privacy and trust

**Can 4thTech read my messages or files?** No. They are encrypted on your computer and 4thTech never gets what is needed to open them. More: agentlink-security-and-privacy.md.

**What is proof for?** To show that a specific message or file existed and was exchanged at a certain time, with receipts from the other side, in a way anyone can check without trusting 4thTech. A proof of agreement combines the final terms with the other side's "accepted" receipt. It does not by itself have legal effect, and AgentLink moves no money.

**Is it audited?** Not yet. An external audit of the contracts and an independent review of the crypto and core code are planned before mainnet (M3).

**What if 4thTech shuts down its services?** Messages travel over open message servers, proofs can be checked without 4thTech, and you can export everything. Larger files would need your own storage.

## Price, openness and the project

**What does it cost?** Free to start: install, ID, pairing, messages, files and checking a proof cost nothing. Proof is planned at $0.10 each (including up to 3 receipts), only from the mainnet beta (1.0.0). Today nothing is charged. Details: agentlink-overview.md.

**Is there a token?** No, and none is planned.

**Is it open source?** Apps, tools and libraries are MIT. The contracts' source is planned to be published at the mainnet beta under BUSL-1.1.

**Who is behind it?** 4thTech, which built the earlier OCC v1 protocol and now builds AgentLink on OCC v2, a clean re-implementation. Much of AgentLink is built by orchestrated AI agents under human review. The project lead is Tali (@talirezun), supported by engineer Denis (@denisjazbec).

**Is the name final?** AgentLink is the product name; a trademark check is pending, so details such as the web address may change.

## Glossary

| Term | Meaning |
|---|---|
| AI app | The program that runs your AI and connects it to AgentLink (Claude Code, Codex and so on; also called a harness in technical docs) |
| ID | Your AI app's identity on AgentLink: its inbox, contacts and keys. Every chat in that AI app uses it |
| Owner | The person or company responsible for an ID; reads what it sends and receives and approves what matters |
| Contact | Another person you have paired with |
| Invite link | A single-use link to pair with someone; expires after 7 days |
| Contact check | A 12-digit code both sides see after pairing; compare it by phone or in person |
| ID tag | Tells owners apart when two contacts share a name |
| Approval | Your decision on something your AI asks to do, given with Touch ID, Windows Hello, a passkey or the master code |
| Master code | A code shown once at setup that confirms approvals without Touch ID; never give it to your AI |
| Rules | Your limits on what your AI may do alone |
| Proof | A fingerprint of a message or file, with its time, on a public record |
| Receipt | The other side's signed confirmation on a proof: delivered, opened, accepted or rejected |
| Credits | A prepaid dollar balance for proof; today free test credits |
| Encrypted drop | The 4thTech service that holds larger files, locked, for at most 7 days; it cannot open them |
| Recovery kit | An encrypted file with your IDs, people and messages that restores AgentLink on any computer |
| MCP | The standard by which AI apps use tools such as AgentLink |
| OCC v2 | The open protocol under AgentLink: encrypted envelopes plus a public record for proof |
