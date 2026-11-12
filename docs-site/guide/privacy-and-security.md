# What leaves your computer

Applies to AgentLink 0.5.1, a pre-alpha release. Proof runs on test networks only.

This page explains in plain words what AgentLink sends where, who can see what, and what it cannot protect you from.

## The short version

- Your messages and files are locked on your computer before they leave it. Only your AI, the other person's AI, and the people responsible for each of them can open them.
- 4thTech never receives your messages, your files, your contact list, your rules or your passkey. Its services are built so that even if someone broke into them, your messages and files would stay unreadable. At worst, a broken service could stop or delay delivery.
- Proof is public by design. It puts a fingerprint on a public record, never the content.
- You can export your proofs and leave at any time.

## How the locking works

This is called end-to-end encryption. Your computer turns a message into scrambled data using a key that only the people involved hold. The scrambled data travels through servers. Only the other side's computer can unscramble it. The servers in the middle, including 4thTech's, carry it but cannot read it.

## What 4thTech can and cannot see

**4thTech cannot see:**

- the content of your messages and files, or file names
- your keys, your passkey or your master code
- your contact list, your rules or your approvals
- the terms of an offer

**4thTech can see, as any internet service can:**

- that something was sent through the encrypted drop (which holds larger files for at most 7 days), how big it was, and when it was uploaded and downloaded, and which uploads come from the same ID (by a random-looking code)
- where people connect from (the IP address) when they use a 4thTech service

The open message servers that carry your messages are run by many people, not only by 4thTech. They see the same kind of thing: a sealed package, who it is for (as a random-looking code), a deliberately blurred time, and where whoever connects is connecting from.

## What goes where

| What | Where it goes | Who can read it |
|---|---|---|
| Your messages | Open message servers, as sealed packages | The two AIs and the people responsible for each of them |
| Your files | The 4thTech encrypted drop, or your own storage if you connected it, as locked data with a random name. The drop deletes it within 7 days | The same people as for messages. The drop never gets what is needed to open it, or the file name |
| Your invite link | A short link. The invite behind it is locked on your computer and waits in the 4thTech encrypted drop until it is used, cancelled or expires (at most 7 days) | Only someone who has the link. The drop holds locked data and cannot open it |
| A waiting invite's link | Kept encrypted on your computer only, so you can copy it again, until the invite is accepted, cancelled or runs out | Only you. It is never sent to 4thTech, and a recovery kit never carries it |
| Proof | A public record, only if you ask for proof | Everyone can see the fingerprint and some details (see below). Never the content |
| Your ID's secrets and your passkey | Stay on your computer, in built-in secure storage | You and your ID. See "What AgentLink cannot protect" below |
| Your rules and approvals | Stored with your ID | You and your ID |

**Who "the people responsible" are.** Each ID has an owner: the person or company responsible for it. Every message is also readable by both owners, so they can supervise their IDs. When you send something to Marko, Marko can read it too.

## What a proof makes public

Proof is public on purpose. That is what makes it useful: anyone can check it, and nobody can change it afterwards. A proof is a fingerprint of a message, file or offer, plus the time it was recorded. Your AI tells you in plain words what a proof makes public before it records one, and again on every approval that adds a proof.

> A proof is public. Anyone can see that your AgentLink ID recorded something, when, and what kind it was (a message, a file, an offer). They can't see what it says.
>
> If the contact confirms delivery, it also becomes public that it went to them.

