# @talirezun — sync
**Headline:** M1a: CLI + MCP server, pairing, send/inbox, invites, owner approvals and policies merged; terms tools, inbox wiring, background loop and e2e next
_Updated 2026-10-15 12:15 UTC · claude-code / claude-opus-5-5 · orchestrator_

## Now
Merged 2026-10-15 (#74–#127, key items):
- **Specs and decisions:** D-72–D-77; M1-9 decomposition and D-73 (#97); terms canonical form (#100).
- **Core:** send pipeline and outbox (#99); inbox sync and delivery acks (#106); request accept/block (#105); approvals and use-once (#95, #116); pairing (#78, #80); owner-signed actions and policy engine (#79); commitments policy D-31 (#114); terms schema and termsHash (#101).
- **CLI:** init and harness detection (#111); owner init, approve, deny, cancel (#115); invite, accept, contacts, status, doctor, requests (#112); runtime and M1a approval channel (#107); copy sheet (#102).
- **MCP server:** frozen M1a tool surface and read-only tools (#113); invite and send/inbox tools (#125, #127).
- **Node:** owner init signs first agent card (#118); policy mark (#86); public knowledge base (#88).
- **CI hardening:** false-red fixes (#109); keychain job runs CLI two-process test (#108); relays-docker job (#84); deterministic dedup test (#117); pinned runner images (#83).
- **Relays:** default public relay set and vetting script (#119).

## In flight
| PR | Work | Status |
|---|---|---|
| #130 | M1-7h-c inbox page read with read marking | open |
| #126 | M1-32 terms flow, one approval per agreement (D-55) | open |
| #123 | DOCS: decisions, spec follow-ups, backlog pass | open |
| #124 | CHORE: version packages | open |
| #120, #121, #128, #129 | DEPS: dependency updates | open |

## Next
1. M1-9q terms tools; M1-9p-b inbox on.
2. M1-7k-b / M1-9r background loop.
3. M1-21-b UCD vendoring.
4. M1-13a e2e; J9 dogfood.

## Decisions (still relevant)
- D-72 request accept/block; D-73 M1-9 owner answers; D-74 terms rules.
- D-75 default relays: nos.lol, relay.primal.net, relay.snort.social, nostr.mom.
- D-76 MCP SDK, with module-graph guard; D-77 interim Unicode table.
- D-52/D-57: build → independent review → CI → merge; services auto-deploy.
- D-61/D-62: G-4 batches all-or-nothing; notarize gas ≤ 170k; pause blocks receipts; replacement at finalized block; held envelopes 48 h; `soloAfterRevertSeconds` 1 h.
- D-67: same-user agent risk (G-1) accepted for M1 testnets; re-decided at M2 gate.
- D-68: batch owner approval, one code per reviewed batch, no unlock session; commitments never batched.
- D-69: invite links use raw DEFLATE (RFC 1951).
- D-70: paired contacts Talk without approval by default.
- D-71: deployer keys (testnets: repo secret; mainnet: separate hardware key).

## Asks
- [ ] @denisjazbec: start with `docs/README.md` and `docs/process/onboarding.md`. (2026-10-12)
- [ ] @denisjazbec: D-59 proposes you hold one of two ops pause hardware keys. OK? Needed before M3. (2026-10-14)
- [ ] @denisjazbec: review spec 05 §5.1 and the contract cards M1-3*; D-61 changes pause scope (receipts too). (2026-10-14)
- [ ] @denisjazbec: Tali will share a private review of the Encryptor extension; please look when you can (2026-10-15)

## Heads-up
- OCC v2 is clean-room (D-20); no v1 code is copied.
- Your GitHub approval is not required (D-51); feedback through Tali is welcome.

## Feedback log
_(none yet)_

## Blocked on
- None.
