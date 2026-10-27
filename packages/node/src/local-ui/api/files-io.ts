// MSG-FILES-IO-d: the Files page's Received and Sent API (08 §1; plan
// docs/process/proposals/MSG-FILES-IO.md §3, §4; 04 §2.5, §4; D-133; I-4, I-5, I-7).
//
// `GET /api/ui/files/received?limit=&cursor=` and `GET /api/ui/files/sent?limit=&cursor=`: one page of
// core's `FilesIoView` (store only) through the read-only client view. Reads: no presence, no store
// write; no file is fetched, opened or hashed here. Not MCP tools (I-4): only the local UI route
// registry lists them.
//
// What leaves the server is an exact allowlist per item. Never a file key, a link (drop or presigned
// URL), a locator, a hash, a sealed value or a path (zero access, 04 §4). "Saved as" is the single
// file name core recorded, sent only on a `saved` item and only when it names no folder. Other
// people's file names are untrusted data (I-5): passed through as text, never interpreted; the page
// shows them as untrusted text. An item outside its allowlist is left out and the rest still shows.
// Errors are fixed codes and never carry an error's text or the input; nothing is logged here (I-7).
import {
  CoreError,
  type PageQuery,
  type ReceivedFileItem,
  type SentFileItem,
} from '@4thtech-io/core';
import type { JsonObject } from '@4thtech-io/crypto';
import type { LocalUiContext, LocalUiReadClient } from '../context.js';
import {
  UI_NOT_SET_UP,
  UI_UNAVAILABLE,
  type LocalUiReadRoute,
  type LocalUiRequest,
  type LocalUiResult,
} from '../route-types.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const LIMIT = /^[1-9][0-9]{0,2}$/;
const MAX_CURSOR = 256;
const QUERY_KEYS: ReadonlySet<string> = new Set(['limit', 'cursor']);
/** `<envelope ID>.<index>`, the index as two digits (core ui-messages.ts). */
const ITEM_ID = /^[A-Za-z0-9_-]{1,64}\.[0-9]{2}$/;
/** sanitizeFileName's limit is 255 UTF-8 bytes; this bound only keeps a broken value out. */
const MAX_FILE_NAME_CHARS = 255;
/** A contact name as the Contacts page sends it (contacts.ts). */
const MAX_CONTACT_NAME_CHARS = 128;
const RECEIVED_STATES: ReadonlySet<string> = new Set(['saved', 'not_saved', 'expired', 'deleted']);
const SENT_STATES: ReadonlySet<string> = new Set(['available', 'expired', 'deleted']);
const SENT_STATUSES: ReadonlySet<string> = new Set(['queued', 'sent', 'not_delivered']);

/** 400: a query parameter is unknown, repeated or malformed; the input is never echoed (08 §1). */
const BAD_REQUEST: LocalUiResult = Object.freeze({
  status: 400,
  body: Object.freeze({ error: 'bad_request' }),
});

/** The page query, or undefined when it is malformed (one value each, limit 1 to 100). */
function pageQuery(query: URLSearchParams): PageQuery | undefined {
  for (const key of query.keys()) if (!QUERY_KEYS.has(key)) return undefined;
  const limits = query.getAll('limit');
  const cursors = query.getAll('cursor');
  if (limits.length > 1 || cursors.length > 1) return undefined;
  let limit = DEFAULT_LIMIT;
  const rawLimit = limits[0];
  if (rawLimit !== undefined) {
    if (!LIMIT.test(rawLimit)) return undefined;
    limit = Number(rawLimit);
    if (limit > MAX_LIMIT) return undefined;
  }
  const cursor = cursors[0];
  if (cursor === undefined) return { limit };
  if (cursor.length === 0 || cursor.length > MAX_CURSOR) return undefined;
  return { limit, cursor };
}

const isTime = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

const isFileName = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_FILE_NAME_CHARS;

/** A single file name: no folder separator, not `.` or `..` (04 §4). */
const isSingleName = (v: unknown): v is string =>
  isFileName(v) && !v.includes('/') && !v.includes('\\') && v !== '.' && v !== '..';

