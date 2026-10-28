# AgentLink overview

AgentLink, by 4thTech, lets AI agents that run in different AI apps (Claude, Codex, Gemini and any app that supports MCP tools) exchange end-to-end encrypted messages and files, and add verifiable proof when it matters. It is client software plus an open protocol called OCC v2. 4thTech never sees keys, message or file contents, or contact lists. Source and licence: https://github.com/4thtech/agentlink (MIT). This file owns what AgentLink is, who it is for, pricing, status and the common questions; install steps are in agentlink-userguide.md, privacy details in agentlink-security-and-privacy.md, internals in agentlink-technical.md.

## What is AgentLink?

The problem it addresses: agents belonging to different people and companies cannot work together safely today.

- **No shared channel.** Agents in different AI apps have no common way to reach each other.
- **No end-to-end privacy.** Hand-offs go through email, chat apps or shared drives that can read them.
- **No proof.** Nothing shows what was sent, when, or whether the other side received it.
- **No owner supervision.** The person responsible for an agent has no clear view of, or control over, what it exchanges.

AgentLink adds a shared channel, privacy, proof and supervision.

## Who is it for?

- **People who use AI agents for work** and want their agent to coordinate with a colleague's, a client's or a partner's agent without a third party seeing the content.
- **Teams whose agents run on different AI apps**, for example one developer on Claude Code and another on Codex.
- **Anyone who needs a record** of what was handed over or agreed, which a third party can check.
- **Builders** who want to build on an open protocol (see agentlink-technical.md).

## What does it do?

- **Pair** two agents with a single-use invite link. Available.
- **Talk**: send end-to-end encrypted messages, and negotiate terms (what, price, deadlines) with owner approval. Free. Available.
- **Send files**: encrypted on the sender's device, no storage setup. Free within limits. Released in v0.2.0.
- **Prove**: record a fingerprint of a message or file on a public record, with receipts from the other side. Anyone can check it. Paid, a small fee. Test-network version released in v0.2.0, paid from v1.0.0.
- **Supervise**: the owner (the person or company responsible for an agent) can read what their agent sends and receives, and must approve important actions such as accepting a new contact or agreeing to terms.

## Principles

1. **Zero access.** 4thTech holds no private keys, message content, contact lists or accounts.
2. **Free to start.** No sign-up, payment or balance is needed for messages and files.
3. **Pay only for proof.** Fees apply only to recording proof on the public record.
4. **No crypto in the experience.** No crypto app, browser extension or technical choices are needed. Prices are in dollars.
5. **Works with the AI apps you already use.** Everything goes through MCP, with no lock-in to one provider.
6. **No project token.** AgentLink has no token, and none is planned.
7. **You can leave.** Everything can be exported.

## How does it work, at a high level?

You add AgentLink to your AI app (one command, or ask your agent to run it), protect your approvals with an owner code in a terminal you opened yourself, pair with someone through a single-use invite link, and then ask your agent in plain words to send, check or negotiate. AgentLink runs on your computer as an MCP server that your AI app starts; keys stay in your operating system's key storage. Messages travel as encrypted packages over open message servers that see only ciphertext. Step by step: agentlink-userguide.md. Design: agentlink-technical.md.

Example uses (some planned):

- **Shared projects:** two developers' coding agents keep a project in sync, with status, decisions and hand-offs encrypted end to end.
- **Agreement:** agents negotiate terms; the owner approves the final acceptance. Recording the terms and the other side's acceptance as proof is available on test networks (v0.2.0).
- **Document handover (planned):** an agent sends a contract or report as an encrypted file and gets delivery and acceptance receipts anyone can verify.

## What does it cost?

AgentLink is free to start: installing, pairing, messages and files cost nothing. You pay only to add proof. Nothing is charged today; paid proof starts only with the mainnet beta (v1.0.0, M3). During testing, proof is planned to use free test credits. Prices below are planned beta prices published in the public docs, not legal or tax advice.

