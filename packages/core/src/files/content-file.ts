// FILES-AI-1 (D-152; 06 §2.3 "Send by content"; 04 §4 "Written by the AI into the Send folder"):
// the checks and the daily budget of a small text file the AI wrote and passes as content.
//
// - contentFileName: a name with a folder part (`/` or `\`, also behind invisible characters) is
//   FILE_NAME, never shortened to its last segment; otherwise core's sanitizeFileName (one plain
//   segment, no control, format or bidi character, no leading dot, at most 255 UTF-8 bytes) and the
//   Attach allowlist on the sanitised name's last extension (.md, .markdown, .txt, .json; case
//   ignored), else FILE_TYPE.
// - contentFileBytes: the UTF-8 of the content, at most 8 MiB (the in-app Attach cap), no NUL, no
//   lone surrogate; else FILE_TOO_LARGE or FILE_NOT_TEXT. The bytes sent are exactly these bytes.
// - reserveContentBudget: at most 50 files and 64 MiB written by content per ID in any rolling 24 h
//   (the G-7 window rule), checked and reserved in ONE store transaction before the write, so two
//   calls at once can never both pass the last place. A row is a time and a byte count only (no
//   name, hash or contact); it stays counted when the file is later removed. No MCP tool reads or
//   changes the ledger (I-4); it is not policy in 0.5.5.
//
// Pure code apart from the one store transaction; nothing here logs (I-5, I-7).
import { encodeHex, randomBytes } from '@4thtech-io/crypto';
import { hasFolderPart, sanitizeFileName } from '../file-name.js';
import type { Store } from '../store/store.js';

/** The types the AI may send by content (lowercase extensions, no dot): the Attach allowlist. */
export const CONTENT_FILE_EXTENSIONS: readonly string[] = Object.freeze([
  'md',
  'markdown',
  'txt',
  'json',
]);
/** The largest content, in UTF-8 bytes: the in-app Attach cap (D-150 (1)). */
export const CONTENT_FILE_MAX_BYTES = 8 * 1024 * 1024;
/** The longest `name` argument, in UTF-16 code units (the schema's bound, checked again here). */
export const CONTENT_FILE_MAX_NAME_CHARS = 1024;

/** The daily budget (owner decision (d), 14 Nov 2026): fixed in 0.5.5. */
export const CONTENT_FILE_BUDGET = Object.freeze({
  files: 50,
  bytes: 64 * 1024 * 1024,
  windowSeconds: 24 * 60 * 60,
});

/** The fixed refusal codes of a content file (06 §2.3). */
export const FILE_NAME = 'FILE_NAME' as const;
export const FILE_TYPE = 'FILE_TYPE' as const;
export const FILE_NOT_TEXT = 'FILE_NOT_TEXT' as const;
export const FILE_NAME_TAKEN = 'FILE_NAME_TAKEN' as const;
export const FILE_BUDGET = 'FILE_BUDGET' as const;
export const SEND_FOLDER_UNAVAILABLE = 'SEND_FOLDER_UNAVAILABLE' as const;

export type ContentFileCode =
  | typeof FILE_NAME
  | typeof FILE_TYPE
  | typeof FILE_NOT_TEXT
  | 'FILE_TOO_LARGE'
  | typeof FILE_NAME_TAKEN
  | typeof FILE_BUDGET
  | typeof SEND_FOLDER_UNAVAILABLE;

/** The codes that are never kept under a clientRequestId (06 §2.3): the same call works later. */
export const CONTENT_FILE_UNKEPT: ReadonlySet<string> = new Set<string>([
  FILE_NAME,
  FILE_TYPE,
  FILE_NOT_TEXT,
  'FILE_TOO_LARGE',
  FILE_NAME_TAKEN,
  FILE_BUDGET,
  SEND_FOLDER_UNAVAILABLE,
]);

/** The sanitised saved-to-be name, or a fixed refusal. */
export function contentFileName(
  raw: unknown,
):
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly code: ContentFileCode } {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > CONTENT_FILE_MAX_NAME_CHARS) {
    return { ok: false, code: FILE_NAME };
  }
  if (hasFolderPart(raw)) return { ok: false, code: FILE_NAME };
  const name = sanitizeFileName(raw);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { ok: false, code: FILE_TYPE };
  const extension = name.slice(dot + 1).toLowerCase();
  return CONTENT_FILE_EXTENSIONS.includes(extension)
    ? { ok: true, name }
    : { ok: false, code: FILE_TYPE };
}

/** A lone surrogate (in `u` mode a pair is one code point and never matches). */
const LONE_SURROGATE = /[\ud800-\udfff]/u;

/** The UTF-8 bytes of the content, or a fixed refusal. */
export function contentFileBytes(
  content: unknown,
):
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly code: ContentFileCode } {
  if (typeof content !== 'string') return { ok: false, code: FILE_NOT_TEXT };
  // Each UTF-16 code unit is at least one UTF-8 byte: longer is over the cap without encoding.
  if (content.length > CONTENT_FILE_MAX_BYTES) return { ok: false, code: 'FILE_TOO_LARGE' };
  if (LONE_SURROGATE.test(content) || content.includes('\u0000')) {
    return { ok: false, code: FILE_NOT_TEXT };
  }
  const bytes = new TextEncoder().encode(content);
  if (bytes.length > CONTENT_FILE_MAX_BYTES) return { ok: false, code: 'FILE_TOO_LARGE' };
  return { ok: true, bytes };
}

/**
 * The budget check and reservation in one store transaction (see the header). 'over' writes
 * nothing; 'ok' has written one row. A store error propagates (the caller fails closed).
 */
export async function reserveContentBudget(
  store: Store,
  now: number,
  bytes: number,
): Promise<'ok' | 'over'> {
  const entryId = encodeHex(randomBytes(16));
  const since = now - CONTENT_FILE_BUDGET.windowSeconds;
  return store.transaction((tx) => {
    // Rows that left the window no longer count: dropped in the same step.
    tx.delete('content_file_budget', { t: { lte: since } });
    const rows = tx.select('content_file_budget');
    let used = 0;
    for (const row of rows) {
      if (!Number.isSafeInteger(row.bytes) || row.bytes < 0) throw new Error('ledger unreadable');
      used += row.bytes;
    }
    if (rows.length + 1 > CONTENT_FILE_BUDGET.files || used + bytes > CONTENT_FILE_BUDGET.bytes) {
      return 'over' as const;
    }
    tx.insert('content_file_budget', { entry_id: entryId, t: now, bytes });
    return 'ok' as const;
  });
}
