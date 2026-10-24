// Own storage as the owner signed it (M1-9i-a, D-115; 04 §2.2, §2.5.1; 07 §3.4, §5.2, §5.6).
//
// - The `storage-mark` KeyStore item: `{"v":1,"active"}` as its exact JCS bytes, where `active` is
//   the `id` of the applied `storage.set` or null after a `storage.remove`. Its codec lives here so
//   every backend writes the same bytes; the backends (M1-9i-c) write it under the agent's
//   inter-process lock (06 §6) and read it back.
// - OwnStorage.load(): `none`, `ready` or `broken` (07 §3.4 "Load"). `ready` only when the stored
//   `storage.set` verifies (encoding, `sig`, `agent`, `owner`, schema; never its expiry), its `id`
//   equals the row's `id` and `active` in `storage-mark`, and `s3:<id>` exists with a matching
//   `credentialDigest`, compared in constant time. Anything else is `broken`, which counts as
//   configured: a send never falls back to the drop (07 §5.6). A mismatch is never repaired.
// - brokenOwnStorageAdapter(): the stub the runtime passes as own storage for `broken`; it refuses
//   every call, and the file send turns it into `needs_setup` `storage_broken` before any upload.
//
// I-7: no credential ever reaches the core. The KeyStore side returns only the credentialDigest of
// `s3:<id>`, and the S3 adapter's credentials provider reads the item itself at each use. Nothing
// here logs the endpoint, the bucket or a digest; problems are fixed codes.
import {
  canonicalize,
  decodeHex,
  decodeUtf8,
  encodeUtf8,
  equalBytes,
  parseJson,
} from '@4thtech-io/crypto';
import { StorageError, type StorageAdapter } from '@4thtech-io/storage';
import { storageIdSchema, type StorageProvider } from '@4thtech-io/types';
import { nowOf, open, type CoreContext } from './context.js';
import type { IdentityService } from './identity.js';
import { verifyStoredOwnerAction } from './owner-action.js';
import type { Row } from './store/schema.js';

/** The KeyStore item names (04 §2.2): `<agentId>:storage-mark` and `<agentId>:s3:<id>`. */
export const STORAGE_MARK_ITEM = 'storage-mark';
export const storageCredentialItem = (id: string): string => `s3:${id}`;

/**
 * The own-storage KeyStore items of one agent, as the core needs them (04 §2.2, §2.5.1). Backends
 * implement it next to their KeyStore (keychain and file, Node, M1-9i-c), like PolicyVersionMark.
 * - `readMark`: the `storage-mark` item's bytes, or null when the item does not exist (an agent
 *   created before M1-9i). Throws when it cannot be read; never returns null for that.
 * - `writeMark`: writes `encodeStorageMark(active)` under the agent's inter-process lock (06 §6),
 *   reads it back, and rejects when the write did not stick.
 * - `credentialDigest`: the `credentialDigest` of the item `s3:<id>` (`credentialDigestOfItem`,
 *   @4thtech-io/crypto) as 64 lowercase hex, or null when the item does not exist. Throws when it is
 *   malformed or unreadable. It never returns or logs the credential (I-7).
 */
export interface OwnStorageKeys {
  readMark(): Promise<Uint8Array | null>;
  writeMark(active: string | null): Promise<void>;
  credentialDigest(id: string): Promise<string | null>;
}

/** The decoded `storage-mark` item. */
export interface StorageMark {
  readonly active: string | null;
}

function checkActive(active: unknown): asserts active is string | null {
  if (active !== null && !storageIdSchema.safeParse(active).success) {
    throw new TypeError('storage-mark: active must be null or 16 lowercase hex');
  }
}

/** The exact item bytes: JCS of `{"v":1,"active"}` as UTF-8 (04 §2.2). */
export function encodeStorageMark(active: string | null): Uint8Array {
  checkActive(active);
  return encodeUtf8(canonicalize({ v: 1, active }));
}

/**
 * Decodes the item strictly: it must be exactly the bytes encodeStorageMark gives for its value
 * (canonical JCS, no other key, `v` 1, `active` null or 16 lowercase hex). Anything else throws, and
 * the load reads `broken` (malformed fails closed, 04 §2.2); it is never read as `active: null`.
 */
