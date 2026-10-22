// M1-4c-b: the direct-mode transaction signer behind KeyStore.signTransaction (07 §6.2, 03 §4.3,
// 05 §2.5; 04 §2.1 EVM key, §8.1). The agent's own account sends a Notary or vault call and pays the
// network fee itself. Every KeyStore backend calls directTransactionSnapshot(tx, ownAddress) before
// it reads a seed, then signDirectTransaction(secretKey, snapshot) with the EVM key (epoch 0); the
// signer is exported only from the restricted @4thtech-io/crypto/keystore entry.
//
// The serialisation is EIP-2718 type 2 (EIP-1559): 0x02 || RLP([chainId, nonce,
// maxPriorityFeePerGas, maxFeePerGas, gas, to, value, data, accessList, yParity, r, s]), signed over
// keccak256(0x02 || RLP(the first nine fields)). Keccak-256 comes from @noble/hashes and the ECDSA
// from ecdsa.ts (@noble/curves): this file is the RLP encoding over them, not a primitive (I-8). It
// is in-repo rather than viem's for the reason eip712.ts gives (07 §1, deps-check: crypto stays on
// noble and hpke); viem is the differential oracle in the tests.
//
// The signer is deliberately narrow, so the agent's EVM key can only ever send what direct mode
// sends (the KeyStore is not a general transaction signer):
// - EIP-1559 only, with the exact fields below as data properties, each read once, and no access
//   list;
// - a chain ID from DIRECT_TX_ALLOWLIST: the launch testnets only, so no mainnet transaction is ever
//   signed (D-40 testnet allowlist);
// - `to` is required (no contract creation) and is one of that chain's AgentLink contracts (Notary,
//   fee vault) or an offered fee token;
// - the call is one of the direct-mode functions for that contract, by selector: `notarizeDirect`,
//   `notarizeBatch`, `acknowledge`, `acknowledgeBatch` on the Notary; `deposit` and `withdraw` on
//   the vault; `approve` on a fee token. `approve` names only the vault as spender; `withdraw` names
//   only the agent's own address as recipient (an owner action that names another recipient is a
//   later card); `deposit` carries value only for the native coin, and then exactly the amount;
// - value only on a payable call (`notarizeDirect`, a native `deposit`), at most MAX_TX_VALUE_WEI;
//   calldata at most MAX_TX_DATA_BYTES; gas and fee caps (below).
// Anything else is CryptoInputError `transaction_refused` with one fixed message per rule
// (TRANSACTION_REFUSED), which never names an input (I-7).
import { concatBytes } from './bytes.js';
import { signDigestEcdsa } from './ecdsa.js';
import { decodeHex0x, encodeHex0x } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { keccak256 } from './hash.js';

/**
 * The transaction a KeyStore is asked to sign (07 §6.2 direct mode). Addresses and calldata are
 * lowercase `0x` hex; amounts are bigints; chainId and nonce are safe integers.
 */
export interface DirectTransaction {
  readonly type: 'eip1559';
  readonly chainId: number;
  readonly nonce: number;
  readonly gas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly to: string;
  readonly data: string;
  readonly value: bigint;
}

/** The AgentLink contracts and fee tokens a direct-mode transaction may call on one chain. */
export interface DirectTxChain {
  readonly notary: string;
  readonly vault: string;
  /** ERC-20 fee tokens (`approve` only); the native coin has no address. */
  readonly feeTokens: readonly string[];
}

// The OCC v2 contracts are at the same address on every chain (CREATE3, 05 §9); these are the
// pinned release's (@4thtech-io/occ-v2-abi v0.1.0-testnet.3). The chain package's tests check this
// table against that release and the shipped chain configs, so the two cannot drift apart.
const OCC_NOTARY = '0xb29dedee26d480105dad5b90f549a09d376d855f';
const OCC_VAULT = '0x91a40104553bd1731c3fbe05209a908b40e50f8d';

/**
 * Chain ID to what direct mode may call there. Testnets only (Base Sepolia, Gnosis Chiado): a
 * mainnet joins in its own reviewed change, never by configuration.
 */
