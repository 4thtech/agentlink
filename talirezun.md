# @talirezun — sync
**Headline:** M0 nearly done: monorepo, Foundry, vector harness, guards, delivery pipeline and docs merged; M1a crypto starting (M1-1h)
_Updated 2026-10-14 · claude-code / claude-opus-5-5 · orchestrator_

## Now
- main 9cac3a1. Merged 2026-10-14: monorepo skeleton (M0-2d), vector harness (M0-9), boundary guards (M0-10), Foundry skeleton (private), runbooks/lessons/onboarding, public docs (`docs-site/`, D-57), specs D-52…D-59.
- New flow (D-52 + #17): CI runs on branch pushes; PRs open after the independent review; claims live on this board, not draft PRs. Runbooks: `docs/runbooks/`.
- Name: **AgentLink** (D-56). Design handoff: `docs/design/claude-design-handoff.md`.

## In flight
| Task | Branch / PR | Status | Next step |
|---|---|---|---|
| M1-1h crypto vectors | feat/M1-1h-vectors | building | independent review |
| M1-2a types | feat/M1-2a-types | building | independent review |
| M1-3a contract interfaces | occ-v2-contracts feat/M1-3a-interfaces | building | review, then Tali merges |
| M0-8 redacting logger | #12 | fix round (review found 2 leaks) | delta review |
| DESIGN-D1 | — | Tali in Claude Design | export to docs/design/d1 |

## Next
1. M1-1a/1b/1c/1g crypto (S2, tests first) after M1-1h.
2. M1-7 core, M1-8 node (incl. D-54 headless keystore), M1-9 MCP (15 `agentlink_` tools, D-53/D-55).
3. M1-13 e2e, M1-23 J9 dogfood (M1a gate, v0.1.0).

## Decisions made (still relevant)
- D-52/D-57: build → independent review → CI → auto-merge; S2 and sensitive paths need Tali's "merge"; services auto-deploy; npm `latest`, desktop and template releases keep Tali's click.
- D-53/D-55: 15 MCP tools; counterparty names only as owner alias or sanitised; one approval per agreement.
- D-54: headless file KeyStore; the owner key never unlocks non-interactively.
- D-58/D-59: owner-operation bodies; contract roles with 7-day delays, paused mainnet launch.

## Asks
- [ ] @denisjazbec: start with `docs/README.md` (Start here) and `docs/process/onboarding.md`. (2026-10-12)
- [ ] @denisjazbec: D-59 proposes you hold one of two ops pause hardware keys (not a Safe-signer device). OK? Needed before M3. (2026-10-14)
- [ ] @denisjazbec: review spec 05 §5.1 (roles, delays) and the contract cards M1-3*. Relayed feedback is fine. (2026-10-12)

## Heads-up
- OCC v2 is clean-room (D-20); no v1 code is copied.
- Your GitHub approval is not required (D-51); feedback through Tali is welcome.

## Feedback log
_(none yet)_

## Blocked on
- Nothing.
