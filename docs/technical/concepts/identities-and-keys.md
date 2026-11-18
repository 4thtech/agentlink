# Identities and keys

<!-- ai-knowledge: summary
summary: How identities and keys work: principals and master seeds, where seeds live, the signed cards that tie an ID to its owner, owner operations and browser support for approval passkeys. For developers and security readers. -->

> **Status: Current for v0.5.10.** Keys and agent cards shipped in v0.1.0; owner presence in the desktop app and the agent-key signing allowlist are described as of 0.5.10. Source: [04 §2](https://github.com/4thtech/agentlink/blob/main/specs/04-security-and-crypto.md). The exact derivation inputs are in the spec, and test vectors in [`test-vectors/`](https://github.com/4thtech/agentlink/tree/main/test-vectors).

## Principals

Every **agent** and every **owner** is a principal with one 32-byte random master seed. Purpose keys are derived with HKDF-SHA256 under fixed, versioned labels, so one backup restores everything and keys are never reused across protocols.

| Purpose key | Curve | Used for |
|---|---|---|
| EVM key | secp256k1 | The stable agent ID (EVM address); signs only AgentLink's own EIP-712 shapes (see below). Never rotated, because credits and commitments are tied to it |
| Nostr key | secp256k1 (BIP-340) | Signs envelopes and seals; NIP-44. Rotates with the key epoch |
| Encryption key | X25519 | HPKE recipient key. Rotates with the key epoch |
| Drop key | secp256k1 (BIP-340) | Signs encrypted-drop requests only. Never published and unlinkable to the agent's public identity, so the drop cannot link uploads to an agent |

### Drop-request signing

The drop key signs through the `KeyStore` and nowhere else: `KeyStore.signDropRequest(request, createdAt)` returns the `Authorization` header for one encrypted-drop request (07 §5.4; M1-1g-e). The KeyStore builds the signed event itself, so the caller cannot turn it into a general signer:

- the event kind (27235), the empty content and the `domain` tag `agentlink/v1/drop` are fixed inside; the caller passes only the method, URL and body;
- only `POST` and `DELETE`, to an `https` URL in its serialised form, without credentials or fragment (the drop compares the URL exactly);
- the body must be the drop's signed JSON (at most 1024 bytes, `v: 1`, a 16-byte nonce and `ts`), and `createdAt` must equal its `ts`;
- it signs with the drop key of the current key epoch, never the Nostr or EVM identity key, and an owner session has no drop signer at all;
- anything else is refused with one fixed error that names no input, before any key is read. The result is header text only: no key bytes.

### Agent key signing allowlist (0.5.10)

Since 0.5.10 (D-156) the agent `KeyStore` signs EIP-712 typed data only in AgentLink's own shapes: OCC v2 records and receipts for an allowlisted chain and contract, agent cards, and the credits top-up authorization with a fixed recipient (that chain's AgentLink vault), an allowlisted token and a value cap. Anything else is refused with a fixed error before any key material is loaded, in every `KeyStore` backend (04 §3.1.1). Owner signing is separate and needs presence.

## Where seeds live

| Packaging | Agent seed | Owner seed |
|---|---|---|
| Local (browser app, CLI) | OS keychain | Never stored in plaintext on the agent machine: a keychain item wrapped under a generated 120-bit master code by default, or a chosen owner passphrase as an explicit opt-in (Argon2id, D-67); also by a passkey (WebAuthn PRF) in the browser app |
| Desktop app, Mac and Windows (D-145) | OS keychain, the same items as the browser app | As in the browser app under the master code, and also wrapped (`ALKH`, 04 §2.3.4) under a secret that the app's native helper releases only after Touch ID (a Secure Enclave key) or Windows Hello (a TPM-backed key). Planned with signed builds: a fixed-identity owner process as the only reader. Linux (planned): passphrase or master code, documented as weaker |
| Headless machines (containers, WSL, SSH; D-54) | OS keychain if usable; otherwise, only after the user opts in at an interactive terminal, a passphrase-locked file (`ALKS` v1) | Own file (`owner.alko`), wrapped with a generated 120-bit master code (no chosen passphrase) and created in a separate interactive owner step; unlocked only at an interactive prompt or with a passkey, never from an environment variable, file or argument (04 §2.8) |
| Self-hosted Worker (planned, 0.6.0) | Worker secrets in the user's own account | Not present unwrapped |
| Owner console (planned, M2) | — | IndexedDB, wrapped with a key from the passkey's PRF output |