export const DIRECT_TX_ALLOWLIST: Readonly<Record<number, DirectTxChain>> = Object.freeze({
  84532: Object.freeze({
    notary: OCC_NOTARY,
    vault: OCC_VAULT,
    // Circle's USDC on Base Sepolia (07 §6.1 config, M1-14).
    feeTokens: Object.freeze(['0x036cbd53842c5426634e7929541ec2318f3dcf7e']),
  }),
  10200: Object.freeze({
    notary: OCC_NOTARY,
    vault: OCC_VAULT,
    // Native xDAI only (D-46).
    feeTokens: Object.freeze([] as string[]),
  }),
});

/** Largest calldata, in bytes. A one-item notarizeBatch is under 1 KiB. */
export const MAX_TX_DATA_BYTES = 65_536;
/** Largest gas limit. */
export const MAX_TX_GAS = 15_000_000n;
/** Largest maxFeePerGas, in wei (10 000 gwei). */
export const MAX_FEE_PER_GAS_WEI = 10_000_000_000_000n;
/** Largest native value, in wei (100 coins; testnet top-ups and fees are far below). */
export const MAX_TX_VALUE_WEI = 100_000_000_000_000_000_000n;

/** The function selectors direct mode sends (checked against the ABIs in the chain package). */
export const DIRECT_TX_SELECTORS = Object.freeze({
  /** notarizeDirect((address,bytes32,bytes32,bytes32,bytes32,uint8,address,uint256,uint256,uint64)) */
  notarizeDirect: '0xc814929f',
  /** notarizeBatch((…)[],bytes[]) */
  notarizeBatch: '0x026e3ca5',
  /** acknowledge((address,bytes32,uint8,bytes32,uint64),bytes) */
  acknowledge: '0x4b27b9c3',
  /** acknowledgeBatch((address,bytes32,uint8,bytes32,uint64)[],bytes[]) */
  acknowledgeBatch: '0xb87c66ed',
  /** deposit(address,uint256) */
  deposit: '0x47e7ef24',
  /** withdraw(address,uint256,address) */
  withdraw: '0x69328dec',
  /** approve(address,uint256) */
  approve: '0x095ea7b3',
});

/** Why a transaction was refused. Stable strings. */
export type TransactionRefusal =
  | 'malformed'
  | 'not_eip1559'
  | 'chain_not_allowed'
  | 'contract_creation'
  | 'destination_not_allowed'
  | 'call_not_allowed'
  | 'data_too_large'
  | 'value_not_allowed'
  | 'fee_out_of_bounds';

/** The one fixed message per refusal (I-7: none names an input). */
export const TRANSACTION_REFUSED: Readonly<Record<TransactionRefusal, string>> = Object.freeze({
  malformed: 'signTransaction: not a transaction of the direct-mode form',
  not_eip1559: 'signTransaction: only EIP-1559 transactions are signed',
  chain_not_allowed: 'signTransaction: that network is not one direct mode sends on',
  contract_creation: 'signTransaction: a transaction without a destination is never signed',
  destination_not_allowed: 'signTransaction: the destination is not an AgentLink contract',
  call_not_allowed: 'signTransaction: not a call direct mode sends',
  data_too_large: 'signTransaction: the call data is too large',
  value_not_allowed: 'signTransaction: the value is not allowed for this call',
  fee_out_of_bounds: 'signTransaction: the gas or fee limits are out of bounds',
});

const refused = (reason: TransactionRefusal): CryptoInputError =>
  new CryptoInputError('transaction_refused', TRANSACTION_REFUSED[reason]);

const TX_KEYS = [
  'chainId',
  'data',
  'gas',
  'maxFeePerGas',
  'maxPriorityFeePerGas',
  'nonce',
  'to',
  'type',
  'value',
];
const ADDRESS = /^0x[0-9a-f]{40}$/;
const DATA = /^0x(?:[0-9a-f]{2})*$/;
const ZERO_WORD_PREFIX = '0'.repeat(24);

/** The data properties of a plain object, each read once; anything else is `malformed`. */
function readFields(tx: unknown): Record<string, unknown> {
  if (typeof tx !== 'object' || tx === null || Array.isArray(tx)) throw refused('malformed');
  const proto = Object.getPrototypeOf(tx) as unknown;
  if (proto !== Object.prototype && proto !== null) throw refused('malformed');
  const keys = Reflect.ownKeys(tx);
  if (keys.length !== TX_KEYS.length) throw refused('malformed');
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== 'string' || !TX_KEYS.includes(key)) throw refused('malformed');
    const d = Object.getOwnPropertyDescriptor(tx, key);
    if (d === undefined || !('value' in d)) throw refused('malformed');
    out[key] = d.value;
  }
  return out;
}

