# Notifications

*Applies to AgentLink 0.5.5. The bell and Settings › Notifications are new in 0.5.4. In 0.5.5 a click opens the right place, other IDs are covered and notifications stay quiet while the window is in front.*

## The bell

The **bell** is in the top bar, left of **Go to**. Its number is how many things are new for the ID you have open; above nine it shows **9+**. The same number is in front of the browser tab's title, for example *(3) Home · AgentLink*, and the tab's icon shows a small dot while an approval waits for you.

Open the bell to see a short list in three groups:

| Group | What is in it |
|---|---|
| **Needs you** | Approvals waiting for you. They stay here, and in the number, until you approve or deny them. |
| **New** | New messages and files, one line per person ("3 new messages from **Ana**"), a new version of AgentLink, and the message network when it has been unreachable for 10 minutes. |
| **Earlier** | What you have already seen. |

- Click a line to go to it (Home for approvals and people, Settings › Updates, or the network page under Advanced). It is then marked as read.
- **Mark all read** clears the dots. Approvals still count until you decide them.
- The gear opens **Settings › Notifications**; **Open Activity** shows the full history.
- With the keyboard: Tab to the bell, Enter to open, the arrow keys to move, Escape to close.
- On a phone the list opens across the screen.

The list never holds what a message says, a file's name or a link. A person is named only by a name **you** gave them on People; someone who only has the name they chose for themselves, or anyone else, is "a contact". The list stays on this computer, in the ID's own folder, and keeps the last 30 days (at most 200 lines).

## Notifications from the desktop app

When you use the AgentLink desktop app, it shows real notifications from AgentLink (its own name and icon). Each one says only one of four things:

| Notification | When | A click opens |
|---|---|---|
| **Approval waiting** | Your AI asks for an approval | That approval |
| **New message** | A contact sends you a message | That conversation |
| **File received** | A contact sends you a file | That conversation |
| **Update ready** | A new version of AgentLink has finished downloading and is ready to install (also once at launch, if one is already waiting) | Settings › Updates |

- A notification never shows what a message says, a file's name or a link, and it never approves, accepts or replies. To decide, open AgentLink.
- It says "From a contact" unless you turn on **Show names in notifications**. Then it uses the name **you** gave the contact on People. A name someone chose for themselves is never shown.
- Since 0.5.5 a click opens that approval or that conversation, not just Home. The click carries only an opaque local reference that AgentLink checks again before it opens anything; no message text or name is in it.
- A file and the message that comes with it raise one notification, not two.
- Notifications also cover your **other IDs**, not only the one you have open, under the same **New messages** and **Files received** switches. With **Show names in notifications** on, such a notification names the ID and a contact name you gave, never message text.
- While the AgentLink window is in front and focused, no notification pops up: you are already looking at it. The bell and the badge still update, and notifications return as soon as you switch away.
- You get at most one of each kind every 30 seconds. If more arrive in between, the next one counts them ("3 new messages from your contacts").
- On a Mac, the number on the AgentLink icon in the Dock is how many approvals are waiting.
- On a Mac, the first notification may ask whether AgentLink may show notifications. If you said no, turn them on in System Settings › Notifications › AgentLink.
- While the desktop app runs, AgentLink shows no other alert for approvals of the ID you have open, so you never get two.

## Settings › Notifications

The switches you see depend on where you use AgentLink. Your choices are kept for this copy of AgentLink, for every ID.

**In the desktop app:**

| Switch | Starts |
|---|---|
| **Approvals waiting** | on |
| **New messages** | off |
| **Files received** | off |
| **Updates** | off |
| **Show names in notifications** | off |

**In a browser:** one switch, **Approvals waiting**, which starts **on**. When your AI asks for an approval and AgentLink cannot open it in your browser, a short alert on this computer says one is waiting. The alert names no one and never approves anything. Turn the switch off and AgentLink shows no such alert; the bell and Home still show the approval.

The bell in the app always lists what is new, whatever you choose here. Nothing on this page changes what your AI may do.

Back to [The local app](README.md).
