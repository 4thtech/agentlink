# AgentLink — sync board
_Updated 2026-10-14 18:10 by @talirezun_

## Area ownership
| Area | Repo / paths | Lead | Review |
|---|---|---|---|
| Everything (default) | `agentlink`, `occ-v2-contracts` | @talirezun | @denisjazbec (feedback; required on S2) |

## Active tasks
| Task | Assignee | Status | Branch / PR | Updated |
|---|---|---|---|---|
| M0-2 Repos, CI, branch protection | @talirezun | in-progress | main pushed; settings pending | 2026-10-12 |
| M0-4 Decide D-11, D-12, D-14 | @talirezun | in-progress | — | 2026-10-12 |
| M0-2d Monorepo skeleton + CI strict | @talirezun (agents) | done | #2 merged | 2026-10-14 |
| M0-9 Test-vector harness (S2) | @talirezun (agents) | done | #13 merged | 2026-10-14 |
| M0-8/8b Redacting logger + hardening | @talirezun (agents) | done | #12, #40 | 2026-10-14 |
| M0-10 Boundary guards | @talirezun (agents) | done | #9 merged | 2026-10-14 |
| G-29 / G-3 spec gaps | @talirezun (agents) | done | #10, #11 (D-58, D-59) | 2026-10-14 |
| M1-1h Crypto test vectors (S2) | @talirezun (agents) | done | #25 | 2026-10-14 |
| M1-1a/1b crypto base, keys | @talirezun (agents) | done | #27, #29 | 2026-10-14 |
| M1-1c/1e/1f/1g crypto | @talirezun (agents) | done | #32, #37, #38, #41 | 2026-10-14 |
| M1-2a/2b Types (S2) | @talirezun (agents) | done | #23, #31 | 2026-10-14 |
| M1-3a/3b contracts | @talirezun (agents) | done | contracts #2, #3 | 2026-10-14 |
| M1-3d Notary | @talirezun (agents) | done | contracts #4 | 2026-10-14 |
| DOCS-RB runbooks / DOCS-PUB public docs | @talirezun (agents) | done | #7, #8 | 2026-10-14 |
| G-2 envelope signatures spec (D-61, D-62) | @talirezun (agents) | done | #34 | 2026-10-14 |
| M1-1h-c / M1-2c vectors, types runtimes | @talirezun (agents) | done | #35, #36 | 2026-10-14 |
| DESIGN-D1 intake (D1, partial D2, brand) | @talirezun (agents) | done | #33 | 2026-10-14 |
| M1-1g-b test seam for package tests | @talirezun (agents) | in review | fix/M1-1g-b-test-seam-zones | 2026-10-14 |
| M1-3e contract fuzz/invariants | @talirezun (agents) | in review | feat/M1-3e-fuzz-invariants | 2026-10-14 |
| G-9 store schema spec | @talirezun (agents) | in-progress | docs/G-9-store-schema | 2026-10-14 |
| M1-5a transport-nostr gift wrap | @talirezun (agents) | in-progress | feat/M1-5a-transport-gift-wrap | 2026-10-14 |

## Waiting on a decision
| # | Question | Decider | Raised by / when |
|---|---|---|---|
| 1 | Licence of the contracts (D-11, BUSL-1.1 at mainnet) and product name (D-14). The clients are MIT (D-12, decided) | @talirezun + counsel | foundation pack |
| 2 | Design D1 landed (#33). Open: wording fixes, Lucide notice, 4thTech logo art in repo? | @talirezun | orchestrator, 2026-10-14 |
| 3 | Design drop D2: full system, console, verify, invite, onboarding. Due before the M1 gate | @talirezun | orchestrator, 2026-10-12 |

## Blockers
| Task | Blocked on | Since |
|---|---|---|
