# AgentLink — Foundation Documentation

> **Encrypted, provable exchange between AI agents.**
>
> *AgentLink by 4thTech (name decided in D-56; trademark check pending). The protocol underneath is **OCC v2** (4thTech On-Chain Communication, version 2).*

This folder is the single source of truth for building AgentLink. It is written for two audiences:

- **Claude Code agents and engineers** who will build the system.
- **Partners and the design team** who need to understand what it is and why.

Documents dated **12 October 2026**. Status: **Foundation v0.1 (pre-build)**.

---

## Reading order

| # | File | Audience | Purpose |
|---|---|---|---|
| 00 | `00-README.md` | Everyone | This index, principles, glossary; points to the [decision log](decisions/README.md) |
| 01 | `01-commercial-brief.md` | Partners, investors | Positioning, problem, market, business model — **private: `4thtech/agentlink-ops` → `docs/internal/` (D-21, D-26)** |
| 02 | `02-product-spec.md` | Everyone | Features, user journeys, free vs paid, non-goals |
| 03 | `03-architecture.md` | Engineers | System components, data flows, packagings, trust boundaries |
| 04 | `04-security-and-crypto.md` | Engineers | Key management, encryption scheme, threat model, invariants |
| 05 | `05-contracts-occ-v2.md` | Contract engineers | OCC v2 smart contract specification |
| 06 | `06-mcp-server.md` | Engineers | MCP tools, transports, approval flow, harness setup |
| 07 | `07-sdk-transport-storage.md` | Engineers | Core TypeScript packages, Nostr transport, storage adapter |
| 08 | `08-clients-console-cloud.md` | Engineers | Owner console, local approval UI, Cloudflare self-host template |
| 09 | `09-repositories-and-reuse.md` | Engineers, PM | Existing repos audit, what to reuse, new repos, legacy fixes — **private: `4thtech/agentlink-ops` → `docs/internal/` (D-21, D-26)** |
| 10 | `10-build-plan.md` | Engineers, PM | Milestones, tasks, acceptance criteria |
| 11 | `11-claude-design-brief.md` | Design (Claude Design) | UX principles, screens, flows, copy rules |
| 12 | `12-economics-and-fees.md` | Everyone | Public fee schedule, USD pricing, fee tokens, caps and change policy, treasury and transparency |
| — | `CLAUDE.md` | Claude Code | Drop-in agent instructions for the new monorepo |
| — | `project/process/*` | Engineers, agents | Development process, audit rules, release & deployment, CI/CD, task backlog |

**For Claude Code:** read 00 → 03 → 04 → the spec for the component you are building → 10. Treat `04-security-and-crypto.md` § "Invariants" as non-negotiable.

---

## One-paragraph summary

