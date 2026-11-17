# Decision log

Every product, protocol, security and process decision for AgentLink, one file per decision. This index replaces the table that used to sit in [`00-README.md`](../00-README.md). The specs (02 to 12) are normative; a decision records why they say what they say, and a spec change that needs a decision adds one here.

**Adding a decision:** create `D-NNN.md` (three digits, the next free number) with the same outline as the others (heading `# D-N: title`, then Status, Date, Specs and the Decision text) and add its row to the table below. [`tools/check-security-docs.mjs`](../../../tools/check-security-docs.mjs) checks that every file has a row here and that every decided entry citing 04 is explained on a security page or allowlisted.

Status: **Decided** (an owner decision; details may still say "owner confirms at merge"), **Decided in part** (some points decided, others proposed), **Proposed** or **Open**. Each file holds the full status text, including amendments and supersessions.

| ID | Title | Status | Date | Specs |
|---|---|---|---|---|
| [D-01](D-001.md) | Product built under the 4thTech brand | Decided | 2026-10-12 | — |
| [D-02](D-002.md) | One-liner: "Encrypted, provable exchange between AI agents" | Decided | 2026-10-12 | — |
| [D-03](D-003.md) | Free: Talk, pairing, Send file (BYO storage), local verify, console | Decided | 2026-10-12 | — |
| [D-04](D-004.md) | Fees payable in native coin, USDC, USDT (per-chain allowlist) | Decided | 2026-10-12 | — |
| [D-05](D-005.md) | Storage: bring your own (S3-compatible first) | Decided | 2026-10-12 | — |
| [D-06](D-006.md) | PollinationX not on the stage-1 critical path | Decided | 2026-10-12 | — |
| [D-07](D-007.md) | Transport: Nostr (NIP-17 / NIP-59 gift wraps) via a transport interface | Decided | 2026-10-12 | — |
| [D-08](D-008.md) | One MCP server, two transports (stdio + streamable HTTP) | Decided | 2026-10-12 | — |
| [D-09](D-009.md) | Hosting: Cloudflare (Workers, Durable Objects, R2, static assets) | Decided | 2026-10-12 | — |
| [D-10](D-010.md) | Chains: beta on Base + Gnosis | Decided | 2026-10-12 | — |
| [D-11](D-011.md) | OCC v2 contracts: private repo in beta | Proposed | 2026-10-12 | — |
| [D-12](D-012.md) | Client software (SDK, MCP, console, cloud-agent template, docs): public, **MIT** licence | Decided | 2026-10-12 | — |
| [D-13](D-013.md) | Optional 4thTech "temporary encrypted drop" for users without storage | Decided | 2026-10-12 | — |
| [D-14](D-014.md) | Working product name "AgentLink" | Decided | 2026-10-12 | — |
| [D-15](D-015.md) | Legal entity / jurisdiction (not Slovenia) | Open | 2026-10-12 | — |
| [D-16](D-016.md) | Owner operations require owner presence (passkey/passphrase) and owner signatures | Decided | 2026-10-12 | — |
| [D-17](D-017.md) | Contact invites require owner approval by default | Decided | 2026-10-12 | — |
| [D-18](D-018.md) | File links expire after max 7 days | Decided | 2026-10-12 | — |
| [D-19](D-019.md) | OCC v2 contracts live in a separate private repo `4thtech/occ-v2-contracts` | Decided | 2026-10-12 | — |
| [D-20](D-020.md) | OCC v2 is a clean re-implementation from 05 | Decided | 2026-10-12 | — |
| [D-21](D-021.md) | `01-commercial-brief.md` and `09-repositories-and-reuse.md` are kept out of the public repo | Decided | 2026-10-12 | — |
| [D-22](D-022.md) | Development runs in orchestration mode: an Opus orchestrator delegates to Haiku / Sonnet / Opus workers by complexity | Decided | 2026-10-12 | — |
| [D-23](D-023.md) | Human reviewers are the owner plus 4thTech engineers | Decided | 2026-10-12 | — |
| [D-24](D-024.md) | The owner (@talirezun) leads development | Decided | 2026-10-12 | — |
| [D-25](D-025.md) | Continuous delivery: merging to `main` deploys automatically to staging/testnet with smoke tests | Decided | 2026-10-12 | — |
| [D-26](D-026.md) | Private internal docs (01, 09) and infrastructure-as-code live in the private repo `4thtech/agentlink-ops` | Decided | 2026-10-12 | — |
| [D-27](D-027.md) | Stay on the GitHub Free plan for now (private repos without rulesets: testnet keys only, low balances) | Decided | 2026-10-12 | — |
| [D-28](D-028.md) | Hosting on Cloudflare Workers (zone `4thtech.io` is on Cloudflare) | Decided | 2026-10-12 | 08 |
| [D-29](D-029.md) | Public product and developer docs stay on GitBook (`wiki.4thtech.io`, today OCC v1 only) | Decided | 2026-10-12 | — |
| [D-30](D-030.md) | The owner delivers design through Claude Design in three drops: D1 (copy sheet, tokens, local approval UI) by week 3 of M1 | Decided | 2026-10-12 | — |
| [D-31](D-031.md) | Commitments need owner approval by default | Decided | 2026-10-12 | — |
| [D-32](D-032.md) | Negotiate-and-agree is the flagship journey (J8) | Decided | 2026-10-12 | — |
| [D-33](D-033.md) | Walking skeleton first | Decided | 2026-10-12 | — |
| [D-34](D-034.md) | Owner identity | Decided | 2026-10-12 | — |
| [D-35](D-035.md) | Cold start | Decided | 2026-10-12 | — |
| [D-36](D-036.md) | Native desktop apps for macOS, Windows and Linux in M2 | Decided | 2026-10-12 | 11 |
| [D-37](D-037.md) | Two directions | Decided | 2026-10-12 | — |
| [D-38](D-038.md) | Check the product name and trademark (D-14) before choosing the production domain, because owner passkeys bind to that domain | Decided | 2026-10-12 | — |
| [D-39](D-039.md) | UX first | Decided | 2026-10-12 | — |
| [D-40](D-040.md) | Zero-config multi-chain | Decided | 2026-10-12 | — |
| [D-41](D-041.md) | The desktop apps (macOS, Windows, Linux) are full local dashboards | Decided | 2026-10-12 | — |
| [D-42](D-042.md) | Brand | Decided | 2026-10-12 | — |
| [D-43](D-043.md) | Versioning framework | Decided | 2026-10-12 | — |
| [D-44](D-044.md) | `4thtech/agentlink` is **built in public** from 13 Oct 2026 | Decided | 2026-10-12 | — |
| [D-45](D-045.md) | Economic model (public, `12-economics-and-fees.md`) | Decided | 2026-10-12 | 12 |
| [D-46](D-046.md) | Stablecoin-only fees at launch | Decided | 2026-10-12 | — |
| [D-47](D-047.md) | Crypto-only charging during beta | Decided | 2026-10-12 | — |
| [D-48](D-048.md) | Encrypted drop by default; own storage optional | Decided | 2026-10-13 | 04, 06, 12 |
| [D-49](D-049.md) | One-click consumer storage connectors | Decided | 2026-10-13 | 07 |
| [D-50](D-050.md) | Revenue operations, phased | Decided | 2026-10-13 | 12 |
| [D-51](D-051.md) | Merge model (simplified, confirmed by Tali in chat, 13 Oct 2026) | Decided | 2026-10-13 | — |
| [D-52](D-052.md) | Automated delivery pipeline (decided by Tali in chat, 14 Oct 2026) | Decided | 2026-10-14 | — |
| [D-53](D-053.md) | MCP tool surface freeze, one-link install-and-pair, J9 as a daily habit | Decided | 2026-10-14 | 06, 08 |
| [D-54](D-054.md) | Headless KeyStore (G-31) | Decided | 2026-10-14 | 04, 07 |
| [D-56](D-056.md) | Product name and brand system | Decided | 2026-10-14 | — |
| [D-55](D-055.md) | Dedicated terms tools, one approval per agreement | Decided | 2026-10-14 | 04, 06, 11 |
| [D-57](D-057.md) | Public docs published continuously from the repository (amends D-29) | Proposed | 2026-10-14 | — |
| [D-58](D-058.md) | Owner-operation bodies (G-29) | Decided | 2026-10-14 | 04 |
| [D-59](D-059.md) | Contract roles and delays (G-3) | Decided | 2026-10-14 | 05 |
| [D-60](D-060.md) | Branch-push CI and local red evidence | Decided | 2026-10-14 | — |
| [D-61](D-061.md) | Contract and envelope decisions of 14 Oct 2026 (amends D-59) | Decided | 2026-10-14 | 04, 05 |
| [D-62](D-062.md) | Envelope signatures, keys and limits (G-2), with the contract rules stated alongside D-61 | Decided | 2026-10-14 | 04, 05 |
| [D-63](D-063.md) | Testnet deployment order and CREATE3 salts (G-8) | Decided in part | 2026-10-14 | 05, 10 |
| [D-64](D-064.md) | One deployer key and one address set for testnet and mainnet (amends D-63 (3)) | Decided in part | 2026-10-14 | 03, 05 |
| [D-65](D-065.md) | Two amendments of D-58 for owner-copy relays (G-24) | Decided | 2026-10-14 | 04, 07 |
| [D-66](D-066.md) | Owner decisions of 14 Oct 2026: key commitment (G-46), EIP-7702-delegated agent keys (G-47), owner passphrase minimum, batch gas… | Decided | 2026-10-14 | 04, 05, 07 |
| [D-67](D-067.md) | G-1 accepted as a documented M1 residual; where the owner seed lives on keychain machines | Decided in part | 2026-10-14 | 04, 06, 07, 11 |
| [D-68](D-068.md) | Owner decisions of 14 Oct 2026 on the D-67 follow-ups: batch approval, the I-4 scope pointer and the D-67 derived items | Decided in part | 2026-10-14 | 03, 04, 06, 07, 11 |
| [D-69](D-069.md) | Invite compression: raw DEFLATE (G-12) | Decided in part | 2026-10-14 | 04 |
| [D-70](D-070.md) | G-6 reading: paired contacts Talk under a fail-closed policy | Decided | 2026-10-15 | 06 |
| [D-71](D-071.md) | Owner decisions of 15 Oct 2026: the deployer keys, the RED-commit gap, proposed values, G-51, G-49 and G-52 (supersedes D-64 (1) and… | Decided in part | 2026-10-15 | 03, 04, 05, 06, 07, 08 |
| [D-72](D-072.md) | Requests from unknown senders: accept, ignore and block, and refused-row retention (IR-M1-7e-1 F01) | Decided in part | 2026-10-15 | 04, 06, 07, 11 |
| [D-73](D-073.md) | Owner decisions of 15 Oct 2026 on the M1-9 decomposition (the Talk part of M1a) | Decided in part | 2026-10-15 | — |
| [D-74](D-074.md) | `terms` canonical form and negotiation chain made exact | Proposed | — | 04, 06, 12 |
| [D-75](D-075.md) | Default relay set (owner decision of Tali, 15 Oct 2026; M1-18) | Proposed | 2026-10-15 | 04, 07 |
| [D-76](D-076.md) | MCP server: the official `@modelcontextprotocol/sdk`, with a module-graph guard on the stdio path | Decided | 2026-10-15 | — |
| [D-77](D-077.md) | Interim UCD 15.0.0 table for the `terms` character rule (#101) | Decided | 2026-10-15 | — |
| [D-78](D-078.md) | One owner, many local agents; `init` for one harness (M1-9t) | Decided in part | 2026-10-16 | 04, 06 |
| [D-79](D-079.md) | Local approval page on `http://localhost:<port>` (M1-31, IR-D56-1 F12) | Decided | 2026-10-17 | 04 |
| [D-80](D-080.md) | G-26: the STREAM header is authenticated | Decided | 2026-10-18 | 04 |
| [D-81](D-081.md) | G-20: Revocation typed data and owner nonces | Decided | 2026-10-18 | 04, 05 |
| [D-82](D-082.md) | Owner seed blobs `ALKP` (passkey PRF) and `ALKR` (recovery code) (M1-1k) | Decided | 2026-10-17 | 04, 12 |
| [D-83](D-083.md) | G-10: the contracts ABI package is private and in-repo | Decided | 2026-10-18 | 05 |
| [D-84](D-084.md) | Streaming download verification: quarantine instead of pre-check | Decided | 2026-10-18 | 04, 07 |
| [D-85](D-085.md) | G-27: inline packing is bounded by the payload cap | Decided | 2026-10-18 | 04, 06, 07 |
| [D-86](D-086.md) | G-13: Record kind is set by the core from the payload type | Decided | 2026-10-18 | 05 |
| [D-87](D-087.md) | G-25: `agentlink_verify_proof_pack` `path` is confined to two folders | Decided | 2026-10-18 | 06 |
| [D-88](D-088.md) | G-40: production is the beta; staging is CI-only | Decided | 2026-10-19 | — |
| [D-89](D-089.md) | G-17: the EIP-3009 flag is off-chain, and the vault checks the received amount | Decided | 2026-10-19 | 05 |
| [D-90](D-090.md) | G-7 and G-32 confirmed | Decided | 2026-10-19 | 04, 06, 11 |
| [D-91](D-091.md) | M1-9f: the Claude Desktop extension is an optional bundle built from the npm release | Decided | 2026-10-19 | 06 |
| [D-92](D-092.md) | M1-3j: go for the Gnosis Chiado testnet deployment | Decided | 2026-10-19 | — |
| [D-93](D-093.md) | FA-1: code-bearing signers are solo from their first item | Decided | 2026-10-19 | 07 |
| [D-94](D-094.md) | FA-3: submitter defaults | Decided | 2026-10-19 | 07 |
| [D-95](D-095.md) | Proof verification: an interim rule for card-based attribution | Decided | 2026-10-19 | 07 |
| [D-96](D-096.md) | M1-4d-c: a contract-account signer that no longer confirms its signature is a non-fatal finding | Decided | 2026-10-19 | 05, 07, 11 |
| [D-97](D-097.md) | `receiptFlags` bit layout | Decided | 2026-10-19 | 05, 07 |
| [D-98](D-098.md) | M1-7f-2: a receiver-side retention record | Decided | 2026-10-19 | 04, 07 |
| [D-99](D-099.md) | M1-9m-b L2: `policy allow-folder` refuses a folder that contains a protected folder | Decided | 2026-10-19 | 04, 06 |
| [D-100](D-100.md) | M1-9m-b L3: `agentlink policy recover` † | Decided | 2026-10-19 | 06 |
| [D-101](D-101.md) | M1-9d-2 is its own S2 card | Decided | 2026-10-19 | — |
| [D-102](D-102.md) | M1-4d-d: agent-card proof of possession in proof packs | Decided | 2026-10-19 | 04, 07 |
| [D-103](D-103.md) | Amends D-100: `agentlink policy recover` signs above both the mark and the stored version | Decided | 2026-10-19 | 06 |
| [D-104](D-104.md) | M1-4d-c: owner-approval and receipt-link rules for the proof-pack verifier | Decided | 2026-10-19 | 04, 07, 11 |
| [D-105](D-105.md) | M1-4d-c: a receipt link that does not confirm is a non-fatal warning | Decided | 2026-10-19 | 05, 07, 11 |
| [D-106](D-106.md) | M1-4d-f: card-updates follow `contacts.allowed` | Decided | 2026-10-19 | 04, 06, 07 |
| [D-107](D-107.md) | Recipient-side proof-pack export (J8 "both sides export") | Decided | 2026-10-19 | 04, 05, 07 |
| [D-108](D-108.md) | Network fields, drop-delete epoch, `agentlink verify` and the status output | Decided | 2026-10-19 | 06, 07 |
| [D-109](D-109.md) | Privacy of on-chain proofs | Decided | 2026-10-20 | 04, 05, 06, 07, 11, 12 |
| [D-110](D-110.md) | Solana support after EVM coverage (direction only) | Decided | 2026-10-20 | 07 |
| [D-111](D-111.md) | Top-up and own-account connection: direction | Decided | 2026-10-20 | 06, 08, 11, 12 |
| [D-112](D-112.md) | "Users pay all costs" covers proofs, receipts and top-ups only; messages and files stay free | Decided | 2026-10-21 | 12 |
| [D-113](D-113.md) | Top-up link format | Decided | 2026-10-21 | 06, 08 |
| [D-114](D-114.md) | Who pays for receipts: the sender's proof fee covers up to 3; deferred posting as the fallback | Decided | 2026-10-21 | 07, 12 |
| [D-115](D-115.md) | Own storage and the recovery kit (M1-9i) | Decided | 2026-10-21 | — |
| [D-116](D-116.md) | The design has existed since 14 Oct: UI is built styled from it now, after an adjustment pass | Decided | 2026-10-21 | 08, 11 |
| [D-117](D-117.md) | Design decisions: backup, exchange network, "wallet", minimum; and the UX north star | Decided | 2026-10-21 | 04, 06, 08, 11 |
| [D-118](D-118.md) | The local UI is a React app in `apps/local-ui`, embedded in the CLI | Decided | 2026-10-22 | 08 |
| [D-119](D-119.md) | Owner-signed policy loosening is allowed, with warnings the owner must acknowledge | Decided | 2026-10-22 | 04, 08 |
| [D-120](D-120.md) | App UX decisions: page-first setup, recovery kit later, automatic test credits, seven-item navigation | Decided | 2026-10-22 | 08, 11 |
| [D-121](D-121.md) | Agent-side decisions D1, D3, D4, D5, D6 | Decided | 2026-10-22 | — |
| [D-122](D-122.md) | Payment model: prepaid credits, QR top-up now, a Withdraw credits button, public trust documentation | Decided | 2026-10-22 | 03, 08, 11, 12 |
| [D-123](D-123.md) | Build-plan deviation: Chiado QR top-up now; M1-3c and a testnet slice of M3-4b pulled forward | Decided | 2026-10-22 | — |
| [D-124](D-124.md) | G-21: the install → first message target is strict and self-timed | Decided | 2026-10-23 | 08 |
| [D-125](D-125.md) | G-21: the M2 gate's onboarding timing rule (median, 80% share, 15-minute ceiling) | Decided | 2026-10-23 | 08 |
| [D-126](D-126.md) | Mechanical merge of `origin/main` into an approved PR head: lightweight re-verification | Decided | 2026-10-23 | — |
| [D-127](D-127.md) | M1-7g-e: no stored per-contact proof flag in M1 | Decided | 2026-10-23 | 04 |
| [D-128](D-128.md) | Owner-signed JSON is verified from the exact text received, strictly | Decided | 2026-10-23 | 04 |
| [D-129](D-129.md) | M1-28 interim: drop buckets now, limits confirmed, internal testers only until counsel signs off | Decided | 2026-10-23 | 04, 07 |
| [D-130](D-130.md) | 0.3.0 first run: passkey-first approvals, the owner code as a saved backup, and agent-guided setup | Decided | 2026-10-25 | 04, 06, 08, 11 |
| [D-131](D-131.md) | Cloud agent for 0.4.0: self-hosted in the user's own Cloudflare account, Claude only, an owner on the Worker's own origin, and one… | Decided | 2026-10-25 | 03, 04, 06, 07, 08 |
| [D-132](D-132.md) | Local app v2 design decisions, and confirming paid actions with the computer's own verification | Decided | 2026-10-27 | 04, 06, 08, 11, 12 |
| [D-133](D-133.md) | Messages and Files In/Out in the local app: read-only, local-only, inbound shown as untrusted plain text | Decided | 2026-10-27 | 08, 11 |
| [D-134](D-134.md) | Show in Finder without Touch ID, message history kept as today, and the local-session residual for message text accepted for 0.3.x | Decided | 2026-10-27 | 04, 08 |
| [D-135](D-135.md) | Release numbers: 0.4.0 is the local app's Messages/Files release and the cloud agent is 0.5.0; the full B-11 v2 visual refresh is the… | Decided | 2026-10-27 | — |
| [D-136](D-136.md) | Business agents: companies connect the agents they already run, through a business agent in their own Cloudflare account | Decided | 2026-10-28 | 04, 08 |
| [D-137](D-137.md) | UX wave 2 screens are built straight from the b11 brief, and "Active now" is a static dot (extends D-135 (3)(c)) | Decided | 2026-10-28 | 11 |
| [D-138](D-138.md) | Usability wave 3 (0.4.4): the app opens on a guided start; agents and AI apps are managed in the app; a live connections map | Decided | 2026-10-29 | — |
| [D-139](D-139.md) | Short invite links: the invite is encrypted on the drop, and the link carries only a secret | Decided | 2026-10-29 | 04, 06, 07, 08, 11 |
| [D-140](D-140.md) | One Touch ID creates an agent and connects its AI app (W5) | Decided | 2026-10-29 | 04, 06, 08, 11 |
| [D-141](D-141.md) | Renames reach contacts: a rename re-signs the agent's card with the new name, and the existing card update tells every contact | Decided | 2026-10-29 | 04, 06, 07, 08, 11 |
| [D-142](D-142.md) | Incoming files are saved automatically into a folder the owner chooses once | Decided | 2026-10-29 | 04, 06, 08, 11 |
| [D-143](D-143.md) | Live AI-app status and Pause: every MCP process keeps a heartbeat row, the app reads a live event stream, and the owner can pause an agent | Decided | 2026-10-30 | 04, 06, 07, 08 |
| [D-144](D-144.md) | User-facing "agent" becomes "ID" (W7-ID-RENAME) | Decided | 2026-11-02 | 08, 11 |
| [D-145](D-145.md) | Desktop apps for macOS and Windows (M2-11a, WP-D0): an Electron shell around the unchanged Node core, AI apps keep one stdio MCP process… | Decided | 2026-11-12 | 03, 04, 06, 08 |
| [D-146](D-146.md) | Names for the three codes and tags (option A): "master code", "Contact check", "ID tag" | Decided | 2026-11-12 | 04, 11 |
| [D-147](D-147.md) | Restore from a recovery kit inside the app; one kit for all IDs; a server-side kit record; Check that my kit opens (design-1112, amends… | Decided | 2026-11-12 | 04, 06, 08 |
| [D-148](D-148.md) | Local history management: Archive and Delete on this computer, Free up space, tombstones, a saved-files index, owner-signed retention… | Decided | 2026-11-12 | 04, 06, 07, 08, 10, 11 |
| [D-149](D-149.md) | A safe in-app reader for received text files | Decided | 2026-11-12 | 04, 08, 11 |
| [D-150](D-150.md) | The owner attaches light text files in the app's conversation and sends them himself | Proposed | 2026-11-13 | 04, 08 |
| [D-151](D-151.md) | One update key for the desktop app, held by CI behind the owner's approval click (UPD-0; amends D-145 (5) and Q-145-3/Q-145-4) | Decided | 2026-11-13 | 04, 08 |
| [D-152](D-152.md) | Send-by-content: the AI sends a small text file it wrote, saved first into the ID's own Send folder; the Send folder and Inbox shown in… | Decided | 2026-11-14 | 04, 06, 08, 11 |
| [D-153](D-153.md) | Forgot your master code? Start over on this computer (OWNER-START-OVER; Mac app, Windows app, browser app) | Decided | 2026-11-14 | 04, 08, 11 |
| [D-154](D-154.md) | Choose folders in Finder or Explorer, and change the Inbox folder (FILES-FOLDER-PICKER, release 0.5.8) | Proposed | 2026-11-14 | 04, 08, 11 |
| [D-155](D-155.md) | The menu bar widget: a living brand-mark icon and a read-only popover | Decided | 2026-11-16 | 04, 08, 11 |
| [D-156](D-156.md) | Security hardening after community review | Decided | 2026-11-17 | 03, 04, 06, 07, 08, 11 |
