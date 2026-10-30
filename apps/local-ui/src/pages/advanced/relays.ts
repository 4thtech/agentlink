// W4-SETTINGS-ADVANCED: what the health answer says about the relays (08 §1: counts only, a last
// sync in unix seconds; the server never sends an address). Anything else in the body is ignored.
import type { ApiResult } from '../../api/client.js';

export interface Relays {
  readonly connected?: number;
  readonly total?: number;
  /** Unix seconds of the last completed sync. */
  readonly lastSyncAt?: number;
}

const MAX_COUNT = 64;
const isCount = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_COUNT;

/** The relay facts of a health answer; `{}` when it has none; undefined when it is unusable. */
export function parseRelays(result: ApiResult<unknown>): Relays | undefined {
  if (result.kind !== 'ok') return undefined;
  const data = result.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const { relays, lastSyncAt } = data as { relays?: unknown; lastSyncAt?: unknown };
  const out: { connected?: number; total?: number; lastSyncAt?: number } = {};
  if (relays !== null && relays !== undefined) {
    if (typeof relays !== 'object' || Array.isArray(relays)) return undefined;
    const { connected, total } = relays as { connected?: unknown; total?: unknown };
    if (!isCount(connected) || !isCount(total) || connected > total) return undefined;
    out.connected = connected;
    out.total = total;
  }
  if (typeof lastSyncAt === 'number' && Number.isSafeInteger(lastSyncAt) && lastSyncAt >= 0) {
    out.lastSyncAt = lastSyncAt;
  }
  return out;
}
