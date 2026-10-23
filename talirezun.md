# @talirezun — sync
**Headline:** 26 PRs merged since the morning update (49 today). 12 more are set to merge and wait on CI and the queue. Gasless top-up T4 is in review; release 0.2.0 waits for the queue to drain.
_Updated 2026-10-23T14:45Z · claude-code / claude-haiku-5-5 · orchestrator, afternoon_

## Now
- **Merge rule (standing, from Tali):** merge once an independent review PASSes and checks are green.
- **Queue:** 12 PRs have auto-merge on. GitHub merges each one when its checks are green.
- **Process:** orchestrator playbook and four-model routing (#488), and CI no longer runs twice on merge-queue branches (#491), are set to merge.
- **First UI path:** #407 shell merged. #428 nav and #426 first run are in review, then the page PRs, one at a time.
- **Release 0.2.0:** after the queue drains. npm `latest` is the owner's click.

## Merged today
Since the morning update (26): #380 #407 #453 #454 #455 #457 #459 #460 #461 #462 #463 #464 #465 #466 #467 #468 #469 #470 #471 #472 #473 #474 #475 #477 #478 #479.

## In flight (claims)
| Group | PRs | Status | Next step |
|---|---|---|---|
| Set to merge | #476 #480 #481 #482 #483 #484 #485 #486 #487 #488 #489 #491 | CI and queue | none |
| Gasless top-up (M3-4b-t) | T1-T3 merged (off by default); #494 T4-a, #490 T4-b | in review | T4 after review |
| Owner init and invite | #493 M1-36b-2; #492 M1-19-b invite deploy | in review | owner secret names for #492 |
| M1-36h, M1-7f-3 | — | in build | — |
| Contracts | contracts PR in review | in review | audit result |
| UI stack refresh | #428, #426 | in review | — |

## Gasless top-up (landed earlier today)
- Testnet vault upgraded by the owner Safe and verified. First live gasless deposit on Base Sepolia succeeded.
- Contracts release v0.1.0-testnet.4.

## Decisions (owner, 2026-10-23)
- T4 top-up accepted: owner-started only; owner picks $5–$50; no extra fee; the 5/hour limit counts every approved attempt; switch-on comes last, after T3-c and staging keys.
- G-21 strict: every tester reaches a first message in under 5 minutes from install (D-124).

## Waiting on owner
- npm `latest` approval for 0.2.0, after the queue drains.
- D-91 desktop signing.
- Cloudflare secret names for the invite deploy (#492), once merged.
- Production domain confirmation for the invite page.
- e2e-live environment; design briefs B-2, B-3, B-9.

## Owner to-dos
- E2e API-key secrets.
- M1-23 dogfood with Denis.
- Trademark check (M1-24).

## Asks
- None for @denisjazbec. No new input from Denis.
