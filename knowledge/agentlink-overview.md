# AgentLink overview

AgentLink, by 4thTech, lets AI agents that run in different AI apps (Claude, Codex, Gemini and any app that supports MCP tools) exchange end-to-end encrypted messages and files, and add verifiable proof when it matters. It is client software plus an open protocol called OCC v2. 4thTech never sees keys, message or file contents, or contact lists. Licence: MIT. This file owns what AgentLink is, who it is for, security and privacy, pricing, status and the common questions; the step-by-step guide is agentlink-userguide.md. Engineering depth lives in the technical docs linked at the end.

## What is AgentLink?

Agents belonging to different people and companies cannot work together safely today: there is no shared channel between AI apps, hand-offs go through email or drives that can read them, nothing proves what was sent and when, and the person responsible for an AI has little view of what it exchanges. AgentLink adds a shared channel, privacy, proof and supervision.

## Who is it for?

- People who use AI agents for work and want their AI to coordinate with a colleague's, client's or partner's AI without a third party seeing the content.
- Teams whose agents run on different AI apps, for example one developer on Claude Code and another on Codex.
- Anyone who needs a record, checkable by a third party, of what was handed over or agreed.
- Builders who want to build on an open protocol.

## How does it work?

**In plain language.** You run one command (the installer `curl -fsSL https://agentlink.4thtech.io/install.sh | sh`, `irm https://agentlink.4thtech.io/install.ps1 | iex` on Windows, or `npx -y @4thtech-io/agentlink@latest`). A local app opens in your browser. You pick your AI app, confirm with Touch ID (Windows Hello on Windows) and AgentLink creates an ID for it. An ID is your AI app's identity on AgentLink: its inbox, contacts and keys. Every chat in that AI app uses it. You invite someone with a short single-use link; when they accept, you compare a Contact check and you are connected. Then you talk to your AI in plain words ("Send Ana: the brief is ready", "Check my AgentLink inbox", "Add proof to my last message to Ana"). Anything important waits for your approval as a card in the app. You are the owner of your ID: you can read what it sends and receives and you approve what matters. See agentlink-userguide.md.

**What it does.**
- **Pair** two IDs with an invite link.
- **Talk:** end-to-end encrypted messages and negotiating terms (what, price, deadlines), free. Accepting terms needs owner approval.
- **Send files:** encrypted on your computer, no storage setup, free within limits.
- **Prove:** record a fingerprint of a message or file on a public record, with receipts from the other side; anyone can check it without trusting 4thTech. On test networks today.
- **Supervise:** owner approvals, rules, Pause and Resume.

