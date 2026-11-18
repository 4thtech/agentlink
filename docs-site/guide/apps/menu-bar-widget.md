# The menu bar widget (Mac and Windows)

*New in 0.5.9, in the Mac and Windows desktop apps. The browser app has no icon.*

The AgentLink desktop app puts a small icon in your **menu bar** (Mac) or **notification area near the clock** (Windows). It shows at a glance whether AgentLink is running and whether anything needs you, and one click opens a small widget with the latest. You do not have to open the app.

## What the icon shows

The icon is the AgentLink mark: two brackets and a diamond. The **shape** tells you the state, never only the colour.

| What you see | What it means |
|---|---|
| Plain mark | Connected and running |
| Mark that breathes | Connecting |
| Mark with a **filled dot** | An approval is waiting for you |
| Paused mark | AgentLink is paused: nothing is sent or received for now |
| Offline mark | AgentLink is not running |
| Update mark | An update is ready |
| Mark with a **hollow ring** | You have unread messages |

The ring and the dot are different shapes on purpose: a ring is "new messages", a dot is "something needs you". Opening the widget clears the ring on the icon. The counts for each contact in the widget stay until you open that chat in the app. The dot stays until the approval is decided.

**What it animates on.** The icon moves for a moment when:

- **A message arrives:** the diamond slides in.
- **Your AI sends a message:** the diamond slides out and back.
- **An approval is waiting:** the mark grows once, then shows the dot.

It does not animate when AgentLink starts, and not more than once every couple of seconds for the same kind of news. **Reduced motion:** if your computer asks for less motion, or Reduce motion is **On** in [Appearance](../local-app/appearance.md), the icon only shows the final picture and never moves.

Hover over the icon for a short line such as "AgentLink: Running · 1 waiting". It only ever has words and numbers, never a name or a message.

## Click it: the widget

A click opens the widget under the icon. It is 360 pixels wide, closes when you click anywhere else or press **Esc**, and shows these sections in this order:

1. **Status.** *Running*, *Paused*, *Not running* or *Connecting…*, and **Update ready** when there is one.
2. **Needs you.** How many approvals are waiting and how many new files, with **Review**. New files leave this list once you open, save or show them in the app, or choose **Mark as seen** in that conversation. If nothing is waiting: "Nothing is waiting."
3. **Connected now.** For each of your IDs, which of your AI apps are *Working*, *Ready* or *Idle*, or *Not running*.
4. **Contacts.** People you have exchanged something with today, marked **Active now** or **Today**. AgentLink only knows the time of the last exchange, so it never says a contact is "online".
5. **New messages.** For each contact: their name, how many new messages (new files are counted under Needs you, not here), how long ago, and the first line of the newest one (a **message preview**, up to 80 characters, plain text). Click a row to open that chat in the app.
6. **Today.** A small chart by the hour of messages in and out, proofs and files.
7. **Live.** The newest things that happened.
8. **Footer.** **Open AgentLink**, **Pause** or **Resume**, **Update ready** when there is an update, and **Quit**.

Previews come from other people's AI agents, so they are shown as plain text and nothing in them is clickable. You can turn them off, see Settings below.

## The widget only looks

The widget never approves, denies or signs anything, and it never asks for Touch ID, Windows Hello or your master code. **Review**, **Pause**, **Resume** and **Update ready** open the main AgentLink window, where you do it as usual. That keeps every decision in one place that you can see.

## Right-click menu

Right-click (or Control-click on a Mac) the icon for a short menu: **Open AgentLink** and **Quit**. **Quit** on a Mac also works with **Cmd+Q** when the widget is open.

## On Windows

The icon sits in the notification area at the right of the taskbar, near the clock. Windows starts new icons in the hidden **^** area. To keep AgentLink visible:

- Drag the AgentLink icon out of the **^** area onto the taskbar, or
- Open **Settings** › **Personalization** › **Taskbar** › **Other system tray icons** and switch **AgentLink** on.

## The Settings switches

In **Settings** › [Appearance](../local-app/appearance.md), in the desktop app only:

- **Show AgentLink in the menu bar** (Mac) or **Show AgentLink near the clock** (Windows). On by default. Off removes the icon. On a Mac the Dock icon stays. On Windows, **while the icon is hidden, closing the window quits AgentLink**, because otherwise it would keep running with no way back to it.
- **Show message previews.** On by default. Off removes the first line of messages from the widget; it then shows only the name, the count and the time.

Back to the [desktop app](desktop-app.md).
