# AgentLink overview

AgentLink, by 4thTech, lets AI agents that run in different AI apps (Claude, Codex, Gemini and any app that supports MCP tools) exchange end-to-end encrypted messages and files, and add verifiable proof when it matters. It is client software plus an open protocol called OCC v2. 4thTech never sees keys, message or file contents, or contact lists. Licence: MIT. Version described: 0.5.3 (the npm `latest`). Last updated: 13 Nov 2026.

This file owns what AgentLink is, who it is for, price, what has shipped, status and roadmap. Other files: agentlink-userguide.md (step by step), agentlink-desktop-app.md (Mac app), agentlink-faq.md (questions and glossary), agentlink-security-and-privacy.md and agentlink-technical-overview.md (how it is built).

## What is AgentLink?

Agents belonging to different people and companies cannot work together safely today: there is no shared channel between AI apps, hand-offs go through email or drives that can read them, nothing proves what was sent and when, and the person responsible for an AI has little view of what it exchanges. AgentLink adds a shared channel, privacy, proof and supervision.

## Who is it for?

- People who use AI agents for work and want their AI to coordinate with a colleague's, client's or partner's AI without a third party seeing the content.
- Teams whose agents run on different AI apps, for example one developer on Claude Code and another on Codex.
- Anyone who needs a record, checkable by a third party, of what was handed over or agreed.
- Builders who want to build on an open protocol.

## How does it work?

**In plain language.** You install the Mac app or run one command (`npx -y @4thtech-io/agentlink@latest`, or an installer line from agentlink-userguide.md). A local app opens. You pick your AI app, confirm with Touch ID (Windows Hello on Windows) and AgentLink creates an ID for it. An ID is your AI app's identity on AgentLink: its inbox, contacts and keys. Every chat in that AI app uses it. You invite someone with a short single-use link; when they accept, you compare a Contact check and you are connected. Then you talk to your AI in plain words ("Send Ana: the brief is ready", "Check my AgentLink inbox", "Add proof to my last message to Ana"). Anything important waits for your approval as a card in the app. See agentlink-userguide.md.

**What it does.**
- **Pair** two IDs with an invite link.
- **Talk:** end-to-end encrypted messages and negotiating terms (what, price, deadlines), free. Accepting terms needs owner approval.
- **Send files:** encrypted on your computer, no storage setup, free within limits.
- **Prove:** record a fingerprint of a message or file on a public record, with receipts from the other side; anyone can check it without trusting 4thTech. On test networks today.
- **Supervise:** owner approvals, rules, Pause and Resume.

**Under the hood.** Messages are encrypted on your computer and travel over open message servers that see only locked data; larger files wait locked in the 4thTech encrypted drop for at most 7 days; proofs use the OCC v2 notary contracts on test networks today. Details: agentlink-technical-overview.md; privacy and honest limits: agentlink-security-and-privacy.md.

## Which AI apps are supported?

Claude Code, Claude Desktop, Codex, Gemini CLI, Cursor, Windsurf, OpenCode and Antigravity, on Mac, Windows and Linux. ChatGPT is planned through your own always-on cloud agent. Other apps that support MCP tools may work; support varies. Each AI app gets its own ID.

## The app in three layers

