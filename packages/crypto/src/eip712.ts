// EIP-712 typed-data hashing (04 §2.4, §5; 05 §3.1). Keccak-256 comes from @noble/hashes and
// signing from ecdsa.ts (@noble/curves); this file is the EIP-712 encoding over them, not a
// primitive (I-8). It is in-repo rather than viem's for three reasons: 07 §1 and the deps-check
// policy keep @4thtech-io/crypto on noble and hpke only (it is the trusted base); viem's typed-data
// validation accepts what 04 §2.4.1 refuses (numbers as strings, extra fields); and its recovery
// accepts malleable signatures. viem is the differential oracle in the tests instead.
//
// Scope is what the protocol signs: structs over `address`, `bool`, `string`, `bytes`, `bytes1` to
// `bytes32` and `uint8` to `uint256`. Arrays and signed integers are refused (fail closed) until a
// type needs them. Every input is checked strictly and refused, never coerced:
// - a struct value is a plain object with exactly the declared fields, as data properties;
// - an address is `0x` + 40 hex, all lowercase or with a valid EIP-55 checksum (general typed data,
//   such as a token's domain read from chain, uses checksums; protocol objects are parsed to
//   lowercase before they get here, 04 §2.4.1);
// - `bytesN` and `bytes` are `0x` + lowercase hex of the exact length, or a Uint8Array (empty
//   `bytes` only as an empty Uint8Array, since `0x` alone is not canonical; IR-M1-1e-1 I-3, for
//   M1-1j to revisit if a type needs empty `bytes`);
// - `uintN` is a safe-integer number or a bigint, within N bits; decimal strings are refused;
// - the domain type uses the EIP's fields in the EIP's order with the EIP's types.
//
// Errors never contain the input (I-7): see errors.ts.
import { concatBytes } from './bytes.js';
import { encodeEcdsaSignature, signDigestEcdsa } from './ecdsa.js';
import { decodeHex0x, encodeUtf8, isWellFormedText } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { keccak256 } from './hash.js';
import { evmAddressChecksummed } from './keys.js';

/** One member of an EIP-712 struct type. */
export interface TypedDataField {
  readonly name: string;
  readonly type: string;
}

/** Struct name to its members, `EIP712Domain` included. */
export type TypedDataTypes = Readonly<Record<string, readonly TypedDataField[]>>;

/** Full typed data: the types, the primary type, the domain and the message. */
export interface TypedData {
  readonly types: TypedDataTypes;
  readonly primaryType: string;
  readonly domain: Readonly<Record<string, unknown>>;
  readonly message: Readonly<Record<string, unknown>>;
}

/** The three hashes of typed data; `digest` is what gets signed. */
export interface TypedDataHashes {
  /** hashStruct(EIP712Domain, domain). */
  readonly domainSeparator: Uint8Array;
  /** hashStruct(primaryType, message). */
  readonly structHash: Uint8Array;
  /** keccak256(0x19 0x01 || domainSeparator || structHash). */
  readonly digest: Uint8Array;
}

const invalid = (message: string): CryptoInputError =>
  new CryptoInputError('invalid_typed_data', message);

/** Deepest struct nesting accepted; protocol types are one or two levels deep. */
const MAX_STRUCT_DEPTH = 32;

/** The EIP-712 domain fields, in the EIP's order, with their types. */
const DOMAIN_FIELDS: readonly TypedDataField[] = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
  { name: 'salt', type: 'bytes32' },
];

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const UINT = /^uint([1-9][0-9]{0,2})$/;
const BYTES_N = /^bytes([1-9][0-9]?)$/;

type Atomic =
  | { kind: 'uint'; bits: number }
  | { kind: 'bytesN'; length: number }
  | { kind: 'address' | 'bool' | 'string' | 'bytes' };

/** The atomic or dynamic type a name denotes, or null when it names no such type. */
function atomicType(type: string): Atomic | null {
  if (type === 'address' || type === 'bool' || type === 'string' || type === 'bytes') {
    return { kind: type };
  }
  const uint = UINT.exec(type);
  if (uint) {
    const bits = Number(uint[1]);
    if (bits % 8 === 0 && bits <= 256) return { kind: 'uint', bits };
    return null;
  }
  const bytes = BYTES_N.exec(type);
  if (bytes) {
    const length = Number(bytes[1]);
    if (length <= 32) return { kind: 'bytesN', length };
  }
  return null;
}

/** Names that are Solidity types and so can never be struct names. */
function isReservedTypeName(name: string): boolean {
  return (
    atomicType(name) !== null ||
    /^u?int[0-9]*$/.test(name) ||
    /^bytes[0-9]*$/.test(name) ||
    /^u?fixed/.test(name) ||
    name === 'function'
  );
}

/** Reads an own data property; refuses accessors so a getter cannot change what gets hashed. */
function own(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !('value' in descriptor)) {
    throw invalid('EIP-712 struct values must be plain data properties');
  }
  return descriptor.value as unknown;
}

function isPlainObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Own keys of a plain object, refusing symbol keys. */
function ownKeys(value: object): string[] {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    throw invalid('EIP-712 objects must not have symbol keys');
  }
  return keys as string[];
}

