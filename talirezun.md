# @talirezun — sync
**Headline:** M1b: 0.1.1 released (npm latest); 16 PRs merged 2026-10-18; files/proof engine built, wiring next
_Updated 2026-10-18 · claude-code / claude-haiku-5-5 · orchestrator_

## Now
- **Merged 2026-10-18:**
  - STREAM encryption;
  - revocation typed data;
  - storage multipart + streaming;
  - the drop deploy pipeline (awaiting owner Cloudflare setup);
  - the local approval UI (not yet wired);
  - the internal package rename to @4thtech-io/*;
  - CI hardening;
  - the docs pass (#263).

## In flight
| Task | Branch / PR | Status | Next step |
|---|---|---|---|
| Contracts ABI export job | contracts repo | in progress | export lands, then M1-3f |
| M1-3f ABI package | — | blocked | waits on the export; private, never published (D-83) |
| Spec gaps G-13, G-25, G-27 | — | waiting | owner decisions |

## Next
1. M1-4a chain client.
2. M1-7f / M1-7g files.
3. M1-9d tools.
4. Wire the local UI.
5. J2 / J3 / J5 gate coverage.

## Decisions (still relevant)
- D-80/D-81 rules confirmed.
- D-83 ABI package private and never published.
- D-84 streaming download quarantine.

## Asks
- [ ] @denisjazbec: start with `docs/README.md` and `docs/process/onboarding.md`. (2026-10-12)
- [ ] @denisjazbec: D-59 proposes you hold one of two ops pause hardware keys. OK? Needed before M3. (2026-10-14)
- [ ] @denisjazbec: review spec 05 §5.1 and the contract cards M1-3*; D-61 changes pause scope (receipts too). (2026-10-14)

## Heads-up
- OCC v2 is clean-room (D-20); no v1 code is copied.

## Feedback log
_(none yet)_

## Blocked on
- M1-3f ABI package: contracts repo export job.
- G-13, G-25, G-27: owner decisions.
