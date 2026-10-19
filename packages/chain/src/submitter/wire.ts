// The submitter API in JSON (07 §7; 05 §3.1 JSON form, 04 §2.4.1; M1-10a). Shared by the
// submitter Worker (apps/submitter), which parses requests with it, and by clients (M1-4c), which
// parse its answers with it. Everything is parsed strictly: unknown fields, other spellings and
// out-of-range values are refused, never normalised. A refusal is a ChainInputError with a fixed
// code and text; it never echoes its input (a signature, a record or a URL).
//
// A submitter only relays items its client signed (I-3): it never sees a key, plaintext or a
// storage link, and it cannot alter what it sends, because the Notary checks every signature.
// Its answers are untrusted: a client confirms every status by reading the chain (04 §7, M1-4c).
import { parseReceipt, parseRecord, type OccReceipt, type OccRecord } from '@4thtech-io/crypto';
import { ChainInputError, checkChainId, computeRecordId, type Hex } from '../ids/index.js';

/** Most items in one request; also the largest batch (the 05 §3.4 gas target is for n = 20). */
export const SUBMITTER_MAX_ITEMS = 20;
/**
 * Largest signature, in bytes. An EOA signature is 65 bytes; an ERC-1271 account's (a nested
 * ERC-7739 signature, for example) can be several hundred (07 §7, FA-11).
 */
export const SUBMITTER_MAX_SIGNATURE_BYTES = 2048;

/** One signed Record (`POST /v1/notarize`) or Receipt (`POST /v1/receipt`), parsed. */
export type SubmitItem =
  | {
      readonly type: 'record';
      /** The item's ID: its record ID. */
      readonly id: string;
      readonly recordId: Hex;
      readonly signer: Hex;
      readonly deadline: number;
      readonly record: OccRecord;
      readonly signature: Hex;
    }
  | {
      readonly type: 'receipt';
      /** The item's ID: `<recordId>:<receiptType>`. */
      readonly id: string;
      readonly recordId: Hex;
      readonly signer: Hex;
      readonly deadline: number;
      readonly receipt: OccReceipt;
      readonly signature: Hex;
    };

export type SubmitKind = 'notarize' | 'receipt';

/** A parsed submit request: one chain, one item type, 1 to SUBMITTER_MAX_ITEMS distinct items. */
export interface SubmitRequest {
  readonly chainId: number;
  readonly items: readonly SubmitItem[];
}

/**
 * Per-item status (05 §3.3, 07 §7). Final: `recorded`, `skipped` (already on-chain in identical
 * form; a client treats it as success with the existing record ID) and `failed`. In flight:
 * `submitted` (in a sent transaction, `txHash`) and `held` (the Notary is paused; sent after unpause
 * or `failed` with `Expired` at the deadline).
 */
export type SubmitStatus = 'submitted' | 'held' | 'recorded' | 'skipped' | 'failed';

export const SUBMIT_STATUSES: readonly SubmitStatus[] = Object.freeze([
  'submitted',
  'held',
  'recorded',
  'skipped',
  'failed',
]);

export interface SubmitItemResult {
  readonly id: string;
  readonly recordId: Hex;
  readonly status: SubmitStatus;
  /** The transaction that carries the item now (`submitted`, `recorded`, a revert's `failed`). */
  readonly txHash?: Hex;
  /** Why it failed: a contract error name (`InsufficientCredits`) or a fixed code. */
  readonly error?: string;
}

export interface SubmitResponse {
  readonly chainId: number;
  readonly items: readonly SubmitItemResult[];
}

/**
 * `GET /v1/status/:txHash`. `items` show each item's current status and transaction. `dropped`:
 * neither the transaction nor its fee-bumped replacements were included in time; its items were
 * queued again (they show their new transaction).
 */
export interface StatusResponse {
  readonly chainId: number;
  readonly txHash: Hex;
  readonly state: 'pending' | 'included' | 'reverted' | 'dropped';
  readonly items: readonly SubmitItemResult[];
}

/** `GET /v1/health`: per chain, the gas balance in wei (decimal string) and the queue depth. */
export interface HealthResponse {
  readonly ok: boolean;
  readonly chains: readonly {
    readonly chainId: number;
    readonly available: boolean;
    readonly gasBalance: string | null;
    readonly queueDepth: number;
  }[];
}

const BYTES32 = /^0x[0-9a-f]{64}$/;
const TX_HASH = BYTES32;
const ITEM_ID = /^0x[0-9a-f]{64}(?::[1-4])?$/;
const ERROR_CODE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;

