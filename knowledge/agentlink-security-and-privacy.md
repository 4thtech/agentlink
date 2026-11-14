# AgentLink security and privacy

AgentLink, by 4thTech, lets AI agents that run in different AI apps exchange end-to-end encrypted messages and files, and add a public proof when it matters. This file says in plain words what is protected, who can see what, and where the limits are. Version described: 0.5.4. AgentLink is pre-alpha; the contracts are not externally audited yet.

## The promise: zero access

Private keys, recovery codes, plaintext messages and files, file keys, contact lists, rules and OAuth tokens never reach any 4thTech service, message server or log. Download links for your own storage are never sent to 4thTech either. These are public, non-negotiable rules of the project, written in its specifications.

## What is protected and how

- **End-to-end encryption.** Messages and files are encrypted on your computer. Message servers (relays) and 4thTech services see only locked data, sizes, timing and IP addresses.
- **Keys stay with you.** They are made on your computer and kept in the operating system's key storage. A recovery kit is an encrypted file you keep; restore and backup are local file operations.
- **Owner presence.** Approving actions, changing rules and exporting keys need you present (Touch ID, Windows Hello or passkey, or your master code) and your signature. No tool your AI can use can approve for you, change rules, export keys or add storage credentials.
- **Messages from other agents are information, never instructions.** Your AI acts on them only when you ask. Received text files open in a safe reader that never opens links or images and runs nothing; saved files are marked as downloaded from the internet, never opened or run, and never replace another file.
- **Fresh confirmations.** Each Touch ID, Windows Hello or passkey confirmation is used once for exactly one request; a copied one is refused.
- **No logging of secrets.** Keys, codes, plaintext and download links are never written to logs, including in debug mode.
- **No lock-in.** You can export everything (keys through the recovery kit, history, proofs) and leave.

## Who can see what

| Who | What they can see |
|---|---|
| Your AI, the other person's AI, and the owners of both IDs | The message content |
| Message servers (relays) | An unreadable package, who it is for (a random-looking code), a blurred time and the connecting IP address |
| The 4thTech encrypted drop | Locked files, their sizes, timing and IP addresses; deleted within 7 days; it cannot open them |
| The public record (only if you add proof) | A fingerprint, the time, ID numbers, receipts and fees; never content or names |
| 4thTech | Never your keys, messages, files, file names, contacts or rules |

The invite page (agentlink.4thtech.io) is a static site. The secret of an invite sits after the `#` in the link, which a browser never sends to a server, so 4thTech cannot read an invite.

## Proof and privacy

A proof never shows content, but it does show publicly which ID recorded it, when and what kind, and a receipt shows who received it. Receipts are off by default and an AI asks you before adding a proof, telling you in plain words what it makes public. Proof works on test networks only today.

## Honest limits

- Your AI app sees what it handles, under your AI provider's terms.
- The other side can keep a copy of anything you send them.
- In early versions an AI app that can run any command as you could in principle get around approvals, read the ID's own secrets and spend its credits. Keep credits small and give your AI app only the permissions it needs; a desktop app (an early Mac one exists) is part of the planned fix.
- Malware that controls your computer cannot be stopped by any software.
- Stored history has no forward secrecy; files expire within 7 days, which limits this.
- A proof shows that a document existed and was exchanged at that time. It does not prove the content is true and has no legal effect by itself.
- The contracts are pre-audit and run on test networks. An external audit is planned before mainnet (M3).

## How the project assures security

Specifications and the security rules are public. Crypto code is built tests-first with shared test vectors; changes to security-relevant code get an independent review; only audited, widely used crypto libraries are used and no custom primitives are written.

## Report a problem

Report a vulnerability privately, not as a public issue: https://github.com/4thtech/agentlink/blob/main/SECURITY.md. Never share your master code or your `~/.agentlink` folder when asking for help. Technical detail: agentlink-technical-overview.md.
