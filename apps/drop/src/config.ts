// Limits and configuration of the encrypted drop (07 §5.4 Limits, 04 §4; CORS 08 §7). The defaults
// are the spec's proposed values. Environment overrides exist for staging and tests; each is bounded,
// and the size cap can never exceed the spec's 100 MiB. Any invalid value makes readConfig return
// null and the Worker fail closed (`unavailable`), never run with a guessed limit.
import { DROP_URL_KEY_LENGTH, decodeBase64url } from '@agentlink/crypto';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export interface Limits {
  /** Largest object (ciphertext bytes). */
  readonly maxSize: number;
  /** Multipart part size; an object larger than this gets one signed target per part. */
  readonly partSize: number;
  /** Bytes one drop key may reserve in any rolling 7 days. */
  readonly weeklyQuota: number;
  /** Upload grants per drop key per hour. */
  readonly keyUploadsPerHour: number;
  /** Signed requests (upload, commit, DELETE) per drop key per hour. */
  readonly keyRequestsPerHour: number;
  /** Drop keys first admitted from one IP (IPv6 /64) in any rolling 24 hours. */
  readonly ipNewKeysPerDay: number;
  /** Absolute ceiling on signed requests (upload, commit, DELETE) per IP (IPv6 /64) per hour, all
   * keys together. Generous, so a shared NAT is not blocked; an abuse backstop only. */
  readonly ipRequestsPerHour: number;
  /** Abuse reports per IP (IPv6 /64) per hour. */
  readonly ipReportsPerHour: number;
  /** Bytes the whole drop may grant in any rolling 24 hours (global cap). */
  readonly globalBytesPerDay: number;
  /** Upload grants for the whole drop per hour (global cap). */
  readonly globalUploadsPerHour: number;
  /** Downloads per object: twice the 8-recipient envelope maximum (04 §3.1.1). */
  readonly downloadLimit: number;
  /** Hard expiry after upload (not configurable). */
  readonly maxExpirySeconds: number;
  /** Lifetime of a signed PUT target (not configurable). */
  readonly uploadTargetSeconds: number;
}

export const DEFAULTS: Limits = Object.freeze({
  maxSize: 100 * MiB,
  partSize: 64 * MiB,
  weeklyQuota: GiB,
  keyUploadsPerHour: 60,
  keyRequestsPerHour: 240,
  ipNewKeysPerDay: 10,
  ipRequestsPerHour: 3_000,
  ipReportsPerHour: 20,
  globalBytesPerDay: 500 * GiB,
  globalUploadsPerHour: 20_000,
  downloadLimit: 16,
  maxExpirySeconds: 7 * 86_400,
  uploadTargetSeconds: 15 * 60,
});

type Overridable = Exclude<keyof Limits, 'maxExpirySeconds' | 'uploadTargetSeconds'>;

/** Environment name, then the inclusive bounds of an override. */
const OVERRIDES: Readonly<Record<Overridable, readonly [string, number, number]>> = {
  maxSize: ['DROP_MAX_SIZE', 1, 100 * MiB],
  partSize: ['DROP_PART_SIZE', 5 * MiB, 64 * MiB],
  weeklyQuota: ['DROP_WEEKLY_QUOTA', 1, GiB],
  keyUploadsPerHour: ['DROP_KEY_UPLOADS_PER_HOUR', 1, 1_000],
  keyRequestsPerHour: ['DROP_KEY_REQUESTS_PER_HOUR', 1, 10_000],
  ipNewKeysPerDay: ['DROP_IP_NEW_KEYS_PER_DAY', 1, 1_000],
  ipRequestsPerHour: ['DROP_IP_REQUESTS_PER_HOUR', 1, 1_000_000],
  ipReportsPerHour: ['DROP_IP_REPORTS_PER_HOUR', 1, 1_000],
  globalBytesPerDay: ['DROP_GLOBAL_BYTES_PER_DAY', 1, 10 * 1024 * GiB],
  globalUploadsPerHour: ['DROP_GLOBAL_UPLOADS_PER_HOUR', 1, 1_000_000],
  downloadLimit: ['DROP_DOWNLOAD_LIMIT', 1, 100],
};

export interface DropConfig {
  readonly limits: Limits;
  /** The Worker secret (32 bytes) from which the URL MAC and IP-bucket keys are derived. */
  readonly urlKey: Uint8Array;
  /** Origins allowed to fetch objects from a browser (08 §7). Exact `https://host[:port]` only. */
  readonly corsOrigins: readonly string[];
}

const ORIGIN =
  /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

function parseInteger(text: string, min: number, max: number): number | null {
  if (!/^(0|[1-9]\d{0,15})$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

/** The drop's configuration from its Worker environment, or null when any value is invalid. */
export function readConfig(env: Readonly<Record<string, unknown>>): DropConfig | null {
  const rawKey = env.DROP_URL_KEY;
  if (typeof rawKey !== 'string') return null;
  let urlKey: Uint8Array;
  try {
    urlKey = decodeBase64url(rawKey, { length: DROP_URL_KEY_LENGTH });
  } catch {
    return null;
  }

  const limits: Record<string, number> = { ...DEFAULTS };
  for (const [field, [name, min, max]] of Object.entries(OVERRIDES)) {
    const raw = env[name];
    if (raw === undefined) continue;
    if (typeof raw !== 'string') return null;
    const value = parseInteger(raw, min, max);
    if (value === null) return null;
    limits[field] = value;
  }

  let corsOrigins: string[] = [];
  const rawOrigins = env.DROP_CORS_ORIGINS;
  if (rawOrigins !== undefined) {
    if (typeof rawOrigins !== 'string') return null;
    corsOrigins = rawOrigins
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== '');
    if (corsOrigins.some((origin) => !ORIGIN.test(origin))) return null;
  }

  return Object.freeze({
    limits: Object.freeze(limits) as unknown as Limits,
    urlKey,
    corsOrigins: Object.freeze(corsOrigins),
  });
}
