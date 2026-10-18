// Record, Receipt and AgentCard builders (07 §6.2; 05 §3.1; 04 §2.4, §5; D-61, D-86).
//
// The builders assemble the 05 §3.1 JSON form and hand it to @4thtech-io/crypto, which parses it
// strictly and does the EIP-712 hashing that the shared vectors check in every runtime. Signing
// happens only through `KeyStore.sign712` (04 §2.2): no key ever reaches this package.
//
// Salts (04 §5, D-61): `buildRecord` draws a fresh 32-byte CSPRNG salt for every Record that has a
// recipient and a random 256-bit nonce for every Record; it takes neither from its caller.
// `assembleRecord` is the deterministic core the vector tests drive; it is not re-exported from
// this folder's index or from the package root.
import {
  AGENT_CARD_DOMAIN,
  AGENT_CARD_TYPES,
  encodeHex0x,
  hashTypedData,
  occV2Domain,
  parseAgentCard,
  recipientCommitment,
  receiptTypedData,
  recordTypedData,
  type KeyStore,
  type OccReceipt,
  type OccRecord,
  type OccV2Domain,
  type TypedData,
} from '@4thtech-io/crypto';
import {
  ChainInputError,
  canonicalAddress,
  checkChainId,
  checkUint256,
  computeRecordId,
  randomNonce,
  randomSalt,
  type Hex,
} from '../ids/index.js';

/** 05 §3.1 Record kinds (D-86). 7..255 are reserved; adding one is a spec change. */
export const RECORD_KIND = Object.freeze({
  MESSAGE: 1,
  FILE: 2,
  OFFER: 3,
  ACCEPT: 4,
  DELIVERY: 5,
  NOTE: 6,
} as const);
export type RecordKind = (typeof RECORD_KIND)[keyof typeof RECORD_KIND];

/** 05 §3.1 Receipt types. */
export const RECEIPT_TYPE = Object.freeze({
  DELIVERED: 1,
  OPENED: 2,
  ACCEPTED: 3,
  REJECTED: 4,
} as const);
export type ReceiptType = (typeof RECEIPT_TYPE)[keyof typeof RECEIPT_TYPE];

/** What a caller gives `buildRecord`. No salt, nonce or commitment: the builder makes those. */
export interface RecordInput {
  readonly chainId: number;
  /** The Notary proxy on `chainId` (the EIP-712 `verifyingContract`). */
  readonly notary: string;
  /** The agent's EVM address. */
  readonly signer: string;
  /** sha256(JCS(envelope without sig)), `0x` + 64 lowercase hex (04 §3.1). */
  readonly envelopeHash: string;
  /** The recipient agent's EVM address, or null for a self-note (commitment 0, 05 §3.1). */
  readonly recipient: string | null;
  /** Default 0 (no parent). */
  readonly parentRecordId?: string;
  /** Default 0 (official clients). */
  readonly appId?: string;
  readonly kind: RecordKind;
  /** `address(0)` for the native coin. */
  readonly feeToken: string;
  readonly maxFee: bigint;
  /** Unix seconds. */
  readonly deadline: number;
}

/** A built Record: its JSON form, typed data, digest and ID, and the salt to deliver. */
export interface BuiltRecord {
  readonly domain: OccV2Domain;
  readonly record: OccRecord;
  /**
   * The commitment salt, delivered to the recipient only inside the encrypted `proof` envelope
   * (04 §5). Secret until a receipt reveals it; never log it. Null for a self-note.
   */
  readonly salt: Hex | null;
  readonly recordId: Hex;
  readonly typedData: TypedData;
  /** The EIP-712 digest that gets signed, `0x` + 64 lowercase hex. */
  readonly digest: Hex;
}

/** What a caller gives `buildReceipt`. The salt is the one the Record's sender delivered. */
export interface ReceiptInput {
  readonly chainId: number;
  readonly notary: string;
  /** The recipient agent's EVM address. */
  readonly signer: string;
  readonly recordId: string;
  readonly receiptType: number;
  readonly salt: string;
  readonly deadline: number;
}

export interface BuiltReceipt {
  readonly domain: OccV2Domain;
  readonly receipt: OccReceipt;
  readonly typedData: TypedData;
  readonly digest: Hex;
}

/** The one KeyStore method the builders use. */
export type TypedDataSigner = Pick<KeyStore, 'sign712'>;

const RECORD_INPUT_KEYS: ReadonlySet<string> = new Set([
  'chainId',
  'notary',
  'signer',
  'envelopeHash',
  'recipient',
  'parentRecordId',
  'appId',
  'kind',
  'feeToken',
  'maxFee',
  'deadline',
]);
const ZERO32 = `0x${'0'.repeat(64)}` as Hex;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const KINDS: ReadonlySet<number> = new Set(Object.values(RECORD_KIND));
const RECEIPT_TYPES: ReadonlySet<number> = new Set(Object.values(RECEIPT_TYPE));

const fail = (code: string, message: string): never => {
  throw new ChainInputError(code, message);
};

function bytes32(value: unknown, field: string): Hex {
  if (typeof value !== 'string' || !BYTES32.test(value)) {
    fail('invalid_bytes32', `${field}: must be 0x + 64 lowercase hex`);
  }
  return value as Hex;
}

function deadlineOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('invalid_deadline', 'deadline: must be a non-negative safe integer (unix seconds)');
  }
  return value as number;
}

function checkRecordInput(input: unknown): asserts input is RecordInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    fail('invalid_record_input', 'record input: must be an object');
  }
  for (const key of Reflect.ownKeys(input as object)) {
    if (typeof key !== 'string' || !RECORD_INPUT_KEYS.has(key)) {
      // A salt, nonce or commitment from the caller is refused here (D-61).
      fail('invalid_record_input', 'record input: unknown field');
    }
  }
}

