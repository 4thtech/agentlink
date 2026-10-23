# @talirezun — sync
**Headline:** 38 PRs merged since 13:00Z, including the desktop extension bundle, the local UI shell and Activity page. Gasless T4-a, strict signed JSON and KeyStore restore are set to merge; release 0.2.0 waits for the queue.
_Updated 2026-10-23T18:40Z · claude-code / claude-haiku-5-5 · orchestrator, evening_

## Now
- **Merge rule (standing, from Tali):** merge once an independent review PASSes and checks are green.
- **Queue:** 14 PRs have auto-merge on: #426 #488 #494 #496 #497 #503 #507 #508 #509 #511 #513 #515 #517 #481.
- **Need a main catch-up first:** #494, #492, #513.
- **Held drafts (UI pages):** #418, #429, #430, #432.
- **Review open:** #512 vocabulary lint, #516 owner-confirmed decisions.
- **Release 0.2.0:** after the queue drains. npm `latest` is the owner's click.

## Merged since 13:00Z (38)
407 417 428 449 453 456 457 458 459 463 471 475 476 477 478 479 480 482 483 484 485 486 487 489 490 491 493 495 498 499 500 501 502 504 505 506 510 514
Plus two contracts PRs (parity follow-up, NatSpec).

Highlights:
- Local UI: shell, navigation (7 items), Activity page, first-run page.
- Owner-first policy at setup (#493, #506).
- Desktop extension bundle with a signed release job (#514). Signing certificate PR #517 is set to merge.
- Receipt retry (#489), file link refresh (#498), Nostr multi-identity login (#502).
- CI: merge queue timeout 120 min, no duplicate queue runs (#491).

## Gasless top-up (off by default)
- T1-T3 merged. T4-b (#490) merged. T4-a (#494) set to merge.

## Owner decisions (2026-10-23)
- **T4 details:** owner-started top-ups only; owner picks $5–$50; no extra fee; the 5/hour limit counts every approved attempt; switch-on comes last.
- **D-127:** M1-7g-e is won't-do for M1.
- **D-128:** strict signed JSON (spec #513, parser #515).
- **D-129:** drop interim. Internal testers only until counsel sign-off. Limits: 100 MB per file, 1 GB per key per week, 16 downloads.
- A file-link refresh never extends retention.
- Storage warning at 80%.
- Keep `--advanced`.
- Invite production domain deferred to the trademark check.
- Stay on GitHub Free.

## Waiting on owner
- R2 drop buckets (step 1: agentlink-drop-staging).
- Offline backup of the desktop signing key.
- npm `latest` approval for 0.2.0.

## Owner to-dos
- E2e API-key secrets.
- M1-23 dogfood with Denis.
- Trademark check (M1-24).

## Asks
- None for @denisjazbec. No new input from Denis.