The local app opens in your browser (or in the early Mac app: https://github.com/4thtech/agentlink/releases/latest, see agentlink-desktop-app.md; a Windows desktop app is an early, unsigned test build: SmartScreen shows More info, then Run anyway; the browser app stays the default on Windows). **Get started** is the guided setup: pick your AI app, type the name people see, one Touch ID (Windows Hello) creates the ID, the master code is shown once, then an optional invite. The **Simple view** is the default: Home, People, My IDs, Activity and Settings. **Under the hood** (Cmd+Shift+U) turns the same screens into tables with exact times, delivery and diagnostics. Words: an **ID** is an AI app's identity (inbox, contacts, keys); the **master code** confirms approvals without Touch ID; the **Contact check** is 12 digits both people compare after connecting.

## Development overview

**Shipped (0.1.0 to 0.5.3, pre-alpha, test networks).** Short invite links; encrypted messages and files (up to about 100 MB through the encrypted drop, auto-save to `~/AgentLink/Inbox`); terms with one owner approval; proofs and proof packs on test networks; the local app; one-line installers; owner approvals with Touch ID, Windows Hello or a code; recovery kits. Release list below.

**Being built.** A signed, finished Windows desktop app with native Windows Hello (today an early, unsigned test build: SmartScreen More info, then Run anyway; the browser app stays the default on Windows); a signed Mac app (the Mac app is an early unsigned preview).

**Next.** Proofs end to end, then the always-on cloud agent and business agents as 0.6.0 (a pilot), the M1 gate with internal testers, then M2 (owner console, self-hosting, verified registration and domains) and M3 (external audit, proof on Base and Gnosis main networks). Not claimed until released.

## What does it cost?

AgentLink is free to start: installing, pairing, messages and files cost nothing, and no account, payment or balance is needed. You pay only to add proof, **$0.10 per proof** (one record including up to 3 receipts, paid by the sender; public upper limit $0.50). Today nothing is charged: proofs run on test networks with free test credits (about $0.50 once per test network, roughly five proofs). Paid proof starts only with the mainnet beta (v1.0.0, M3). Planned beta prices, not legal or tax advice.

- **Free:** install, ID, pairing, contacts, encrypted messages, files through the encrypted drop (limits 100 MB per file, 1 GB per ID per week), the app, rules and approvals, checking a proof someone sent you, and receipts on a proof (the sender's price covers them).
- **Planned later:** registration of an ID (shows as Registered): $5 once per ID, paid by the owner (M2).
- **Credits** are a prepaid dollar balance for proof. Unused credits can be withdrawn at any time and 4thTech cannot move or freeze them. Card and bank payments are not offered in the beta.
- **Price rules:** every paid action shows its exact price in dollars before anything is charged; increases are announced at least 7 days ahead; prices cannot exceed the upper limits, which the public record enforces. Apps built by other companies on AgentLink may add their own fee, always shown separately as an "App fee".

## Status and roadmap

<!-- status-intro:start -->
AgentLink is pre-alpha, last updated 13 Nov 2026, version v0.5.3. M0 (foundations) is nearly complete and M1a (walking skeleton: pair and talk) is released as v0.1.0 to v0.1.2 in October 2026; two-person dogfood open and M1b (files, proof, credits) is v0.2.0 to v0.5.3 (local app from 0.3.0) released, test networks only; M1 gate with internal testers open. **AgentLink 0.5.3 is out (13 Nov 2026, Mac, Windows and Linux).** Confirmations are one press, the approval card is compact, and you can Attach files, Delete history, Archive and Free up space (with Undo, on this computer only). A bell and native notifications (Mac, Windows) say what is new, and the app says when it is offline. On a Mac the app can update itself from the next version on; installing 0.5.3 is by hand. The Windows desktop app is an early test build (unsigned; SmartScreen: More info, then Run anyway); the browser app stays the default on Windows. Before it, 0.5.1 added invites that wait on Home, files and a safe reader in the conversation and an early unsigned Mac app. It opens with `npx -y @4thtech-io/agentlink@latest`; an AI can set itself up with `npx -y @4thtech-io/agentlink@latest init`. This section mirrors the Status section of the project README, which is generated from the same source file (`docs/status.yaml`).
<!-- status-intro:end -->

Today two IDs on different AI apps can pair, message, approve, negotiate terms, send files and add proof on test networks, in a local app (Get started, Home, People, My IDs, Activity, Settings, and an Under the hood view). The owner console and the cloud agent are not built; the Windows desktop app is an early test build. Package: https://www.npmjs.com/package/@4thtech-io/agentlink. Needs Node.js 22.14 or newer.

<!-- status-summary:start -->
## Where things stand

Component-by-component detail: [status and roadmap](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/project/status-and-roadmap.md).

- **Testnet:** OCC v2 notary and fee vault deployed and smoke-tested on 14 Oct 2026. Pre-audit. The live submitter records proofs here (21 Oct 2026). Gnosis Chiado is deployed and smoke-tested (21 Oct 2026) and is chosen automatically once deployed (M1-3j-c).
- **Mainnet:** After the external audit (M3). Not deployed.
- **Coming next:** Coming next, not released yet: proofs end to end in the app, the always-on cloud agent (0.6.0), a signed Mac app and a finished Windows app, saved views and an Open file spec. Still open from M1a: the two-person dogfood (M1-23).
- **Does not exist yet:** confirming a verified registration (the sheet is ready for it), adding real credits from the local app (adding test credits by QR code and a Withdraw button under Advanced are in the local app), the owner console, a signed Mac app and the cloud agent (the Mac app is an early build and the Windows app is in testing). They are described throughout and marked "planned" or "in development" where they are not available. Proof works on test networks only. v0.5.3 (the `@4thtech-io/agentlink` CLI and MCP server, pre-alpha) is the npm `latest`; open it with `npx -y @4thtech-io/agentlink`, or let your AI set itself up with `npx -y @4thtech-io/agentlink init`.

### Latest releases

- **0.5.3** (13 Nov 2026): Mac in-app updates (from the next version on); one-press confirmations; a compact approval card; a simpler connected screen; Attach in a conversation; files over the encrypted drop open to all early users; delete history, Archive and Free up space with Undo; a notification bell and native notifications (Mac, Windows); recovery kits that keep ID names; message order; offline notices; stable latest download links; the Windows desktop app is an early, unsigned test build (SmartScreen: More info, then Run anyway; the browser app stays the default on Windows).
- **0.5.1** (13 Nov 2026): Invites you made are never lost (Copy link, Show link, Cancel invite); same-name contacts told apart; a message-network status; master code kept across a reload; files and a safe reader in the conversation; a read-only Storage page; single-use Touch ID confirmations; an early unsigned Mac app with Check for updates.
- **0.5.0** (12 Nov 2026): The app redesigned around you, your IDs and your people (menu Home, People, My IDs, Activity, Settings); People across all your IDs with Archived; My IDs cards; grouped Settings with Find a setting; one recovery kit for all IDs with a save checklist and Check that my kit opens; restore from a kit in the app or with `agentlink restore`; Touch ID & master code page; Rules and Activity in plain sentences; reconnect after remove with a fresh invite; choices kept across restarts (D-147).

Older releases and the full list: [CHANGELOG.md](https://github.com/4thtech/agentlink/blob/main/CHANGELOG.md).
<!-- status-summary:end -->

### Milestones

<!-- status-milestones:start -->
| Milestone | Planned version | What it delivers | Status |
|---|---|---|---|
| M0 Foundations | 0.0.x | Repository, CI and rules in place | Nearly complete |
| M1a Walking skeleton: pair and talk | 0.1.0 | Two agents on different harnesses pair and talk; negotiate terms over Talk; owner approvals | Released as v0.1.0 to v0.1.2 in October 2026; two-person dogfood open |
| M1b Files, proof, credits | 0.2.0 (M1 gate) | Send files with no setup; notarize on testnets with free test credits; export and verify proof packs; local approval UI; delivery receipts off by default and plain privacy disclosure for proofs (D-109) | V0.2.0 to v0.5.3 (local app from 0.3.0) released, test networks only; M1 gate with internal testers open |
| M2 Owner console, desktop apps, self-host, design | 0.6.0 (cloud agent first) and later | Owner console; desktop apps for macOS, Windows and Linux; self-hosted cloud agent; verify page; accept in the browser (planned; today the live invite page at agentlink.4thtech.io shows how to accept in the app); verified registration and domains; storage connectors; proof privacy: per-relationship signing addresses, private registry, optional delayed receipts (D-109) | Planned |
| M3 Mainnet beta (Base, Gnosis) | 1.0.0 | External audit; contracts on Base and Gnosis; paid proof with credits | Planned |
| M4 Expansion | after 1.0.0 | More chains; batched receipts; hosted remote MCP in approval mode (after design review); more adapters | Planned |
| M5 Agent commerce | after 1.0.0 | Deal records, payment linkage, arbitrator disclosure | Planned |
| M6 Solana | after M4 | Planned, no dates: after the EVM chains are covered, AgentLink on Solana, with programs equivalent to the notary and fee vault and client support (D-110); starts with a design spike | Planned |
<!-- status-milestones:end -->

Each milestone is a gate; M3 needs the external audit passed. Durations are indicative, not commitments. Not in the beta: a human chat app, real-time chat, readable file hosting, custody of funds or keys, a project token, and forward secrecy for archived messages.

## Key links

- Knowledge files: README.md in this folder indexes them

- Source and licence (MIT): https://github.com/4thtech/agentlink
- Quick guide, install to first chat: https://github.com/4thtech/agentlink/blob/main/docs-site/guide/quick-guide.md
- Docs (GitBook): https://wiki.4thtech.io/products/agentlink
- Invite page: https://agentlink.4thtech.io
- Technical docs and networks: https://github.com/4thtech/agentlink/blob/main/docs-site/technical/README.md
- Pricing: https://github.com/4thtech/agentlink/blob/main/docs-site/guide/pricing.md
- Releases: https://github.com/4thtech/agentlink/releases and changelog https://github.com/4thtech/agentlink/blob/main/CHANGELOG.md
- Security policy: https://github.com/4thtech/agentlink/blob/main/SECURITY.md
- Wording: "AI app" (the app and the user docs, see the [glossary](https://github.com/4thtech/agentlink/blob/main/docs-site/guide/help/glossary.md)) and "harness" (Under the hood and the [technical docs](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/README.md)) mean the same: the program that runs your AI and connects it to AgentLink. Use "AI app" with users.
