# RB-23 · Desktop update keys: one-time setup and signing a release

## Purpose
The desktop app installs an update only if it was signed with **your** keys (D-145 (5), 08 §8). The keys never go to CI or to any agent. This page covers the one-time setup (about 30 minutes), signing each release (about 1 minute), changing a key, and what to do if something goes wrong.

## Who runs it
Tali (owner) only. Agents never hold these keys, never type the passphrases and never run the tool. The tool refuses to run in CI.

## Two keys, in plain words
- **Root key.** The master key. Its public half is built into every copy of the app. It signs only short notes that say "this is the update key now" or "that update key is withdrawn". You use it rarely: once now, and again only to change the update key. **It never stays on your everyday computer.** It lives only on two USB sticks.
- **Update key.** Signs each release. It is kept separate from the root key. If it is ever lost or exposed, the root key replaces it and the apps follow, with no reinstall.

Each key is a file locked with its own passphrase (Argon2id + AES-256-GCM, in its own `ALKU` file format). The file is useless without the passphrase, and the passphrase is useless without the file.

## One-time setup (about 30 minutes)

You need:
- two USB sticks labelled **ROOT A** and **ROOT B**, and a third labelled **UPDATE** (or a folder on your computer for the update key, see step 9);
- this repository at a **reviewed, tagged commit** (the tag the orchestrator names, for example `desktop-keys-v1`), with `pnpm install` done and the desktop app built (`pnpm --filter @4thtech-io/desktop build`);
- two passphrases, one per key, each at least 16 characters (a sentence of five or six random words is good). Write each on paper. Do not save them in a password manager that syncs to this computer.

Steps:
1. **Check you have the reviewed code.** In the repository: `git checkout <the tag>` and `git status` must show no changes.
2. **Go offline.** Turn Wi-Fi off and unplug the network cable. Best of all is a separate offline computer, or a computer started from a live USB system that keeps nothing. Keep the network off until step 10.
3. **Plug in ROOT A.** Create the root key **directly on the stick**, never on the computer's own disk:
   ```bash
   node tools/desktop/sign-manifest.mjs generate --role root --out /Volumes/ROOT_A/root.key
   ```
   Type the root passphrase twice. It prints `root public key: …` (64 characters). Write the first and last 8 characters on the paper next to the passphrase.
4. **Copy it to ROOT B** and check both open:
   ```bash
   cp /Volumes/ROOT_A/root.key /Volumes/ROOT_B/root.key
   node tools/desktop/sign-manifest.mjs check /Volumes/ROOT_A/root.key
   node tools/desktop/sign-manifest.mjs check /Volumes/ROOT_B/root.key
   ```
   Each prints `OK: …`.
5. **Create the update key** with the other passphrase, on the UPDATE stick (or in its own folder, step 9):
   ```bash
   node tools/desktop/sign-manifest.mjs generate --role update --out /Volumes/UPDATE/update.key
   node tools/desktop/sign-manifest.mjs check /Volumes/UPDATE/update.key
   ```
6. **Sign the first note** ("the update key is this one"), number 1, onto the UPDATE stick:
   ```bash
   node tools/desktop/sign-manifest.mjs public-key /Volumes/UPDATE/update.key
   node tools/desktop/sign-manifest.mjs statement --root-key /Volumes/ROOT_A/root.key \
     --action introduce --update-key <the update public key> --sequence 1 \
     --out /Volumes/UPDATE/statement-1.json
   ```
7. **Write down the public keys** (they are not secret): `public-key /Volumes/ROOT_A/root.key` and `public-key /Volumes/UPDATE/update.key`. Save the two lines in a text file on the UPDATE stick, for example `public-keys.txt`.
8. **Make sure no root key is left on the computer.** Nothing was written to the disk, but check: `ls ~ ~/Downloads ~/Desktop | grep -i '\.key'` shows nothing. Eject ROOT A and ROOT B and store them in two different places (for example home and office), each with its paper.
9. **Update key location.** The update key may stay on the UPDATE stick (best) or in its own folder on your computer, for example `~/agentlink-update-key/` (copy `update.key`, `statement-1.json` and `public-keys.txt` there). Never put it in the same place as a root key.
10. Turn the network back on. Send the orchestrator `public-keys.txt` and `statement-1.json` only. **Never** send a `.key` file or a passphrase.

