# 05 — OCC v2 Smart Contracts

**Repository:** `occ-v2-contracts` (private during beta; verified source under BUSL-1.1 at mainnet; see §10).
**Toolchain:** Solidity 0.8.x, exact pin in the contracts repo (currently 0.8.37), Foundry, OpenZeppelin Contracts v5 (+ upgradeable), Solady where gas matters.

OCC v2 is a **new codebase**. It reuses ideas from OCC v1 (Mails' record + `setOpenedAt` receipts, AppFeeManager's integrator fees) but no v1 contract is upgraded or extended. v1 stays deployed for legacy apps.

---

## 1. Contracts

| Contract | Purpose | Beta |
|---|---|---|
| `OCCFeeVault` | **Credits** (deposits/withdrawals), fee configuration, quotes, charging, treasury sweeps, integrator apps and payouts | ✅ M1 |
| `OCCNotary` | Notarized records and receipts (signature-based, submitter-agnostic) | ✅ M1 |
| `OCCRegistry` | Verified agent cards (agent ↔ owner binding), revocation | ✅ M2 |
| `OCCAnchor` | Batched Merkle roots of many envelopes | P2 |
| `OCCDeals` | Offer → counter → accept → deliver → confirm state machine | P2 |

All charging goes through `OCCFeeVault.charge`, callable only by registered **modules** (Notary, Registry, later Anchor and Deals). Credits are shared across modules.

---

## 2. OCCFeeVault

### 2.1 Fee types

```solidity
enum FeeType { NOTARIZE, REGISTER, ANCHOR, DEAL, DISCLOSE }
```

### 2.2 Configuration (per chain, per token)

```solidity
mapping(FeeType => mapping(address token => uint256)) protocolFee;    // address(0) = native coin
mapping(FeeType => mapping(address token => uint256)) maxProtocolFee;  // cap
mapping(address token => bool) feeTokenAllowed;                        // launch: USD stablecoins only (D-46)
mapping(address token => uint256) minDeposit;                          // anti-griefing for gasless deposits
uint16 integratorFeeCapMultiple;                                       // default 4 (×protocol fee), ≤ MAX_MULTIPLE = 10 (constant)
```

- `FEE_ADMIN` sets `protocolFee` ≤ `maxProtocolFee` (immediate; above the cap reverts `FeeAboveCap()`).
- `maxProtocolFee` can be **lowered** immediately and only **raised** with a 7-day execution delay, so users see fee-cap increases in advance. These are two functions, each mapped to one role (§5, G-3; decided, D-59): **lower the cap** (`FEE_ADMIN`, immediate; if the current fee is above the new cap, the fee drops to the cap) and **raise the cap** (`CAP_RAISER`, 7 days). Each reverts `InvalidCapChange()` if the new value goes the other way.
- `setIntegratorFeeCapMultiple` reverts `MultipleAboveMax()` if the new multiple is above `MAX_MULTIPLE` (proposed). The exact function names and parameters of every restricted function are in §5.2.
- Fees are fixed token amounts (no oracle).
- **Launch configuration (D-45, D-46; 12 §2–§3):** only USD stablecoins are allowlisted: USDC, USDT where available, and on Gnosis the native xDAI (`address(0)`), which counts as a USD-pegged native coin. No volatile native coin (e.g. ETH) is allowlisted. Each token is valued at $1, so every fee is the same USD amount on every chain: `NOTARIZE` $0.10 with `maxProtocolFee` $0.50, `REGISTER` $5 with `maxProtocolFee` $25, set in token units (USD × 10^decimals, e.g. 500000 for $0.50 in 6-decimal USDC). `ANCHOR`, `DEAL` and `DISCLOSE` are not configured (fee 0 and cap 0; their modules do not exist yet).
- Removing a token from the allowlist stops new deposits and charges in it; `withdraw` of existing credits in it keeps working (§2.5 invariant).
- **Later (M4, `DECISION NEEDED`):** native volatile coins only behind a separate bounded **`PRICE_UPDATER`** role that can move a native-coin fee only within a narrow band around its USD target, at a limited rate and never above `maxProtocolFee`. It needs a contract design, a security review and an external audit delta before any such token is allowlisted (12 §3.4).

### 2.3 Integrator apps

```solidity
struct App { address integrator; bool active; string name; }
mapping(bytes32 appId => App) apps;     // appId = keccak256(abi.encode(integrator, keccak256(bytes(name))))
mapping(bytes32 appId => mapping(FeeType => mapping(address token => uint256))) integratorFee;

function registerApp(string calldata name) external returns (bytes32 appId);          // integrator = msg.sender
function setIntegratorFee(bytes32 appId, FeeType t, address token, uint256 amount) external; // integrator only
function setIntegrator(bytes32 appId, address newIntegrator) external;                 // integrator only (appId unchanged)
function setAppActive(bytes32 appId, bool active) external;                            // FEE_ADMIN
```

