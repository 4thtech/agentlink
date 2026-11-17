# Policies

> **Status: Current for v0.5.10.** Source: [06 §3](https://github.com/4thtech/agentlink/blob/main/docs/foundation/06-mcp-server.md) and the schema in `packages/types/src/policy.ts`.

**Purpose:** the reference for every policy key, its default and what it allows.

## What a policy is

A policy is the owner's rule book for one AgentLink ID. It is:

- **Owner-signed.** The owner signs each version with presence (Touch ID, Windows Hello, a passkey or the master code).
- **Versioned.** Each change is a new version. The core checks the signature and the version on every load. A policy that fails the check is not applied, and actions need the owner's approval until the owner confirms it again.
- **Enforced in the core,** outside the model. No prompt, message or file can change it.
- **Changed only by the owner,** in the AgentLink app or in the CLI. No MCP tool changes a policy (I-4).

## Defaults

These are the defaults of a new policy (`POLICY_DEFAULTS`). A new ID's first rules also keep saved files for 90 days.

| Section | Key | Default | Meaning |
|---|---|---|---|
| `contacts` | `acceptInvites` | `approval` | The owner approves each invite the AI accepts (`auto` skips it) |
| | `unknownSenders` | `queue` | Messages from unknown senders wait for the owner (`drop` discards them) |
| | `allowed` | `paired` | Every paired contact may exchange messages |
| | `rateLimitPerContactPerHour` | `120` | Most messages per contact and hour |
| `files` | `allowedFolders` | none | Send folders. Empty means sending a file by path needs setup first |
| | `inboxFolder` | `~/AgentLink/Inbox` | Where received files are saved |
| | `maxSendSizeMB` / `maxReceiveSizeMB` | `100` / `200` | File size limits |
| | `storage` | `auto` | Own storage if set up, else the encrypted drop (`drop` or `own` to force) |
| | `defaultExpiryDays` | `7` | Most days a download link lives (maximum 7) |
| | `deleteAfter` | `expiry` | Remove a sent file at expiry (`receipt` removes it on delivery) |
| | `ownerArchive` | `false` | Do not keep owner copies beyond expiry |
| | `autoSave` | on, 50 files and 500 MB per contact a day; 200 files and 2048 MB in total | Files from contacts you keep are saved by themselves. "Ask before saving" can be set per contact |
| `envelopes` | `maxEnvelopeKB` | `24` | Largest message package |
| `proofs` | `notarize` | `allow` | Adding a proof (`approval` asks each time, `deny` blocks) |
| | `dailyBudgetUSD` | `"5"` | Over this in any 24 hours needs approval |
| | `perActionMaxUSD` | `"1"` | A fee above this needs approval |
| | `allowKeyDisclosure` | `approval` | Putting a content key in a proof pack needs approval |
| | `exportFolder` | `~/AgentLink/Proofs` | Where proof packs are written |
| | `defaultChain` | `base` | The proof network, picked automatically; shown only under Advanced |
| `receipts` | `autoDelivered` | `false` | On-chain DELIVERED receipts are public, so they are opt-in |
| | `autoOpened` | `false` | "Opened" only when the user asks |
| `commitments` | `accept` | `approval` | Accepting terms needs the owner, once per agreement |
| | `autoAcceptContacts` | none | Contacts eligible for auto-accept |
| | `autoAcceptMaxUSD` | `"0"` | Highest price auto-accept covers |
| | `autoAcceptDirection` | `buy` | Auto-accept only when we pay |
| | `autoAcceptMinUSD` | `null` | Selling never auto-accepts |
| `history` | `messagesKeepDays` / `filesKeepDays` | `0` / `0` | Keep everything (0 means forever) |
| `contactRules` | | none | Per-contact overrides, below |

## Received acknowledgements (`receipts.sendReceived`)

- Not one of the `POLICY_DEFAULTS` keys: a policy without it counts as on (since 0.5.10, D-156). Free and off-chain.
- Label (Settings › Rules): "Tell contacts when your AI receives a message".
- When on, the AgentLink app sends a signed off-chain acknowledgement for each message it processed from an active contact. It never does so for a blocked, removed or revoked contact, an unknown sender or a request.
- A policy signed before 0.5.10 has no such key. Absent counts as on. People who update from an earlier version see a one-time notice; new installs do not.
- The owner turns it off for everyone with the switch. A per-contact setting is planned (not in 0.5.10).
- What it tells the sender: [Privacy of proofs](../concepts/privacy.md).
- On-chain DELIVERED receipts stay opt-in: `receipts.autoDelivered` is `false` unless the owner turns it on, here or per contact.

## Per-contact overrides (`contactRules`)

Up to 256 rules, one per contact, sorted by ID. A rule applies only while the contact is paired and not blocked or revoked. Each rule has at least one of:

| Part | Key | Effect |
|---|---|---|
| `proofs` | `notarize` | Replaces `proofs.notarize` for this contact (a global `deny` always wins) |
| `proofs` | `perActionMaxUSD` | Replaces the per-proof limit for this contact |
| `receipts` | `autoDelivered` | Replaces the on-chain DELIVERED setting for this contact |
| `files` | `askBeforeSaving` | Exactly `true`: this contact's files wait for Save |

"Remember for this contact" on a proof approval creates the proof rule. A file rule can only make saving stricter.

## How a change is signed

The app builds the whole new policy with version plus one, asks for presence, and signs it. The core applies it only if the version is the next one. Changes to spending (proofs, limits, rules) get the strongest confirmation. See [06 §3](https://github.com/4thtech/agentlink/blob/main/docs/foundation/06-mcp-server.md) for the exact JSON form, bounds and the fail-closed rules.
