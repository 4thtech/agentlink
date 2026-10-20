# 12 — Economics and Fees

**Public and normative** for clients, contracts and docs. Decisions: D-45 (economic model), D-46 (stablecoin-only fees, amends D-04), D-47 (crypto-only charging during beta), D-40 (automatic chain choice). Contract details: 05 §2, §5. Client details: 07 §6.

> **Beta prices, not live yet.** Nothing is charged today. Paid proof starts with the mainnet beta (M3); until then testnets are free.

---

## 1. Principles

1. **Free to start.** Install, pairing, messages and files cost nothing and need no balance (files within the encrypted drop's quotas, §2).
2. **Pay only for proof.** Fees apply only to on-chain actions.
3. **Token-less.** There is no project token. Fees are paid in established USD stablecoins.
4. **Priced in US dollars.** Every quote is shown in dollars before any paid action.
5. **One price on every chain.** The client picks the proof network automatically (D-40), so the price must not depend on it.
6. **Bounded and transparent.** Hard caps on-chain, a public schedule, advance notice of increases, and quotes anyone can check.
7. **Non-custodial.** Prepaid credits stay yours and can be withdrawn at any time.

---

## 2. Fee schedule (beta)

| Action | Fee type (05 §2.1) | Price | On-chain cap | Who pays |
|---|---|---|---|---|
| **Proof**: one notarized record, including up to 3 receipts (delivered, opened, accepted *or* rejected) | `NOTARIZE` | **$0.10** | $0.50 | Sender |
| **Verified registration**: one-time per agent per key epoch (a key rotation registers again, 05 §4) | `REGISTER` | **$5.00** | $25.00 | Owner |
| Batched receipts | `ANCHOR` | Not yet offered (M4) | — | — |
| Deal record transitions | `DEAL` | Not yet offered (M5) | — | — |
| Arbitrator disclosure | `DISCLOSE` | Not yet offered (M5) | — | — |

Prices are the protocol fee charged through official clients. A third-party app may add its own fee, always shown separately (§5).

**Free:** install, identity, pairing, contacts; encrypted messages and off-chain acknowledgements; sending files, through the 4thTech encrypted drop within its quotas (proposed 100 MB per file and 1 GB per agent per week, D-48) or through your own storage (your provider may bill you); owner console, policies and approvals; verifying a proof pack (CLI and public page); fee quotes and credit balances; receipts on a notarized record (prepaid by the sender, so the recipient pays nothing).

**Network costs.** For proofs and receipts sent through a submitter, the submitter pays the network cost (gas) and recovers it from protocol fees; there is no extra charge. Calls you make yourself (direct mode, a deposit from your own account, a withdrawal) pay the network's own cost from the calling address. AgentLink adds no fee to deposits or withdrawals.

**Files.** The encrypted drop needs no setup and no payment. Its cost (Cloudflare R2, about $0.015 per GB-month with free egress; objects live at most 7 days) is borne by 4thTech. Paid larger quotas are a possible later option, not offered now (`DECISION NEEDED (owner)`, later). Above the quotas, or for longer retention, users connect their own storage (02 F-32, F-36).

**Testnets:** free. A 4thTech faucet credits testnet agents through `depositFor` (05 §9). Testnet credits have no value.

---

## 3. Fee tokens (D-46)

### 3.1 Launch: stablecoins only

| Token | Where | Notes |
|---|---|---|
| USDC | Each supported chain where an issuer-listed USDC exists | Gasless top-up (EIP-3009) only where proven for that exact token |
| USDT | Where an issuer-listed USDT exists | Generally no EIP-3009 |
| xDAI | Gnosis only | Gnosis's native coin, USD-pegged; `address(0)` in the vault |

Each token is valued at **$1 per unit**, so the fee in token units is exactly the USD price (amount = USD × 10^decimals). No oracle, no price feed, no repricing.

### 3.2 Allowlist rules (per chain)

A token is allowlisted only if all of these hold, each checked by a re-runnable script whose output cites the source and date:

- the address appears on the **issuer's official list** for that chain (Circle, Tether), or is the chain's native coin (xDAI on Gnosis);
- `decimals()` and `symbol()` match the config;
- no **fee-on-transfer** or rebasing behaviour (the vault credits the measured balance change and never allowlists such tokens, 05 §2.5);
- the **EIP-3009 flag** is set only when `receiveWithAuthorization` is proven on a fork for that exact token (bridged variants may lack it).

**Issuer risk.** USDC and USDT issuers can freeze addresses. If an issuer froze the vault, credits in that token could not move until it is unfrozen. AgentLink cannot prevent this. Removing a token from the allowlist stops new deposits and charges in it; existing credits in it stay withdrawable.

### 3.3 Why native volatile coins are excluded

A fee fixed in ETH (for example) drifts with the ETH price. Keeping it at $0.10 would need frequent repricing by an admin or an on-chain oracle. That adds trust and oracle risk, conflicts with advance notice of price changes, and makes USD display depend on a third-party price endpoint. Stablecoins avoid all of this.

### 3.4 Later: native coins behind a bounded price updater

Native volatile coins may be added later (M4) behind a separate, bounded **`PRICE_UPDATER`** role: it could only move a native-coin fee within a narrow band around the USD price, at a limited rate, and never above the cap. It needs a contract design, a security review and an external audit delta before any native volatile coin is allowlisted. `DECISION NEEDED (owner)`: whether to offer native coins at all.

---

## 4. How a fee is charged

1. **Quote.** The client calls `OCCFeeVault.quote(feeType, token, appId)` and shows the result in USD: protocol part, integrator part, total (07 §6.2).
2. **Signed maximum.** The payer signs `maxFee` inside the `Record` (05 §3.1) or `Registration` (05 §4). If the fee at inclusion is higher, the charge reverts (`FeeAboveMax`). A price change can never charge more than the payer signed.
3. **Payment.** From credits (default) or by direct payment.
4. **Split.** The protocol part accrues to the treasury; the integrator part accrues to the app's integrator (§5).

### 4.1 Credits (non-custodial)

Credits are a prepaid balance per payer (the agent, or the owner for registration), per chain and per token, held by `OCCFeeVault` (05 §2.5):

- **Top up:** `deposit` (your own account), `depositFor` (anyone can top up any agent: the owner console, the testnet faucet, promotions), or **gasless USDC**: send USDC to the agent address; the agent signs an EIP-3009 `receiveWithAuthorization` with the vault as payee and a submitter submits it.
- **Minimum gasless deposit:** `minDeposit` per token prevents griefing of the sponsored submission. **Proposed: $5** (in token units), confirmed in the fee configuration (M3-3).
- **Withdraw any time:** `withdraw` returns unused credits. No admin function can move, freeze or reduce a payer's credits, and pausing never blocks withdrawals.

### 4.2 Direct payment

Without credits, a payer can call the module's direct function (e.g. `notarizeDirect`) and pay in the same call. The payer pays the network cost.

### 4.3 Protocol and integrator split

| Part | Goes to | Collected by |
|---|---|---|
| Protocol fee | `protocolAccrued[token]` | `sweep(token)` to the treasury Safe (anyone may call it) |
| Integrator fee | `integratorAccrued[appId][token]` | `withdrawIntegrator` by the app's integrator |

Official clients use `appId = 0`: no integrator fee.

---

### 4.4 Funding and privacy (D-109)

Every top-up is public and links the paying account to the agent: `Deposited` names the payer and the account that paid, a gasless USDC top-up shows the account that sent the USDC, and `notarizeDirect` needs network fees in the agent's own account, so whoever funded it is visible. One account that tops up several agents links them to each other. If that account is a personal or exchange account, it can tie the agent to a real person.

- **Default path.** Credits through the submitter (§4.1) are the default; the submitter's own account pays the network fee, so the agent's funding is not visible per proof.
- **User guidance (11 §5.6).** The top-up screens and the user guide say that the account a top-up comes from is publicly linked to the agent, and suggest free test credits on testnets, a separate account used only for AgentLink top-ups, and gasless top-ups from that account. The warning is plain and short, appears once per top-up method and never blocks a top-up.
- **Owner console.** `depositFor` from the console uses the account the owner chooses; the console suggests a dedicated top-up account and never defaults to a personal one.
- **Billing profiles** stay off-chain and opt-in (§7.1); nothing about them is published.
- **Later.** Per-relationship signing addresses (04 §5.1, M2-17a) must not be funded per address, since each deposit would link it.

## 5. Integrator fees

A third-party app registers with `registerApp` and sets its own fee per fee type and token. At charge time the integrator part is capped:

> integrator part = min(integratorFee, `integratorFeeCapMultiple` × protocol fee)

The multiple defaults to **4** and can never exceed **10** (a contract constant). With a $0.10 proof fee and multiple 4, an app can add at most $0.40.

- Every quote shows the integrator fee **separately** from the protocol fee, in USD.
- `FEE_ADMIN` can deactivate an abusive app (its charges revert) but can never move integrator balances.

---

## 6. Changing prices (governance)

| Change | Who | On-chain delay |
|---|---|---|
| Set a fee within its cap (up or down) | `FEE_ADMIN` (4thTech Safe) | None |
| Lower a cap | `FEE_ADMIN` | None |
| Raise a cap, or change the integrator multiple | `CAP_RAISER` (Safe) | **7 days** |
| Allowlist or remove a fee token, set `minDeposit` | `CONFIG_ADMIN` (Safe) | 48 h |
| Change the treasury | `TREASURY_ADMIN` (Safe) | 7 days |
| Pause charging | `PAUSER` | None; **never blocks withdrawals** |
| Register a module, upgrade a contract (proposed, G-3) | `MODULE_ADMIN`, `UPGRADER` (Safe) | **7 days**; the notice tells users to withdraw and revoke token approvals |
| Remove a module (proposed, G-3) | `PAUSE_ADMIN` (Safe) | None; only reduces power |
| Unpause (proposed, G-3) | `PAUSE_ADMIN` (Safe) | None |

**Public price policy** (D-45; a commitment, not enforced on-chain):

- Every **price increase** is announced **at least 7 days** before it takes effect, in the `CHANGELOG`, a GitHub Release and these docs.
- A **price decrease** may take effect immediately; it is announced the same way.
- The on-chain cap is the hard limit. Raising it is visible on-chain for 7 days before it can execute.

The signed `maxFee` (§4) protects every payer even if a change happens between quote and inclusion.

---

## 7. Transparency

- **Verifiable quotes.** `quote()` is a public view function; anyone can compare it with what a client shows.
- **USD in every quote.** The price list in `agentlink_status` (06 §2.1, D-53) and every paid-action result show the price in USD before anything is charged.
- **Published configuration.** At each deployment, 4thTech publishes per chain, in these docs and in the in-repo `@4thtech-io/occ-v2-abi` (private, bundled into the CLI, D-83): contract addresses, treasury Safe address, allowlisted fee tokens (with issuer source), fees, caps, `minDeposit` and the integrator multiple. Each entry can be checked against the chain.
- **Permissionless sweep.** `sweep` can be called by anyone and only ever pays the published treasury.
- **Events.** Every charge, deposit, withdrawal and configuration change emits an event (05 §6).

### 7.1 Revenue flow, reporting and invoicing (D-50)

- **Flow.** Each charge emits `Charged` (05 §6). The protocol part accrues in `OCCFeeVault` per chain and token; anyone can `sweep` it to the published treasury Safe on that chain (§4.3). Integrators withdraw their own part. Fees are stablecoin-only (D-46), so revenue is already in US dollars.
- **Reporting.** During beta, 4thTech builds a monthly revenue report from public events only (`Charged`, `Deposited`, `Withdrawn`, `Swept`, per chain), checked against explorers and the Safe. Anyone can rebuild the same figures from the chain. After beta, an internal read-only dashboard indexes the same events; it holds no keys, and fee or treasury changes still go through the Safe (§6).
- **Invoices on request.** A business that needs invoices creates an opt-in **billing profile**: it signs once with its owner key (an owner operation, never an MCP tool) to link its agent addresses to its billing details, and its on-chain charges can then be invoiced. Without a profile, payers stay pseudonymous. Registered agents (OCCRegistry, M2) and verified domains (D-34) help match agents to the business. Billing details are held only by 4thTech operations and never include message or file content, so zero access holds. Counsel reviews data protection and VAT before invoices are issued (§9, D-47).
- **No fiat.** Card and bank payments stay out of scope until the legal questions in §9 are settled.

---

## 8. Cost model (why $0.10)

All figures are **estimates** and move with network prices.

- **Network cost per proof.** A record plus up to three receipts uses at most about 170k + 3 × 75k gas (05 §3.4 targets). On Base and Gnosis this is about **$0.001–0.01** per record.
- **Who carries it.** The submitter sponsors that cost and recovers it from protocol fees, together with running the submitter, the faucet, audits and the bug bounty.
- **Files.** The encrypted drop's storage cost (R2, about $0.015 per GB-month, free egress, at most 7 days per object) is borne by 4thTech; files are free within the quotas (§2, D-48).
- **What you buy.** A proof is not a bare timestamp. It can be a **proof of agreement**: the sender's signature over the exact content hash, plus the recipient's signed receipts for delivery, opening and acceptance, so an accepted record shows that both sides assented to the same terms. Anyone can check it without trusting 4thTech. (It does not by itself establish legal enforceability, 02 F-43.)
- **Why a fixed price.** One flat USD price is easy to budget (policies use `dailyBudgetUSD`, 06 §3) and does not change with short-term network congestion.

---

## 9. Payments and legal stance (D-47)

- **Crypto only during beta.** Fees are paid in the stablecoins in §3. There is no card or bank payment.
- **Operating entity:** to be decided (D-15); intended to be outside the EU.
- **Tax.** Counsel will assess tax and VAT treatment, including for consumers in the EU, before the paid mainnet launch (M3-7). Paying in crypto is not assumed to change the tax treatment.
- This document describes the protocol and its fee mechanics. It is **not legal or tax advice**.

---

## 10. Promotions (optional)

`DECISION NEEDED (owner)`: whether to offer **welcome credits** on mainnet, funded from the treasury through `depositFor`.

Sybil considerations:

- Agents are free to create, so per-agent grants can be farmed.
- Credits are withdrawable by design, so a grant is equivalent to cash and can be cashed out.
- Mitigations to weigh: small amounts (e.g. a few proofs), grants only after verified registration, invite or partner codes, per-owner limits and a fixed total budget. A non-withdrawable promotional balance would need a contract change and a security review.

---

## 11. Open decisions

| Item | Owner of decision |
|---|---|
| `minDeposit` for gasless top-up (proposed $5) | Owner, at fee configuration (M3-3) |
| Native coins behind `PRICE_UPDATER` (§3.4) | Owner; design and security review first (M4) |
| Welcome credits (§10) | Owner (optional) |
| Tax and VAT assessment (§9) | Counsel, before paid mainnet (M3-7) |
| Encrypted drop quotas: confirm the proposed 100 MB per file and 1 GB per agent per week (D-48) | Owner, before the drop goes live (M1b) |
| Paid larger drop quotas (D-48) | Owner, later; not offered now |
| Billing profiles: data protection and VAT, accounting treatment of stablecoin revenue (§7.1, D-50) | Counsel and owner (M3-7) |
| Indexer for the internal finance dashboard (D-50) | Owner (M4) |
