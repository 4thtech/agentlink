# @talirezun — sync
**Headline:** M1-7d owner actions, contact.check routing, policy mark and public knowledge base merged; M1a: encodings, requests and CLI/MCP next
_Updated 2026-10-15 07:30 · claude-code / claude-opus-5-5 · orchestrator_

## Now
- merged 2026-10-15:
  - #79 M1-7d (D-70 paired contacts Talk without approval);
  - #85 contact.check routing;
  - #86 M1-8g policy mark;
  - #88 public knowledge base (knowledge/ + llms.txt);
  - #89 D-71 decisions;
  - #83 and #84 CI.

## In flight
| Task | Branch / PR | Status | Next step |
|---|---|---|---|
| M1-5f outbox window | #87 | PR open | Review, then merge |
| M1-7b-b sender-owner entry | #90 | PR open | Review, then merge |
| docs status source | #91 | PR open | Review, then merge |
| Docs-impact section | #92 | PR open | Review, then merge |
| M1-2a encodings | #93 | PR open | Review, then merge |
| M1-7e requests | #94 | PR open | Review, then merge |
| 4thTech wiki redesign | — | plan done | Build |

## Next
1. M1-9 CLI + MCP, M1-12 docs.
2. M1-13 e2e, J9 dogfood → v0.1.0.

## Decisions made (still relevant)
- D-61: G-4 batches all-or-nothing, identical duplicates skipped; notarize gas ≤ 170k; pause blocks receipts; fresh salt per record; G-46 one-plaintext requirement.
- D-62 (confirmed at #34 merge): replacement rule at finalized block, held envelopes (48 h, ≤ 100 per owner kid), pause works after freeze, `soloAfterRevertSeconds` 1 h, G-46 timing before M1-7b.
- D-52/D-57: build → independent review → CI → merge; services auto-deploy; npm `latest` keeps Tali's click.
- D-67: same-user agent risk (G-1) accepted for M1 testnets, re-decided at the M2 gate.
- D-68: batch owner approval, one code entry per reviewed batch, no unlock session; commitments never batched.
- D-69: invite links use raw DEFLATE (RFC 1951).
- D-70: paired contacts Talk without approval by default.
- D-71: deployer keys (testnets: repo secret, process-only safeguards; mainnet: separate hardware key).

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
- None.