Harness agents can run shell commands as the same OS user, so they can read anything the agent process can read, including the agent seed. They must not be able to obtain the owner key. That is why owner operations need user presence.

## Agent cards

An **agent card** binds an agent's public keys (EVM, Nostr, encryption) to its owner's keys, with a hashed display name, a hashed relay list, validity times and the key epoch. The owner signs it with EIP-712 under a chain-agnostic domain, so the same signature works off-chain and in the Registry on every chain. Display names are self-declared unless the agent is registered.

## Owner operations

Approving or denying, changing policies, adding allowed folders or storage credentials, exporting keys, revoking agents and disclosing content keys are **owner-only**. Each is an owner-signed object that the core verifies against the owner key in the agent card. Signing needs the owner's presence: Touch ID, Windows Hello or the master code in the desktop app, a passkey or the master code in a browser, the owner passphrase or code typed at a terminal (04 §2.5). Each gesture or entry covers one owner operation. Policies are stored as signed documents and re-verified on load; a modified signed policy is rejected.

Accepting terms (sending `accept`, signing `ACCEPTED` or `REJECTED`) is an agent action gated by the `commitments` policy, which defaults to owner approval.

## Browser support for approval passkeys

This applies to the browser app only: the desktop app's window has WebAuthn switched off and uses Touch ID, Windows Hello or the master code.

From the 0.3.0 first run (D-130), the local approval page on `http://localhost:<port>` (rpId `localhost`) registers a passkey with the WebAuthn PRF extension and uses it to unwrap the owner key (04 §2.5; M1-8e). `localhost` counts as a secure context in Chromium, Safari and Firefox, so WebAuthn works there without HTTPS. PRF is the limiting part: the browser, the operating system and the passkey provider must all support it. This table is research from public sources read on 25 Oct 2026 (MDN, WebKit bug tracker, Firefox release notes and Mozilla bug tracker, a Corbado PRF support survey); vendor release notes did not state it directly, so every cell stays **to test** until checked on a real machine.

| Browser | macOS (Touch ID) | Windows (Hello) |
|---|---|---|
| Safari | Expected on Safari 18+ (macOS 15+) with a platform passkey (Apple Passwords / iCloud Keychain). To test | n/a |
| Chrome | Expected with Chrome 132+ when the passkey is in iCloud Keychain; the "Chrome profile" passkey option reportedly returns no PRF. To test | Expected with Chrome 147+ on Windows 11 24H2/25H2 with the Feb 2026 update; 146 and earlier return PRF only when signing in, not at creation. To test |
| Edge | Chromium rules as Chrome. To test | As Chrome (147+). To test |
| Firefox | Reported working from Firefox 139. To test | Expected from Firefox 148 (creation backported to 147) with the Feb 2026 Windows update; earlier releases return no PRF for Windows Hello. To test |
| Brave, Arc (Chromium) | Follow the Chromium version; may differ in which passkey provider they offer. To test | Same. To test |

Passkey provider on top of the browser:

| Provider | PRF |
|---|---|
| Apple Passwords (iCloud Keychain), Windows Hello (updated), Google Password Manager | Reported to work |
| 1Password | Reported to work (Chrome) |
| Bitwarden | Varies by platform; to test |
| Chrome profile authenticator, Dashlane, NordPass | Reported to return no PRF |
| Windows 10, Windows 11 without the Feb 2026 update | No PRF from Windows Hello (a hardware security key can still provide it) |

Playwright coverage today: only Chromium with a virtual authenticator (`packages/node/src/approval-passkey-browser.test.ts`), which proves the page script, not any real Touch ID or Windows Hello. WebKit and Firefox are not tested.

When PRF is missing, the page finds no PRF and shows "unsupported", or the browser creates a passkey that returns no PRF output. The page then sends an empty value and the server does not wrap the owner key under that passkey. The master code (`ALKO`) stays the way to approve, so nothing is lost and no key is ever derived from a passkey without PRF.

