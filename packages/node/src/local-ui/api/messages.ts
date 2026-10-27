// MSG-FILES-IO-c: the Messages page's API (08 §1; 04 §2.5; D-133, D-134; plan
// docs/process/proposals/MSG-FILES-IO.md §4; I-4, I-5, I-7).
//
// Two reads (`presence: false`), through the read-only client view (context.ts `messages`, core's
// MessagesView, MSG-FILES-IO-a):
// - `GET /api/ui/messages`: every contact that is not removed, newest conversation first:
//   `contactId` (the route key, never shown), `name` (as core shows it outside the untrusted block:
//   the owner's alias or the restricted name), `lastAt`, `lastInAt`.
// - `GET /api/ui/messages/:contactId?box=in|out&limit=&cursor=`: one page of that contact's Inbox
//   (`in`) or Sent (`out`), newest first, and `next` when there is more.
//
// No new authority (I-4): GET only, behind the same session, CSRF, Host and fetch-metadata gate as
// every /api/ui/ route (approval-server.ts). Core's view reads the local store only and writes
// nothing; in particular it never sets `read_at`, so reading here never marks a message read for
// the AI. These are not MCP tools.
//
// What leaves (zero access, I-7): an allowlist with an exact key set per item. Never a URL, file
// key, locator, hash, envelope JSON or sealed value; a value outside its allowlist leaves the item
// out (fail closed). Message text and file names are untrusted (I-5): passed through as plain data,
// never interpreted here; the page renders them only as untrusted text. Errors are fixed codes
// (`bad_request`, `not_found`, `unavailable`, and the shared `not_set_up`), never an input echo or
// an error's text. Nothing here logs.
import { CoreError, PAGE_TYPES, type MessageBox, type PageQuery } from '@4thtech-io/core';
import type { JsonObject } from '@4thtech-io/crypto';
import { UI_NOT_SET_UP, type LocalUiReadRoute, type LocalUiResult } from '../route-types.js';

/** A contact's ID: its agent's EVM address, lowercase (04 §2.9). */
const CONTACT = /^0x[0-9a-f]{40}$/;
/** An envelope ID: base64url text (06 §2.2). */
const ENVELOPE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const LIMIT = /^[1-9][0-9]{0,2}$/;
const MAX_CURSOR = 256;
const MAX_NAME_CHARS = 128;
/** sanitizeFileName keeps one visible segment; anything longer is not a name core produced. */
const MAX_FILE_NAME_CHARS = 1024;
const BOXES: ReadonlySet<string> = new Set<MessageBox>(['in', 'out']);
const BOX_QUERY_KEYS: ReadonlySet<string> = new Set(['box', 'limit', 'cursor']);
const SENT_STATUSES: ReadonlySet<string> = new Set(['queued', 'sent', 'not_delivered']);
const TYPES: ReadonlySet<string> = new Set(PAGE_TYPES);

const fixed = (status: number, error: string): LocalUiResult =>
  Object.freeze({ status, body: Object.freeze({ error }) });

/** 400: a query value, the box or the contact is malformed; the input is never echoed. */
const BAD_REQUEST = fixed(400, 'bad_request');
/** 404: no contact this page can show (unknown or removed). */
const NOT_FOUND = fixed(404, 'not_found');
/** 503: the store could not be read just now; never the error's text (it could name a path). */
const UNAVAILABLE = fixed(503, 'unavailable');

const isTime = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isTimeOrNull = (v: unknown): v is number | null => v === null || isTime(v);

/** One conversation as the page sees it, or undefined to leave it out. */
function conversationView(c: unknown): JsonObject | undefined {
  if (typeof c !== 'object' || c === null) return undefined;
  const { contactId, display, lastAt, lastInAt } = c as Record<string, unknown>;
  if (typeof contactId !== 'string' || !CONTACT.test(contactId)) return undefined;
  const name: unknown =
    typeof display === 'object' && display !== null
      ? (display as { name?: unknown }).name
      : undefined;
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_CHARS) {
    return undefined;
  }
  if (!isTimeOrNull(lastAt) || !isTimeOrNull(lastInAt)) return undefined;
  return { contactId, name, lastAt, lastInAt };
}

/** A message's files as the page sees them, or undefined when one is outside the allowlist. */
function filesView(files: unknown): JsonObject[] | undefined {
  if (!Array.isArray(files)) return undefined;
  const out: JsonObject[] = [];
  for (const f of files as unknown[]) {
    if (typeof f !== 'object' || f === null) return undefined;
    const { name, size } = f as Record<string, unknown>;
    if (typeof name !== 'string' || name.length > MAX_FILE_NAME_CHARS) return undefined;
    if (!isTime(size)) return undefined;
    out.push({ name, size });
  }
  return out;
}

