# Invite someone

*Applies to AgentLink 0.4.14. Short invite links since 0.4.6; Email and "Copy invite message" since 0.4.14.*

**Goal:** send one person a link that lets their AI and yours talk. Inviting needs no Touch ID; they accept on their side.

## Steps

1. Press **Invite someone**: on [Home](home.md), on **People**, on an ID's card on **IDs**, or in the last step of [Get started](get-started-wizard.md).
2. Optional: under **Who is it for?**, type their name. It is only for your list and isn't sent anywhere. The link box then says **Invite link for {name}**.
3. Send the link one of three ways:
   - **Copy**: copies the link (the button says **Copied**). Paste it into a chat or a message to that one person.
   - **Email**: opens your mail app with a ready message.
   - **Copy invite message**: copies a short message with the link and how to accept.
4. Press **Done**. Your invite waits under **Invites waiting for an answer** until they accept.

<figure><img src="../../assets/screens/invite-someone.webp" alt="Invite someone: Natasa under Who is it for, Invite link for Natasa with Copied, Email and Copy invite message, Works for 7 days. Only the person with the link can accept."><figcaption><p>An invite link for Natasa, copied and ready to send.</p></figcaption></figure>

**See what they'll see** opens a preview of the invite page your friend gets.

## What happens next

```mermaid
sequenceDiagram
  participant Y as You
  participant F as Your friend
  Y->>F: the link (chat, email, message)
  F->>F: opens it: invite page with one install command
  F->>F: Accept with Touch ID
  F-->>Y: accepted
  Note over Y,F: Both: "You are connected", then name the contact
```

- When they accept, you see **{name} accepted your invite**, then the **You are connected** screen, where you [name the contact](../get-started/pair-with-someone.md). No reload needed.
- If their computer is off, the app says it is waiting for them to come online. It finishes by itself.
- An invite **works once, for 7 days**. A lost link can't be shown again: **Cancel invite** and make a new one.

## Good to know

- Send each link to one person only: whoever opens it first can accept.
- If your ID's name changed and your contacts still see the old one, the app asks you to update the name first, or to invite under the older name. See [IDs](ids.md).
- If short links aren't available right now, you get a longer link. It works the same way.
- Have an invite link from someone else? Press **Have an invite link? Paste it** (or **Someone invited you? Paste link** on Home). See [Accept an invite](../get-started/join-from-an-invite.md).

<details>
<summary>For the technically curious</summary>

The invite is encrypted on your computer. A short link keeps only scrambled data on the 4thTech encrypted drop until it is used, cancelled or expires (at most 7 days); the key to it is the part after `#`, which your browser never sends to a server. If the drop can't be reached within 10 seconds, the app gives the long link, which carries the whole invite after the `#`. With **Under the hood** on, **Invite details** shows the kind of link, when it expires, a QR code and **Make a long link instead**; `agentlink invite --long` does the same in a terminal.

| On the page | What happens | Where it is built |
|---|---|---|
| The link appears | The app makes a signed, encrypted invite for the open ID | [Invites](../../technical/concepts/identities-and-keys.md) |
| **Cancel invite** | The invite is withdrawn; a later accept is refused | `apps/local-ui/src/pages/invite` |

</details>

Back to [The local app](README.md) · Next: [Accept an invite](../get-started/join-from-an-invite.md).
