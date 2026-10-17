// The OCC v2 proof types (05 §3.1, §4; 04 §5): `Record`, `Receipt` and `Registration` under the
// chain domain {name: "OCC", version: "2", chainId, verifyingContract}, the record struct hash, the
// recipient commitment, and the EIP-3009 `ReceiveWithAuthorization` typed data (03 §5, 05 §2.5).
// Hashing is eip712.ts over @noble/hashes keccak-256; nothing here is a primitive (I-8).
//
// Every function parses its message strictly first, in the 05 §3.1 JSON form (04 §2.4.1), and works
// on that parsed, frozen copy, so what is checked is what is hashed and signed:
// - exactly the struct's fields, as plain data properties of a plain object;
// - addresses and `bytes32` as `0x` + lowercase hex of their size (no EIP-55, no `0X`, no bare hex);
// - `uint256` values as decimal strings matching `^(0|[1-9][0-9]*)$`, at most 2^256 - 1;
// - other integers as JSON integers in [0, 2^53 - 1] and in range for their uint type.
// Anything else is refused, never normalised. 04 §2.4.1 lists no `Registration` paths yet; it gets
// the same form (the vectors of M1-1i do too). An object no longer shows how its numbers were
// spelled, so a message read from JSON text needs a token-level check first (parseJson
// `integersOnly`), as for the AgentCard.
//
// EIP-3009: this module never hard-codes a token domain and never checks the payee. A caller that
// signs a `ReceiveWithAuthorization` MUST read the token's domain from chain (EIP-5267
// `eip712Domain()`) and MUST refuse to sign unless `to` equals the configured fee vault for that
// chain (05 §2.5: payee = vault, so front-running cannot redirect funds). That is M3-4b's duty.
//
// The revoke struct waits for G-20 (M1-1i-b). Signing goes through the KeyStore's signTypedData
// with the typed data the builders below return.
//
// Errors never contain the input (I-7): see errors.ts.
import { concatBytes } from './bytes.js';
import {
  eip712HashStruct,
  eip712TypeHash,
  hashTypedData,
  type TypedData,
  type TypedDataHashes,
  type TypedDataTypes,
} from './eip712.js';
import { decodeHex0x, decodeUint256Decimal, isWellFormedText } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { keccak256 } from './hash.js';
import { evmAddressChecksummed } from './keys.js';

/** The OCC v2 chain domain name and version (05 §3.1, 04 §5). */
export const OCC_V2_DOMAIN_NAME = 'OCC';
export const OCC_V2_DOMAIN_VERSION = '2';

/** The OCC v2 chain domain: the Notary, or the Registry for a `Registration` (05 §4). */
export interface OccV2Domain {
  readonly name: typeof OCC_V2_DOMAIN_NAME;
  readonly version: typeof OCC_V2_DOMAIN_VERSION;
  readonly chainId: number;
  readonly verifyingContract: string;
}

/** A token's own EIP-712 domain, read from chain (EIP-3009); never hard-coded here. */
export interface TokenDomain {
  readonly name: string;
  readonly version: string;
  readonly chainId: number;
  readonly verifyingContract: string;
}

/** 05 §3.1 `Record` in its JSON form. */
export interface OccRecord {
  readonly signer: string;
  readonly envelopeHash: string;
  readonly recipientCommitment: string;
  readonly parentRecordId: string;
  readonly appId: string;
  readonly kind: number;
  readonly feeToken: string;
  readonly maxFee: string;
  readonly nonce: string;
  readonly deadline: number;
}

/** 05 §3.1 `Receipt` in its JSON form. */
export interface OccReceipt {
  readonly signer: string;
  readonly recordId: string;
  readonly receiptType: number;
  readonly salt: string;
  readonly deadline: number;
}

/** 05 §4 `Registration` in the same JSON form. */
export interface OccRegistration {
  readonly cardHash: string;
  readonly feeToken: string;
  readonly maxFee: string;
  readonly appId: string;
  readonly nonce: string;
  readonly deadline: number;
}

/** EIP-3009 `ReceiveWithAuthorization` in its JSON form (04 §2.4.1: `auth`, 07 §7). */
export interface ReceiveWithAuthorization {
  readonly from: string;
  readonly to: string;
  readonly value: string;
  readonly validAfter: string;
  readonly validBefore: string;
  readonly nonce: string;
}

/** The EIP-712 hashes of a proof message, with its type hash. */
export interface ProofTypeHashes extends TypedDataHashes {
  readonly typeHash: Uint8Array;
}

