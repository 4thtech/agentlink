# @talirezun — sync
**Headline:** 16 Nov: AgentLink 0.5.9 is live (npm latest, signed desktop update for Mac and Windows): menu bar widget with an animated brand icon, live status, approvals waiting, connected AI apps, contacts, new messages and a Today timeline; Settings switches to hide the icon or previews; stuck Checking… bar fixed. Docs: download links for Mac and Windows on every entry page, wiki synced to v0.5.9, research section with the first article (CC BY 4.0).
_Updated 2026-11-16 · claude-code / claude-haiku-5-5 · orchestrator, handoff_

## Now
- 0.5.9 LIVE on npm latest and as a signed desktop update for Mac and Windows. Included:
  - Menu bar widget with an animated brand icon: live status, approvals waiting, connected AI apps, contacts, new messages and a Today timeline (D-155).
  - Settings switches to hide the icon or show previews.
  - Stuck "Checking…" status bar fixed.
  - Docs: download links for Mac and Windows on every entry page; wiki synced to v0.5.9.
  - Research section with the first article (CC BY 4.0).
- Merged PRs: #836, #837, #838 (release), #840 (version), wiki #31, #32, #33.

## Next
1. Owner production test of 0.5.9 (Mac + Surface).
2. Follow-up cards to backlog: AI app name per contact in the widget, widget screenshot, knowledge size, Windows CI timeout flake.
3. Dependabot alert 19; PR #809.

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

## 2026-11-14 — 0.5.5 released
- 0.5.5 live: npm latest, GitHub release v0.5.5 (Mac arm64/x64 DMG + zip, Windows setup.exe, extension files), signed desktop update file; wiki.4thtech.io synced (wiki #28). Release PR #828, version PR #829.
- Contents: first run on any computer (master code in the app or browser, no passkey, no terminal); browser and app continue each other; native Windows Hello; start over on this computer (D-153); an ID that can't be opened offers Restore / Remove / Continue; files (send a small text file by content, Files step, Home Files panel, Show in Finder/Explorer); notification fixes; Windows installer shortcut and logs; release-pipeline guards.
- Next: owner tests Update now on both Macs, the Windows setup on a real PC and a fresh first run; follow-up cards from review lows.

## 2026-11-15 — 0.5.6, 0.5.7, 0.5.8 released
- 0.5.6: one-click Update now in the Mac app, Windows app and browser app; a way out of setup at any step.
- 0.5.7: Home Files panel shows the Send folder correctly. Owner confirmed Mac in-app update 0.5.6 → 0.5.7.
- 0.5.8: choose Send and Inbox folders in Finder/Explorer; Windows updates clean up after themselves.
- Next: owner checks Windows and browser updates; follow-up cards.
