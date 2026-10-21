# @talirezun — sync
**Headline:** Proofs live end to end on testnet (submitter in production); Chiado contracts smoke-tested; 20+ PRs merged.
_Updated 2026-10-21 · claude-code / claude-opus-5-5 · orchestrator_

## Now
- **Submitter live on Base Sepolia.** Chiado smoke passed.
- **Merged:**
  - receipts off by default, plus receipt requests;
  - privacy notices;
  - proof-mismatch flags;
  - delete-on-receipt and a per-file delete setting;
  - faucet hardening;
  - CI catch-up deploys.
- **Decisions D-112 to D-116:** free messages and files; top-up link format; receipts payer; backup and restore; design exists and needs adjusting.

## In flight
- **Merge queue (open):** #341, #344, #348, #350, #351, #352, #353, #354, #355, #356.
- E2e and prompt-injection suites building.

## Next
1. Design adjustment audit (DESIGN-ADJ-1) and UI tokens.
2. Backup and restore code cards (M1-9i-a/b/c).
3. Chiado auto-selection (M1-3j-b).
4. Release 0.1.3 when the owner says.
5. M1 gate cards.

## Owner to-dos
- Redesigns from the design audit briefs.
- Chiado submitter keys and xDAI.
- E2e API-key secrets.
- M1-23 dogfood with Denis.
- Trademark check (M1-24).

## Asks
- None for @denisjazbec.
