# Security model

> **Status: Current for v0.5.10.** This page describes the security model as shipped in release 0.5.10. Source: [04 Security and crypto](https://github.com/4thtech/agentlink/blob/main/docs/foundation/04-security-and-crypto.md), which is normative; any change to it needs a recorded decision.

## Invariants

| ID | Invariant |
|---|---|
| I-1 | Private keys are generated on the user's side and never transmitted in plaintext to any 4thTech system, relay, storage provider or chain |
| I-2 | Plaintext content (messages, files, file keys, contact lists, policies) never leaves the user's side unencrypted |
| I-3 | 4thTech-operated services must function correctly if fully compromised, without exposing I-1 or I-2 data; they may only deny or delay service |
| I-4 | Policies, approvals, key export and storage credentials are owner-controlled: they take effect only with an owner signature, and the owner key unlocks only with the owner's presence: Touch ID, Windows Hello or the master code in the desktop app, a passkey or the master code in a browser, the owner passphrase on the command line. No MCP tool and no agent process can produce one. Scope: on a machine where an agent runs as the owner's OS user, the last sentence holds only under the conditions in [04 §2.5](https://github.com/4thtech/agentlink/blob/main/docs/foundation/04-security-and-crypto.md#25-owner-operations-and-user-presence) (G-1, D-67) |
| I-5 | All inbound content from other agents is untrusted data: never executed, never interpreted as tool instructions by our code, and clearly labelled as untrusted in tool results |
| I-6 | Every on-chain record and receipt is EIP-712 signed with domain separation and replay protection |
| I-7 | No logging of plaintext, keys, presigned URLs, salts or decrypted metadata anywhere, including local logs and debug mode |
| I-8 | Only audited, widely used crypto libraries; no custom primitives |
| I-9 | Every owner can decrypt every envelope sent or received by their agents (file contents until expiry unless archived) |
| I-10 | Users can export everything (keys via the recovery kit, history, proofs) and leave; no lock-in to 4thTech services |

## Core design

- **Zero access.** 4thTech holds no user keys, plaintext, file keys, contact lists or accounts. Its services (submitter, encrypted drop, optional relay, static sites) see only ciphertext, signed public data or page loads.
- **No dangerous MCP tools.** No tool changes policies, exports keys, adds storage credentials, decides approvals or reads arbitrary files (I-4).
- **Untrusted content.** Inbound text is wrapped in a delimited untrusted-content block in every tool result. It never appears in tool descriptions, server instructions, summaries or errors (I-5).
- **Separate drop key.** Encrypted-drop requests are signed with a per-epoch drop key held in the `KeyStore`, never the agent's identity key, so the drop cannot link uploads to the agent's public identity ([Identities and keys](identities-and-keys.md)).
- **Commitments need approval.** Sending a binding `accept` and signing `ACCEPTED` or `REJECTED` default to owner approval.
- **Bounded fees.** Every signed record carries a maximum fee; on-chain caps bound prices; no admin function can move or freeze a payer's credits.
- **Narrow file access.** Tools read files only from the owner's allowed folders after the real path is resolved. Downloads are verified in a quarantine file before they appear (D-84). See [Files](files.md).

## Owner presence

Owner operations (approvals, policy changes, folders, key export, revoking, paying) need the owner's signature, and the owner key opens only with the owner's presence. Each entry or gesture unlocks the owner key for exactly one owner operation; there is no standing unlock session (D-68).

| Where | How the owner confirms |
|---|---|
| Desktop app, Mac | Touch ID (an OS sheet that names AgentLink), or the master code |
| Desktop app, Windows | Windows Hello (a TPM-backed key is required), or the master code |
| Browser app | A passkey, or the master code |
| Command line, headless | The owner passphrase or owner code, typed by the person |

- **Approvals happen in the app, never by AI.** An AI can ask for an approval and gets `pending_approval`. Only the owner decides it, on the approval card, with a gesture or the master code (D-132).
- **The desktop app has shipped** for Mac and Windows (D-145). Its native helpers release the wrapping secret for the owner key only after the OS gesture (`ALKH`, 04 §2.3.4). A passkey is used only in a browser.
- **The master code** is the fallback when Touch ID or Windows Hello can't be used (D-146). Restoring the owner key stays the recovery code's job.
- **Driving the app is not a way in.** Release builds turn off the Node, inspector and debugging switches, exit on any switch outside a small allowlist, and use a sandboxed, origin-locked window with an in-memory session (08 §8).

### Same-user processes (G-1, D-67)

Agents often run with shell access as the owner's OS user. AgentLink is built so that such a process never finds the owner key unwrapped on disk. What the desktop app adds, and what it does not:

- **What the OS sheet protects.** Touch ID and Windows Hello prompts are drawn by the operating system. A same-user process cannot answer them, and cannot see or type a gesture for the owner.
- **What a same-user process could still do.** While builds are unsigned, a process running as the same OS user that can modify the installed app, read process memory or imitate a prompt could misuse a genuine gesture or a typed master code. This is the same class as a modified package on the command line.
- **What limits it.** Small credit balances, spending budgets, harness permission settings that deny access to AgentLink's files and the keychain, and owner revocation. A same-user script that does not modify the installation and does not read process memory cannot approve or change a policy.
- **What closes it.** A signed build whose owner key opens only in a fixed-identity owner process (D-145 (3)). See the Roadmap below.

## Desktop and local app features

### Start over on this computer (D-153)

For an owner who lost the master code and has no recovery kit. Restore from a recovery kit is always offered first (D-147).

- **Not a bypass.** It signs nothing, opens no owner key, exports nothing and reveals nothing. It adds no power that a same-user process does not already have.
- **Gates, checked by the server:** the app's page session, the typed phrase `start over`, then one fresh confirmation: an OS sheet in the desktop app with Touch ID or Windows Hello, a platform authenticator in a browser, or typing the phrase again where no sensor exists.
- **Moves, never deletes.** The AgentLink folder is moved to a dated backup folder. Then the old IDs' keychain items are erased by exact name, and the app offers first run with a new master code.
- **Not from an AI.** No MCP tool, handoff token or agent credential reaches it (I-4).

### Folder picker (D-154)

- In the desktop app, **Add folder…** and **Change…** open the native Finder or Explorer dialog. In a browser, the owner types or pastes the path.
- **The picker grants nothing.** A picked path is only text. The server checks it exactly like a typed one (real path, ownership, no links, not a system or app folder), then the owner confirms with presence.
- **The Send folder is never the Inbox,** nor inside or around it, so a received file never becomes sendable.
- No MCP tool reaches any of it (I-4).

### Menu bar widget and message previews (D-155)

- **Read-only.** The widget approves, denies, signs and changes nothing, and never shows a presence prompt. Review approvals, Pause and Update open the main window.
- **Previews are built by the server:** plain text, one line, at most 80 characters, with control and direction characters removed. They are shown as text only, never as markup or links.
- **"Show message previews"** (Settings › Appearance, on by default) turns them off. The server then omits them from its answer; the page does not just hide them.
- Previews never reach the icon, its tooltip, the private pipe, OS notifications, the window title or logs (I-5, I-7).

## New in 0.5.10 (D-156)

### Signed "received" acknowledgements

| Rule | Behaviour |
|---|---|
| Default | On. The recipient's AI app sends a signed off-chain `ack` for each processed message |
| Who gets one | Only active, fully paired contacts. Never a request, an unknown sender, or a blocked, removed or revoked contact |
| Binding | The ack is bound to the envelope hash, not only the envelope ID |
| Verification | The sender counts it only from the contact the envelope went to, with a signature that verifies against that contact's card at the key epoch in force when it was made |
| Timing privacy | Sent after a random delay of 5 to 90 seconds, with a minute-rounded time |
| Off switch | "Tell contacts when your AI receives a message" (Settings › Rules), for everyone; a per-contact setting is planned. Policy `receipts.sendReceived`; absent means on ([Policies](../reference/policies.md)) |
| Older apps | An ID-only ack from an older app shows as "Received (older app)" and never makes a proof "Delivered" |
| Proof packs | The ack may be carried as an **automatic device receipt**, labelled as such and reported apart from on-chain receipts. The owner may leave it out at export |
| On-chain receipts | On-chain DELIVERED receipts stay opt-in (D-109) |

An ack tells the sender that the recipient's AI app processed the message at about that time. The delay, the coarse time and the switch bound what it discloses.

### Agent key typed-data allowlist

The agent key signs only AgentLink's own EIP-712 shapes: OCC v2 records and receipts for an allowlisted chain and contract, agent cards, and the credits top-up authorization (recipient fixed to that chain's AgentLink vault, an allowlisted token, a value cap). Anything else is refused with a fixed error **before any key material is loaded**, in every `KeyStore` backend (04 §3.1.1). Owner signing is unchanged and needs presence.

### Desktop app reliability (08 §8)

- **Quit order.** Every quit path closes the windows first, then asks the core to shut down and waits for it, then exits. No window shows a "not running" page or a terminal command while quitting.
- **The widget opens reliably,** on the current Space and over full-screen apps.
- **A widget row opens the exact item:** a message row opens that contact's conversation, an approval row that approval. Only an ID travels, checked against a strict pattern; an unknown target opens the list.

## Updates and sending

- **Updater trust (D-145, D-151).** The desktop app installs an update only if it is signed by the one update key whose public half is pinned in the app. CI signs the manifest (SHA-256 of each file, channel, short validity, no downgrades) only after the owner's approval click in a protected environment. The app re-checks every signature and hash before it replaces itself. Updating never touches IDs, keys or messages.
- **Sending from the app (D-150).** The owner can attach `.md`, `.txt` or `.json` files in a conversation. This is a local route behind the session, CSRF and origin checks, not an MCP tool. Files go only through the ID's own Send folder and the ordinary send under the policy in force.
- **Sending by content (D-152).** `agentlink_send` takes `file: {name, content}` for a small text file the AI wrote. It writes only into the root of the ID's own Send folder (no overwrite, no links followed), only text types, within a per-ID daily budget. No tool can choose another folder or change the budget (I-4).

## Accepted trade-offs and residual risks

- **No forward secrecy for stored messages** (04 §6). Owners must be able to read history (I-9), so a stolen encryption key opens past envelopes addressed to it. Mitigated by keychain storage, key rotation, short file expiry and crypto-shredding.
- **Same-user processes** (G-1, D-67). A process running as the owner's OS user that modifies the installation, reads process memory or imitates a prompt can act beyond what I-4 promises. Limited by small balances, budgets, harness permissions, revocation and, in the desktop app, OS-drawn prompts.
- **Compromised hosts serving code.** Whoever can serve code for the console, the setup guide page or a user's own cloud agent controls what those pages do. Limited by open source, reproducible builds, published hashes, SRI and CSP, and by self-hosting or the desktop app.
- **Unsigned desktop builds.** While builds are unsigned, a same-user process could change a staged update between its last check and the install. Today this adds nothing, because that process could change the installed app directly. Signed builds close it.
- **Metadata.** Relays, the encrypted drop and storage providers see IP addresses, sizes and timing. The chain shows pseudonymous agent addresses and, after an on-chain receipt, the link between a record and its recipient.

## Roadmap

Later items of D-156, in order:

- Planned: approval cards that show, in full, what will be signed, decoded by the app itself, 0.5.11.
- Planned: hard owner ceilings per proof and per day, above which nothing is signed, 0.5.11.
- Planned: caps on invites the AI makes, with added contacts waiting until the owner keeps them, 0.5.11.
- Planned: outgoing caps per contact and per day for messages and files, 0.5.11.
- Planned: a message counts as sent once a relay serves it back, 0.5.12.
- Planned: a restore guard that keeps spending and processed actions consistent after a restore, 0.5.12.
- Planned: an on-chain spending allowance and a protected signing helper on macOS, before mainnet (M3).

## Decisions behind the mechanisms

The decisions below shape the security mechanisms on this page and in 04; each file in the [decision log](https://github.com/4thtech/agentlink/blob/main/docs/foundation/decisions/README.md) has the full text. Decisions named elsewhere on this page are not repeated.

| Decision | What it settles |
|---|---|
| D-58, D-65 | The exact bodies of owner operations, cards and pairing messages, and owner-copy relays (04 §3.4.1) |
| D-61, D-62 | Envelope signatures, keys and size limits, and the contract rules that go with them (04 §3.1.1) |
| D-66 | The key commitment `aead.kc` and wraps derived from the content key, so one ciphertext cannot open differently for different recipients (04 §3.3) |
| D-69 | Invite payload compression with bounded decoding (04 §3.6) |
| D-75 | The default relay set and how relays are vetted |
| D-78 | One owner with several local agents: logical separation, not a security boundary (04 §2.2) |
| D-79 | The local approval page on `localhost` and its request guards |
| D-81 | Revocation typed data and single-use owner nonces (05 §4) |
| D-82 | The owner seed wraps `ALKP` (passkey) and `ALKR` (recovery code) (04 §2.3.1, §2.3.2) |
| D-90 | Lifetimes of owner-signed objects, the rolling 24-hour budget window and per-contact proof rules (04 §2.5.1, 06 §3) |
| D-99 | An allowed folder may not contain a protected folder (04 §4) |
| D-102, D-104 | Proof-pack verification: the agent card's proof of possession, owner approvals and receipt links (07 §8) |
| D-106 | Card updates are sent only to contacts the policy allows, and none while the policy cannot be read |
| D-117 | Design rules: backup export behind owner presence, the plain-words vocabulary, the UX north star |
| D-119 | An owner may loosen a policy only by signing it, after acknowledging each warning |
| D-127 | A contact's proof flag is derived from refused rows, not stored separately; no MCP tool can clear it |
| D-129 | Drop storage: the 7-day lifecycle, per-file and weekly limits, a download limit per object (07 §5.4) |
| D-134 | Show in Finder needs no extra gesture and opens only the recorded file inside the Inbox folder, through the OS opener |
| D-136 | Business agents run in the company's own Cloudflare account, under the same owner model as the cloud agent |
| D-140 | One Touch ID creates an agent and connects its AI app, as one owner operation (04 §2.8) |
| D-141 | A rename re-signs the agent card and reaches every contact through the existing card update |
| D-149 | Received text files open in a safe in-app reader: plain text, never executed or rendered as active content |

## Assurance

- Crypto, the policy engine and anything that signs are built tests-first, with shared cross-runtime test vectors.
- Every security-relevant change gets an independent review. Contracts get an external audit, and `crypto` and `core` an independent review, before mainnet (M3).
- Reporting: see [SECURITY.md](https://github.com/4thtech/agentlink/blob/main/SECURITY.md). Unfixed vulnerabilities are never described in public docs.

See also the [Threat model](threat-model.md).
