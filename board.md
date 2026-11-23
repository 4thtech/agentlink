# AgentLink — sync board
_Updated 2026-11-23 by @talirezun_

## Area ownership
| Area | Repo / paths | Lead | Review |
|---|---|---|---|
| Everything (default) | `agentlink`, `occ-v2-contracts` | @talirezun | @denisjazbec (feedback; required on S2) |

## Active tasks
| Task | Assignee | Status | Branch / PR | Updated |
|---|---|---|---|---|
| M0-2 Repos, CI, branch protection | @talirezun | in-progress | main pushed; settings pending | 2026-10-12 |
| M0-4 Decide D-11, D-12, D-14 | @talirezun | in-progress | — | 2026-10-12 |
| Orchestrator waves | @talirezun (agents) | in-progress | 0.5.13 LIVE (19 Nov): delivery details under the hood, restore entries in Activity, notice when one ID runs on two computers, new default message-network servers with one-click "Update your contact details", public hostile-scenario suite in CI, residual-risk rewrite. 0.5.12 LIVE (18 Nov). Next: 0.5.14 before mainnet (on-chain spending allowance, signed Mac helper, KeyStore record gate) | 2026-11-19 |
| 0.5.14 (KeyStore record gate + message-network view + spending-record recovery) | @talirezun (agents) | done 19 Nov | LIVE: npm latest 0.5.14, GitHub release v0.5.14, signed desktop update; docs + wiki in progress. Next: 0.5.15 (your own servers with a Test button) | 2026-11-19 |
| 0.5.15 (use your own servers, end to end) | @talirezun (agents) | done 20 Nov | LIVE: npm latest 0.5.15, GitHub release v0.5.15, signed desktop update; docs + wiki in progress. Next: on-chain spending allowance + signed Mac helper (before mainnet) | 2026-11-20 |
| 0.5.16 (Windows in-app updates fixed; Message network polish) | @talirezun (agents) | done 21 Nov | LIVE: npm latest 0.5.16, GitHub release v0.5.16, signed desktop update; release PR #860, version PR #861; docs in progress. Windows users on 0.5.14/0.5.15 install 0.5.16 once by hand. Next: on-chain spending allowance + signed Mac helper (before mainnet) | 2026-11-21 |
| 0.5.17 (nostr.data.haus replaces offchain.pub; first Windows in-app update) | @talirezun (agents) | done 22 Nov | LIVE: npm latest 0.5.17, GitHub release v0.5.17, signed desktop update; release PR #863, version PR #864, docs PR #865, wiki #44. Owner confirmed Windows in-app update 0.5.16 → 0.5.17 and Mac. Next: 0.5.18 shared server connection (off by default) | 2026-11-22 |
| 0.5.18 (shared server connection, off by default; D-159) | @talirezun (agents) | done 23 Nov | LIVE: npm latest 0.5.18, GitHub release v0.5.18, signed desktop update; release PR #866, version PR #867, docs PR #868, wiki #45. Next: 0.5.19 polish (copy, test stability, shared-link hardening, terminal app hosts the link, knowledge trim, wiki sync from main) | 2026-11-23 |
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
