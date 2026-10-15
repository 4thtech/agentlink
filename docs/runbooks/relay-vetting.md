# RB-16 · Vetting the default relay set

## Purpose
Check each relay of the default set (D-75) against what AgentLink needs, and record a dated result, so M1-18 can sign off the relays before external testers arrive.

## When to use
Before the J9 dogfood and before external testers; whenever the default list changes (`packages/transport-nostr/src/default-relays.ts`); and about every quarter while the list is public relays. Not part of CI: it talks to live third-party relays.

## Who runs it
The orchestrator or a builder (Sonnet or above) on a machine with network access. The owner confirms the sign-off.

## Preconditions
- Dependencies installed and the packages built (`pnpm install`, `pnpm -r build`): the script imports `isAllowedRelayUrl` from `@agentlink/types` and `isGloballyRoutable` from `@agentlink/transport-nostr` (the functions the node relay connector uses), `nostr-tools` from transport-nostr and `ws` from `@agentlink/node`. Node 22 or later.
- Run from an empty scratch directory: the script writes `relay-vet-<time>.json` into the current directory.

## Steps
1. Print the plan without touching the network: `node tools/relays/vet.mjs`.
2. Run the checks: `node <repo>/tools/relays/vet.mjs --live` (or pass `wss://…` URLs to try other relays; every non-flag argument is treated as a relay URL). **Before any connection** each URL gets the 04 §4 relay address check: it must be `wss://`, pass the relay URL rule (a lowercase DNS name, no IP literal, no local name), and its host is resolved with every answer required to be globally routable. A URL that fails is reported as `refused` with a reason and is never contacted; the saved file of `--recheck` is checked the same way. The connection then goes to the checked address only (no second lookup), with no redirects, a 128 KiB frame cap and a 64 KiB cap on the NIP-11 document. Per relay it sends **one** tiny kind-1059 event of random bytes, signed by a throwaway key made for the run. The key is never printed or saved and no real key or envelope is used.
3. Record the dated table (below) in the PR or in `docs/process/` notes.
4. Retention: later (for example after 10 minutes, 24 hours and 7 days) run `node <repo>/tools/relays/vet.mjs --live --recheck relay-vet-<time>.json`. It asks each relay for the saved event id and says whether it is still there.
5. If a check fails, do not edit the list on your own; report it to the owner (a list change is a decision-log entry).

## Checklist (sign-off table)
| Check | Pass when | How the script checks it |
|---|---|---|
| Kind 1059 accepted | `OK true` for the test wrap | Publishes it and reads the `OK` |
| Read by `#p` (what the sync does) | The wrap comes back for `{kinds:[1059], "#p":[recipient], since}`, the exact shape of `sync.ts`, without AUTH, or after a NIP-42 AUTH the relay accepts (the script answers a challenge with the throwaway key, which is also the `p` recipient) | `REQ` with that filter; on an `AUTH` challenge it signs kind 22242 and asks again. This is the check that decides a relay, because sync never reads by id |
| Read by id (comparison only) | Informational | `REQ` with `ids`; some relays treat it differently from `#p` |
| Message size | NIP-11 `max_message_length` ≥ 90 112 bytes. Derivation: the largest valid wrap has a NIP-44 payload of 87 472 characters (04 §3.1.1), so the `EVENT` frame is that plus the event JSON (id, pubkey, sig, tags, kind, keys), about 88 KB; 90 112 is 88 KiB, which holds it with about 2 KB to spare. Our own inbound frame cap is 131 072. The card's older "≥ 64 KB" was below what a maximum wrap needs and is corrected | `judgeNip11` on `limitation.max_message_length`; absent is "unknown", test by hand |
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

**15 Oct 2026, Node 22, from the builder's machine. One tiny kind-1059 event per relay from a throwaway key (the second run, with the sync's `#p` filter and AUTH attempt).**

| Relay | Accepts 1059 | Read by `#p` + `since` (sync's filter) | Read by id | NIP-11 max message | NIP-42 AUTH |
|---|---|---|---|---|---|
| `wss://relay.damus.io` | yes | **no**: `auth-required: requested filter requires authentication` | no | 1 000 000 (ok) | challenge sent; our login refused: `relay needs serviceUrl to be configured before AUTH can work` (tried with and without a trailing slash on the relay URL) |
| `wss://nos.lol` | yes | yes | yes | 131 072 (ok) | no challenge; open reads |
| `wss://relay.primal.net` | yes | yes | yes | 1 000 000 (ok) | no challenge; open reads |

**Outcome: damus is dropped (D-75).** The owner chose nos.lol, relay.primal.net, relay.snort.social and nostr.mom, in that order. **damus failed the sync read**: it demands AUTH for a `#p` query, then refuses every login because of its own configuration, so a sync against it returns nothing. Publishing works. This is a relay-side fault that may be fixed; re-run before relying on it. 

Not yet measured for the final four: retention beyond 0 minutes (use `--recheck` after 10 minutes, 24 hours and 7 days) and uptime. M1-18 is not signed off until the damus decision and retention are done.

### Replacement candidates for damus (15 Oct 2026, same checks, one tiny event each)

| Relay | Accepts 1059 | Read by `#p` + `since` | Read by id | NIP-11 max message | NIP-42 AUTH |
|---|---|---|---|---|---|
| `wss://nostr.mom` | yes | yes | yes | 131 072 (ok) | none, open reads |
| `wss://relay.snort.social` | yes | yes | yes | 524 288 (ok) | none, open reads |
| `wss://offchain.pub` | yes | yes | yes | 131 072 (ok) | none, open reads |
| `wss://relay.nostr.band` | no: connection error, NIP-11 timed out | no | no | unknown | unknown (looks down; re-run later) |
| `wss://nostr.oxtr.dev` | yes | yes | yes | 131 072 (ok) | none, open reads |

Retention and uptime are not measured for any of them. The owner chose nostr.mom and relay.snort.social from this table.
