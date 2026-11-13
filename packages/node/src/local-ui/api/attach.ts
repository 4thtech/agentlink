// ATT-APP-ATTACH (08 §1 "Attach a file"; 04 §4; I-4, I-5, I-7; proposed, owner confirms at merge):
// the owner attaches light text files in a conversation and sends them to that person.
//
// `POST /api/ui/attach`, the attach kind (route-types.ts LocalUiAttachRoute): the server's attach
// gate has already checked the session, CSRF, Origin, fetch metadata, the octet-stream type, no
// query, no operation input, no presence header and the body size, and parsed one JSON object.
// This handler takes exactly `{to, text?, files: [{name, data}]}`:
// - `to`: a contact's agent ID (`0x` + 40 lowercase hex);
// - `text`: the owner's note, at most ATTACH_MAX_TEXT_CHARS (may be empty or left out);
// - `files`: 1 to ATTACH_MAX_FILES, each `name` (an allowed type after sanitising: .md,
//   .markdown, .txt, .json) and `data` (standard base64 of at most 8 MiB of valid UTF-8 text
//   without NUL); all files together at most ATTACH_MAX_TOTAL_BYTES.
// Answers are fixed codes: 200 `{status: sent | queued | not_delivered}`; 400 `invalid`, `type`,
// `not_text`; 413 `too_large`; 404 `not_found`; 409 `no_folder` (the page shows Home's Send folder
// banner), `folder_unavailable`, `not_ready`, `storage`, `busy`, `paused`; 403 `policy`; 503
// `unavailable`. Never a path, a file name or an error's text. Nothing here logs.
import type { JsonObject, JsonValue } from '@4thtech-io/crypto';
import {
  ATTACH_MAX_FILES,
  ATTACH_MAX_TOTAL_BYTES,
  attachName,
  attachProblem,
} from '../../send-folder-file.js';
import {
  ATTACH_PATH,
  UI_NOT_SET_UP,
  type LocalUiAttachFile,
  type LocalUiAttachRefusal,
  type LocalUiAttachRoute,
  type LocalUiResult,
} from '../route-types.js';

export { ATTACH_PATH };

/** The longest note sent with attached files. */
export const ATTACH_MAX_TEXT_CHARS = 4000;
/** The largest body the attach gate reads: every file as base64, the note and the JSON around it. */
export const ATTACH_MAX_BODY_BYTES = Math.ceil(ATTACH_MAX_TOTAL_BYTES / 3) * 4 + 64 * 1024;

const CONTACT = /^0x[0-9a-f]{40}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_NAME_CHARS = 1024;
const BODY_KEYS: ReadonlySet<string> = new Set(['to', 'text', 'files']);
const FILE_KEYS: ReadonlySet<string> = new Set(['name', 'data']);

const fixed = (status: number, error: string): LocalUiResult =>
  Object.freeze({ status, body: Object.freeze({ error }) });
const INVALID = fixed(400, 'invalid');

const REFUSAL: Readonly<Record<LocalUiAttachRefusal, LocalUiResult>> = {
  type: fixed(400, 'type'),
  no_folder: fixed(409, 'no_folder'),
  folder_unavailable: fixed(409, 'folder_unavailable'),
  not_found: fixed(404, 'not_found'),
  not_ready: fixed(409, 'not_ready'),
  policy: fixed(403, 'policy'),
  too_large: fixed(413, 'too_large'),
  storage: fixed(409, 'storage'),
  busy: fixed(409, 'busy'),
  paused: fixed(409, 'paused'),
  failed: fixed(503, 'unavailable'),
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Strict standard base64 to bytes; undefined when malformed. */
function base64Bytes(data: unknown): Uint8Array | undefined {
  if (typeof data !== 'string' || data.length % 4 !== 0 || !BASE64.test(data)) return undefined;
  const bytes = new Uint8Array(Buffer.from(data, 'base64'));
  return Buffer.from(bytes).toString('base64') === data ? bytes : undefined;
}

/** The checked request, or the fixed answer that refuses it. */
export function parseAttachBody(
  body: JsonValue,
):
  | { readonly to: string; readonly text: string; readonly files: LocalUiAttachFile[] }
  | LocalUiResult {
  if (!isObject(body)) return INVALID;
  for (const key of Object.keys(body)) if (!BODY_KEYS.has(key)) return INVALID;
  const { to, text, files } = body as Record<string, unknown>;
  if (typeof to !== 'string' || !CONTACT.test(to)) return INVALID;
  if (text !== undefined && (typeof text !== 'string' || text.length > ATTACH_MAX_TEXT_CHARS)) {
    return INVALID;
  }
  if (!Array.isArray(files) || files.length === 0 || files.length > ATTACH_MAX_FILES) {
    return INVALID;
  }
  const out: LocalUiAttachFile[] = [];
  let total = 0;
  for (const f of files as unknown[]) {
    if (!isObject(f)) return INVALID;
    for (const key of Object.keys(f)) if (!FILE_KEYS.has(key)) return INVALID;
    const { name, data } = f;
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_CHARS) {
      return INVALID;
    }
    if (attachName(name) === undefined) return REFUSAL.type;
    const bytes = base64Bytes(data);
    if (bytes === undefined) return INVALID;
    const problem = attachProblem(bytes);
    if (problem === 'too_large') return REFUSAL.too_large;
    if (problem === 'not_text') return fixed(400, 'not_text');
    total += bytes.length;
    if (total > ATTACH_MAX_TOTAL_BYTES) return REFUSAL.too_large;
    out.push({ name, bytes });
  }
  return { to, text: typeof text === 'string' ? text : '', files: out };
}

const isResult = (v: unknown): v is LocalUiResult => isObject(v) && 'status' in v && 'body' in v;

export const attachRoute: LocalUiAttachRoute = Object.freeze<LocalUiAttachRoute>({
  method: 'POST',
  path: ATTACH_PATH,
  presence: 'attach',
  handler: async (_context, body: JsonObject, desk) => {
    if (desk === undefined) return UI_NOT_SET_UP;
    const parsed = parseAttachBody(body);
    if (isResult(parsed)) return parsed;
    const outcome = await desk.send(parsed);
    if (outcome.status === 'refused') return REFUSAL[outcome.reason];
    return { status: 200, body: { status: outcome.status } };
  },
});
