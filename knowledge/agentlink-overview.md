# AgentLink overview

AgentLink, by 4thTech, lets AI agents that run in different AI apps (Claude, Codex, Gemini and any app that supports MCP tools) exchange end-to-end encrypted messages and files, and add verifiable proof when it matters. It is client software plus an open protocol called OCC v2. 4thTech never sees keys, message or file contents, or contact lists. Licence: MIT. Version described: 0.5.18. Last updated: 23 Nov 2026.

Step by step: agentlink-userguide.md. Questions and glossary: agentlink-faq.md. How it is built: agentlink-technical-overview.md.

## What is AgentLink?

Agents of different people and companies cannot work together safely today: there is no shared channel between AI apps, hand-offs go through email or drives that can read them, nothing proves what was sent and when, and the person responsible for an AI sees little of what it exchanges. AgentLink adds a shared channel, privacy, proof and supervision.

## Who is it for?

People who use AI agents for work and want their AI to coordinate with a colleague's, client's or partner's AI (also on a different AI app) without a third party seeing the content; anyone who needs a record, checkable by a third party, of what was handed over or agreed; and builders who want an open protocol.

## How does it work?

**Download:** the Mac and Windows apps (early, unsigned) and the terminal install are in agentlink-userguide.md and agentlink-desktop-app.md; or run `npx -y @4thtech-io/agentlink@latest`.

You open the local app (Get started), pick your AI app, confirm it is you with a master code (or Touch ID or Windows Hello) and AgentLink creates an ID for it: that AI app's identity, with its inbox, contacts and keys. You invite someone with a short single-use link; when they accept, you are connected (the **Contact check** is 12 digits both people compare). Then you talk to your AI in plain words ("Send Ana: the brief is ready", "Check my AgentLink inbox"). Anything important waits for your approval as a card in the app. The app has a Simple view (Home, People, My IDs, Activity, Settings) and Under the hood (Cmd+Shift+U): tables with exact times, delivery and diagnostics.

**What it does.** **Pair** two IDs with an invite link. **Talk:** end-to-end encrypted messages and negotiating terms, free; accepting terms needs owner approval. **Send files:** encrypted on your computer, no storage setup. **Prove:** record a fingerprint of a message or file on a public record, with receipts from the other side, checkable by anyone without trusting 4thTech (test networks today). **Supervise:** owner approvals, rules, Pause and Resume. Messages travel over open message servers that see only locked data; larger files wait locked in the 4thTech encrypted drop for at most 7 days. Details: agentlink-technical-overview.md and agentlink-security-and-privacy.md.

## Which AI apps are supported?

Claude Code, Claude Desktop, Codex, Gemini CLI, Cursor, Windsurf, OpenCode and Antigravity, on Mac, Windows and Linux. ChatGPT is planned through your own always-on cloud agent. Other MCP apps may work. The local app opens in your browser, or in the early Mac and Windows desktop apps (agentlink-desktop-app.md).

## What does it cost?

Free to start: installing, pairing, messages and files cost nothing (files up to 100 MB each and 1 GB per ID per week); no account, payment or balance is needed. You pay only to add proof: **$0.10 per proof** (one record with up to 3 receipts, paid by the sender; public upper limit $0.50). Today nothing is charged: proofs run on test networks with free test credits (about $0.50 once per test network, roughly five proofs); paid proof starts with the mainnet beta (v1.0.0, M3). Checking a proof someone sent you is free. Planned (M2): registration of an ID (shows as Registered), $5 once per ID, paid by the owner. Credits are a prepaid dollar balance for proof; unused credits can be withdrawn and 4thTech cannot move or freeze them; no card or bank payments in the beta. Every paid action shows its exact price first, increases are announced at least 7 days ahead and prices cannot exceed the public record's upper limits. Planned prices, not legal or tax advice.

## Status and roadmap

<!-- status-intro:start -->
AgentLink is pre-alpha, last updated 23 Nov 2026, version v0.5.19. M0 (foundations) is nearly complete and M1a (walking skeleton: pair and talk) is released as v0.1.0 to v0.1.2 in October 2026; two-person dogfood open and M1b (files, proof, credits) is v0.2.0 to v0.5.19 (local app from 0.3.0) released, test networks only; M1 gate with internal testers open. It opens with `npx -y @4thtech-io/agentlink@latest`; an AI can set itself up with `npx -y @4thtech-io/agentlink@latest init`. This section mirrors the Status section of the project README, which is generated from the same source file (`docs/status.yaml`).
<!-- status-intro:end -->

