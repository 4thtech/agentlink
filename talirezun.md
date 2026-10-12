# @talirezun — sync
**Headline:** v0.0.1 "M0 Foundations" published: specs (pack v0.3), process, CI and versioning; design brief handed to Claude Design; no product code yet
_Updated 2026-10-12T16:00Z · claude-code / claude-opus-5-5 · orchestrator_

## Now
- The repo is public from 2026-10-13 (D-44). The docs map is in `docs/README.md`, and the decisions are D-01…D-47 in `docs/foundation/00-README.md`.
- The plan is M1a walking skeleton (pair + Talk, v0.1.0), then M1b (files, proof), then the M1 gate (v0.2.0). Details in `docs/process/backlog.md` (176 cards).
- Design is being made in Claude Design from spec 11. Drops D1 and D2 are tracked in `docs/design/README.md`.
- Coding starts after Tali's go-ahead.

## In flight
| Task | Branch / PR | Status | Next step |
|---|---|---|---|
| M0-2 repos + CI | main | in-progress | GitHub settings (rulesets, scanning, environments) |
| DESIGN-D1 | — | in-progress (Tali) | copy sheet, tokens, local UI |

## Next
1. GitHub settings and rulesets (owner).
2. M0 skeletons (pnpm/turbo monorepo, Foundry in occ-v2-contracts) once coding is approved.
3. M1a critical path: crypto vectors → core → node → MCP tools → e2e → J9 dogfood.

## Decisions made (still relevant)
- **D-25:** auto-merge behind gates; staging deploys automatically; production waits for Tali's approval click.
- **D-31:** commitments (accept, ACCEPTED/REJECTED receipts) need owner approval by default.
- **D-32:** J8 negotiate-and-agree produces a proof of agreement.
- **D-33:** M1a / M1b split.
- **D-36/D-41:** desktop apps for macOS, Windows and Linux in M2, as full dashboards.
- **D-39/D-40:** UX first, with automatic chain selection.
- **D-45/D-46:** $0.10 per proof, $5 verified registration, stablecoins only, public fee schedule (`12-economics-and-fees.md`).

## Asks
- [ ] @denisjazbec: start with `docs/process/onboarding.md`. Part A is for you; Part B is your agents' protocol, with a bootstrap prompt. Then set up the `../agentlink-sync` worktree. (raised 2026-10-12)
- [ ] @denisjazbec: review spec `05-contracts-occ-v2.md` and the contract cards (M1-3*, M1-14, M2-4, M3-1/2). Key topics: AccessManager roles and delays (gap G-3), stablecoin-only fee config (D-46), and the CREATE3 deploy plan. Relayed feedback is fine. (raised 2026-10-12)
- [ ] @denisjazbec: look over the spec gaps in `backlog.md` §8, especially G-1 (local owner key), G-3 and G-6 (policies fail open). (raised 2026-10-12)

## Heads-up
- OCC v2 is a clean re-implementation (D-20). No v1 code is copied.
- S2 PRs need your GitHub approval (code owner) before they can auto-merge.

## Feedback log
_(none yet)_

## Blocked on
- Tali's go-ahead to start coding.