- `appId` includes the integrator address, so names can't be squatted on new chains: the same integrator address gets the same `appId` everywhere.
- `appId = 0` means no integrator (official clients).
- The integrator fee is capped **at charge time**: `min(integratorFee, integratorFeeCapMultiple × protocolFee)`, so lowering protocol fees can't leave oversized integrator fees.
- `FEE_ADMIN` can deactivate abusive apps (charges for inactive apps revert); it cannot move integrator balances.

### 2.4 Quotes and charging

```solidity
function quote(FeeType t, address token, bytes32 appId)
    external view returns (uint256 protocolPart, uint256 integratorPart, uint256 total);

function charge(address payer, FeeType t, bytes32 appId, address token, uint256 maxTotal) external; // modules only
```

`charge`:
1. Requires caller is a registered module and the token is allowed; app active if `appId ≠ 0`.
2. `total = protocolPart + integratorPart` (cap applied); requires `total ≤ maxTotal` (signed by the payer).
3. Debits `credits[payer][token]`; reverts `InsufficientCredits(payer, token, needed, available)` if short.
4. Accrues `protocolAccrued[token]` and `integratorAccrued[appId][token]`.

**Direct payment** (no credits): modules expose `payable` "direct" functions where `msg.sender` is the payer. The module forwards funds via `vault.depositFromModule{value}(payer, token, amount)`. This function is module-only and pulls ERC-20s from `payer` with `transferFrom` (payer must have approved the vault). It is followed immediately by `charge`. **Approvals (G-3; decided, D-59):** clients approve the vault for the exact amount of each direct payment and never an unlimited amount, and they prefer EIP-3009 (`depositWithAuthorization`) or permit flows that leave no standing allowance. A standing allowance is exposed to any later vault or module upgrade, which withdrawing credits does not undo.

### 2.5 Credits (non-custodial)

```solidity
function deposit(address token, uint256 amount) external payable;                     // credit msg.sender
function depositFor(address payer, address token, uint256 amount) external payable;   // anyone can top up any agent
function depositWithAuthorization(address token, address from, uint256 value,
    uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external; // EIP-3009; credits `from`
function withdraw(address token, uint256 amount, address to) external;                // payer withdraws unused credits any time
function creditsOf(address payer, address token) external view returns (uint256);
```

- `SafeERC20`; credits the **measured balance delta**. Fee-on-transfer tokens are unsupported and never allowlisted.
- `depositWithAuthorization` calls the token's **`receiveWithAuthorization`** (payee = vault, so front-running cannot redirect funds; never `transferWithAuthorization`). Requires `value ≥ minDeposit[token]`. Supported only for tokens flagged EIP-3009-capable in the chain config (verify per chain: native Circle USDC yes; bridged variants may not be).
- **Invariant:** no admin function can move, freeze or reduce a payer's credits. Pause blocks new charges and deposits, **never withdrawals**.

### 2.6 Treasury and payouts

- `treasury` = 4thTech Safe multisig per chain. Changing it requires a 7-day execution delay.
- `sweep(token)` is permissionless: sends `protocolAccrued[token]` to `treasury` using `call` (never `transfer`).
- `withdrawIntegrator(appId, token, to)` callable by the app's integrator.
- All value transfers: checks-effects-interactions + `nonReentrant`.

---

## 3. OCCNotary

### 3.1 Types (EIP-712, domain `{name:"OCC", version:"2", chainId, verifyingContract}`)

```solidity
struct Record {
    address signer;               // agent EVM address (EOA or ERC-1271 account)
    bytes32 envelopeHash;         // sha256(JCS(envelope without sig)) — see 04 §3.1
    bytes32 recipientCommitment;  // keccak256(abi.encode(recipientAgentEvm, salt)); 0 for self-notes
    bytes32 parentRecordId;       // threading / replies; 0 if none
    bytes32 appId;                // integrator; 0 for official clients
    uint8   kind;                 // 1 MESSAGE, 2 FILE, 3 OFFER, 4 ACCEPT, 5 DELIVERY, 6 NOTE (extensible)
    address feeToken;             // address(0) = native
    uint256 maxFee;               // max total fee the signer accepts
    uint256 nonce;                // random, single use per signer
    uint64  deadline;             // unix seconds
}

struct Receipt {
    address signer;               // recipient agent EVM address
    bytes32 recordId;
    uint8   receiptType;          // 1 DELIVERED, 2 OPENED, 3 ACCEPTED, 4 REJECTED
    bytes32 salt;                 // commitment preimage
    uint64  deadline;
}
```

**JSON form (04 §2.4.1).** Wherever these values appear in JSON (the `proof` body, proof packs, tool results, the submitter API), addresses and every `bytes32` (`recordId`, `salt`, `envelopeHash`, `recipientCommitment`, `parentRecordId`, `appId`), transaction hashes and signatures are `0x` + lowercase hex; `uint256` values (`maxFee`, `nonce`) are decimal strings; the other integers are JSON integers. Anything else is rejected, never normalised.

### 3.2 Functions

