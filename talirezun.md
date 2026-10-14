# @talirezun — sync
**Headline:** OCC v2 contracts live on Base Sepolia (smoke test passed); M1a transport, store, key commitment and envelope verification merged
_Updated 2026-10-14 21:05 · claude-code / claude-opus-5-5 · orchestrator_

## Now
- agentlink merged 2026-10-14 evening: #57 M1-8a-b keychain CI matrix, #58 backlog cards, #59 M1-5b relay pool, #60 M1-8b SQLite store, #61 M1-1l key commitment, #62 D-67 (G-1 accepted as an M1 residual), #63 M1-5c transport sync, #64 D-68 batch owner approval, #65 README testnet status, #66 M1-7b envelope verification.
- Contracts #7–#9 merged; OCC v2 deployed to Base Sepolia through CI and smoke-tested.

## In flight
| Task | Branch / PR | Status | Next step |
|---|---|---|---|
| M1-8c owner code and batch approval | — | fix round | PR |
| M1-2e batch approval vectors | — | building | — |
| M1-7c pairing | — | building | — |
| M1-8b concurrency test flake | #68 | final fix | — |

## Next
1. M1-7d/7e (owner actions, requests), M1-9 CLI + MCP.
2. M1-13 e2e, J9 dogfood → M1a gate (v0.1.0).

## Decisions made (still relevant)
- D-61: G-4 batches all-or-nothing, identical duplicates skipped; notarize gas ≤ 170k; pause blocks receipts; fresh salt per record; G-46 one-plaintext requirement.
- D-62 (confirmed at #34 merge): replacement rule at finalized block, held envelopes (48 h, ≤ 100 per owner kid), pause works after freeze, `soloAfterRevertSeconds` 1 h, G-46 timing before M1-7b.
- D-52/D-57: build → independent review → CI → merge; services auto-deploy; npm `latest` keeps Tali's click.
- D-67: same-user agent risk (G-1) accepted for M1 testnets, re-decided at the M2 gate.
- D-68: batch owner approval, one code entry per reviewed batch, no unlock session; commitments never batched.

## Asks
- [ ] @denisjazbec: start with `docs/README.md` and `docs/process/onboarding.md`. (2026-10-12)
- [ ] @denisjazbec: D-59 proposes you hold one of two ops pause hardware keys. OK? Needed before M3. (2026-10-14)
- [ ] @denisjazbec: review spec 05 §5.1 and the contract cards M1-3*; D-61 changes pause scope (receipts too). (2026-10-14)

## Heads-up
- OCC v2 is clean-room (D-20); no v1 code is copied.
- Your GitHub approval is not required (D-51); feedback through Tali is welcome.

## Feedback log
_(none yet)_

## Blocked on
- Nothing.
