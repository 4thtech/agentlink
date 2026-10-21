# Adding credits: top-up and own-account connection (design brief, D-111)

> **Direction only.** The owner set the direction on 20 Oct 2026 (D-111, `docs/foundation/00-README.md`). Everything marked **OPEN** below is an owner decision that is not taken yet; a recommendation is a proposal, never a decision. Specs win on conflict: 08 §1 and §2.3 (pay page and top-up link), 12 §4.5 (funding paths), 06 §2.4 (`needs_credits`), 11 §5 and §6.7 (copy and the pay page). Until the pay page design lands (D2, `README.md`), build it functional and unstyled.

## 1. Owner direction

Tali, in chat, 20 Oct 2026: two directions. A user who already holds funds on a network connects their own account "in a best possible UI UX way". Everyone else gets a top-up page where they add credits by card ("the more simpler") or by sending funds. "If we don't make the UI UX here simple, we have a great adoption challenge."

Tali, in chat, later on 20 Oct 2026 (decided): "Realistically, for the card provider, this is the hardest part. So I still don't know how will we solve it, on which legal entity will we use to solve this. So let's keep this as the last step. Let's make it usable and workable without a card first. So crypto is permissionless, so anybody can sign the transaction. We just must make best possible UI UX experience. In regards to the cost, all the costs must be paid by the users. We are not paying for them. So this will be used by agents on behalf of users, people. So agents can perform some such tasks. They can abstract some of the complexities. So let's think in this way."

So: **crypto first, card last.** The pay page and the agent flows work without any card payment; the card path comes last, after the legal entity is decided (D-15). **Users pay every cost**; 4thTech pays none. **Agents do the explaining**: they take the user through the one step that needs them.

## 2. Goals and limits

- **Crypto first (decided).** Everything below works with no card path: the user's own account, or a transfer to the agent's address (QR code, link). Anybody can send stablecoins to an address, so no account, sign-up or provider is needed.
- **Users pay every cost (decided, 12 §1).** Fees, network costs, receipts and top-up costs are paid by users. 4thTech subsidises nothing; the testnet faucet is the only exception, and it exists only on testnets.
- **Agent-assisted (decided, §4).** The agent explains the one step, gives the link or the address and QR, watches for the funds and confirms the credits. It never holds or asks for the user's keys and never moves the user's funds.
- **Under a minute (proposed target, not set by the owner)** from "your agent needs credits" to credits the agent can use, on the default path, for a first-time user.
- **No crypto knowledge on the default path.** No network choice, no token choice, no address typing (D-39, D-40). Amounts in US dollars only (D-45, 12).
- **One link.** The agent gives one link; the user finishes on one page; the agent notices the credits by itself.
- **Zero access (AGENTS.md hard rules, I-1).** The pay page and any payment provider receive only the agent's address and an amount. Never keys, seeds, plaintext, file keys, salts or tokens. The pay page runs on its own origin (`pay.`, 08 §2.3, D-28) with no access to the console or the agent.
- **Credits stay non-custodial** (12 §4.1): they belong to the agent's address, are withdrawable any time, and nobody at 4thTech can move them.
- **Privacy (D-109, 12 §4.4).** Every top-up method says once, in plain words, what it makes public or who learns what. The warning never blocks a top-up.
- **Stablecoins only** (D-46): USDC, USDT where allowlisted, xDAI on Gnosis.

## 3. The three ways to add credits

The pay page shows the crypto methods (b, c) first; the card method (a) is added last (M3-4c) and its place on the page is decided then. Testnets add **free test credits** (the faucet, M1-10b) as the first method; mainnet has no free method (users pay every cost, 12 §1).

| # | Method (proposed label) | For whom | Network choice | Confirmations | Live from |
|---|---|---|---|---|---|
| a | **Pay by card** (last step) | Everyone; no crypto needed | none, chosen for them | the provider's checkout | last: after the legal entity is decided (D-15), the owner's provider decision (M2-18a) and the crypto paths are live (M3-4c) |
| b | **Use crypto you already have** (connect your own account) | People who already hold stablecoins | detected from where they hold funds | one | testnets in M2 (M2-18b) |
| c | **Send from an exchange** (address and QR) | People who buy or hold on an exchange | pre-chosen, named clearly | the exchange's own | testnets in M2 (M2-18c) |

