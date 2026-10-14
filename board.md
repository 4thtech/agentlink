# AgentLink — sync board
_Updated 2026-10-14 by @talirezun_

## Area ownership
| Area | Repo / paths | Lead | Review |
|---|---|---|---|
| Everything (default) | `agentlink`, `occ-v2-contracts` | @talirezun | @denisjazbec (feedback; required on S2) |

## Active tasks
| Task | Assignee | Status | Branch / PR | Updated |
|---|---|---|---|---|
| M0-2 Repos, CI, branch protection | @talirezun | in-progress | main pushed; settings pending | 2026-10-12 |
| M0-3 Docs + agent instructions in repo | @talirezun | done | v0.0.1 | 2026-10-12 |
| M0-4 Decide D-11, D-12, D-14 | @talirezun | in-progress | — | 2026-10-12 |
| M0-2d Monorepo skeleton + CI strict | @talirezun (agents) | done | #2 merged | 2026-10-14 |
| M0-9 Test-vector harness (S2) | @talirezun (agents) | done | #13 merged | 2026-10-14 |
| M0-8 Redacting logger | @talirezun (agents) | in-progress | feat/M0-8-redacting-logger | 2026-10-14 |
| M0-10 Boundary guards | @talirezun (agents) | done | #9 merged | 2026-10-14 |
| G-29 / G-3 spec gaps | @talirezun (agents) | done | #10, #11 (D-58, D-59) | 2026-10-14 |
| M1-1h Crypto test vectors (S2) | @talirezun (agents) | in-progress | feat/M1-1h-vectors | 2026-10-14 |
| M1-2a Types (S2) | @talirezun (agents) | in-progress | feat/M1-2a-types | 2026-10-14 |
| M1-3a Contract interfaces (S2) | @talirezun (agents) | in-progress | occ-v2-contracts feat/M1-3a-interfaces | 2026-10-14 |
| D-53…D-57 specs | @talirezun (agents) | done | #4, #5, #6, #8, #14 | 2026-10-14 |
| DOCS-RB runbooks / DOCS-PUB public docs | @talirezun (agents) | done | #7, #8 | 2026-10-14 |
| M0-2f Foundry skeleton (occ-v2-contracts) | @talirezun (agents) | done | contracts #1 merged | 2026-10-14 |

## Waiting on a decision
| # | Question | Decider | Raised by / when |
|---|---|---|---|
| 1 | Licence of the contracts (D-11, BUSL-1.1 at mainnet) and product name (D-14). The clients are MIT (D-12, decided) | @talirezun + counsel | foundation pack |
| 2 | Design drop D1: copy sheet, tokens, local approval UI. Due week 3 of M1 (`docs/design/README.md`) | @talirezun | orchestrator, 2026-10-12 |
| 3 | Design drop D2: full system, console, verify, invite, onboarding. Due before the M1 gate | @talirezun | orchestrator, 2026-10-12 |

## Blockers
| Task | Blocked on | Since |
|---|---|---|
