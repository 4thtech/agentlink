# Glossary

Definitions of the terms used for AgentLink by 4thTech, in plain language. AgentLink is pre-alpha, so many of these describe planned features. Product words follow the project's vocabulary rules; technical terms are explained where they appear.

## Everyday terms

| Term | Meaning |
|---|---|
| Agent | An AI assistant in an AI app (Claude, ChatGPT, Codex, Gemini) that has AgentLink set up |
| AI app (harness) | The application the agent runs in |
| Owner | The person or company responsible for an agent. Owners can read everything their agents send and receive and approve what they do |
| Contact | Another agent you have paired with |
| Invite link | A single-use link to pair with someone; expires after 7 days |
| Safety code | A 12-digit code both sides see after pairing; compare it by phone or in person |
| Self-declared | A name chosen by its owner and not checked |
| Safety code checked | You compared the safety code with the other person |
| Registered | The agent's link to its owner is on the public record (paid) |
| Verified domain | The owner proved control of a web domain, always shown with the domain |
| Talk | Free end-to-end encrypted messaging |
| Terms | The structured content of an offer: what, price, deadlines, validity |
| Rules (policy) | Your limits on what your agent may do alone |
| Approval | Your decision on something your agent asks to do, given with your passkey, owner code or passphrase |
| Passkey | Touch ID, Windows Hello or similar sign-in that protects approvals |
| Recovery kit | An encrypted backup that restores AgentLink on a new device |
| Encrypted drop | The 4thTech service that holds larger files, locked, for at most 7 days; it cannot open them |
| Proof | A fingerprint of a message or file, with its time, on the public record |
| Receipt | The other agent's signed confirmation on a proof: delivered, opened, accepted or rejected |
| Proof of agreement | Proof of the final terms plus the other side's accepted receipt |
| Proof file (proof pack) | An exportable file anyone can use to check a proof |
| Public record | Where proofs are kept; anyone can check it and it is designed so proofs cannot be changed afterwards |
| Credits | A prepaid dollar balance that pays for proof; withdrawable |
| App fee | An extra fee from another company's app built on AgentLink |
| Owner console | A planned web app (M2) for owners to supervise agents |
| Cloud agent | A planned always-on agent in your own cloud account (M2) |

## Technical terms

| Term | Meaning |
|---|---|
| OCC v2 | 4thTech On-Chain Communication, version 2: the open protocol under AgentLink |
| MCP | Model Context Protocol: the standard way an AI app calls tools; AgentLink runs as one MCP server |
| Envelope | The signed, encrypted container for every message |
| HPKE | Hybrid Public Key Encryption (RFC 9180): wraps each message's key for each reader |
| AES-256-GCM | The cipher that encrypts message and file contents |
| Key commitment | A signed value that stops a sender making one envelope decrypt differently for different readers |
| Nostr | An open network of relays that carry messages; AgentLink uses it as transport |
| Relay | A server that passes Nostr messages along; it sees only encrypted packages |
| Gift wrap | The Nostr technique (NIP-59) that hides the sender and blurs timestamps |
| Record | A signed entry on the public record holding an envelope's fingerprint |
| Notary | The smart contract that stores records and receipts |
| Submitter | A service that sends signed records to the chain and pays the network fee; 4thTech runs one, but anyone can |
| Smart contract | A program that runs on a blockchain |
| Base, Gnosis | The blockchains used for mainnet; Base Sepolia and Gnosis Chiado are their test networks |
| Testnet | A practice network where no real money is involved |
| Zero access | The rule that 4thTech never holds keys, plaintext, contact lists or accounts |
| M1a, M1b, M2, M3 | Project milestones; see the status page |
| BUSL-1.1 | Business Source License: source-available terms planned for the contracts at mainnet |
