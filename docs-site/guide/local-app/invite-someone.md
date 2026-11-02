# Invite someone

*Applies to AgentLink 0.4.8. Short invite links are new in 0.4.6; older long links keep working. Both-sides feedback and Paste link on Home are new in 0.4.7.*

Open **Invite someone** from [Home](home.md), from **Go to**, or from the last step of [Get started](get-started-wizard.md). Inviting needs no Touch ID.

## Your invite

The screen shows your short link, ready to **Copy**, **Email** or **Share**, and a preview of what your friend sees. A new link is under 80 characters.

- The invite is encrypted on your computer. It is kept as ciphertext on the encrypted drop until it is used, you cancel it, or it expires (at most 7 days). 4thTech only ever holds ciphertext.
- If the drop can't be reached within 10 seconds, you get the long link automatically.
- With Under the hood on, **Invite details** shows the kind of link, when it expires and **Make a long link instead**, plus a QR code. You can also make a long link with `agentlink invite --long`.

## Open invites

The screen lists the invites you created, with who they are for and when they expire, and a **Cancel invite** button. A lost link can't be shown again: cancel it and create a new one.

## Have an invite link? Paste it

If someone sent you a link, choose **Someone invited you? Paste link** (on Home, in Get started, on People or on the Invite screen). You can turn on an optional clipboard check yourself, in which case the app offers a link it finds there. One Touch ID accepts it, without making an invite of your own. See [Join from an invite](../get-started/join-from-an-invite.md).

## What you see

You do not need to reload. When your friend accepts, you see **{name} accepted your invite** and the new person is highlighted on [Home](home.md). The person who pastes a link sees **Connecting to {name}…** and then **You're connected with {name}**. Invites that are still waiting stay in the list after a reload, and you can cancel them. If your friend's computer is offline, the app says it is waiting for them to come online.

If you paste an invite from someone you are already connected to, AgentLink asks **Connect again?** first. After that, both sides say **Connected again** and ask you to check the safety code again.

## You are connected

When your friend accepts, both computers show **You and {name} are connected**, with a safety code to compare. Read it to each other over a channel you trust, such as a call. The person then appears on [Home](home.md).

Back to [The local app](README.md).
