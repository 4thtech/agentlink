// The Messages API client: the only place that knows the routes (plan docs/process/proposals/
// MSG-FILES-IO.md §4; MSG-FILES-IO-c builds the server side). Two read-only GETs under /api/ui/.
// Wiring to the real endpoint is a change in this file only.
//
// I-5: every field is checked and copied into a fresh object (an allowlist), so a field the server
// should not send (a URL, a key) can never reach the page; an entry that fails the check is skipped.
import type { ApiClient, ApiResult } from '../../api/client.js';

export const PAGE_SIZE = 20;
const ID_RE = /^[A-Za-z0-9._:~-]{1,128}$/;
const MAX_TEXT = 100_000;
const MAX_NAME = 1024;
const UNNAMED_FILE = 'Unnamed file';
const MAX_FILES = 50;
const STATUSES: ReadonlySet<string> = new Set(['queued', 'sent', 'not_delivered']);

export type MessageBox = 'in' | 'out';
export type SentStatus = 'queued' | 'sent' | 'not_delivered';

export interface Conversation {
  readonly contactId: string;
  readonly name: string;
  readonly lastAt: number;
  /** Time of the newest inbound message; 0 when there is none. */
  readonly lastInAt: number;
}

export interface MessageFile {
  readonly name: string;
  readonly size: number;
}

export interface MessageItem {
  readonly id: string;
  readonly at: number;
  readonly text: string;
  readonly files: readonly MessageFile[];
  readonly status?: SentStatus;
  readonly receipt: boolean;
  readonly proof: boolean;
  readonly size: number;
}

export interface MessagePage {
  readonly items: readonly MessageItem[];
  readonly next?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isTime = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function parseConversation(raw: unknown): Conversation | undefined {
  if (!isRecord(raw)) return undefined;
  const { contactId, name, lastAt, lastInAt } = raw;
  if (typeof contactId !== 'string' || !ID_RE.test(contactId)) return undefined;
  if (typeof name !== 'string' || name.length === 0 || name.length > 128) return undefined;
  if (lastAt !== null && !isTime(lastAt)) return undefined;
  if (lastInAt !== undefined && lastInAt !== null && !isTime(lastInAt)) return undefined;
  return { contactId, name, lastAt: lastAt ?? 0, lastInAt: lastInAt ?? 0 };
}

function parseFile(raw: unknown): MessageFile | undefined {
  if (!isRecord(raw)) return undefined;
  const { name, size } = raw;
  if (typeof name !== 'string' || name.length > MAX_NAME) return undefined;
  return { name: name === '' ? UNNAMED_FILE : name, size: isTime(size) ? size : 0 };
}

function parseItem(raw: unknown): MessageItem | undefined {
  if (!isRecord(raw)) return undefined;
  const { id, at, text, files, status, receipt, proof, size } = raw;
  if (typeof id !== 'string' || !ID_RE.test(id)) return undefined;
  if (!isTime(at) || !isTime(size)) return undefined;
  if (typeof text !== 'string' || text.length > MAX_TEXT) return undefined;
  if (!Array.isArray(files)) return undefined;
  const parsedFiles: MessageFile[] = [];
  for (const f of (files as unknown[]).slice(0, MAX_FILES)) {
    const file = parseFile(f);
    if (file !== undefined) parsedFiles.push(file);
  }
  if (status !== undefined && (typeof status !== 'string' || !STATUSES.has(status)))
    return undefined;
  const base = {
    id,
    at,
    text,
    files: parsedFiles,
    receipt: receipt === true,
    proof: proof === true,
    size,
  };
  return status === undefined ? base : { ...base, status: status as SentStatus };
}

export function parseConversations(data: unknown): readonly Conversation[] | undefined {
  if (!isRecord(data) || !Array.isArray(data['conversations'])) return undefined;
  const out: Conversation[] = [];
  for (const raw of data['conversations'] as unknown[]) {
    const c = parseConversation(raw);
    if (c !== undefined) out.push(c);
  }
  return out;
}

export function parsePage(data: unknown): MessagePage | undefined {
  if (!isRecord(data) || !Array.isArray(data['items'])) return undefined;
  const next = data['next'];
  if (
    next !== undefined &&
    next !== null &&
    (typeof next !== 'string' || next.length === 0 || next.length > 256)
  ) {
    return undefined;
  }
  const items: MessageItem[] = [];
  for (const raw of data['items'] as unknown[]) {
    const item = parseItem(raw);
    if (item !== undefined) items.push(item);
  }
  return typeof next === 'string' ? { items, next } : { items };
}

export type Problem = 'error' | 'offline' | 'session' | 'not_set_up';
export type Loaded<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: Problem };

function problemOf(result: Exclude<ApiResult<unknown>, { kind: 'ok' }>): Problem {
  switch (result.kind) {
    case 'offline':
      return 'offline';
    case 'session_expired':
    case 'forbidden':
      return 'session';
    case 'error':
      return result.status === 409 ? 'not_set_up' : 'error';
    default:
      return 'error';
  }
}

export interface MessagesApi {
  conversations(): Promise<Loaded<readonly Conversation[]>>;
  messages(contactId: string, box: MessageBox, cursor?: string): Promise<Loaded<MessagePage>>;
}

/** Plain GETs only: nothing here can write, and nothing marks a message read for the AI. */
export function createMessagesApi(client: ApiClient): MessagesApi {
  return {
    async conversations() {
      const result = await client.get<unknown>('/api/ui/messages');
      if (result.kind !== 'ok') return { ok: false, problem: problemOf(result) };
      const value = parseConversations(result.data);
      return value === undefined ? { ok: false, problem: 'error' } : { ok: true, value };
    },
    async messages(contactId, box, cursor) {
      const query = `?box=${box}&limit=${String(PAGE_SIZE)}${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
      const result = await client.get<unknown>(
        `/api/ui/messages/${encodeURIComponent(contactId)}${query}`,
      );
      if (result.kind !== 'ok') return { ok: false, problem: problemOf(result) };
      const value = parsePage(result.data);
      return value === undefined ? { ok: false, problem: 'error' } : { ok: true, value };
    },
  };
}
