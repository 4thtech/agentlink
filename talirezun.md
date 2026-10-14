# @talirezun — sync
**Headline:** M1a crypto, transport and core skeleton merged; contracts pre-audited (Fable 5.1); Base Sepolia deploy next
_Updated 2026-10-14 20:15 · claude-code / claude-opus-5-5 · orchestrator_

## Now
- main 4308ff6. Merged 2026-10-14: #32–#52 (crypto M1-1c/1e/1f/1g/1g-b/1h-c, types M1-2c, transport M1-5a, core M1-7a, logger M0-8b, CI M0-10c/d/e, specs G-2/G-8/G-9/G-24, D-63–D-65, design intake, Fable audit follow-ups); contracts #4 Notary, #5 fuzz/invariants, #6 testnet config.
- Contracts pre-audited by Fable 5.1 (0 Critical, 0 High); Base Sepolia testnet deploy is next (owner-triggered, CI only).

## In flight
| Task | Branch / PR | Status | Next step |
|---|---|---|---|
| M1-14 chain config | #53 | approved | merge when green |
| M1-3k audit fixes (private) | fix/M1-3k-audit-fable-1 | Fable re-check GO | PR → Tali |
| M1-3g deploy script (private) | feat/M1-3g-deploy-testnet | building | Fable review → deploy |
| D-66 key commitment (G-46) | docs/D-66-g46-key-commitment | writing | review → PR |
| M1-8a keychain KeyStore | feat/M1-8a-keychain-keystore | fixing review | PR |
| M1-1g-d epoch advance | feat/M1-1g-d-epoch-advance | fixing review | PR |

## Next
1. Base Sepolia deploy + smoke test; M1-5b transport sync, M1-8b SQLite store, M1-7b envelope verification.
2. M1-8c, M1-9 CLI/MCP, M1-13 e2e, J9 dogfood (M1a gate, v0.1.0).

## Decisions made (still relevant)
- D-61: G-4 batches all-or-nothing, identical duplicates skipped; notarize gas ≤ 170k; pause blocks receipts; fresh salt per record; G-46 one-plaintext requirement.
- D-62 (confirmed at #34 merge): replacement rule at finalized block, held envelopes (48 h, ≤ 100 per owner kid), pause works after freeze, `soloAfterRevertSeconds` 1 h, G-46 timing before M1-7b.
- D-52/D-57: build → independent review → CI → merge; services auto-deploy; npm `latest` keeps Tali's click.

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
