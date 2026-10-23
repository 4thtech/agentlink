# AgentLink — sync board
_Updated 2026-10-23T09:40Z by @talirezun_

## Area ownership
| Area | Repo / paths | Lead | Review |
|---|---|---|---|
| Everything (default) | `agentlink`, `occ-v2-contracts` | @talirezun | @denisjazbec (feedback; required on S2) |

## Active tasks
| Task | Assignee | Status | Branch / PR | Updated |
|---|---|---|---|---|
| M0-2 Repos, CI, branch protection | @talirezun | in-progress | main pushed; settings pending | 2026-10-12 |
| M0-4 Decide D-11, D-12, D-14 | @talirezun | in-progress | — | 2026-10-12 |
| M1b waves — orchestrator | @talirezun (agents) | in-progress | 23 PRs merged today; 17 reviewed, set to merge, waiting on CI/queue | 2026-10-23 |
| M1-11b first UI path | @talirezun (agents) | in-progress | #407 shell, #428 nav, #426 first run, #431 init opens it; then 6 page PRs, one at a time | 2026-10-23 |
| M3-4b-t gasless top-up | @talirezun (agents) | in-progress | testnet vault upgraded and verified; first live gasless deposit on Base Sepolia OK; T1-T3 merged (off by default); #453 ABI + kill switch; #459 T3-b safeguards; T4 owner-approved top-up flow next, after #435 | 2026-10-23 |
| Contracts #28 vector parity | @talirezun (agents) | in audit | #28 | 2026-10-23 |
| M1-4c-b KeyStore signTransaction | @talirezun (agents) | in-progress | m1-4c-b | 2026-10-23 |
| Release 0.2.0 | @talirezun | blocked | after queue drains; contracts release v0.1.0-testnet.4 done | 2026-10-23 |
| M1 gate two-machine test — Tali | @talirezun | in-progress | J1/J4/J8/J9 passed 17/17 (2026-10-18); J2/J3/J5 after M1b | 2026-10-18 |

## Waiting on a decision
| # | Question | Decider | Raised by / when |
|---|---|---|---|
| 1 | Contracts licence (D-11, BUSL-1.1 at mainnet) and product name (D-14). Clients are MIT (D-12, decided) | @talirezun + counsel | foundation pack |
| 2 | Design briefs B-2, B-3 and B-9 (D-116 redesigns) | @talirezun | orchestrator, 2026-10-22 |
| 3 | e2e-live environment; npm `latest` click for 0.2.0; close #408 (superseded by #414) | @talirezun (owner) | orchestrator, 2026-10-23 |

## Blockers
| Task | Blocked on | Since |
|---|---|---|
| Release 0.2.0 | Merge queue drain and main CI green; npm `latest` is the owner's click | 2026-10-23 |