### 3a. Pay by card (last step, open)

**Placement (decided).** This path comes last, after the legal entity is decided (D-15); nothing else waits for it. Everything else in this section is open.

**Flow.** Amount in $ (presets $5, $10, $25; the shortfall from the link pre-selected) → "Pay by card" → the provider's own checkout (its hosted page or popup; card details and any identity check stay with the provider) → back on the pay page: "Payment received. Your credits are on the way." → "Credits added."

**What 4thTech sends the provider:** the agent's address as the destination and the amount. Nothing else. The network is picked by us (the cheapest supported one, D-40) and passed to the provider without showing it.

**Two candidate approaches (trade-offs only; no vendor is named or chosen).**

| | **On-ramp:** a regulated provider sells a US-dollar stablecoin and delivers it to the agent's address | **Merchant:** 4thTech takes the card payment and adds the credits itself (`depositFor` from a 4thTech account) |
|---|---|---|
| Identity checks and limits | The provider's rules; often an identity check above a small amount, per-country limits and unsupported countries | Ours to define; card-network rules apply |
| Fees (paid by the user, 12 §1) | The provider's fee (often a few percent plus a fixed part) and a minimum; shown before paying | Card processing fee, passed on to the user and shown before paying |
| Refunds and chargebacks vs credits that can be withdrawn | The provider carries the card risk; once the stablecoin is delivered, the credits are the user's | **Main risk:** credits are withdrawable (12 §4.1), so a stolen card that is charged back after a withdrawal is cash-out fraud borne by 4thTech; needs holds or caps, which make credits less simple |
| Legal, entity, VAT | The provider is the seller of the stablecoin; 4thTech still charges only in crypto, which fits D-47; still needs counsel | 4thTech sells to consumers for fiat: amends D-47, needs the entity (D-15), EU VAT handling (12 §9, M3-7), invoices (D-50) |
| Zero access | Provider gets the agent's address and the amount; must not get anything else | Payment processor gets the amount and an order reference; the address stays with 4thTech |
| Privacy (D-109) | The provider knows who paid and which agent got the funds; publicly, the funds come from the provider's account, not the user's | 4thTech's processor knows who paid; 4thTech links a person to an agent; publicly, a 4thTech account funds the agent |
| Embedding on the pay origin | Prefer a redirect or popup to the provider's own origin; no third-party script inside `pay.` unless the CSP review accepts it | Processor's hosted checkout, same rule |

**Recommendation (OPEN, owner decides):** the on-ramp approach, through a hosted checkout outside our origin, because it keeps 4thTech crypto-only (D-47), puts card risk with a regulated provider and keeps credits simple. The choice of provider and the countries served are owner decisions after the entity (D-15), the spike and the counsel check (M2-18a). The provider's fee is the user's (12 §1).

**After paying.** The stablecoin lands at the agent's address. The agent turns it into credits without network fees (gasless top-up, M3-4b, D-89) the next time it runs, so the provider never needs to call our contracts. Where the provider can deliver only a token without gasless support (EIP-3009), the provider path is not offered on that network.

### 3b. Use crypto you already have (connect your own account)