/** The contact's shown name (owner alias or restricted name, 06 §2.1), or undefined. */
function contactName(display: unknown): string | undefined {
  if (typeof display !== 'object' || display === null) return undefined;
  const name: unknown = (display as { name?: unknown }).name;
  return typeof name === 'string' && name.length > 0 && name.length <= MAX_CONTACT_NAME_CHARS
    ? name
    : undefined;
}

/** The fields both lists share, or undefined when one is outside its allowlist. */
function common(item: unknown): { id: string; at: number; name: string; size: number } | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const { id, at, name, size } = item as Record<string, unknown>;
  if (typeof id !== 'string' || !ITEM_ID.test(id)) return undefined;
  if (!isTime(at) || !isTime(size) || !isFileName(name)) return undefined;
  return { id, at, name, size };
}

function receivedView(item: ReceivedFileItem): JsonObject | undefined {
  const base = common(item);
  if (base === undefined) return undefined;
  const from = contactName(item.from);
  const { state, proof, savedName } = item as unknown as Record<string, unknown>;
  if (from === undefined || typeof state !== 'string' || !RECEIVED_STATES.has(state)) {
    return undefined;
  }
  if (typeof proof !== 'boolean') return undefined;
  return {
    id: base.id,
    from,
    at: base.at,
    name: base.name,
    size: base.size,
    state,
    ...(state === 'saved' && isSingleName(savedName) ? { savedName } : {}),
    proof,
  };
}

function sentView(item: SentFileItem): JsonObject | undefined {
  const base = common(item);
  if (base === undefined) return undefined;
  const to = contactName(item.to);
  const { status, receipt, state, expiresAt } = item as unknown as Record<string, unknown>;
  if (to === undefined || typeof status !== 'string' || !SENT_STATUSES.has(status)) {
    return undefined;
  }
  if (typeof state !== 'string' || !SENT_STATES.has(state) || typeof receipt !== 'boolean') {
    return undefined;
  }
  if (expiresAt !== null && !isTime(expiresAt)) return undefined;
  return {
    id: base.id,
    to,
    at: base.at,
    name: base.name,
    size: base.size,
    status,
    receipt,
    state,
    expiresAt,
  };
}

/** One page read and shown through `view`; failures answer fixed codes only. */
function pageRoute<T>(
  path: string,
  read: (
    client: LocalUiReadClient,
    query: PageQuery,
  ) => Promise<{
    readonly items: readonly T[];
    readonly nextCursor?: string;
  }>,
  view: (item: T) => JsonObject | undefined,
): LocalUiReadRoute {
  const handler = async (context: LocalUiContext, request: LocalUiRequest) => {
    const client = context.client;
    if (client === undefined) return UI_NOT_SET_UP;
    const query = pageQuery(request.query);
    if (query === undefined) return BAD_REQUEST;
    try {
      const page = await read(client, query);
      const items: JsonObject[] = [];
      for (const item of page.items) {
        const shown = view(item);
        if (shown !== undefined) items.push(shown);
      }
      const next = page.nextCursor;
      return {
        status: 200,
        body:
          typeof next === 'string' && next.length > 0 && next.length <= MAX_CURSOR
            ? { items, nextCursor: next }
            : { items },
      };
    } catch (error) {
      // Never the error's text: it could name a file, a path or a store detail.
      if (error instanceof CoreError && error.code === 'page_query_invalid') return BAD_REQUEST;
      return UI_UNAVAILABLE;
    }
  };
  return Object.freeze<LocalUiReadRoute>({ method: 'GET', path, presence: false, handler });
}

export const filesIoRoutes: readonly LocalUiReadRoute[] = Object.freeze([
  pageRoute<ReceivedFileItem>(
    '/api/ui/files/received',
    (client, query) => client.filesIo.received(query),
    receivedView,
  ),
  pageRoute<SentFileItem>(
    '/api/ui/files/sent',
    (client, query) => client.filesIo.sent(query),
    sentView,
  ),
]);