const field = (name: string, type: string) => Object.freeze({ name, type });

const DOMAIN_TYPE = Object.freeze([
  field('name', 'string'),
  field('version', 'string'),
  field('chainId', 'uint256'),
  field('verifyingContract', 'address'),
]);

/** 05 §3.1 `Record`, in the declared field order. */
export const RECORD_TYPES: TypedDataTypes = Object.freeze({
  EIP712Domain: DOMAIN_TYPE,
  Record: Object.freeze([
    field('signer', 'address'),
    field('envelopeHash', 'bytes32'),
    field('recipientCommitment', 'bytes32'),
    field('parentRecordId', 'bytes32'),
    field('appId', 'bytes32'),
    field('kind', 'uint8'),
    field('feeToken', 'address'),
    field('maxFee', 'uint256'),
    field('nonce', 'uint256'),
    field('deadline', 'uint64'),
  ]),
});

/** 05 §3.1 `Receipt`. */
export const RECEIPT_TYPES: TypedDataTypes = Object.freeze({
  EIP712Domain: DOMAIN_TYPE,
  Receipt: Object.freeze([
    field('signer', 'address'),
    field('recordId', 'bytes32'),
    field('receiptType', 'uint8'),
    field('salt', 'bytes32'),
    field('deadline', 'uint64'),
  ]),
});

/** 05 §4 `Registration` (`regOwnerSig`). */
export const REGISTRATION_TYPES: TypedDataTypes = Object.freeze({
  EIP712Domain: DOMAIN_TYPE,
  Registration: Object.freeze([
    field('cardHash', 'bytes32'),
    field('feeToken', 'address'),
    field('maxFee', 'uint256'),
    field('appId', 'bytes32'),
    field('nonce', 'uint256'),
    field('deadline', 'uint64'),
  ]),
});

/** EIP-3009 `ReceiveWithAuthorization` (the vault calls `receiveWithAuthorization`, 05 §2.5). */
export const RECEIVE_WITH_AUTHORIZATION_TYPES: TypedDataTypes = Object.freeze({
  EIP712Domain: DOMAIN_TYPE,
  ReceiveWithAuthorization: Object.freeze([
    field('from', 'address'),
    field('to', 'address'),
    field('value', 'uint256'),
    field('validAfter', 'uint256'),
    field('validBefore', 'uint256'),
    field('nonce', 'bytes32'),
  ]),
});

const invalid = (message: string): CryptoInputError =>
  new CryptoInputError('invalid_proof_struct', message);

function isPlainObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Own data properties only: a getter is refused unread, so it cannot change between check and use. */
function dataProperty(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !('value' in descriptor)) {
    throw invalid('proof message fields must be plain data properties');
  }
  return descriptor.value as unknown;
}

/** Reads exactly the named own data properties of a plain object, refusing anything more. */
function exactFields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value)) throw invalid('a proof message must be a plain JSON object');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || !names.every((name) => keys.includes(name))) {
    throw invalid('a proof message must have exactly its struct fields');
  }
  const out: Record<string, unknown> = {};
  for (const name of names) out[name] = dataProperty(value, name);
  return out;
}

function canonicalHex(value: unknown, length: number): string {
  if (typeof value !== 'string') throw invalid('address and bytes32 fields must be strings');
  try {
    decodeHex0x(value, { length });
  } catch {
    throw invalid('address and bytes32 fields must be 0x + lowercase hex of their size');
  }
  return value;
}

function canonicalUint256(value: unknown): string {
  if (typeof value !== 'string') throw invalid('uint256 fields must be decimal strings');
  try {
    decodeUint256Decimal(value);
  } catch {
    throw invalid('uint256 fields must be canonical decimal strings up to 2^256 - 1');
  }
  return value;
}

function jsonInteger(value: unknown, max: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < 0 ||
    value > max
  ) {
    throw invalid('integer fields must be JSON integers in range for their type');
  }
  return value;
}

/** Parses a message of `types[primary]` in the 05 §3.1 JSON form; returns a frozen copy. */
function parseJsonForm(types: TypedDataTypes, primary: string, value: unknown): object {
  const fields = types[primary] ?? [];
  const raw = exactFields(
    value,
    fields.map((f) => f.name),
  );
  const out: Record<string, string | number> = {};
  for (const { name, type } of fields) {
    const v = raw[name];
    if (type === 'address') out[name] = canonicalHex(v, 20);
    else if (type === 'bytes32') out[name] = canonicalHex(v, 32);
    else if (type === 'uint256') out[name] = canonicalUint256(v);
    else if (type === 'uint8') out[name] = jsonInteger(v, 255);
    else if (type === 'uint64') out[name] = jsonInteger(v, Number.MAX_SAFE_INTEGER);
    else throw invalid('unsupported proof field type');
  }
  return Object.freeze(out);
}

