# @talirezun — sync
**Headline:** v0.1.0 released on npm as @4thtech-io/agentlink (2026-10-16); M1a complete; M1b and the two-machine M1 gate test next
_Updated 2026-10-16 16:28 UTC · claude-code / claude-haiku-5-5 · sync update for 2026-10-15/16_

## Now
- **2026-10-16:** v0.1.0 released on npm as `@4thtech-io/agentlink`.
- **M1a complete:** background loop, tool-surface guard, UCD vendoring, J8 e2e, multi-agent per owner, fresh-session fixes, install docs, skill file.
- **AI e2e passing;** local dogfood Claude Code ↔ OpenCode 16/17.
- **Release pipeline:** ci-green gate, deploy freeze, merge queue, trusted publishing.

## In flight
None. No open PRs as of 2026-10-16.

## Next
1. M1b in a new session (orchestrator).
2. M1 gate: two-machine test run by Tali (Denis busy).

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