/** One message of `box` as the page sees it, or undefined to leave it out. */
function itemView(box: MessageBox, item: unknown): JsonObject | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const { id, at, type, text, files, proof, size } = item as Record<string, unknown>;
  if (typeof id !== 'string' || !ENVELOPE_ID.test(id)) return undefined;
  if (!isTime(at) || !isTime(size)) return undefined;
  if (typeof type !== 'string' || !TYPES.has(type)) return undefined;
  // Untrusted (I-5): the text as core gave it, a plain string; never parsed or shortened here.
  if (typeof text !== 'string' || typeof proof !== 'boolean') return undefined;
  const shownFiles = filesView(files);
  if (shownFiles === undefined) return undefined;
  const base: JsonObject = { id, at, type, text, files: shownFiles, proof, size };
  if (box === 'in') return base;
  const { status, receipt } = item as Record<string, unknown>;
  if (typeof status !== 'string' || !SENT_STATUSES.has(status)) return undefined;
  if (typeof receipt !== 'boolean') return undefined;
  return { ...base, status, receipt };
}

/** The box and page query, or undefined when anything is unknown, repeated or malformed. */
function boxQuery(
  query: URLSearchParams,
): { readonly box: MessageBox; readonly page: PageQuery } | undefined {
  for (const key of query.keys()) if (!BOX_QUERY_KEYS.has(key)) return undefined;
  const boxes = query.getAll('box');
  const limits = query.getAll('limit');
  const cursors = query.getAll('cursor');
  if (boxes.length !== 1 || limits.length > 1 || cursors.length > 1) return undefined;
  const box = boxes[0] as string;
  if (!BOXES.has(box)) return undefined;
  let limit = DEFAULT_LIMIT;
  const rawLimit = limits[0];
  if (rawLimit !== undefined) {
    if (!LIMIT.test(rawLimit)) return undefined;
    limit = Number(rawLimit);
    if (limit > MAX_LIMIT) return undefined;
  }
  const cursor = cursors[0];
  if (cursor === undefined) return { box: box as MessageBox, page: { limit } };
  if (cursor.length === 0 || cursor.length > MAX_CURSOR) return undefined;
  return { box: box as MessageBox, page: { limit, cursor } };
}

const listConversations: LocalUiReadRoute = Object.freeze<LocalUiReadRoute>({
  method: 'GET',
  path: '/api/ui/messages',
  presence: false,
  handler: async (context, request) => {
    if ([...request.query.keys()].length > 0) return BAD_REQUEST;
    const client = context.client;
    if (client === undefined) return UI_NOT_SET_UP;
    try {
      const conversations: JsonObject[] = [];
      for (const c of await client.messages.conversations()) {
        const shown = conversationView(c);
        if (shown !== undefined) conversations.push(shown);
      }
      return { status: 200, body: { conversations } };
    } catch {
      return UNAVAILABLE;
    }
  },
});

const listBox: LocalUiReadRoute = Object.freeze<LocalUiReadRoute>({
  method: 'GET',
  path: '/api/ui/messages/:contactId',
  presence: false,
  handler: async (context, request) => {
    const contactId = request.params['contactId'];
    if (contactId === undefined || !CONTACT.test(contactId)) return BAD_REQUEST;
    const parsed = boxQuery(request.query);
    if (parsed === undefined) return BAD_REQUEST;
    const client = context.client;
    if (client === undefined) return UI_NOT_SET_UP;
    try {
      const page = await client.messages.list(contactId, parsed.box, parsed.page);
      const items: JsonObject[] = [];
      for (const item of page.items) {
        const shown = itemView(parsed.box, item);
        if (shown !== undefined) items.push(shown);
      }
      const next = page.nextCursor;
      return {
        status: 200,
        body:
          typeof next === 'string' && next.length > 0 && next.length <= MAX_CURSOR
            ? { items, next }
            : { items },
      };
    } catch (error) {
      if (error instanceof CoreError) {
        if (error.code === 'contact_not_found') return NOT_FOUND;
        if (error.code === 'page_query_invalid') return BAD_REQUEST;
      }
      return UNAVAILABLE;
    }
  },
});

export const messagesRoutes: readonly LocalUiReadRoute[] = Object.freeze([
  listConversations,
  listBox,
]);
