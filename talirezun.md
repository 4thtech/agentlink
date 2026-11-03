# @talirezun — sync
**Headline:** 3 Nov: AgentLink 0.4.13 live on npm latest (Windows setup fix, Windows Hello second gesture, backup-code flow, classroom handout). Earlier, 28 Oct: AgentLink 0.4.1, 0.4.2 and 0.4.3 released (visual refresh, Approvals grid, Add contact, Start here, funding steps, activity pulse, compact view). Next: usability wave (guided start, agent identities in the app).
_Updated 2026-11-03 · claude-code / claude-opus-5-5 · orchestrator, handoff_

## Now
- 0.4.0 is out: Messages and Files views (read-only, local), Show in Finder, Touch ID upgrade for existing owners, payment confirmation sheet for proofs above limits and limit changes, live status bar, duplicate-contact suggestion.
- Test submitter redeployed; health green.
- Visual refresh of the local app (UI-REFRESH a–t) merged: shell, translucency, transitions, all pages restyled, Approvals in the app, performance and accessibility audit passed (0 axe violations).
- Follow-up cards for the refresh tail are being written.

## Next
1. Owner visual QA of the refresh on his Mac, then release it.
2. Cloud agent, shipped as 0.5.0 (builds on D-131 spec and core M2-3a).

## Owner steps
- Visual QA of the refreshed local app on his Mac (checklist ready).
- Decide brand usage text for #540 (docs brand kit and owner intro GIF).
- Upload the GitHub social preview image.
- Create the Cloudflare test account for the cloud 24-hour loop.
- Mac check: password-manager save on first run.

## Decisions made (still relevant)
- D-135: design briefs follow B-11 v2 (supersedes B-2, B-3, B-9).
- D-131: cloud spec.
- npm `latest` and deploy approvals stay with the owner.

## Asks
- None for @denisjazbec. No new input from Denis.

## Feedback log
- None recorded in this file yet.

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
- Merged PRs: #790, #791, #792, #793. Docs gap PR for 0.4.13 in progress.
- Next, after the ~6 Nov classroom: passkey option E and Windows parity (Windows Hello on some devices gives no PRF; the backup code is the classroom path), F45 restart hint, F23 option A (card name = folder name for terminal IDs), F33, F43, D4, Windows sqlite test timeouts, F49 lows.
- Owner op still open: Submitter pool (Gnosis faucet low).
