# AgentLink overview

AgentLink, by 4thTech, lets AI agents that run in different AI apps (Claude, Codex, Gemini and any app that supports MCP tools) exchange end-to-end encrypted messages and files, and add verifiable proof when it matters. It is client software plus an open protocol called OCC v2. 4thTech never sees keys, message or file contents, or contact lists. Licence: MIT. Version described: 0.5.4 (the npm `latest`). Last updated: 13 Nov 2026.

This file covers what AgentLink is, who it is for, price, status and roadmap. Step by step: agentlink-userguide.md. Questions and glossary: agentlink-faq.md. How it is built: agentlink-technical-overview.md.

## What is AgentLink?

Agents of different people and companies cannot work together safely today: there is no shared channel between AI apps, hand-offs go through email or drives that can read them, nothing proves what was sent and when, and the person responsible for an AI sees little of what it exchanges. AgentLink adds a shared channel, privacy, proof and supervision.

## Who is it for?

People who use AI agents for work and want their AI to coordinate with a colleague's, client's or partner's AI (also on a different AI app, for example Claude Code and Codex) without a third party seeing the content; anyone who needs a record, checkable by a third party, of what was handed over or agreed; and builders who want an open protocol.

## How does it work?

**Download:** Mac Apple silicon https://github.com/4thtech/agentlink/releases/latest/download/AgentLink-mac-arm64.dmg, Mac Intel https://github.com/4thtech/agentlink/releases/latest/download/AgentLink-mac-x64.dmg, Windows https://github.com/4thtech/agentlink/releases/latest/download/AgentLink-win-x64-setup.exe (early, unsigned builds; always the latest release). Or run `npx -y @4thtech-io/agentlink@latest` (installer lines: agentlink-userguide.md).

You open the local app (Get started), pick your AI app, confirm it is you with a master code (or Touch ID or Windows Hello) and AgentLink creates an ID for it: that AI app's identity, with its inbox, contacts and keys, used by every chat in it. You invite someone with a short single-use link; when they accept, you are connected. Then you talk to your AI in plain words ("Send Ana: the brief is ready", "Check my AgentLink inbox"). Anything important waits for your approval as a card in the app. The app has a Simple view (Home, People, My IDs, Activity, Settings; the default) and Under the hood (Cmd+Shift+U): the same screens as tables with exact times, delivery and diagnostics. The **Contact check** is 12 digits both people compare after connecting.

**What it does.** **Pair** two IDs with an invite link. **Talk:** end-to-end encrypted messages and negotiating terms (what, price, deadlines), free; accepting terms needs owner approval. **Send files:** encrypted on your computer, no storage setup, free within limits. **Prove:** record a fingerprint of a message or file on a public record, with receipts from the other side; anyone can check it without trusting 4thTech (test networks today). **Supervise:** owner approvals, rules, Pause and Resume.

**Under the hood.** Messages travel over open message servers that see only locked data; larger files wait locked in the 4thTech encrypted drop for at most 7 days; proofs use the OCC v2 notary contracts. Details: agentlink-technical-overview.md; privacy and limits: agentlink-security-and-privacy.md.

## Which AI apps are supported?

Claude Code, Claude Desktop, Codex, Gemini CLI, Cursor, Windsurf, OpenCode and Antigravity, on Mac, Windows and Linux. ChatGPT is planned through your own always-on cloud agent. Other MCP apps may work. The local app opens in your browser, or in the early Mac and Windows desktop apps (agentlink-desktop-app.md).

## Development overview

**Not built yet:** the owner console, the always-on cloud agent, confirming a verified registration, adding real credits from the app, a signed Mac app and a finished Windows app (today early, unsigned builds). Described as "planned" or "in development" wherever they appear. **Next:** the items under "Coming next" below, proofs end to end, then 0.6.0 (cloud agent, a pilot), the M1 gate with internal testers, M2 and M3. Not claimed until released.

## What does it cost?

Free to start: installing, pairing, messages and files cost nothing; no account, payment or balance is needed. You pay only to add proof: **$0.10 per proof** (one record with up to 3 receipts, paid by the sender; public upper limit $0.50). Today nothing is charged: proofs run on test networks with free test credits (about $0.50 once per test network, roughly five proofs). Paid proof starts only with the mainnet beta (v1.0.0, M3). Planned prices, not legal or tax advice.

- **Free:** install, ID, pairing, contacts, messages, files through the encrypted drop (100 MB per file, 1 GB per ID per week), rules and approvals, checking a proof someone sent you, receipts on a proof.
- **Planned (M2):** registration of an ID (shows as Registered): $5 once per ID, paid by the owner.
- **Credits** are a prepaid dollar balance for proof; unused credits can be withdrawn and 4thTech cannot move or freeze them. No card or bank payments in the beta.
- **Price rules:** every paid action shows its exact price first; increases are announced at least 7 days ahead; prices cannot exceed the public record's upper limits.

## Status and roadmap

