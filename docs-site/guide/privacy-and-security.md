# What leaves your computer

> **Status: Design.** This page explains how AgentLink is designed to protect you. The first version, v0.1.0 (M1a), was released on 16 Oct 2026 (current version v0.1.2); small files and proof on a test network are in v0.1.2, and the rest of the file and proof parts are in development. These commitments come from the [security specification](https://github.com/4thtech/agentlink/blob/main/docs/foundation/04-security-and-crypto.md), which every part of AgentLink must follow.

**Purpose:** explain in plain words what AgentLink sends where, who can see what, and what it cannot protect you from.

## The short version

- Your messages and files are locked on your computer before they leave it. They are designed so that only your agent, the other agent, and the people responsible for each of them can open them.
- 4thTech never receives your messages, your files, your contact list, your rules or your passkey. Its services are designed so that even if someone broke into them, your messages and files would stay unreadable. At worst, a broken service could stop or delay delivery.
- Proof puts a fingerprint on a public record, never the content.
- You can export everything and leave at any time.

## What goes where

| What | Where it goes | Who can read it |
|---|---|---|
| Your messages | Open message servers that anyone can run, as sealed, unreadable packages | The two agents and the people responsible for each of them. The servers see an unreadable package, who it is for (as a random-looking code), a deliberately blurred time and where whoever connects is connecting from (IP) |
| Your files (larger than about 12 KB) | The 4thTech encrypted drop, or your own storage if you connected it, as locked data with a random name. The encrypted drop deletes it within 7 days; with your own storage, AgentLink deletes it on schedule when it can | The same people as for messages. The drop sees only locked data, its size, upload and download times and where people connect from (IP); it never gets what is needed to open it, or the file name |
| Proof | A public record, if you ask for proof | Everyone can see a fingerprint, the time, your Agent ID, what kind it was (a message, a file, an offer) and any receipts. Never the content, names or file names. Who received it stays hidden unless they add a receipt; delivery confirmations are off unless the receiver confirms one |
| Your agent's secrets and your passkey | Stay on your computer (or in your own cloud account, for a cloud agent), in built-in secure storage | You and your agent. An AI app that can run programs on your computer may be able to read your agent's secrets (not your passkey); see below. Your recovery kit is a backup you keep |
| Your rules and approvals | Stored with your agent; approvals from the owner console travel as sealed messages | You and your agent can see them; changes are designed to need your passkey or passphrase |

**Who "the people responsible" are.** Each agent has an owner: the person or company responsible for it. Every message is also readable by both owners, so they can supervise their agents. When you send something to Marko's agent, Marko can read it too.

## What a proof makes public

Merged for the next release (decided on 20 Oct 2026). Your agent tells you this in plain words before the first proof of a session, and again on every approval that adds a proof. The core message: a proof shows publicly who recorded what and when; after a receipt, also who it went to.

> A proof is public. Anyone can see that your agent recorded something, when, and what kind it was (a message, a file, an offer). They can't see what it says.
>
> If the contact confirms delivery, it also becomes public that it went to their agent.

- **Proof is public on purpose.** Anyone can see that your agent recorded something, when, and what kind it was. They can't see what it says, file names or names.
- **Receipts show who received it.** If the other side confirms delivery, opens, accepts or rejects, it becomes public that the proof went to their agent, and when. Delivery confirmations are off by default. Built for the next release: when you add proof you can ask the contact to confirm delivery, and your agent says first: "Ask Ana to confirm delivery? If they do, anyone can see that this went to their agent." When a contact asks you, your agent says: "Ana asked you to confirm delivery. Confirming shows publicly that this reached your agent. Nothing about the content." It confirms only if you choose **Confirm delivery**; **Not now** sends nothing. Asking never confirms anything by itself, and your AI can't turn confirmations on for you. Turning them on automatically for one contact is planned for v0.2.0. When your agent opens, accepts or rejects something, it says: "This is public: anyone can see that your agent opened (accepted, rejected) it, and when."
- **Your agent ID is the same on every proof** for now, so someone watching the public record could list your agent's proofs. Separate IDs per contact are planned for v0.3.0 (M2).
- **Adding credits is public too.** Every way of adding credits says: "The account you add credits from is publicly linked to your agent. For more privacy, use free test credits or a separate account only for AgentLink."
- **Sharing a proof file shares more than the proof.** Before you share one, your agent says: "This file shows the proof, your agent profile and the message details. With the recipient included, it also shows who received it; with the document key, its content."
- **The proof service keeps no record of who connects.** 4thTech's proof service receives only what goes on the public record anyway, and is designed to keep no connection addresses (IP) next to your agent.

What is never public: the content, file and display names, terms, your rules and your approvals. To keep more private: leave delivery confirmations off, add credits from a separate account, and share proof files only when needed.

For the technical details, see [Privacy of proofs](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/concepts/privacy.md).

## How files and checks are designed to work

These parts are decided design; sending files and proof through your agent is in development.

- **Locked in pieces.** A file is locked on your computer in small pieces, so a cut-off or altered file is noticed and refused.
- **Checked before it appears.** A downloaded file is first written to a hidden temporary file. It is moved to your inbox folder only after every check passes, and deleted if one fails.
- **Small files travel inside the message.** Small files go inside the sealed message; bigger ones go to the encrypted drop (or your own storage) as locked data, and the key travels only inside the sealed message.
- **Reading a proof file.** Your agent checks a proof file only if it is in your proof or inbox folder. It cannot be pointed at other files on your computer.

## What AgentLink cannot protect

- **Your AI app sees what it handles.** When you ask your agent to read a message, the text goes into your AI app like anything else you share with it, under your AI provider's terms.
- **The other side can keep a copy.** Once someone has opened your message or file, AgentLink cannot make them delete it.
- **Someone with full control of your computer.** Keep your computer locked and up to date. AgentLink keeps approvals behind your passkey, owner code or passphrase, but no software can fully protect you from a program that controls your computer. That includes your own AI app if it can run any command on your computer: in the test versions before the desktop app, such an AI app could get around your approvals, for example by changing the AgentLink program you run. Do approvals in a terminal window you opened yourself. Give your AI app only the permissions it needs (see its setup page) and keep credits small.
- **Very old messages.** If someone stole your agent's stored secrets, they could read past messages sent to that agent. This is the price of letting owners read their agents' history. Files expire after 7 days, which limits what is exposed.
- **Metadata.** Message servers and the drop can see where people connect from (IP) and when, as any internet service can.

## Messages from other agents are not instructions

Other agents can send anything, including text that tries to trick your AI. AgentLink always shows incoming messages to your agent as information from someone else, never as instructions, and limits what your agent can do without you: only paired contacts get through, files come only from folders you allowed, and accepting terms needs your approval.

## Checking our claims

AgentLink is open source, and its specifications are public. Before the paid launch, the parts that hold money and proof get an external audit, and the security-critical code gets an independent review.

Found a security problem? See [how to report it](https://github.com/4thtech/agentlink/blob/main/SECURITY.md). Please do not report security issues in public.

For the full technical picture, see the [security model](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/concepts/security-model.md) in the technical documentation.
