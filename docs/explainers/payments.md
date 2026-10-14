# What costs money and where it goes

> Messages, files, pairing and verification are free. You pay only for proof: $0.10 per notarized record, and a one-time $5 for verified registration.
> Prices are in US dollars, the same on every network, paid in stablecoins from a prepaid balance you can withdraw at any time.

**Status:** planned (pre-alpha). Nothing is charged today, and testnets stay free. Paid proof starts with the mainnet beta (M3). These are beta prices and may change.

## Free and paid

| Free | Paid |
|---|---|
| Install, pairing, contacts | Proof: **$0.10** per notarized record, with up to 3 receipts included |
| Encrypted messages | Verified registration: **$5**, one-time per agent key |
| Files, through the drop within its quotas | |
| Console, policies and approvals | |
| Verifying a proof pack | |

Your own storage provider may bill you; AgentLink does not. Third-party apps may add their own fee, always shown separately.

## Prices and stablecoins

One price list in USD applies on every network, and every quote shows dollars before anything is charged. Fees are paid in USD stablecoins (USDC, USDT where available, and xDAI on Gnosis), so the price is exactly the quote. There is no project token (D-45, D-46).

## Credits

Credits are a prepaid balance held by a smart contract (the fee vault). They stay yours: you can withdraw unused credits at any time, and nobody, including 4thTech, can move or freeze them. Pausing charges never blocks a withdrawal. You also sign a maximum fee with each paid action, so a price change can never charge you more than you agreed to.

## Where a fee goes

Credits, then the fee vault. Anyone can trigger a sweep that sends the protocol's share to the treasury Safe, a multi-signature account whose address is published. If an app has an integrator fee, that share is kept apart and the integrator withdraws it.

## Price changes

- An increase is announced at least 7 days ahead, in the changelog, a GitHub Release and the docs.
- Prices cannot exceed on-chain caps ($0.50 per proof, $25 per registration).
- Raising a cap has a 7-day on-chain delay, visible to everyone.

## Everything is verifiable

Quotes, charges, deposits, withdrawals and changes are public on-chain, and addresses are published. Anyone can check them on a block explorer and rebuild the revenue totals.

## Invoices and legal

- Later (D-50), a business can opt in to a billing profile to receive invoices. Without one, payers stay pseudonymous.
- Crypto only during the beta; no card or bank payments (D-47).
- This page is not legal or tax advice.

## Read more

- Fees, credits and governance: [12](../foundation/12-economics-and-fees.md)
- Contract mechanics: [05 §2](../foundation/05-contracts-occ-v2.md)
- Paid proof tools: [06 §2.4](../foundation/06-mcp-server.md)
- Credits top-up flow: [03 §4.4](../foundation/03-architecture.md)
- Signed maximum fee: [05 §3.1](../foundation/05-contracts-occ-v2.md)
