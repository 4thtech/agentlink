// Storage selection (07 §5.6, 06 §3 `files.storage`, D-48) and inline packing (G-27 option a).
//
// Pure decisions, so the core's `sendFile` (M1-7f) applies one tested table:
// 1. Inline first (G-27 option a, decided by the owner 2026-10-18; spec PR in flight): every file of
//    at most 12 288 bytes of ALF1 ciphertext is marked inline. While the serialized payload is above
//    the receiver's limit of 17 136 bytes (04 §3.1.1), the inline file with the largest ciphertext
//    (on a tie, the highest index) moves to storage. The caller serializes again after any uploads
//    and refuses the send (`PAYLOAD_TOO_LARGE`, nothing sent, uploads deleted) if it is still over.
// 2. `own` → own storage, or `needs_setup` when none is configured. Never the drop.
// 3. `auto` with own storage configured → own storage; no silent fallback to the drop if it fails.
// 4. `auto` or `drop` within the drop limits → the drop.
// 5. Otherwise `needs_setup`, naming the limit and the own-storage option.
// A drop refusal maps back here: size and quota limits keep `needs_setup`; a busy or unavailable
// drop is retryable and never `needs_setup` (IR-D48-1 F10).
import type { StorageAdapter } from './adapter.js';
import { DROP_MAX_CIPHERTEXT_BYTES } from './drop.js';
import { StorageError } from './errors.js';
import { INLINE_MAX_CIPHERTEXT_BYTES } from './inline.js';

/** 06 §3 `files.storage`. */
export type FilesStorage = 'auto' | 'own' | 'drop';

/** The largest serialized payload a receiver accepts (04 §3.1.1: `aead.ct` ≤ 17 152 bytes). */
export const PAYLOAD_MAX_BYTES = 17_136;
/** The most files one payload carries (04 §3.4). */
export const PAYLOAD_MAX_FILES = 16;

export type NeedsSetupReason = 'no_own_storage' | 'size' | 'quota';

export type StorageSelection =
  | { readonly mode: 'own' }
  | { readonly mode: 'drop' }
  | { readonly mode: 'needs_setup'; readonly reason: NeedsSetupReason };

export type RetrySelection = {
  readonly mode: 'retry';
  readonly code: 'rate_limited' | 'unavailable';
  readonly retryAfter?: number;
};

export interface SelectStorageInput {
  readonly policy: FilesStorage;
  /** Own storage (the S3-compatible adapter, or a consumer connector from M2) is configured. */
  readonly ownConfigured: boolean;
  /** The file's ALF1 ciphertext size in bytes. */
  readonly ciphertextSize: number;
  /** The drop's size cap; defaults to 100 MiB (a staging or self-hosted drop may be smaller). */
  readonly dropMaxBytes?: number;
  /** The drop key's remaining weekly quota, when the caller knows it. */
  readonly dropQuotaRemaining?: number;
}

const POLICIES: readonly FilesStorage[] = ['auto', 'own', 'drop'];

function invalid(message: string): StorageError {
  return new StorageError('invalid_argument', message);
}

function isSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** True when a file's ciphertext is small enough to be considered for inline (07 §5.3). */
export function isInlineEligible(ciphertextSize: number): boolean {
  if (!isSize(ciphertextSize)) throw invalid('ciphertextSize must be a positive integer');
  return ciphertextSize <= INLINE_MAX_CIPHERTEXT_BYTES;
}

/** Steps 2–5 of 07 §5.6, for a file that does not travel inline. */
export function selectStorage(input: SelectStorageInput): StorageSelection {
  if (input === null || typeof input !== 'object') throw invalid('missing selection input');
  const { policy, ownConfigured, ciphertextSize } = input;
  if (!POLICIES.includes(policy)) throw invalid('unknown files.storage value');
  if (typeof ownConfigured !== 'boolean') throw invalid('ownConfigured must be a boolean');
  if (!isSize(ciphertextSize)) throw invalid('ciphertextSize must be a positive integer');
  const dropMax = input.dropMaxBytes ?? DROP_MAX_CIPHERTEXT_BYTES;
  if (!isSize(dropMax)) throw invalid('dropMaxBytes must be a positive integer');
  const quota = input.dropQuotaRemaining;
  if (quota !== undefined && !(Number.isSafeInteger(quota) && quota >= 0)) {
    throw invalid('dropQuotaRemaining must be a non-negative integer');
  }

  if (policy === 'own') {
    return ownConfigured ? { mode: 'own' } : { mode: 'needs_setup', reason: 'no_own_storage' };
  }
  if (policy === 'auto' && ownConfigured) return { mode: 'own' };
  if (ciphertextSize > dropMax) return { mode: 'needs_setup', reason: 'size' };
  if (quota !== undefined && ciphertextSize > quota)
    return { mode: 'needs_setup', reason: 'quota' };
  return { mode: 'drop' };
}

