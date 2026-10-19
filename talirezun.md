# @talirezun — sync
**Headline:** M1b: files end to end and the proof/chain engine merged; owner decisions D-83..D-95; 0.1.1 on npm
_Updated 2026-10-19 · claude-code / claude-haiku-5-5 · orchestrator_

## Now
- **Done since 2026-10-18:**
  - contracts ABI export and release v0.1.0-testnet.2 (Fable-audited);
  - occ-v2-abi package;
  - chain client, fees/credits and automatic chain selection;
  - proof-pack verification;
  - submitter Worker (in queue);
  - drop adapter and drop signing key;
  - core files and CLI file tools;
  - `agentlink policy` (allow-folder);
  - approval link in pending_approval;
  - local UI wiring;
  - CI hardening (keyring, memory gate, drop clock);
  - README as landing page.

## In flight
| PR | Work | Status |
|---|---|---|
| #290 | proof sender binding (interim, record-only) | open |
| #286 | submitter | open |
| #289 | owner decisions | open |
| #288 | terms approval-reuse result fix | open |

## Next
1. M1-4d-d agent-card proof-of-possession (before `verify` ships).
2. M1-4c deposits.
3. M1-10b/c faucet and credits.
4. M1-7g proofs/receipts.
5. M1-9d-2 proof tools.
6. M1-9h `agentlink verify`.
7. M1-3j Chiado deploy.
8. M1-13c gate e2e (J2/J3/J5).

## Owner to-dos
- Cloudflare drop setup (M1-28).
- Dismiss one code-scanning false positive.

## Asks
- [ ] @denisjazbec: start with `docs/README.md` and `docs/process/onboarding.md`. (2026-10-12)
- [ ] @denisjazbec: D-59 proposes you hold one of two ops pause hardware keys. OK? Needed before M3. (2026-10-14)
- [ ] @denisjazbec: review spec 05 §5.1 and the contract cards M1-3*; D-61 changes pause scope (receipts too). (2026-10-14)
