// The Files page's server answers, checked before anything renders (I-5: values are shown as text
// only; a value of the wrong shape is dropped, never guessed).
export const LIST_PATH = '/api/ui/files';
export const COMMIT_PATH = '/api/ui/files/folders';

/** `version`: the rules version the folder list was read at (the server's `baseVersion`, L-1). */
export const reviewPath = (change: 'add' | 'remove', path: string, version: number): string =>
  `/api/ui/files/review?${new URLSearchParams({ [change]: path, version: String(version) }).toString()}`;

export interface FolderRow {
  /** As the rules write it. */
  readonly path: string;
  /** Its real location when found, or null. */
  readonly resolved: string | null;
}

export interface Review {
  /** Opaque: names the exact change the server prepared. Never shown. */
  readonly review: string;
  readonly change: 'add' | 'remove';
  /** The folder that will be signed: the real one for an add. */
  readonly folder: string;
  readonly typed: string;
  readonly elsewhere: boolean;
  /** Every warning code for this change, in the server's order. */
  readonly warnings: readonly string[];
  /** Seconds. */
  readonly expiresAt: number;
}

const MAX_PATH = 4096;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CODE = /^[a-z_]{1,64}$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isPath = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_PATH;

export interface FolderList {
  readonly folders: readonly FolderRow[];
  /** The rules version this list was read at; null when the rules can't be read. */
  readonly version: number | null;
}

export function parseList(data: unknown): FolderList | undefined {
  if (!isObject(data) || !Array.isArray(data['folders'])) return undefined;
  const v = data['version'];
  const version = typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
  const rows: FolderRow[] = [];
  for (const row of data['folders'] as unknown[]) {
    if (!isObject(row) || !isPath(row['path'])) continue;
    const resolved = row['resolved'];
    rows.push({ path: row['path'], resolved: isPath(resolved) ? resolved : null });
  }
  return { folders: rows, version };
}

export function parseReview(data: unknown): Review | undefined {
  if (!isObject(data)) return undefined;
  const { review, change, folder, typed, elsewhere, warnings, expiresAt } = data;
  if (typeof review !== 'string' || !TOKEN.test(review)) return undefined;
  if (change !== 'add' && change !== 'remove') return undefined;
  if (!isPath(folder) || !isPath(typed) || typeof elsewhere !== 'boolean') return undefined;
  if (!Array.isArray(warnings) || warnings.length > 64) return undefined;
  if (!warnings.every((w): w is string => typeof w === 'string' && CODE.test(w))) return undefined;
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)) return undefined;
  return { review, change, folder, typed, elsewhere, warnings, expiresAt };
}

/** A review the server refused: the fixed reason, and the protected folder it names (D-99). */
export type ReviewProblem =
  | { readonly kind: 'folder'; readonly reason: string; readonly protectedFolder?: string }
  | {
      readonly kind:
        | 'rules_unreadable'
        | 'receipts_question'
        | 'changed'
        | 'stale'
        | 'not_set_up'
        | 'unavailable'
        | 'failed';
    };

export function parseReviewProblem(status: number, data: unknown): ReviewProblem {
  const error = isObject(data) ? data['error'] : undefined;
  if (status === 422 && error === 'folder_refused' && isObject(data)) {
    const reason = typeof data['reason'] === 'string' ? data['reason'] : 'unknown';
    const pf = data['protectedFolder'];
    return isPath(pf)
      ? { kind: 'folder', reason, protectedFolder: pf }
      : { kind: 'folder', reason };
  }
  switch (error) {
    case 'rules_unreadable':
    case 'receipts_question':
    case 'changed':
    case 'stale':
    case 'not_set_up':
    case 'unavailable':
      return { kind: error };
    default:
      return { kind: 'failed' };
  }
}