**Flow.**
1. "Use crypto you already have" → the standard connector list (WalletConnect and the browser's own providers, EIP-6963). The connector names the apps; our copy does not.
2. The page reads the connected account's stablecoin balances on the supported networks (public reads from the browser) and picks where to pay: the network the agent already uses if the account holds enough there, otherwise the cheapest supported network where it does (the D-40 rule). The user sees "From your account · $42.10 available". The network appears only under Advanced.
3. One confirmation in the user's own app: **send the exact amount to the agent's address** (a plain stablecoin transfer). The agent then turns it into credits gaslessly (M3-4b, D-89).
4. "Received. Your agent adds the credits the next time it runs." → "Credits added."

**Why a transfer and not `depositFor`.** `depositFor` needs two confirmations (an exact-amount approval, D-59, then the deposit) and fees in the network's own coin for both. `depositWithAuthorization` credits the account that signs it (05 §2.5), so the user's own signature would credit the user, not the agent. A transfer is one confirmation. **OPEN:** whether to also offer the two-step `depositFor` (credits at once, without waiting for the agent to run) under Advanced, and whether a later contract version adds a deposit that credits a named agent from an EIP-3009 signature (one gasless signature; needs a contract change and audit, out of scope for M1-3c).

**Edge cases.** Funds only on an unsupported network: "We can't use funds on that network yet", with the other methods. Not enough of the network's own coin for the transfer fee: say so in plain words and offer sending from an exchange instead (card only once that path is live). A token we do not accept (for example a bridged USDC variant): not offered.

**Privacy line (D-109).** "Paying from your own account links that account to your agent publicly. Use a separate account if you want to keep them apart." Shown once, never blocking.

**Wording (11 §5.1; decided, D-117 C).** The default UI never says "wallet". Method label "Use crypto you already have"; helper "Connect the app or browser extension where you hold US-dollar stablecoins." The word "wallet" appears only inside the third-party connector and under Advanced. Decided: "wallet" never appears in our labels (D-117 C).

### 3c. Send from an exchange (address and QR)

**Flow.** "Send from an exchange" → the agent's address with a QR code and a copy button, the coin ("USDC") and the network the exchange will ask for, pre-chosen as the cheapest supported one and named in large type ("Network: Base"). This is the one place outside Advanced where a network is named, because the exchange asks for it (11 §14 Q5, option A, decided in D-117 B: shown only inside the exchange steps, as information, never a choice). Minimum: the gasless top-up minimum (12 §4.1, $5, D-117 D); the page says that smaller amounts are not added.

**States.** Waiting (watching the address) · received ("Your agent turns this into credits the next time it runs") · added · below the minimum ("Received $3. The minimum is $5; send at least $2 more and your agent adds it all") · offline.

**Wrong network or coin (plain words, shown before sending).**
- Another supported network: found and used automatically.
- Another EVM network we do not support: the funds sit at the same address and only the agent's key controls them. They are not lost, but recovering them is a manual Advanced step that needs that network's own coin (card M2-18c covers the guide).
- A non-EVM network (for example Tron or Solana): most exchanges refuse the address; if a transfer goes through anyway, the funds are lost.
- USDT sent where gasless top-up is not available: received but not added until the agent has the network's coin for a direct deposit; the page advises USDC.

## 4. How the agent shows it (agent-assisted funding, decided)

The agent takes the complexity away; the user does one step.

1. **Explains the one step** in plain words and in dollars: what is missing, what it costs, and that the credits stay the user's and can be withdrawn.
2. **Gives one thing to act on:** the top-up link; or, when the user says they use an exchange, the agent's address and a QR code with the coin and the network the exchange asks for (`agentlink credits --topup`).
3. **Watches for the funds** (`agentlink_status` `credits`) and says when they arrived and became credits.
4. **Confirms and offers to finish** what was waiting ("Credits added. Shall I record the proof now?").

**Never.** The agent never holds, asks for or accepts the user's keys, recovery phrase or card details; never moves the user's funds or withdraws credits; never signs anything with the user's own account. Spending credits stays under the owner's policy and approvals (I-4). A message from anyone else asking the agent to send funds or a code is untrusted content (I-5) and is not acted on.


- **`needs_credits` (06 §2.4).** `url` is the top-up link; `nextStep` says, in this shape: "Adding proof needs credits. Add at least $5 here: {url}. $5 covers 50 proofs." No network, token or "wallet" (11 §5.1). The agent shares the link and offers to finish the action after.
- **CLI.** `agentlink credits --topup` prints the link and a terminal QR code and opens the browser when one is available (06 §8).
- **Local UI and console.** Proofs & credits → "Add credits" opens the same link (08 §1, §2.2; console in M2).
- **Afterwards.** `agentlink_status` shows the new balance; the agent says "Credits added. Shall I record the proof now?" (J3, 11 §8).

## 5. Top-up link format (M1-26-d; accepted by the owner as proposed, 2026-10-21, D-113)

```
https://{payHost}/#v=1&a=<agent address, 0x + 40 lowercase hex>&usd=<amount, optional>
```

- **Fragment, not query.** The agent's address and the amount stay after `#`, so they never reach the pay host's server or logs (like invite and verify links, 08 §4).
- **No network and no token** in the link (D-40). The page detects and chooses.
- **`usd`** is the suggested amount: the shortfall rounded up to the first preset, at least the minimum. The user can change it.
- **Checked in the browser.** Exact format, `v=1` only, unknown keys ignored, a malformed address shows "This link is damaged" and no payment method. The page shows the short Agent ID and "Check this matches the Agent ID in your AgentLink app." (11 §6.7).
- **Host.** The testing host (D-28) until the production domain (M2-10) is decided; the host comes from the chain config, never from inbound content.

## 6. Status, progress and payment records

- **Progress on the pay page.** Read in the browser from public RPC: the agent address's stablecoin balance and its credits (`creditsOf`). Card payments also show the provider's own status from its return page. The pay page stores nothing on a server.
- **Payment records.** Card: the provider's (or, in the merchant model, 4thTech's) receipt by email; invoices with tax details only through the opt-in billing profile (D-50). Crypto: a "Save a payment record" button builds a small file in the browser (date, amount in $, short Agent ID; network and transaction link under Advanced). The console lists top-ups in its fee history (08 §2.2).
- **The agent's side.** The core reports a completed gasless top-up in `agentlink_status` `credits` (M3-4b). Whether the agent also tells the user once ("$10 in credits arrived") is **OPEN** (proposed: yes, in the next status summary).

