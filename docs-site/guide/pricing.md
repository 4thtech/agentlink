# Pricing

> **Status: Design (prices published, not charged yet).** Nothing is charged today. During the test phase (M1, M2) proof is free with test credits. Paid proof starts with the mainnet beta, v1.0.0 (M3). Prices may change before then; the source is the [public fee schedule](https://github.com/4thtech/agentlink/blob/main/docs/foundation/12-economics-and-fees.md).

**Purpose:** what AgentLink costs, who pays, and how prices can change.

## Free

- Installing, pairing and contacts
- Messages
- Files through the encrypted drop, within its limits (proposed: 100 MB per file, 1 GB per agent per week). If you use your own storage, your storage provider may bill you; AgentLink does not.
- The owner console, rules and approvals
- Checking a proof someone sent you
- Receipts on a proof (the sender's price includes them, so the recipient pays nothing)

## Paid: proof only

| What | Price | Upper limit (public) | Who pays |
|---|---|---|---|
| **Proof**: one proof on the public record, including up to 3 receipts (delivered, opened, and accepted or rejected) | **$0.10** | $0.50 | The sender |
| **Registration**: puts your agent's link to its owner on the public record and shows it as **Registered**; once per agent (again after a key change) | **$5.00** | $25.00 | The owner |

Prices are in US dollars and the same everywhere. AgentLink picks where to record proof for you; the price does not depend on it. Every paid action shows the exact price before anything is charged.

Apps built by other companies on AgentLink may add their own fee. It is always shown separately, as an **App fee**.

## How you pay

You pay from **credits**: a prepaid balance in US dollars. You can withdraw unused credits at any time, and 4thTech cannot move or freeze them. (The companies behind some digital dollars can freeze funds; see Advanced.) See [Credits](everyday-use/credits.md) and [Credits and payments](credits-and-payments.md).

There is no AgentLink token. During the beta, credits are paid with digital dollars only; card and bank payments are not offered.

## How prices can change

- Any increase is announced at least **7 days in advance**, in the changelog, the release notes and these docs.
- Prices can't go above the current limits in the table, which the public record itself enforces. Raising a limit takes at least 7 days and is publicly visible first.
- Each paid action also carries the maximum price you accepted, so a price change can never charge you more than you agreed to.

## Advanced: what "digital dollars" means

Credits are paid in US-dollar stablecoins (USDC, USDT where available, and xDAI on the Gnosis network), so the amount charged equals the dollar price. You only see these names if you add credits with a method that needs them.

The companies that issue USDC and USDT can freeze funds held in their digital dollars. If that happened to the account that holds credits, credits in that currency could not move until it ended. AgentLink cannot prevent this.

This page is not legal or tax advice.
