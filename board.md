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
| M0-2d Monorepo skeleton + CI strict | @talirezun (agents) | in-progress | chore/M0-2d-monorepo-skeleton | 2026-10-14 |
| M0-2f Foundry skeleton (occ-v2-contracts) | @talirezun (agents) | in-progress | chore/M0-2f-foundry-skeleton | 2026-10-14 |

## Waiting on a decision
| # | Question | Decider | Raised by / when |
|---|---|---|---|
| 1 | Licence of the contracts (D-11, BUSL-1.1 at mainnet) and product name (D-14). The clients are MIT (D-12, decided) | @talirezun + counsel | foundation pack |
| 2 | Design drop D1: copy sheet, tokens, local approval UI. Due week 3 of M1 (`docs/design/README.md`) | @talirezun | orchestrator, 2026-10-12 |
| 3 | Design drop D2: full system, console, verify, invite, onboarding. Due before the M1 gate | @talirezun | orchestrator, 2026-10-12 |

## Blockers
| Task | Blocked on | Since |
|---|---|---|
| S2 PRs (incl. PR #1, all M1-1 crypto) | review-gate (d) requires a non-author approval, impossible under D-51; owner edits the workflow | 2026-10-14 |