// --- types --------------------------------------------------------------------------------------

/** Validated types: struct name -> members. Built once per call from the caller's object. */
type Schema = ReadonlyMap<string, readonly TypedDataField[]>;

function readSchema(types: unknown): Schema {
  if (!isPlainObject(types)) throw invalid('EIP-712 types must be a plain object');
  const schema = new Map<string, readonly TypedDataField[]>();
  for (const name of ownKeys(types)) {
    if (!IDENTIFIER.test(name) || isReservedTypeName(name)) {
      throw invalid('EIP-712 struct names must be identifiers that are not Solidity types');
    }
    const members = own(types, name);
    if (!Array.isArray(members)) throw invalid('EIP-712 struct members must be an array');
    const fields: TypedDataField[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < members.length; i += 1) {
      const member = own(members, String(i));
      if (!isPlainObject(member)) throw invalid('EIP-712 members must be { name, type } objects');
      const keys = ownKeys(member);
      if (keys.length !== 2 || !keys.includes('name') || !keys.includes('type')) {
        throw invalid('EIP-712 members must have exactly a name and a type');
      }
      const fieldName = own(member, 'name');
      const fieldType = own(member, 'type');
      if (typeof fieldName !== 'string' || !IDENTIFIER.test(fieldName)) {
        throw invalid('EIP-712 member names must be identifiers');
      }
      if (typeof fieldType !== 'string') throw invalid('EIP-712 member types must be strings');
      if (seen.has(fieldName)) throw invalid('EIP-712 member names must be unique in a struct');
      seen.add(fieldName);
      fields.push(Object.freeze({ name: fieldName, type: fieldType }));
    }
    schema.set(name, Object.freeze(fields));
  }
  // Every member type is atomic or a struct defined here; EIP712Domain is never a member type.
  for (const fields of schema.values()) {
    for (const field of fields) {
      if (atomicType(field.type) !== null) continue;
      if (!schema.has(field.type) || field.type === 'EIP712Domain') {
        throw invalid('EIP-712 member type is not supported or not defined');
      }
    }
  }
  const domain = schema.get('EIP712Domain');
  if (domain === undefined) throw invalid('EIP-712 types must define EIP712Domain');
  let next = 0;
  for (const field of domain) {
    while (next < DOMAIN_FIELDS.length && DOMAIN_FIELDS[next]?.name !== field.name) next += 1;
    const standard = DOMAIN_FIELDS[next];
    if (standard === undefined || standard.type !== field.type) {
      throw invalid('EIP712Domain must use the standard fields, types and order');
    }
    next += 1;
  }
  return schema;
}

function fieldsOf(schema: Schema, type: string): readonly TypedDataField[] {
  const fields = schema.get(type);
  if (fields === undefined) throw invalid('EIP-712 primary type is not defined');
  return fields;
}

/** The struct types `primary` references, transitively, the primary itself first. */
function dependencies(schema: Schema, primary: string): string[] {
  const found = new Set<string>([primary]);
  const pending = [primary];
  for (let type = pending.pop(); type !== undefined; type = pending.pop()) {
    for (const field of fieldsOf(schema, type)) {
      if (schema.has(field.type) && !found.has(field.type)) {
        found.add(field.type);
        pending.push(field.type);
      }
    }
  }
  return [primary, ...[...found].filter((t) => t !== primary).sort()];
}

function encodeTypeOf(schema: Schema, primary: string): string {
  return dependencies(schema, primary)
    .map(
      (type) =>
        `${type}(${fieldsOf(schema, type)
          .map((f) => `${f.type} ${f.name}`)
          .join(',')})`,
    )
    .join('');
}

function typeHashOf(schema: Schema, primary: string): Uint8Array {
  return keccak256(encodeUtf8(encodeTypeOf(schema, primary)));
}

// --- values -------------------------------------------------------------------------------------

function word(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let rest = value;
  for (let i = 31; i >= 0 && rest > 0n; i -= 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

const HEX_LOWER = /^0x[0-9a-f]{40}$/;
const HEX_ANY = /^0x[0-9a-fA-F]{40}$/;

function addressBytes(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !HEX_ANY.test(value)) {
    throw invalid('EIP-712 address must be 0x + 40 hex');
  }
  // A mixed-case address must equal its EIP-55 form (M1-1b's evmAddressChecksummed, L-2).
  if (!HEX_LOWER.test(value) && evmAddressChecksummed(value.toLowerCase()) !== value) {
    throw invalid('EIP-712 address must be lowercase or carry a valid EIP-55 checksum');
  }
  return decodeHex0x(value.toLowerCase(), { length: 20 });
}

function byteValue(value: unknown, length?: number): Uint8Array {
  let bytes: Uint8Array;
  if (value instanceof Uint8Array) {
    bytes = value;
  } else if (typeof value === 'string') {
    try {
      bytes = decodeHex0x(value);
    } catch {
      throw invalid('EIP-712 bytes must be 0x + lowercase hex or a Uint8Array');
    }
  } else {
    throw invalid('EIP-712 bytes must be 0x + lowercase hex or a Uint8Array');
  }
  if (length !== undefined && bytes.length !== length) {
    throw invalid('EIP-712 bytesN value has the wrong length');
  }
  return bytes;
}

function uintValue(value: unknown, bits: number): bigint {
  let n: bigint;
  if (typeof value === 'bigint') {
    n = value;
  } else if (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0)) {
    n = BigInt(value);
  } else {
    throw invalid('EIP-712 uint must be a safe-integer number or a bigint');
  }
  if (n < 0n || n >> BigInt(bits) !== 0n) throw invalid('EIP-712 uint is out of range');
  return n;
}

