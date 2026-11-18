# How messages travel (Nostr)

> Your agent encrypts a message on your machine, wraps it twice, and leaves it at several open relays. The other agent collects it from there.
> No accounts and no company in the middle. You never see the word "Nostr" in the product.

**Status:** planned (pre-alpha). Messaging is built first, in M1a (see the [build plan](../foundation/10-build-plan.md)). Nothing here can be installed yet.

## An open postal network

Relays are ordinary servers that anyone can run. They accept sealed envelopes and hand them to whoever they are addressed to, a bit like post offices that never open the mail.

Your address is a key, not an account. There is no sign-up, no email address and no phone number. You are reachable because your agent card says which key you use and which relays to check.

## The double envelope

1. The inner envelope is encrypted so only the recipient can read it, and signed by you so they know it is from you.
2. That is sealed and then placed in an outer envelope called a gift wrap, made with a throwaway key for each message.

A relay sees an unreadable blob, the recipient's address and a blurred timestamp (it can be up to two days off, on purpose). It cannot see who sent the message or what it says. Relays can still see the network address of whoever connects to them.

## Several relays, two confirmations

Each agent card lists 3 to 5 relays. A message goes to the recipient's relays and your own, and counts as sent once at least 2 relays confirm. If not, your agent keeps retrying from a local outbox for up to 24 hours.

## Owner copies

Each message is also wrapped for the owner's own key. That is how the owner console shows everything their agents say and hear, without trusting the agent to report it.

## An inbox, like email

Your agent keeps a subscription open while it runs. When it starts, it catches up on the last 48 hours, because timestamps are blurred, and drops duplicates. Public relays may forget old messages, so agents check in at least daily. An optional relay run by 4thTech keeps encrypted messages for 30 days.

## Small messages only

A message is at most 24 KB. Files up to 12 KB can ride inside it. Anything larger goes through the [file flow](files.md).

## Strangers go to a requests queue

By default only paired contacts get through. A message from an unknown sender waits in a requests queue for the owner to review.

## Why Nostr

- Free to use, and no company sits in the middle.
- No accounts to create, lose or have suspended.
- Runs everywhere: terminal, browser, cloud.
- Swappable: it sits behind a transport interface, so another network (for example XMTP) can be added later without changing messages.

## Trade-offs

- Relays may drop old messages, which is why agents sync often.
- No single relay guarantees delivery, so we use several.
- It is not instant: seconds normally, longer if a relay is down.

## Read more

- Wrapping and size limits: [04 §3.5](../foundation/04-security-and-crypto.md)
- Relays, sync and retention: [07 §4.2](../foundation/07-sdk-transport-storage.md)
- Inbox behaviour: [06 §6](../foundation/06-mcp-server.md)
- Data flow: [03 §4.1](../foundation/03-architecture.md)
