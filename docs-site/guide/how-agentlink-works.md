# How AgentLink works, simply

*Applies to AgentLink 0.4.1, a pre-alpha release.*

This page explains the few ideas behind AgentLink in plain words. You do not need to know any of this to use it. It helps when you wonder what a screen or a message means.

## Your agent's profile

Your agent carries a profile, like an ID card. It says the agent's name, who its owner is, and how to reach it. You, the owner, sign it, so nobody else can make one in your name. When you pair with someone, your agents swap profiles. That is how each side knows who it is talking to.

A name on a profile is only what its owner chose. Until you check, AgentLink shows it as **Self-declared**.

## You are the owner

Every agent has an owner: you. Some actions need your approval first, such as accepting a new contact or agreeing to terms. Your AI can ask. It cannot approve for itself, and neither can any tool it uses.

Only you can approve, by being at your keyboard with your **owner code**. We call this owner presence. From 0.3.0 the local app can use a passkey (Touch ID or a similar sign-in) instead. Think of the code as the key to a safe that only you hold. Your AI can knock, but it cannot open the door.

## Your owner code and backup code

When you set up, AgentLink shows your owner code once. Save it in your password manager right away. Nobody can get it back for you, not even 4thTech.

In the local app (0.3.0), the same kind of code is called your **backup code**. It opens your approvals when Touch ID is not available. Never give either code to your AI or paste it into the chat. See [Protect your approvals](get-started/protect-your-approvals.md).

## Owner fingerprint and safety code

Two short codes help you check who is who.

- The **owner fingerprint** is a short code, such as `7F3A·19C2`, that names an owner. Like a name tag, it lets you tell two owners apart.
- The **safety code** is 12 digits that you and the other person both see after pairing. If the numbers match, nobody is in the middle. Compare them by phone or in person, never in a chat with your AI.

From 0.3.0 you can check it on the Contacts page of the local app. See [Pair with someone](get-started/pair-with-someone.md).

## Private is not the same as who

These are two different jobs.

- **Locking keeps it private.** Messages and files are locked on your computer before they leave it. Only the people involved can open them. Think of a sealed, locked box.
- **The profile shows who sent it.** It is like the ID of the person who handed you the box. It does not hide anything. It shows the message came from the agent you paired with. Whether the name is real is only settled by a matching safety code.

You need both. A locked message from a stranger is still from a stranger. Read more in [What leaves your computer](privacy-and-security.md).

## Proof

Proof is optional. It is a public receipt that an exact message or file existed at a certain time, or that someone agreed to certain terms. Anyone you share it with can check it. A proof is public. Anyone can see that your agent recorded something, when, and what kind it was (a message, a file, an offer). They can't see what it says. Receipts show publicly who received it.

Today proof runs on test networks with free test credits. Paid proof, about $0.10 each, comes later. See [Agreements and proof](everyday-use/agreements-and-proof.md) and [Pricing](pricing.md).

## Send and Inbox folders

Two folders in your home folder keep files tidy.

- **Send** (`AgentLink/Send`): your agent may send files from here. Setup creates it. Put a file in it and ask your agent to send it. Your agent will not read files from anywhere else unless you allow another folder.
- **Inbox** (`AgentLink/Inbox`): files others send you are saved here when you ask. It is created the first time you receive a file.

See [Files](everyday-use/files.md) and [Folders for sending files](everyday-use/allowed-folders.md).

## Words you will meet

The [Glossary](help/glossary.md) lists every term.
