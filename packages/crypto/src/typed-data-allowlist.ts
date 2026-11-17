// SEC-KS-712-ALLOWLIST: what the agent key signs through KeyStore.sign712 (04 §3.1.1, 07 §6.2).
//
// The agent EVM key signs only AgentLink's own record, receipt, card and top-up formats. Every
// KeyStore backend calls typedDataSnapshot(typedData, ownAddress, nowSeconds) before it reads a
// seed, and signs the snapshot it returns, never the caller's object. Stateless: no counters, so
// nothing to restore or sync. An OwnerSession's sign712 (cardSig, Registration) is not affected.
//
// Allowed, with the exact types of @4thtech-io/crypto (field names, types and order) and exactly the
// declared fields:
// - OCC v2 `Record` under {name "OCC", version "2", chainId of TYPED_DATA_ALLOWLIST, that chain's
//   Notary}: `signer` is this agent, `appId` is AGENT_APP_ID (official clients, 12 §4.3),
//   `feeToken` is a fee token of that chain and `maxFee` is at most its ceiling (the NOTARIZE fee
//   cap, $0.50 in token units), `deadline` at most MAX_PROOF_DEADLINE_SECONDS from now;
// - OCC v2 `Receipt` under the same domain: `signer` is this agent, the same deadline bound;
// - `AgentCard` under the chain-agnostic card domain (04 §2.4): `agentEvm` is this agent;
// - EIP-3009 `ReceiveWithAuthorization` under the domain of a top-up token of an allowlisted chain
//   (its address, name and version): `from` is this agent, `to` is that chain's fee vault,
//   `value` at most the token's cap, `validBefore` at most MAX_TOP_UP_WINDOW_SECONDS from now.
// Anything else is CryptoInputError `typed_data_refused` with the fixed message of the rule
// (TYPED_DATA_REFUSED), which never names an input (I-7).
//
// The tables follow DIRECT_TX_ALLOWLIST (the launch testnets only; a mainnet joins in its own
// reviewed change, never by configuration). The chain package's tests check them against the
// shipped chain configs, so the two cannot drift apart.
import { AGENT_CARD_DOMAIN, AGENT_CARD_TYPES } from './agent-card.js';
import type { TypedData, TypedDataField, TypedDataTypes } from './eip712.js';
import { CryptoInputError } from './errors.js';
import { DIRECT_TX_ALLOWLIST } from './evm-tx.js';
import {
  OCC_V2_DOMAIN_NAME,
  OCC_V2_DOMAIN_VERSION,
  RECEIPT_TYPES,
  RECEIVE_WITH_AUTHORIZATION_TYPES,
  RECORD_TYPES,
} from './proof-types.js';

/** A token the vault top-up may authorize, with its own EIP-712 domain name and version. */
export interface TopUpToken {
  readonly name: string;
  readonly version: string;
  /** The most one authorization may move, in base units. */
  readonly maxValue: bigint;
}

/** What the agent key may sign for on one chain. Addresses are lowercase. */
export interface TypedDataChain {
  readonly notary: string;
  readonly vault: string;
  /** Record fee token (address(0) for the native coin) to the highest `maxFee`, in base units. */
  readonly recordFeeTokens: Readonly<Record<string, bigint>>;
  /** Tokens of the vault top-up (`ReceiveWithAuthorization`). */
  readonly topUpTokens: Readonly<Record<string, TopUpToken>>;
}

/** The app ID of the official clients (12 §4.3): the only one the agent key signs a Record for. */
export const AGENT_APP_ID = `0x${'0'.repeat(64)}`;

/** Records and receipts are signed with a deadline one hour out; five minutes for clock skew. */
export const MAX_PROOF_DEADLINE_SECONDS = 3_600 + 300;

/** Top-up authorizations are valid for at most 15 minutes; five minutes for clock skew. */
export const MAX_TOP_UP_WINDOW_SECONDS = 900 + 300;

const NATIVE = `0x${'0'.repeat(40)}`;
const USDC_BASE_SEPOLIA = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';

function chainOf(chainId: number) {
  const direct = DIRECT_TX_ALLOWLIST[chainId];
  if (direct === undefined) throw new Error('unreachable: not a direct-mode chain');
  return direct;
}

/**
 * Chain ID to what the agent key signs there. Testnets only (Base Sepolia, Gnosis Chiado), the same
 * contracts as DIRECT_TX_ALLOWLIST. Fee ceilings are the NOTARIZE cap ($0.50, 12 §2) of a $1
 * stablecoin; the top-up cap is $50 (the testnet gasless cap).
 */
