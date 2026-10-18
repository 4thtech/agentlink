// The sender's `files` rows (07 §3): what it needs later for refresh-link and retention (04 §4).
// The name, the locator, the download URL and the file key are sealed under the store key (`enc`,
// 07 §3.1, bound to the table, column and row key). The drop locator is its signed GET URL, a bearer
// secret (IR-M1-6c-1), so it is only ever stored sealed and never logged.
import type { CoreContext } from '../context.js';
import { seal } from '../context.js';
import type { Row } from '../store/schema.js';
import type { OutgoingRecord } from './outgoing.js';

/** Seals the rows for one envelope's files. Call before the store transaction (no await inside). */
export async function sealFileRows(
  ctx: CoreContext,
  envelopeId: string,
  records: readonly OutgoingRecord[],
): Promise<Row<'files'>[]> {
  const rows: Row<'files'>[] = [];
  for (const r of records) {
    const key = [envelopeId, r.idx];
    const locator = JSON.stringify({ kind: r.kind, locator: r.object?.locator ?? null });
    rows.push({
      envelope_id: envelopeId,
      idx: r.idx,
      name: await seal(ctx, 'files', 'name', key, r.entry.name),
      size: r.entry.size,
      sha256: r.entry.ciphertextSha256,
      locator: await seal(ctx, 'files', 'locator', key, locator),
      url: r.entry.url === null ? null : await seal(ctx, 'files', 'url', key, r.entry.url),
      file_key: await seal(ctx, 'files', 'file_key', key, r.entry.fileKey),
      expires_at: r.entry.expiresAt,
      deleted_at: null,
    });
  }
  return rows;
}
