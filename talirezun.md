# @talirezun — sync
**Headline:** D-118 to D-123 recorded in PR #416; about 25 PRs passed review and wait on CI runners, and the merge queue has been stalled since 10:03Z (#386 and #395 jumped to the front).
_Updated 2026-10-22T18:00Z · claude-code / claude-haiku-5-5 · orchestrator, evening_

## Merge plan (2026-10-22 evening)
Approved drafts merge after their bases, each with a fresh review: #370→#407,#427,#428; #410→#424→#426→#431; #411→#417,#418,#419→#435 (+#425); #414→#415→#429,#430,#432; #406→#416→#437; #413→#422.
Follow-up cards are recorded in #416/#437. Contracts: occ-v2-contracts #25 and #26 merged; testnet vault upgrade is the owner's next step.

## Now
- **Merge rule (standing, from Tali):** merge once an independent review PASSes and checks are green.
- **Queue:** stalled by a flaky test and runner load. #386 and #395 were moved to the front.
- **Release 0.2.0** stays blocked until main's e2e is green (#396, flake fix).
- **Faucet:** Base Sepolia faucet funded to 40 test USDC (Tali).

## Decisions (D-118 to D-123, PR #416)
- Local UI is a React app in `apps/local-ui`.
- Policy loosening is allowed, with warnings that must be acknowledged.
- App UX: passkey owner setup with an owner-code backup; recovery kit "Later"; free test credits auto-claimed once; navigation cut to 7 items.
- Agent side: global install, approval wait, automatic agent names, Send folder.
- Payments: QR top-up, Withdraw credits button, public trust docs.
- Chiado QR top-up now; gasless top-up (M1-3c) and the testnet slice of M3-4b pulled forward.

## In flight (claims)
| Task | PR / branch | Status | Next step |
|---|---|---|---|
| UI frame and pages | #407, #410, #411, #417, #418, #424 | claimed | — |
| Core helpers | #415 | claimed | — |
| Test credits | #419, #420 | claimed | — |
| CLI UX | #409, #412, #413, #421, #422 | claimed | — |
| Docs | #416, #423 | claimed | — |
| M1-3c contracts (builder) | branch not yet pushed | in progress | push branch |
| M1-4c-b KeyStore signTransaction | m1-4c-b | in progress | — |
| CI matrix, queue-only legs | #395 | open | — |
| e2e flake fix | #396 | open | unblocks main e2e and 0.2.0 |
| Version packages | #324 | open | release 0.2.0 |

## Waiting on owner
- e2e-live environment.
- npm `latest` approval click for the release.
- Design briefs B-2, B-3 and B-9.

## Owner to-dos
- E2e API-key secrets.
- M1-23 dogfood with Denis.
- Trademark check (M1-24).

## Decisions made (still relevant)
- D-112 to D-117: free messages and files; top-up link format; receipts payer; backup and restore; design exists and needs adjusting; merge rule above.

## Asks
- None for @denisjazbec. No new input from Denis.