Sources: MDN, WebAuthn extensions (modified 17 Sep 2026); Mozilla bug 1863819 and Firefox 148 release notes (24 Feb 2026); WebKit bug 311099 (Apr 2026); Corbado, Passkeys and WebAuthn PRF (2026); Chromium Intent to Ship, WebAuthn PRF (Apr 2023).

## First run, one host, start over and a missing key (0.5.5)

Sources: [04 §2.5, §2.5.4](https://github.com/4thtech/agentlink/blob/main/specs/04-security-and-crypto.md), [08 §1](https://github.com/4thtech/agentlink/blob/main/specs/08-clients-console-cloud.md).

- **First run on any platform** (FIRSTRUN-ANY-PLATFORM). The owner is made with the master code in the app host, wherever it runs; "Use your master code instead" makes no WebAuthn request, so there is no passkey dead end and no security-key prompt on Windows. A platform sensor (Touch ID, Windows Hello, a platform passkey with PRF) is offered after the master code, and in a browser only where the browser reports a user-verifying platform authenticator. "Skip to Home" is hidden until an owner exists.
- **One AgentLink, browser or app** (APP-CONTINUITY). The browser host (`agentlink ui`) and the desktop app run the same app host on the same `~/.agentlink` and the same keychain service, so the owner, IDs, contacts and folders are the same either way. Before the app's host starts it reads `~/.agentlink/app-host.json`: a record of a dead process is removed, and a running terminal host is asked to close with `POST /api/ui/host/yield` (record token only, no cookie; it prints "AgentLink moved to the AgentLink app"). With the app open, `agentlink ui` sends `POST /api/ui/host/show` and starts nothing. In the app, presence uses the app's own helper (Touch ID, Windows Hello) once turned on, otherwise the master code; the window has WebAuthn switched off, so no browser passkey is asked for. On a Mac, items the browser host saved in the keychain trigger one allow-access prompt per item on first use (the notice says to enter the Mac login password, never the master code, and choose Always Allow).
- **Windows Hello in the app** (WIN-HELLO-NATIVE). A native helper reports why it can't be used (`not_set_up`, `no_secure_hardware`, unknown) before any prompt, so screens can offer the master code with set-up help instead of a security-key prompt; the prompt opens in front of the AgentLink window.
- **An ID whose key is missing** (WIN-BROKEN-ID, 04 §2.5). An ID folder whose seed or store key is not in the keychain answers `identity_missing` for that ID only; the directory lists it as broken and the others open as usual. Three routes: Restore from backup (a restore writes into that folder), **Remove from this computer** (the folder is renamed whole to `~/.agentlink/set-aside/<name>.<YYYYMMDD-HHMMSS>`, leftover agent items erased without the store key, only when the seed is really gone; signs nothing, tells no contact, never an owner item) and Continue without it. Never an MCP tool (I-4).
- **Start over on this computer** (OWNER-START-OVER, D-153, 04 §2.5.4). Not an owner operation: it signs nothing and opens no owner key. The server checks the page session on a route kind of its own (`start-over`; fixed paths, never an MCP tool), the typed phrase `start over` (a single-use nonce, 120 s), and one fresh confirmation at finish: the OS sheet of the app's helper where Touch ID or Windows Hello is set up; a WebAuthn creation with user verification in a browser; or, where none exists, the phrase typed a second time on a separate step. These stop web origins, AI apps and accidents; they are no protection against a same-user process (G-1). The effect: the IDs and the owner item's ciphertext digest go to `~/.agentlink/start-over.json`; `~/.agentlink` is renamed to `~/.agentlink.backup-YYYYMMDD-HHMMSS` (nothing deleted); Keychain or Credential Manager items are erased by exact name (each ID's, then the owner's, `owner` last) only if every ID's items went; first run then makes a new owner. A failed step is shown and the retry finishes what is unfinished; a new owner is never touched. Residuals: older storage items, the old Windows Hello key and passkeys named AgentLink stay.

## Rotation and recovery

A new key epoch derives new Nostr and encryption keys and a new agent card; old epochs stay derivable, so history stays readable. The recovery kit is an encrypted backup of the seed (`ALKR`, under a generated recovery code; a passkey PRF wrap is `ALKP`) that the user holds; 4thTech stores nothing.