```solidity
function notarize(Record calldata r, bytes calldata sig) external returns (bytes32 recordId);
function notarizeBatch(Record[] calldata rs, bytes[] calldata sigs) external returns (bytes32[] memory);
function notarizeDirect(Record calldata r) external payable returns (bytes32 recordId); // requires msg.sender == r.signer; pays now
function acknowledge(Receipt calldata rc, bytes calldata sig) external;
function acknowledgeBatch(Receipt[] calldata rcs, bytes[] calldata sigs) external;
function getRecord(bytes32 recordId) external view returns (RecordState memory);
function computeRecordId(address signer, uint256 nonce) external view returns (bytes32);
```

Signatures are verified with OpenZeppelin `SignatureChecker.isValidSignatureNow(signer, digest, sig)`, which supports EOAs **and** ERC-1271 smart accounts.

### 3.3 Logic

**notarize**
1. `block.timestamp ≤ deadline`; signature valid for `r.signer`.
2. `recordId = keccak256(abi.encode(block.chainid, address(this), r.signer, r.nonce))`; requires `records[recordId].signer == address(0)` (this also enforces single-use nonces, so no separate nonce mapping is needed).
3. `vault.charge(r.signer, NOTARIZE, r.appId, r.feeToken, r.maxFee)`.
4. Store:
   ```solidity
   struct RecordState {
       address signer;              // slot 1: 20 B
       uint64  timestamp;           //         8 B
       uint8   kind;                //         1 B
       uint8   receiptFlags;        //         1 B  (bit per receipt type)
       bytes32 envelopeHash;        // slot 2
       bytes32 recipientCommitment; // slot 3
       bytes32 recordStructHash;    // slot 4: EIP-712 struct hash (commits parentRecordId, appId, fee fields)
       uint64[4] receiptAt;         // slot 5: timestamps for DELIVERED, OPENED, ACCEPTED, REJECTED (packed)
   }
   ```
5. Emit `RecordNotarized(...)`.

**acknowledge**
1. Record exists; `deadline` valid; signature valid for `rc.signer`.
2. `keccak256(abi.encode(rc.signer, rc.salt)) == recipientCommitment` (only the intended recipient can acknowledge).
3. Receipt type not yet set; `ACCEPTED` and `REJECTED` are mutually exclusive (so at most **3 receipts** per record). The one-time flag prevents replay.
4. Set flag and `receiptAt[type]`; emit `ReceiptRecorded`.
5. **No fee:** receipts are included in the record fee.

**Batches (G-4; decided by the owner in chat, 14 Oct 2026; wording confirmed at merge).** `notarizeBatch` and `acknowledgeBatch` are all-or-nothing, with one exception: an item that is already on-chain in identical form is skipped.
- **Record item.** If `records[recordId]` exists and its `recordStructHash` equals the item's EIP-712 struct hash, the item is skipped. A skipped item has no charge, no revert, no state change and emits `RecordSkipped(recordId)`. This check runs first, so a skipped item's deadline and signature are not checked: nothing it carries is used. A `recordId` that exists with a different struct hash reverts the whole batch (`RecordExists()`).
- **Receipt item.** The contract stores no receipt struct hash, so "identical" is read as follows. The same `receiptType` is already set on that `recordId`, and the item's `signer` and `salt` open its `recipientCommitment`. Only the committed recipient can set a type, and only once, so the on-chain outcome is the same. Such an item is skipped and emits `ReceiptSkipped(recordId, receiptType)`. If the commitment does not open, the whole batch reverts (`NotRecipient()`), and so does an `ACCEPTED` for a record with `REJECTED` set, or the reverse (`ConflictingReceipt()`). Only the deadline is not compared, because it is not stored.
- **Any other failure reverts the whole batch.** This includes an expired deadline, an invalid signature, insufficient credits, a fee above `maxFee` and a pause. An identical item repeated within one batch is skipped the second time.
- **Single calls are unchanged.** `notarize` and `acknowledge` still revert on an existing record (`RecordExists()`) or receipt (`ReceiptExists()`).
- **Submitter rule (M1-10a, 07 §7).**
  - Before sending, the submitter simulates each item alone and then the batch (`eth_call`). It leaves out every item that fails for a reason other than an identical existing entry, and reports that item to its client as `failed` with the error.
  - If a sent batch still reverts (state changed between simulation and inclusion, for example credits spent), it re-simulates per item, leaves out the failing items and resubmits the rest once. An item that fails twice is reported `failed` and never retried.
  - A signer whose item caused an on-chain batch revert is submitted alone, outside batches, for a cooling-off period, so that one signer cannot grief other signers' items.
  - Per-item status to clients: `recorded`, `skipped` (already on-chain, which a client treats as success, with the existing `recordId`) or `failed`.
  - A pause is not an item failure. While the Notary is paused, the submitter holds items and sends them after unpause. An item whose deadline passes in the meantime is `failed` (`Expired()`), and the client signs again under §5.1.

> Privacy note: a receipt reveals the salt, linking the recipient's agent address to the record. Records without receipts reveal only the salted commitment. Per-relationship agent keys (P2) reduce linkability.

