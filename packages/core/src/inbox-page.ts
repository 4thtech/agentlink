// The inbox page read (M1-7h-c; 06 §2.2 `InboundMessage`/`OutboundMessage`, "Order and paging",
// "Read state"; §2.1 accepted requests, D-72; 07 §3, §3.2). The core half of `agentlink_inbox`:
// the CLI wraps every untrusted value it returns (06 §4) and formats our dates.
//
// What is returned: envelopes in state `ok` of the user message types (PAGE_TYPES) from a contact
// that is not removed; `request` rows the owner accepted (D-72: no sender name, only the 04 §2.9
// sender code); and, with `includeSent`, our own `ok` outbound rows to such a contact. Never a
// queued request, a `refused` or `received` row, a held envelope or a protocol type.
//
// Order: (createdAt, envelopeId bytes). envelopeId is base64url text whose ASCII order is not its
// byte order, so the store selects by time and the final order is computed here on decoded bytes.
// A page is the newest `limit` matching items, ended early before the item that would take the sum
// of `sizeOf` above `maxBytes` (at least one item), listed oldest first.
//
// Read marks and atomicity. A Store transaction is synchronous (store.ts) and payloads are sealed,
// so a page is built in three steps: (A) one transaction selects the candidate rows; (B) their
// payloads are opened outside it; (C) one transaction checks that every row on the page is unchanged
// (same hash, state, contact, and the read mark seen in A) and sets `read_at` on the unread inbound
// ones. If any check fails, C writes nothing and the read starts again from A, so the page that is
// returned is exactly the page whose marks were committed, and two concurrent reads never both
// return one item as unread. After MAX_ATTEMPTS lost races the read fails with `inbox_busy`.
//
// I-5: sender-chosen values (bodies, terms, notes, file names and types, the declared name) are
// returned only as data under fields the CLI wraps. File URLs, file keys, inline bytes and the
// ciphertext hash are never copied into an item (zero access). I-7: logs carry counts only.
import {
  ENVELOPE_ID_LENGTH,
  decodeBase64url,
  decodeHex,
  formatFingerprint,
  parseJson,
  senderCode,
  verifyTermsHash,
} from '@agentlink/crypto';
import { payloadSchema, type Payload } from '@agentlink/types';
import type { ContactBook, ContactView } from './contacts.js';
import { nowOf, open, type CoreContext } from './context.js';
import { CoreError } from './errors.js';
import type { InboxSender } from './inbox.js';
import type { Row } from './store/schema.js';
import type { StoreTx, Where } from './store/store.js';

/** The types an inbox page returns (06 §2.2 `MessageBase.type`). `proof` only fills an item (M1b). */
export const PAGE_TYPES: readonly string[] = Object.freeze([
  'text',
  'note',
  'request',
  'delivery',
  'offer',
  'accept',
  'reject',
  'file',
]);

/** 06 §2.2: `limit` is 1 to 100. */
export const INBOX_PAGE_MAX_LIMIT = 100;

/** How many times a read starts again after another read or writer changed its page. */
const MAX_ATTEMPTS = 4;

const DELIVERY_STATES = ['queued', 'sent', 'not_delivered'] as const;

/** One inbox page query (06 §2.2 "Order and paging", "Read state"). */
export interface InboxPageQuery {
  /** Only this contact's items (the thread view). Accepted requests are never a contact's. */
  readonly contactId?: string;
  /** Only items with `createdAt` at or after this, unix seconds. */
  readonly since?: number;
  /** Only items strictly older than this envelope, by (`createdAt`, envelopeId bytes). */
  readonly before?: string;
  /** 1 to 100. */
  readonly limit: number;
  /** False: unread inbound items only. */
  readonly includeRead: boolean;
  /** False: no outbound items. */
  readonly includeSent: boolean;
  /**
   * The bytes an item takes in the caller's text result. The core takes the newest matching items
   * first and stops before the item that would take the sum above `maxBytes`, keeping at least one.
   */
  readonly sizeOf: (item: InboxPageItem) => number;
  readonly maxBytes: number;
}