/** The EIP-712 message: the parsed JSON form with `uint256` decimal strings as bigint. */
function eip712Message(types: TypedDataTypes, primary: string, parsed: object) {
  const out: Record<string, unknown> = {};
  for (const { name, type } of types[primary] ?? []) {
    const v = (parsed as Record<string, unknown>)[name];
    out[name] = type === 'uint256' ? decodeUint256Decimal(v as string) : v;
  }
  return Object.freeze(out);
}

function chainIdOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw invalid('chainId must be a JSON integer in [1, 2^53 - 1]');
  }
  return value;
}

/** Parses the OCC v2 chain domain: exactly the four fields, name "OCC", version "2" (05 §3.1). */
function parseOccDomain(value: unknown): OccV2Domain {
  const raw = exactFields(value, ['name', 'version', 'chainId', 'verifyingContract']);
  if (raw.name !== OCC_V2_DOMAIN_NAME || raw.version !== OCC_V2_DOMAIN_VERSION) {
    throw invalid('the domain must be the OCC v2 chain domain');
  }
  return Object.freeze({
    name: OCC_V2_DOMAIN_NAME,
    version: OCC_V2_DOMAIN_VERSION,
    chainId: chainIdOf(raw.chainId),
    verifyingContract: canonicalHex(raw.verifyingContract, 20),
  });
}

/**
 * Parses a token's EIP-712 domain as read from chain: exactly name, version, chainId and
 * verifyingContract. The address is lowercase or carries a valid EIP-55 checksum (a chain read
 * returns checksums); name and version are whatever the token reports.
 */
function parseTokenDomain(value: unknown): TokenDomain {
  const raw = exactFields(value, ['name', 'version', 'chainId', 'verifyingContract']);
  const { name, version, verifyingContract } = raw;
  if (
    typeof name !== 'string' ||
    typeof version !== 'string' ||
    !isWellFormedText(name) ||
    !isWellFormedText(version)
  ) {
    throw invalid('the token domain name and version must be strings');
  }
  if (typeof verifyingContract !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(verifyingContract)) {
    throw invalid('the token domain verifyingContract must be 0x + 40 hex');
  }
  if (
    !/^0x[0-9a-f]{40}$/.test(verifyingContract) &&
    evmAddressChecksummed(verifyingContract.toLowerCase()) !== verifyingContract
  ) {
    throw invalid('the token domain verifyingContract must be lowercase or valid EIP-55');
  }
  return Object.freeze({ name, version, chainId: chainIdOf(raw.chainId), verifyingContract });
}

/** The OCC v2 chain domain for a chain and a contract (the Notary, or the Registry). */
export function occV2Domain(chainId: number, verifyingContract: string): OccV2Domain {
  return parseOccDomain({
    name: OCC_V2_DOMAIN_NAME,
    version: OCC_V2_DOMAIN_VERSION,
    chainId,
    verifyingContract,
  });
}

/** Parses a `Record` in its 05 §3.1 JSON form; refuses, never normalises. */
export function parseRecord(value: unknown): OccRecord {
  return parseJsonForm(RECORD_TYPES, 'Record', value) as OccRecord;
}

/** Parses a `Receipt` in its 05 §3.1 JSON form; refuses, never normalises. */
export function parseReceipt(value: unknown): OccReceipt {
  return parseJsonForm(RECEIPT_TYPES, 'Receipt', value) as OccReceipt;
}

/** Parses a `Registration` in the same JSON form; refuses, never normalises. */
export function parseRegistration(value: unknown): OccRegistration {
  return parseJsonForm(REGISTRATION_TYPES, 'Registration', value) as OccRegistration;
}

/** Parses an EIP-3009 authorization: addresses and `nonce` `0x` hex, amounts and times decimal. */
export function parseReceiveWithAuthorization(value: unknown): ReceiveWithAuthorization {
  return parseJsonForm(
    RECEIVE_WITH_AUTHORIZATION_TYPES,
    'ReceiveWithAuthorization',
    value,
  ) as ReceiveWithAuthorization;
}

function typedData(
  types: TypedDataTypes,
  primaryType: string,
  domain: OccV2Domain | TokenDomain,
  parsed: object,
): TypedData {
  return Object.freeze({
    types,
    primaryType,
    domain: domain as unknown as Readonly<Record<string, unknown>>,
    message: eip712Message(types, primaryType, parsed),
  });
}

