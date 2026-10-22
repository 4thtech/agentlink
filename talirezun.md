# @talirezun — sync
**Headline:** #416 (D-119 to D-123) merged this evening. 26 PRs are reviewed and set to auto-merge, waiting on CI runners; release 0.2.0 waits on the queue draining.
_Updated 2026-10-22T18:00Z · claude-code / claude-haiku-5-5 · orchestrator, evening_

## Now
- **Merge rule (standing, from Tali):** merge once an independent review PASSes and checks are green.
- **Queue:** 26 PRs wait on CI runners. GitHub merges each one when its checks are green.
- **Release 0.2.0:** blocked until the queue drains and main CI is green. The npm `latest` click is the owner's.
- **Testnet vault upgrade:** owner executes it from 21:02 UTC.

## Merged today
#370 #396 #397 #404 #409 #412 #416 #420 #421 #424 #433.

## In flight (claims)
| Group | PRs | Status | Next step |
|---|---|---|---|
| Ready, auto-merge set | #348 #380 #381 #382 #388 #390 #392 #394 #401 #402 #403 #405 #407 #411 #413 #414 #425 #427 #434 #436 | waiting on CI runners | none |
| Wave 2 (new) | #439 faucet-off alert, #440 storage follow-ups, #441 Cursor and Windsurf setup, #442 tool wording, #443 owner setup follow-ups, #444 deploy-drop follow-ups | auto-merge set | none |
| Stacked on a base | #415 #417 #418 #419 #422 #426 #428 #437 #438 | waiting on base | #428 after #407; #426 after #411, then #431; #417 #418 #419 after #411, then #435; #415 after #414, then #429 #430 #432; #422 after #413; #437 after #394 (recount); #438 after #436 |
| M1-3c contracts | branch not yet pushed | in progress | push branch |
| M1-4c-b KeyStore signTransaction | m1-4c-b | in progress | — |

## Waiting on owner
- Close #408 (superseded by #414).
- Testnet vault upgrade, from 21:02 UTC.
- npm `latest` approval for 0.2.0.
- e2e-live environment; design briefs B-2, B-3, B-9.

## Owner to-dos
- E2e API-key secrets.
- M1-23 dogfood with Denis.
- Trademark check (M1-24).

## Decisions
- D-112 to D-123 recorded; D-119 to D-123 in #416.

## Asks
- None for @denisjazbec. No new input from Denis.