Verifiers can check everything shown in a proof (signer, time, envelope hash, recipient, receipts with timestamps, and all other record fields via `recordStructHash`) from `getRecord` alone. That matters because some RPCs prune old logs.

### 3.4 Gas targets (including 21k intrinsic gas; verify with snapshots)

| Function | Target |
|---|---|
| `notarize` (credits, EOA) | ≤ 170k (decided by the owner in chat, 14 Oct 2026; wording confirmed at merge) |
| `acknowledge` | ≤ 75k |
| `notarizeBatch` per item (n = 20) | ≤ 120k |

On Base and Gnosis these cost a fraction of a cent, leaving margin for gas sponsorship by the submitter.

---

## 4. OCCRegistry (M2)

```solidity
struct Registration {
    bytes32 cardHash;     // EIP-712 hash of the AgentCard (chain-agnostic domain, 04 §2.4)
    address feeToken;
    uint256 maxFee;
    bytes32 appId;
    uint256 nonce;
    uint64  deadline;
}

function register(AgentCard calldata card, bytes calldata cardOwnerSig, bytes calldata cardAgentSig,
                  Registration calldata reg, bytes calldata regOwnerSig) external;
function revoke(address agentEvm, uint256 nonce, uint64 deadline, bytes calldata ownerSig) external;
function getAgent(address agentEvm) external view returns (AgentEntry memory);
```

- `cardOwnerSig` and `cardAgentSig` are both over the card (mutual consent). Cards are public, so they alone must not authorize spending.
- **`regOwnerSig`** (EIP-712, OCC v2 chain-specific domain) over `Registration` authorizes the fee parameters. Without it, anyone holding a public card could register it with their own `appId` and drain the owner's credits.
- Fee: `REGISTER`, charged to `card.ownerEvm`.
- A higher `keyEpoch` from the same owner replaces the entry (new registration and fee).
- Stores `{ownerEvm, cardHash, keyEpoch, registeredAt, revoked}`; emits full card fields in `AgentRegistered`.
- ERC-8004 bridge (P2).

---

## 5. Roles and governance

OpenZeppelin Contracts v5 `AccessManager`; the role map below is **decided (D-59, G-3)**. The vault, the Notary and the Registry each delegate access control to it as their authority.

**How the delays work.** In AccessManager, an execution delay attaches to a (role, account) grant, not to a function, and each restricted function maps to exactly one role. So every distinct delay is its own role (one role per power and delay), and every direction-dependent change has two functions: lowering vs raising the cap, `pause` vs `unpause`, registering vs removing a module (two functions, never one `setModule(address, bool)`). The AccessManager delays are the timelock: there is no separate `TimelockController`. The Safe schedules, waits and executes through the AccessManager. An operation not executed within one week after it becomes executable expires (OZ `expiration()`) and must be scheduled again.

**User functions are never restricted.** Credits, quotes, apps, `sweep`, notarization, receipts, registration, revocation and views carry no access check in code. No AccessManager setting can gate them, and `withdraw` works in every state (§2.5). `charge` and `depositFromModule` check the vault's module list in code.

### 5.1 Role map

| ID | Role | Restricted functions (contract) | Mainnet holder | Execution delay | Grant delay | Guardian | Role admin |
|---|---|---|---|---|---|---|---|
| 0 | `ADMIN_ROLE` (OZ built-in) | No contract function. AccessManager administration only: grants and revocations by default, role admins, guardians, grant delays, target function roles, target admin delays, closing targets, `updateAuthority` | 4thTech Safe (≥ 2-of-3) | **7 days** | 7 days | — (OZ allows none; the Safe itself cancels) | — |
| 1 | `FEE_ADMIN` | Set the protocol fee ≤ cap, lower the cap, (de)activate apps (vault) | Safe | 0 | 0 | — | `ADMIN_ROLE` |
| 2 | `PAUSER` | `pause` (vault, Notary, Registry) | Two ops hardware keys **and** the Safe | 0 | 0 | — | `PAUSE_ADMIN` |
| 3 | `PAUSE_ADMIN` | `unpause` (vault, Notary, Registry); remove a module (vault); admin of `PAUSER` and `GUARDIAN` | Safe | 0 | 0 | — | `ADMIN_ROLE` |
| 4 | `GUARDIAN` | No function; guardian of roles 10–24, so it can **cancel** their scheduled operations, never execute | The two ops hardware keys | 0 | 0 | — | `PAUSE_ADMIN` |
| 10 | `CONFIG_ADMIN` | Allowlist or remove a fee token, set `minDeposit` (vault) | Safe | 48 h | 48 h | `GUARDIAN` | `ADMIN_ROLE` |
| 20 | `CAP_RAISER` | Raise the cap, set `integratorFeeCapMultiple` (vault) | Safe | 7 days | 7 days | `GUARDIAN` | `ADMIN_ROLE` |
| 21 | `TREASURY_ADMIN` | Change the treasury (vault) | Safe | 7 days | 7 days | `GUARDIAN` | `ADMIN_ROLE` |
| 22 | `MODULE_ADMIN` | Register a module (vault) | Safe | 7 days | 7 days | `GUARDIAN` | `ADMIN_ROLE` |
| 23 | `UPGRADER` | `upgradeToAndCall` (vault, Notary, Registry) | Safe | 7 days | 7 days | `GUARDIAN` | `ADMIN_ROLE` |
| 24 | `FREEZER` | `freezeUpgrades` (Notary) | Safe | 7 days | 7 days | `GUARDIAN` | `ADMIN_ROLE` |

