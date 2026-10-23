// Drop usage for the local UI Storage page (M1-11r-c; D-48, D-118; 07 §5.4 Limits, 08 §1).
//
// The drop reserves quota per drop key when it grants an upload: 1 GiB of ciphertext in any rolling
// 7 days. The drop has no usage endpoint, so the core counts its own sender `files` rows whose sealed
// locator says `drop` and whose outgoing envelope was created in the window, as ALF1 ciphertext
// bytes. A deleted object still counts (the reservation is made at the grant). It is an estimate:
// an upload granted for a send that then failed leaves no row, and after a drop-key rotation the
// new key's quota starts fresh while the old uploads are still counted here.
//
// Read-only and zero access (I-7): the result is numbers and a level only, never a URL, a locator,
// a name or a key. A row whose locator does not open is skipped with one fixed log line.
import { alf1CiphertextSize } from '@4thtech-io/storage';
import { nowOf, open, type CoreContext } from '../context.js';
import { CoreError } from '../errors.js';
import type { FilesPlatform } from './platform.js';

const MiB = 1024 * 1024;

/** The drop's quota per drop key in the window (07 §5.4 Limits, M1-27a). */
export const DROP_WEEKLY_QUOTA_BYTES = 1024 * MiB;
/** The rolling window of the drop quota, in seconds. */
export const DROP_QUOTA_WINDOW_SECONDS = 7 * 86_400;
/** From this share of the quota on, the usage reads `near` (11 design brief: within, near, reached). */
export const DROP_NEAR_FRACTION = 0.8;

export type DropUsageLevel = 'within' | 'near' | 'reached';

/** The Storage page's drop meter. Numbers only. */
export interface DropUsage {
  /** This runtime can reach a drop (the platform passed one). */
  readonly available: boolean;
  /** Ciphertext bytes this agent reserved in the window (estimate, see the header). */
  readonly usedBytes: number;
  readonly quotaBytes: number;
  /** `quotaBytes - usedBytes`, never below 0. */
  readonly remainingBytes: number;
  readonly level: DropUsageLevel;
  /** Unix seconds when the oldest counted upload leaves the window; null when nothing counts. */
  readonly resetsAt: number | null;
}

function quotaOf(platform: FilesPlatform | undefined): number {
  const quota = platform?.drop?.weeklyQuotaBytes;
  if (quota === undefined) return DROP_WEEKLY_QUOTA_BYTES;
  if (!Number.isSafeInteger(quota) || quota <= 0) {
    throw new CoreError(
      'files_invalid',
      'The drop quota must be a positive whole number of bytes.',
    );
  }
  return quota;
}

/** The locator's kind, or null when it does not open or parse (nothing about it is logged). */
async function locatorKind(
  ctx: CoreContext,
  envelopeId: string,
  idx: number,
  sealed: Parameters<typeof open>[4],
): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(
      await open(ctx, 'files', 'locator', [envelopeId, idx], sealed),
    );
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const { kind } = parsed as { kind?: unknown };
    return typeof kind === 'string' ? kind : null;
  } catch {
    return null;
  }
}

export async function readDropUsage(
  ctx: CoreContext,
  platform: FilesPlatform | undefined,
): Promise<DropUsage> {
  const quotaBytes = quotaOf(platform);
  const now = nowOf(ctx);
  const since = now - DROP_QUOTA_WINDOW_SECONDS;
  const candidates = await ctx.store.transaction((tx) => {
    const sent = new Map<string, number>();
    for (const e of tx.select('envelopes', { direction: 'out', created_at: { gt: since } })) {
      sent.set(e.envelope_id, e.created_at);
    }
    if (sent.size === 0) return [];
    // A drop object expires at most 7 days after its upload, so a row uploaded in the window still
    // has `expires_at` after its start; the join keeps only this agent's outgoing envelopes.
    return tx.select('files', { expires_at: { gt: since } }).flatMap((row) => {
      const at = sent.get(row.envelope_id);
      return at === undefined ? [] : [{ row, at }];
    });
  });

  let usedBytes = 0;
  let oldest: number | null = null;
  let skipped = false;
  for (const { row, at } of candidates) {
    const kind = await locatorKind(ctx, row.envelope_id, row.idx, row.locator);
    if (kind === null) {
      skipped = true;
      continue;
    }
    if (kind !== 'drop' || !Number.isSafeInteger(row.size) || row.size < 0) continue;
    usedBytes += alf1CiphertextSize(row.size);
    if (oldest === null || at < oldest) oldest = at;
  }
  if (skipped) ctx.log.warn('drop usage: a file row was not readable and is not counted');

  const remainingBytes = Math.max(0, quotaBytes - usedBytes);
  const level: DropUsageLevel =
    usedBytes >= quotaBytes
      ? 'reached'
      : usedBytes >= quotaBytes * DROP_NEAR_FRACTION
        ? 'near'
        : 'within';
  return Object.freeze({
    available: platform?.drop !== undefined,
    usedBytes,
    quotaBytes,
    remainingBytes,
    level,
    resetsAt: oldest === null ? null : oldest + DROP_QUOTA_WINDOW_SECONDS,
  });
}
