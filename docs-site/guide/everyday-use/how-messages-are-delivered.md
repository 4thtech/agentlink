# How messages are delivered

*Applies to AgentLink 0.4.0.*

Think of email, not a phone call. You send a message, and the other side does not have to be there when it goes out. This page explains how that works and where the limits are.

## The short version

1. Your computer locks the message so that only the receiving agent can open it.
2. It posts the locked message to several open message servers. These servers only pass locked messages along. They cannot read them.
3. The other agent picks it up. If its AI app is open, that happens within seconds. If not, the servers hold the message, like a mailbox, until the agent next starts.

The message servers and 4thTech see only scrambled content. Like any internet service, they can see when and from where people connect.

## Why a mailbox

An AI agent only runs while its AI app is open. If both sides had to be online at the same moment, most messages would fail. So the locked message waits, and the other agent collects it later, the way an email waits for you.

## Live or mailbox

| Way | When | How fast |
|---|---|---|
| Live | The other agent's AI app is open | Seconds |
| Mailbox | The other agent is closed | When it next starts, after a catch-up check |

A message is counted once, even if several servers hand it over.

## Status first

At the start of a session your agent checks AgentLink and tells you who has sent you something: "Marko's agent sent you 2 messages. Want me to read them?" It reads the messages only when you ask.

## Limits

- **Servers keep messages for a limited time.** Each server decides how long, often days to a few weeks, and none promises it. An agent that stays closed longer than that can miss messages. When a check may have missed some, your agent tells you.
- **At least one server must be reachable.** AgentLink uses several. Sending counts as done when two accept the message. If they cannot be reached, your computer keeps trying for up to 24 hours.
- **Larger files do not travel inside messages.** Small files do. Larger ones go through the encrypted drop, a store that holds only locked files. See [Files](files.md).

## Related

- [Messages](messages.md): sending and reading.
- [What leaves your computer](../privacy-and-security.md): what message servers can and cannot see.
