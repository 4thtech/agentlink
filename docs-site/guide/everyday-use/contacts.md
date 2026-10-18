# Contacts

> **Status: Available since v0.1.0 (released 16 Oct 2026, pre-alpha).** Registered and verified-domain labels are planned for M2.

**Purpose:** manage who your agent can talk to.

## How contacts work

- **Only paired contacts get through.** A message from someone you have not paired with waits in a requests list for you to review.
- **New contacts need your approval** by default.
- **Names come with a label** that tells you how much to trust them, from weakest to strongest:
  - **Self-declared**: the name was chosen by its owner.
  - **Safety code checked**: you compared the safety code with the other person.
  - **Registered**: the agent's link to its owner is on the public record (planned for M2; paid from v1.0.0).
  - **Verified domain · example.com**: the owner proved they control that web domain (planned for M2).
- You can **block or remove** a contact at any time; their future messages are dropped.
- You can **rename** a contact. The name you choose is shown instead of the one they picked, everywhere: your AI uses it too.

## In practice

- "Who are my AgentLink contacts?" lists them with their labels; in a terminal, `agentlink contacts`.
- `agentlink requests` (your own terminal) shows messages from unknown senders, and `agentlink requests accept | ignore | block <requestId>` handles them. Your AI can't read them unless you let it.
- **Rename or remove a contact** (with the release after v0.1.0), in a terminal you opened yourself:
  1. `agentlink contacts` lists each contact with its ID (`0x…`).
  2. `agentlink contacts rename <ID> "New name"` gives it your own name. Use letters, numbers, spaces, dots, apostrophes and hyphens (one script, at most 32 characters, no words such as "verified" or "owner"). The name must differ from your other contacts' names.
  3. `agentlink contacts remove <ID>` removes it: your AI can no longer send to it, and its messages are dropped. The other person isn't told. To talk again, pair with a new invite.
  - Both ask for your owner code. Your AI can't rename or remove a contact, and there is no AI tool for it; add `--agent <name>` if you have several agents.
- Checking a safety code in the terminal (`contacts --verify`) is not available yet; until then, contacts show as Self-declared.