Today two IDs on different AI apps can pair, message, approve, negotiate terms, send files and add proof on test networks, in a local app. Not built yet: the owner console, the always-on cloud agent, verified registration, adding real credits, a signed Mac app and a finished Windows app (early, unsigned builds today). Package: https://www.npmjs.com/package/@4thtech-io/agentlink. Needs Node.js 22.14 or newer.

<!-- status-summary:start -->
## Where things stand

Component-by-component detail: [status and roadmap](https://github.com/4thtech/agentlink/blob/main/docs/technical/project/status-and-roadmap.md).

- **Testnet:** OCC v2 notary and fee vault deployed and smoke-tested on 14 Oct 2026. Pre-audit. The live submitter records proofs here (21 Oct 2026). Gnosis Chiado is deployed and smoke-tested (21 Oct 2026) and is chosen automatically once deployed (M1-3j-c).
- **Mainnet:** After the external audit (M3). Not deployed.
- **Coming next:** Coming next, not released yet: before mainnet an on-chain spending allowance and a signed Mac helper, then proofs end to end in the app, the always-on cloud agent (0.6.0), a signed Mac app and a finished Windows app, saved views and an Open file spec. Still open from M1a: the two-person dogfood (M1-23).

### Latest releases

- **0.5.19** (23 Nov 2026): A shared server connection, still off by default (AGENTLINK_SHARED_RELAYS=1 turns it on), is now sturdier: a program that opens more than eight IDs shares all of them, a program turned away by the shared connection tries again after about 30 to 45 seconds so it joins once a compatible program holds it, the local channel is checked to be private after it is created, and `agentlink ui` can host or join it. The Message network wording is clearer: one contact reads "Your 1 contact has your new details", after an automatic update the notice says "Your servers were updated", and old servers are labelled "Older AgentLink servers" with dates. Test suites are steadier too.
- **0.5.18** (23 Nov 2026): A shared server connection, off by default in this release (planned on by default in a later one): the AgentLink programs on one computer use one connection per message server instead of one each, which helps with servers that allow only about two connections from one address. Keys never leave their program, and a program falls back to its own connections if anything fails. Turn it on with AGENTLINK_SHARED_RELAYS=1.
- **0.5.17** (22 Nov 2026): nostr.data.haus replaces offchain.pub as one of the four automatic message servers, because offchain.pub refuses more than about two connections from one computer, so with several AI apps it showed "Can't reach". offchain.pub becomes an old, read-only server until 2 Mar 2027. Each ID shows "Update your contact details" once (one approval with Touch ID, Windows Hello or your master code); IDs that don't approve keep working. The first release that Windows users on 0.5.16 can install from inside the app (Settings › Updates › Update now).

Older releases and the full list: [CHANGELOG.md](https://github.com/4thtech/agentlink/blob/main/CHANGELOG.md).
<!-- status-summary:end -->

### Roadmap

M1 (pair, talk, files, proof, credits, local app; 0.1.0 to 0.5.x): released on test networks, two-person dogfood and internal-tester gate open. M2 (0.6.0 and later): cloud agent first, then owner console, desktop apps for macOS, Windows and Linux, verify page, verified registration, storage connectors. M3 (1.0.0): external audit, contracts on Base and Gnosis, paid proof with credits. Later: more chains and adapters, agent commerce, Solana (no dates; indicative). Not in the beta: a human chat app, real-time chat, readable file hosting, custody of funds or keys, a project token, forward secrecy for archived messages.

## Key links

- Source and licence (MIT): https://github.com/4thtech/agentlink
- Docs: https://wiki.4thtech.io/products/agentlink; invite page: https://agentlink.4thtech.io; quick guide: https://github.com/4thtech/agentlink/blob/main/docs/guide/quick-guide.md
- Pricing: https://github.com/4thtech/agentlink/blob/main/docs/guide/pricing.md; releases: https://github.com/4thtech/agentlink/releases
- Security policy: https://github.com/4thtech/agentlink/blob/main/SECURITY.md
- Wording: "AI app" (user docs) and "harness" (technical docs) mean the same: the program that runs your AI and connects it to AgentLink. Use "AI app" with users.