/** Typed data of a `Record` under the OCC v2 chain domain, for the KeyStore's signTypedData. */
export function recordTypedData(domain: unknown, record: unknown): TypedData {
  return typedData(RECORD_TYPES, 'Record', parseOccDomain(domain), parseRecord(record));
}

/** Typed data of a `Receipt` under the OCC v2 chain domain. */
export function receiptTypedData(domain: unknown, receipt: unknown): TypedData {
  return typedData(RECEIPT_TYPES, 'Receipt', parseOccDomain(domain), parseReceipt(receipt));
}

/** Typed data of a `Registration` under the OCC v2 chain domain (the Registry). */
export function registrationTypedData(domain: unknown, registration: unknown): TypedData {
  return typedData(
    REGISTRATION_TYPES,
    'Registration',
    parseOccDomain(domain),
    parseRegistration(registration),
  );
}

/**
 * Typed data of an EIP-3009 `ReceiveWithAuthorization` under the token's own domain, which the
 * caller reads from chain. The payee (`to`) must be the fee vault (05 §2.5); that check is the
 * caller's, which knows the chain configuration.
 */
export function receiveWithAuthorizationTypedData(
  tokenDomain: unknown,
  authorization: unknown,
): TypedData {
  return typedData(
    RECEIVE_WITH_AUTHORIZATION_TYPES,
    'ReceiveWithAuthorization',
    parseTokenDomain(tokenDomain),
    parseReceiveWithAuthorization(authorization),
  );
}

function hashesOf(td: TypedData): ProofTypeHashes {
  return { typeHash: eip712TypeHash(td.types, td.primaryType), ...hashTypedData(td) };
}

/** Type hash, domain separator, struct hash and digest of a `Record` (05 §3.1). */
export function hashRecord(domain: unknown, record: unknown): ProofTypeHashes {
  return hashesOf(recordTypedData(domain, record));
}

/** Type hash, domain separator, struct hash and digest of a `Receipt` (05 §3.1). */
export function hashReceipt(domain: unknown, receipt: unknown): ProofTypeHashes {
  return hashesOf(receiptTypedData(domain, receipt));
}

/** Type hash, domain separator, struct hash and digest of a `Registration` (05 §4). */
export function hashRegistration(domain: unknown, registration: unknown): ProofTypeHashes {
  return hashesOf(registrationTypedData(domain, registration));
}

/** Type hash, domain separator, struct hash and digest of an EIP-3009 authorization. */
export function hashReceiveWithAuthorization(
  tokenDomain: unknown,
  authorization: unknown,
): ProofTypeHashes {
  return hashesOf(receiveWithAuthorizationTypedData(tokenDomain, authorization));
}

/**
 * `recordStructHash`: the EIP-712 struct hash of a `Record`, hashStruct(Record) without a domain.
 * The Notary stores it (05 §3.3) so verifiers can check every Record field from `getRecord`.
 */
export function recordStructHash(record: unknown): Uint8Array {
  const parsed = parseRecord(record);
  return eip712HashStruct(RECORD_TYPES, 'Record', eip712Message(RECORD_TYPES, 'Record', parsed));
}

/**
 * Recipient commitment (04 §5): keccak256(abi.encode(recipientAgentEvm, salt)), two 32-byte words
 * with the address left-padded. `recipientAgentEvm` is `0x` + 40 lowercase hex; `salt` is `0x` + 64
 * lowercase hex or 32 bytes. The salt must be fresh CSPRNG bytes per Record (D-61): that is the
 * caller's duty, this function only hashes.
 */
export function recipientCommitment(
  recipientAgentEvm: string,
  salt: string | Uint8Array,
): Uint8Array {
  let address: Uint8Array;
  try {
    address = decodeHex0x(recipientAgentEvm, { length: 20 });
  } catch {
    throw invalid('recipientAgentEvm must be 0x + 40 lowercase hex');
  }
  let saltBytes: Uint8Array;
  if (salt instanceof Uint8Array) {
    if (salt.length !== 32) throw invalid('salt must be 32 bytes');
    saltBytes = salt;
  } else {
    try {
      saltBytes = decodeHex0x(salt, { length: 32 });
    } catch {
      throw invalid('salt must be 0x + 64 lowercase hex or 32 bytes');
    }
  }
  return keccak256(concatBytes(new Uint8Array(12), address, saltBytes));
}