export const TYPED_DATA_ALLOWLIST: Readonly<Record<number, TypedDataChain>> = Object.freeze({
  84532: Object.freeze({
    notary: chainOf(84532).notary,
    vault: chainOf(84532).vault,
    // Circle's USDC, 6 decimals.
    recordFeeTokens: Object.freeze({ [USDC_BASE_SEPOLIA]: 500_000n }),
    // Circle's USDC on Base Sepolia reports name "USDC", version "2" (test-vectors/eip3009).
    topUpTokens: Object.freeze({
      [USDC_BASE_SEPOLIA]: Object.freeze({ name: 'USDC', version: '2', maxValue: 50_000_000n }),
    }),
  }),
  10200: Object.freeze({
    notary: chainOf(10200).notary,
    vault: chainOf(10200).vault,
    // Native xDAI only (D-46), 18 decimals.
    recordFeeTokens: Object.freeze({ [NATIVE]: 500_000_000_000_000_000n }),
    topUpTokens: Object.freeze({}),
  }),
});

/** Why typed data was refused. Stable strings. */
export type TypedDataRefusal =
  | 'malformed'
  | 'type_not_allowed'
  | 'domain_not_allowed'
  | 'signer_not_allowed'
  | 'fee_not_allowed'
  | 'app_not_allowed'
  | 'deadline_not_allowed'
  | 'payee_not_allowed'
  | 'value_not_allowed';

/** The one fixed message per refusal (I-7: none names an input). */
export const TYPED_DATA_REFUSED: Readonly<Record<TypedDataRefusal, string>> = Object.freeze({
  malformed: 'sign712: not typed data of an allowed form',
  type_not_allowed: 'sign712: not a record, receipt, card or top-up the agent signs',
  domain_not_allowed: 'sign712: the domain is not an AgentLink contract or top-up token',
  signer_not_allowed: 'sign712: the agent signs only as itself',
  fee_not_allowed: 'sign712: the fee token or the fee ceiling is not allowed',
  app_not_allowed: 'sign712: only the official app ID is signed',
  deadline_not_allowed: 'sign712: the deadline is too far ahead',
  payee_not_allowed: 'sign712: a top-up pays only the fee vault',
  value_not_allowed: 'sign712: the top-up value is above the cap',
});

const refused = (reason: TypedDataRefusal): CryptoInputError =>
  new CryptoInputError('typed_data_refused', TYPED_DATA_REFUSED[reason]);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function isPlainObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Exactly the named own data properties of a plain object, read once into a copy. */
function exact(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value)) throw refused('malformed');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || !names.every((name) => keys.includes(name))) {
    throw refused('malformed');
  }
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !('value' in descriptor)) throw refused('malformed');
    out[name] = descriptor.value as unknown;
  }
  return out;
}

/** An address field, lowercase for comparison (the hash still checks its EIP-55 form). */
function address(value: unknown): string {
  if (typeof value !== 'string' || !ADDRESS.test(value)) throw refused('malformed');
  return value.toLowerCase();
}

/** An unsigned integer field as bigint (a safe-integer number or a bigint). */
function uint(value: unknown): bigint {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw refused('malformed');
}

/** The chain of an allowlisted chain ID, or `domain_not_allowed`. */
function allowedChain(chainId: unknown): TypedDataChain {
  let id: number;
  if (typeof chainId === 'number' && Number.isSafeInteger(chainId)) id = chainId;
  else if (typeof chainId === 'bigint' && chainId <= BigInt(Number.MAX_SAFE_INTEGER)) {
    id = Number(chainId);
  } else throw refused('domain_not_allowed');
  if (!Object.hasOwn(TYPED_DATA_ALLOWLIST, id)) throw refused('domain_not_allowed');
  return TYPED_DATA_ALLOWLIST[id] as TypedDataChain;
}

/** True when `types` declares exactly the struct types of `expected`, field for field. */
function sameTypes(types: unknown, expected: TypedDataTypes): boolean {
  if (!isPlainObject(types)) return false;
  const names = Object.keys(expected);
  const keys = Reflect.ownKeys(types);
  if (keys.length !== names.length || !names.every((name) => keys.includes(name))) return false;
  return names.every((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(types, name);
    if (descriptor === undefined || !('value' in descriptor)) return false;
    const members: unknown = descriptor.value;
    const want = expected[name] as readonly TypedDataField[];
    if (!Array.isArray(members) || members.length !== want.length) return false;
    return want.every((field, i) => {
      const member: unknown = members[i];
      if (!isPlainObject(member)) return false;
      const keysOf = Reflect.ownKeys(member);
      if (keysOf.length !== 2) return false;
      const n = Object.getOwnPropertyDescriptor(member, 'name');
      const t = Object.getOwnPropertyDescriptor(member, 'type');
      return n?.value === field.name && t?.value === field.type;
    });
  });
}

const AGENT_SHAPES: Readonly<Record<string, TypedDataTypes>> = Object.freeze({
  Record: RECORD_TYPES,
  Receipt: RECEIPT_TYPES,
  AgentCard: AGENT_CARD_TYPES,
  ReceiveWithAuthorization: RECEIVE_WITH_AUTHORIZATION_TYPES,
});

