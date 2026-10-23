# @talirezun — sync
**Headline:** 23 PRs merged today. 17 more reviewed and set to merge, waiting on CI and the queue. Gasless top-up is live on Base Sepolia; release 0.2.0 follows the queue drain.
_Updated 2026-10-23T09:40Z · claude-code / claude-haiku-5-5 · orchestrator, morning_

## Now
- **Merge rule (standing, from Tali):** merge once an independent review PASSes and checks are green.
- **Queue:** 17 PRs wait on CI and the merge queue. GitHub merges each one when its checks are green.
- **First UI path:** #407 shell, then #428 nav, #426 first run, #431 init opens it. Then 6 page PRs, one at a time.
- **Release 0.2.0:** after the queue drains. npm `latest` is the owner's click.

## Merged today
#348 #388 #392 #402 #413 #414 #415 #419 #422 #425 #434 #437 #438 #440 #442 #444 #445 #446 #447 #448 #450 #451 #452.

## In flight (claims)
| Group | PRs | Status | Next step |
|---|---|---|---|
| Reviewed, set to merge | #380 #407 #449 #453 #454 #455 #456 #457 #458 #459 #460 #461 #462 #463 #464 #465 #466 | waiting on CI and queue | none |
| Gasless top-up (M3-4b-t) | T1 signing format, T2 chain helpers, T3 submitter endpoint merged (off by default); #453 ABI + kill switch; #459 T3-b safeguards | T4 next | T4 owner-approved top-up flow in core + UI, after #435 |
| Contracts | #28 vector parity | in audit | audit result |
| M1-4c-b KeyStore signTransaction | m1-4c-b | in progress | — |

## Gasless top-up (landed today)
- Testnet vault upgraded by the owner Safe and verified. First live gasless deposit on Base Sepolia succeeded.
- Contracts release v0.1.0-testnet.4.

## Decisions (owner, 2026-10-23)
- M3-4b-t a–f: owner approves each top-up; agent key signs; testnet $5 min, $50 cap; normal fee; 15-minute window; 5 per agent per hour.
- Separate relay gas key.
- G-21 strict: every tester reaches a first message in under 5 minutes from install. Recorded as D-124 in #461.

## Waiting on owner
- Close #408 (superseded by #414).
- npm `latest` approval for 0.2.0.
- e2e-live environment; design briefs B-2, B-3, B-9.

## Owner to-dos
- E2e API-key secrets.
- M1-23 dogfood with Denis.
- Trademark check (M1-24).

## Asks
- None for @denisjazbec. No new input from Denis.
