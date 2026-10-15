# RB-16 · Vetting the default relay set

## Purpose
Check each relay of the default set (D-75) against what AgentLink needs, and record a dated result, so M1-18 can sign off the relays before external testers arrive.

## When to use
Before the J9 dogfood and before external testers; whenever the default list changes (`packages/transport-nostr/src/default-relays.ts`); and about every quarter while the list is public relays. Not part of CI: it talks to live third-party relays.

## Who runs it
The orchestrator or a builder (Sonnet or above) on a machine with network access. The owner confirms the sign-off.

## Preconditions
- Dependencies installed (`pnpm install`); Node 22 or later (global `WebSocket` and `fetch`).
- Run from an empty scratch directory: the script writes `relay-vet-<time>.json` into the current directory.

## Steps
1. Print the plan without touching the network: `node tools/relays/vet.mjs`.
2. Run the checks: `node <repo>/tools/relays/vet.mjs --live` (or pass `wss://…` URLs to try other relays). Per relay it sends **one** tiny kind-1059 event of random bytes, signed by a throwaway key made for the run. The key is never printed or saved and no real key or envelope is used.
3. Record the dated table (below) in the PR or in `docs/process/` notes.
4. Retention: later (for example after 10 minutes, 24 hours and 7 days) run `node <repo>/tools/relays/vet.mjs --live --recheck relay-vet-<time>.json`. It asks each relay for the saved event id and says whether it is still there.
5. If a check fails, do not edit the list on your own; report it to the owner (a list change is a decision-log entry).

## Checklist (sign-off table)
| Check | Pass when | How the script checks it |
|---|---|---|
| Kind 1059 accepted | `OK true` for the test wrap | Publishes it and reads the `OK` |
| Read back | The event comes back by id without AUTH, or the relay says AUTH is needed | `REQ` with `ids`. A relay that accepts but never returns it is a **fail for reads** until shown otherwise with a `#p` filter under AUTH |
| Message size | NIP-11 `max_message_length` ≥ 90 112 (the largest valid wrap is about 88 KB as an `EVENT` frame; our frame cap is 131 072, 04 §3.1.1). The card's older "≥ 64 KB" is below what a maximum wrap needs | `judgeNip11` on `limitation.max_message_length`; absent is "unknown", test by hand |
| Retention | Still present after 7 days (we sync with a 48 h look-back and a 9 day first sync, 07 §4.2, §4.3); 30 days is the longest we rely on | Saved event id, `--recheck` over time |
| Read auth (NIP-42) | Behaviour known: either open reads, or an `AUTH` challenge that the pool answers (07 §4.2 supports NIP-42) | NIP-11 `supported_nips`, `auth_required`, an `AUTH` frame on publish or read |
| Uptime | No outage over the observation period | Repeat runs; manual note |
| Address check | The host name passes the relay URL rule (04 §4) and resolves only to global addresses | Unit tests (name rule); the pool checks resolved addresses at connect |

## Verification
A table with the date, the Node version, one row per relay, and a verdict per check; "not run" where a check was skipped. Sign-off needs every check green for at least 2 relays (a single relay never reaches `sent`, 07 §4.2), the others noted.

## Failure and rollback
A relay that fails a check stays out of any new default list; the owner decides about removal. Nothing in the script changes state beyond the single test event, which relays may keep or drop.

## Related
`docs/foundation/00-README.md` D-75; `docs/foundation/07-sdk-transport-storage.md` §4.2, §4.3; `docs/foundation/04-security-and-crypto.md` §3.1.1, §4; backlog card M1-18.

## Results

**15 Oct 2026, Node 22, from the builder's machine (single run, one test event per relay).**

| Relay | Accepts 1059 | Read back by id | NIP-11 max message | NIP-42 | Retention |
|---|---|---|---|---|---|
| `wss://relay.damus.io` | yes | **no** (accepted, not returned by id; not yet tried with `#p` under AUTH) | 1 000 000 (ok) | not advertised | not measured |
| `wss://nos.lol` | yes | yes | 131 072 (ok) | not advertised | present at 0 min; longer not measured |
| `wss://relay.primal.net` | yes | yes | 1 000 000 (ok) | not advertised | present at 0 min; longer not measured |

Open: damus read-back by `#p`, retention at 10 min, 24 h and 7 days, and uptime are **not yet measured**; M1-18 is not signed off until they are.
