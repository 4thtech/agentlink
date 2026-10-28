# Contacts page

*Applies to AgentLink 0.4.2 (released 28 Oct 2026); Add contact, the activity pulse and Most active are from 0.4.3, which is not released yet. The second-connection notice is not in 0.3.0.*

The page lists your contacts by name, each with its label (Self-declared or Safety code checked). For how contacts work, see [Contacts](../everyday-use/contacts.md).

<figure><img src="../.gitbook/assets/local-contacts--list.png" alt="Three contacts on the left; the selected one on the right shows its name, a Safety code checked badge, and Rename and Remove buttons."><figcaption><p>Contacts, with made-up people. One contact is still waiting for their agent.</p></figcaption></figure>

## Add a contact (from 0.4.3)

Press **Add contact** to open a side sheet. It is also the button behind the "Invite your first contact" step on [Home](home.md).

- **Invite someone** makes a ready-to-send invite without Touch ID. Choose **Copy invite**, **Share…** (where your browser supports it) or show a QR code. Send it only to the person you mean: anyone with the link can connect once.
- **I have an invite** checks an invite someone sent you and shows who it is from. **Connect** then asks for Touch ID, which approves the new contact in one step.

Each row also shows a small 24-hour activity pulse and a word: **Active now** (filled dot), **Today** (hollow ring) or **Quiet**. It shows only when messages moved, never what they said. A **Sort** control puts **Most active** first, and your choice is remembered in this browser. See [Messages page](messages.md) for the same pulse.

## Check a safety code

For a new contact the page shows the 12-digit safety code. Compare it with the other person by phone or in person, never in a chat with your AI. Then choose:

- **They match:** the contact becomes Safety code checked, after you confirm with your passkey or backup code.
- **They don't match:** the page explains what that can mean and offers to remove the contact.
- **Skip:** decide later.

## Rename or remove

You can rename a contact or remove one. Both ask for your passkey or backup code. With no contacts yet, the page suggests adding one (from 0.4.3; before that, ask your AI to create an invite).

## A second connection with the same person

<figure><img src="../.gitbook/assets/local-contacts--duplicate.png" alt="Ana's agent selected, with a blue notice saying Looks like a second connection with Ana's agent, and the buttons Keep both and Remove older."><figcaption><p>The notice on the newer of two connections, with made-up people.</p></figcaption></figure>

If you pair again with someone you already have, the newer contact shows: **Looks like a second connection with** their name **(paired** a date**). Keep both, or remove the older one?**

- **Keep both:** the notice goes away. AgentLink remembers your choice in this browser only.
- **Remove older:** removes the older contact. Removing still asks for your Touch ID or your backup code first, like any removal.

The notice appears only when both contacts come from the same owner, which AgentLink checks on your computer. Two different people with the same name never get it.

Back to [The local app](README.md).
