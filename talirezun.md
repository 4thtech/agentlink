# @talirezun — sync
**Headline:** Standing merge rule: the orchestrator merges a PR once it has an independent review PASS and green checks. Release 0.2.0 waits on main's e2e (#396). Chiado keys are set; #402 is in review.
_Updated 2026-10-22 · claude-code / claude-haiku-5-5 · orchestrator_

## Now
- **Merge rule (standing, from Tali):** merge once an independent review PASSes and checks are green.
- **CI:** #395 runs the macOS and Windows legs in the merge queue only. Merge-queue batching is on (groups of 5, 2 concurrent builds).
- **Release 0.2.0** is next. Blocked until main's e2e is green; #396 is the flake fix.
- **Chiado:** submitter keys are set. Enabling it (#402) is in review. Production funding is coming through the community.
- **UI:** M1-11b (first interactive local app) starts once #370 (UI components) merges. M1-35c (UI strings, #398) is reviewed.
- **Main** has landed through #384 (2026-10-22). 30 PRs are open.

## In flight
| Task | PR | Status | Next step |
|---|---|---|---|
| UI components (M1-35b) | #370 | review | unblocks M1-11b, then M1-35c |
| UI strings (M1-35c) | #398 | reviewed | merge under the standing rule |
| e2e flake fix | #396 | open | unblocks main e2e and 0.2.0 |
| CI matrix, queue-only legs | #395 | open | — |
| Chiado enable | #402 | review | needs Chiado funding |
| Transport hardening (M1-5b-c) | #403 | open | — |
| Counter-offers (M1-9d-5) | #401 | open | — |
| Receiver file-key rows (M1-7f-2) | #400 | open | — |
| Version packages | #324 | open | release 0.2.0 |
| Top-up link (M1-26-e) | #344 | review | on until the pay page is live |
| Invite page (M1-19) | #348 | review | — |

## Waiting on owner
- Design briefs B-2, B-3 and B-9.
- e2e-live environment.
- npm `latest` approval click for the release.
- Chiado funding.

## Owner to-dos
- E2e API-key secrets.
- M1-23 dogfood with Denis.
- Trademark check (M1-24).

## Decisions made (still relevant)
- D-112 to D-117: free messages and files; top-up link format; receipts payer; backup and restore; design exists and needs adjusting; merge rule above.

## Asks
- None for @denisjazbec. No new input from Denis.
