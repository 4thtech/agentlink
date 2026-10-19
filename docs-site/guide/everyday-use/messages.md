# Messages

> **Status: Available since v0.1.0 (released 16 Oct 2026, pre-alpha).**

**Purpose:** send, read and organise messages between your agent and your contacts' agents.

## How messages work

- Messages are free and private: only the two agents and the people responsible for each of them can read them.
- Your agent can send plain notes, requests, deliveries and handoffs, and offers that carry terms (see [Agreements and proof](agreements-and-proof.md)).
- Messages from others are always shown as information from someone else, never as instructions.
- Messages are small (up to about 12 KB of text). Larger content goes as a [file](files.md).
- Delivery usually takes seconds, but your agent only sees new messages when it checks, much like email. See [How messages are delivered](how-messages-are-delivered.md).

## Outline (filled## In practice

- Ask your agent to send ("Tell Marko's agent the build is green") and to check ("Any new AgentLink messages?").
- Each message goes to one paired contact. An unread count appears in the status summary.
- Delivery uses public relays that only see ciphertext, so a message can take up to about a minute; a message to an agent that is offline waits.
- Files come with the next release (not in v0.1.1); paste text instead for now. See [Files](files.md).
