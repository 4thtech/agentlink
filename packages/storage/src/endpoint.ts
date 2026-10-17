// Configuration checks for the S3 adapter: endpoint, bucket, region, storage prefix and object keys.
//
// The endpoint check follows the 04 §4 relay-URL grammar, adapted to https: it runs on the raw
// string before any URL parser (a WHATWG parser would map percent-encoding, full-width dots and
// numeric forms onto localhost or IP literals), and refuses IP literals, numeric labels and local
// names. It cannot see DNS: a public name that resolves to a private address is caught by the
// SSRF-safe fetch (M1-15) that the caller injects, not here.
import { decodeBase64url, encodeBase64url, randomBytes } from '@agentlink/crypto';
import { StorageError } from './errors.js';

const MAX_ENDPOINT_LENGTH = 256;
const ENDPOINT_RE = /^https:\/\/([^/:]+)(?::([1-9][0-9]{0,4}))?\/?$/;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NUMERIC_LABEL_RE = /^(?:[0-9]+|0x[0-9a-f]*)$/;
const LAST_LABEL_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const DENIED_SUFFIXES = ['localhost', 'localdomain', 'local', 'internal', 'home.arpa'];

function invalid(what: string): StorageError {
  return new StorageError('invalid_config', `invalid storage ${what}`);
}

/**
 * Returns the endpoint origin (`https://host[:port]`, no trailing slash) or throws
 * `invalid_config`. The error never echoes the input.
 */
export function validateS3Endpoint(endpoint: string): string {
  if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT_LENGTH) {
    throw invalid('endpoint');
  }
  // Printable ASCII only, and no `%` or `\` anywhere (04 §4).
  if (!/^[\x21-\x7e]+$/.test(endpoint) || /[%\\]/.test(endpoint)) throw invalid('endpoint');
  const match = ENDPOINT_RE.exec(endpoint);
  if (match === null) throw invalid('endpoint');
  const host = match[1] ?? '';
  const port = match[2];
  if (host.length > 253 || host.endsWith('.')) throw invalid('endpoint');
  const labels = host.split('.');
  if (labels.length < 2) throw invalid('endpoint');
  for (const label of labels) {
    if (!LABEL_RE.test(label) || NUMERIC_LABEL_RE.test(label)) throw invalid('endpoint');
  }
  if (!LAST_LABEL_RE.test(labels[labels.length - 1] ?? '')) throw invalid('endpoint');
  for (const suffix of DENIED_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) throw invalid('endpoint');
  }
  if (port !== undefined && Number(port) > 65_535) throw invalid('endpoint');
  return port === undefined ? `https://${host}` : `https://${host}:${port}`;
}

/** S3 bucket naming rules, path-style safe (no dots run, no slash, lower case). */
export function validateBucket(bucket: string): string {
  if (
    typeof bucket !== 'string' ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
    bucket.includes('..')
  ) {
    throw invalid('bucket');
  }
  return bucket;
}

export function validateRegion(region: string): string {
  if (typeof region !== 'string' || !/^[a-z0-9-]{1,32}$/.test(region)) throw invalid('region');
  return region;
}

const PREFIX_BYTES = 16;
const OBJECT_ID_BYTES = 16;
const B64URL_16_RE = /^[A-Za-z0-9_-]{22}$/;

/**
 * `storagePrefix` is 16 random bytes in base64url (04 §2.9), generated at `init` and passed in by
 * the caller. It is never the agent ID.
 */
export function validateStoragePrefix(prefix: string): string {
  if (typeof prefix !== 'string' || !B64URL_16_RE.test(prefix)) throw invalid('prefix');
  try {
    decodeBase64url(prefix, { length: PREFIX_BYTES });
  } catch {
    throw invalid('prefix');
  }
  return prefix;
}

/** `agentlink/<storagePrefix>/<random 128-bit>` (04 §2.9, 07 §5.2). No file names or metadata. */
export function newObjectKey(storagePrefix: string): string {
  validateStoragePrefix(storagePrefix);
  return `agentlink/${storagePrefix}/${encodeBase64url(randomBytes(OBJECT_ID_BYTES))}`;
}

/** True only for a key this prefix could have produced. */
export function isOwnObjectKey(storagePrefix: string, key: unknown): key is string {
  if (typeof key !== 'string') return false;
  const parts = key.split('/');
  return (
    parts.length === 3 &&
    parts[0] === 'agentlink' &&
    parts[1] === storagePrefix &&
    B64URL_16_RE.test(parts[2] ?? '')
  );
}
