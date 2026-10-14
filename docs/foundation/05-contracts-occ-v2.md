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

- `FEE_ADMIN` sets `protocolFee` ≤ `maxProtocolFee` (immediate).
- `maxProtocolFee` can be **lowered** immediately and only **raised** with a 7-day execution delay, so users see fee-cap increases in advance.
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

**Direct payment** (no credits): modules expose `payable` "direct" functions where `msg.sender` is the payer. The module forwards funds via `vault.depositFromModule{value}(payer, token, amount)`. This function is module-only and pulls ERC-20s from `payer` with `transferFrom` (payer must have approved the vault). It is followed immediately by `charge`.

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

> Privacy note: a receipt reveals the salt, linking the recipient's agent address to the record. Records without receipts reveal only the salted commitment. Per-relationship agent keys (P2) reduce linkability.

Verifiers can check everything shown in a proof (signer, time, envelope hash, recipient, receipts with timestamps, and all other record fields via `recordStructHash`) from `getRecord` alone. That matters because some RPCs prune old logs.

### 3.4 Gas targets (including 21k intrinsic gas; verify with snapshots)

| Function | Target |
|---|---|
| `notarize` (credits, EOA) | ≤ 160k |
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

OpenZeppelin `AccessManager` with **per-function execution delays**:

| Role | Holder | Powers | Delay |
|---|---|---|---|
| `ADMIN` | 4thTech Safe (≥ 2-of-3) | Grant roles, register modules, allowlist tokens, set `minDeposit` | 48 h |
| `FEE_ADMIN` | 4thTech Safe | Set fees ≤ caps, lower caps, (de)activate apps | 0 |
| `CAP_RAISER` | 4thTech Safe | Raise `maxProtocolFee`, change `integratorFeeCapMultiple` | 7 days |
| `TREASURY_ADMIN` | 4thTech Safe | Change treasury | 7 days |
| `PAUSER` | Ops hardware key + Safe | Pause charging/notarization (never withdrawals) | 0 |
| `UPGRADER` | 4thTech Safe | Notary/Registry upgrades: 48 h. Vault upgrades: 7 days (users can withdraw first) | 48 h / 7 days |

**Freeze:** the Notary has a one-way `freezeUpgrades()` (ADMIN, 7-day delay). After it runs, `_authorizeUpgrade` always reverts, regardless of roles. It is executed at GA so records stay permanently neutral. The vault stays upgradeable with a 7-day delay.

Contracts are UUPS proxies with ERC-7201 namespaced storage.

---

## 6. Events

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
FeeSet / CapSet / AppRegistered / IntegratorFeeSet / AppStatusChanged / ModuleSet / TokenAllowed / UpgradesFrozen
```

---

## 7. Errors (custom errors only)

`Expired()`, `InvalidSignature()`, `RecordExists()`, `RecordNotFound()`, `ReceiptExists()`, `ConflictingReceipt()`, `NotRecipient()`, `NotSigner()`, `InsufficientCredits(address,address,uint256,uint256)`, `FeeAboveMax(uint256,uint256)`, `TokenNotAllowed(address)`, `BelowMinDeposit()`, `NotModule()`, `AppExists()`, `AppInactive()`, `NotIntegrator()`, `FeeAboveCap()`, `Paused()`, `UpgradesAreFrozen()`, `ZeroAddress()`, `TransferFailed()`.

---

## 8. Testing and security gates

- Unit tests for every function and revert path; **fuzz tests** for signatures, fees, credits; **invariant tests**:
  - Σ credits + Σ protocolAccrued + Σ integratorAccrued **≤** vault balance (per token; funds can be force-sent).
  - A record's fields never change after creation; receipt flags and timestamps only ever get set once.
  - No role can reduce a payer's credits.
  - After `freezeUpgrades`, no upgrade succeeds.
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
- Deployer key: fresh hardware-backed key used only for deployment; all roles transferred to the Safe in the same script; deployer retains no role (CI check).
- Publish ABIs and addresses as `@agentlink/occ-v2-abi`.

---

## 10. Licensing (proposed — confirm with counsel)

- Beta: private repository.
- Mainnet: verified source published under **Business Source License 1.1**:
  - Licensor: the operating entity (TBD).
  - Additional Use Grant: non-commercial use, testing, security research, and use through the canonical deployments.
  - Change Date: three years after mainnet launch; Change License: GPL-2.0-or-later.
- Rationale: verified source is needed for trust in a notary, but bytecode is public anyway, so secrecy doesn't prevent forks. BUSL limits commercial forks; network effects and integrator fees remove the incentive to fork.
