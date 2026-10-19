// Inline packing under the payload cap (04 §3.4, G-27, D-85; 07 §5.6 step 1).
//
// A file goes inline only if its ALF1 ciphertext is at most 12 288 bytes and the serialized payload
// (the exact JCS bytes encrypted into `aead.ct`) stays at most 17 136 bytes. The measure here builds
// that payload with placeholders of the exact final lengths (hashes, file key, inline base64url,
// each stored file's `url` at its backend's longest URL), so it is the same number the sender gets
// after upload, or larger.
//
// "Cannot fit" first (IR-M1-6c-1 L2): storage's planInline returns an all-stored plan even when
// that plan is over the cap, and the final check after upload would only refuse it then. So the
// all-stored payload is measured before anything else; when it is over the cap the send is refused
// (`PAYLOAD_TOO_LARGE`) before a single file is read or uploaded.
import { canonicalize, encodeUtf8, type JsonValue } from '@4thtech-io/crypto';
import {
  PAYLOAD_MAX_BYTES,
  PAYLOAD_MAX_FILES,
  alf1CiphertextSize,
  planInline,
} from '@4thtech-io/storage';
import { CoreError } from '../errors.js';

/** The facts the measure needs about one file, before it is encrypted. */
export interface PackingFile {
  /** The file name as it goes into the payload. */
  readonly name: string;
  readonly mime: string;
  /** Plaintext bytes. */
  readonly size: number;
  /** The longest `url` the file's backend can return if it is stored (drop or own storage). */
  readonly storedUrlLength: number;
  /** The `expiresAt` the entry will carry (a backend may only shorten it, never lengthen it). */
  readonly expiresAt: number;
}

/** The rest of the payload (04 §3.4): everything but `files`. */
export interface PackingBase {
  readonly type: string;
  readonly body: unknown;
  readonly replyTo: string | null;
}

export type PackingPlan =
  { readonly fits: true; readonly inline: readonly boolean[] } | { readonly fits: false };

/** Lengths fixed by 04 §3.4: 64 hex digits, and base64url of 32 bytes. */
const HEX64 = 'f'.repeat(64);
const KEY_B64 = 'k'.repeat(43);

const base64urlLength = (bytes: number): number => Math.ceil((bytes * 4) / 3);

/** The serialized payload size in bytes for `inline` (true = the file travels inline). */
export function measurePayload(
  base: PackingBase,
  files: readonly PackingFile[],
  inline: readonly boolean[],
): number {
  const entries = files.map((f, i) => {
    const ct = alf1CiphertextSize(f.size);
    const isInline = inline[i] === true;
    return {
      name: f.name,
      size: f.size,
      mime: f.mime,
      plaintextSha256: HEX64,
      ciphertextSha256: HEX64,
      inline: isInline ? 'A'.repeat(base64urlLength(ct)) : null,
      url: isInline ? null : 'u'.repeat(f.storedUrlLength),
      fileKey: KEY_B64,
      expiresAt: f.expiresAt,
    };
  });
  const payload = { type: base.type, body: base.body, replyTo: base.replyTo, files: entries };
  return encodeUtf8(canonicalize(payload as unknown as JsonValue)).length;
}

/**
 * The D-85 plan: eligible files inline, the largest moved to storage (highest index on a tie) until
 * the payload fits. `{fits: false}` when even the all-stored payload is over the cap: nothing may
 * be read or uploaded then.
 */
export function planPacking(
  base: PackingBase,
  files: readonly PackingFile[],
  maxPayload: number = PAYLOAD_MAX_BYTES,
): PackingPlan {
  if (!Array.isArray(files) || files.length > PAYLOAD_MAX_FILES) {
    throw new CoreError('files_invalid', 'A message carries at most 16 files.');
  }
  const allStored = files.map(() => false);
  if (measurePayload(base, files, allStored) > maxPayload) return { fits: false };
  const sizes = files.map((f) => alf1CiphertextSize(f.size));
  const inline = planInline(sizes, (plan) => measurePayload(base, files, plan), maxPayload);
  // planInline ends at the all-stored plan at worst, which fits (checked above).
  if (measurePayload(base, files, inline) > maxPayload) return { fits: false };
  return { fits: true, inline };
}