/** The 32-byte ABI words after the selector, or undefined when the length is not `count` words. */
function words(data: string, count: number): string[] | undefined {
  const body = data.slice(10);
  if (body.length !== count * 64) return undefined;
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) out.push(body.slice(i * 64, (i + 1) * 64));
  return out;
}

/** An ABI-encoded address word as `0x` + 40 lowercase hex, or undefined when the high bytes are set. */
function addressWord(word: string | undefined): string | undefined {
  if (word === undefined || !word.startsWith(ZERO_WORD_PREFIX)) return undefined;
  return `0x${word.slice(24)}`;
}

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

/** Checks the call against the per-contract rules; `value` is already within MAX_TX_VALUE_WEI. */
function checkCall(chain: DirectTxChain, to: string, data: string, value: bigint, own: string) {
  if (data.length < 10) throw refused('call_not_allowed');
  const selector = data.slice(0, 10);
  const S = DIRECT_TX_SELECTORS;
  if (to === chain.notary) {
    if (
      selector !== S.notarizeDirect &&
      selector !== S.notarizeBatch &&
      selector !== S.acknowledge &&
      selector !== S.acknowledgeBatch
    ) {
      throw refused('call_not_allowed');
    }
    // notarizeDirect pays now (05 §3.2): the native fee rides along as value. Nothing else is payable.
    if (value !== 0n && selector !== S.notarizeDirect) throw refused('value_not_allowed');
    return;
  }
  if (to === chain.vault) {
    if (selector === S.deposit) {
      const w = words(data, 2);
      const token = addressWord(w?.[0]);
      if (w === undefined || token === undefined) throw refused('call_not_allowed');
      const amount = BigInt(`0x${w[1] as string}`);
      // A native deposit carries exactly the amount; a token deposit carries none.
      const want = token === ZERO_ADDRESS ? amount : 0n;
      if (value !== want) throw refused('value_not_allowed');
      return;
    }
    if (selector === S.withdraw) {
      const w = words(data, 3);
      const token = addressWord(w?.[0]);
      const recipient = addressWord(w?.[2]);
      // The agent's own credits back to the agent's own account only.
      if (token === undefined || recipient !== own) throw refused('call_not_allowed');
      if (value !== 0n) throw refused('value_not_allowed');
      return;
    }
    throw refused('call_not_allowed');
  }
  if (chain.feeTokens.includes(to)) {
    const w = words(data, 2);
    // `approve(vault, amount)`, never another spender.
    if (selector !== S.approve || addressWord(w?.[0]) !== chain.vault) {
      throw refused('call_not_allowed');
    }
    if (value !== 0n) throw refused('value_not_allowed');
    return;
  }
  throw refused('destination_not_allowed');
}

const isBigIntIn = (v: unknown, min: bigint, max: bigint): v is bigint =>
  typeof v === 'bigint' && v >= min && v <= max;

/**
 * Checks a direct-mode transaction against the rules above and returns a frozen plain copy of it
 * (each field read once), or throws CryptoInputError `transaction_refused` with the fixed message
 * of the rule that failed. `ownAddress` is the signing agent's EVM address (`0x` + 40 lowercase
 * hex), the only recipient a `withdraw` may name. Public inputs only: backends call it before they
 * read a seed, so a refused transaction never touches key material.
 */
export function directTransactionSnapshot(tx: unknown, ownAddress: string): DirectTransaction {
  if (typeof ownAddress !== 'string' || !ADDRESS.test(ownAddress)) throw refused('malformed');
  const f = readFields(tx);
  if (f.type !== 'eip1559') throw refused('not_eip1559');
  const { chainId, nonce, gas, maxFeePerGas, maxPriorityFeePerGas, to, data, value } = f;
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId < 1) {
    throw refused('malformed');
  }
  const chain = Object.hasOwn(DIRECT_TX_ALLOWLIST, chainId)
    ? DIRECT_TX_ALLOWLIST[chainId]
    : undefined;
  if (chain === undefined) throw refused('chain_not_allowed');
  if (to === undefined || to === null || to === '' || to === '0x') {
    throw refused('contract_creation');
  }
  if (typeof to !== 'string' || !ADDRESS.test(to)) throw refused('malformed');
  if (typeof nonce !== 'number' || !Number.isSafeInteger(nonce) || nonce < 0) {
    throw refused('malformed');
  }
  if (typeof data !== 'string' || !DATA.test(data)) throw refused('malformed');
  if ((data.length - 2) / 2 > MAX_TX_DATA_BYTES) throw refused('data_too_large');
  if (
    !isBigIntIn(gas, 21_000n, MAX_TX_GAS) ||
    !isBigIntIn(maxFeePerGas, 1n, MAX_FEE_PER_GAS_WEI) ||
    !isBigIntIn(maxPriorityFeePerGas, 0n, maxFeePerGas as bigint)
  ) {
    throw refused('fee_out_of_bounds');
  }
  if (typeof value !== 'bigint') throw refused('malformed');
  if (value < 0n || value > MAX_TX_VALUE_WEI) throw refused('value_not_allowed');
  checkCall(chain, to, data, value, ownAddress);
  return Object.freeze({
    type: 'eip1559',
    chainId,
    nonce,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas: maxPriorityFeePerGas as bigint,
    to,
    data,
    value,
  });
}

