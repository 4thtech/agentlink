# @talirezun — sync
**Headline:** 18 Nov: AgentLink 0.5.11 is live (npm latest, signed desktop update for Mac and Windows). 0.5.10 and 0.5.11 shipped the first security hardening after a public community review: received receipts on by default, agent key signing allowlist, hard spending limits, send caps, full-text approval cards, invite limits. The 4thTech org landing page and wiki were refreshed; the research section launched.
_Updated 2026-11-18 · claude-code / claude-haiku-5-5 · orchestrator, handoff_

## Now
- 0.5.11 LIVE on npm latest and as a signed desktop update for Mac and Windows. Included:
  - Hard spending limits and send caps.
  - Full-text approval cards.
  - Invite limits with Keep/Remove.
  - Widget fixes; compact docs with a generated Lumina file.
- 0.5.10 (same day). Included:
  - Received receipts on by default.
  - Agent key signing allowlist.
  - Desktop fixes.
- 4thTech org landing page and wiki refreshed; research section launched.
- Merged PRs: #838, #841–#845; wiki #33–#36; 4thtech/.github#1.

## Next
1. Docs folder rename PR.
2. Triage of the open code-scanning alerts.
3. 0.5.12 (relay read-back, restore guard, terms caps).
4. Owner production test of 0.5.11.

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