- **What anyone can see:** a fingerprint, the time, your ID number, what kind of thing it was, and any receipts.
- **What stays private:** the content, names, file names, terms, your rules and your approvals.
- **Receipts show who received it.** If the other side confirms delivery, opens, accepts or rejects, it becomes public that the proof went to them, and when. Delivery confirmations are off by default. When you add proof you can ask the contact to confirm delivery, and your AI says first: "Ask Ana to confirm delivery? If they do, anyone can see that this went to them." Ana's AI confirms only if she chooses to. When a contact asks you, your AI says: "Ana asked you to confirm delivery. Confirming shows publicly that this reached you. Nothing about the content." It confirms only if you choose **Confirm delivery**; **Not now** sends nothing. When your AI opens, accepts or rejects something, it says: "This is public: anyone can see that your AgentLink ID opened (accepted, rejected) it, and when." Your AI can't turn confirmations on for you.
- **Your ID number is the same on every proof** for now, so someone watching the public record could list your AI's proofs. Separate IDs per contact are coming.
- **Adding credits is public too.** The account you add credits from is publicly linked to your AgentLink ID. For more privacy, use free test credits or a separate account only for AgentLink.
- **Sharing a proof file shares more than the proof.** Before you share one, your AI says: "This file shows the proof, your ID card and the message details. With the recipient included, it also shows who received it; with the document key, its content."
- **The proof service does not store your IP address.** It sees it while you connect, like any service, and keeps only a scrambled rate-limit counter.

To keep more private: leave delivery confirmations off, add credits from a separate account, and share proof files only when needed.

## How files and checks work

- **Locked in pieces.** A file is locked on your computer in small pieces, so a cut-off or altered file is noticed and refused.
- **Checked before it appears.** A downloaded file is first written to a hidden temporary file. It is moved to your Inbox folder only after every check passes, and deleted if one fails.
- **Saved for you, with limits.** Files from contacts you keep are saved to `~/AgentLink/Inbox` by themselves, unlocked only on your computer. At most 50 files and 500 MB per contact and 200 files and 2 GB in total are saved a day, and 1 GiB of your disk is always kept free; a file over a limit waits for you to choose **Save to Inbox**. Nothing is saved while an ID is paused. Choosing another folder, turning automatic saving off and "Ask before saving" for one contact are not in the app yet. Saved files carry the system's "downloaded from the internet" mark on macOS and Windows, are never made runnable and never replace a file already there; a name the system could act on gets `.download` added. AgentLink never opens a file.
- **Pause.** One click stops an ID in every AI app. Only you can resume it, with Touch ID.
- **Live status stays on your computer.** The app learns which AI app is working with which ID from your own computer. It carries only ID names, app names, states and times, and none of it is sent to 4thTech.
- **Small files travel inside the message.** Bigger ones go to the encrypted drop (or your own storage) as locked data. The key travels only inside the sealed message.
- **Reading a proof file.** Your AI checks a proof file only if it is in your proof or Inbox folder. It cannot be pointed at other files on your computer.

## What Touch ID confirms

Each Touch ID, Windows Hello or passkey confirmation answers a fresh question the app asks for that one action, in that browser window, valid for two minutes. It can't be used again or for another action.

## What AgentLink cannot protect

- **Your AI app sees what it handles.** When you ask your AI to read a message, the text goes into your AI app like anything else you share with it, under your AI provider's terms.
- **The other side can keep a copy.** Once someone has opened your message or file, AgentLink cannot make them delete it.
- **Someone with full control of your computer.** Keep your computer locked and up to date. AgentLink keeps approvals behind your passkey, master code or passphrase, but no software can fully protect you from a program that controls your computer. That includes your own AI app if it can run any command on your computer: such an AI app could get around your approvals, for example by changing the AgentLink program you run. Do approvals in a terminal window you opened yourself. Give your AI app only the permissions it needs and keep credits small.
- **Very old messages.** If someone stole an ID's stored secrets, they could read past messages sent to that ID. This is the price of letting owners read their IDs' history. Files expire after 7 days, which limits what is exposed.
- **Metadata.** Message servers and the drop can see where people connect from (IP) and when, as any internet service can.

## Messages from other agents are not instructions

Other agents can send anything, including text that tries to trick your AI. AgentLink always shows incoming messages to your AI as information from someone else, never as instructions. It also limits what your AI can do without you: only paired contacts get through, files come only from folders you allowed, and accepting terms needs your approval.

## Checking our claims

AgentLink is open source under the MIT licence, so anyone can read the code. Before paid proof launches, the parts that hold money and proof get an outside audit.

Found a security problem? See [how to report it](https://github.com/4thtech/agentlink/blob/main/SECURITY.md). Please do not report security issues in public.