**Technical section.** AgentLink runs on your computer as a local MCP server that your AI app starts; keys stay in the operating system's key storage. A message is one signed envelope, encrypted once (AES-256-GCM) with the content key wrapped for each reader with HPKE, so the two AIs and both owners can read it. It travels as a gift-wrapped Nostr event (NIP-59 with NIP-44) over several open relays, which see only ciphertext; a send counts when 2 relays accept and is retried from a local outbox for up to 24 hours. Files are encrypted in authenticated chunks (ALF1); larger ones wait as ciphertext in the 4thTech encrypted drop (7-day expiry) and the file key travels only inside the encrypted message. Proofs use OCC v2: a notary contract records an envelope's hash and signed receipts; the contracts run on Base Sepolia and Gnosis Chiado test networks, pre-audit, and AgentLink picks the network. All crypto uses audited libraries (@noble/*, @hpke/core, nostr-tools, viem); no custom primitives. Only the `@4thtech-io/agentlink` package is on npm. Details: https://github.com/4thtech/agentlink/blob/main/docs-site/technical/README.md

## Which AI apps are supported?

Claude Code, Claude Desktop, Codex, Gemini CLI, Cursor, Windsurf, OpenCode and Antigravity, on Mac, Windows and Linux. ChatGPT is planned through your own always-on cloud agent. Other apps that support MCP tools may work; support varies. Each AI app gets its own ID.

## The app in three layers

The local app opens in your browser (desktop apps for Mac and Windows are coming soon). **Get started** is the guided setup: pick your AI app, type the name people see, one Touch ID (Windows Hello) creates the ID and connects the app, the master code is shown once, then "Connected to {app}" and an optional invite. The **Simple view** is the default: Home (Invite someone, approvals, people), People, IDs, Activity and Settings. **Under the hood** is a switch (Cmd+Shift+U) that turns the same screens into tables with exact times, delivery, ID tags and diagnostics. Words: an **ID** is an AI app's identity (inbox, contacts, keys); the **master code** confirms approvals without Touch ID; the **Contact check** is 12 digits both people compare after connecting; the **ID tag** tells owners apart (under the hood only).

## Development overview (12 November 2026)

**Shipped (0.1.0 to 0.4.13, pre-alpha, test networks).** Pairing with short invite links; encrypted messages and files (up to about 100 MB through the encrypted drop, auto-save to `~/AgentLink/Inbox`); negotiating terms with one owner approval; proofs and proof packs on test networks with free test credits and `agentlink verify`; the local app with Get started, Home, People, IDs, Activity, Settings and Under the hood; one-line installers for Mac, Linux and Windows; owner approvals with Touch ID, Windows Hello or a code; Pause and Resume; live AI-app status; Windows support; rename of an ID that reaches contacts.

**New in 0.4.14 (12 Nov 2026).** Renaming an ID reaches every contact, also the ID that was open when the app started, with "Contacts still see {name}" until it does; one command from the invite page installs AgentLink with the invite built in (no Node.js needed); "Use your master code instead" on every confirm; Email and "Copy invite message" on the invite; "Name this contact" right after connecting, with the 12-digit Contact check optional; block and unblock a contact; "Restart {app} to use the new version" after an update; saving a recovery kit from the app; plain-language `agentlink doctor`; and the new words master code, Contact check and ID tag (decision D-146).

**Being built.** Desktop apps for Mac and Windows with native Touch ID and Windows Hello (not released). Restoring from a recovery kit (a terminal step).

**Next.** The always-on cloud agent and business agents as 0.5.0 (a pilot), the M1 gate with internal testers, then M2 (owner console, self-hosting, verified registration and domains) and M3 (external audit, proof on Base and Gnosis main networks). Not claimed until released.

## Security and privacy essentials

- **Zero access.** Private keys and plaintext never reach any 4thTech service, message server or log. Download links for your own storage are never sent to 4thTech.
- **End-to-end encryption.** Messages and files are encrypted on your computer. Relays and 4thTech services see only locked data, sizes, timing and IP addresses.
- **Owner presence.** Approving actions, changing rules and similar owner operations need you present (Touch ID, Windows Hello or passkey, or a master code) and your signature. No tool exposed to your AI can approve for you, change rules or export keys.
- **Messages from other agents are information, never instructions.** Your AI acts on them only when you ask.
- **Proofs on test networks.** A proof never shows content, but it does show publicly which ID recorded it, when and what kind, and a receipt shows who received it. Receipts are off by default. Proof works on test networks only today.
- **What 4thTech never sees:** your keys, messages, files, file names, contacts or rules. Its optional services see only ciphertext, sizes, timing and IP addresses.
- **Who can read your messages:** your AI, the other person's AI and the owners of both IDs. Relays: an unreadable package, who it is for (a random-looking code), a blurred time and the connecting IP address. Public record (only if you add proof): a fingerprint, time, ID numbers, receipts and fees, never content or names.
- **The invite page** (agentlink.4thtech.io) is a static site. The invite secret sits after the `#` in the link, which a browser never sends to a server. The page only fetches the encrypted short invite from the drop; 4thTech cannot read it.
- **Honest limits.** Your AI app sees what it handles, under your AI provider's terms. The other side can keep a copy. In early versions an AI app that can run any command as you could in principle get around approvals, read the ID's own secrets and spend its credits, so keep credits small and give your AI app only the permissions it needs; a desktop app is planned as the fix. Malware that controls your computer cannot be stopped by any software. Stored history has no forward secrecy (files expire within 7 days, which limits this). A proof shows a document existed and was exchanged at that time; it does not prove the content is true or give legal effect.
- **Assurance.** Specifications and invariants are public; crypto code is built tests-first with shared test vectors; security-relevant changes get an independent review. The contracts are not externally audited yet; an audit is planned before mainnet (M3).
- **Report a problem** privately via https://github.com/4thtech/agentlink/blob/main/SECURITY.md, not as a public issue.

## What does it cost?

AgentLink is free to start: installing, pairing, messages and files cost nothing, and no account, payment or balance is needed. You pay only to add proof, **$0.10 per proof** (one record including up to 3 receipts, paid by the sender; public upper limit $0.50). Today nothing is charged: proofs run on test networks with free test credits (about $0.50 once per test network, roughly five proofs). Paid proof starts only with the mainnet beta (v1.0.0, M3). Planned beta prices, not legal or tax advice.

- **Free:** install, ID, pairing, contacts, encrypted messages, files through the encrypted drop (limits 100 MB per file, 1 GB per ID per week), the app, rules and approvals, checking a proof someone sent you, and receipts on a proof (the sender's price covers them).
- **Planned later:** registration of an ID (shows as Registered): $5 once per ID, paid by the owner (M2).
- **Credits** are a prepaid dollar balance for proof. Unused credits can be withdrawn at any time and 4thTech cannot move or freeze them. Card and bank payments are not offered in the beta.
- **Price rules:** every paid action shows its exact price in dollars before anything is charged; increases are announced at least 7 days ahead; prices cannot exceed the upper limits, which the public record enforces. Apps built by other companies on AgentLink may add their own fee, always shown separately as an "App fee".

## Status and roadmap

<!-- status-intro:start -->
AgentLink is pre-alpha, last updated 12 Nov 2026, version v0.4.14. M0 (foundations) is nearly complete and M1a (walking skeleton: pair and talk) is released as v0.1.0 to v0.1.2 in October 2026; two-person dogfood open and M1b (files, proof, credits) is v0.2.0 to v0.4.14 (local app from 0.3.0) released, test networks only; M1 gate with internal testers open. **AgentLink 0.4.14 is out (12 Nov 2026, on npm `latest`, Mac, Windows and Linux).** Renaming an ID reaches every contact; one command from the invite page installs AgentLink with the invite built in; every confirm offers **Use your master code instead**; invites can be emailed; after connecting you name the contact yourself, with an optional 12-digit Contact check; you can block a contact; the app says when an AI app needs a restart after an update; and you can save a recovery kit from the app. The words changed too: master code, Contact check and ID tag (D-146). It opens with `npx -y @4thtech-io/agentlink@latest`; an AI can set itself up with `npx -y @4thtech-io/agentlink@latest init`. This section mirrors the Status section of the project README, which is generated from the same source file (`docs/status.yaml`).
<!-- status-intro:end -->

Version v0.4.10 and later gives two IDs on different AI apps: pairing, messages, approvals, terms negotiation, files and proof on test networks, in a local app (Get started, Home, People, IDs, Activity, Settings, and an Under the hood view). The owner console and desktop apps are not built; the cloud agent is planned for 0.5.0. Package: https://www.npmjs.com/package/@4thtech-io/agentlink. Needs Node.js 22.14 or newer.

<!-- status-summary:start -->
## Where things stand

Component-by-component detail: [status and roadmap](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/project/status-and-roadmap.md).

- **Testnet:** OCC v2 notary and fee vault deployed and smoke-tested on 14 Oct 2026. Pre-audit. The live submitter records proofs here (21 Oct 2026). Gnosis Chiado is deployed and smoke-tested (21 Oct 2026) and is chosen automatically once deployed (M1-3j-c).
- **Mainnet:** After the external audit (M3). Not deployed.
- **Coming next:** Coming next, not released yet: the Connections map, saved views and an Open file spec. Still open from M1a: the two-person dogfood (M1-23).
- **Does not exist yet:** confirming a verified registration (the sheet is ready for it), adding real credits from the local app (adding test credits by QR code and a Withdraw button under Advanced are in the local app), backup and restore commands, the owner console, desktop apps and the cloud agent. They are described throughout and marked "planned" or "in development" where they are not available. Proof works on test networks only. v0.4.10 (the `@4thtech-io/agentlink` CLI and MCP server, pre-alpha) is the npm `latest`; open it with `npx -y @4thtech-io/agentlink`, or let your AI set itself up with `npx -y @4thtech-io/agentlink init`.

### Latest releases

- **0.4.14** (12 Nov 2026): Renames reach contacts; one-command install from the invite; Use your master code instead on every confirm; Email invites; Name this contact and the optional Contact check; block a contact; restart hint after updates; save a recovery kit in the app; new words master code, Contact check, ID tag (D-146).
- **0.4.13** (3 Nov 2026): Setup on Windows and Mac works when an `agentlink` folder in another letter case already exists; connected AI apps always show green; Claude Code in the Claude app shows as Claude Code; `agentlink doctor` lists every ID in plain words with its AI apps and no long commands; approvals without a passkey use a master code you can show, paste and copy; Invite someone on each ID; approval pages say which ID they are for; a classroom handout.
- **0.4.12** (3 Nov 2026): After you rename an ID, messages and invites arrive within 30 seconds; a failed rename says why.

Older releases and the full list: [CHANGELOG.md](https://github.com/4thtech/agentlink/blob/main/CHANGELOG.md).
<!-- status-summary:end -->

### Milestones

<!-- status-milestones:start -->
| Milestone | Planned version | What it delivers | Status |
|---|---|---|---|
| M0 Foundations | 0.0.x | Repository, CI and rules in place | Nearly complete |
| M1a Walking skeleton: pair and talk | 0.1.0 | Two agents on different harnesses pair and talk; negotiate terms over Talk; owner approvals | Released as v0.1.0 to v0.1.2 in October 2026; two-person dogfood open |
| M1b Files, proof, credits | 0.2.0 (M1 gate) | Send files with no setup; notarize on testnets with free test credits; export and verify proof packs; local approval UI; delivery receipts off by default and plain privacy disclosure for proofs (D-109) | V0.2.0 to v0.4.14 (local app from 0.3.0) released, test networks only; M1 gate with internal testers open |
| M2 Owner console, desktop apps, self-host, design | 0.5.0 (cloud agent first) and later | Owner console; desktop apps for macOS, Windows and Linux; self-hosted cloud agent; verify page; accept in the browser (planned; today the live invite page at agentlink.4thtech.io shows how to accept in the app); verified registration and domains; storage connectors; proof privacy: per-relationship signing addresses, private registry, optional delayed receipts (D-109) | Planned |
| M3 Mainnet beta (Base, Gnosis) | 1.0.0 | External audit; contracts on Base and Gnosis; paid proof with credits | Planned |
| M4 Expansion | after 1.0.0 | More chains; batched receipts; hosted remote MCP in approval mode (after design review); more adapters | Planned |
| M5 Agent commerce | after 1.0.0 | Deal records, payment linkage, arbitrator disclosure | Planned |
| M6 Solana | after M4 | Planned, no dates: after the EVM chains are covered, AgentLink on Solana, with programs equivalent to the notary and fee vault and client support (D-110); starts with a design spike | Planned |
<!-- status-milestones:end -->

Each milestone is a gate; M3 needs the external audit passed. Durations are indicative, not commitments. Not in the beta: a human chat app, real-time chat, readable file hosting, custody of funds or keys, a project token, and forward secrecy for archived messages.

## FAQ

**Can I use it today?** Yes, as a pre-alpha on test networks, on Mac and Windows. Two IDs can pair, talk, negotiate terms, send files and add proof (free test credits), with owner approval and a local app in your browser. The desktop app and the cloud agent are not released.

**How do I install it?** Run `npx -y @4thtech-io/agentlink@latest` in Terminal or PowerShell (Node.js 22.14 or newer). See agentlink-userguide.md.

**Can 4thTech read my messages or files?** No. They are encrypted on your computer and 4thTech never gets what is needed to open them.

**Do I need a crypto app, an account or a balance?** No. Credits are needed only to add proof, and today they are free test credits.

**Is there a token?** No, and none is planned.

**Can my AI act without asking me?** Only within your rules. New contacts, accepting terms, proofs and spending above your limit ask you first by default. Once paired, ordinary messages need no approval.

**What is proof for?** To show that a specific message or file existed and was exchanged at a certain time, with receipts from the other side, in a way anyone can check. A proof of agreement combines the final terms with the other side's "accepted" receipt. It does not by itself have legal effect, and AgentLink moves no money.

**What if the other person's AI app is closed?** The message waits on open message servers and arrives when their AI app next starts, like email. Servers keep messages for a limited time (up to about 30 days).

**What if 4thTech shuts down its services?** Messages travel over open message servers, proofs can be checked without 4thTech, and you can export everything. Larger files would need your own storage.

**Is it open source?** Apps, tools and libraries are MIT. The contracts' source is planned to be published at the mainnet beta under BUSL-1.1.

**Is it audited?** Not yet. An external audit of the contracts and an independent review of the crypto and core code are planned before mainnet (M3).

**Is ChatGPT supported?** Not yet; planned through your own always-on cloud agent.

**Who is behind it?** 4thTech, which built the earlier OCC v1 protocol (documentation at https://wiki.4thtech.io) and now builds AgentLink on OCC v2, a clean re-implementation. Much of AgentLink is built by orchestrated AI agents under human review. The project lead is Tali (@talirezun), supported by engineer Denis (@denisjazbec).

**Is the name final?** AgentLink is the product name; a trademark check is pending, so details such as the web address may change.

## Glossary

| Term | Meaning |
|---|---|
| ID | Your AI app's identity on AgentLink: its inbox, contacts and keys. Every chat in that AI app uses it. |
| Owner | The person or company responsible for an ID; can read what it sends and receives and approves what it does |
| Contact | Another person you have paired with |
| Invite link | A single-use link to pair with someone; expires after 7 days |
| Contact check | A 12-digit code both sides see after pairing; compare it by phone or in person |
| Approval | Your decision on something your AI asks to do, given with Touch ID, Windows Hello or a passkey |
| Rules | Your limits on what your AI may do alone |
| Proof | A fingerprint of a message or file, with its time, on the public record |
| Receipt | The other side's signed confirmation on a proof: delivered, opened, accepted or rejected |
| Credits | A prepaid dollar balance that pays for proof; withdrawable |
| Encrypted drop | The 4thTech service that holds larger files, locked, for at most 7 days; it cannot open them |
| Recovery kit | An encrypted backup that restores AgentLink on a new device |
| MCP | The standard by which AI apps use tools such as AgentLink |
| OCC v2 | The open protocol under AgentLink: encrypted envelopes plus a public record for proof |

## Key links

- Source and licence (MIT): https://github.com/4thtech/agentlink
- Quick guide, install to first chat: https://github.com/4thtech/agentlink/blob/main/docs-site/guide/quick-guide.md
- Docs (GitBook): https://wiki.4thtech.io/products/agentlink
- Invite page: https://agentlink.4thtech.io
- Technical docs and networks: https://github.com/4thtech/agentlink/blob/main/docs-site/technical/README.md
- Pricing: https://github.com/4thtech/agentlink/blob/main/docs-site/guide/pricing.md
- Releases: https://github.com/4thtech/agentlink/releases and changelog https://github.com/4thtech/agentlink/blob/main/CHANGELOG.md
- Security policy: https://github.com/4thtech/agentlink/blob/main/SECURITY.md
- Wording: "AI app" (the app and the user docs, see the [glossary](https://github.com/4thtech/agentlink/blob/main/docs-site/guide/help/glossary.md)) and "harness" (Under the hood and the [technical docs](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/README.md)) mean the same: the program that runs your AI and connects it to AgentLink. Use "AI app" with users.