## 2026-11-18 — 0.5.12 release PR, docs rename, 0.5.13 started
- Docs folder rename merged (#846): docs/ (user guide, technical), specs/ (was docs/foundation), project/ (process, runbooks, lessons, design). Old links have pointer pages.
- RELEASE 0.5.12 PR #847: delivery confirmation ("Sent, availability unknown" when it can't be checked), restore guard, atomic proof records, send limits for terms, refused-upload cleanup, delete history no longer blocked by receipts, widget deep links and status strip, release PRs run the long e2e lanes. Reviews passed; one more limits fix is being added before merge. npm and desktop update need the owner's clicks.
- 0.5.13 in progress on rel0513/*: delivery details under the hood, restore entries in Activity, notice when the same ID runs on two computers, public e2e/hostile suite, daily relay health check, new default relays with a one-click contact-details update.

## 2026-11-18 — 0.5.12 released
- 0.5.12 live: npm latest, GitHub release v0.5.12, signed desktop update (Mac arm64/x64, Windows). Release PR #847, version PR #848, docs #849.
- Contents: delivery confirmation ("Sent, availability unknown" when no server can confirm), restore guard (24 h owner approval for paid actions, old approvals void), proof signing and fee reservation in one step, consistent spending limits, negotiation messages count toward send limits, refused-upload cleanup, delete history not blocked by receipts, widget file links and clearing, Under the hood strip wraps, release PRs run the long e2e lanes.
- Next: RELEASE 0.5.13 PR; 0.5.14 before mainnet (on-chain allowance, signed Mac helper, KeyStore record gate).

## 2026-11-19 — 0.5.13 released
- 0.5.13 live: npm latest, GitHub release v0.5.13, signed desktop update (Mac, Windows). Release PR #850, version PR #851, docs #852.
- Contents: per-message delivery details (message network: accepted by N, available from M), restore and update entries in Activity with a "From before the restore" label, a notice with last-seen date when the same ID runs on another computer, new default message-network servers with a one-click owner-approved "Update your contact details" (CLI: agentlink owner update-contact-details), daily read-only server health check, public hostile-scenario test suite (25 scenarios), rewritten residual-risk section in specs/04.
- Next: 0.5.14 before mainnet: on-chain spending allowance, signed Mac helper, KeyStore record gate.

## 2026-11-19 — 0.5.14 started
- Owner decisions (relay network): server names visible only under Under the hood (contacts' on expand); own list 2–8 servers; 30-day overlap after a change; two automatic servers mixed into a custom list by default (can turn off); sign-in servers allowed with a warning if ≥ 2 others work; 0.5.14 = KeyStore record gate + read-only live view, custom servers in 0.5.15 after Tali's design pass; spending allowance + signed Mac helper as a long track. Private-network servers: public servers only for 0.5.15 (Tali, after an independent assessment); a narrow owner-approved variant can be revisited if a team asks. Network diagram: three-column diagram (this ID → servers → contacts) preferred.
- Lanes: rel0514/keystore-gate, rel0514/net-backend, rel0514/ci, rel0514/leftovers.
- 19 Nov design choices (Tali, all recommended): amber for slow/can't reach; health dots by shape and colour; 24 h bar per server; "Reaches N contacts"; "Needs your approval" label; contacts-per-server count on each card. First-launch: fix the font swap in the app. Wiki sync script becomes check-only.
- 0.5.15 must have a Test button when you add your own server (in-app check: ready / slow / needs sign-in / refused, with plain reasons) before anything is saved (card NET-PRECHECK).
- Diagram left label: "<name> · this computer" ("Your ID" when no name); keeps the ID wording rule (D-144). Tali, 19 Nov.
- 0.5.14 ships without the 24-hour bar on server cards (CSS budget kept; same numbers shown in words); bar returns in 0.5.15 after a CSS clean-up card. Tali, 19 Nov.

## 2026-11-19 — handoff (0.5.14 release PR open)
- Release PR #853 (rel0514/integration → main) open. All lanes reviewed (KeyStore gate, spending-record recovery, message-network backend) and integrated; local suites green; browser checks fixed.
- Holding merge: Linux keyring crashes in e2e on every 0.5.14 run, never on main → being investigated as a likely 0.5.14 cause. Tali has pre-approved the merge once CI is fully green.
- Then: version PR, Tali's npm and desktop update clicks, docs/wiki/second brain flip, X post.

## 2026-11-19 — 0.5.14 released
- 0.5.14 LIVE: npm latest, GitHub release v0.5.14, signed desktop update (Mac, Windows). Release PR #853, version PR #854.
- Contents: proof-record signing check inside the KeyStore; Under the hood › Message network (live servers, health, speed, contacts per server, three-column diagram); clear recovery when the spending record breaks ("Save again" in Settings › Rules); failed contact-details updates retry; own server lists capped at 8; same-ID notice always shown; first-launch layout fix; fewer keychain calls on Linux; CI browser cache.
- Next: 0.5.15 — use your own servers (Test button, 2–8 servers, reset to automatic, public servers only), 24-hour bar back.

## 2026-11-20 — 0.5.15 planned: finish "use your own servers" end to end
- Owner (Tali): finish the whole own-servers chapter in 0.5.15 (companies can run AgentLink on their own relays); only bug iterations after. No separate 0.5.14 patch: the Message network view fixes (false "can't reach", truthful banner, Automatic label) ship in 0.5.15.
- Decisions: reset/change allowed during the 30-day overlap (old lists stay readable, up to 16 servers); the 2 mixed-in automatic servers count toward the 8 (up to 6 own, ≥ 2 own ready); slow servers count as ready with a warning; wireframes C1–C8 are the design; the "don't also announce on the default servers" option is in 0.5.15.
- Waiting for Tali's go to start the build wave.
- 20 Nov: owner chose: the opt-out also stops the old-server update fan-out. Build wave started (rel0515/integration).
- 20 Nov: Message network page stays compact: one-line server rows that open on tap, "Show all N" after 5, old servers folded, diagram capped at 5 servers / 5 contacts with "+N more", problems always on top; built with the 24-hour bar.
- 20 Nov: Tali approved the compact Message network layout (screenshots with 12 servers / 30 contacts).
- 20 Nov: opt-out is "fully quiet": with it on, AgentLink also stops reading and probing the old public servers and sends nothing to public servers during the 30-day overlap; own previous servers stay readable 30 days; warning names that contacts with very old details may miss you until updated.

## 2026-11-20 — 0.5.15 released
- 0.5.15 LIVE: npm latest, GitHub release v0.5.15, signed desktop update (Mac, Windows). Release PR #856, version PR #857.
- Contents: use your own message servers end to end (Test button, own list 2–8 with automatic mix-in, owner approval, 30-day overlap, fully quiet option that sends nothing to and reads nothing from public servers, `agentlink owner servers` CLI); compact Message network view with diagram and 24-hour bar; fixes from the owner's test; faster database setup.
- Next: on-chain spending allowance and signed Mac helper before mainnet.

## 2026-11-21 — 0.5.16 started; dev machine incident
- 0.5.16 (fix release) on rel0516/integration: Windows in-app update (0.5.14 Windows app could not read the update; manual box shown while checking) and Message network polish. Unfinished work saved on rel0516/wip-win-update and rel0516/wip-net-polish. Paused until Tali says go.
- Dev machine incident: hundreds of leftover worker copies plus parallel tests overloaded the owner's Mac; it hung and needed a macOS reinstall. All old copies removed (work verified merged); new limits: ≤ 2 test-heavy workers, single-core tests, clean copies after each release.