function encodeValue(schema: Schema, type: string, value: unknown, depth: number): Uint8Array {
  const atomic = atomicType(type);
  if (atomic === null) return hashStructOf(schema, type, value, depth + 1);
  switch (atomic.kind) {
    case 'string':
      if (typeof value !== 'string' || !isWellFormedText(value)) {
        throw invalid('EIP-712 string must be a well-formed string');
      }
      return keccak256(encodeUtf8(value));
    case 'bytes':
      return keccak256(byteValue(value));
    case 'bytesN': {
      const out = new Uint8Array(32);
      out.set(byteValue(value, atomic.length));
      return out;
    }
    case 'address': {
      const out = new Uint8Array(32);
      out.set(addressBytes(value), 12);
      return out;
    }
    case 'bool':
      if (typeof value !== 'boolean') throw invalid('EIP-712 bool must be a boolean');
      return word(value ? 1n : 0n);
    case 'uint':
      return word(uintValue(value, atomic.bits));
  }
}

function hashStructOf(schema: Schema, type: string, data: unknown, depth: number): Uint8Array {
  if (depth > MAX_STRUCT_DEPTH) throw invalid('EIP-712 struct is nested too deeply');
  if (!isPlainObject(data)) throw invalid('EIP-712 struct value must be a plain object');
  const fields = fieldsOf(schema, type);
  const keys = ownKeys(data);
  if (keys.length !== fields.length || !fields.every((f) => keys.includes(f.name))) {
    throw invalid('EIP-712 struct value must have exactly the declared fields');
  }
  const parts = [typeHashOf(schema, type)];
  for (const field of fields) {
    parts.push(encodeValue(schema, field.type, own(data, field.name), depth));
  }
  return keccak256(concatBytes(...parts));
}

// --- public API ---------------------------------------------------------------------------------

/** encodeType(primaryType): the primary struct, then its dependencies sorted by name. */
export function eip712EncodeType(types: TypedDataTypes, primaryType: string): string {
  const schema = readSchema(types);
  fieldsOf(schema, primaryType);
  return encodeTypeOf(schema, primaryType);
}

/** typeHash = keccak256(encodeType(primaryType)). */
export function eip712TypeHash(types: TypedDataTypes, primaryType: string): Uint8Array {
  const schema = readSchema(types);
  fieldsOf(schema, primaryType);
  return typeHashOf(schema, primaryType);
}

/** hashStruct(primaryType, data) = keccak256(typeHash || encodeData(data)). */
export function eip712HashStruct(
  types: TypedDataTypes,
  primaryType: string,
  data: Readonly<Record<string, unknown>>,
): Uint8Array {
  return hashStructOf(readSchema(types), primaryType, data, 0);
}

/**
 * The domain separator, the struct hash of the message and the digest
 * keccak256(0x19 0x01 || domainSeparator || hashStruct(message)) of full typed data.
 */
export function hashTypedData(typedData: TypedData): TypedDataHashes {
  if (!isPlainObject(typedData)) throw invalid('typed data must be a plain object');
  const keys = ownKeys(typedData);
  if (
    keys.length !== 4 ||
    !['types', 'primaryType', 'domain', 'message'].every((k) => keys.includes(k))
  ) {
    throw invalid('typed data must have exactly types, primaryType, domain and message');
  }
  const schema = readSchema(own(typedData, 'types'));
  const primaryType = own(typedData, 'primaryType');
  if (typeof primaryType !== 'string' || primaryType === 'EIP712Domain') {
    throw invalid('EIP-712 primary type must be a struct other than EIP712Domain');
  }
  fieldsOf(schema, primaryType);
  const domainSeparator = hashStructOf(schema, 'EIP712Domain', own(typedData, 'domain'), 0);
  const structHash = hashStructOf(schema, primaryType, own(typedData, 'message'), 0);
  const digest = keccak256(concatBytes(Uint8Array.of(0x19, 0x01), domainSeparator, structHash));
  return { domainSeparator, structHash, digest };
}

/**
 * Signs typed data: canonical ECDSA over its digest, as `0x` + 130 lowercase hex (04 §2.4.1).
 * For KeyStore implementations only; see signDigestEcdsa.
 */
export function signTypedData(typedData: TypedData, secretKey: Uint8Array): string {
  const { digest } = hashTypedData(typedData);
  return encodeEcdsaSignature(signDigestEcdsa(digest, secretKey));
}
