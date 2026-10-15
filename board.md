# AgentLink — sync board
_Updated 2026-10-15 01:45 by @talirezun_

## Area ownership
| Area | Repo / paths | Lead | Review |
|---|---|---|---|
| Everything (default) | `agentlink`, `occ-v2-contracts` | @talirezun | @denisjazbec (feedback; required on S2) |

## Active tasks
| Task | Assignee | Status | Branch / PR | Updated |
|---|---|---|---|---|
| M0-2 Repos, CI, branch protection | @talirezun | in-progress | main pushed; settings pending | 2026-10-12 |
| M0-4 Decide D-11, D-12, D-14 | @talirezun | in-progress | — | 2026-10-12 |
| M0/M1 2026-10-14 batch | @talirezun (agents) | done | #2–#56, contracts #2–#7 | 2026-10-14 |
| M1-1l key commitment (G-46) | @talirezun (agents) | done | #61 | 2026-10-14 |
| M1-5b relay pool | @talirezun (agents) | done | #59 | 2026-10-14 |
| M1-5c transport sync | @talirezun (agents) | done | #63 | 2026-10-14 |
| M1-7b envelope verification | @talirezun (agents) | done | #66 | 2026-10-14 |
| M1-8b SQLite store | @talirezun (agents) | done | #60 | 2026-10-14 |
| M1-8a-b keychain CI matrix | @talirezun (agents) | done | #57 | 2026-10-14 |
| M1-8c owner code and batch approval | @talirezun (agents) | done | #67 | 2026-10-15 |
| M1-2d pairing body schemas | @talirezun (agents) | done | #71 | 2026-10-15 |
| M1-2e batch approval vectors | @talirezun (agents) | done | #72 | 2026-10-15 |
| M1-2f contact.check schema | @talirezun (agents) | done | #76 | 2026-10-15 |
| M1-7c pairing | @talirezun (agents) | done | #78 | 2026-10-15 |
| M1-7c-b contact.check verify-and-store | @talirezun (agents) | done | #80 | 2026-10-15 |
| M1-5b-b Node relay connector | @talirezun (agents) | in-progress | #81 merged; Docker CI job pending | 2026-10-15 |
| M1-7d owner actions | @talirezun (agents) | blocked | #79; owner decision | 2026-10-15 |

## Waiting on a decision
| # | Question | Decider | Raised by / when |
|---|---|---|---|
| 1 | Licence of the contracts (D-11, BUSL-1.1 at mainnet) and product name (D-14). The clients are MIT (D-12, decided) | @talirezun + counsel | foundation pack |
| 2 | Design D1 landed (#33). Open: wording fixes, Lucide notice, 4thTech logo art in repo? | @talirezun | orchestrator, 2026-10-14 |
| 3 | Design drop D2: full system, console, verify, invite, onboarding. Due before the M1 gate | @talirezun | orchestrator, 2026-10-12 |

## Blockers
| Task | Blocked on | Since |
|---|---|---|
| M1-7d owner actions | Owner decision (G-6 reading), #79 | 2026-10-15 |
