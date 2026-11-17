# Threat model

> **Status: Current for v0.5.10.** The public threat model as shipped in release 0.5.10. Source: [04 §7](https://github.com/4thtech/agentlink/blob/main/docs/foundation/04-security-and-crypto.md#7-threat-model), which is normative. It lists the threats the design addresses and how; it is not a list of known vulnerabilities. Findings from reviews and audits are handled privately ([SECURITY.md](https://github.com/4thtech/agentlink/blob/main/SECURITY.md)) and published only once fixed.

Section references such as (04 §4) point into the source spec. A "Residual" names what remains and what limits it.

## Transport and storage

| Threat | Mitigation |
|---|---|
| **Malicious or compromised relay** | Gift wraps hide sender and content; several relays; signature checks. Deduplication by gift-wrap ID, then by envelope hash after the signature passed, never by the sender-chosen envelope ID (04 §3.5, D-71) |
| **Malicious storage provider** (own storage) | Ciphertext only; hash checks; expiring URLs (04 §4) |
| **Malicious or compromised encrypted drop** | Ciphertext only; the file key travels only in the end-to-end-encrypted envelope; both hashes checked; signed, expiring URLs. At worst it denies, deletes or delays (I-3), and the sender can resend through own storage. Its metadata is minimised: an unlinkable drop key and aggregate counters only (04 §4, D-48) |
| **Drop abuse / free storage misuse** (hosting unwanted content, quota farming) | Size cap and weekly quota per drop key, per-IP limits and a global cap; hard 7-day expiry; download limit per object; attachment-only serving from a dedicated host; a report path that deletes the object (04 §4) |
| **Consumer storage account compromise or over-broad OAuth scope** | Minimal scopes (app folder or app-created files); tokens only in the OS keychain, never sent to 4thTech or logged; ciphertext only, and hash checks detect replacement; the owner can revoke the app at the provider (D-49, 07 §5.5) |
| **Malicious submitter** | Cannot alter signed records; can only censor, so the client fails over to another submitter or direct mode |
| **Network observer** | TLS everywhere; content already end-to-end encrypted |

## Counterparties and content

| Threat | Mitigation |
|---|---|
| **Malicious sender equivocates across recipients** | A key commitment is checked before decrypting; every opener recomputes the wraps it can check, its own owner's always; the proof-pack verifier checks it too (04 §3.3, G-46). Residual: an entry whose key the opener does not hold cannot be checked |
| **Malicious counterparty: prompt injection** | Inbound content labelled untrusted (I-5); actions bounded by owner-signed policies; new contacts need owner approval by default; files only from allowed folders; spending budgets |
| **Malicious counterparty: spam / flooding** | Allowlist by default; unknown senders go to a requests queue with per-key and total limits. Refusals expire after 7 days, and the owner can ignore one sender, clear the queue or block a key at any time (D-72); per-contact rate limits; envelope size cap (07 §3.2) |
| **Malicious counterparty: SSRF via file or relay URLs** | `https` only; private, loopback and link-local targets refused; redirects capped and re-checked; relay URLs checked at parse and at connect (04 §4) |
| **Malicious files / symlink tricks** | Never executed; sanitized names; real-path checks; size limits (04 §4) |
| **Contact floods the disk or plants files through auto-save** | Only from paired, allowed contacts that are not blocked, removed or revoked; daily file and size limits per contact and per ID; 1 GiB kept free; "Ask before saving" per contact and a global off switch; quarantine mark; never opened or made executable; no overwrite (04 §4.1, D-142) |
| **Agent commits its owner to terms** | `commitments.accept` defaults to approval (D-31); auto-accept only for allowlisted contacts, in the direction and within the limits the owner chose; the approval card shows the terms and what changed; `termsHash` binds exactly what was accepted; the agent cannot supply the accepted terms (04 §3.4.2, D-55) |
| **Reuse or replay of a commitment approval** | One approval binds one commitment scope (contact, thread, answered envelope and its hash, `termsHash`, decision, fee cap, expiry); each part runs once and any change voids it; on-chain nonces and one-time receipt flags (I-6); the owner can cancel unused parts (04 §3.4.2) |
| **Message previews in the menu bar widget** | Built by the server: plain text, one line, at most 80 characters, control and direction characters removed; shown as text only, never as markup or links. "Show message previews" makes the server omit them. Never in the icon, tooltip, pipe, OS notifications, title or logs (I-5, I-7). The widget is read-only (08 §8, D-155). Residual: a glanceable surface can be read over a shoulder; the switch is the answer |
| **Forged, misattributed or replayed "received" acknowledgement** | The ack is bound to the envelope hash; the sender counts it only from the contact the envelope went to, with a signature valid at that contact's key epoch, and only when the hash matches. Acks go only to active, paired contacts. An older app's ID-only ack shows as "Received (older app)" and never makes a proof "Delivered"; on-chain receipts stay separate and opt-in (D-109). A random delay, minute-rounded time and `receipts.sendReceived` bound what it discloses; a proof pack carries it only when the owner asks at export, and it then names the recipient (04 §3.4, D-156) |

## Local machine and owner presence

| Threat | Mitigation |
|---|---|
| **Shell-capable harness agent (same OS user)** | Owner key never on disk unwrapped; owner operations need presence (Touch ID, Windows Hello, passkey or master code); signed policies; harness permission guidance; small credit balances (04 §2.5). Residual: a process that modifies the installation or reads process memory is outside I-4's guarantee (G-1, D-67) |
| **Budget ledger tampering or clock moves** | The budget check and fee reservation run in one transaction; a missing or unreadable ledger, or a clock behind the newest entry, makes every paid action need approval (06 §3, G-7). Residual: a same-user process can weaken the local daily window; the per-action cap, small balances and visible on-chain charges limit it |
| **Stolen laptop** | Keychain protection (OS login); owner key needs presence; the owner can revoke the agent (revocation envelope, and on-chain revoke if registered) |
| **Leaked file KeyStore on a headless machine** | Opt-in only, after a warning; Argon2id and AES-256-GCM; a generated unlock code by default; strict file modes and real-path checks; the owner key is never unlocked non-interactively, so a leak exposes the agent key only (04 §2.8, D-54). Residual: a passphrase stored on the same disk adds no at-rest protection beyond disk encryption |
| **Local page imitating the approval page** (shared `localhost` passkey) | The owner's gesture is still required. The desktop app uses OS-drawn Touch ID and Windows Hello prompts instead of a localhost passkey; signed builds bind the owner key to a fixed-identity owner process (04 §2.5, D-145 (3)) |
| **Agent key asked to sign foreign typed data** | The agent `KeyStore` signs only AgentLink's own EIP-712 shapes (OCC v2 records and receipts for an allowlisted chain and contract, agent cards, the credits top-up with a fixed recipient, allowlisted token and value cap). Anything else is refused before key material is loaded, in every backend. Owner signing is unchanged (04 §3.1.1, D-156) |

## Pairing and identity

| Threat | Mitigation |
|---|---|
| **Phishing invites** | Invites show the name, label, ID tag and expiry; the Contact check follows pairing; single use; expiry; owner approval by default (04 §3.6) |
| **Short invite links on the drop** | The drop stores only invite ciphertext under a one-way lookup ID; the key stays in the URL fragment and is never sent to 4thTech or logged; fixed fetch host, no redirects, size cap. A compromised drop can deny but not read or substitute an invite (04 §3.6.2, D-139). Residual: the drop can tell that two addresses paired; the long link avoids it |
| **Unauthenticated report deletes an invite object** | Deny-only: the recipient sees "no longer available" and the inviter makes a new invite; nothing is revealed or substituted; 128-bit IDs; reports rate-limited per IP (07 §5.4, D-139) |
| **Flooding of the unauthenticated invite fetch** | 128-bit IDs (no enumeration); per-IP and global fetch limits; per-object download limit; a uniform `404`; uploads need a signed drop request (07 §5.4, D-139) |
| **Swapped or copied invite (MITM at pairing)** | Commit-then-reveal Contact check, 12 digits, compared by the owners on their own screens, never relayed by an AI; "checked" only through an owner-signed `contact.check`; a second answer to an invite is reported to the inviter (04 §3.6.1) |
| **Agent ID claimed by another owner's card, or a replayed card** | The card signature binds the agent key to the owner; handshakes accepted only from the card's key; one contact per agent ID; a re-pair takes effect only on completion and with unchanged owner keys (04 §2.9) |
| **Local edit of the displayed safety code** (the Contact check digits) | The digits are recomputed on every display from the peer-signed handshake, never read from a stored value; `contact.check` signs the recomputed digest (04 §3.6.1). Residual: a modified installation controls what that machine shows (G-1) |
| **Spoofed or lapsed domain claim** | Owner-signed claim checked against the contact's owner key; periodic re-check with downgrade and warning; exact domain shown; SSRF rules on `.well-known` fetches (04 §2.7) |

## On-chain and payments

| Threat | Mitigation |
|---|---|
| **Replay of records / receipts / authorizations** | EIP-712 domains, nonces, deadlines, one-time receipt flags; EIP-3009 nonces (I-6) |
| **Abuse of a public agent card** (registering it with someone else's fees) | Registration needs a separate owner signature over the fee parameters (05 §4) |
| **Submitter gas griefing** | Simulation before submit; on-chain credits required; per-signer rate limits; minimum deposit for gasless top-ups |
| **On-chain metadata analysis** | Pseudonymous agent keys; salted recipient commitments; per-relationship keys later (04 §5.1, D-109) |

## Cloud agent

| Threat | Mitigation |
|---|---|
| **Compromised cloud-agent template or update** | Template releases only from a release tag after the owner's click; pinned versions with provenance; CSP and SRI on owner pages; a reproducible owner-page bundle whose hash `/status` shows (D-131, D-52). Residual: whoever can deploy code to the user's Worker controls its owner pages |
| **Compromised 4thTech guide page that generates the button's secrets** | Static page, one first-party script, no third-party scripts or analytics, SRI and a CSP that blocks all connections; reproducible build with published hashes; the desktop path needs no page (D-131 (9)). Residual: the same class as a compromised console host |
| **Cloudflare account compromise** | The guide asks for two-factor sign-in; small credits; the owner deploys a new agent and pairs again (D-131). Residual: control of the account controls the agent |
| **Cloudflare as the user's processor** | Disclosed in the guide: the agent runs in the user's own Cloudflare account, and 4thTech never sees it (D-131) |
| **Setup race on a guessable `workers.dev` name** | `/setup` needs the setup code, works once and is refused once an owner exists; CI tests the claim (04 §2.5, D-131) |
| **OAuth token theft or an over-broad grant** | PKCE S256; short access tokens, rotating refresh tokens, grants that expire after at most 30 days; tested redirect hosts; one fixed tool scope; every grant needs an owner-signed `connector.authorize`, checked on every request; owner operations never accept a token (I-4, D-131) |
| **Malicious client registration** | Registering grants nothing: every grant needs the owner's gesture on a sign-in page that names the app and its redirect host |
| **Look-alike approval link** | Approval links come only from our tool results, never from inbound content (I-5); the passkey works only on the exact Worker host; the page shows the agent's name and owner fingerprint |
| **OAuth library's own crypto** | Allowed only in the cloud agent, for OAuth data only, never keys or content; platform WebCrypto only; unused features off and tested off; exact pinned version; independent audit of the integration (D-131 (11)) |
| **Denial of wallet** (floods that raise the user's Cloudflare bill) | Unknown-sender queue limits, per-IP limits on `/mcp` and the OAuth endpoints, alarm-only sync, the expected monthly cost in the guide |

## Desktop app and updates

| Threat | Mitigation |
|---|---|
| **Malicious desktop app update** | One update key, its public half pinned in the app; the private key used by one CI step only after the owner's approval click in a protected environment (D-151). Strictly parsed manifest with domain tag, channel, platform, version, minimum version and expiry; host allowlist; no downgrade; bytes checked against hash and size; built only from attested release assets (D-128, D-145). Residual: the release process and its key are trusted, as for npm `latest` |
| **Changed staged bundle during the in-app update** (Mac) | The staged app is checked against the signed manifest and its own hashes, and checked again on "Restart now" (04 §7). Residual for unsigned builds: adds nothing over a same-user process changing the installed app directly; signed builds close it |
| **Changed setup during the Windows in-app update** | The setup is checked against the signed manifest after download and after "Restart now", made read-only and its file identity re-checked before and while it runs; a mismatch is never run (04 §7). Residual for unsigned builds: the same class as the Mac row |
| **Same-user process drives the desktop app** (debug port, inspector, injected switches) | Fuses read back by CI; exit on any switch outside a small allowlist; preview mode compiled out; a sandboxed, origin-locked window with an in-memory session (08 §8, D-145 (4)). Residual while unsigned: the installed app can be modified like any user-writable program (G-1) |
| **Crafted `agentlink://` link** | Only `agentlink://join#…` is read, rebuilt canonically and pattern-checked; kept in memory, never logged; accepting needs presence (08 §8, D-145 (7)) |
| **Tampered Electron or Node binary in the build** | Per-asset SHA-256 committed in the repo and checked before use; upstream signatures kept; no `electron` package or install scripts; Electron security fixes within 7 days (D-145 (1)) |
| **Compromised 4thTech web host serving malicious console JS** | Open source, reproducible builds, published hashes, SRI, CSP; self-hostable console; the desktop app and local packaging avoid the web. Residual: whoever serves the page controls it, so verify hashes or run locally |

## Supply chain

| Threat | Mitigation |
|---|---|
| **Supply chain (npm)** | Minimal dependencies, pinned lockfile, npm provenance, 2FA, reviewed updates, no install scripts in our packages; npm `latest` needs the owner's approval (D-52) |

Residual risks and trade-offs are summarised in the [Security model](security-model.md).
