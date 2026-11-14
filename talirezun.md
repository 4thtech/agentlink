# @talirezun — sync
**Headline:** 12 Nov: AgentLink 0.4.14 is live on npm latest. It brings rename to contacts, one-command install from the invite, master code naming (D-146) and the docs overhaul. Desktop apps (Mac and Windows, unsigned early builds, D-145) are in progress on `desktop/integration`. Next: the UX redesign on `ux1113/base`.
_Updated 2026-11-12 · claude-code / claude-haiku-5-5 · orchestrator, handoff_

## Now
- 0.4.14 LIVE on npm latest. Included:
  - Rename reaches contacts.
  - One-command install from the invite.
  - Master code naming (D-146), and use your code on every confirm.
  - Email invite and "Name this contact".
  - AI addresses contacts by name.
  - Block a contact.
  - Restart hint.
  - Recovery kit in the app.
  - Doctor output in plain words.
- Docs overhaul merged: README landing page, step-by-step guide with screenshots, glossary, knowledge overview.
- Merged PRs: #795 (UX1112 fixes), #796 (version packages), #797 (DOCS-0414), #798 (hotfix: honest recovery kit copy until restore ships). No open PRs at the time of this update.
- Desktop apps (Mac and Windows, unsigned early builds, D-145) in progress on branch `desktop/integration`:
  - Shell, packaging, CI, invite links, use-the-app, updater, installer desktop mode.
  - Touch ID in the app (phase 2).
  - All reviewed.
  - Touch ID registration does not work yet on a real Mac; under investigation.
  - No external builds yet.

## Next
1. Fix Touch ID registration on a real Mac, then decide on the first external desktop build.
2. UX redesign (design-1112 approved: My IDs, People, Settings, Activity, restore in the app, D-147) on branch `ux1113/base`.
3. Restore spec `ux1113/wp-r0` is reviewed; build restore after the redesign base is in place.

## Owner steps
- Visual QA of the refreshed local app on his Mac (checklist ready).
- Decide brand usage text for #540 (docs brand kit and owner intro GIF).
- Upload the GitHub social preview image.
- Create the Cloudflare test account for the cloud 24-hour loop.
- Mac check: password-manager save on first run.
- Mac check: Touch ID registration on desktop builds (in investigation).

## Decisions made (still relevant)
- D-145: desktop apps ship as unsigned early builds until signing is set up.
- D-146: master code naming.
- D-147: restore in the app.
- D-135: design briefs follow B-11 v2 (supersedes B-2, B-3, B-9).
- D-131: cloud spec.
- npm `latest` and deploy approvals stay with the owner.

## Asks
- None for @denisjazbec. No new input from Denis.

## Feedback log
- None recorded in this file yet.

## 2026-11-12 handoff
- 0.4.14 LIVE on npm latest. Merged #795, #796, #797, #798. No open PRs.
- Desktop apps on `desktop/integration`: all parts reviewed. Blocker: Touch ID registration on a real Mac. No external builds yet.
- Next: UX redesign on `ux1113/base` (design-1112 approved); restore spec `ux1113/wp-r0` reviewed.

## 2026-11-03 handoff
- 0.4.10, one-line installer and one-click release LIVE; no open PRs. GitBook installer docs waiting on sync. Next: Tali testing feedback, Windows installer test, classroom dry run (~6 Nov).
- 0.4.13 LIVE on npm latest (verified). Included:
  - Windows setup with an existing lowercase agentlink folder (W1).
  - Connected AI apps stay green (L1).
  - Claude Code in the Claude app is named correctly (F46).
  - Doctor output in plain words (D1, D3).
  - Windows Hello second gesture (M1-11s-c-c, F48).
  - Backup code Show, Copy and paste, and confirm-with-backup-code (F49).
  - Invite button per ID and approval copy (CLASSROOM-UX).
  - Classroom handout: docs/runbooks/classroom-handout.md.
- Merged PRs: #790, #791, #792, #793.
- Owner op still open: Submitter pool (Gnosis faucet low).

## 2026-11-14 — 0.5.4 released
- 0.5.4 live: npm latest, GitHub release (Mac arm64/x64 DMG + zip, Windows early-build setup.exe), signed desktop update file; wiki.4thtech.io synced (wiki #27).
- Contents: Mac in-app updates (signed), one-press confirmations, attach text files, delete/archive/keep-days/tidy, notification centre + native notifications, recovery-kit names, message order, Windows desktop early build, stable latest download links.
- Next: small 0.5.5 to test Update now; real Windows PC check; cards from review lows.

## 2026-11-14 — 0.5.5 planned
- Owner testing of 0.5.4 found first-run blockers on a fresh Mac user and on Windows 11 21H2 (owner setup needs a passkey the app/OS can't provide). 0.5.5 = one release: first run everywhere (master code without passkey, native Touch ID / Windows Hello), clearer file sharing + send-by-content, notification fixes, Windows fixes, "start over" for a lost master code.