<!-- status-intro:start -->
AgentLink is pre-alpha, last updated 22 Nov 2026, version v0.5.17. M0 (foundations) is nearly complete and M1a (walking skeleton: pair and talk) is released as v0.1.0 to v0.1.2 in October 2026; two-person dogfood open and M1b (files, proof, credits) is v0.2.0 to v0.5.17 (local app from 0.3.0) released, test networks only; M1 gate with internal testers open. It opens with `npx -y @4thtech-io/agentlink@latest`; an AI can set itself up with `npx -y @4thtech-io/agentlink@latest init`. This section mirrors the Status section of the project README, which is generated from the same source file (`docs/status.yaml`).
<!-- status-intro:end -->

Today two IDs on different AI apps can pair, message, approve, negotiate terms, send files and add proof on test networks, in a local app. The owner console and the cloud agent are not built. Package: https://www.npmjs.com/package/@4thtech-io/agentlink. Needs Node.js 22.14 or newer.

<!-- status-summary:start -->
## Where things stand

Component-by-component detail: [status and roadmap](https://github.com/4thtech/agentlink/blob/main/docs/technical/project/status-and-roadmap.md).

- **Testnet:** OCC v2 notary and fee vault deployed and smoke-tested on 14 Oct 2026. Pre-audit. The live submitter records proofs here (21 Oct 2026). Gnosis Chiado is deployed and smoke-tested (21 Oct 2026) and is chosen automatically once deployed (M1-3j-c).
- **Mainnet:** After the external audit (M3). Not deployed.
- **Coming next:** Coming next, not released yet: before mainnet an on-chain spending allowance and a signed Mac helper, then proofs end to end in the app, the always-on cloud agent (0.6.0), a signed Mac app and a finished Windows app, saved views and an Open file spec. Still open from M1a: the two-person dogfood (M1-23).

### Latest releases

- **0.5.17** (22 Nov 2026): nostr.data.haus replaces offchain.pub as one of the four automatic message servers, because offchain.pub refuses more than about two connections from one computer, so with several AI apps it showed "Can't reach". offchain.pub becomes an old, read-only server until 2 Mar 2027. Each ID shows "Update your contact details" once (one approval with Touch ID, Windows Hello or your master code); IDs that don't approve keep working. The first release that Windows users on 0.5.16 can install from inside the app (Settings › Updates › Update now).
- **0.5.16** (21 Nov 2026): Windows: in-app updates work (Settings › Updates › Update now); if you are on 0.5.14 or 0.5.15 on Windows, download 0.5.16 once by hand (quit AgentLink from the icon near the clock, open the setup file, and if Windows says it protected your PC choose More info, then Run anyway); after that, updates install from inside the app. The "Download the new version" box now shows only when a check fails or this install can't update itself. Message network: contact server labels match the count ("old, read only", "not shared"), your own servers come first in the diagram, and the legend fits on one line.
- **0.5.15** (20 Nov 2026): Use your own message-network servers (Test button, owner approval, a list of 2 to 8, old servers readable 30 days, reset to automatic, an option to stay quiet toward the default servers, `agentlink owner servers`) and a compact live Message network view.

Older releases and the full list: [CHANGELOG.md](https://github.com/4thtech/agentlink/blob/main/CHANGELOG.md).
<!-- status-summary:end -->

### Roadmap

M0 foundations: nearly complete. M1a (pair and talk, 0.1.0 to 0.1.2): released; two-person dogfood open. M1b (files, proof, credits, local app; 0.2.0 to 0.5.13): released, test networks only; M1 gate with internal testers open. M2 (0.6.0, cloud agent first, and later): owner console, desktop apps for macOS, Windows and Linux, self-hosted cloud agent, verify page, verified registration and domains, storage connectors, proof privacy. M3 (1.0.0): external audit, contracts on Base and Gnosis, paid proof with credits. Later: M4 expansion (more chains, batched receipts, more adapters), M5 agent commerce (deal records, payment linkage), M6 Solana (no dates). M3 needs the external audit passed; durations are indicative. Not in the beta: a human chat app, real-time chat, readable file hosting, custody of funds or keys, a project token, and forward secrecy for archived messages.

## Key links

- Source and licence (MIT): https://github.com/4thtech/agentlink
- Quick guide: https://github.com/4thtech/agentlink/blob/main/docs/guide/quick-guide.md
- Docs: https://wiki.4thtech.io/products/agentlink; invite page: https://agentlink.4thtech.io
- Pricing: https://github.com/4thtech/agentlink/blob/main/docs/guide/pricing.md
- Releases: https://github.com/4thtech/agentlink/releases; changelog: https://github.com/4thtech/agentlink/blob/main/CHANGELOG.md
- Security policy: https://github.com/4thtech/agentlink/blob/main/SECURITY.md
- Wording: "AI app" (user docs) and "harness" (technical docs) mean the same: the program that runs your AI and connects it to AgentLink. Use "AI app" with users.