/** A file as an inbox item shows it (06 §2.2 `FileInfo`): never a URL, a file key or inline bytes. */
export interface InboxPageFile {
  /** Position in the payload's `files[]`. */
  readonly index: number;
  /** Plaintext bytes as the sender stated them (checked at fetch). */
  readonly size: number;
  readonly plaintextSha256: string;
  /** Inline content, the configured encrypted drop origin, or other storage. */
  readonly delivery: 'inline' | 'drop' | 'own';
  /** Unix seconds, or null for inline. */
  readonly expiresAt: number | null;
  /** Untrusted (I-5): the sender's file name, for the untrusted block only. */
  readonly name: string;
  /** Untrusted (I-5): the sender's MIME type, for the untrusted block only. */
  readonly mime: string;
}

/** The terms reference of an `offer`, `accept` or `reject` whose `termsHash` the core recomputed. */
export interface InboxTermsRef {
  readonly termsId: string;
  readonly version: number;
  /** Bare 64 lower-case hex, equal to sha256(JCS(terms)) (04 §3.4). */
  readonly termsHash: string;
  /** Unix seconds. */
  readonly validUntil: number;
}

interface InboxPageItemBase {
  readonly envelopeId: string;
  readonly thread: string;
  readonly type: string;
  /** The envelope's `createdAt`, unix seconds (sender-chosen within 04 §3.1.1's window). */
  readonly createdAt: number;
  readonly replyTo: string | null;
  readonly files: readonly InboxPageFile[];
  /**
   * Untrusted (I-5): a Talk item's body (a string or a JSON object), or null for `offer`, `accept`
   * and `reject`, whose content is `terms` and `note`.
   */
  readonly body: string | Readonly<Record<string, unknown>> | null;
  /** Untrusted: the terms of an `offer`, `accept` or `reject`, as received. */
  readonly terms?: Readonly<Record<string, unknown>>;
  /** Untrusted: the free note of an `offer` or `reject`. */
  readonly note?: string | null;
  /** Ours: present only when the body's `termsHash` is the hash of its `terms`. */
  readonly termsRef?: InboxTermsRef;
}

/** An inbound item: from a contact, or an accepted request (`from: null`, D-72). */
export interface InboundPageItem extends InboxPageItemBase {
  readonly direction: 'in';
  /** The contact under the 06 §2.1 rule; null only for an accepted request (D-72). */
  readonly from: InboxSender | null;
  /** Only when `from` is null: the 04 §2.9 sender code, short form (`2B9E·04D1`). */
  readonly senderCode?: string;
  /** True if it had been returned before this call (06 §2.2 "Read state"). */
  readonly read: boolean;
}

/** An outbound item (06 §2.2 `OutboundMessage`). Outbound items have no read state. */
export interface OutboundPageItem extends InboxPageItemBase {
  readonly direction: 'out';
  readonly to: InboxSender;
  readonly delivery: 'queued' | 'sent' | 'not_delivered';
}

export type InboxPageItem = InboundPageItem | OutboundPageItem;

export type InboxPage =
  | {
      readonly status: 'ok';
      /** Oldest first. Inbound items here were marked read in the transaction that built the page. */
      readonly items: readonly InboxPageItem[];
      /** The requests queue, a count only (06 §2.1). */
      readonly requests: number;
    }
  /** `before` names no item this query can see: nothing was read or marked. */
  | { readonly status: 'before_not_found' };

type Category = 'in' | 'request' | 'out';

interface Candidate {
  readonly row: Row<'envelopes'>;
  readonly category: Category;
  readonly idBytes: Uint8Array;
}

interface Built {
  readonly candidate: Candidate;
  readonly item: InboxPageItem;
}

const invalid = (): CoreError =>
  new CoreError('inbox_query_invalid', 'The inbox query is not valid.');

const isUint = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

function checkQuery(q: InboxPageQuery): void {
  if (typeof q !== 'object' || q === null) throw invalid();
  if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > INBOX_PAGE_MAX_LIMIT) throw invalid();
  if (q.since !== undefined && !isUint(q.since)) throw invalid();
  if (q.before !== undefined && typeof q.before !== 'string') throw invalid();
  if (q.contactId !== undefined && typeof q.contactId !== 'string') throw invalid();
  if (typeof q.includeRead !== 'boolean' || typeof q.includeSent !== 'boolean') throw invalid();
  if (typeof q.sizeOf !== 'function' || !isUint(q.maxBytes) || q.maxBytes < 1) throw invalid();
}