function freezeTypedData(td: TypedData): TypedData {
  Object.freeze(td.domain);
  Object.freeze(td.message);
  return Object.freeze(td);
}

/**
 * The deterministic core of `buildRecord`. `nonce` and `salt` come from `buildRecord`'s CSPRNG
 * draws in production and from the shared vectors in tests. Not exported from the package.
 */
export function assembleRecord(
  input: RecordInput,
  fresh: { readonly nonce: bigint; readonly salt: string | null },
): BuiltRecord {
  checkRecordInput(input);
  const chainId = checkChainId(input.chainId);
  const notary = canonicalAddress(input.notary, 'notary');
  const signer = canonicalAddress(input.signer, 'signer');
  if (!KINDS.has(input.kind)) fail('invalid_kind', 'kind: must be a 05 §3.1 kind (1..6)');
  const nonce = checkUint256(fresh.nonce, 'nonce');
  const maxFee = checkUint256(input.maxFee, 'maxFee');

  let salt: Hex | null = null;
  let commitment = ZERO32;
  if (input.recipient !== null) {
    const recipient = canonicalAddress(input.recipient, 'recipient');
    salt = bytes32(fresh.salt, 'salt');
    commitment = encodeHex0x(recipientCommitment(recipient, salt)) as Hex;
  } else if (fresh.salt !== null) {
    fail('invalid_record_input', 'a self-note has no recipient and no salt');
  }

  const record: OccRecord = {
    signer,
    envelopeHash: bytes32(input.envelopeHash, 'envelopeHash'),
    recipientCommitment: commitment,
    parentRecordId: bytes32(input.parentRecordId ?? ZERO32, 'parentRecordId'),
    appId: bytes32(input.appId ?? ZERO32, 'appId'),
    kind: input.kind,
    feeToken: canonicalAddress(input.feeToken, 'feeToken'),
    maxFee: maxFee.toString(10),
    nonce: nonce.toString(10),
    deadline: deadlineOf(input.deadline),
  };
  const domain = occV2Domain(chainId, notary);
  const typedData = freezeTypedData(recordTypedData(domain, record));
  return Object.freeze({
    domain: Object.freeze(domain),
    record: Object.freeze(record),
    salt,
    recordId: computeRecordId(chainId, notary, signer, nonce),
    typedData,
    digest: encodeHex0x(hashTypedData(typedData).digest) as Hex,
  });
}

/**
 * Builds a Record with a fresh random nonce and, when it has a recipient, a fresh 32-byte CSPRNG
 * commitment salt (04 §5, D-61). Two calls never share a salt, a nonce, a commitment or a record ID.
 */
export function buildRecord(input: RecordInput): BuiltRecord {
  checkRecordInput(input);
  return assembleRecord(input, {
    nonce: randomNonce(),
    salt: input.recipient === null ? null : randomSalt(),
  });
}

/** Builds a Receipt (05 §3.1) for a Record the signer received. */
export function buildReceipt(input: ReceiptInput): BuiltReceipt {
  const chainId = checkChainId(input.chainId);
  const notary = canonicalAddress(input.notary, 'notary');
  if (!RECEIPT_TYPES.has(input.receiptType)) {
    fail('invalid_receipt_type', 'receiptType: must be a 05 §3.1 receipt type (1..4)');
  }
  const receipt: OccReceipt = {
    signer: canonicalAddress(input.signer, 'signer'),
    recordId: bytes32(input.recordId, 'recordId'),
    receiptType: input.receiptType,
    salt: bytes32(input.salt, 'salt'),
    deadline: deadlineOf(input.deadline),
  };
  const domain = occV2Domain(chainId, notary);
  const typedData = freezeTypedData(receiptTypedData(domain, receipt));
  return Object.freeze({
    domain: Object.freeze(domain),
    receipt: Object.freeze(receipt),
    typedData,
    digest: encodeHex0x(hashTypedData(typedData).digest) as Hex,
  });
}

/** The AgentCard typed data under the chain-agnostic domain (04 §2.4), for `cardAgentSig`. */
export function agentCardTypedData(card: unknown): TypedData {
  const parsed = parseAgentCard(card);
  return freezeTypedData({
    types: AGENT_CARD_TYPES,
    primaryType: 'AgentCard',
    domain: { ...AGENT_CARD_DOMAIN },
    message: { ...parsed },
  });
}

async function signChecked(
  signer: TypedDataSigner,
  td: TypedData,
  digest: string,
): Promise<string> {
  // A caller-modified result would sign something other than what it shows: refuse it.
  if (encodeHex0x(hashTypedData(td).digest) !== digest) {
    fail('digest_mismatch', 'typed data does not match its digest');
  }
  return signer.sign712(td);
}

/** Signs a built Record with the agent EVM key through `KeyStore.sign712`. */
export function signRecord(signer: TypedDataSigner, built: BuiltRecord): Promise<string> {
  return Promise.resolve().then(() => signChecked(signer, built.typedData, built.digest));
}

/** Signs a built Receipt through `KeyStore.sign712`. */
export function signReceipt(signer: TypedDataSigner, built: BuiltReceipt): Promise<string> {
  return Promise.resolve().then(() => signChecked(signer, built.typedData, built.digest));
}

/** Signs an AgentCard (`cardAgentSig`, 04 §2.4) through `KeyStore.sign712`. */
export function signAgentCard(signer: TypedDataSigner, card: unknown): Promise<string> {
  return Promise.resolve().then(() => signer.sign712(agentCardTypedData(card)));
}
