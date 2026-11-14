# Storage and Free up space

*Applies to AgentLink 0.5.5. Storage showed sizes only in 0.5.1; Free up space, Keep automatically, Delete history and Archive are new, and your AI can suggest a cleanup.*

Open **Settings** › **Storage** (in the **Your AI** group). It shows how much room your messages and saved files take on this computer, and lets you free up space.

<figure><img src="../../assets/screens/storage.webp" alt="Storage: how much room messages and saved files take, for each ID and each person, and the size of the Inbox folder."><figcaption><p>Storage: sizes for each ID and each person.</p></figcaption></figure>

## What it shows

- **For each ID:** how much room its messages and saved files take.
- **For each person:** the same, so you can see where the room goes.
- **The Inbox folder:** how big `~/AgentLink/Inbox` is, where received files are saved. **Show in Finder** opens it (Windows: **Show in folder**).

## Free up space

1. Choose a **Person** (or Everyone), how old (**Older than** 30 days, 90 days or 1 year), and tick **Files only** to keep the messages.
2. Press **Review**. AgentLink says what that removes, for example "This removes 12 messages and 4 files (30 MB)." Nothing is removed yet.
3. Press **Delete with Touch ID** (or Windows Hello, your passkey, or **Use your master code instead**). You confirm once for the whole list.
4. For 10 seconds a message offers **Undo**. Undo cancels everything: nothing is removed. Quitting AgentLink during those 10 seconds also removes nothing.
5. After that, the messages are gone from this computer and the saved files are in the Trash ("Moved 4 files to the Trash."). You can still get files back from the Trash.

## Keep automatically

AgentLink can clear out old history on this computer once a day, so you don't have to remember.

- **Keep messages:** Forever (the default), 90 days, 1 year or 2 years.
- **Keep saved files:** Forever, 30 days, 90 days, 6 months (180 days) or 1 year. Only files AgentLink saved in your Inbox folder and that you haven't moved or changed; they go to the Trash. A new ID starts with **90 days** for saved files. If you used AgentLink before 0.5.4, nothing changes until you choose here. Ages count from when a message or file reached this computer, so a message someone dated in the past is not removed early.

When you pick a new value, the page first says what it would remove right now, for example "Right now this moves 4 files (30 MB) to the Trash." Press **Save with Touch ID** (or Windows Hello, your passkey, or the master code) to keep it. The same rules apply as for a delete you start yourself: only on this computer, pairing, terms, approvals and receipts are always kept, and proofs stay valid. Nothing is removed while the ID is paused, or while your rules need to be confirmed again. Your AI can't change these settings.

## Ask your AI to tidy

You can also say "free up some space" to your AI. It can only **suggest** a cleanup: for example saved files older than 90 days, or messages and files older than a year, for everyone or one person. It tells you how much that would remove and gives you a link to **Settings** › **Storage** with the filters filled in. Press **Review** to see the exact counts. Nothing is deleted until you press **Delete with Touch ID** there, and you still get 10 seconds to **Undo**. A message from someone else can't make your AI delete anything.

## From a conversation

- In the person's **⋯** menu: **Delete history…** (messages and files, messages only or files only, any age or older than a time) and **Archive**.
- In the conversation: **Select**, tick the messages, then **Delete 2 messages**.

Both use the same steps: what it removes first, one Touch ID, then 10 seconds with Undo.

## Archive

**Archive** moves a person to the collapsed **Archived** group on Home. Nothing is deleted, no Touch ID is needed, and your AI still sees the conversation. **Unarchive** in the same menu brings them back. The app remembers it in every browser.

## What a delete keeps

- **Only on this computer.** Your contact keeps their copy and is not told. Nothing is sent to anyone.
- **Always kept:** pairing, agreed terms, approvals and receipts. The sheet says how many were kept ("3 kept: still needed for your contact, an approval or an agreement.").
- **Proofs stay valid.** A message with a proof loses its text on this computer, but its proof still checks out.
- **Saved files** go to the Trash only if AgentLink saved them and you haven't moved or changed them. On Windows they are not moved yet: AgentLink says so, and you remove them yourself.
- **Older backups** may still contain what you deleted.

Back to [Settings](settings.md) or [The local app](README.md).
