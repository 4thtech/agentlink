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

**Batches (G-4; decided by the owner in chat, 14 Oct 2026, D-61; wording confirmed at merge).** `notarizeBatch` and `acknowledgeBatch` are all-or-nothing, with one exception: an item that is already on-chain in identical form is skipped.
- **Record item.** If `records[recordId]` exists and its `recordStructHash` equals the item's EIP-712 struct hash, the item is skipped. A skipped item has no charge, no revert, no state change and emits `RecordSkipped(recordId)`. This check runs **before** the deadline and signature checks, so an identical stored record is skipped even if the item's deadline has passed: nothing it carries is used, and the stored struct hash shows that the same signed Record was already verified on-chain. A `recordId` that exists with a different struct hash reverts the whole batch (`RecordExists()`).
- **Receipt item.** The contract stores no receipt struct hash, so "identical" is read as follows (this reading is the spec's interpretation of the owner's decision; D-62, accepted by Tali, 2026-10-14, at merge of 4thtech/agentlink#34). The item is checked like a single `acknowledge` first: the record exists, the item's `deadline` has not passed, its signature is valid for `signer`, and `signer` and `salt` open the `recipientCommitment`. Only then, if the same `receiptType` is already set on that `recordId`, the item is skipped and emits `ReceiptSkipped(recordId, receiptType)`. Only the committed recipient can set a type, and only once, so the on-chain outcome is the same. The stored and new deadlines are not compared, because the deadline is not stored. A failed check reverts the whole batch (`Expired()`, `InvalidSignature()`, `NotRecipient()`), and so does an `ACCEPTED` for a record with `REJECTED` set, or the reverse (`ConflictingReceipt()`).
- **Why records and receipts differ.** An identical record is proven by its stored struct hash, which the contract verified when it stored it, so the skip needs no other check. A receipt has no stored hash, so the item's own signature and deadline must hold before it can stand in for the stored one.
- **Any other failure reverts the whole batch.** This includes an expired deadline or an invalid signature (except on an identical record item, above), insufficient credits, a fee above `maxFee` and a pause. An identical item repeated within one batch is skipped the second time.
- **Single calls are unchanged.** `notarize` and `acknowledge` still revert on an existing record (`RecordExists()`) or receipt (`ReceiptExists()`).
- **Submitter rule (M1-10a, 07 §7).**
  - Before sending, the submitter simulates each item alone and then the batch (`eth_call`). It leaves out every item that fails for a reason other than an identical existing entry, and reports that item to its client as `failed` with the error.
  - If a sent batch still reverts (state changed between simulation and inclusion, for example credits spent), it re-simulates per item, leaves out the failing items and resubmits the rest once. An item that fails twice is reported `failed` and never retried.
  - A signer whose item caused an on-chain batch revert is submitted alone, outside batches, for a cooling-off period, so that one signer cannot grief other signers' items. The period is a submitter setting, `soloAfterRevertSeconds`, default 3 600 (1 h) (D-62, accepted by Tali, 2026-10-14, at merge of 4thtech/agentlink#34).
  - Per-item status to clients: `recorded`, `skipped` (already on-chain, which a client treats as success, with the existing `recordId`) or `failed`.
  - Proposed additions (pre-audit AUDIT-FABLE-OCCv2-1 FA-1, FA-3; owner confirms at merge), stated in 07 §7: items from signers with code are submitted solo (or at most one per batch) from their first item, every transaction's gas limit is its simulated gas plus a fixed margin, and items already on-chain at simulation are reported `skipped` without being transmitted.
  - A pause is not an item failure. While the Notary is paused, the submitter holds items and sends them after unpause. An item whose deadline passes in the meantime is `failed` (`Expired()`), and the client may sign a replacement only under 04 §5 ("Replacing a signed item").

> Privacy note: a receipt reveals the salt, linking the recipient's agent address to the record. Records without receipts reveal only the salted commitment. Per-relationship agent keys (P2) reduce linkability.

Verifiers can check everything shown in a proof (signer, time, envelope hash, recipient, receipts with timestamps, and all other record fields via `recordStructHash`) from `getRecord` alone. That matters because some RPCs prune old logs.

### 3.4 Gas targets (including 21k intrinsic gas; verify with snapshots)

| Function | Target |
|---|---|
| `notarize` (credits, EOA) | ≤ 170k (decided by the owner in chat, 14 Oct 2026, D-61; wording confirmed at merge) |
| `acknowledge` | ≤ 75k |
| `notarizeBatch` per item (n = 20) | ≤ 125k (raised from 120k by the owner, D-66 (4), 14 Oct 2026, on the AUDIT-FABLE-OCCv2-1 re-check: mixed USDC and native batches had only 158 gas of headroom under 120k) |

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

struct Revocation {
    address agentEvm;
    uint32  keyEpoch;      // the stored epoch (04 §2.4 card, §6 AgentRegistered)
    uint256 nonce;
    uint64  deadline;
}

function register(AgentCard calldata card, bytes calldata cardOwnerSig, bytes calldata cardAgentSig,
                  Registration calldata reg, bytes calldata regOwnerSig) external;
function revoke(Revocation calldata rev, bytes calldata ownerSig) external;
function getAgent(address agentEvm) external view returns (AgentEntry memory);
```

- `cardOwnerSig` and `cardAgentSig` are both over the card (mutual consent). Cards are public, so they alone must not authorize spending.
- **`regOwnerSig`** (EIP-712, OCC v2 chain-specific domain) over `Registration` authorizes the fee parameters. Without it, anyone holding a public card could register it with their own `appId` and drain the owner's credits.
- Fee: `REGISTER`, charged to `card.ownerEvm`.
- A higher `keyEpoch` from the same owner replaces the entry (new registration and fee).
- **Revocation (D-81).** `struct Revocation { address agentEvm; uint32 keyEpoch; uint256 nonce; uint64 deadline; }` (`keyEpoch` type aligned to the stored `uint32`), signed by `ownerEvm` (EIP-712, OCC v2 chain domain; ERC-1271 accepted). The signer must equal the stored `ownerEvm` of `agentEvm`, otherwise `InvalidSignature()`. `Registration` and `Revocation` nonces are random, single-use per owner, tracked in `usedNonces[ownerEvm][nonce]` and shared by both types. Reverts if expired (`Expired()`), the nonce is used (`NonceUsed()`), `keyEpoch` ≠ stored epoch (`EpochMismatch()`), the agent is not registered (`AgentNotRegistered()`) or is already revoked (`AlreadyRevoked()`). Revoke works while paused (§5.1).
- **Revocation JSON form (proposed, owner confirms at merge; 04 §2.4.1).** As the §3.1 JSON form of `Record` and `Receipt`: exactly the four keys `agentEvm`, `keyEpoch`, `nonce` and `deadline`; `agentEvm` is `0x` + 40 lowercase hex; `nonce` is a canonical decimal string (`^(0|[1-9][0-9]*)$`) of at most 2^256 − 1; `keyEpoch` (at most 2^32 − 1) and `deadline` (at most 2^53 − 1) are JSON integers. Every other form is rejected, never normalised.
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
  - **Pause.** `PAUSER` (either ops key or the Safe) pauses at once. **Pause scope:** pause blocks charges, deposits, notarization, **receipts** (`acknowledge`, `acknowledgeBatch`; decided by the owner in chat, 14 Oct 2026, D-61; amends D-59) and registration. It **never** blocks `withdraw`, `withdrawIntegrator`, `sweep` or the Registry `revoke` (resolves G-39; decided, D-59). A stolen ops key therefore cannot trap funds or stop the revocation of a compromised agent.
    - **Items signed before or during a pause** (D-62, accepted by Tali, 2026-10-14, at merge of 4thtech/agentlink#34). The submitter holds them and sends them after unpause if their `deadline` has not passed (§3.3). A D-55 commitment part (04 §3.4.2) stays `claimed`, with its signed item kept. When the deadline has passed, a replacement is signed only under 04 §5 ("Replacing a signed item"): the earlier item's deadline has passed **and** the chain's `finalized` block, with a timestamp after that deadline, shows no record (or no receipt of that type). If the earlier item landed, it stands, and nothing is signed or charged again. The rule depends on chain state, not on the pause, because the core cannot observe why an item did not land. For a commitment part, a replacement is signed only before the scope's `expiresAt`. After it, the unused parts are void and the owner is asked again.
    - **Pause after freeze** (D-62, accepted by Tali, 2026-10-14, at merge of 4thtech/agentlink#34). After `freezeUpgrades`, every upgrade reverts and nothing else changes. `pause`, `unpause` and the role map are unaffected, so a frozen Notary can still be paused, and only the Safe unpauses it.
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
  - **Holders:** a separate **2-of-3 testnet Safe** (Tali, Denis and an offline backup key; the signer addresses differ from mainnet) and a separate testnet ops key. No agent or CI signer. Nothing is shared with mainnet (`release-and-deployment.md` §1), the deployer key included since D-71 (1).
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
| `RecordSkipped(recordId)` | `notarizeBatch` (§3.3) | An item identical to a stored record was skipped: no charge and no state change. Anyone can cause it by replaying a record's public calldata in a batch, so it is never evidence of a submission, of a signer's intent or of a payment. Verifiers use `getRecord` and `RecordNotarized`. |
| `ReceiptSkipped(recordId, receiptType)` | `acknowledgeBatch` (§3.3) | A receipt item whose type was already set was skipped: no state change. It is never evidence of a receipt; verifiers use `getRecord` and `ReceiptRecorded`. |

Notes:

- **No actor on delayed changes.** An operation with an execution delay runs through the AccessManager, so the caller the contract sees is the AccessManager. `TreasuryChanged`, `MinDepositSet`, `IntegratorFeeCapMultipleSet`, `ModuleSet`, `TokenAllowed`, `CapSet` and the upgrade events therefore carry no actor. Who scheduled the operation is in the AccessManager's `OperationScheduled` event (caller, target, data), and its `OperationExecuted` and `OperationCanceled` events mark the outcome. Monitoring watches both: the schedule (7 days before the change) is the early warning, and the contract event confirms it happened.
- **Inherited events.** The ERC-1967 `Upgraded(address indexed implementation)` marks every upgrade; the AccessManager emits `RoleGranted`, `RoleRevoked`, `TargetFunctionRoleUpdated` and related events for every role-map change.
- **`CapSet`** is emitted by both `lowerMaxProtocolFee` and `raiseMaxProtocolFee`; `FeeSet` is also emitted when a lowered cap drags the current fee down to it. `ModuleSet` is emitted with `registered = true` by `registerModule` and `false` by `removeModule`.
- **Naming.** The pause events use the OpenZeppelin v5 names (`Paused`, `Unpaused`). The earlier error `Paused()` could not coexist with an event of the same name in one contract, so the error is renamed to the OpenZeppelin name `EnforcedPause()`, which also reverts a `pause` while paused, and `ExpectedPause()` reverts an `unpause` while not paused (§7).

---

## 7. Errors (custom errors only)

`Expired()`, `InvalidSignature()`, `NonceUsed()`, `EpochMismatch()`, `AgentNotRegistered()`, `AlreadyRevoked()`, `RecordExists()`, `RecordNotFound()`, `ReceiptExists()`, `ConflictingReceipt()`, `NotRecipient()`, `NotSigner()`, `InsufficientCredits(address payer, address token, uint256 needed, uint256 available)`, `FeeAboveMax(uint256 total, uint256 maxTotal)`, `TokenNotAllowed(address token)`, `BelowMinDeposit()`, `NotModule()`, `AppExists()`, `AppInactive()`, `NotIntegrator()`, `FeeAboveCap()`, `EnforcedPause()` (renamed from `Paused()`, which collided with the event `Paused`; proposed, §6), `UpgradesAreFrozen()`, `ZeroAddress()`, `TransferFailed()`, `InvalidCapChange()` (G-3; decided, D-59), `ExpectedPause()` and `MultipleAboveMax()` (proposed; §5.2).

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

- Foundry scripts; **CREATE3 via CreateX**, so proxy addresses are identical on all chains of one campaign even though initializer arguments (fee tokens, treasury) differ per chain. Salts, guards and the deployer key's lifecycle: §9.1.
- Per-chain config file: fee tokens, at launch **stablecoins only** (USDC and USDT addresses where available, plus native xDAI on Gnosis; D-46), each verified against the issuer's official list, checked for no fee-on-transfer behaviour and carrying an EIP-3009 flag; initial fees and caps (the same USD amounts on every chain, 12 §2), min deposits, treasury Safe, roles and delays. The verified per-chain configuration is published at deployment (12 §7).
- Beta: Base Sepolia (M1), then Gnosis Chiado at the same addresses (D-63) → Base and Gnosis mainnet (M3), at addresses of their own, the same on both mainnets (D-71 (1), superseding D-64 (2)). Then Arbitrum, Optimism, Polygon (M4).
- **Testnet faucet:** a 4thTech-run `depositFor` faucet credits testnet agents (M1) so testers never need gas.
- Verify on Sourcify and explorers at mainnet.
- Deployer key: on testnets a testnet-only key (D-64, D-71 (1)); on mainnet a separate key from the owner's Trezor hardware wallet, used only for deployment (D-71 (1), superseding D-64's shared key), so testnet and mainnet addresses differ (§9.1). All roles are transferred to the Safe in the same script; the deployer retains no role (CI check). Mainnet contracts are initialised paused and unpaused by the Safe once the configured grant and target admin delays are in effect (§5).
- Export ABIs and addresses as release artifacts, imported into the private in-repo package `@4thtech-io/occ-v2-abi` and bundled into the CLI; never published to npm (D-83).

### 9.1 Salts, addresses and the deployer key (G-8)

*Status: decided by the owner (D-63 (1)): Base Sepolia first, Gnosis Chiado later at the same CREATE3 addresses. Everything else in this section, including what follows from that order, is proposed; the owner confirms at merge (D-63 (2), (3)). D-64 (1) and (2) (owner decisions, 14 Oct 2026: one key and one label for testnets and mainnets) are superseded by D-71 (1) (owner decision, 15 Oct 2026): the testnet key is for testnets only, mainnet uses a separate key from the owner's Trezor hardware wallet, and mainnet addresses differ from the testnet addresses (owner-confirmed). **Campaign**, controls 2 and 3 and **Testnet and mainnet addresses** reflect this.*

**Campaign.** A campaign is one set of contract addresses: one deployer key plus one campaign label (`campaign-1`, then `campaign-2` after a full redeploy, …; proposed). Testnets and mainnets are separate campaigns with separate keys (D-71 (1)), so their addresses differ (**Testnet and mainnet addresses**, below). A campaign is deployed chain by chain and in stages (M1: AccessManager, vault and Notary; M2: Registry; later modules), possibly months apart. Every chain of a campaign gets the same addresses. On each chain the stages run in order, because a later stage's initializer points at earlier-stage addresses.

**Salt layout.** Every CreateX salt is 32 bytes:

| Bytes | Content |
|---|---|
| 0–19 | The **guard**: the address that calls CreateX. Because it equals the caller, CreateX hashes it into the salt (permissioned deploy protection), so no other account can deploy at the resulting address, and a mempool observer cannot front-run it |
| 20 | `0x00`: **no** cross-chain redeploy protection; the chain ID is not hashed into the salt |
| 21–31 | `bytes11(keccak256(label))`, where `label` is the ASCII string in the table below |

CreateX turns this into the guarded salt `keccak256(abi.encode(bytes32(uint256(uint160(guard))), salt))` and deploys at the CREATE3 (or CREATE2) address of the guarded salt from the canonical CreateX address. CreateX itself reverts if the guard is the caller and byte 20 is neither `0x00` nor `0x01`. The guard must be CreateX's `msg.sender`: the account or contract that calls CreateX directly, never through a forwarder or multicall (otherwise CreateX silently takes its unguarded branch). The script additionally refuses a salt whose bytes 0–19 differ from that caller, a zero guard (with `0x00` it would fall into the unguarded branch), and byte 20 = `0x01`. A fork test proves that the script's offline computation equals the address CreateX actually deploys to, against the pinned CreateX code hash (M1-14).

**Salt families** (`<c>` is the campaign label):

| Contract | Opcode | Guard | Label | On upgrade |
|---|---|---|---|---|
| Stage deployer (one-shot contract) | CREATE3 | Deployer key | `agentlink/occ-v2/<c>/deployer/<stage>` (`m1`, `m2-registry`, …) | — |
| AccessManager | CREATE3 | Stage deployer (or the deployer key, see **Gas and size**) | `agentlink/occ-v2/<c>/AccessManager` | Never changes (not upgradeable) |
| Proxy (vault, Notary, Registry, later modules) | CREATE3 | Stage deployer | `agentlink/occ-v2/<c>/proxy/<Contract>` | Never changes |
| Implementation | CREATE2 | The key that deploys it | `agentlink/occ-v2/<c>/impl/<Contract>/<version>` | New version label, new address |

- **Proxies carry no version.** A proxy address is the contract's identity on every chain and survives every upgrade. An upgrade changes only the ERC-1967 implementation slot (`upgradeToAndCall` through `UPGRADER`, §5.1). No upgrade needs the campaign deployer key.
- **Implementations use CREATE2,** so the address commits to the init code: the same build under the same guard gives the same address, and anyone can recompute it from the audited bytecode. An implementation holds no power (initializers disabled in the constructor, UUPS functions `onlyProxy`), so it may be deployed in an earlier transaction than its stage. That keeps the stage transaction small. An upgrade's implementation is deployed by whichever key prepares the upgrade; the upgrade evidence (`release-and-deployment.md` §4.4) states its salt, guard, predicted address and runtime code hash.
- **Stage deployer.** The guard of the AccessManager and the proxies is a one-shot contract that performs its whole stage in its constructor: the AccessManager with itself as initial admin, each proxy with its initializer, `OCCRoleSetup.configure`, the role grants, and renouncing `ADMIN_ROLE`. So no transaction exists in which the deployer holds power over a live proxy (M1-3g, option (a)). It is deployed with CREATE3 under the deployer key's guard, so its address, and therefore every address it guards, is the same on every chain, although its constructor arguments (the per-chain config) differ. A guard is never deployed with plain CREATE: its address would depend on the key's nonce and differ per chain. A stage without AccessManager setup (the Registry) still uses its own stage deployer, so one rule covers every stage.
- **Authority is explicit.** Under CREATE3 a constructor's `msg.sender` is CreateX's intermediate proxy, and under `deployCreate3AndInit` an initializer's `msg.sender` is CreateX itself. So every constructor and initializer takes its authority (AccessManager `initialAdmin`, `authority`, any owner) as an explicit argument, never from `msg.sender`. The post-deploy check confirms that neither CreateX nor any CREATE3 intermediate address holds a role.
- **The stage deployer has no callable function.** Its runtime code is non-empty (CreateX refuses empty code), but every call reverts. Otherwise it would remain a guard through which a caller could create contracts at its addresses on chains not yet reached. A test asserts that every call reverts, and the post-deploy check pins its runtime code hash.
- **Deploy and initialise atomically.** Each proxy's init code carries its implementation and initializer call (ERC-1967 proxy constructor; preferred). CreateX `deployCreate3AndInit` is allowed only for an initializer that takes nothing from `msg.sender`. Either way it is one call, so no uninitialised proxy exists in any block. Because proxy addresses are predicted before deployment, the vault initializer registers the Notary as a module at its predicted address (M1-3b).
- **Gas and size.** The stage transaction must fit, with margin, under the lowest block gas limit and the lowest per-transaction gas cap (EIP-7825, 2^24 gas, on chains that enforce it) of every chain planned for the campaign, not just the chain deployed first. The stage deployer's init code, which embeds the creation code it deploys, must be within the EIP-3860 limit of 49 152 bytes. Both are checked on the fork dry-run, and the limits are recorded by M1-14 and M3-2a. Otherwise a later chain could never reproduce the addresses. If the init code is too large, the AccessManager is deployed in an earlier transaction under the deployer key's guard (same label), with `initialAdmin` set explicitly to the predicted stage deployer address. Under D-64 (2) the testnet stage was also sized for Base, Gnosis and the planned M4 mainnets; since D-71 (1) the mainnet campaign is separate, so its own fork dry-run checks the mainnet limits for the audited build (derived, proposed; owner confirms at merge). CREATE3 addresses depend only on guards and labels, not on code, so the audited build keeps the addresses. But the guard layout (the AccessManager under the stage deployer, or the fallback under the deployer key) and every label are frozen for the campaign from its first deployment (M1-3g): changing either changes that campaign's addresses. If the audited build cannot fit a planned chain without such a change, the campaign needs a new label and new addresses.

**Why the chain ID is off.** Identical addresses across chains require that the chain ID is not part of the guarded salt. The cost: whoever holds the deployer key can deploy **any** code at the campaign's addresses on every chain the campaign has not reached yet, because a CREATE3 address does not commit to code. Turning the chain ID on would not stop the key holder from deploying elsewhere; it would only give each chain its own addresses, and lose the identical-address property 03 §7 relies on. This is accepted, with these controls:

1. Clients, the verifier and the submitter take contract addresses only from the shipped per-chain config (07 §6.1), keyed by chain ID. They never assume a contract exists at the campaign's addresses on a chain the config does not list. Published address lists name the chains they cover and never imply that a chain they do not list has AgentLink contracts at those addresses.
2. The **mainnet** deployer key. **D-71 (1) (owner decision, Tali, in chat, 15 Oct 2026; supersedes D-64 (1)):** a separate deployer key from the owner's Trezor hardware wallet, never the testnet key (control 3). It never touches GitHub or CI, so the mainnet deploy is an owner-signed manual deploy (`release-and-deployment.md` §4.3; tooling in M3-2d, proposed). It is kept offline between deployment sessions and retained while any mainnet chain or stage of the campaign is still planned (M2 Registry, M4 chains). It holds no role after each stage, so its compromise gives no power over deployed contracts, only the squatting risk above. A compromise is an incident: every chain not yet deployed gets a new campaign (new key, new addresses), listed per chain ID.
3. The **testnet deployer key** (D-64, as amended by D-71 (1): **testnets only**) is retained while any testnet chain or stage of the campaign is planned, so that Gnosis Chiado (D-63), the M2 Registry stage and later testnets land at the Base Sepolia addresses. It sits in CI as a **repository secret** of the private contracts repo (GitHub Free: no environments on private repositories, D-27), with process-only protection: manual dispatch, broadcast only after the owner's explicit "go", mainnet chain IDs refused, and agents never approving or broadcasting on their own (D-71 (1), `release-and-deployment.md` §4.2). **Residual (owner-accepted, D-71 (1)):** anyone, or any agent, with write access to the repo could run the workflow, or read the secret in a workflow they write. Anyone who obtains the key can squat (put any code at) the testnet campaign's addresses on every testnet chain and stage not yet deployed: the Chiado M1 stage, the M2 Registry stage and any M4 testnets. They can also put code at the testnet campaign's addresses on mainnet chains (IR-G-8-1 M-1); control 1 keeps clients from trusting those addresses, because a chain's addresses come only from the per-chain config. Since D-71 (1) our mainnet contracts come from a separate key at different addresses, so this risk no longer reaches them. The label is public (this section) and the key's address is public from its first testnet transaction, so anyone can compute these addresses; only the key protects them. A squat makes our deploy fail closed (control 4), but that address is lost on that chain. **A compromise, or a suspected one, forces a new key and a new label, and so new addresses** on every testnet not yet deployed.

   Controls (proposed; owner confirms at merge):
   - the key's CI lifecycle, **amended by D-71 (1)** (owner decisions, 15 Oct 2026): the key stays a repository secret for further testnet deploys, with process-only protection and the residual above, never touches mainnet, and is deleted when the testnets end; the owner holds the only other copy offline;
   - testnet deploys run only while testnet chains or stages of the campaign are planned; M4 testnets join the testnet campaign with the same key and label;
   - the pre-broadcast check below detects a squat and fails closed;
   - the owner explicitly accepts this residual risk on testnets (faucet funds only) at merge of D-63;
   - the D-64 mitigations that still apply to the testnet key (`release-and-deployment.md` §4.2), among them: it is never imported into a browser extension or hot wallet; monitoring of the deployer's nonce and balance on every planned testnet; CI hardening while the secret is stored;
   - *(superseded by D-71 (1): mainnet has its own key, so the D-64 go-or-switch reassessment no longer applies.)*

   Rotating the testnet key, on suspicion or by choice, means a new key and a new label: new addresses on every testnet not yet deployed, a testnet redeploy, and a new ABI prerelease.
4. The pre-broadcast check fails closed if any predicted address is already used (below).

**Testnet and mainnet addresses (D-64 (2), superseded by D-71 (1)).** D-64 (2) gave testnets and mainnets one shared label and, with the shared key, identical addresses. D-71 (1) (owner decision, 15 Oct 2026) gives mainnet a separate deployer key on the owner's Trezor hardware wallet. **Owner-confirmed consequence** (Tali, in chat, 15 Oct 2026: "Yes, I'm aware that main net contracts will differ from test net ones. It's not a problem."): mainnet CREATE3 addresses differ from the testnet addresses, because they depend on the deployer and its guarded salt, and the per-chain deployments table (the shipped per-chain config, 07 §6.1; control 1) is the source of truth. The D-64 (2) consequences below hold only where noted:

- (i) **Identical addresses within one campaign:** the stage deployers, the AccessManager and every proxy are identical across the testnets (one testnet campaign) and across the mainnets (one mainnet campaign), but the two sets differ (D-71 (1)). The mainnet run's predictions must equal the mainnet campaign's address file (**Before broadcast**, step 2).
- (ii) *(no longer holds, D-71 (1))* The squat risk of the testnet phase no longer reaches the mainnet addresses, which come from a separate key.
- (iii) **CREATE3 addresses are single-use per label on each chain.** Upgrades through the existing proxies keep the addresses (an upgrade changes only the implementation slot). A **full** testnet redeploy, for example after a storage redesign, cannot reuse the label on a chain where it has been used, so it needs a new label and gets new addresses on every testnet. Older testnet addresses are dropped from the per-chain config. If a key is compromised, both the key and the label change, and so do the addresses (a new key alone already changes them; the new label keeps one label per key and one address file per campaign).
- (iv) **Clients map addresses per chain ID** (control 1). The same address on another chain never implies that our contracts are there unless the per-chain config lists that chain. **A testnet proof is not a mainnet proof:** the chain ID is bound in the EIP-712 domain, and since D-71 (1) the contract address differs too. The verify page and `agentlink verify` still label testnet chain IDs prominently and never present a testnet proof as a mainnet one (M1-9h, M2-5a).

Mainnet uses its own key and label, so its addresses differ from the testnet addresses without any testnet redeploy (D-71 (1)).

**Before broadcast (fork dry-run).** The script runs on an anvil fork of the target chain at its latest block, then repeats steps 1–3 as its first action on the live chain:

1. It checks the CreateX runtime code hash at the canonical address (M1-14).
2. It computes every guarded salt and predicted address and compares them with the campaign's committed address file (private repo, `script/config/addresses/<campaign>.json`). On the campaign's first chain the file is written from the dry-run and reviewed in the deploy PR. On every later chain the predictions must equal the file, which equals the addresses already published.
3. It checks that no predicted address of the stage, including the CREATE3 intermediate addresses, has code or a nonzero nonce.
4. It runs the stage on the fork and checks that the deployed addresses equal the predictions and that the post-deploy checks (M1-3g; `release-and-deployment.md` §4.3) pass.

Only then does CI (testnets) or the owner (mainnet, `release-and-deployment.md` §4.3) broadcast.

**Salt already used: fail closed.** If any predicted address of a stage, including the CREATE3 intermediate addresses, has code or a nonzero nonce, the script stops before broadcast. On-chain, CreateX reverts on the collision, and the stage is one transaction, so nothing partial remains. The script never bumps a label, adds entropy or falls back to another salt. The only exception is an implementation whose predicted CREATE2 address already holds exactly the expected runtime code hash: it is reused, since CREATE2 binds the code. Otherwise a person decides. If the code is our own verified deployment of that stage, nothing is redeployed. If not, it is an incident (possible key compromise), and continuing needs a new campaign, decided by the owner.

---

## 10. Licensing (proposed — confirm with counsel)

- Beta: private repository.
- Mainnet: verified source published under **Business Source License 1.1**:
  - Licensor: the operating entity (TBD).
  - Additional Use Grant: non-commercial use, testing, security research, and use through the canonical deployments.
  - Change Date: three years after mainnet launch; Change License: GPL-2.0-or-later.
- Rationale: verified source is needed for trust in a notary, but bytecode is public anyway, so secrecy doesn't prevent forks. BUSL limits commercial forks; network effects and integrator fees remove the incentive to fork.
