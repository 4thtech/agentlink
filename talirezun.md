# @talirezun — sync
**Headline:** M1a core: pairing, key commitment, owner code with batch approval, transport and store merged; owner-actions (M1-7d) awaits an owner decision
_Updated 2026-10-15 01:45 · claude-code / claude-opus-5-5 · orchestrator_

## Now
- agentlink merged overnight 2026-10-14/15:
  - #67 M1-8c owner code and batch approval;
  - #70 D-69 invite links use raw DEFLATE;
  - #71 M1-2d pairing body schemas;
  - #72 M1-2e batch approval schema;
  - #73 docs follow-ups and lesson LL-15;
  - #75 and #77 test vectors;
  - #76 M1-2f contact.check schema;
  - #78 M1-7c pairing;
  - #80 M1-7c-b contact.check verify-and-store;
  - #81 M1-5b-b Node relay connector.
- Contracts: invariant-test flake fixed and CI repaired.

## In flight
| Task | Branch / PR | Status | Next step |
|---|---|---|---|
| M1-7d owner actions | #79 | waiting on owner decision (G-6 reading) | Owner decision |
| audit-rules one-liner | #74 | waiting on owner approval | Owner approval |
| M1-5b-b Docker relay CI job | — | needs owner (`.github`) | Owner |

## Next
1. M1-7e requests, M1-8g, M1-9 CLI + MCP (after M1-7d).
2. M1-13 e2e, J9 dogfood → M1a gate (v0.1.0).

## Decisions made (still relevant)
- D-61: G-4 batches all-or-nothing, identical duplicates skipped; notarize gas ≤ 170k; pause blocks receipts; fresh salt per record; G-46 one-plaintext requirement.
- D-62 (confirmed at #34 merge): replacement rule at finalized block, held envelopes (48 h, ≤ 100 per owner kid), pause works after freeze, `soloAfterRevertSeconds` 1 h, G-46 timing before M1-7b.
- D-52/D-57: build → independent review → CI → merge; services auto-deploy; npm `latest` keeps Tali's click.
- D-67: same-user agent risk (G-1) accepted for M1 testnets, re-decided at the M2 gate.
- D-68: batch owner approval, one code entry per reviewed batch, no unlock session; commitments never batched.
- D-69: invite links use raw DEFLATE (RFC 1951).

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
- M1-7d owner actions (#79): owner decision (G-6 reading).
