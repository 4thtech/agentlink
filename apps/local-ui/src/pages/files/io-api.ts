// The Files lists' calls (MSG-FILES-IO-f; plan docs/process/proposals/MSG-FILES-IO.md §4). Built
// against the node API of card d with a mocked server in tests; this is the one small module that
// knows the routes, so a change to the contract touches only this file.
//
// GET `/api/ui/files/received` and `/api/ui/files/sent`, behind the same cookie and CSRF header as
// every page call. MSG-FILES-IO-h: the one write, `POST /api/ui/files/received/reveal` (Show in
// Finder), carries only the item ID; the server finds the file itself (files-api.ts `reveal`). An answer is read through an allowlist: only the named fields are
// taken, each checked for type and length, so a stray URL, key or path in an answer is never kept
// or shown (zero access). File names and contact names are untrusted text (I-5): they are cleaned
// of control and bidi characters here and shown as plain text only.
import type { Answer } from './files-api.js';

export const RECEIVED_PATH = '/api/ui/files/received';
export const SENT_PATH = '/api/ui/files/sent';
/** MSG-FILES-IO-h: Show in Finder (D-134). The body is `{"id":"<item ID>"}` and nothing else. */
export const REVEAL_PATH = '/api/ui/files/received/reveal';
export const PAGE_SIZE = 20;

export type ReceivedState = 'saved' | 'not_saved' | 'expired' | 'deleted';
export type SentState = 'available' | 'expired' | 'deleted';
export type SentStatus = 'queued' | 'sent' | 'not_delivered';

export interface ReceivedItem {
  readonly id: string;
  readonly from: string;
  readonly at: number;
  readonly name: string;
  readonly size: number;
  readonly state: ReceivedState;
  readonly savedName: string | null;
  readonly proof: boolean;
}

export interface SentItem {
  readonly id: string;
  readonly to: string;
  readonly at: number;
  readonly name: string;
  readonly size: number;
  readonly status: SentStatus;
  readonly receipt: boolean;
  readonly state: SentState;
  readonly expiresAt: number | null;
}

export interface Feed<T> {
  readonly items: readonly T[];
  readonly next: string | null;
}

/** Control, bidi and invisible-format characters: never shown (a name may use them to disguise itself). */
const HIDDEN = new RegExp(
  // eslint-disable-next-line no-control-regex
  '[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff\\ufff9-\\ufffb]',
  'g',
);

/**
 * Text another party chose, made safe to show: plain, no hidden characters, bounded to `max`
 * characters (code points, so a surrogate pair is never split).
 */
export function plain(value: string, max = 255): string {
  const chars = [...value.replace(HIDDEN, '').trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
const oneOf = <T extends string>(v: unknown, set: readonly T[]): T | undefined =>
  typeof v === 'string' ? set.find((s) => s === v) : undefined;

const RECEIVED_STATES = ['saved', 'not_saved', 'expired', 'deleted'] as const;
const SENT_STATES = ['available', 'expired', 'deleted'] as const;
const STATUSES = ['queued', 'sent', 'not_delivered'] as const;

function receivedItem(raw: unknown): ReceivedItem | undefined {
  if (!isObject(raw)) return undefined;
  const id = str(raw['id'], 80);
  const from = str(raw['from'], 400);
  const name = str(raw['name'], 1024);
  const at = num(raw['at']);
  const size = num(raw['size']);
  const state = oneOf(raw['state'], RECEIVED_STATES);
  const proof = raw['proof'];
  if (
    id === undefined ||
    from === undefined ||
    name === undefined ||
    at === undefined ||
    size === undefined ||
    state === undefined ||
    typeof proof !== 'boolean'
  ) {
    return undefined;
  }
  const saved = state === 'saved' ? str(raw['savedName'], 1024) : undefined;
  return {
    id,
    from: plain(from, 100),
    at,
    name: plain(name),
    size,
    state,
    savedName: saved === undefined ? null : plain(saved),
    proof,
  };
}

function sentItem(raw: unknown): SentItem | undefined {
  if (!isObject(raw)) return undefined;
  const id = str(raw['id'], 80);
  const to = str(raw['to'], 400);
  const name = str(raw['name'], 1024);
  const at = num(raw['at']);
  const size = num(raw['size']);
  const status = oneOf(raw['status'], STATUSES);
  const state = oneOf(raw['state'], SENT_STATES);
  const receipt = raw['receipt'];
  if (
    id === undefined ||
    to === undefined ||
    name === undefined ||
    at === undefined ||
    size === undefined ||
    status === undefined ||
    state === undefined ||
    typeof receipt !== 'boolean'
  ) {
    return undefined;
  }
  return {
    id,
    to: plain(to, 100),
    at,
    name: plain(name),
    size,
    status,
    receipt,
    state,
    expiresAt: num(raw['expiresAt']) ?? null,
  };
}

/**
 * One page of the node API (`{ items, nextCursor? }`, MSG-FILES-IO-d). An item outside its
 * allowlist is left out and the rest still shows; a page that is not that shape is undefined.
 */
function feedOf<T>(json: unknown, one: (raw: unknown) => T | undefined): Feed<T> | undefined {
  if (!isObject(json) || !Array.isArray(json['items'])) return undefined;
  const items: T[] = [];
  for (const raw of json['items'] as unknown[]) {
    const item = one(raw);
    if (item !== undefined) items.push(item);
  }
  const next = json['nextCursor'];
  if (next !== undefined && (typeof next !== 'string' || next.length > 256)) return undefined;
  return { items, next: typeof next === 'string' && next.length > 0 ? next : null };
}

export const parseReceived = (json: unknown): Feed<ReceivedItem> | undefined =>
  feedOf(json, receivedItem);
export const parseSent = (json: unknown): Feed<SentItem> | undefined => feedOf(json, sentItem);

/**
 * W4-WIRE-3 (W4-AUTO-SAVE, 08 §1): the Inbox folder of the received page's `autoSave` block, home
 * shown as `~` (the owner's own setting, never inbound text); undefined when absent or not a plain
 * short path.
 */
export function parseInboxFolder(json: unknown): string | undefined {
  const block = isObject(json) ? json['autoSave'] : undefined;
  const folder = isObject(block) ? str(block['folder'], 512) : undefined;
  if (folder === undefined) return undefined;
  const shown = plain(folder, 512);
  return shown === '' ? undefined : shown;
}

export function listPath(base: string, cursor: string | null): string {
  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor !== null) query.set('cursor', cursor);
  return `${base}?${query.toString()}`;
}

export type LoadResult<T> =
  | { readonly kind: 'ok'; readonly feed: Feed<T> }
  | { readonly kind: 'not_set_up' }
  | { readonly kind: 'offline' }
  | { readonly kind: 'error' };

export type Getter = (path: string) => Promise<Answer>;

export async function loadFeed<T>(
  get: Getter,
  base: string,
  cursor: string | null,
  parse: (json: unknown) => Feed<T> | undefined,
): Promise<LoadResult<T>> {
  const answer = await get(listPath(base, cursor));
  if (answer.kind === 'offline') return { kind: 'offline' };
  if (answer.status === 409) return { kind: 'not_set_up' };
  const feed = answer.status === 200 ? parse(answer.json) : undefined;
  return feed === undefined ? { kind: 'error' } : { kind: 'ok', feed };
}
