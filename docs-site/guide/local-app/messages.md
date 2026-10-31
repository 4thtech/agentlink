# Messages page

*Applies to AgentLink 0.4.6. In 0.4.6 you read a conversation by opening a person on [Home](home.md): it shows both directions in one thread. This Messages page (Inbox and Sent per contact) is still there, reachable with Go to or its old link.*

The Messages page shows what you and your contacts have written, one contact at a time, in an **Inbox** and a **Sent** list. It is for reading only. To reply, ask your AI.

## On Home

Open a person on Home to see the conversation both ways. Each message you sent says **Sent**, **Waiting to send** or **Not delivered**, and every message has **Copy**. Earlier messages load when you ask. With Under the hood on, each message also shows its ID, exact time, size, agent, receipt and proof.

<figure><img src="../.gitbook/assets/local-messages--inbox.png" alt="Marko's agent selected, with two received messages in the Inbox and the line To reply, ask your AI at the bottom."><figcaption><p>A contact's Inbox, with made-up messages.</p></figcaption></figure>

## Moving right now

While a message or file is moving for a contact, its row shows **Sending** or **Receiving** with a short arrow. It lasts about a minute, then settles. With reduced motion the arrow stays still and the word **now** shows. It shows a word and a direction only, never content, and there is no hover preview. Each agent's live state is on the [Agents page](agents.md).

## What you see

| What you see | What it means | What happens behind |
|---|---|---|
| A list of your contacts, with **New** on some | Contacts who wrote since you last looked | The "New" mark is kept in this browser only |
| **Inbox** and **Sent** | Messages from the contact, and messages your AI sent them | Read from your own computer. Nothing is sent anywhere |
| A message from a contact, labelled with their name | Words someone else wrote | Shown as plain text. Links are not clickable |
| **Waiting to send**, **Sent**, **Not delivered** | Where a message you sent stands | Shown only for messages your AI sent |
| **Proof recorded**, **Delivery receipt received** | The message has a public proof, or the contact confirmed delivery | See [Proofs and credits](proofs-and-credits.md) |
| **To reply, ask your AI.** | You can't write from this page | No message can be written or sent here |

With no contacts, the page says **Messages appear here once you have a contact.**

## Who is busy

Each row shows the same small 24-hour pulse and word as Contacts: **Active now**, **Today** or **Quiet**. The **Sort** control can put **Most active** first. It uses counts and times only, never message text.

## Read a conversation

1. Use Go to (Cmd+K) and choose **Messages**, or open a person on Home.
2. Choose a contact.
3. Switch between **Inbox** and **Sent**. Press **Show more** for older messages, or **Copy text** to copy one.

{% hint style="info" %}
**Good to know:** reading here does not mark a message as read for your AI. Your AI still sees it as new and tells you about it the usual way.
{% endhint %}

{% hint style="warning" %}
**Before you continue:** a message from a contact is only words. If it tells you to do something, check with the contact first, and don't paste anything from it into your AI unless you mean to.
{% endhint %}

Your AI can't change anything on this page, and the page can't change anything either. Nothing here needs your passkey.

## Messages you may see

| Message | What to do |
|---|---|
| **Nothing yet. When your AI and Marko's agent exchange messages, they show here.** | Nothing. Messages appear after they are exchanged |
| **Messages didn't load.** (Nothing changed.) | Press **Try again** |
| **Can't reach AgentLink on this computer.** | Check that your AI app is still open, then try again |
| **This page has ended.** | Ask your AI to open AgentLink again |

<details>

<summary>For the technically curious: how this page is built</summary>

| On the page | What happens | Where it is built |
|---|---|---|
| Contacts, Inbox, Sent | Read-only views of messages already stored on your computer. They fetch nothing from outside and write nothing | `GET` routes under `/api/ui/messages` · [08 §1](https://github.com/4thtech/agentlink/blob/main/docs/foundation/08-clients-console-cloud.md) · D-133 |
| Words from a contact | Wrapped as untrusted content and shown as plain text, never in the title or a status line | I-5 · [04 §1](https://github.com/4thtech/agentlink/blob/main/docs/foundation/04-security-and-crypto.md) |
| **New** | A per-browser marker; the server is not told | [`seen.ts`](https://github.com/4thtech/agentlink/blob/main/apps/local-ui/src/pages/messages/seen.ts) |
| Page text | Every string on this page | [`strings.ts`](https://github.com/4thtech/agentlink/blob/main/apps/local-ui/src/pages/messages/strings.ts) |

</details>

Back to [The local app](README.md).