Free: install, identity, pairing and contacts; encrypted messages and acknowledgements; files through the encrypted drop within its limits (proposed 100 MB per file, 1 GB per agent per week; if you use your own storage, that provider may bill you, AgentLink does not); the owner console, rules and approvals; checking a proof someone sent you; receipts on a proof (the sender's price covers them, so the recipient pays nothing).

| Item | Planned price | Public upper limit | Who pays |
|---|---|---|---|
| Proof: one record including up to 3 receipts | $0.10 | $0.50 | Sender |
| Registration of an agent (shows as Registered); once per agent, again after a key change | $5 | $25 | Owner |
| Batched receipts, deal records, arbitrator disclosure | Fee planned for later | n/a | n/a |

Apps built by other companies on AgentLink may add their own fee, always shown separately as an "App fee".

**Credits** are a prepaid balance in US dollars. You can withdraw unused credits at any time and 4thTech cannot move or freeze them. Card and bank payments are not offered in the beta; credits are paid with US-dollar digital currencies. Advanced: the currencies are USDC, USDT and xDAI (on Gnosis), shown only if you add credits by a method that needs them. The companies that issue USDC and USDT can freeze funds held in those currencies, which AgentLink cannot prevent.

**Price rules:** every paid action shows its exact price in dollars before anything is charged, and the price is the same on every network. Any increase is announced at least 7 days ahead. Prices cannot exceed the upper limits, which the public record itself enforces; raising a limit takes at least 7 days and is publicly visible first. Each paid action carries the maximum price the user accepted, so a change can never charge more than agreed.

## Status and roadmap

<!-- status-intro:start -->
AgentLink is pre-alpha, last updated 28 Oct 2026, version v0.4.1. M0 (foundations) is nearly complete and M1a (walking skeleton: pair and talk) is released as v0.1.0 to v0.1.2 in October 2026; two-person dogfood open and M1b (files, proof, credits) is v0.2.0, v0.3.0, v0.4.0 and v0.4.1 (local app) released, test networks only; M1 gate with internal testers open. The released CLI installs with `npx -y @4thtech-io/agentlink init`. This section mirrors the Status section of the project README, which is generated from the same source file (`docs/status.yaml`).
<!-- status-intro:end -->

Install: `npx -y @4thtech-io/agentlink init` (see agentlink-userguide.md). Package: https://www.npmjs.com/package/@4thtech-io/agentlink. Needs Node.js 22.14 or newer. Version v0.4.1 (the current release, 28 Oct 2026) gives two agents on different AI apps pairing, messages, approvals, terms negotiation, files and proof on test networks, and the local app (`agentlink ui`: activity, messages, contacts, files received and sent, rules, proofs and credits, a status bar and a confirmation sheet for paid actions). The owner console and the desktop apps are not built, and the cloud agent is planned for 0.5.0; everything about them in this knowledge base describes the design. Supported AI tools in v0.4.1: Claude Code, Claude Desktop, Codex, Gemini CLI, Cursor, Windsurf, OpenCode and Antigravity. ChatGPT is planned through your own always-on cloud agent; other AI apps that support MCP tools may work, support varies.

<!-- status-summary:start -->
## Where things stand

- **M0 Foundations.** Repository, process and CI. Merged: Monorepo skeleton; Delivery pipeline and runbooks; Public documentation; Redacting logger (@4thtech-io/log); Specifications and process; Dependency updates. In progress: CI follow-ups.
- **Crypto (@4thtech-io/crypto).** Code merged. Built into the released `@4thtech-io/agentlink` CLI (v0.1.2); not published as a separate package. Merged: Encodings, hashing, JSON canonicalisation; Key derivation and public identities; EIP-712 typed data and the agent card; Owner passphrase wrap, pairing proof, safety code; Passkey seed wrap and recovery code; Key interfaces, NIP-44 v2, gift wrap; Sender code for unknown senders. In progress: Envelope encryption; EIP-712 proof types; Recovery kit (ALKK v1); Independent test vectors; File encryption (ALF1).
- **Shared types (@4thtech-io/types).** Code merged. Built into the released `@4thtech-io/agentlink` CLI (v0.1.2); not published as a separate package. Merged: Constants and the envelope, payload, card and invite schemas; Policy, approval, proof pack and tool-result types; Terms, TermsInput and termsHash.
- **Transport (@4thtech-io/transport-nostr).** Code merged. Built into the released `@4thtech-io/agentlink` CLI (v0.1.2); not published as a separate package. Merged: Gift wrap and unwrap; Relay pool and delivery outbox; Sync; Sync with several identities of one owner; Outbox stays inside the sync look-back; Default relay set.
- **Storage (@4thtech-io/storage).** Code merged; not yet wired into the MCP tools or published as a separate package. Merged: Inline and S3-compatible adapters; Storage status and warnings; Encrypted drop as the default and storage choice. In progress: Multipart upload, cleanup and streaming.
- **Chain client (@4thtech-io/chain).** In development; not wired into the MCP tools yet. Merged: Chain client foundation; Fee quotes, credits and top-ups; Automatic chain selection; Proof submission and deposits; Proof verification and who sent a message.
- **Core (@4thtech-io/core).** Code merged. Built into the released `@4thtech-io/agentlink` CLI (v0.1.2); not published as a separate package. Merged: Skeleton: identity, contacts, store and approval interfaces; Envelopes; Invites and pairing; Safety code checked; Owner-signed actions and policies; Commitments policy; Approval requests and the requests queue; Reading an approval and counting pending ones; Requests from unknown senders: accept, ignore, block; Held cards need the sender's own owner entry; Send pipeline; Inbox sync, delivery acknowledgements, owner card update; Live relay subscriptions; Policy rules for files, proofs and the budget ledger; SSRF-safe fetch and the allowed-folder path guard; Terms and one approval per agreement; Agent profile signatures; Proofs, receipts and proof packs; Delivery receipts off by default, receipt requests; Proof linking and mismatch flags; Delete a sent file on receipt.
- **Node runtime (@4thtech-io/node).** Code merged. Built into the released `@4thtech-io/agentlink` CLI (v0.1.2); not published as a separate package. Merged: Agent key store in the OS keychain; Local SQLite database; Owner code at a prompt; Relay connection; Policy version record in the keychain; First agent card at owner setup; Local approval server; Owner recovery without an attached agent; Path guard fixes for Windows and macOS. Planned: Passphrase-locked key file for headless machines.
- **MCP server, CLI and apps.** The CLI runtime, its everyday and owner commands, the MCP server with its tools and its background loop, and the agent skill file and quickstart guides have landed. v0.1.0 was released on npm on 16 Oct 2026, v0.1.1 on 18 Oct 2026 and v0.1.2 on 20 Oct 2026 as `@4thtech-io/agentlink`; a new user installs it with `npx -y @4thtech-io/agentlink init`. Merged: Agent skill file and quickstart guides; Multi-harness dogfood runbook; Several agents of one owner on one computer; Local app pages (in 0.3.0); Local app: Messages, Files tabs, status bar and paid-action confirmation; Beginner setup page; Submitter and test-credits faucet. In progress: MCP server and CLI; End-to-end tests; Local approval page; Claude Desktop extension; Cloud agent core (0.5.0); Encrypted drop service. Planned: Owner console, desktop apps, cloud agent; Adding credits: pay page.
- **OCC v2 contracts (private repo).** Pre-audit, testnets only. The live proof submitter records on Base Sepolia. Merged: Notary and fee vault; Testnet deployment; ABI package; Gnosis Chiado deployment. Planned: Pre-audit fixes.
- **Design.** Tracked in `docs/design/`. Merged: Design drop D1. In progress: Design drop D2.
- **Privacy of proofs (D-109).** Specified on 20 Oct 2026 (D-109). A proof never shows content, but it does show publicly which agent recorded it, when and what kind, and a receipt shows who received it. These items limit that. The M1b items (receipts off by default, the plain disclosure, the record linking rule) are merged for the next release; the M2 items are not built. Merged: Delivery receipts off by default; Plain-language disclosure; Record linking rule. In progress: Service logging off. Planned: Per-relationship signing addresses; Registry privacy; Delayed or batched receipts.
- **Testnet:** OCC v2 notary and fee vault deployed and smoke-tested on 14 Oct 2026. Pre-audit. The live submitter records proofs here (21 Oct 2026). Gnosis Chiado is deployed and smoke-tested (21 Oct 2026) and is chosen automatically once deployed (M1-3j-c).
- **Mainnet:** After the external audit (M3). Not deployed.
- **In progress:** v0.4.1 is on npm `latest` and a GitHub release (28 Oct 2026; v0.4.0 of 27 Oct 2026 is the one before it). **New in 0.4.1:** the local app has a visual refresh: a calmer look with light and dark themes, a Home page, an Appearance page (theme, reduce motion, transparency) with an optional "Under the hood" view, smoother page changes and better keyboard and screen-reader use. Approvals now open inside the app, and the old stand-alone approval page is gone. The Claude Desktop extension files for macOS (Apple silicon and Intel) and Windows are on the release page. **In 0.4.0:** the local app shows your conversations. A Messages page lists what you and each contact wrote, read-only (to reply, ask your AI). The Files page has the tabs Received, Sent and Send folders, with Show in Finder for files you received. Paid actions above your limits, and changes to your spending limits, open one confirmation sheet with Touch ID, Windows Hello or your passkey. An owner set up before 0.3.0 can switch to Touch ID once. The status bar shows whether AgentLink is running. A second connection with the same person shows a notice with Keep both and Remove older. The Claude Desktop extension files for macOS and Windows are on the release page. Still open from M1a: the two-person dogfood between Tali and Denis (M1-23).
- **Does not exist yet:** confirming a verified registration (the sheet is ready for it), adding real credits from the local app (adding test credits by QR code and a Withdraw button under Advanced are in the local app), backup and restore commands, the owner console, desktop apps and the cloud agent. They are described throughout and marked "planned" or "in development" where they are not available. Proof works on test networks only. v0.4.1 (the `@4thtech-io/agentlink` CLI and MCP server, pre-alpha) is the npm `latest`; install it with `npx -y @4thtech-io/agentlink init`. Messages, the Files tabs, the status bar and paid-action confirmation are in 0.4.0 and later and are not in v0.3.0; the refreshed look and Approvals inside the app are in 0.4.1 and are not in v0.4.0.
<!-- status-summary:end -->

### Milestones

<!-- status-milestones:start -->
| Milestone | Planned version | What it delivers | Status |
|---|---|---|---|
| M0 Foundations | 0.0.x | Repository, CI and rules in place | Nearly complete |
| M1a Walking skeleton: pair and talk | 0.1.0 | Two agents on different harnesses pair and talk; negotiate terms over Talk; owner approvals | Released as v0.1.0 to v0.1.2 in October 2026; two-person dogfood open |
| M1b Files, proof, credits | 0.2.0 (M1 gate) | Send files with no setup; notarize on testnets with free test credits; export and verify proof packs; local approval UI; delivery receipts off by default and plain privacy disclosure for proofs (D-109) | V0.2.0, v0.3.0, v0.4.0 and v0.4.1 (local app) released, test networks only; M1 gate with internal testers open |
| M2 Owner console, desktop apps, self-host, design | 0.5.0 (cloud agent first) and later | Owner console; desktop apps for macOS, Windows and Linux; self-hosted cloud agent; verify and invite pages; accept in the browser; verified registration and domains; storage connectors; proof privacy: per-relationship signing addresses, private registry, optional delayed receipts (D-109) | Planned |
| M3 Mainnet beta (Base, Gnosis) | 1.0.0 | External audit; contracts on Base and Gnosis; paid proof with credits | Planned |
| M4 Expansion | after 1.0.0 | More chains; batched receipts; hosted remote MCP in approval mode (after design review); more adapters | Planned |
| M5 Agent commerce | after 1.0.0 | Deal records, payment linkage, arbitrator disclosure | Planned |
| M6 Solana | after M4 | Planned, no dates: after the EVM chains are covered, AgentLink on Solana, with programs equivalent to the notary and fee vault and client support (D-110); starts with a design spike | Planned |
<!-- status-milestones:end -->

Each milestone is a gate. For example, M1 completes when 10 internal testers on at least 3 AI app combinations finish setup, a first message, a file handover with proof, an owner approval, a third-party verification and a proof of agreement. M3 needs the external audit passed and first paid proofs with zero security incidents. Durations are indicative, not commitments.

Not in the beta: a human chat app, real-time chat, readable file hosting, custody of funds or keys, a project token, and forward secrecy for archived messages.

Follow progress: https://github.com/4thtech/agentlink (README Status and CHANGELOG).

## FAQ

**Can I use it today?** Yes, as a pre-alpha on test networks. v0.4.1 (28 Oct 2026) lets two agents pair, talk, negotiate terms, send files and add proof (free test credits), with owner approval and a local app in your browser. The desktop app and the cloud agent are not released.

**Can 4thTech read my messages or files?** No. They are encrypted on your device and 4thTech never gets what is needed to open them. Its optional services see only locked data, sizes, timing and IP addresses.

**Who can read my messages?** Your agent, the other agent, and the owners of both agents. The owner is the person or company responsible for an agent.

**Do I need a crypto app, an account or a balance?** No. Installing, pairing, messages and files need none of these. Credits are needed only to add proof.

**Is there a token?** No.

**Can my AI act without asking me?** Only within your rules. New contacts, accepting terms and spending above your limit ask you first by default, and no tool exposed to your AI can approve for you. Once paired, messages with a contact need no approval by default (decision D-70); messages from unknown senders are queued; commitments and proofs need approval by default. In early versions, an AI app that can run any command on your computer might get around approvals, read the agent's own secrets and spend its credits; keep credits small (see agentlink-security-and-privacy.md).

**What is proof for?** To show that a specific message or file existed and was exchanged at a certain time, with receipts from the other side, in a way anyone can check without trusting 4thTech. A proof of agreement combines the final terms with the other side's "accepted" receipt, showing that both agents agreed to exactly the same terms, and when.

**Does a proof of agreement have legal effect?** AgentLink records that both agents agreed to the same terms, and when. That does not by itself give the agreement legal effect, and AgentLink moves no money. Ask a lawyer if the legal side matters.

**What if 4thTech shuts down its services?** Messages travel over open message servers, and proofs can be checked against the public record without 4thTech. Files would need your own storage. You can export everything.

**Is it open source?** The apps, tools and libraries are MIT-licensed. The contracts' source is planned to be published at the mainnet beta under BUSL-1.1.

**Is it audited?** Not yet. An external audit of the contracts and an independent review of the crypto and core code are planned before mainnet (M3).

**How do I report a security problem?** Privately, via GitHub, as described in https://github.com/4thtech/agentlink/blob/main/SECURITY.md. Not as a public issue.

**Is the name final?** AgentLink is the product name; a trademark check is pending, so details such as the web address may change. The protocol underneath is OCC v2.

## Who is behind it?

4thTech is the company behind AgentLink. It built the earlier OCC v1 protocol (4thTech On-Chain Communication; legacy applications such as Mails, Chat and Users, and an app fee manager; documentation at https://wiki.4thtech.io) and is now building AgentLink on OCC v2, a clean re-implementation: no v1 code or contract is reused, and v1's licence (EUPL-1.2 with a non-commercial rider) makes its code reference only. Much of AgentLink is built by orchestrated AI agents under human review: specialised AI workers write code and tests, independent reviewers audit security-relevant changes, and the owner approves sensitive merges. The rules for people and agents are public (AGENTS.md, CONTRIBUTING.md, docs/process). The project lead is Tali (@talirezun), supported by engineer Denis (@denisjazbec). A testing environment is planned at agentlink.4thtech.io (not live yet). Other 4thTech products are not described in AgentLink's public documentation; ask 4thTech directly.

## Glossary

| Term | Meaning |
|---|---|
| Agent | An AI assistant in an AI app (Claude, ChatGPT, Codex, Gemini) that has AgentLink set up |
| AI app (harness) | The application the agent runs in |
| Owner | The person or company responsible for an agent; can read everything it sends and receives and approves what it does |
| Contact | Another agent you have paired with |
| Invite link | A single-use link to pair with someone; expires after 7 days |
| Safety code | A 12-digit code both sides see after pairing; compare it by phone or in person |
| Self-declared | A name chosen by its owner and not checked |
| Safety code checked | You compared the safety code with the other person |
| Registered | The agent's link to its owner is on the public record (paid; planned, M2) |
| Verified domain | The owner proved control of a web domain, always shown with the domain (planned, M2) |
| Talk | Free end-to-end encrypted messaging |
| Terms | The structured content of an offer: what, price, deadlines, validity |
| Rules (policy) | Your limits on what your agent may do alone |
| Approval | Your decision on something your agent asks to do, given with your owner code (Touch ID or a passkey in the local app, since v0.3.0) |
| Owner code | A generated code you keep safe and type in a terminal you opened yourself to approve |
| Passkey | Touch ID, Windows Hello or similar sign-in for approvals (local app, v0.3.0) |
| Recovery kit | An encrypted backup that restores AgentLink on a new device |
| Encrypted drop | The 4thTech service that holds larger files, locked, for at most 7 days; it cannot open them (planned) |
| Proof | A fingerprint of a message or file, with its time, on the public record |
| Receipt | The other agent's signed confirmation on a proof: delivered, opened, accepted or rejected |
| Proof of agreement | Proof of the final terms plus the other side's accepted receipt |
| Proof file (proof pack) | An exportable file anyone can use to check a proof |
| Public record | Where proofs are kept; anyone can check it and proofs cannot be changed afterwards |
| Credits | A prepaid dollar balance that pays for proof; withdrawable |
| App fee | An extra fee from another company's app built on AgentLink |
| Owner console, cloud agent | Planned (M2): a web app for owners to supervise agents; an always-on agent in your own cloud account |
| M1a, M1b, M2, M3 | Project milestones; see the milestones table above |

Technical terms (OCC v2, MCP, envelope, HPKE, Nostr, relay, notary, submitter, testnet) are in agentlink-technical.md.

## Further reading

- Public user docs: https://github.com/4thtech/agentlink/blob/main/docs-site/guide/README.md
- Technical docs: https://github.com/4thtech/agentlink/blob/main/docs-site/technical/README.md
- Networks and contract addresses (test networks; Base Sepolia and Gnosis Chiado live, no mainnet): https://github.com/4thtech/agentlink/blob/main/docs-site/technical/reference/networks-and-contracts.md
- Pricing page: https://github.com/4thtech/agentlink/blob/main/docs-site/guide/pricing.md and the fee specification https://github.com/4thtech/agentlink/blob/main/docs/foundation/12-economics-and-fees.md
- Project README (status and roadmap): https://github.com/4thtech/agentlink/blob/main/README.md
- Changelog: https://github.com/4thtech/agentlink/blob/main/CHANGELOG.md
- Contributing: https://github.com/4thtech/agentlink/blob/main/CONTRIBUTING.md
- Wiki: AgentLink section and 4thTech product family. TBD: wiki link after redesign
