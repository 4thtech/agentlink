# @talirezun — sync
**Headline:** M1a crypto foundations merged (keys, HPKE/AEAD, EIP-712, KeyStore/NIP-44/gift wrap, passphrase/pairing/safety code); G-2 spec and design D1 landed; transport and core next
_Updated 2026-10-14 18:10 · claude-code / claude-opus-5-5 · orchestrator_

## Now
- main 1377cb5. Merged 2026-10-14: #32 M1-1e, #33 design intake, #34 G-2 (D-61, D-62), #35 M1-1h-c, #36 M1-2c, #37 M1-1f, #38 M1-1c, #39 M0-10c, #40 M0-8b, #41 M1-1g; contracts #4 Notary.
- Flow (D-52): build → independent review → CI → PR. S2, sensitive and process PRs merge on Tali's "merge"; auto-merge only for S0/S1 outside docs/process.
- Design: D1 in `docs/design/` (D2 partial: prototypes and rationale missing).

## In flight
| Task | Branch / PR | Status | Next step |
|---|---|---|---|
| M1-1g-b test seam for package tests | fix/M1-1g-b-test-seam-zones | reviewed, fixing lows | PR → Tali |
| M1-3e contract fuzz/invariants | feat/M1-3e-fuzz-invariants (private) | reviewed, fixing | PR → Tali (nightly cadence) |
| G-9 store schema (07 §3) | docs/G-9-store-schema | writing | review → PR |
| M1-5a transport-nostr gift wrap | feat/M1-5a-transport-gift-wrap | building | review → PR |
| Backlog follow-ups + README status | docs/BL-followups-2026-10-14 | writing | PR |

## Next
1. M1-7a core (after G-9), M1-5b/5c transport sync.
2. M1-8 node, M1-9 MCP tools, M1-13 e2e, J9 dogfood (M1a gate, v0.1.0).

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