const fail = (code: string, message: string): never => {
  throw new ChainInputError(code, message);
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function exactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  what: string,
): Record<string, unknown> {
  if (!isObject(value)) fail('invalid_submit_body', `${what}: must be an object`);
  const obj = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key !== 'string' || (!required.includes(key) && !optional.includes(key))) {
      fail('invalid_submit_body', `${what}: unknown field`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(obj, key)) fail('invalid_submit_body', `${what}: missing field`);
  }
  return obj;
}

/** A signature in JSON form: `0x` + lowercase hex, 1 to SUBMITTER_MAX_SIGNATURE_BYTES bytes. */
export function isSubmitSignature(value: unknown): value is Hex {
  return (
    typeof value === 'string' &&
    value.length >= 4 &&
    value.length <= 2 + 2 * SUBMITTER_MAX_SIGNATURE_BYTES &&
    value.length % 2 === 0 &&
    /^0x[0-9a-f]+$/.test(value)
  );
}

function signatureOf(value: unknown): Hex {
  if (!isSubmitSignature(value)) {
    fail('invalid_signature_form', 'signature: must be 0x + lowercase hex, at most 2048 bytes');
  }
  return value as Hex;
}

function strictParse<T>(parse: (v: unknown) => T, value: unknown, what: string): T {
  try {
    return parse(value);
  } catch {
    // The crypto parser's message may describe the input; ours never does.
    return fail('invalid_submit_body', `${what}: not in the 05 §3.1 JSON form`);
  }
}

/**
 * Parses a `POST /v1/notarize` (`{chainId, records: [{record, signature}]}`) or `POST /v1/receipt`
 * (`{chainId, receipts: [{receipt, signature}]}`) body. `notaryFor` returns the Notary address of a
 * chain the caller supports (lowercase), or undefined, which refuses the request
 * (`unsupported_chain`). Duplicate items are refused.
 */
export function parseSubmitRequest(
  kind: SubmitKind,
  body: unknown,
  notaryFor: (chainId: number) => string | undefined,
): SubmitRequest {
  const field = kind === 'notarize' ? 'records' : 'receipts';
  const obj = exactKeys(body, ['chainId', field], [], 'request');
  let chainId: number;
  try {
    chainId = checkChainId(obj.chainId);
  } catch {
    return fail('invalid_submit_body', 'chainId: must be a positive integer');
  }
  const notary = notaryFor(chainId);
  if (notary === undefined) fail('unsupported_chain', 'that chain is not served here');
  const list = obj[field];
  if (!Array.isArray(list) || list.length < 1 || list.length > SUBMITTER_MAX_ITEMS) {
    fail('invalid_submit_body', `${field}: 1 to ${String(SUBMITTER_MAX_ITEMS)} items`);
  }
  const seen = new Set<string>();
  const items = (list as unknown[]).map((entry): SubmitItem => {
    let item: SubmitItem;
    if (kind === 'notarize') {
      const e = exactKeys(entry, ['record', 'signature'], [], 'item');
      const record = strictParse(parseRecord, e.record, 'record');
      const recordId = computeRecordId(
        chainId,
        notary as string,
        record.signer,
        BigInt(record.nonce),
      );
      item = Object.freeze({
        type: 'record',
        id: recordId,
        recordId,
        signer: record.signer as Hex,
        deadline: record.deadline,
        record: Object.freeze(record),
        signature: signatureOf(e.signature),
      });
    } else {
      const e = exactKeys(entry, ['receipt', 'signature'], [], 'item');
      const receipt = strictParse(parseReceipt, e.receipt, 'receipt');
      item = Object.freeze({
        type: 'receipt',
        id: `${receipt.recordId}:${String(receipt.receiptType)}`,
        recordId: receipt.recordId as Hex,
        signer: receipt.signer as Hex,
        deadline: receipt.deadline,
        receipt: Object.freeze(receipt),
        signature: signatureOf(e.signature),
      });
    }
    if (seen.has(item.id)) fail('invalid_submit_body', `${field}: the same item twice`);
    seen.add(item.id);
    return item;
  });
  return Object.freeze({ chainId, items: Object.freeze(items) });
}

/** The JSON body a client sends for `items` (the inverse of parseSubmitRequest). */
export function submitRequestBody(
  kind: SubmitKind,
  chainId: number,
  items: readonly ({ record: OccRecord } | { receipt: OccReceipt })[],
  signatures: readonly string[],
): Record<string, unknown> {
  if (items.length !== signatures.length) {
    fail('invalid_submit_body', 'one signature per item');
  }
  const field = kind === 'notarize' ? 'records' : 'receipts';
  return {
    chainId: checkChainId(chainId),
    [field]: items.map((item, i) => ({ ...item, signature: signatureOf(signatures[i]) })),
  };
}