### Before you say "merge" on the root-key PR
The orchestrator opens a PR that puts the root public key into `apps/desktop/src/main/updater/root-key.json`. Before you say "merge":
1. Plug in ROOT A and run `node tools/desktop/sign-manifest.mjs check /Volumes/ROOT_A/root.key`, then type the root passphrase. Use `check`, not `public-key`: `public-key` only reads the public half written in the file, which anyone could have changed; `check` opens the key with your passphrase and prints the public key that really belongs to it (`OK: the passphrase opens the root key …`).
2. Open the PR's file `root-key.json` on GitHub.
3. Compare all 64 characters with the key `check` printed in step 1, and with the first and last 8 on your paper. If any character differs, do **not** merge; tell the orchestrator.

## Each release (about 1 minute)

In the same sitting as the npm `latest` approval, CI leaves an unsigned manifest (`agentlink-desktop-stable.json.unsigned`, or `beta`) on the draft GitHub release.

1. Download it. With the desktop app built from the release commit (`pnpm --filter @4thtech-io/desktop build`), sign it:
   ```bash
   node tools/desktop/sign-manifest.mjs sign --update-key /Volumes/UPDATE/update.key \
     --statement /Volumes/UPDATE/statement-1.json \
     --manifest ~/Downloads/agentlink-desktop-stable.json.unsigned \
     --out ~/Downloads/agentlink-desktop-stable.json
   ```
2. The tool first checks the note against the root key built into the app, then shows the version, each installer's system and chip, size and checksum, and the expiry (30 days). Compare the version with the release, and the checksums with `SHA256SUMS` on the draft release. Type `yes` only if they match, then the update passphrase.
3. The tool checks the signed file with the app's own checks before writing it. Upload `agentlink-desktop-stable.json` to the draft release. CI checks it against the root key and publishes. Your signature is the approval; nothing else goes out.

## Changing the update key (rotation)

Do this once as a rehearsal before any external build, and any time the update key may be exposed.

1. Offline: `generate --role update --out /Volumes/UPDATE/update-2.key` (new passphrase).
2. With ROOT A plugged in: `statement --root-key /Volumes/ROOT_A/root.key --action rotate --update-key <new public key> --sequence 2 --out /Volumes/UPDATE/statement-2.json`. The number is always one higher than the last note you signed (keep a list on the paper).
3. Sign the next release with `update-2.key` and `statement-2.json`. Apps that see it switch to the new key and refuse the old one from then on, also apps that are already up to date.
4. **Raise the floor in the next build.** Tell the orchestrator the new number. The next app build sets `minimumStatementSequence` in `root-key.json` to it, so even a freshly installed copy never accepts an older note. Check it in that PR the same way as above: the number in the file equals your latest note number.

To **withdraw** a key with no new release ready: `--action revoke --update-key <that key> --sequence <next number>` and give the orchestrator the note; it is published on its own, and the apps stop accepting that key. Then introduce a new key with the next number, and raise the floor as in step 4.

## If something goes wrong
- **Update key lost, forgotten or exposed:** rotate (above). Nothing is reinstalled.
- **One root stick lost:** use the other one at once to copy it to a new stick.
- **Root key exposed, or both root sticks lost:** existing apps can no longer be updated safely. Stop all desktop releases (`DEPLOY_FREEZE`), generate a new root key with this guide, and publish a new build that people install by hand, with a short notice on the website and README. Old apps keep working but will not update.
- **`This tool … does not run in CI`:** you are in a CI shell or have `CI` set; open a normal terminal.
- **`Run this in a terminal`:** the passphrase must be typed, never piped or pasted from a file.
- **`The app's checks are not built`:** run `pnpm --filter @4thtech-io/desktop build` first.

## Known limits (for reviewers)
- **Clock.** Expiry and "dated in the future" use the computer's clock. A wrong clock can make the app refuse a good update (until it is fixed) or accept an expired one; it never makes it accept an unsigned or wrongly signed one.
- **Freeze window.** Someone who controls the download path can keep showing the last valid manifest until it expires (at most 31 days), so an app may learn of a new release up to that late. They cannot make it install anything older or unsigned.
- **Rollback of the app's own record.** A program running as the same user can delete the app's record of the latest note; the pinned floor (step 4 of rotation) limits how far back that goes.
- **Between the check and opening.** The installer is checked again right before it is opened, but a program running as the same user could swap it in that moment. Gatekeeper and SmartScreen still check what is opened; the same user could already change the installed app (04 §2.5).