export function decodeStorageMark(bytes: Uint8Array): StorageMark {
  let value: unknown;
  try {
    value = parseJson(decodeUtf8(bytes), { integersOnly: true });
  } catch {
    throw new TypeError('storage-mark: not JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('storage-mark: not an object');
  }
  const { active } = value as { active?: unknown };
  checkActive(active === undefined ? '' : active);
  if (!equalBytes(encodeStorageMark(active as string | null), bytes)) {
    throw new TypeError('storage-mark: not its canonical form');
  }
  return { active: active as string | null };
}

/** Why own storage reads `broken` (fixed codes for `doctor`; never a value, I-7). */
export type OwnStorageProblem =
  | 'keys_unavailable'
  | 'mark_unavailable'
  | 'mark_malformed'
  | 'store_unreadable'
  | 'identity_unavailable'
  | 'row_missing'
  | 'not_active'
  | 'row_invalid'
  | 'credential_unavailable'
  | 'credential_missing'
  | 'credential_mismatch';

export type OwnStorageState =
  | { readonly state: 'none' }
  | {
      readonly state: 'ready';
      readonly id: string;
      readonly provider: StorageProvider;
      readonly endpoint: string;
      readonly bucket: string;
      readonly region: string;
    }
  | { readonly state: 'broken'; readonly problem: OwnStorageProblem };

const broken = (problem: OwnStorageProblem): OwnStorageState => ({ state: 'broken', problem });

/**
 * The outcome of a test upload, download and delete (07 §5.2 guided setup), as a fixed code only:
 * free text could carry an endpoint, a bucket or a credential (I-7).
 */
export type OwnStorageTestCode =
  | 'ok'
  | 'upload_failed'
  | 'download_failed'
  | 'delete_failed'
  | 'credentials_refused'
  | 'unreachable'
  | 'failed';

const TEST_CODES: ReadonlySet<string> = new Set<OwnStorageTestCode>([
  'ok',
  'upload_failed',
  'download_failed',
  'delete_failed',
  'credentials_refused',
  'unreachable',
  'failed',
]);

/** A test result as the caller reports it: `ok` true exactly when `code` is `ok`. */
export interface OwnStorageTestInput {
  readonly ok: boolean;
  readonly code: OwnStorageTestCode;
}

/** The last test result, with the unix time the core recorded it. */
export interface OwnStorageTest extends OwnStorageTestInput {
  readonly at: number;
}

/**
 * Own storage for the Storage page (M1-11r-c; 08 §1): whether it is configured and working, the
 * provider for display, the fixed problem code when broken, and the last test result of this
 * process. Never the endpoint, bucket, region, id, credential or credentialDigest (I-7, 04 §4).
 */
export type OwnStorageStatus =
  | {
      readonly state: 'none';
      readonly configured: false;
      readonly working: false;
      readonly lastTest: null;
    }
  | {
      readonly state: 'ready';
      readonly configured: true;
      readonly working: true;
      readonly provider: StorageProvider;
      readonly lastTest: OwnStorageTest | null;
    }
  | {
      readonly state: 'broken';
      readonly configured: true;
      readonly working: false;
      readonly problem: OwnStorageProblem;
      readonly lastTest: OwnStorageTest | null;
    };

function checkTestInput(input: unknown): OwnStorageTestInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('own storage test: not an object');
  }
  const keys = Object.keys(input).sort();
  if (keys.length !== 2 || keys[0] !== 'code' || keys[1] !== 'ok') {
    throw new TypeError('own storage test: exactly ok and code');
  }
  const { ok, code } = input as { ok: unknown; code: unknown };
  if (typeof ok !== 'boolean' || typeof code !== 'string' || !TEST_CODES.has(code)) {
    throw new TypeError('own storage test: ok must be a boolean and code a known code');
  }
  if (ok !== (code === 'ok')) throw new TypeError('own storage test: ok and code disagree');
  return { ok, code: code as OwnStorageTestCode };
}

/**
 * Compares two credentialDigests in constant time over their decoded bytes (never `===` on the
 * hex; AUDIT-FABLE-M1-9i-b2-1). A value that is not 64 lowercase hex matches nothing.
 */
export function credentialDigestsEqual(a: string, b: string): boolean {
  let x: Uint8Array;
  let y: Uint8Array;
  try {
    x = decodeHex(a, { length: 32 });
    y = decodeHex(b, { length: 32 });
  } catch {
    return false;
  }
  return equalBytes(x, y);
}

/** Reads `storage-mark`: a missing item is `active: null`; unreadable or malformed is a problem. */
export async function readStorageMark(
  keys: OwnStorageKeys,
): Promise<StorageMark | 'mark_unavailable' | 'mark_malformed'> {
  let bytes: Uint8Array | null;
  try {
    bytes = await keys.readMark();
  } catch {
    return 'mark_unavailable';
  }
  if (bytes === null) return { active: null };
  try {
    return decodeStorageMark(bytes);
  } catch {
    return 'mark_malformed';
  }
}

export class OwnStorage {
  readonly #ctx: CoreContext;
  readonly #identity: IdentityService;
  readonly #keys: OwnStorageKeys | undefined;
  /**
   * The last test result in this process, bound to the storage it tested: the `ready` id, or null
   * for a `broken` storage. Memory only; a restart shows "not tested yet".
   */
  #lastTest: { readonly boundTo: string | null; readonly test: OwnStorageTest } | undefined;

  constructor(ctx: CoreContext, identity: IdentityService, keys: OwnStorageKeys | undefined) {
    this.#ctx = ctx;
    this.#identity = identity;
    this.#keys = keys;
  }