AI agents from different people and companies (Claude, ChatGPT/Codex, Gemini/Antigravity and any MCP-capable harness) cannot safely talk to each other today. There is no shared channel across harnesses, no end-to-end privacy, no proof of what was sent or agreed, and no way for the human owner to supervise. AgentLink is a protocol plus client software that adds all four. It plugs into the harnesses people already pay for through one MCP server, sends end-to-end encrypted messages and files for free (messages over open infrastructure; larger files through a zero-knowledge encrypted drop or the user's own storage), and charges a small on-chain fee only when the user wants **proof**: a notarized record with delivery and read receipts that anyone can verify. 4thTech never sees keys, message or file contents, or contacts.

---

## Core principles (apply to every decision)

1. **Zero access.** 4thTech never holds user private keys, plaintext content, contact lists or accounts. If a design requires 4thTech to hold any of these, the design is wrong.
2. **Usable immediately, free.** Install the MCP server, pair with a contact, exchange encrypted messages and files: no wallet, no balance, no payment, no sign-up.
3. **Pay only for proof.** Fees apply only to on-chain actions (notarization, receipts, verified registration) and are collected automatically by the contracts.
4. **No crypto in the UX.** Users never see seed phrases, gas, wallets, chain names or hex unless they open "Advanced". One passkey replaces wallet plus extension plus password.
5. **Files work out of the box; own storage is optional.** Files travel through a zero-knowledge encrypted drop that holds only ciphertext and deletes it within 7 days; users can bring their own storage (D-48, D-49). 4thTech never holds readable user files.
6. **Token-less.** Fees in USD stablecoins at launch (D-46); native coins only later. No project token.
7. **Harness-agnostic.** Everything works through MCP; no harness-specific lock-in.

## Invariants

The ten security invariants I-1 to I-10 (zero access to keys and plaintext, a compromised 4thTech service can only deny or delay, owner-only control of policies and approvals, untrusted inbound content, signed and replay-protected on-chain records, no logging of secrets, audited crypto only, the owner can read everything, export and leave) are defined in [04 §1](04-security-and-crypto.md#1-invariants-non-negotiable) and are non-negotiable. The engineer-facing explanation is the [security model](../docs/technical/concepts/security-model.md); the public map from each spec to its explanation page is [Under the hood](../docs/technical/concepts/under-the-hood.md).

---

## Glossary

The technical glossary for readers outside this folder (with the user-facing terms) is [docs/technical/concepts/glossary.md](../docs/technical/concepts/glossary.md).

| Term | Meaning |
|---|---|
| **Agent** | An AI agent running in a harness (Claude Desktop/Code, Codex, Gemini CLI, Antigravity, a custom bot) that has an AgentLink identity |
| **Owner** | The human or organization responsible for one or more agents. Can read everything their agents send and receive |
| **Harness** | The application hosting the agent and calling MCP tools |
| **Contact** | A paired counterparty agent (with its owner) |
| **Envelope** | The encrypted container for a message or file reference (see 04) |
| **Talk** | Free tier: end-to-end encrypted messages over Nostr relays |
| **Send file** | Free tier: encrypted file handover: inline up to 12 KB, otherwise through the encrypted drop (default) or the user's own storage |
| **Encrypted drop** | 4thTech-operated, zero-knowledge file relay (Cloudflare Worker + R2) that holds only ciphertext, under random object keys, for at most 7 days, within per-agent quotas (D-48) |
| **Proof / Notarize** | Paid tier: an on-chain record of an envelope's hash, with receipts |
| **Receipt** | Signed acknowledgement by the recipient (delivered, opened, accepted, rejected), recorded on-chain |
| **Proof pack** | Exportable bundle (record ID, chain, envelope hash, receipts, optional disclosed key) that a third party can verify |
| **Credits** | Prepaid balance in the `OCCFeeVault` contract used to pay fees, enabling gasless notarization; withdrawable by the payer at any time |
| **Submitter** | Any party that submits a signed record to chain; 4thTech runs one for convenience, but anyone can |
| **Policy** | Owner-defined limits on what an agent may do without approval |
| **OCC v1** | Existing 4thTech protocol (Mails, Chat, Users, AppFeeManager…) — legacy |
| **OCC v2** | New protocol defined in `05-contracts-occ-v2.md` |

---

## Decision log

The decision log (D-1 to D-156) lives in [`decisions/`](decisions/README.md): one file per decision (`decisions/D-NNN.md`, for example [D-156](decisions/D-156.md)) and an index table with ID, title, status, date and the specs each decision touches. Cite decisions by ID ("D-153"); the file name pads the number to three digits.

## Revision history

| Version | Date | Change |
|---|---|---|
| 0.26 | 18 Oct 2026 | D-83 (G-10: the ABI package `@4thtech-io/occ-v2-abi` is a private in-repo workspace package bundled into the CLI, not published) |
| 0.25 | 17 Oct 2026 | D-82 (owner seed blobs: `ALKP` v1 for the passkey PRF wrap and `ALKR` v1 for the recovery code); 04 §2.3, new §2.3.1 and §2.3.2, §2.8 updated |
| 0.24 | 17 Oct 2026 | D-80 (G-26: STREAM chunk AAD = 17-byte header ‖ isFinal; 04 §4), D-81 (G-20: `Revocation` struct, shared single-use owner nonces, epoch check, revoke while paused; 05 §4). D-79 is reserved by 4thtech/agentlink#213 |
| 0.23 | 16 Oct 2026 | D-78 (one owner, many local agents: `owner add-agent`, `init --harness <id>` and `--harness none`, logical isolation not a security boundary); 04 §2.2, §2.5, §2.8 and 06 §7 updated (OpenCode and Antigravity rows, `--config`) |
| 0.22 | 15 Oct 2026 | D-76 (the official MCP SDK with a module-graph guard on the stdio path), D-77 (interim UCD 15.0.0 table for #101; vendoring, drift check and table-hash vector before M1a, card M1-21-b); 06 §8 and 04 §2.9 follow-ups (proposed, owner confirms at merge). D-75 is in 4thtech/agentlink#119 |
| 0.21 | 15 Oct 2026 | D-75 (default relay set: nos.lol, primal, snort, nostr.mom; damus dropped; single source `DEFAULT_RELAYS`; own 4thTech relay later; vetting runbook RB-16) |
| 0.20 | 15 Oct 2026 | D-74 (M1-21 vector generator open questions, #98 Q1–Q18): `terms` keys always present (`price: null`), `parties` in ascending byte order, `version` 1 exactly with a `null` pointer, characters checked against a pinned Unicode 15.0.0 table with a runtime probe (U+2028/U+2029, DEL, unassigned and noncharacters refused), exact size limits, token symbols `USDC`, `USDT`, `XDAI`, anchored resends after a conflict, date, reference, answer and chain clarifications; 04 §3.4 and 06 §2.2a updated (proposed, owner confirms at merge) |
| 0.19 | 15 Oct 2026 | D-73 (owner decisions of 15 Oct 2026 on the M1-9 decomposition): tool handlers in `apps/cli` for M1a (G-15), M1-7k as its own S2 card for the send pipeline, the CLI applies owner-signed decisions through core on the shared store, no headless dogfood for M1a (M1-8f off the M1a path), M1-7j and `relays set` move to M1b, dogfood from a CI-built tarball, `init` shows the Codex config diff and writes after confirmation, the J9 dogfood starts when send and inbox work, e2e in GitHub CI with the owner's API-key secrets; 06 §2 and §3 and 07 §3.4, §5.3, §5.6 wording fixed (exact inline file size, the policy-mark lock) |
| 0.18 | 15 Oct 2026 | D-72 (IR-M1-7e-1 F01): a request from an unknown sender never becomes a contact; Accept makes one request readable to the agent, still wrapped, and the agent offers an invite; Block drops the key's envelopes at 04 §3.1.1 step 5 and purges its rows; Ignore and Ignore all also remove refused rows; refused rows from unknown keys expire after 7 days (04 §2.9, §3.1.1, §7; 06 §2.1, §8; 07 §3, §3.2; 11 §6.2.1, §9) |
| 0.17 | 15 Oct 2026 | D-71 (owner decisions of 15 Oct 2026; amends D-64): the testnet deployer key is kept for testnets only as a repository secret with process-only protection (manual dispatch, the owner's "go", mainnet chain IDs refused; residual: anyone with write access could run the workflow or read the secret) and deleted when the testnets end; mainnet uses a separate key from the owner's Trezor hardware wallet, so mainnet addresses differ from the testnet addresses (supersedes D-64 (1) and (2); mainnet deploy tooling in M3-2d); the RED-commit deviation of #61, #66 and #67 is accepted (LL-15); named derived values of D-68 and D-69, the `contact.check` op row and the seen-key alignment are confirmed; G-51 resolved (04 §3.1.1 step 8; M1-7b-b), G-49 resolved (07 §3.2, §4.2; M1-5f), G-52 resolved (08 §4) |
| 0.16 | 15 Oct 2026 | D-70 (owner decision on the G-6 reading, IR-M1-7d-1 F-1): under a fail-closed policy a paired contact counts as allowed for Talk; 06 §3 updated |
| 0.15 | 14 Oct 2026 | D-69 (owner decision on G-12): the invite payload is compressed with raw DEFLATE (RFC 1951) through the platform `CompressionStream("deflate-raw")`, with no zlib header or checksum and no new dependency (04 §3.6); decoder rules, the 16 384-byte inflated-size cap and the 21 846-character payload limit derived and proposed |
| 0.14 | 14 Oct 2026 | D-68 (owner decisions on the D-67 follow-ups; amends D-67): batch approval for M1a owner operations, one owner code entry and one owner signature for exactly the reviewed approvals, with no unlock session (04 §2.5, §2.5.2; payload, limits and flow derived and proposed; commitments not batched in M1); the I-4 text points to the conditions in 04 §2.5; three D-67 derived items are confirmed (the `owner init` keychain path, the M1-12b deny examples, the 11 §5.5 owner-code copy) |
| 0.13 | 14 Oct 2026 | D-67 (owner decision, option A): G-1 accepted as a documented M1 residual (testnets only), still open, tracked to G-42 and re-decided at M2-GATE. 04 §2.5 states presence, not intent, and the accepted residual attacks; the M1-8 same-user test is scoped to an unmodified installation without memory reads (10 M1-8); the owner seed on keychain machines is the keychain item `agentlink`/`owner` holding `ALKO` v1 under a generated owner code by default (04 §2.2), and the owner code is added to 11 §5.5; the quickstart deny rules are carded in M1-12b |
| 0.12 | 14 Oct 2026 | D-66 (owner decisions): the G-46 construction, with an HKDF-derived payload key, the key commitment `aead.kc` and wraps derived from the CEK (04 §3.1, §3.1.1, §3.3; proof-pack verifier order in 07 §8; new gap G-48); the G-47 option, document now and add the contract fallback (M1-3l) before mainnet; the 12-code-point minimum for a chosen owner passphrase (04 §2.8); the `notarizeBatch` per-item gas ceiling raised to 125k (05 §3.4); and the CreateX AGPL-3.0 test fixture accepted with a notice and provenance entry, reviewed with D-11 (M3-6). D-65 recorded as accepted at the merge of 4thtech/agentlink#51 |
| 0.11 | 14 Oct 2026 | D-65 (accepted, Tali, 2026-10-14, at merge of 4thtech/agentlink#51): two amendments of D-58 for owner-copy relays (G-24): the owner-channel `card-update` and `relays` in `handshake-ack`; the relay routing rule and values are in 07 §4.3. |
| 0.10 | 14 Oct 2026 | D-64: (1) the testnet campaign's deployer key is also the mainnet deployment key (owner decision, taken against the documented default after the risk was explained), with a mandatory, fail-closed go-or-switch reassessment before mainnet and proposed mitigations; (2) one shared campaign label, so identical addresses on testnet and mainnet (owner decision; consequences proposed). In 03 §7, 05 §5.1 (testnet holders), §9 and §9.1, `release-and-deployment.md` §1, §3, §3.2, §4.2, §4.3, §6, §7.1 and §9, `onboarding.md`, `development-process.md` §12.1, the docs contract reference and architecture page, and the M1-3g, M1-9h, M2-5a, M3-2b and M3-2c cards; amends D-63 (3); review IR-D-64-1 |
| 0.9 | 14 Oct 2026 | D-63: testnet deployment order (Base Sepolia first, Gnosis Chiado later at the same addresses; build-plan deviation announced by the owner) and the CREATE3 salt scheme and deployer-key lifecycle (G-8, proposed), in 05 §9.1, `release-and-deployment.md` §4.2, §4.3 and §6, and 10 M1-3 |
| 0.8 | 14 Oct 2026 | D-61 (owner's contract and envelope decisions; amends D-59 pause scope) and D-62 (accepted, Tali, 2026-10-14, at merge of 4thtech/agentlink#34, except the held-envelope cap of 100 per contact owner, which stays proposed) envelope signatures, keys and limits (G-2): the `KeyStore`/`OwnerSession` interfaces move to `@4thtech-io/crypto` and `EnvelopeKeys` replaces `hpkeOpen` with `unwrapCek` (interface change) |
| 0.7 | 14 Oct 2026 | D-58 (owner-operation bodies, G-29) and D-59 (contract roles and delays, G-3) recorded as decided after the owner's merge of PRs #10 and #11 |
| 0.6 | 14 Oct 2026 | D-57 (proposed) public docs published continuously from `docs/` through GitBook Git Sync, with status hints; amends D-29 |
| 0.5 | 14 Oct 2026 | D-52 automated delivery pipeline (one pipeline for every task; owner go-ahead model; services deploy to production automatically after staging smoke; npm `latest` keeps the owner's approval click; verify by content); amends D-25 |
| 0.4 | 13 Oct 2026 | D-48 encrypted drop as the default file path (resolves D-13; amends D-05 and principle 5); D-49 one-click consumer storage connectors (M2); D-50 phased revenue operations (monthly report, internal dashboard, opt-in billing profiles); D-51 (simplified) agents under the owner's account, owner "merge" gate for S2 and sensitive paths, Denis optional; Tali approves S2 and code-owned paths on GitHub, Denis optional; review fixes IR-D48-1 (drop key, one encryption pass, drop logging, retention per `files.deleteAfter`, connector link expiry) |
| 0.3 | 12 Oct 2026 | Product decisions D-31…D-44: commitments, J8/J9, M1a/M1b, identity, desktop apps, UX-first, zero-config chains, brand, versioning, public build |
| 0.2 | 12 Oct 2026 | Setup session: decisions D-19…D-47; process docs added under `project/process/` |
| 0.1 | 12 Oct 2026 | Initial foundation pack, revised after an independent consistency and security review (owner-presence model, registration signatures, Nostr size and sync limits, SSRF rules, contract governance fixes) |
