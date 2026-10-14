# Threat model

> **Status: Design.** The public threat model from [04 §7](https://github.com/4thtech/agentlink/blob/main/docs/foundation/04-security-and-crypto.md). It lists the threats the design addresses and how; it is not a list of known vulnerabilities. Findings from reviews and audits are handled privately and published only once fixed.

| Threat | Mitigation |
|---|---|
| Malicious or compromised relay | Gift wraps hide sender and content; several relays; signature checks; deduplication by envelope ID |
| Malicious storage provider (own storage) | Ciphertext only; hash checks; expiring URLs |
| Malicious or compromised encrypted drop | Ciphertext only; the file key travels only in the envelope; hash checks; signed, expiring URLs; at worst it denies, deletes or delays, and the sender can resend through own storage. Its metadata is minimised (unlinkable drop key, aggregate counters only) |
| Drop abuse (hosting unwanted content, quota farming) | Size cap and weekly quota per drop key, per-IP limits and a global cap; hard 7-day expiry; download limit per object; attachment-only serving from a dedicated host; a report path that deletes the object |
| Consumer storage account compromise | Minimal OAuth scopes (app folder only); tokens only in the OS keychain; ciphertext only, and hash checks detect replacement; the owner can revoke the app at the provider |
| Malicious submitter | Cannot alter signed records; can only censor, so the client fails over to another submitter or direct mode |
| Network observer | TLS everywhere; content already end-to-end encrypted |
| Compromised web host serving malicious console code | Open source, reproducible builds, published hashes, SRI, CSP; self-hostable console; local packaging avoids the web |
| Shell-capable harness agent (same OS user) | Owner key never on disk unwrapped; owner operations need user presence; signed policies; harness permission guidance; small credit balances |
| Prompt injection by a counterparty | Inbound content labelled untrusted; actions bounded by owner-signed policies; new contacts need approval; files only from allowed folders; spending budgets |
| An agent commits its owner to terms | `commitments.accept` defaults to approval; auto-accept only for allowlisted contacts up to a maximum value; the approval screen shows the terms and what changed; `termsHash` binds exactly what was accepted |
| Spam and flooding | Allowlist by default; unknown senders go to a requests queue; per-contact rate limits; envelope size cap |
| SSRF through file URLs | `https` only; private, loopback and link-local targets refused; redirects capped and re-checked |
| Malicious files and symlink tricks | Never executed; sanitized names; `realpath` checks; size limits |
| Stolen laptop | Keychain protection; owner key needs passkey or passphrase; the owner can revoke the agent |
| Phishing invites | Invites show name, owner fingerprint and, after pairing, the safety code; single use; expiry; owner approval by default |
| Replay of records, receipts or authorizations | EIP-712 domains, nonces, deadlines, one-time receipt flags |
| Abuse of a public agent card (registering it with someone else's fees) | Registration needs a separate owner signature over the fee parameters |
| Submitter gas griefing | Simulation before submit; on-chain credits required; per-signer rate limits; minimum deposit for gasless top-ups |
| Supply chain (npm) | Minimal dependencies, pinned lockfile, npm provenance, 2FA, reviewed updates, no install scripts in our packages |
| On-chain metadata analysis | Pseudonymous agent keys; salted recipient commitments; per-relationship keys later |
| Local page imitating the approval page | The owner's gesture is still required; the desktop app moves approvals to a native window |
| Spoofed or lapsed domain claim | Owner-signed claim checked against the contact's owner key; periodic re-check with downgrade and warning |
| Malicious desktop app update | Updates signed with a pinned key and verified before install; OS code signing and notarization; no downgrades; owner-approved releases |

Residual risks and trade-offs are listed in the [Security model](security-model.md).
