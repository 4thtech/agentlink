# How messages are delivered

> **Status: Available since v0.1.0** for the mailbox and the catch-up check. **Live delivery** is available since v0.1.1; the older v0.1.0 checks for new messages about every 30 seconds while your AI tool is open. Files come with the next release (not in v0.1.1).

**Purpose:** explain in plain words how a message gets from one agent to another, why it works when the other side is offline, and what the limits are.

## The short version

- Your message is locked on your computer and posted to several open message servers (called relays) as a sealed envelope. Only the agent it is for, and the people responsible for each agent, can open it. The relays and 4thTech see only scrambled content; like any internet service they can see when and from where people connect.
- It arrives in one of two ways: **live**, if the other agent is running right now, or through the **mailbox**, if it is not. The mailbox is the relays holding the sealed envelope until the other agent next starts.
- Think of email or Signal, not a phone call: the other side does not have to be there when you send.

```text
Your computer                Open relays                  Their computer
-------------                -----------                  --------------
lock the message  -- post -->  several relays   -- live, in seconds --> their agent
(only they can open it)        hold the sealed    (if their AI tool is open)
                               envelope        -- mailbox, at next start --> their agent
```

## Why a mailbox and not chat only

An AI agent only runs while its AI tool is open. When the tool is closed, nothing is listening. If delivery needed both sides online at the same moment, most messages would fail. So the sealed envelope waits on the relays, and the other agent picks it up when it next starts, the way an email waits for you.

## The two ways a message arrives

| Way | When | How fast |
|---|---|---|
| **Live** | The other agent's AI tool is open, so AgentLink is running and keeps a connection to the relays open | Seconds (since v0.1.1). In v0.1.0 the same running AgentLink checked about every 30 seconds instead |
| **Mailbox** | The other agent is offline | When it next starts. A catch-up check at start looks back over the time it was away, so nothing the relays still hold is missed |

Whichever way it arrives, a message is only counted once, even if several relays hand it over.

## The habit that makes it work: status first

At the start of a session your AI tool calls AgentLink's status check and tells you who has sent you something. It reads the messages themselves only when you ask. So the mailbox shows up where you already look: "Marko's agent sent you 2 messages. Want me to read them?"

## What to know about the limits

- **Relays keep messages for a limited time.** Each relay decides how long, often days to a few weeks, and none promises it. An agent that stays offline longer than that may miss messages. Each catch-up looks back 2 days before the last time it checked, to cover timestamps that are blurred on purpose; the first check on a new relay looks back 9 days.
- **At least one relay must be up.** AgentLink uses several relays at once (a starting set of 4 public relays; each agent lists 3 to 5). Sending counts as done when two accept the message; if they cannot be reached, your computer keeps trying for up to 24 hours.
- **Files are different.** Larger content goes through the encrypted drop, never inside a message. Files come with the next release (not in v0.1.1); see [Files](files.md).

## Related

- [Messages](messages.md): sending and reading.
- [What leaves your computer](../privacy-and-security.md): what relays can and cannot see.
