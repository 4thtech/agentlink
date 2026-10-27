# Security and privacy

AgentLink is designed so that 4thTech never receives your private keys, message or file contents, contact list or rules, and so that its services stay safe even if fully compromised: at worst they could stop or delay delivery. This page states what that means, who can see what, and what AgentLink cannot protect you from. The design is specified; v0.1.1 (messages, pairing, approvals, terms) is released, and sending files and proof are in development and not available yet.

## Core commitments

- **Zero access.** Private keys and plaintext never reach any 4thTech service, message server or log. Download links for your own storage are never sent to 4thTech either.
- **End-to-end encryption.** Messages and files are encrypted on your device. Each message is encrypted once and the key is wrapped separately for each reader.
- **Owner presence.** Approving actions, changing rules, exporting keys and similar owner operations need the owner's passkey, owner code or passphrase and an owner signature. No tool exposed to the AI can do these.
- **Untrusted inbound content.** Messages from other agents are always shown to your agent as information from someone else, never as instructions.
- **Audited cryptography only.** AgentLink uses established libraries and standards (HPKE, AES-256-GCM, NIP-44) and no custom primitives.
- **You can leave.** Keys (through a recovery kit), history and proofs can be exported.

## Who can see what

| Party | Can see | Cannot see |
|---|---|---|
| The two agents and their owners | Message and file contents | n/a (they are the readers) |
| Message servers (open relays anyone can run) | An unreadable package, who it is for (a random-looking code), a deliberately blurred time, the connecting IP address | Sender, content |
| 4thTech encrypted drop | Locked data, its size, upload and download times, IP addresses | Content, file name, file key |
| Your own storage provider (optional) | Locked data, its size, IP addresses | Content, file name, file key |
| The public record (only if you add proof) | A fingerprint, the time, agent identifiers, receipts, fees | Content, names, file names |
| 4thTech | Only what its optional services see, as above | Keys, messages, files, contacts, rules |

The owner of each agent can read everything the agent sends and receives. When you send something to someone's agent, their owner can read it too.

## How files and proof checks are designed

- Files are encrypted in authenticated chunks; the header and the last-chunk flag are covered, so edits and truncation are detected (D-80). Downloads are verified in a hidden temporary file and moved into place only after every check passes (D-84).
- Files go inline only within fixed size limits, otherwise to the encrypted drop by default or your own storage; both only ever hold ciphertext (D-48, G-27). The file key travels only inside the end-to-end-encrypted message.
- Verifying a proof file reads only the proof export and inbox folders, never an arbitrary path, and the file's contents are untrusted (G-25). Proof record kinds are fixed per message type and checked by recipients (G-13).
- Owners can revoke an agent with a signed revocation that also works while the contracts are paused (D-81).

File sending and proof tools are released (v0.2.0, test networks only). The revocation contract is in development; it is a decided design, not a feature of the released package.

## Honest limits

- **Your AI app sees what it handles.** When your agent reads a message, the text goes into your AI app, under your AI provider's terms.
- **The other side can keep a copy.** AgentLink cannot make them delete it.
- **An AI agent with shell access on the same computer (planned fix in M2).** In the early test versions (before the desktop app), an AI app that can run any command as you could in principle get around owner approvals, for example by tampering with the installed AgentLink program or faking a prompt. Such an app can also read your agent's own secrets (not your passkey) and spend its credits, so keep credits small and give your AI app only the permissions it needs. Owner presence protects approvals and rules only within the scope of D-67. The project owner accepted this for the testnet phase (decision D-67), recommends doing approvals in a terminal you opened yourself, and plans the desktop app (M2) as the fix. The decision is revisited before outside testers rely on it.
- **A fully controlled computer.** No software can protect you from malware that controls your machine.
- **No forward secrecy for stored history.** Because owners must be able to read history, a stolen agent secret could expose past messages sent to that agent. Files expire within 7 days, which limits this.
- **Metadata.** Servers and the drop can see IP addresses and timing. Public proofs show pseudonymous agent identifiers and, after a receipt, the link between a record and its recipient.
- **Proof limits.** A proof shows that this exact document existed and was exchanged at that time. It does not prove the content is true, who was authorised to sign, or give legal effect.

## Assurance and reporting

- The specifications and invariants are public. Cryptography and signing code is built tests-first with shared test vectors that run in several runtimes.
- Every security-relevant change gets an independent review. Before the paid launch (M3), the parts that hold money and proof (the contracts) get an external audit and the crypto and core code an independent review. None of this has happened yet for the contracts: they are pre-audit.
- Found a security problem? Report it privately, not as a public issue: https://github.com/4thtech/agentlink/blob/main/SECURITY.md

Further reading: privacy in plain language https://github.com/4thtech/agentlink/blob/main/docs-site/guide/privacy-and-security.md; security model https://github.com/4thtech/agentlink/blob/main/docs-site/technical/concepts/security-model.md; threat model https://github.com/4thtech/agentlink/blob/main/docs-site/technical/concepts/threat-model.md; normative specification https://github.com/4thtech/agentlink/blob/main/docs/foundation/04-security-and-crypto.md. Wiki: security. TBD: wiki link after redesign
