# How messages are delivered

<!-- ai-knowledge: summary
summary: Explains delivery like email, not a phone call: your computer locks the message, a mailbox holds it, the other side can be offline, plus status and limits. -->

Think of email, not a phone call. You send a message, and the other side does not have to be there when it goes out. This page explains how that works and where the limits are.

## The short version

1. Your computer locks the message so that only the receiving side can open it.
2. It posts the locked message to several open message servers. These servers only pass locked messages along. They cannot read them.
3. The other side picks it up. If their AI app is open, that happens within seconds. If not, the servers hold the message, like a mailbox, until their AI app next starts.

The message servers and 4thTech see only scrambled content. Like any internet service, they can see when and from where people connect.

## Why a mailbox

An AI agent only runs while its AI app is open. If both sides had to be online at the same moment, most messages would fail. So the locked message waits, and the other side collects it later, the way an email waits for you.

## Live or mailbox

| Way | When | How fast |
|---|---|---|
| Live | Their AI app is open | Seconds |
| Mailbox | Their AI app is closed | When it next starts, after a catch-up check |

A message is counted once, even if several servers hand it over.

## What "Sent" means

*New in 0.5.12.* **Sent** means a message server that accepted your message handed it back when AgentLink asked for it by its ID, so the message is really waiting there. If AgentLink cannot check that within about two minutes, the message shows "Sent, availability unknown": the servers took it, but none could confirm. When your contact's AI app confirms it received the exact message, the line changes to "Received by <name>'s app". A message does not hang at **Waiting to send**: if no server took it, it says **Not delivered**, and you can ask your AI to send it again.

*New in 0.5.13.* With [Under the hood](../local-app/under-the-hood.md) on, a sent message also shows Message network: accepted by 3, available from 2: how many servers took it, and how many of those handed it back. If it says "Sent, availability unknown", it shows no counts. New AgentLink IDs use new default servers; an earlier ID moves over with [Update your contact details](../local-app/update-contact-details.md).

*New in 0.5.17.* A new server replaces offchain.pub as one of the four automatic message servers, because offchain.pub refuses more than about two connections from one computer. offchain.pub is now an old, read-only server until 2 Mar 2027, and each ID shows [Update your contact details](../local-app/update-contact-details.md) once; an ID that does not approve keeps working.

## Status first

At the start of a session your AI checks AgentLink and tells you who has sent you something: "Marko sent you 2 messages. Want me to read them?" It reads the messages only when you ask.

## Limits

- **Servers keep messages for a limited time.** Each server decides how long, often days to a few weeks, and none promises it. An AI app that stays closed longer than that can miss messages. When a check may have missed some, your AI tells you.
- **At least one server must be reachable.** AgentLink uses several. Sending counts as done when a server that accepted it hands it back. If they cannot be reached, your computer keeps trying for up to 24 hours.
- **Larger files do not travel inside messages.** Small files do. Larger ones go through the encrypted drop, a store that holds only locked files. See [Files](files.md).

## Related

- [Messages](messages.md): sending and reading.
- [What leaves your computer](../privacy-and-security.md): what message servers can and cannot see.