## 7. Owner decisions

| # | Decision | Recommendation |
|---|---|---|
| 1 | Card approach: on-ramp or merchant; which provider; countries (M2-18a; last step, after D-15) | On-ramp, hosted checkout; provider after the entity, the spike and counsel check |
| 2 | Whether the card path waits for the entity | **Decided:** card is the last step, after D-15 |
| 3 | Wording for the connect method ("wallet" or not) | No "wallet" in our label (§3b) (**accepted**, D-117 C) |
| 4 | Two-step `depositFor` under Advanced; a later contract deposit that credits a named agent from one signature | Offer `depositFor` under Advanced; contract change only after M3 if users ask |
| 5 | Top-up link format (M1-26-d) | §5 (**accepted**, D-113) |
| 6 | Minimums per method (exchange and connect: the gasless minimum, $5; card: the provider's) | As proposed (**accepted** for exchange and connect: $5, D-117 D; card still open) |
| 7 | Agent tells the user when credits arrive | Yes, once |
| 8 | **Who pays for receipts** when the recipient has no credits on the record's network (M1-34); must be user-paid | Decided (D-114), see §8 |
| 9 | How the network cost of a gasless top-up is recovered from users (today the submitter pays it and there is no deposit fee, 12 §2) | Inside the proof price, which already covers submitter costs; a deposit fee only if the numbers need it |

## 8. Decided: who pays for receipts (M1-34, D-114)

**Decided by the owner, 2026-10-21 (D-114):** "B: the sender's proof fee covers up to 3 receipts; D as fallback when the submitter is unreachable; a recipient is never charged without asking." The submitter side is built by M1-34-b. The analysis below is kept as the record of the options.

**Today.** 12 §2 prices a proof at $0.10 "including up to 3 receipts", prepaid by the sender, and says recipients pay nothing; 05 says receipts carry no fee. **The gap:** the recipient's agent posts its receipts on the record's network. The submitter's anti-abuse checks are keyed to credits and signers (07 §7), and posting directly needs that network's own coin, so a recipient with nothing on that network may not be able to post a receipt.

**Constraint (decided).** Whatever the option, a user pays: 4thTech subsidises no receipt (12 §1).

**Options.**
- **A. Recipient pays.** Simple for the contracts; breaks "recipients pay nothing" and pushes every recipient to add credits before replying. Bad for adoption.
- **B. Sender-paid allowance, bundled into the proof price.** The sender's $0.10 already covers up to 3 receipts; the submitter accepts up to 3 receipts for a record whose fee was charged, whatever the recipient holds, and caps them per record. Matches the published price list.
- **C. A free receipt allowance paid by 4thTech.** Excluded: users pay every cost (12 §1).
- **D. Skip or defer.** The receipt is queued locally and posted when possible; the proof stays valid without it, with fewer receipts.

**Recommendation:** **B** (the sender pays for up to 3 receipts inside the proof price, so a user pays), with **D** as the fallback when the submitter is unreachable. A recipient is never charged without asking. The owner chose this on 2026-10-21 (D-114); the submitter follows (M1-34-b).