/** The 16 bytes of a canonical envelope ID, or undefined. */
function idBytesOf(id: string): Uint8Array | undefined {
  if (id.length === 0 || id.length > 32) return undefined;
  try {
    return decodeBase64url(id, { length: ENVELOPE_ID_LENGTH });
  } catch {
    return undefined;
  }
}

function compareBytes(x: Uint8Array, y: Uint8Array): number {
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    const d = (x[i] as number) - (y[i] as number);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** Ascending (createdAt, envelopeId bytes). */
const byPosition = (x: Candidate, y: Candidate): number =>
  x.row.created_at - y.row.created_at || compareBytes(x.idBytes, y.idBytes);

// An https origin in the canonical form `downloadUrlSchema` admits (lower-case host, optional port,
// no user info). The core has no URL parser (it runs in Node, Workers and browsers alike), and every
// file URL has already passed that schema, so its origin is this prefix.
const ORIGIN = /^https:\/\/[a-z0-9.-]+(?::[1-9][0-9]{0,4})?(?=$|[/?#])/;

/** The https origins of the configured encrypted drop (06 §2.2 `FileInfo.delivery`). */
export function dropOriginsOf(origins: readonly string[] | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  for (const origin of origins ?? []) {
    // Anything else never matches, so such files show as `own`.
    const text = typeof origin === 'string' ? origin.replace(/\/$/, '') : '';
    if (ORIGIN.exec(text)?.[0] === text) out.add(text);
  }
  return out;
}

const senderOf = (view: ContactView): InboxSender => ({
  contactId: view.id,
  display: view.display,
  ownerFingerprint: view.ownerFingerprint.short,
  safetyCodeChecked: view.safetyCodeChecked,
  declaredName: view.name.value,
});

/** The where-clauses of the three categories, before the read and time filters. */
function categoryWheres(
  q: InboxPageQuery,
  scope: readonly string[],
): readonly (readonly [Category, Where<'envelopes'>])[] {
  const types = { in: [...PAGE_TYPES] };
  const out: (readonly [Category, Where<'envelopes'>])[] = [];
  if (scope.length > 0) {
    out.push(['in', { direction: 'in', state: 'ok', contact_id: { in: [...scope] }, type: types }]);
  }
  if (q.contactId === undefined) {
    out.push([
      'request',
      {
        direction: 'in',
        state: 'request',
        contact_id: null,
        request_accepted_at: { gte: 0 },
        type: types,
      },
    ]);
  }
  if (q.includeSent && scope.length > 0) {
    out.push([
      'out',
      {
        direction: 'out',
        state: 'ok',
        contact_id: { in: [...scope] },
        type: types,
        delivery: { in: [...DELIVERY_STATES] },
      },
    ]);
  }
  return out;
}

/** Does `row` fall in `category` (the same rules as categoryWheres, for the `before` row)? */
function inCategory(row: Row<'envelopes'>, category: Category, scope: readonly string[]): boolean {
  if (!PAGE_TYPES.includes(row.type)) return false;
  switch (category) {
    case 'in':
      return (
        row.direction === 'in' &&
        row.state === 'ok' &&
        row.contact_id !== null &&
        scope.includes(row.contact_id)
      );
    case 'request':
      return (
        row.direction === 'in' &&
        row.state === 'request' &&
        row.contact_id === null &&
        row.request_accepted_at !== null
      );
    case 'out':
      return (
        row.direction === 'out' &&
        row.state === 'ok' &&
        row.contact_id !== null &&
        scope.includes(row.contact_id) &&
        row.delivery !== null
      );
    default:
      return false;
  }
}

type Selection =
  | { readonly status: 'ok'; readonly candidates: readonly Candidate[]; readonly requests: number }
  | { readonly status: 'before_not_found' };

/**
 * Step A, inside one transaction: the newest `limit` candidates of every category (with every row
 * that ties the oldest one's time, so the byte order below can pick among them), merged and cut to
 * the newest `limit` overall, newest first.
 */
function selectTx(tx: StoreTx, q: InboxPageQuery): Selection {
  const visible = tx
    .select('contacts', { status: { ne: 'removed' } })
    .map((contact) => contact.contact_id);
  const scope =
    q.contactId === undefined ? visible : visible.includes(q.contactId) ? [q.contactId] : [];
  const categories = categoryWheres(q, scope);

  let before: Candidate | undefined;
  if (q.before !== undefined) {
    const bytes = idBytesOf(q.before);
    const row = bytes === undefined ? undefined : tx.get('envelopes', { envelope_id: q.before });
    const category = row && categories.find(([c]) => inCategory(row, c, scope))?.[0];
    if (row === undefined || bytes === undefined || category === undefined) {
      return { status: 'before_not_found' };
    }
    before = { row, category, idBytes: bytes };
  }

  const found = new Map<string, Candidate>();
  const add = (category: Category, rows: readonly Row<'envelopes'>[]): void => {
    for (const row of rows) {
      const idBytes = idBytesOf(row.envelope_id);
      if (idBytes === undefined || found.has(row.envelope_id)) continue;
      const candidate: Candidate = { row, category, idBytes };
      if (before !== undefined && byPosition(candidate, before) >= 0) continue;
      found.set(row.envelope_id, candidate);
    }
  };
  for (const [category, base] of categories) {
    const unreadOnly = category !== 'out' && !q.includeRead;
    const where: Where<'envelopes'> = { ...base, ...(unreadOnly ? { read_at: null } : {}) };
    const since = q.since === undefined ? {} : { gte: q.since };
    if (before !== undefined) {
      // The rows that tie the cursor's time: the byte comparison in `add` keeps the older ones.
      const t = before.row.created_at;
      if (q.since === undefined || t >= q.since) {
        add(category, tx.select('envelopes', { ...where, created_at: t }));
      }
    }
    const range = before === undefined ? since : { ...since, lt: before.row.created_at };
    const newest = tx.select(
      'envelopes',
      { ...where, created_at: range },
      { orderBy: [['created_at', 'desc']], limit: q.limit },
    );
    add(category, newest);
    const last = newest[newest.length - 1];
    if (newest.length === q.limit && last !== undefined) {
      add(category, tx.select('envelopes', { ...where, created_at: last.created_at }));
    }
  }
  const candidates = [...found.values()].sort((x, y) => byPosition(y, x)).slice(0, q.limit);
  const requests = tx.count('envelopes', { direction: 'in', contact_id: null, state: 'request' });
  return { status: 'ok', candidates, requests };
}

/** The item fields every direction shares, from an opened payload. */
function baseOf(row: Row<'envelopes'>, payload: Payload, drop: ReadonlySet<string>) {
  const files: InboxPageFile[] = payload.files.map((f, index) => ({
    index,
    size: f.size,
    plaintextSha256: f.plaintextSha256,
    delivery: f.inline !== null ? 'inline' : isDrop(f.url, drop) ? 'drop' : 'own',
    expiresAt: f.inline !== null ? null : f.expiresAt,
    name: f.name,
    mime: f.mime,
  }));
  const base = {
    envelopeId: row.envelope_id,
    thread: row.thread_id,
    type: row.type,
    createdAt: row.created_at,
    replyTo: payload.replyTo,
    files,
  };
  if (payload.type === 'offer' || payload.type === 'accept' || payload.type === 'reject') {
    const { terms, termsHash, note } = payload.body;
    const ref: InboxTermsRef | undefined = verifyTermsHash(terms, termsHash)
      ? {
          termsId: terms.termsId,
          version: terms.version,
          termsHash,
          validUntil: terms.validUntil,
        }
      : undefined;
    return {
      ...base,
      body: null,
      terms: terms as unknown as Readonly<Record<string, unknown>>,
      ...(payload.type === 'accept' ? {} : { note }),
      ...(ref === undefined ? {} : { termsRef: ref }),
    };
  }
  const body = payload.body as string | Readonly<Record<string, unknown>>;
  return { ...base, body };
}

function isDrop(url: string | null, drop: ReadonlySet<string>): boolean {
  if (url === null || drop.size === 0) return false;
  const origin = ORIGIN.exec(url)?.[0];
  return origin !== undefined && drop.has(origin);
}

/** Step C, inside one transaction: every row unchanged since step A, then the read marks. */
function commitTx(tx: StoreTx, built: readonly Built[], now: number): number | undefined {
  for (const { candidate } of built) {
    const seen = candidate.row;
    const row = tx.get('envelopes', { envelope_id: seen.envelope_id });
    if (
      row === undefined ||
      row.envelope_hash !== seen.envelope_hash ||
      row.state !== seen.state ||
      row.direction !== seen.direction ||
      row.contact_id !== seen.contact_id ||
      (candidate.category === 'request' && row.request_accepted_at === null) ||
      (candidate.category !== 'out' && row.read_at !== seen.read_at)
    ) {
      return undefined;
    }
  }
  let marked = 0;
  for (const { candidate } of built) {
    const seen = candidate.row;
    if (candidate.category === 'out' || seen.read_at !== null) continue;
    marked += tx.update(
      'envelopes',
      { envelope_id: seen.envelope_id, envelope_hash: seen.envelope_hash, read_at: null },
      { read_at: now },
    );
  }
  return marked;
}

export interface InboxPageDeps {
  readonly ctx: CoreContext;
  readonly contacts: ContactBook;
  readonly dropOrigins: ReadonlySet<string>;
}

/** One inbox page with its read marks (06 §2.2). See the file header for the steps. */
export async function readInboxPage(deps: InboxPageDeps, q: InboxPageQuery): Promise<InboxPage> {
  checkQuery(q);
  const { ctx, contacts, dropOrigins } = deps;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const now = nowOf(ctx);
    const selection = await ctx.store.transaction((tx) => selectTx(tx, q));
    if (selection.status !== 'ok') return selection;

    // Step B: open payloads outside any transaction, newest first, until the page is full.
    const senders = new Map<string, InboxSender | undefined>();
    const sender = async (contactId: string): Promise<InboxSender | undefined> => {
      if (!senders.has(contactId)) {
        senders.set(contactId, await contacts.get(contactId).then(senderOf, () => undefined));
      }
      return senders.get(contactId);
    };
    const built: Built[] = [];
    let bytes = 0;
    let unreadable = 0;
    for (const candidate of selection.candidates) {
      const item = await buildItem(ctx, candidate, dropOrigins, sender);
      if (item === undefined) {
        unreadable += 1;
        continue;
      }
      const size = q.sizeOf(item);
      if (!Number.isFinite(size) || size < 0) throw invalid();
      if (built.length > 0 && bytes + size > q.maxBytes) break;
      bytes += size;
      built.push({ candidate, item });
    }
    if (unreadable > 0) ctx.log.warn('inbox rows unreadable', { rows: unreadable });

    // Step C: the page and its read marks, or nothing if the page changed meanwhile.
    const marked = await ctx.store.transaction((tx) => commitTx(tx, built, now));
    if (marked === undefined) {
      ctx.log.debug('inbox page changed while read; reading again', { attempt });
      continue;
    }
    ctx.log.info('inbox page read', { items: built.length, marked });
    return {
      status: 'ok',
      items: built.map((b) => b.item).reverse(),
      requests: selection.requests,
    };
  }
  throw new CoreError('inbox_busy', 'The inbox changed while it was read. Try again.');
}

/** One candidate as an item, or undefined when its payload or its contact cannot be read. */
async function buildItem(
  ctx: CoreContext,
  candidate: Candidate,
  drop: ReadonlySet<string>,
  sender: (contactId: string) => Promise<InboxSender | undefined>,
): Promise<InboxPageItem | undefined> {
  const { row, category } = candidate;
  if (row.payload_json === null) return undefined;
  let payload: Payload;
  try {
    const text = await open(ctx, 'envelopes', 'payload_json', [row.envelope_id], row.payload_json);
    const parsed = payloadSchema.safeParse(parseJson(text));
    if (!parsed.success || parsed.data.type !== row.type) return undefined;
    payload = parsed.data;
  } catch {
    return undefined;
  }
  const base = baseOf(row, payload, drop);
  if (category === 'request') {
    let code: string;
    try {
      code = formatFingerprint(senderCode(decodeHex(row.from_key, { length: 32 })), 'short');
    } catch {
      return undefined;
    }
    return { ...base, direction: 'in', from: null, senderCode: code, read: row.read_at !== null };
  }
  if (row.contact_id === null) return undefined;
  const who = await sender(row.contact_id);
  if (who === undefined) return undefined;
  if (category === 'out') {
    if (row.delivery === null) return undefined;
    return { ...base, direction: 'out', to: who, delivery: row.delivery };
  }
  return { ...base, direction: 'in', from: who, read: row.read_at !== null };
}
