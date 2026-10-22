# AgentLink — sync board
_Updated 2026-10-22T12:05Z by @talirezun_

## Area ownership
| Area | Repo / paths | Lead | Review |
|---|---|---|---|
| Everything (default) | `agentlink`, `occ-v2-contracts` | @talirezun | @denisjazbec (feedback; required on S2) |

## Active tasks
| Task | Assignee | Status | Branch / PR | Updated |
|---|---|---|---|---|
| M0-2 Repos, CI, branch protection | @talirezun | in-progress | main pushed; settings pending | 2026-10-12 |
| M0-4 Decide D-11, D-12, D-14 | @talirezun | in-progress | — | 2026-10-12 |
| M1b waves — orchestrator | @talirezun (agents) | in-progress | D-118 to D-123 in #416; ~25 PRs reviewed, waiting on CI runners | 2026-10-22 |
| M1-11b first interactive local app | @talirezun (agents) | in-progress | UI frame and pages: #407, #410, #411, #417, #418, #424 | 2026-10-22 |
| M1-4c-b KeyStore signTransaction | @talirezun (agents) | in-progress | m1-4c-b | 2026-10-22 |
| M1-3c chain contracts (gasless top-up) | @talirezun (agents) | in-progress | branch not yet pushed | 2026-10-22 |
| Core helpers, test credits, CLI UX, docs | @talirezun (agents) | in-progress | #415; #419, #420; #409, #412, #413, #421, #422; #416, #423 | 2026-10-22 |
| Open PRs, IR PASS, waiting on merge queue | @talirezun (agents) | in-progress | #344 #348 #370 #398 #400 #401 #402 #403 | 2026-10-22 |
| Release 0.2.0 | @talirezun | blocked | waits on main e2e (#396) | 2026-10-22 |
| M1 gate two-machine test — Tali | @talirezun | in-progress | J1/J4/J8/J9 passed 17/17 (2026-10-18); J2/J3/J5 after M1b | 2026-10-18 |

## Waiting on a decision
| # | Question | Decider | Raised by / when |
|---|---|---|---|
| 1 | Contracts licence (D-11, BUSL-1.1 at mainnet) and product name (D-14). Clients are MIT (D-12, decided) | @talirezun + counsel | foundation pack |
| 2 | Design briefs B-2, B-3 and B-9 (D-116 redesigns) | @talirezun | orchestrator, 2026-10-22 |
| 3 | e2e-live environment; npm `latest` click | @talirezun | orchestrator, 2026-10-22 |

## Blockers
| Task | Blocked on | Since |
|---|---|---|
| Release 0.2.0 | main e2e green (#396 flake fix) | 2026-10-22 |