function itemResultOf(value: unknown): SubmitItemResult {
  const o = exactKeys(value, ['id', 'recordId', 'status'], ['txHash', 'error'], 'item result');
  if (typeof o.id !== 'string' || !ITEM_ID.test(o.id)) fail('invalid_submitter_answer', 'id');
  if (typeof o.recordId !== 'string' || !BYTES32.test(o.recordId)) {
    fail('invalid_submitter_answer', 'recordId');
  }
  if (!(o.id as string).startsWith(o.recordId as string)) {
    fail('invalid_submitter_answer', 'id and recordId differ');
  }
  if (!SUBMIT_STATUSES.includes(o.status as SubmitStatus)) {
    fail('invalid_submitter_answer', 'status');
  }
  if (o.txHash !== undefined && (typeof o.txHash !== 'string' || !TX_HASH.test(o.txHash))) {
    fail('invalid_submitter_answer', 'txHash');
  }
  if (o.error !== undefined && (typeof o.error !== 'string' || !ERROR_CODE.test(o.error))) {
    fail('invalid_submitter_answer', 'error');
  }
  return Object.freeze({
    id: o.id as string,
    recordId: o.recordId as Hex,
    status: o.status as SubmitStatus,
    ...(o.txHash === undefined ? {} : { txHash: o.txHash as Hex }),
    ...(o.error === undefined ? {} : { error: o.error as string }),
  });
}

function itemResults(value: unknown): readonly SubmitItemResult[] {
  if (!Array.isArray(value) || value.length > SUBMITTER_MAX_ITEMS * 2) {
    fail('invalid_submitter_answer', 'items');
  }
  return Object.freeze((value as unknown[]).map(itemResultOf));
}

function chainIdOf(value: unknown): number {
  try {
    return checkChainId(value);
  } catch {
    return fail('invalid_submitter_answer', 'chainId');
  }
}

/** Parses a submit answer. Untrusted: a client confirms every status on-chain (M1-4c). */
export function parseSubmitResponse(value: unknown): SubmitResponse {
  const o = exactKeys(value, ['chainId', 'items'], [], 'answer');
  return Object.freeze({ chainId: chainIdOf(o.chainId), items: itemResults(o.items) });
}

/** Parses a status answer. Untrusted, like every submitter answer. */
export function parseStatusResponse(value: unknown): StatusResponse {
  const o = exactKeys(value, ['chainId', 'txHash', 'state', 'items'], [], 'answer');
  if (typeof o.txHash !== 'string' || !TX_HASH.test(o.txHash)) {
    fail('invalid_submitter_answer', 'txHash');
  }
  if (!['pending', 'included', 'reverted', 'dropped'].includes(o.state as string)) {
    fail('invalid_submitter_answer', 'state');
  }
  return Object.freeze({
    chainId: chainIdOf(o.chainId),
    txHash: o.txHash as Hex,
    state: o.state as StatusResponse['state'],
    items: itemResults(o.items),
  });
}

/** Parses a health answer. */
export function parseHealthResponse(value: unknown): HealthResponse {
  const o = exactKeys(value, ['ok', 'chains'], [], 'answer');
  if (typeof o.ok !== 'boolean' || !Array.isArray(o.chains) || o.chains.length > 64) {
    fail('invalid_submitter_answer', 'health');
  }
  const chains = (o.chains as unknown[]).map((c) => {
    const e = exactKeys(c, ['chainId', 'available', 'gasBalance', 'queueDepth'], [], 'chain');
    if (typeof e.available !== 'boolean') fail('invalid_submitter_answer', 'available');
    if (
      e.gasBalance !== null &&
      (typeof e.gasBalance !== 'string' || !DECIMAL.test(e.gasBalance))
    ) {
      fail('invalid_submitter_answer', 'gasBalance');
    }
    if (
      typeof e.queueDepth !== 'number' ||
      !Number.isSafeInteger(e.queueDepth) ||
      e.queueDepth < 0
    ) {
      fail('invalid_submitter_answer', 'queueDepth');
    }
    return Object.freeze({
      chainId: chainIdOf(e.chainId),
      available: e.available as boolean,
      gasBalance: e.gasBalance as string | null,
      queueDepth: e.queueDepth as number,
    });
  });
  return Object.freeze({ ok: o.ok as boolean, chains: Object.freeze(chains) });
}

/** True for a transaction hash in JSON form. */
export function isTxHash(value: unknown): value is Hex {
  return typeof value === 'string' && TX_HASH.test(value);
}

/** True for an item error code (a contract error name or a fixed code). */
export function isSubmitErrorCode(value: unknown): value is string {
  return typeof value === 'string' && ERROR_CODE.test(value);
}
