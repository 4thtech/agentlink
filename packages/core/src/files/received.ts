// The receiver's `files` rows (M1-7f-2, D-98; 04 §4 "Retention and crypto-shredding"; 07 §3).
//
// At ingest the core moves each `fileKey` out of the stored payload into a sealed local `files` row
// (the name, the URL and the key sealed under the store key, bound to the table, column and row
// key), so the key can be deleted on its own when retention triggers. The stored payload keeps
// every other field and SHREDDED_FILE_KEY in place of the key, so it still parses as a payload;
// fetchFile reads the key only from the row, and a payload whose key was moved out and whose row is
// gone can open nothing.
//
// What this covers (D-98): relay copies and owner copies of the envelope (07 §4.3), and the stored
// envelope itself, still carry the key inside the end-to-end encryption. The effective shred is
// deleting the object; this row only keeps the key out of the payload column.
import type { Payload } from '@4thtech-io/types';
import type { CoreContext } from '../context.js';
import { seal } from '../context.js';
import type { Row } from '../store/schema.js';

/**
 * The value that replaces a moved-out `fileKey` in a stored payload: 32 zero bytes in base64url.
 * Never used as a key: fetchFile treats it as "the key is gone".
 */
export const SHREDDED_FILE_KEY = 'A'.repeat(43);

/** The sealed locator of a receiver row: nothing this agent stored, so nothing it may delete. */
export const RECEIVED_LOCATOR = JSON.stringify({ kind: 'received' });

/**
 * Builds the receiver rows for an inbound payload and the payload text to store without the keys.
 * Call before the store transaction (no await inside it). A payload without files is returned as
 * it is, with no rows.
 */
export async function receivedFileRows(
  ctx: CoreContext,
  envelopeId: string,
  payload: Payload,
  payloadText: string,
): Promise<{ readonly payloadText: string; readonly rows: Row<'files'>[] }> {
  if (payload.files.length === 0) return { payloadText, rows: [] };
  const stored = JSON.parse(payloadText) as { files: { fileKey: string }[] };
  const rows: Row<'files'>[] = [];
  for (const [idx, entry] of payload.files.entries()) {
    const key = [envelopeId, idx];
    rows.push({
      envelope_id: envelopeId,
      idx,
      name: await seal(ctx, 'files', 'name', key, entry.name),
      size: entry.size,
      sha256: entry.ciphertextSha256,
      locator: await seal(ctx, 'files', 'locator', key, RECEIVED_LOCATOR),
      url: entry.url === null ? null : await seal(ctx, 'files', 'url', key, entry.url),
      file_key: await seal(ctx, 'files', 'file_key', key, entry.fileKey),
      expires_at: entry.expiresAt,
      deleted_at: null,
      // The receiver deletes its row at expiry (deleteExpiredFiles); no send-time snapshot applies.
      delete_after: null,
    });
    const target = stored.files[idx];
    if (target !== undefined) target.fileKey = SHREDDED_FILE_KEY;
  }
  return { payloadText: JSON.stringify(stored), rows };
}