- **Target admin delay** = 7 days on the vault, the Notary and the Registry. Remapping a function to another role, closing a target or switching its authority (`updateAuthority`) therefore takes at least 7 days.
- **`minSetback`** stays at the OZ default (5 days, not overridden). Every change to a grant delay or a target admin delay takes effect after max(5 days, the reduction), so a delay can never be shortened faster than it protects.
- **Why 7 days for modules and every upgrade.** A module can call `charge` for any payer. A malicious module, or a malicious upgrade of the Notary or the Registry (both are modules), could therefore drain credits in fee-sized steps to an integrator app it controls. Registering a module and upgrading any module carry the same 7-day delay as a vault upgrade, so users can withdraw first **and revoke any token approval to the vault**. A malicious upgrade could also pull a standing allowance through `depositFromModule` (§2.4). The public notice of every scheduled upgrade or module registration tells users to do both. (This replaces the earlier 48 h for Notary and Registry upgrades and for module registration; decided, D-59.) Removing a module only reduces power, so it is immediate (`PAUSE_ADMIN`).
- **Why `ADMIN_ROLE` is 7 days** (decided, D-59). With every AccessManager change at 7 days, no path to a 7-day power is shorter than 7 days. Grant delays and target admin delays add a second, independent layer. The only exceptions are the 0-delay emergency and fee roles above. Execution delays of existing members can be lowered only after the reduction (OZ); a revoke-and-regrant counts as a new grant and waits for the grant delay.
- **Bound (tested in M1-3a).** With the Safe compromised, every path to `UPGRADER`, `MODULE_ADMIN`, `TREASURY_ADMIN`, `CAP_RAISER` or `FREEZER` power takes at least 7 days on-chain. That covers using the role, granting it to a new account, remapping the function, switching the authority, and lowering a delay first. `CONFIG_ADMIN` power takes at least 48 h.
- **Emergency.**
  - **Pause.** `PAUSER` (either ops key or the Safe) pauses at once. **Pause scope:** pause blocks charges, deposits, notarization, **receipts** (`acknowledge`, `acknowledgeBatch`; decided by the owner in chat, 14 Oct 2026; wording confirmed at merge) and registration. It **never** blocks `withdraw`, `withdrawIntegrator`, `sweep` or the Registry `revoke` (resolves G-39; decided, D-59). A stolen ops key therefore cannot trap funds or stop the revocation of a compromised agent.
    - **Receipts and D-55 commitments** (this reading of the scope is stated here for the owner's confirmation). While the Notary is paused, a commitment scope's receipt or Record part (04 §3.4.2) stays claimed in the store, with its signed item kept, and is not used up. After unpause, the submitter sends the stored item if its `deadline` has not passed.
      - **Receipt.** If the deadline has passed, the core may sign a new Receipt for the same `recordId` and `receiptType` with a new deadline, without asking the owner again, while the scope's `expiresAt` has not passed. It is the same part, and the one-time flag (§3.3) lets at most one receipt land.
      - **Record.** A Record is signed again (new nonce, so a new `recordId`) only after the earlier signed Record's `deadline` has passed. Until then the earlier one could still land, and two Records would be charged twice. This matches the budget release rule (06 §3).
      - **Scope expiry.** After the scope's `expiresAt`, the unused parts are void (04 §3.4.2) and the owner is asked again.
    - **Pause after freeze.** `freezeUpgrades` disables only `_authorizeUpgrade`. `pause`, `unpause` and the role map are unaffected, so a frozen Notary can still be paused, and only the Safe unpauses it (decided by the owner in chat, 14 Oct 2026; wording confirmed at merge).
    - **Accepted residual risk (decided, D-59).** Because pause never blocks `withdrawIntegrator`, pause cannot stop an integrator withdrawing a balance inflated by a bug. The M3-1 audit scope must cover this path.
  - **Unpause.** Only the Safe unpauses (`PAUSE_ADMIN`), so a stolen ops key cannot undo a pause during an incident. It can only pause again (denial of service), or cancel scheduled operations as `GUARDIAN`.
  - **Stolen ops key.** The Safe revokes `PAUSER` and `GUARDIAN` from it **at once**, in the same Safe batch before unpausing, because `PAUSE_ADMIN` administers both roles with no delay. Trade-off: a compromised Safe can also remove the guardians at once, so the guardian adds no time beyond the 7-day bound against a compromised Safe. It is a fast veto for honest mistakes and for operations nobody expected.
  - **Cancel.** `GUARDIAN` or the Safe cancels any unexpected scheduled operation at once. OZ allows no guardian on `ADMIN_ROLE`, so only the Safe or the scheduler can cancel scheduled AccessManager changes.
  - **Ops keys (decided, D-59).** Two dedicated hardware keys, one held by Tali and one by Denis, each holding `PAUSER` and `GUARDIAN`, for on-call coverage. Neither is a Safe-signer device or account. They are never used on CI, agent machines or hot wallets, and are rotated on suspicion via `PAUSE_ADMIN`. The Denis pause key is to be confirmed before M3.
- **New selectors and targets.** After an upgrade, any new restricted selector defaults to `ADMIN_ROLE` until the Safe maps it (7 days); the upgrade's evidence lists the mapping. Later targets (P2 modules, M4 chains) are configured by the Safe through `ADMIN_ROLE` under the same table.
- **Deployment (§9, D-52).**
  - The deployer is the AccessManager's initial admin only inside the deploy script. The script maps every selector, sets delays, guardians and role admins, grants the roles above and renounces `ADMIN_ROLE`. The deployer holds no role afterwards (checked by script).
  - Grant delays and target admin delays configured at deployment take effect only after `minSetback` (5 days).
  - The 7-day bound already holds in that window, because the Safe's own 7-day `ADMIN_ROLE` execution delay applies from the grant. **Mainnet** contracts are nevertheless initialised **paused**, as defence in depth: no user deposits until the full role check passes and every configured delay is in effect (decided, D-59). The order per chain:
    1. deploy (paused);
    2. run the role check (`release-and-deployment.md` §4.3);
    3. wait until every grant delay and target admin delay reads back as configured (deployment + 5 days);
    4. the Safe unpauses;
    5. run the smoke test;
    6. publish.

    The wait does not block deploying the next chain.
  - **Testnets** are unpaused at deployment (faucet funds only).
  - **Mainnet floor.** The deploy script reverts if the chain is a mainnet and any configured delay is below the §5.1 table, so scaled testnet values can never reach mainnet.
- **Testnets** (decided, D-59) use the same role IDs, selector map, guardians and role admins.
  - **Holders:** a separate **2-of-3 testnet Safe** (Tali, Denis and an offline backup key; the signer addresses differ from mainnet) and a separate testnet ops key. No agent or CI signer. Nothing is shared with mainnet (`release-and-deployment.md` §1).
  - **Delays** are scaled so upgrades can be rehearsed during the beta: 48 h → 1 h and 7 days → 4 h, for execution delays, grant delays and the target admin delay. The values live in the per-chain config, and the M1-3a test checks them per chain.
  - **`minSetback` is not scaled.** It stays 5 days on testnets, so delays set at deployment, and rehearsals of delay changes, take effect after 5 days.
- Mainnet configuration, upgrades and Safe operations are owner-only (D-25, D-52): agents prepare evidence; they never schedule, sign, execute or cancel (`release-and-deployment.md` §4.4).

**Freeze:** the Notary has a one-way `freezeUpgrades()` (`FREEZER`, 7-day delay). After it runs, `_authorizeUpgrade` always reverts, regardless of roles. It is executed at GA so records stay permanently neutral. Freeze does not remove pause (§5.1). The vault stays upgradeable with a 7-day delay.

Contracts are UUPS proxies with ERC-7201 namespaced storage; `_authorizeUpgrade` is restricted to `UPGRADER`. The AccessManager itself is not upgradeable.

### 5.2 Restricted functions (names the interfaces use)

*Status: proposed; the owner confirms at merge. The M1-3a interfaces and `docs/roles.md` in `occ-v2-contracts` already use these names; this table makes the spec the source, so the two cannot drift.* Each function maps to exactly one role (§5.1), and `docs/roles.md` is checked against this table and the AccessManager readback.

| Contract | Function (parameters) | Role | Delay | Notes |
|---|---|---|---|---|
| vault | `setProtocolFee` (fee type, token, fee) | `FEE_ADMIN` | 0 | Reverts `FeeAboveCap()` if the fee is above `maxProtocolFee` |
| vault | `lowerMaxProtocolFee` (fee type, token, new cap) | `FEE_ADMIN` | 0 | Lowers the cap; a current fee above it drops to it; `InvalidCapChange()` if the new cap is higher |
| vault | `raiseMaxProtocolFee` (fee type, token, new cap) | `CAP_RAISER` | 7 days | `InvalidCapChange()` if the new cap is lower |
| vault | `setIntegratorFeeCapMultiple` (multiple) | `CAP_RAISER` | 7 days | Reverts `MultipleAboveMax()` above `MAX_MULTIPLE` (10) |
| vault | `setAppActive` (app ID, active) | `FEE_ADMIN` | 0 | |
| vault | `setFeeTokenAllowed` (token, allowed) | `CONFIG_ADMIN` | 48 h | Allowlist or remove a fee token |
| vault | `setMinDeposit` (token, amount) | `CONFIG_ADMIN` | 48 h | |
| vault | `setTreasury` (new treasury) | `TREASURY_ADMIN` | 7 days | |
| vault | `registerModule` (module) | `MODULE_ADMIN` | 7 days | Never a combined `setModule` |
| vault | `removeModule` (module) | `PAUSE_ADMIN` | 0 | |
| vault, Notary, Registry | `pause` | `PAUSER` | 0 | |
| vault, Notary, Registry | `unpause` | `PAUSE_ADMIN` | 0 | |
| vault, Notary, Registry | `upgradeToAndCall` (implementation, data) | `UPGRADER` | 7 days | Gated through `_authorizeUpgrade` |
| Notary | `freezeUpgrades` | `FREEZER` | 7 days | One-way |

As in OpenZeppelin `Pausable`, `pause` while already paused reverts `EnforcedPause()` and `unpause` while not paused reverts `ExpectedPause()`; neither emits an event in that case (proposed). The integrator's own functions (`setIntegratorFee`, `setIntegrator`, `withdrawIntegrator`) and every user function are not restricted (§5).

---

## 6. Events

*Status: proposed; the owner confirms at merge. The first group is unchanged. The parameters of the second group and all of the third group are new.*

```
RecordNotarized(bytes32 indexed recordId, address indexed signer, bytes32 envelopeHash,
                bytes32 recipientCommitment, bytes32 indexed parentRecordId, bytes32 appId, uint8 kind, uint64 timestamp)
ReceiptRecorded(bytes32 indexed recordId, uint8 receiptType, address indexed signer, uint64 timestamp)
AgentRegistered(address indexed agentEvm, address indexed ownerEvm, uint32 keyEpoch, bytes32 cardHash, ...)
AgentRevoked(address indexed agentEvm, address indexed ownerEvm)
Deposited(address indexed payer, address indexed token, uint256 amount, address indexed from)
Withdrawn(address indexed payer, address indexed token, uint256 amount, address to)
Charged(address indexed payer, uint8 feeType, bytes32 indexed appId, address token, uint256 protocolPart, uint256 integratorPart)
Swept(address indexed token, uint256 amount, address treasury)
```

Parameters of the entries that were listed by name only (they match the M1-3a interfaces). `feeType` is `uint8`, as in `Charged`.

```
FeeSet(uint8 feeType, address indexed token, uint256 fee)
CapSet(uint8 feeType, address indexed token, uint256 cap)
AppRegistered(bytes32 indexed appId, address indexed integrator, string name)
IntegratorFeeSet(bytes32 indexed appId, uint8 feeType, address indexed token, uint256 amount)
AppStatusChanged(bytes32 indexed appId, bool active)
ModuleSet(address indexed module, bool registered)
TokenAllowed(address indexed token, bool allowed)
UpgradesFrozen()
```

Added:

```
Paused(address account)                      -- vault, Notary, Registry
Unpaused(address account)                    -- vault, Notary, Registry
TreasuryChanged(address indexed oldTreasury, address indexed newTreasury)
MinDepositSet(address indexed token, uint256 amount)
IntegratorFeeCapMultipleSet(uint16 multiple)
IntegratorChanged(bytes32 indexed appId, address indexed oldIntegrator, address indexed newIntegrator)
IntegratorWithdrawn(bytes32 indexed appId, address indexed token, address indexed to, uint256 amount)
RecordSkipped(bytes32 indexed recordId)                      -- Notary, notarizeBatch (G-4)
ReceiptSkipped(bytes32 indexed recordId, uint8 receiptType)  -- Notary, acknowledgeBatch (G-4)
```

| Event | Emitted by | Meaning |
|---|---|---|
| `Paused(account)` / `Unpaused(account)` | `pause` / `unpause` (§5.2), on each state change only (a call that reverts emits nothing); also once at initialisation, with the initialising caller, when a mainnet contract starts paused (§5.1) | `account` is the caller. Both functions have no delay, so it is the actual ops key or Safe that paused, and which one tells the on-call who to revoke. Same names and signature as OpenZeppelin `Pausable`, so standard monitors recognise them. |
| `TreasuryChanged(old, new)` | `setTreasury` | The address that receives `sweep` changed. The most important event to monitor: it redirects all protocol fees. Both addresses are indexed so an alert can match either. |
| `MinDepositSet(token, amount)` | `setMinDeposit` | New anti-griefing minimum for gasless deposits in `token`. |
| `IntegratorFeeCapMultipleSet(multiple)` | `setIntegratorFeeCapMultiple` | New integrator fee cap, as a multiple of the protocol fee. |
| `IntegratorChanged(appId, old, new)` | `setIntegrator` | An app's integrator address changed; `appId` is unchanged. After this, `withdrawIntegrator` for that app is callable by the new address. |
| `IntegratorWithdrawn(appId, token, to, amount)` | `withdrawIntegrator` | An integrator withdrew `amount` of `token` for `appId` to `to`. This path stays open while paused (§5.1), so an alert on unusually large amounts is the compensating control for that residual risk. |

Notes:

- **No actor on delayed changes.** An operation with an execution delay runs through the AccessManager, so the caller the contract sees is the AccessManager. `TreasuryChanged`, `MinDepositSet`, `IntegratorFeeCapMultipleSet`, `ModuleSet`, `TokenAllowed`, `CapSet` and the upgrade events therefore carry no actor. Who scheduled the operation is in the AccessManager's `OperationScheduled` event (caller, target, data), and its `OperationExecuted` and `OperationCanceled` events mark the outcome. Monitoring watches both: the schedule (7 days before the change) is the early warning, and the contract event confirms it happened.
- **Inherited events.** The ERC-1967 `Upgraded(address indexed implementation)` marks every upgrade; the AccessManager emits `RoleGranted`, `RoleRevoked`, `TargetFunctionRoleUpdated` and related events for every role-map change.
- **`CapSet`** is emitted by both `lowerMaxProtocolFee` and `raiseMaxProtocolFee`; `FeeSet` is also emitted when a lowered cap drags the current fee down to it. `ModuleSet` is emitted with `registered = true` by `registerModule` and `false` by `removeModule`.
- **Naming.** The pause events use the OpenZeppelin v5 names (`Paused`, `Unpaused`). The earlier error `Paused()` could not coexist with an event of the same name in one contract, so the error is renamed to the OpenZeppelin name `EnforcedPause()`, which also reverts a `pause` while paused, and `ExpectedPause()` reverts an `unpause` while not paused (§7).

---

## 7. Errors (custom errors only)

`Expired()`, `InvalidSignature()`, `RecordExists()`, `RecordNotFound()`, `ReceiptExists()`, `ConflictingReceipt()`, `NotRecipient()`, `NotSigner()`, `InsufficientCredits(address payer, address token, uint256 needed, uint256 available)`, `FeeAboveMax(uint256 total, uint256 maxTotal)`, `TokenNotAllowed(address token)`, `BelowMinDeposit()`, `NotModule()`, `AppExists()`, `AppInactive()`, `NotIntegrator()`, `FeeAboveCap()`, `EnforcedPause()` (renamed from `Paused()`, which collided with the event `Paused`; proposed, §6), `UpgradesAreFrozen()`, `ZeroAddress()`, `TransferFailed()`, `InvalidCapChange()` (G-3; decided, D-59), `ExpectedPause()` and `MultipleAboveMax()` (proposed; §5.2).

---

## 8. Testing and security gates

- Unit tests for every function and revert path; **fuzz tests** for signatures, fees, credits; **invariant tests**:
  - Σ credits + Σ protocolAccrued + Σ integratorAccrued **≤** vault balance (per token; funds can be force-sent).
  - A record's fields never change after creation; receipt flags and timestamps only ever get set once.
  - No role can reduce a payer's credits.
  - After `freezeUpgrades`, no upgrade succeeds.
  - Role map (§5.1): every restricted selector has exactly the role and delay of the table; with the Safe compromised, no path to a 7-day power (use, new grant, selector remap, `updateAuthority`, delay reduction) completes in under 7 days.
- ERC-1271 signer tests (Safe-style and passkey-style smart accounts).
- Static analysis: Slither and Aderyn clean (or justified) in CI. Gas snapshots in CI.
- Shared EIP-712 test vectors with `@agentlink/chain` (TypeScript) to guarantee identical hashing, including the chain-agnostic AgentCard domain.
- **External audit before mainnet** (M3 gate). Bug bounty after mainnet.

---

## 9. Deployment

- Foundry scripts; **CREATE3 via CreateX**, so proxy addresses are identical on all chains even though initializer arguments (fee tokens, treasury) differ per chain.
- Per-chain config file: fee tokens, at launch **stablecoins only** (USDC and USDT addresses where available, plus native xDAI on Gnosis; D-46), each verified against the issuer's official list, checked for no fee-on-transfer behaviour and carrying an EIP-3009 flag; initial fees and caps (the same USD amounts on every chain, 12 §2), min deposits, treasury Safe, roles and delays. The verified per-chain configuration is published at deployment (12 §7).
- Beta: Base Sepolia and Gnosis Chiado (M1) → Base and Gnosis mainnet (M3). Then Arbitrum, Optimism, Polygon (M4).
- **Testnet faucet:** a 4thTech-run `depositFor` faucet credits testnet agents (M1) so testers never need gas.
- Verify on Sourcify and explorers at mainnet.
- Deployer key: fresh hardware-backed key used only for deployment; all roles transferred to the Safe in the same script; deployer retains no role (CI check). Mainnet contracts are initialised paused and unpaused by the Safe once the configured grant and target admin delays are in effect (§5).
- Publish ABIs and addresses as `@agentlink/occ-v2-abi`.

---

## 10. Licensing (proposed — confirm with counsel)

- Beta: private repository.
- Mainnet: verified source published under **Business Source License 1.1**:
  - Licensor: the operating entity (TBD).
  - Additional Use Grant: non-commercial use, testing, security research, and use through the canonical deployments.
  - Change Date: three years after mainnet launch; Change License: GPL-2.0-or-later.
- Rationale: verified source is needed for trust in a notary, but bytecode is public anyway, so secrecy doesn't prevent forks. BUSL limits commercial forks; network effects and integrator fees remove the incentive to fork.
