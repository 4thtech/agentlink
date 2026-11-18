# RB-23 · Desktop update key: one-time setup, renewal and changing the key

## Purpose
The desktop app installs an update only if its update document was signed with **the** update key whose public half is built into the app (D-151, 08 §8). Since the owner decision of 13 Nov 2026 there is **one** key. GitHub holds it as the environment secret `DESKTOP_UPDATE_KEY` in the environment `desktop-update`, with you as the required reviewer. The release signs the update document only after your approval click, the same trust as the npm `latest` click. There is no USB ceremony and no root key.

This page covers the one-time setup (about 10 minutes), what happens at each release, renewing a document before it expires, changing the key, and what to do if something goes wrong.

## Who runs it
Tali (owner) only. Agents never hold the private key, never create the environment or the secret, and never run the key tool. The key tool refuses to run in CI.

## One-time setup (about 10 minutes)

You need this repository at a reviewed commit of `main` with `pnpm install` done (`git status` shows no changes).

Do the steps **in this order**: GitHub creates a missing environment with no rules the first time a job names it, so the environment and its rules come first, the pin PR last. The release also checks the rules before any job can reach the key (`desktop-update-environment`) and stops if they are missing.

1. **Create the environment.** GitHub › `4thtech/agentlink` › Settings › Environments › **New environment** › name `desktop-update`:
   - **Required reviewers:** you (tick "Prevent self-review" off, you are the one approving).
   - **Deployment branches and tags:** "Selected branches and tags", add the branch `main` only (no pattern, no tag, no other branch).
   - Turn "Allow administrators to bypass configured protection rules" **off**.
2. **Create the key on your own computer.** In a normal terminal (not a CI shell):
   ```bash
   node tools/desktop/new-update-key.mjs --out ~/agentlink-update.key
   ```
   It writes only the private key (one line, 64 characters) to that new file, readable only by you, and never overwrites a file. It prints the **public key** (64 characters) and the next steps. Write the first and last 8 characters of the public key on paper.
3. **Add the secret.** In the environment `desktop-update` › **Environment secrets** › **Add secret**. Name `DESKTOP_UPDATE_KEY`. Value: open `~/agentlink-update.key` in a text editor and copy the one line. Paste it there and nowhere else. Save.
4. **Pin the public key** (last). Send the orchestrator the **public key** only (never the file). The orchestrator opens a PR that sets `"rootPublicKey"` in `apps/desktop/src/main/updater/root-key.json` to it and switches the release build to updates on. This file is a sensitive path: the PR needs the independent review and your "merge". Before you say "merge":
   1. open the PR's `root-key.json` on GitHub;
   2. compare all 64 characters with the public key the tool printed (and the first and last 8 on your paper). If any character differs, do **not** merge; tell the orchestrator.
5. **Remove the file.** `rm ~/agentlink-update.key` (and empty the Trash if you moved it there; make sure no backup or sync folder copied it), or move it to an offline USB stick if you want a copy for changing environments later. Nothing else needs it: GitHub has the secret, the app has the public key.

**Done (UPD-2):** the owner generated the key and stored the secret himself; the public key `7efc699ddc401adc0c9901f12e152397c835c825d5bc34e7f5f4de00f5f6c984` is pinned in `root-key.json` and `release.yml` builds the desktop app with updates on. Steps 1 to 4 are complete.

The first release after step 4 is the first one that apps can update **to by themselves only from then on**: copies built with updates off (0.5.x up to that release) never check, so everyone installs that one release by hand once.

## Each release (one click)

After you approve npm `latest` and the app is attached to the GitHub Release, two jobs run in `release.yml`:
- `desktop-update-environment` (no secret) checks that `desktop-update` still has you (`talirezun`) as its only required reviewer, `main` only and no admin bypass.
- `desktop-update-manifest` (no secret) downloads the app files from the Release, checks that each is the file this run built, that its build provenance was made by `desktop.yml` at this very commit of `main`, that all three built apps (Mac arm64, Mac x64 and, since 0.5.6, Windows x64) carry exactly the key in `root-key.json`, and writes the unsigned update document. It lists the Mac zips and DMGs and the Windows setup (`AgentLink-<version>-win-x64-setup.exe`), so the Windows app updates in-app too (WIN-INAPP-UPDATE).
- `sign-update-manifest` waits for **your approval** (environment `desktop-update`). Approve it when the release is the one you just approved. It checks the release is still the Latest one; then one step reads the key, signs, and the next step checks the result with the app's own checks; a bad or unsigned document stops the job before anything is uploaded. It publishes `desktop-update-<key id>.json` (the first 16 characters of the public key) and the same file as `desktop-update.json` on the Release.

