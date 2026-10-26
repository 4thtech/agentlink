// M2-3a: the cloud agent's plain settings (wrangler.toml [vars]). No secret is read here.

/** D-131 (f): relay sync every 60 s by default (proposed, owner confirms at merge). */
export const DEFAULT_SYNC_INTERVAL_SECONDS = 60;
/** Bounds of SYNC_INTERVAL_SECONDS: faster costs more requests, slower delays messages. */
export const MIN_SYNC_INTERVAL_SECONDS = 30;
export const MAX_SYNC_INTERVAL_SECONDS = 3_600;

/**
 * The alarm interval in seconds: SYNC_INTERVAL_SECONDS as a plain decimal integer within the bounds,
 * otherwise the default. A bad value never stops the loop.
 */
export function syncIntervalSeconds(value: string | undefined): number {
  if (value === undefined || !/^[1-9][0-9]{1,3}$/.test(value)) return DEFAULT_SYNC_INTERVAL_SECONDS;
  const n = Number(value);
  return n >= MIN_SYNC_INTERVAL_SECONDS && n <= MAX_SYNC_INTERVAL_SECONDS
    ? n
    : DEFAULT_SYNC_INTERVAL_SECONDS;
}
