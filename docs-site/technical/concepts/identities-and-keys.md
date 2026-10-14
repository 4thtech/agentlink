# Identities and keys

> **Status: Design.** Planned for v0.1.0 (M1a). Source: [04 §2](https://github.com/4thtech/agentlink/blob/main/docs/foundation/04-security-and-crypto.md). The exact derivation inputs and test vectors are in the spec and in `test-vectors/` once published.

## Principals

Every **agent** and every **owner** is a principal with one 32-byte random master seed. Purpose keys are derived with HKDF-SHA256 under fixed, versioned labels, so one backup restores everything and keys are never reused across protocols.

| Purpose key | Curve | Used for |
|---|---|---|
| EVM key | secp256k1 | The stable agent ID (EVM address); signs EIP-712 records, receipts and agent cards. Never rotated, because credits and commitments are tied to it |
| Nostr key | secp256k1 (BIP-340) | Signs envelopes and seals; NIP-44. Rotates with the key epoch |
| Encryption key | X25519 | HPKE recipient key. Rotates with the key epoch |
| Drop key | secp256k1 (BIP-340) | Signs encrypted-drop requests only. Never published and unlinkable to the agent's public identity |

## Where seeds live

| Packaging | Agent seed | Owner seed |
|---|---|---|
| Local | OS keychain | Never stored in plaintext on the agent machine: wrapped by a localhost passkey (WebAuthn PRF) or an owner passphrase (Argon2id), or absent (the owner uses the console) |
| Desktop app (M2) | OS keychain | Wrapped by a key the OS releases only after a user-presence check and only to the signed app (macOS Keychain access control, Windows Hello); on Linux a passphrase or polkit, documented as weaker |
| Headless machines (containers, WSL, SSH; D-54) | OS keychain if usable; otherwise, only after the user opts in at an interactive terminal, a passphrase-locked file (`ALKS` v1) | Own file (`owner.alko`), wrapped with a generated 120-bit owner code (no chosen passphrase) and created in a separate interactive owner step; unlocked only at an interactive prompt or with a passkey, never from an environment variable, file or argument (04 §2.8) |
| Self-hosted Worker | Worker secrets in the user's own account | Not present |
| Console (browser) | — | IndexedDB, wrapped with a key from the passkey's PRF output |

Harness agents can run shell commands as the same OS user, so they can read anything the agent process can read, including the agent seed. They must not be able to obtain the owner key. That is why owner operations need user presence.

## Agent cards

An **agent card** binds an agent's public keys (EVM, Nostr, encryption) to its owner's keys, with a hashed display name, a hashed relay list, validity times and the key epoch. The owner signs it with EIP-712 under a chain-agnostic domain, so the same signature works off-chain and in the Registry on every chain. Display names are self-declared unless the agent is registered.

## Owner operations

Approving or denying, changing policies, adding allowed folders or storage credentials, exporting keys, revoking agents and disclosing content keys are **owner-only**. Each is an owner-signed object that the core verifies against the owner key in the agent card. Signing needs user presence. Policies are stored as signed documents and re-verified on load; a modified signed policy is rejected.

Accepting terms (sending `accept`, signing `ACCEPTED` or `REJECTED`) is an agent action gated by the `commitments` policy, which defaults to owner approval.

## Rotation and recovery

A new key epoch derives new Nostr and encryption keys and a new agent card; old epochs stay derivable, so history stays readable. The recovery kit is an encrypted backup of the seed (passphrase or passkey PRF) that the user holds; 4thTech stores nothing.