export interface ResolvedStorage {
  readonly selection: StorageSelection;
  /** The adapter to upload to; absent for `needs_setup`. */
  readonly adapter?: StorageAdapter;
}

export interface StorageAdapters {
  /** Own storage, when configured. */
  readonly own?: StorageAdapter;
  /** Builds the drop adapter; called only when the selection is the drop. */
  readonly drop?: () => StorageAdapter;
}

/**
 * The selection plus the adapter it names. Under `own`, and under `auto` with own storage, the drop
 * factory is never called, so nothing reaches the drop; a failure of own storage is the caller's to
 * report, never a fallback.
 */
export function resolveStorage(
  input: SelectStorageInput,
  adapters: StorageAdapters,
): ResolvedStorage {
  const selection = selectStorage(input);
  if (selection.mode === 'own') {
    if (adapters.own === undefined) {
      throw new StorageError('invalid_config', 'own storage is configured but missing');
    }
    return { selection, adapter: adapters.own };
  }
  if (selection.mode === 'drop') {
    if (adapters.drop === undefined) {
      throw new StorageError('invalid_config', 'the drop is not configured');
    }
    return { selection, adapter: adapters.drop() };
  }
  return { selection };
}

/** Maps a drop refusal to the selection outcome it means, or null when it is not one. */
export function selectionForError(
  error: unknown,
): Extract<StorageSelection, { mode: 'needs_setup' }> | RetrySelection | null {
  if (!(error instanceof StorageError)) return null;
  if (error.code === 'needs_setup' && (error.limit === 'size' || error.limit === 'quota')) {
    return { mode: 'needs_setup', reason: error.limit };
  }
  if (error.code === 'rate_limited' || error.code === 'unavailable') {
    return {
      mode: 'retry',
      code: error.code,
      ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }),
    };
  }
  return null;
}

/**
 * G-27 option a. `sizes` are the files' ALF1 ciphertext sizes, in payload order; `measure` returns
 * the serialized payload size in bytes for a plan (true = inline), counting each stored file's `url`
 * at its backend's maximum URL length (for the drop, `DropAdapter.maxGetUrlLength`). Returns the
 * plan. When even the all-stored plan is over the limit the result is all-stored; the caller's final
 * check after upload then refuses the send.
 */
export function planInline(
  sizes: readonly number[],
  measure: (inline: readonly boolean[]) => number,
  maxPayload: number = PAYLOAD_MAX_BYTES,
): readonly boolean[] {
  if (!Array.isArray(sizes) || sizes.length > PAYLOAD_MAX_FILES) {
    throw invalid(`a payload carries at most ${String(PAYLOAD_MAX_FILES)} files`);
  }
  if (typeof measure !== 'function') throw invalid('missing payload measure');
  if (!isSize(maxPayload)) throw invalid('maxPayload must be a positive integer');
  const plan = sizes.map((size) => isInlineEligible(size));
  const measured = (): number => {
    const bytes = measure(Object.freeze([...plan]));
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw invalid('payload measure must return a non-negative integer');
    }
    return bytes;
  };
  while (measured() > maxPayload) {
    let largest = -1;
    for (let i = 0; i < plan.length; i += 1) {
      // `>=`: on a tie the highest index moves first.
      if (plan[i] === true && (largest === -1 || (sizes[i] ?? 0) >= (sizes[largest] ?? 0))) {
        largest = i;
      }
    }
    if (largest === -1) break;
    plan[largest] = false;
  }
  return Object.freeze(plan);
}
