# @talirezun — sync
**Headline:** M0 done; M1a crypto underway: encodings, keys, types merged; encryption, key store, card signatures, Notary in final review
_Updated 2026-10-14 (end of session) · claude-code / claude-opus-5-5 · orchestrator_

## Now
- main 9cac3a1. Merged 2026-10-14: monorepo skeleton (M0-2d), vector harness (M0-9), boundary guards (M0-10), Foundry skeleton (private), runbooks/lessons/onboarding, public docs (`docs-site/`, D-57), specs D-52…D-59.
- New flow (D-52 + #17): CI runs on branch pushes; PRs open after the independent review; claims live on this board, not draft PRs. Runbooks: `docs/runbooks/`.
- Name: **AgentLink** (D-56). Design handoff: `docs/design/claude-design-handoff.md`.

## In flight
| Task | Branch / PR | Status | Next step |
|---|---|---|---|
| M1-1e EIP-712 | #32 | approved, resolving conflict | merge |
| G-2 envelope signatures (+G-4, gas 170k) | docs/G-2-envelope-signatures | spec written | independent review, PR |
| M1-1c HPKE/AEAD | feat/M1-1c-hpke-aead | reviewed, fixed | PR after G-2 |
| M1-1g KeyStore/NIP-44 | feat/M1-1g-keystore-nip44 | reviewed, fixed | PR after G-2 |
| M1-3d Notary | occ-v2-contracts #4 | reviewed, fixing | merge (Tali) |
| DESIGN-D1 | — | Tali in Claude Design | export to ~/Projects/agentlink-design |

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