// --- RLP (Ethereum Yellow Paper, appendix B) ------------------------------------------------------

/** Minimal big-endian bytes of a non-negative integer; zero is the empty string. */
function intBytes(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array(0);
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  return decodeHex0x(`0x${hex}`);
}

function lengthPrefix(length: number, short: number, long: number): Uint8Array {
  if (length <= 55) return Uint8Array.of(short + length);
  const len = intBytes(BigInt(length));
  return concatBytes(Uint8Array.of(long + len.length), len);
}

function rlpBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 1 && (bytes[0] as number) < 0x80) return bytes;
  return concatBytes(lengthPrefix(bytes.length, 0x80, 0xb7), bytes);
}

function rlpList(items: readonly Uint8Array[]): Uint8Array {
  const payload = concatBytes(...items);
  return concatBytes(lengthPrefix(payload.length, 0xc0, 0xf7), payload);
}

const hexBytes = (hex: string): Uint8Array => (hex === '0x' ? new Uint8Array(0) : decodeHex0x(hex));

/** The nine unsigned fields, RLP-encoded. */
function unsignedFields(tx: DirectTransaction): Uint8Array[] {
  return [
    rlpBytes(intBytes(BigInt(tx.chainId))),
    rlpBytes(intBytes(BigInt(tx.nonce))),
    rlpBytes(intBytes(tx.maxPriorityFeePerGas)),
    rlpBytes(intBytes(tx.maxFeePerGas)),
    rlpBytes(intBytes(tx.gas)),
    rlpBytes(hexBytes(tx.to)),
    rlpBytes(intBytes(tx.value)),
    rlpBytes(hexBytes(tx.data)),
    rlpList([]),
  ];
}

const TYPE_EIP1559 = Uint8Array.of(0x02);

/** The digest a type-2 transaction is signed over: keccak256(0x02 || RLP(unsigned fields)). */
export function directTransactionDigest(tx: DirectTransaction): Uint8Array {
  return keccak256(concatBytes(TYPE_EIP1559, rlpList(unsignedFields(tx))));
}

/** The minimal integer bytes of a 32-byte big-endian scalar. */
function scalarBytes(bytes: Uint8Array): Uint8Array {
  let i = 0;
  while (i < bytes.length && bytes[i] === 0) i += 1;
  return bytes.slice(i);
}

/**
 * Signs a snapshot from directTransactionSnapshot with the agent's EVM secret key and returns the
 * serialised signed transaction, `0x02…` lowercase hex. For KeyStore implementations only
 * (04 §8.1). The snapshot is checked again here, so no caller can skip the rules; the key is read,
 * never copied or retained.
 */
export function signDirectTransaction(
  secretKey: Uint8Array,
  tx: DirectTransaction,
  ownAddress: string,
): string {
  const snapshot = directTransactionSnapshot(tx, ownAddress);
  const fields = unsignedFields(snapshot);
  const digest = keccak256(concatBytes(TYPE_EIP1559, rlpList(fields)));
  const sig = signDigestEcdsa(digest, secretKey);
  const yParity = (sig[64] as number) - 27;
  const signed = rlpList([
    ...fields,
    rlpBytes(intBytes(BigInt(yParity))),
    rlpBytes(scalarBytes(sig.subarray(0, 32))),
    rlpBytes(scalarBytes(sig.subarray(32, 64))),
  ]);
  return encodeHex0x(concatBytes(TYPE_EIP1559, signed));
}
