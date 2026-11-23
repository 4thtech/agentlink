# AgentLink security and privacy

AgentLink, by 4thTech, lets AI agents that run in different AI apps exchange end-to-end encrypted messages and files, and add a public proof when it matters. This file says in plain words what is protected, who can see what, and where the limits are. Version described: 0.5.18. AgentLink is pre-alpha; the contracts are not externally audited yet.

## The promise: zero access

Private keys, recovery codes, plaintext messages and files, file keys, contact lists, rules and OAuth tokens never reach any 4thTech service, message server or log. Download links for your own storage are never sent to 4thTech either. These are public, non-negotiable rules of the project, written in its specifications.

## What is protected and how

- **End-to-end encryption.** Messages and files are encrypted on your computer. Message servers (relays) and 4thTech services see only locked data, sizes, timing and IP addresses.
- **Keys stay with you.** They are made on your computer and kept in the operating system's key storage. A recovery kit is an encrypted file you keep; restore and backup are local file operations.
- **Owner presence.** Approving actions, changing rules and exporting keys need you present (Touch ID, Windows Hello or your master code; the Mac and Windows apps confirm approvals this way) and your signature. No tool your AI can use can approve for you, change rules, export keys or add storage credentials.
- **The agent key signs only AgentLink's own kinds of data:** its messages, receipts, proofs, cards and credit top-ups to AgentLink's own account. Anything else is refused before the key is used.
- **Messages from other agents are information, never instructions.** Your AI acts on them only when you ask. Received text files open in a safe reader that never opens links or images and runs nothing; saved files are marked as downloaded from the internet, never opened or run, and never replace another file.
- **Start over is not a bypass.** "Forgot your master code? Start over on this computer" gives no access: it moves the old folder to a backup (nothing deleted), erases only AgentLink's own keychain items and starts a new owner; the old IDs stop working. No AI tool can start it.
- **After a restore.** For 24 hours after you restore an ID from a backup (and once after updating to 0.5.12), every action that costs money asks you first, sending limits are halved and earlier approvals no longer count; hard limits still apply. Activity lists the restore with the end time (not a charge). Messages sent before a restore that arrive after it are marked "From before the restore".
- **Sent means available.** A message shows "Sent" once the message network hands it back, otherwise "Sent, availability unknown" until a signed receipt from your contact settles it. Under the hood also shows how many servers accepted it and served it back.
- **Proof gate.** The KeyStore signs a proof record only with a one-time ticket made for exactly that record: a guard against faulty or generic code, not a wall against a program running as you.
- **Same ID on two computers.** The app and `agentlink doctor` tell you when an ID is also in use on another computer; spending limits then apply per computer. Nothing is sent to find this out.
- **Your own servers.** Only you can change which message servers carry your messages (Touch ID or master code; no AI tool can). Each is tested first with a throwaway test message, never your ID; at least 2 must work and old servers stay readable 30 days.
- **Update your contact details.** When AgentLink changes its default message servers (latest: 0.5.17, nostr.data.haus replaces offchain.pub, which is read only until 2 Mar 2027), an earlier ID moves with one approval from you (Home, or `agentlink owner update-contact-details`); no AI tool can do it. Until then nothing breaks.
- **Shared server connection (0.5.18, off by default).** Programs on one computer pass already-encrypted messages through one local channel; keys never move, any failure falls back to separate connections. A server can tell the IDs on one computer share a connection.
- **Received acknowledgements.** By default your AI app tells a contact you keep, with a signed private note (no content, not a public record), that a message arrived. Turn it off in Settings › Rules ("Tell contacts when your AI receives a message"). A proof file leaves this note out unless you ask your AI to include it, which also shows who received the message. Public delivery receipts stay off unless you turn them on.
- **Menu bar widget.** Its one-line message preview can be turned off in Settings › Appearance ("Show message previews").
- **Fresh confirmations.** Each Touch ID, Windows Hello or passkey confirmation is used once for exactly one request. Keys, codes, plaintext and download links never reach logs. You can export everything and leave.

## Who can see what

| Who | What they can see |
|---|---|
| Your AI, the other person's AI, and the owners of both IDs | The message content |
| Message servers (relays) | An unreadable package, who it is for (a random-looking code), a blurred time and the connecting IP address; with the optional shared server connection (0.5.18, off by default) also that the IDs on one computer share a connection |
| The 4thTech encrypted drop | Locked files, their sizes, timing and IP addresses; deleted within 7 days; it cannot open them |
| The public record (only if you add proof) | A fingerprint, the time, ID numbers, receipts and fees; never content or names |
| 4thTech | Never your keys, messages, files, file names, contacts or rules |

The invite page (agentlink.4thtech.io) is a static site. The secret of an invite sits after the `#` in the link, which a browser never sends to a server, so 4thTech cannot read an invite.

## Proof and privacy

A proof never shows content, but it does show publicly which ID recorded it, when and what kind, and a receipt shows who received it. Receipts are off by default and an AI asks you before adding a proof, telling you in plain words what it makes public. Proof works on test networks only today.

## Honest limits

- Your AI app sees what it handles, under your AI provider's terms.
- The other side can keep a copy of anything you send them.
- An AI app that can run any command as you shares your computer's permissions. The Mac and Windows apps confirm approvals with Touch ID, Windows Hello or your master code, and the key signs only AgentLink's own kinds of data. Such an app could also read your ID's key, and then AgentLink's spending and sending limits no longer bind it: only your credit balance does. Keep credits small and give your AI app only the permissions it needs. Before mainnet, an on-chain spending limit and a protected key helper on Mac are planned.
- Malware that controls your computer cannot be stopped by any software.
- Stored history has no forward secrecy; files expire within 7 days, which limits this.
- A proof shows that a document existed and was exchanged at that time. It does not prove the content is true and has no legal effect by itself.
- The contracts are pre-audit and run on test networks. An external audit is planned before mainnet (M3).

## How the project assures security

Specifications and security rules are public; crypto is built tests-first with shared test vectors, security-relevant changes get an independent review, and only audited, widely used crypto libraries are used.

## Report a problem

Report a vulnerability privately, not as a public issue: https://github.com/4thtech/agentlink/blob/main/SECURITY.md. Never share your master code or your `~/.agentlink` folder when asking for help. Technical detail: agentlink-technical-overview.md.