function memberNames(types: TypedDataTypes, primary: string): string[] {
  return (types[primary] ?? []).map((f) => f.name);
}

function deadlineWithin(value: unknown, nowSeconds: number, window: number): void {
  if (uint(value) > BigInt(nowSeconds + window)) throw refused('deadline_not_allowed');
}

/** The OCC v2 chain domain of an allowlisted chain's Notary; returns that chain. */
function occDomain(domain: Record<string, unknown>): TypedDataChain {
  if (domain.name !== OCC_V2_DOMAIN_NAME || domain.version !== OCC_V2_DOMAIN_VERSION) {
    throw refused('domain_not_allowed');
  }
  const chain = allowedChain(domain.chainId);
  if (address(domain.verifyingContract) !== chain.notary) throw refused('domain_not_allowed');
  return chain;
}

/**
 * Checks typed data against the agent key's allowlist and returns the frozen snapshot to sign:
 * the library's own types, and copies of the domain and message read once. `ownAddress` is this
 * agent's EVM address (lowercase `0x` hex); `nowSeconds` the store's wall clock in unix seconds.
 * Throws CryptoInputError `typed_data_refused` with a fixed message; never reads a key.
 */
export function typedDataSnapshot(
  typedData: unknown,
  ownAddress: string,
  nowSeconds: number,
): TypedData {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) throw refused('malformed');
  const own = address(ownAddress);
  const top = exact(typedData, ['types', 'primaryType', 'domain', 'message']);
  const primaryType = top.primaryType;
  if (typeof primaryType !== 'string' || !Object.hasOwn(AGENT_SHAPES, primaryType)) {
    throw refused('type_not_allowed');
  }
  const types = AGENT_SHAPES[primaryType] as TypedDataTypes;
  if (!sameTypes(top.types, types)) throw refused('type_not_allowed');
  const message = exact(top.message, memberNames(types, primaryType));
  const domainKeys = memberNames(types, 'EIP712Domain');
  if (!isPlainObject(top.domain)) throw refused('malformed');
  if (Reflect.ownKeys(top.domain).length !== domainKeys.length) throw refused('domain_not_allowed');
  const domain = exact(top.domain, domainKeys);

  switch (primaryType) {
    case 'Record': {
      const chain = occDomain(domain);
      if (address(message.signer) !== own) throw refused('signer_not_allowed');
      if (message.appId !== AGENT_APP_ID) throw refused('app_not_allowed');
      const token = address(message.feeToken);
      if (!Object.hasOwn(chain.recordFeeTokens, token)) throw refused('fee_not_allowed');
      if (uint(message.maxFee) > (chain.recordFeeTokens[token] as bigint)) {
        throw refused('fee_not_allowed');
      }
      deadlineWithin(message.deadline, nowSeconds, MAX_PROOF_DEADLINE_SECONDS);
      break;
    }
    case 'Receipt': {
      occDomain(domain);
      if (address(message.signer) !== own) throw refused('signer_not_allowed');
      deadlineWithin(message.deadline, nowSeconds, MAX_PROOF_DEADLINE_SECONDS);
      break;
    }
    case 'AgentCard': {
      if (domain.name !== AGENT_CARD_DOMAIN.name || domain.version !== AGENT_CARD_DOMAIN.version) {
        throw refused('domain_not_allowed');
      }
      if (address(message.agentEvm) !== own) throw refused('signer_not_allowed');
      break;
    }
    default: {
      // ReceiveWithAuthorization: the token's own domain, read from chain by the caller.
      const chain = allowedChain(domain.chainId);
      const tokenAddress =
        typeof domain.verifyingContract === 'string' && ADDRESS.test(domain.verifyingContract)
          ? domain.verifyingContract.toLowerCase()
          : '';
      if (!Object.hasOwn(chain.topUpTokens, tokenAddress)) throw refused('domain_not_allowed');
      const token = chain.topUpTokens[tokenAddress] as TopUpToken;
      if (domain.name !== token.name || domain.version !== token.version) {
        throw refused('domain_not_allowed');
      }
      if (address(message.from) !== own) throw refused('signer_not_allowed');
      if (address(message.to) !== chain.vault) throw refused('payee_not_allowed');
      if (uint(message.value) > token.maxValue) throw refused('value_not_allowed');
      deadlineWithin(message.validBefore, nowSeconds, MAX_TOP_UP_WINDOW_SECONDS);
      break;
    }
  }

  return Object.freeze({
    types,
    primaryType,
    domain: Object.freeze(domain),
    message: Object.freeze(message),
  });
}

/** The wall clock in unix seconds, as the KeyStore backends read it. */
export function typedDataClock(): number {
  return Math.floor(Date.now() / 1000);
}
