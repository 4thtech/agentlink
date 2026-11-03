// R2 (robustness class 2): why a `failed` answer failed, as a fixed code from a closed set, so the
// page can say something specific. A reason is chosen from the error's `name` and `code` only, both
// fixed strings of our own error classes or of the operating system. The error's message, its
// `cause`, and anything from the request or from inbound content are never read (I-5, I-7).

/** The closed set of `reason` codes a catch-all `failed` answer may carry. */
export const FAILURE_REASONS = [
  'storage_unreachable',
  'relay_unreachable',
  'ai_app_running',
  'ai_app_config_unwritable',
  'keychain_unavailable',
  'busy',
  'internal',
] as const;

export type FailureReason = (typeof FAILURE_REASONS)[number];

const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);
const STORAGE_CODES: ReadonlySet<string> = new Set([
  'network',
  'upload_failed',
  'download_failed',
  'delete_failed',
  'lifecycle_failed',
  'rate_limited',
  'unavailable',
  'credentials_unavailable',
  'credentials_expired',
  'invalid_response',
]);
const KEYCHAIN_CODES: ReadonlySet<string> = new Set(['keychain_failed', 'backend_unavailable']);

function pick(error: unknown, key: 'name' | 'code'): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** The fixed reason for a thrown value; `internal` for anything not recognised. */
export function failureReasonOf(error: unknown): FailureReason {
  const name = pick(error, 'name');
  const code = pick(error, 'code');
  if (name === 'StorageError') {
    return code !== undefined && STORAGE_CODES.has(code) ? 'storage_unreachable' : 'internal';
  }
  if (name === 'KeyStoreError' || name === 'NodeKeyStoreError') {
    return code !== undefined && KEYCHAIN_CODES.has(code) ? 'keychain_unavailable' : 'internal';
  }
  if (name === 'AgentFolderLockError') return 'busy';
  if (name === 'HarnessError') {
    return code === 'write_failed' || code === 'unsafe_path' || code === 'changed'
      ? 'ai_app_config_unwritable'
      : 'internal';
  }
  if (code !== undefined && NETWORK_CODES.has(code)) return 'relay_unreachable';
  return 'internal';
}

/** The body of a catch-all failure answer. */
export function failedBody(error?: unknown): { status: 'failed'; reason: FailureReason } {
  return { status: 'failed', reason: error === undefined ? 'internal' : failureReasonOf(error) };
}
