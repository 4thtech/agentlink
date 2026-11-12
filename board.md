# AgentLink — sync board
_Updated 2026-11-12 by @talirezun_

## Area ownership
| Area | Repo / paths | Lead | Review |
|---|---|---|---|
| Everything (default) | `agentlink`, `occ-v2-contracts` | @talirezun | @denisjazbec (feedback; required on S2) |

## Active tasks
| Task | Assignee | Status | Branch / PR | Updated |
|---|---|---|---|---|
| M0-2 Repos, CI, branch protection | @talirezun | in-progress | main pushed; settings pending | 2026-10-12 |
| M0-4 Decide D-11, D-12, D-14 | @talirezun | in-progress | — | 2026-10-12 |
| Orchestrator waves | @talirezun (agents) | in-progress | 0.4.14 LIVE on npm latest (12 Nov); merged #795-#798 (docs overhaul, hotfix). Next: desktop apps, UX redesign | 2026-11-12 |
| Cloud agent as 0.6.0 | @talirezun (agents) | ready | groundwork merged (D-131 spec #541, core M2-3a #548); starts after the visual refresh | 2026-10-27 |
| Desktop apps (Mac/Windows, unsigned early builds, D-145) | @talirezun (agents) | in-progress | Touch ID in the app now works on a real Mac (owner tested 12 Nov); next: bring onto the 0.5.0 redesign, release as 0.5.1 | 2026-11-12 |
| UX redesign (design-1112: My IDs, People, Settings, Activity, restore in the app D-147) | @talirezun (agents) | done 12 Nov | merged #802; released as 0.5.0 (npm latest pending owner click); docs #805 | 2026-11-12 |
| Release 0.4.0 | @talirezun | done 27 Oct | npm latest 0.4.0; GitHub Release v0.4.0 with signed desktop bundles (macOS arm64/x64, Windows) | 2026-10-27 |

## Waiting on a decision
| # | Question | Decider | Raised by / when |
|---|---|---|---|
| 1 | Contracts licence (D-11, BUSL-1.1 at mainnet) and product name (D-14). Clients are MIT (D-12, decided) | @talirezun + counsel | foundation pack |
| 2 | Design briefs B-2, B-3, B-9: SUPERSEDED by B-11 v2 (decided 27 Oct, D-135) | @talirezun | orchestrator, 2026-10-22 |
| 3 | e2e-live environment; close #408 (superseded by #414) | @talirezun (owner) | orchestrator, 2026-10-23 |
| 4 | Owner op: Submitter pool (Gnosis faucet low) | @talirezun (owner) | orchestrator, 2026-11-03 |

## Blockers
| Task | Blocked on | Since |
|---|---|---|