If you do not approve, the Release is still there and people can download it; apps just do not offer it in-app.

## Renew (about every 3–4 weeks without a release)

An update document is valid for 30 days. The daily check `Desktop update expiry` goes red 7 days before it expires (and when it has expired or is missing while a key is pinned). GitHub emails you the red run. To renew:
- **ship a release** (any release signs a new document), or
- open Actions › **Desktop update renew** › **Run workflow** on `main`, and approve its `renew-sign` job. It re-signs the **current Latest** release with a new 30-day window. It uses only what is on the Release: the release tag must point at a commit on `main` whose `root-key.json` equals main's, and each file needs its build provenance from `desktop.yml` at that commit. It needs no build files, so it works at any time (unlike re-running the release jobs, which needs build files GitHub keeps only 14 days). If the pinned key changed since that release, it refuses: ship a release instead.

If it expires anyway, nothing breaks: apps stop offering in-app updates and keep showing the download link (release check) until a new document is published.

## Changing the key

Plan it; there is no way to withdraw a key from apps in the field (D-151). Apps keep trusting the key they were built with until they install a release that pins another one.

1. `node tools/desktop/new-update-key.mjs --out ~/agentlink-update-2.key` (new file).
2. The orchestrator opens a PR that pins the **new** public key in `root-key.json`. Check the 64 characters as in setup step 4, then merge it and replace `DESKTOP_UPDATE_KEY` with the new key (environment › secret › Update). Remove the old key file.
3. The release that carries the new pin is signed with the new key, under the new key id. Apps that still trust the old key ask for the old key id's document, do not find it on that release, and show the download link instead: **everyone installs that one release by hand**, as with the first updates-on release. After that, in-app updates work again.
   - A smoother **bridge** (sign the release that carries the new pin with the old key, under the old key id, so old apps update in-app) needs both keys for one release. `sign-update-manifest` does not do this yet; it is a follow-up (Fable M1).

Because the document name carries the key id, an app with an old pin never fetches a document it would refuse and never mistakes "signed by a key I do not trust" for "no update": it keeps working and shows the download link, and installing by hand moves it to the new key.

## If something goes wrong
- **The key may be exposed** (a leaked log, a compromised GitHub account): set `DEPLOY_FREEZE`, create a new key and change it as above with a release you check yourself. Until apps install that release they still trust the old key: whoever has it **and** can upload to our GitHub Releases could ship them code. That is the same trust as npm `latest` today (04 §7). Delete the old secret at once.
- **Lost the key file:** nothing to do; GitHub has the secret. To move it elsewhere, create a new key and change it as above.
- **`sign-update-manifest` says the key is not the pinned one:** the secret and `root-key.json` disagree. Do not approve again; check which public key is pinned and recreate the secret from the matching file, or change the key as above.
- **`This tool … does not run in CI`:** you are in a CI shell or have `CI` set; open a normal terminal.

## Known limits (for reviewers)
- **No field revocation.** A key cannot be withdrawn from installed apps; it is replaced only by a release that pins a new one (D-151).
- **Same trust as npm `latest`.** The key sits in GitHub's secret store and is used by one CI step after the owner's approval click. Someone with the key and write access to the Releases could ship code to apps that trust it.
- **The approval click is a process rule against agents, not a technical one.** Agents work under your GitHub account (D-51): that token could approve the pending job, change the environment, replace the secret or upload Release files. Only AGENTS.md ("never approve deployments") stops it, as for npm `latest`. A separate agent token without these rights is the real fix (later).
- **Clock.** Expiry and "dated in the future" use the computer's clock. A wrong clock can make the app refuse a good update or accept an expired one; it never makes it accept an unsigned or wrongly signed one.
- **Freeze window.** Someone who controls the download path can keep showing the last valid document until it expires (at most 31 days). They cannot make the app install anything older or unsigned.
- **`tools/desktop/sign-manifest.mjs`** stays for local checks and signing with a sealed key file; releases no longer need it.