  /**
   * The own storage to use now (07 §3.4 "Load"). Read-only: it never writes the store or a KeyStore
   * item, so a mismatch stays `broken` until the owner connects again. Without the KeyStore items
   * (a runtime that did not wire them) nothing can be checked, so it is `broken`, never `none`.
   */
  async load(): Promise<OwnStorageState> {
    const keys = this.#keys;
    if (keys === undefined) return broken('keys_unavailable');
    const mark = await readStorageMark(keys);
    let row: Row<'own_storage'> | undefined;
    try {
      row = await this.#ctx.store.transaction((tx) => tx.select('own_storage')[0]);
    } catch {
      return broken('store_unreadable');
    }
    if (typeof mark === 'string') return broken(mark);
    if (row === undefined) return mark.active === null ? { state: 'none' } : broken('row_missing');
    if (mark.active === null || mark.active !== row.id) return broken('not_active');

    let text: string;
    try {
      text = await open(this.#ctx, 'own_storage', 'signed_json', [row.id], row.signed_json);
    } catch {
      return broken('store_unreadable');
    }
    let self: { agent: string; ownerNostr: string };
    try {
      const view = await this.#identity.get();
      if (view === undefined || view.revoked) return broken('identity_unavailable');
      self = { agent: view.agentId, ownerNostr: view.card.ownerNostr };
    } catch {
      return broken('identity_unavailable');
    }
    // Encoding, schema, `agent`, `owner` and `sig`; never expiry or the nonce (04 §2.5.1).
    const verified = verifyStoredOwnerAction(text, self);
    if (!verified.ok) return broken('row_invalid');
    const { body } = verified.signed;
    if (body.op !== 'storage.set' || body.params.id !== row.id) return broken('row_invalid');

    let digest: string | null;
    try {
      digest = await keys.credentialDigest(row.id);
    } catch {
      return broken('credential_unavailable');
    }
    if (digest === null) return broken('credential_missing');
    if (!credentialDigestsEqual(digest, body.params.credentialDigest)) {
      return broken('credential_mismatch');
    }
    const { id, provider, endpoint, bucket, region } = body.params;
    return { state: 'ready', id, provider, endpoint, bucket, region };
  }

  /**
   * The Storage page's read (M1-11r-c): load() reduced to display values. A test result is shown
   * only for the storage it was recorded against (a new connection, or a change between ready and
   * broken, hides it); with nothing configured there is none.
   */
  async status(): Promise<OwnStorageStatus> {
    const state = await this.load();
    if (state.state === 'none') {
      return Object.freeze({ state: 'none', configured: false, working: false, lastTest: null });
    }
    const boundTo = state.state === 'ready' ? state.id : null;
    const last = this.#lastTest;
    const lastTest = last !== undefined && last.boundTo === boundTo ? last.test : null;
    if (state.state === 'ready') {
      return Object.freeze({
        state: 'ready',
        configured: true,
        working: true,
        provider: state.provider,
        lastTest,
      });
    }
    return Object.freeze({
      state: 'broken',
      configured: true,
      working: false,
      problem: state.problem,
      lastTest,
    });
  }

  /**
   * Records the result of a test the runtime ran against the current own storage (a fixed code,
   * never free text). With nothing configured it is not kept. Malformed input throws and keeps the
   * previous result.
   */
  async recordTest(result: OwnStorageTestInput): Promise<void> {
    const checked = checkTestInput(result);
    const at = nowOf(this.#ctx);
    const state = await this.load();
    if (state.state === 'none') {
      this.#lastTest = undefined;
      return;
    }
    this.#lastTest = {
      boundTo: state.state === 'ready' ? state.id : null,
      test: Object.freeze({ ...checked, at }),
    };
  }
}

const BROKEN_STUBS = new WeakSet<object>();

function refused(): Promise<never> {
  return Promise.reject(
    new StorageError('credentials_unavailable', 'storage credentials are unavailable'),
  );
}

/**
 * The own-storage adapter for a `broken` own storage (07 §5.6): every call is refused with
 * `credentials_unavailable`. Passed as `FilesPlatform.ownStorage`, it keeps own storage configured,
 * so `files.storage: auto` never falls back to the drop, and a send that would store a file returns
 * `needs_setup` `storage_broken` before anything is read or uploaded.
 */
export function brokenOwnStorageAdapter(): StorageAdapter {
  const stub: StorageAdapter = Object.freeze({
    kind: 's3' as const,
    put: refused,
    presignGet: refused,
    delete: refused,
  });
  BROKEN_STUBS.add(stub);
  return stub;
}

/** True only for an adapter made by brokenOwnStorageAdapter (by identity, not by shape). */
export function isBrokenOwnStorageAdapter(adapter: unknown): boolean {
  return typeof adapter === 'object' && adapter !== null && BROKEN_STUBS.has(adapter);
}
