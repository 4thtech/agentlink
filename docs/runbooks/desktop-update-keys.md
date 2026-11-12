# RB-23 · Desktop update keys: one-time setup and signing a release

## Purpose
The desktop app installs an update only if the update was signed with **your** keys (D-145 (5), 08 §8). The keys stay on your computer, never in CI. This page has the one-time setup (about 30 minutes) and the signing step for each release (about 1 minute).

## Who runs it
Tali (owner) only. Agents never hold these keys, never type the passphrases and never run the tool. The tool refuses to run in CI.

## Two keys, in plain words
- **Root key.** The master key. Its public half is built into every copy of the app. It signs only one kind of note: "this is the update key now" (or "that update key is withdrawn"). You use it rarely: once now, and again only to change the update key.
- **Update key.** Signs each release. If it is ever lost or exposed, the root key replaces it and the apps follow, with no reinstall.

Each key lives in its own file, locked with a passphrase you choose (Argon2id + AES-256-GCM, the same sealing AgentLink uses for the owner key). The file is useless without the passphrase, and the passphrase is useless without the file.

## One-time setup (about 30 minutes)

You need: this repository checked out with `pnpm install` done, two USB sticks (the backups), and a passphrase for each key (at least 16 characters; a sentence of five or six random words is good). Write each passphrase on paper. Do not save them in a cloud password manager that syncs to the same computer as the key files.

1. **Go offline.** Turn Wi-Fi off and unplug the network cable (or use an offline computer). The tool never uses the network, but offline is the rule for making master keys.
2. **Make a folder for the keys**, for example `~/agentlink-update-keys`.
3. **Create the root key.** In a terminal at the repository root:
   ```bash
   node tools/desktop/sign-manifest.mjs generate --role root --out ~/agentlink-update-keys/root.key
   ```
   Type the root passphrase twice. It prints `root public key: …` (64 characters).
4. **Create the update key**, with a different passphrase:
   ```bash
   node tools/desktop/sign-manifest.mjs generate --role update --out ~/agentlink-update-keys/update.key
   ```
5. **Sign the first statement** ("the update key is this one"), number 1:
   ```bash
   node tools/desktop/sign-manifest.mjs public-key ~/agentlink-update-keys/update.key
   node tools/desktop/sign-manifest.mjs statement --root-key ~/agentlink-update-keys/root.key \
     --action introduce --update-key <the update public key> --sequence 1 \
     --out ~/agentlink-update-keys/statement-1.json
   ```
6. **Make two backups.** Copy the whole folder to both USB sticks. Keep them in two different places (for example home and office). Then check each backup opens:
   ```bash
   node tools/desktop/sign-manifest.mjs check /Volumes/<stick>/agentlink-update-keys/root.key
   node tools/desktop/sign-manifest.mjs check /Volumes/<stick>/agentlink-update-keys/update.key
   ```
   Each prints `OK: …`.
7. **Hand over the public keys only.** Send the orchestrator the two lines from `public-key` (root and update) and the file `statement-1.json`. These are public and safe to share. **Never** send a `.key` file or a passphrase.
8. Turn the network back on. The orchestrator puts the root public key into `apps/desktop/src/main/updater/root-key.json` (until then, release builds refuse to build).

## Each release (about 1 minute)

In the same sitting as the npm `latest` approval, CI leaves an unsigned manifest (`agentlink-desktop-stable.json.unsigned`, or `beta`) on the draft GitHub release.

1. Download it, then sign it:
   ```bash
   node tools/desktop/sign-manifest.mjs sign --update-key ~/agentlink-update-keys/update.key \
     --statement ~/agentlink-update-keys/statement-1.json \
     --manifest ~/Downloads/agentlink-desktop-stable.json.unsigned \
     --out ~/Downloads/agentlink-desktop-stable.json
   ```
   Type the update passphrase. It prints the version and the date until which the manifest is valid (30 days).
2. Upload `agentlink-desktop-stable.json` to the draft release. CI checks it against the root key and publishes. Your signature is the approval; nothing else goes out.

## Changing the update key (rotation)

Do this once as a rehearsal before any external build, and any time the update key may be exposed.

1. Offline: `generate --role update --out ~/agentlink-update-keys/update-2.key` (new passphrase).
2. `statement --root-key … --action rotate --update-key <new public key> --sequence 2 --out statement-2.json` (always one higher than the last number).
3. Back up the folder to both sticks again.
4. Sign the next release with `update-2.key` and `statement-2.json`. Apps that see it switch to the new key and refuse the old one from then on.

To **withdraw** a key with no new release ready: `--action revoke --update-key <that key> --sequence <next number>`, and give the orchestrator the statement file; it is published on its own. Then introduce a new key with the next number.

## If something goes wrong
- **Forgot a passphrase or lost both copies of a key file:** the update key can be replaced with the root key. If the root key is lost, existing apps can no longer be updated automatically; people would install a new build by hand. This is why there are two backups.
- **`This tool … does not run in CI`:** you are in a CI shell or have `CI` set; open a normal terminal.
- **`Run this in a terminal`:** the passphrase must be typed, never piped or pasted from a file.
