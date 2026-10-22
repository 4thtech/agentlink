# AgentLink — sync board
_Updated 2026-10-22T18:00Z by @talirezun_

## Area ownership
| Area | Repo / paths | Lead | Review |
|---|---|---|---|
| Everything (default) | `agentlink`, `occ-v2-contracts` | @talirezun | @denisjazbec (feedback; required on S2) |

## Active tasks
| Task | Assignee | Status | Branch / PR | Updated |
|---|---|---|---|---|
| M0-2 Repos, CI, branch protection | @talirezun | in-progress | main pushed; settings pending | 2026-10-12 |
| M0-4 Decide D-11, D-12, D-14 | @talirezun | in-progress | — | 2026-10-12 |
| M1b waves — orchestrator | @talirezun (agents) | in-progress | #416 (D-119 to D-123) merged; 26 PRs reviewed, auto-merge set, waiting on CI runners | 2026-10-22 |
| M1-11b first interactive local app | @talirezun (agents) | in-progress | UI: #407 #411 #425 #427 #434 #436 ready; #426 #428 stacked | 2026-10-22 |
| Wave 2 follow-ups (M1-10b-e-b, M1-6b-b, M1-36g, M1-36d-b, M1-11s-c-b, M1-27b-b) | @talirezun (agents) | in-progress | #439 #440 #441 #442 #443 #444; auto-merge set | 2026-10-22 |
| M1-3c chain contracts (gasless top-up) | @talirezun (agents) | in-progress | branch not yet pushed | 2026-10-22 |
| M1-4c-b KeyStore signTransaction | @talirezun (agents) | in-progress | m1-4c-b | 2026-10-22 |
| Merge queue drain (stacked PRs) | @talirezun (agents) | in-progress | stacked on bases: #415 #417 #418 #419 #422 #437 #438 | 2026-10-22 |
| Release 0.2.0 | @talirezun | blocked | waits on queue drain and main CI green | 2026-10-22 |
| M1 gate two-machine test — Tali | @talirezun | in-progress | J1/J4/J8/J9 passed 17/17 (2026-10-18); J2/J3/J5 after M1b | 2026-10-18 |

## Waiting on a decision
| # | Question | Decider | Raised by / when |
|---|---|---|---|
| 1 | Contracts licence (D-11, BUSL-1.1 at mainnet) and product name (D-14). Clients are MIT (D-12, decided) | @talirezun + counsel | foundation pack |
| 2 | Design briefs B-2, B-3 and B-9 (D-116 redesigns) | @talirezun | orchestrator, 2026-10-22 |
| 3 | e2e-live environment; npm `latest` click; close #408 (superseded by #414); testnet vault upgrade from 21:02Z | @talirezun (owner) | orchestrator, 2026-10-22 |

## Blockers
| Task | Blocked on | Since |
|---|---|---|
| Release 0.2.0 | Merge queue drain and main CI green (#396 merged) | 2026-10-22 |
