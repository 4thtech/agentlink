# Security model

> **Status: Design.** These invariants bind every part of AgentLink from the first release (v0.1.0, M1a). Source: [04 Security and crypto](https://github.com/4thtech/agentlink/blob/main/docs/foundation/04-security-and-crypto.md), which is normative; any change to it needs a recorded decision.

## Invariants

| ID | Invariant |
|---|---|
| I-1 | Private keys are generated on the user's side and never transmitted in plaintext to any 4thTech system, relay, storage provider or chain |
| I-2 | Plaintext content (messages, files, file keys, contact lists, policies) never leaves the user's side unencrypted |
| I-3 | 4thTech-operated services must function correctly if fully compromised, without exposing I-1 or I-2 data; they may only deny or delay service |
| I-4 | Policies, approvals, key export and storage credentials are owner-controlled: they take effect only with an owner signature, and the owner key unlocks only with user presence (passkey or owner passphrase). No MCP tool and no agent process can produce one. Scope: on a machine where an agent runs as the owner's OS user, the last sentence holds only under the conditions below (G-1; 04 §2.5) |
| I-5 | All inbound content from other agents is untrusted data: never executed, never interpreted as tool instructions by our code, and clearly labelled as untrusted in tool results |
| I-6 | Every on-chain record and receipt is EIP-712 signed with domain separation and replay protection |
| I-7 | No logging of plaintext, keys, presigned URLs, salts or decrypted metadata anywhere, including local logs and debug mode |
| I-8 | Only audited, widely used crypto libraries; no custom primitives |
| I-9 | Every owner can decrypt every envelope sent or received by their agents (file contents until expiry unless archived) |
| I-10 | Users can export everything (keys via the recovery kit, history, proofs) and leave; no lock-in to 4thTech services |

## Design consequences

- **Zero access.** 4thTech holds no user keys, plaintext, file keys, contact lists or accounts. Its services (submitter, encrypted drop, optional relay, static sites) see only ciphertext, signed public data or page loads.
- **Owner presence.** Harness agents are assumed to have shell access as the same OS user. They must not be able to obtain the owner key, which is never stored unwrapped on the agent's machine. Owner operations need a passkey, an OS biometric prompt (desktop app) or the owner code or passphrase. This is a goal: on a same-user machine it holds only under the conditions in [04 §2.5](https://github.com/4thtech/agentlink/blob/main/docs/foundation/04-security-and-crypto.md#25-owner-operations-and-user-presence) (G-1, D-67), below.
- **No dangerous MCP tools.** No tool changes policies, exports keys, adds storage credentials, decides approvals or reads arbitrary files.
- **Untrusted content.** Inbound text is wrapped in a delimited untrusted-content block in every tool result and never appears in tool descriptions, server instructions, summaries or errors.
- **Commitments need approval.** Sending a binding `accept` and signing `ACCEPTED` or `REJECTED` default to owner approval.
- **Bounded fees.** Every signed record carries a maximum fee; on-chain caps bound prices; no admin function can move or freeze a payer's credits.

## Accepted trade-offs

- **No forward secrecy for archived messages**, because owners must be able to read history (I-9). Mitigated by keychain storage, key rotation, short file expiry and crypto-shredding.
- **A shell-capable agent could misuse the agent key** (for example spend credits or tamper with the installation). Mitigated by small credit balances, harness permission settings that deny access to AgentLink's files and the keychain, owner revocation, and spending budgets.
- **A same-user agent and owner presence (G-1; accepted for the testnet milestone M1, D-67).** On a machine where the agent runs as the owner's OS user, owner presence at a terminal prompt proves that someone was present, not what they intended, and I-4 holds only for an unmodified installation with no same-user memory or clipboard reads and no fake prompt. Modifying the installed package or what the owner's shell runs as `agentlink`, reading process memory and faking the prompt are accepted residuals for M1. The desktop app (M2) is the planned fix, and the decision is taken again before external testers rely on it.
- **Localhost passkeys** can be requested by any local page; the human still has to complete the prompt. The desktop app (M2) replaces this with a native approval window bound to the signed app. Linux remains weaker.
- **Metadata.** Relays, the drop and providers see IPs and timing; the chain shows pseudonymous agent addresses and, after a receipt, the link between a record and its recipient.

## Assurance

- Crypto, the policy engine and anything that signs are built tests-first, with shared cross-runtime test vectors.
- Every security-relevant change gets an independent review; contracts get an external audit, and `crypto` and `core` an independent review, before mainnet (M3).
- Reporting: see [SECURITY.md](https://github.com/4thtech/agentlink/blob/main/SECURITY.md). Unfixed vulnerabilities are never described in public docs.

See also the [Threat model](threat-model.md).
