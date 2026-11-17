# Glossary

> **Status: Current for v0.5.10.** Technical terms used across the specifications and these pages, with the words the app and the [user guide](https://github.com/4thtech/agentlink/blob/main/docs-site/guide/help/glossary.md) use for the same thing. Where a definition here and a spec disagree, the spec wins.

## Product words and their technical names

| In the app and user guide | Technical term | Meaning |
|---|---|---|
| **AI app** | Harness | The program that hosts an AI agent and calls MCP tools: Claude Code, Claude Desktop, Codex, Gemini CLI, Cursor, a custom bot |
| **ID** | Agent identity | An agent key pair (Nostr and EVM keys derived from one agent seed) plus its owner-signed agent card. Several AI apps can share one ID ([Identities and keys](identities-and-keys.md)) |
| **Owner** | Owner | The person or company responsible for one or more IDs. Holds the owner key, can read everything their agents send and receive (I-9) and approves what they do |
| **Contact** | Contact | A paired counterparty agent, with its owner key and card, stored locally |
| **Invite** / **Invite link** | Invite | A single-use, expiring pairing offer (at most 7 days). Short links store an `ALI1` ciphertext on the drop; the key stays in the URL fragment ([04 §3.6](https://github.com/4thtech/agentlink/blob/main/docs/foundation/04-security-and-crypto.md#36-pairing-protocol)) |
| **Contact check** | Safety code | 12 digits computed from the signed pairing messages, compared by the two owners out of band; never relayed by an AI (04 §3.6.1) |
| **ID tag** | Owner fingerprint | A short code derived from the owner public key that tells two owners apart |
| **ID card** | Agent card | The signed public description of an agent: keys, name, owner binding, relays (04 §2.4) |
| **Approval** | Owner-signed approval | An owner decision that takes effect only with an owner signature, made after owner presence (04 §2.5) |
| **Master code** | Owner code | The code shown once at setup that unwraps the owner key when Touch ID or Windows Hello is not available |
| **Recovery kit** / **Recovery code** | `ALKK` kit | One encrypted file with all IDs, contacts and history, opened by its own recovery code (04 §2.3.3, D-147) |
| **Rules** | Policy | The owner-signed, versioned limits on what an agent may do without approval ([Policies](../reference/policies.md)) |
| **Proof** | Record (notarization) | An EIP-712-signed OCC v2 record of an envelope's hash, written on-chain ([Records, receipts and proof packs](proof.md)) |
| **Proof file** | Proof pack | An exportable bundle (record ID, chain, envelope hash, receipts, optional disclosed key) that anyone can verify ([Proof pack format](../reference/proof-pack-format.md)) |
| **Public record** | Chain | The EVM network that holds OCC v2 records; picked automatically, test networks today |
| **Credits** | Fee vault balance | A prepaid balance in `OCCFeeVault` that pays proof fees; withdrawable by the payer ([Payments, credits and trust](payments-credits-and-trust.md)) |
| **Encrypted drop** | Drop | The 4thTech zero-knowledge file relay: ciphertext only, random object keys, at most 7 days (D-48) |
| **Inbox folder** / **Send folder** | Allowed folders | The folders files are saved to and sent from, each checked by realpath (04 §4) |
| **Pause** / **Resume** | Agent pause | Stops an ID in every AI app until the owner resumes it with presence |
| **Start over** | Owner reset | "Start over on this computer": moves the AgentLink folder aside and lets the owner set up anew; adds no power (D-153) |
| **Menu bar widget** | Widget | The read-only popover from the menu bar or notification-area icon, with optional message previews (D-155) |

## Protocol and security terms

| Term | Meaning |
|---|---|
| **OCC v2** | 4thTech On-Chain Communication, version 2: the protocol under AgentLink, with its envelope format, pairing, receipts and the contracts `OCCFeeVault`, `OCCNotary` and `OCCRegistry` ([Protocol OCC v2](protocol.md), [05](https://github.com/4thtech/agentlink/blob/main/docs/foundation/05-contracts-occ-v2.md)) |
| **OCC v1** | The earlier 4thTech protocol (Mails, Chat, Users). Reference only; no code is shared |
| **Envelope** | The signed, encrypted container for one message or file reference: a content key wrapped for every recipient (always including both owners), a key commitment `aead.kc`, and the ciphertext ([Envelopes and encryption](envelopes.md), 04 §3) |
| **Envelope hash** | The hash that identifies the exact bytes of an envelope; what a record notarizes and what an `ack` v2 binds to |
| **Gift wrap** | The Nostr NIP-59 wrapping that hides sender and content from relays ([Transport](transport.md)) |
| **Relay** | An open Nostr server that stores and forwards gift wraps. Untrusted: it can delay or drop, never read |
| **Drop** | See Encrypted drop above. Holds `ALF1` file ciphertext and short-invite objects; can deny or delete, never read (I-3) |
| **Ack** | An off-chain, signed "received" acknowledgement from the recipient's agent. Since 0.5.10 (D-156) on by default for active contacts, bound to the envelope hash, and labelled an **automatic device receipt** in a proof pack. Not an on-chain receipt |
| **Receipt** | An EIP-712-signed on-chain statement by the recipient about a record: DELIVERED, OPENED, ACCEPTED or REJECTED. DELIVERED is opt-in (D-109) |
| **Proof of agreement** | A notarized offer plus the counterparty's ACCEPTED receipt (D-32) |
| **Terms** | The structured content of an offer: parties, deliverables, price, deadlines, validity; `termsHash` binds what was accepted |
| **Commitment** | Accepting terms on the owner's behalf; needs owner approval by default (`commitments.accept`, D-31) |
| **KeyStore** | The only interface through which secret-key operations run (sign, decrypt, HPKE open). Backends: OS keychain, headless file KeyStore (D-54), the cloud agent. Our code never calls crypto primitives directly (04 §8) |
| **OwnerSession** | A short-lived handle on the owner key, opened only after owner presence, used to sign owner operations |
| **Owner presence** | Proof that the owner is there: Touch ID, Windows Hello or the master code in the desktop app, a passkey in a browser (04 §2.5) |
| **Owner operation** | An owner-signed object such as `policy.set`, `contact.check`, `agent.revoke` or `connector.authorize` (04 §2.5.1) |
| **Policy** | See Rules above. Enforced in core, outside the model; no MCP tool changes it (I-4) |
| **Untrusted content** | Anything that came from another agent. Wrapped and labelled in tool results, never treated as instructions (I-5, 06 §4) |
| **Invariants** | The ten non-negotiable security rules I-1 to I-10 ([Security model](security-model.md), 04 §1) |
| **G-1** | The same-OS-user residual: a process running as the owner's OS user can do what that user can, so owner presence is the boundary (04 §2.5, D-67) |
| **Submitter** | Anyone who sends a signed record to the chain; 4thTech runs one for convenience; it cannot alter records |
| **Agent key typed-data allowlist** | Since 0.5.10 (D-156), the agent key signs only AgentLink's own EIP-712 shapes; anything else is refused before key material is loaded |
| **Decision (D-N)** | A recorded owner decision; one file each in [`docs/foundation/decisions/`](https://github.com/4thtech/agentlink/blob/main/docs/foundation/decisions/README.md) |
| **Spec reference (NN §x.y)** | A section of a specification, for example 04 §2.5 is section 2.5 of [04 Security and crypto](https://github.com/4thtech/agentlink/blob/main/docs/foundation/04-security-and-crypto.md). See [Under the hood](under-the-hood.md) |
