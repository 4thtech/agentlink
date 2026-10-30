// The local app's Messages and Files In/Out reads (MSG-FILES-IO-a; plan
// docs/process/proposals/MSG-FILES-IO.md §3, §4; 06 §2.2, §4; 07 §3, §3.1; 04 §4). What the owner
// sees in the app of what their AI sent and received, decrypted only on this computer.
//
// Read-only (I-4). These views never write to the store: in particular they never set `read_at`,
// so reading in the app never marks a message read for the AI (inbox-page.ts does that for the
// AI's own reads, and is not called here). They are not MCP tools. They read the local store only:
// no relay, drop, chain or file-storage request, so they answer with the network down.
//
// Selection: the inbox page's (inbox-page.ts PAGE_TYPES): envelopes in state `ok` of the user
// message types, to or from a contact that is not removed, outbound ones with a delivery state.
// Never a request from an unknown sender, a refused, held or still-being-received row, or a
// protocol type (`ack`, `proof`, handshakes, card updates).
//
// Sources. Messages: the sealed `envelopes.payload_json` of each row (opened through the store
// cipher; the store key lives in the KeyStore, 07 §3.1). Files: the `files[]` entries of those same
// payloads, because retention deletes a whole `files` row (04 §4, files/retention.ts). A file's row
// is read only to tell its state: present (and not expired) means its link and key are still kept;
// gone means retention removed it, which is `expired` once the payload's `expiresAt` has passed and,
// for a sent file before then, `deleted` (delete on receipt, the only pass that removes a sent row
// early). A received row is deleted at its expiry, so a received file without a row is `expired`.
//
// Zero access and I-5: every item is built from an allowlist. Never a URL, a file key, a locator,
// a hash, `envelope_json`, a salt or any sealed value. Message text and other people's file names are
// untrusted: returned as plain data for display in the untrusted block, never interpreted (a JSON
// body becomes indented JSON text). File names go through sanitizeFileName (one visible segment, no
// control or bidi characters). Contacts appear only as ContactBook shows them outside the untrusted
// block (06 §2.1). I-7: logs carry counts only.
import { encodeUtf8 } from '@4thtech-io/crypto';
import type { ContactDisplayName, Payload } from '@4thtech-io/types';
import type { ContactBook } from './contacts.js';
import { nowOf, type CoreContext } from './context.js';
import { CoreError } from './errors.js';
import { sanitizeFileName } from './file-name.js';
import { SHREDDED_FILE_KEY } from './files/received.js';
import { PAGE_TYPES, openStoredPayload } from './inbox-page.js';
import {
  candidatesTx,
  encodeCursor,
  newestFirst,
  pageLimit,
  pageOf,
  parseCursor,
  type Page,
  type PagePosition,
  type PageQuery,
} from './paging.js';
import type { Row } from './store/schema.js';
import type { StoreTx, Where } from './store/store.js';

/** Which list of one contact: what they sent (`in`) or what this agent sent them (`out`). */
export type MessageBox = 'in' | 'out';

/** The relay delivery state of a sent message (07 §3.2 `envelopes.delivery`). */
export type SentStatus = 'queued' | 'sent' | 'not_delivered';

/** One contact in the Messages list. */
export interface Conversation {
  /** The route key for the contact's lists; never shown. */
  readonly contactId: string;
  /** As ContactBook shows it outside the untrusted block (06 §2.1): render with renderContactName. */
  readonly display: ContactDisplayName;
  /** The newest message either way, unix seconds; null when there is none. */
  readonly lastAt: number | null;
  /** The newest message from the contact, unix seconds; null when there is none. */
  readonly lastInAt: number | null;
}

/** A file a message carries: never a URL, a key or a hash. */
export interface MessageFile {
  /** sanitizeFileName's output. Untrusted (I-5): text another party may have chosen. */
  readonly name: string;
  /** Plaintext bytes as the sender stated them. */
  readonly size: number;
}

/** A message in a contact's Inbox. */
export interface InboxMessage {
  /** The envelope ID. */
  readonly id: string;
  /** The envelope's `createdAt`, unix seconds. */
  readonly at: number;
  /** The message type (06 §2.2), one of the inbox's PAGE_TYPES. */
  readonly type: string;
  /**
   * Untrusted (I-5), plain text for the untrusted block only: the body as written; a JSON body as
   * indented JSON text; for `offer`, `accept` and `reject` the note (empty when there is none).
   */
  readonly text: string;
  readonly files: readonly MessageFile[];
  /** True when a proof of this message is recorded or was received. */
  readonly proof: boolean;
  /** The message's plaintext size in bytes. */
  readonly size: number;
}

/** A message in a contact's Sent list. */
export interface SentMessage extends InboxMessage {
  readonly status: SentStatus;
  /**
   * True once the contact's agent acknowledged receiving it (02 F-23 `ack`, stored here). Store
   * only: an on-chain receipt is not read (no network).
   */
  readonly receipt: boolean;
}

export type MessageItem = InboxMessage | SentMessage;

/**
 * UX2-f1: one message exchanged with a contact, for the activity pulse (b11 §24): who and when,
 * nothing else. Never a body, subject, file name, size or envelope field (zero access, I-5).
 */
export interface ExchangeTime {
  readonly contactId: string;
  /** The envelope's `created_at`, unix seconds. */
  readonly at: number;
}

/** UX2-f1: the exchanges in a window, newest first; `capped` when the scan cap left some out. */
export interface ExchangeTimes {
  readonly times: readonly ExchangeTime[];
  readonly capped: boolean;
}

/** U3-flow: a received message is `received`; a sent one is its delivery state (07 §3). */
export type FlowState = 'received' | 'queued' | 'sent' | 'not_delivered';

/**
 * U3-flow (USABILITY-WAVE-3 §4.1): one message or file exchanged with a contact, for the live
 * connections map: who, which way, a message or a file, its state and when. Nothing else: never a
 * body, subject, name, size, link, key, hash or envelope field or ID (zero access, I-5). The store
 * keeps no upload byte counts, so there is no progress here.
 */
export interface FlowEvent {
  readonly contactId: string;
  readonly direction: MessageBox;
  /** `file` when the envelope has a row in `files` (its envelope ID only is read), else `message`. */
  readonly kind: 'message' | 'file';
  readonly state: FlowState;
  /** The envelope's `created_at`, unix seconds. */
  readonly at: number;
}

/** U3-flow: the flow events in a window, newest first; `capped` when the scan cap left some out. */
export interface FlowEvents {
  readonly events: readonly FlowEvent[];
  readonly capped: boolean;
}

/** A received file's state in this agent's store. */
export type ReceivedFileState = 'saved' | 'not_saved' | 'expired';

/** A sent file's state: its link and key kept, past its expiry, or removed on delivery. */
export type SentFileState = 'available' | 'expired' | 'deleted';

/** One received file (Files, Received). */
export interface ReceivedFileItem {
  /** `<envelope ID>.<index>`, the index as two digits. */
  readonly id: string;
  readonly from: ContactDisplayName;
  readonly at: number;
  /** sanitizeFileName's output. Untrusted (I-5). */
  readonly name: string;
  readonly size: number;
  readonly state: ReceivedFileState;
  /** Only when `saved`: the single file name the AI's fetch placed in the Inbox folder. */
  readonly savedName?: string;
  /** W4-AUTO-SAVE (D-142): only when `saved` by the core's automatic save. */
  readonly savedBy?: 'auto';
  /**
   * W4-AUTO-SAVE (D-142, 08 §1): only when `not_saved`, why it was not saved automatically: a fixed
   * code, never error text. Absent while the automatic save is still to run, or with no reason line.
   */
  readonly reason?: NonNullable<Row<'files'>['auto_reason']> | 'before_auto_save';
  readonly proof: boolean;
}

/** One sent file (Files, Sent). */
export interface SentFileItem {
  /** `<envelope ID>.<index>`, the index as two digits. */
  readonly id: string;
  readonly to: ContactDisplayName;
  readonly at: number;
  /** sanitizeFileName's output. */
  readonly name: string;
  readonly size: number;
  readonly status: SentStatus;
  readonly receipt: boolean;
  readonly state: SentFileState;
  /** The link's expiry, unix seconds; null for a file carried inline. */
  readonly expiresAt: number | null;
}

/**
 * Reads where a fetched file was saved (MSG-FILES-IO-b, `files.saved_name`): the single file name,
 * or null when it was not saved. Never a path.
 */
export type SavedNameReader = (row: Row<'files'>) => Promise<string | null>;

export interface FilesIoViewOptions {
  readonly savedName?: SavedNameReader;
}

const BOXES: readonly MessageBox[] = ['in', 'out'];
const DELIVERY_STATES = ['queued', 'sent', 'not_delivered'] as const;
/** Proof rows that mean "this message has a proof": an own record on-chain, or a contact's record. */
const PROOF_STATUSES = ['recorded', 'announced', 'received'] as const;
/** At most this many stored acks of one contact are read for the receipt flags of one page. */
const MAX_ACKS_SCANNED = 1_000;
/** Envelopes read per store transaction while a files page is filled. */
const FILES_BATCH = 50;
/** At most this many envelopes are opened for one files page; the page then ends with a cursor. */
const FILES_SCAN_CAP = 200;
/**
 * UX2-f1: at most this many envelopes per direction are read for one activity pulse, newest first;
 * the pulse then says it is partial. Bounds the read whatever the store holds.
 */
export const PULSE_SCAN_CAP = 10_000;
/**
 * U3-flow: at most this many envelopes per direction are read for one flow answer, newest first;
 * the answer then says it is capped. GET /api/ui/flow passes on at most 200 in all.
 */
export const FLOW_SCAN_CAP = 200;
const FILE_ID = /^(.{1,64})\.([0-9]{2})$/;
/** MSG-FILES-IO-h: an item ID as the local app sends it (an envelope ID is base64url or hex). */
const SAVED_ITEM_ID = /^([A-Za-z0-9_-]{1,64})\.([0-9]{2})$/;

const invalid = (): CoreError =>
  new CoreError('page_query_invalid', 'The page limit or cursor is not valid.');
const noContact = (): CoreError =>
  new CoreError('contact_not_found', 'That contact was not found.');

/**
 * The selection of one direction (inbox-page.ts categoryWheres), for the given contacts; with
 * `'any'`, for every contact (UX2-f1: the caller then checks the contact itself).
 */
function whereOf(direction: MessageBox, contacts: readonly string[] | 'any'): Where<'envelopes'> {
  const base = {
    direction,
    state: 'ok' as const,
    ...(contacts === 'any' ? {} : { contact_id: { in: [...contacts] } }),
    type: { in: [...PAGE_TYPES] },
  };
  return direction === 'out' ? { ...base, delivery: { in: [...DELIVERY_STATES] } } : base;
}

const visibleTx = (tx: StoreTx): string[] =>
  tx.select('contacts', { status: { ne: 'removed' } }).map((r) => r.contact_id);

function proofSetTx(tx: StoreTx, envelopeIds: readonly string[]): ReadonlySet<string> {
  if (envelopeIds.length === 0) return new Set();
  return new Set(
    tx
      .select('proofs', {
        envelope_id: { in: [...envelopeIds] },
        status: { in: [...PROOF_STATUSES] },
      })
      .map((r) => r.envelope_id),
  );
}

function textOf(payload: Payload): string {
  if (payload.type === 'offer' || payload.type === 'accept' || payload.type === 'reject') {
    return payload.body.note ?? '';
  }
  const body: unknown = payload.body;
  return typeof body === 'string' ? body : JSON.stringify(body, null, 2);
}

const fileId = (envelopeId: string, idx: number): string =>
  `${envelopeId}.${String(idx).padStart(2, '0')}`;

const isSentStatus = (v: unknown): v is SentStatus =>
  (DELIVERY_STATES as readonly unknown[]).includes(v);

/**
 * The envelopes among `envelopeIds` that the contact's agent acknowledged (acks.ts `status`): an
 * `ack` stored as `ok` from that same contact whose `replyTo` and `body.envelopeId` both name it.
 * An ack that cannot be read counts as absent (07 §3.1).
 */
async function ackedOf(
  ctx: CoreContext,
  sent: readonly { readonly envelopeId: string; readonly contactId: string }[],
): Promise<ReadonlySet<string>> {
  const out = new Set<string>();
  if (sent.length === 0) return out;
  const wanted = new Map(sent.map((s) => [s.envelopeId, s.contactId]));
  const contacts = [...new Set(sent.map((s) => s.contactId))];
  const acks = await ctx.store.transaction((tx) =>
    contacts.flatMap((contactId) =>
      tx.select(
        'envelopes',
        { direction: 'in', contact_id: contactId, state: 'ok', type: 'ack' },
        {
          orderBy: [
            ['created_at', 'desc'],
            ['envelope_id', 'asc'],
          ],
          limit: MAX_ACKS_SCANNED,
        },
      ),
    ),
  );
  for (const ack of acks) {
    const opened = await openStoredPayload(ctx, ack);
    if (opened?.payload.type !== 'ack') continue;
    const { body, replyTo } = opened.payload;
    if (typeof body !== 'object' || replyTo === null) continue;
    const named = (body as { kind?: unknown; envelopeId?: unknown }).envelopeId;
    if ((body as { kind?: unknown }).kind !== 'received' || named !== replyTo) continue;
    if (wanted.get(replyTo) === ack.contact_id) out.add(replyTo);
  }
  return out;
}

/** The contact displays of a page, once each; undefined for one that cannot be read now. */
class DisplayCache {
  readonly #contacts: ContactBook;
  readonly #seen = new Map<string, ContactDisplayName | undefined>();

  constructor(contacts: ContactBook) {
    this.#contacts = contacts;
  }

  async get(contactId: string): Promise<ContactDisplayName | undefined> {
    if (!this.#seen.has(contactId)) {
      const display = await this.#contacts.get(contactId).then(
        (v) => v.display,
        () => undefined,
      );
      this.#seen.set(contactId, display);
    }
    return this.#seen.get(contactId);
  }
}

/** Messages: the contact list, and one contact's Inbox or Sent. Store only; writes nothing. */
export class MessagesView {
  readonly #ctx: CoreContext;
  readonly #contacts: ContactBook;
  readonly #pulseScanCap: number;

  /**
   * @param options.pulseScanCap test seam: a smaller scan cap for `pulseTimes` (a positive whole
   *   number, never above PULSE_SCAN_CAP). The client always uses PULSE_SCAN_CAP.
   */
  constructor(
    ctx: CoreContext,
    contacts: ContactBook,
    options: { readonly pulseScanCap?: number } = {},
  ) {
    this.#ctx = ctx;
    this.#contacts = contacts;
    const cap = options.pulseScanCap ?? PULSE_SCAN_CAP;
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > PULSE_SCAN_CAP) {
      throw new RangeError('pulseScanCap must be a whole number from 1 to PULSE_SCAN_CAP');
    }
    this.#pulseScanCap = cap;
  }

  /** Every contact that is not removed, newest conversation first (none last). */
  async conversations(): Promise<readonly Conversation[]> {
    const views = await this.#contacts.list();
    const newest = (tx: StoreTx, direction: MessageBox, contactId: string): number | null =>
      tx.select('envelopes', whereOf(direction, [contactId]), {
        orderBy: [['created_at', 'desc']],
        limit: 1,
      })[0]?.created_at ?? null;
    const times = await this.#ctx.store.transaction((tx) =>
      views.map((v) => ({ lastIn: newest(tx, 'in', v.id), lastOut: newest(tx, 'out', v.id) })),
    );
    const out: Conversation[] = views.map((view, i) => {
      const { lastIn, lastOut } = times[i] as { lastIn: number | null; lastOut: number | null };
      const lastAt =
        lastIn === null ? lastOut : lastOut === null ? lastIn : Math.max(lastIn, lastOut);
      return Object.freeze({ contactId: view.id, display: view.display, lastAt, lastInAt: lastIn });
    });
    out.sort(
      (x, y) =>
        (y.lastAt ?? -1) - (x.lastAt ?? -1) ||
        (x.contactId < y.contactId ? -1 : x.contactId > y.contactId ? 1 : 0),
    );
    return Object.freeze(out);
  }

  /**
   * UX2-f1 (b11 §24): who exchanged messages with this agent, and when, for `since <= created_at <=
   * until` (unix seconds), newest first. The selection is the inbox page's (whereOf), both
   * directions, contacts that are not removed only. One store transaction, two bounded selects
   * (PULSE_SCAN_CAP per direction), never one read per conversation. Reads `contact_id` and
   * `created_at` only, columns the store keeps in clear (07 §3): no payload is opened.
   * @throws CoreError `page_query_invalid` when the window is not two whole times in order.
   */
  async pulseTimes(since: number, until: number): Promise<ExchangeTimes> {
    const whole = (v: unknown): v is number =>
      typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
    if (!whole(since) || !whole(until) || since > until) throw invalid();
    const read = await this.#ctx.store.transaction((tx) => {
      const visible = new Set(visibleTx(tx));
      let capped = false;
      const times: ExchangeTime[] = [];
      for (const direction of BOXES) {
        // No contact list in the query (it could be 10 000 IDs); visibility is checked below.
        const rows = tx.select(
          'envelopes',
          { ...whereOf(direction, 'any'), created_at: { gte: since, lte: until } },
          { orderBy: [['created_at', 'desc']], limit: this.#pulseScanCap + 1 },
        );
        if (rows.length > this.#pulseScanCap) capped = true;
        for (const row of rows.slice(0, this.#pulseScanCap)) {
          const contactId = row.contact_id;
          if (contactId === null || !visible.has(contactId)) continue;
          times.push(Object.freeze({ contactId, at: row.created_at }));
        }
      }
      return { times, capped };
    });
    read.times.sort((x, y) => y.at - x.at);
    return Object.freeze({ times: Object.freeze(read.times), capped: read.capped });
  }

  /**
   * U3-flow (USABILITY-WAVE-3 §4.1, GET /api/ui/flow): the messages and files exchanged with this
   * agent for `since <= created_at <= until` (unix seconds), newest first (then by contact,
   * direction). The selection is the pulse's (whereOf), both directions, contacts that are not
   * removed only. One store transaction, two bounded selects (FLOW_SCAN_CAP per direction) and one
   * `files` select by those envelope IDs; reads `contact_id`, `direction`, `delivery` and
   * `created_at` of `envelopes` and `envelope_id` of `files`, columns the store keeps in clear (07
   * §3): no payload or sealed value is opened, and nothing of a `files` row but its envelope ID is
   * kept. Envelope IDs never leave this method.
   * @throws CoreError `page_query_invalid` when the window is not two whole times in order.
   */
  async flowEvents(since: number, until: number): Promise<FlowEvents> {
    const whole = (v: unknown): v is number =>
      typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
    if (!whole(since) || !whole(until) || since > until) throw invalid();
    const read = await this.#ctx.store.transaction((tx) => {
      const visible = new Set(visibleTx(tx));
      let capped = false;
      const picked: { id: string; event: Omit<FlowEvent, 'kind'> }[] = [];
      for (const direction of BOXES) {
        const rows = tx.select(
          'envelopes',
          { ...whereOf(direction, 'any'), created_at: { gte: since, lte: until } },
          { orderBy: [['created_at', 'desc']], limit: FLOW_SCAN_CAP + 1 },
        );
        if (rows.length > FLOW_SCAN_CAP) capped = true;
        for (const row of rows.slice(0, FLOW_SCAN_CAP)) {
          const contactId = row.contact_id;
          if (contactId === null || !visible.has(contactId)) continue;
          const state: FlowState | undefined =
            direction === 'in' ? 'received' : isSentStatus(row.delivery) ? row.delivery : undefined;
          if (state === undefined) continue;
          picked.push({
            id: row.envelope_id,
            event: { contactId, direction, state, at: row.created_at },
          });
        }
      }
      const withFiles =
        picked.length === 0
          ? new Set<string>()
          : new Set(
              tx
                .select('files', { envelope_id: { in: picked.map((p) => p.id) } })
                .map((r) => r.envelope_id),
            );
      const events: FlowEvent[] = picked.map(({ id, event }) =>
        Object.freeze({
          contactId: event.contactId,
          direction: event.direction,
          kind: withFiles.has(id) ? ('file' as const) : ('message' as const),
          state: event.state,
          at: event.at,
        }),
      );
      return { events, capped };
    });
    read.events.sort(
      (x, y) =>
        y.at - x.at ||
        (x.contactId < y.contactId ? -1 : x.contactId > y.contactId ? 1 : 0) ||
        (x.direction < y.direction ? -1 : x.direction > y.direction ? 1 : 0),
    );
    return Object.freeze({ events: Object.freeze(read.events), capped: read.capped });
  }

  /**
   * One page of a contact's Inbox (`in`) or Sent (`out`), newest first by (time, envelope ID).
   * @throws CoreError `contact_not_found` for a contact that is unknown or removed;
   *   `page_query_invalid` for a bad box, limit or cursor.
   */
  async list(
    contactId: string,
    box: MessageBox,
    query: PageQuery = {},
  ): Promise<Page<MessageItem>> {
    if (!BOXES.includes(box)) throw invalid();
    const limit = pageLimit(query);
    const cursor = parseCursor(query.cursor);
    if (typeof contactId !== 'string' || contactId.length === 0) throw noContact();
    const read = await this.#ctx.store.transaction((tx) => {
      const contact = tx.get('contacts', { contact_id: contactId });
      if (contact === undefined || contact.status === 'removed') return undefined;
      const rows = candidatesTx(
        tx,
        'envelopes',
        whereOf(box, [contactId]),
        'created_at',
        'envelope_id',
        '',
        cursor,
        limit,
      );
      const page = pageOf(
        rows.map((row) => ({ at: row.created_at, id: row.envelope_id, row })),
        cursor,
        limit,
      );
      const proofs = proofSetTx(
        tx,
        page.items.map((p) => p.id),
      );
      return { rows: page.items.map((p) => p.row), nextCursor: page.nextCursor, proofs };
    });
    if (read === undefined) throw noContact();

    const acked =
      box === 'out'
        ? await ackedOf(
            this.#ctx,
            read.rows.map((r) => ({ envelopeId: r.envelope_id, contactId })),
          )
        : new Set<string>();
    const items: MessageItem[] = [];
    let unreadable = 0;
    for (const row of read.rows) {
      const opened = await openStoredPayload(this.#ctx, row);
      if (opened === undefined) {
        unreadable += 1;
        continue;
      }
      const base: InboxMessage = {
        id: row.envelope_id,
        at: row.created_at,
        type: row.type,
        text: textOf(opened.payload),
        files: Object.freeze(
          opened.payload.files.map((f) =>
            Object.freeze({ name: sanitizeFileName(f.name), size: f.size }),
          ),
        ),
        proof: read.proofs.has(row.envelope_id),
        size: encodeUtf8(opened.text).length,
      };
      if (box === 'out') {
        if (!isSentStatus(row.delivery)) {
          unreadable += 1;
          continue;
        }
        items.push(
          Object.freeze({ ...base, status: row.delivery, receipt: acked.has(row.envelope_id) }),
        );
      } else {
        items.push(Object.freeze(base));
      }
    }
    if (unreadable > 0) this.#ctx.log.warn('message rows unreadable', { rows: unreadable });
    return Object.freeze({
      items: Object.freeze(items),
      ...(read.nextCursor === undefined ? {} : { nextCursor: read.nextCursor }),
    });
  }
}

interface FileCandidate {
  readonly row: Row<'envelopes'>;
  /** Only files below this index (the rest of the cursor's message); undefined for all. */
  readonly below?: number;
}

interface FileBatch {
  readonly candidates: readonly FileCandidate[];
  /** The `files` rows of the batch, by item ID. */
  readonly fileRows: ReadonlyMap<string, Row<'files'>>;
  readonly proofs: ReadonlySet<string>;
}

/** Files In/Out: every received or sent file, newest message first. Store only; writes nothing. */
export class FilesIoView {
  readonly #ctx: CoreContext;
  readonly #contacts: ContactBook;
  readonly #savedName: SavedNameReader | undefined;

  constructor(ctx: CoreContext, contacts: ContactBook, options: FilesIoViewOptions = {}) {
    this.#ctx = ctx;
    this.#contacts = contacts;
    this.#savedName = options.savedName;
  }

  /**
   * One page of received files, newest first by (message time, item ID). A page may hold fewer than
   * `limit` items while `nextCursor` is present (at most FILES_SCAN_CAP messages are opened per page).
   * @throws CoreError `page_query_invalid` for a bad limit or cursor.
   */
  async received(query: PageQuery = {}): Promise<Page<ReceivedFileItem>> {
    const now = nowOf(this.#ctx);
    const displays = new DisplayCache(this.#contacts);
    return this.#page('in', query, async ({ row, entry, idx, fileRow, proof }) => {
      if (row.contact_id === null) return undefined;
      const from = await displays.get(row.contact_id);
      if (from === undefined) return undefined;
      let state: ReceivedFileState;
      let savedName: string | null = null;
      let reason: ReceivedFileItem['reason'];
      let savedBy: 'auto' | undefined;
      if (fileRow === undefined) {
        // Retention deleted the row, and with it the key; or a payload stored before the rows
        // existed, which still carries its key until its expiry.
        state =
          entry.fileKey === SHREDDED_FILE_KEY || now >= entry.expiresAt ? 'expired' : 'not_saved';
        if (state === 'not_saved') reason = 'before_auto_save';
      } else {
        savedName = await this.#saved(fileRow);
        state = savedName !== null ? 'saved' : now >= fileRow.expires_at ? 'expired' : 'not_saved';
        if (state === 'saved' && fileRow.auto_save === 'saved') savedBy = 'auto';
        if (state === 'not_saved') {
          // D-142: a row stored before automatic saving has no auto_save value.
          reason =
            fileRow.auto_save === null ? 'before_auto_save' : (fileRow.auto_reason ?? undefined);
        }
      }
      return {
        id: fileId(row.envelope_id, idx),
        from,
        at: row.created_at,
        name: sanitizeFileName(entry.name),
        size: entry.size,
        state,
        ...(savedName === null ? {} : { savedName }),
        ...(savedBy === undefined ? {} : { savedBy }),
        ...(reason === undefined ? {} : { reason }),
        proof,
      };
    });
  }

  /**
   * W4-FILES-SAVE (SEC-L1): true when `id` names a received file of this agent that Save can act on
   * (an inbound `ok` message from a contact the list shows, with its receiver row kept). The local
   * app checks this before it asks for the owner's presence. Never logs.
   */
  async isReceived(id: string): Promise<boolean> {
    if (typeof id !== 'string') return false;
    const m = SAVED_ITEM_ID.exec(id);
    if (m === null) return false;
    const envelopeId = m[1] as string;
    const idx = Number(m[2]);
    const row = await this.#ctx.store.transaction((tx) => {
      const scope = visibleTx(tx);
      if (scope.length === 0) return undefined;
      const message = tx.select(
        'envelopes',
        { ...whereOf('in', scope), envelope_id: envelopeId },
        { limit: 1 },
      )[0];
      if (message === undefined) return undefined;
      return tx.select('files', { envelope_id: envelopeId, idx }, { limit: 1 })[0];
    });
    return row !== undefined && row.deleted_at === null;
  }

  /**
   * One page of sent files, newest first by (message time, item ID). Paging as `received`.
   * @throws CoreError `page_query_invalid` for a bad limit or cursor.
   */
  async sent(query: PageQuery = {}): Promise<Page<SentFileItem>> {
    const now = nowOf(this.#ctx);
    const displays = new DisplayCache(this.#contacts);
    /** Item ID → the contact and envelope it went to, for the receipt flags below. */
    const sentTo = new Map<string, { readonly envelopeId: string; readonly contactId: string }>();
    const page = await this.#page('out', query, async ({ row, entry, idx, fileRow }) => {
      if (row.contact_id === null || !isSentStatus(row.delivery)) return undefined;
      const to = await displays.get(row.contact_id);
      if (to === undefined) return undefined;
      let state: SentFileState;
      if (fileRow === undefined) {
        // Retention removed the row: at expiry, or earlier on the contact's delivery receipt.
        state = now >= entry.expiresAt ? 'expired' : 'deleted';
      } else if (fileRow.deleted_at !== null) {
        state = 'deleted';
      } else {
        state = now >= fileRow.expires_at ? 'expired' : 'available';
      }
      const id = fileId(row.envelope_id, idx);
      sentTo.set(id, { envelopeId: row.envelope_id, contactId: row.contact_id });
      const item: SentFileItem = {
        id,
        to,
        at: row.created_at,
        name: sanitizeFileName(entry.name),
        size: entry.size,
        status: row.delivery,
        receipt: false,
        state,
        expiresAt: entry.inline !== null ? null : (fileRow?.expires_at ?? entry.expiresAt),
      };
      return item;
    });
    const acked = await ackedOf(
      this.#ctx,
      page.items.flatMap((i) => sentTo.get(i.id) ?? []),
    );
    return Object.freeze({
      items: Object.freeze(
        page.items.map((item) =>
          Object.freeze({
            ...item,
            receipt: acked.has(sentTo.get(item.id)?.envelopeId ?? ''),
          }),
        ),
      ),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
  }

  /**
   * MSG-FILES-IO-h (Show in Finder, D-134): the saved name of one received file, by its item ID
   * (`<envelope ID>.<index>`, index as two digits) only. The same selection as `received`: an inbound
   * message in state `ok` from a contact that is not removed. Null for a malformed ID, an unknown or
   * outbound item, a file not saved yet, or a saved name that does not open or is not the single
   * clean name fetchFile chose (fail closed: no path is guessed). Never log the result (I-7).
   */
  async savedName(id: string): Promise<string | null> {
    if (typeof id !== 'string') return null;
    const m = SAVED_ITEM_ID.exec(id);
    if (m === null || this.#savedName === undefined) return null;
    const envelopeId = m[1] as string;
    const idx = Number(m[2]);
    const row = await this.#ctx.store.transaction((tx) => {
      const scope = visibleTx(tx);
      if (scope.length === 0) return undefined;
      const message = tx.select(
        'envelopes',
        { ...whereOf('in', scope), envelope_id: envelopeId },
        { limit: 1 },
      )[0];
      if (message === undefined) return undefined;
      return tx.select('files', { envelope_id: envelopeId, idx }, { limit: 1 })[0];
    });
    if (row === undefined || row.deleted_at !== null) return null;
    try {
      const name = await this.#savedName(row);
      return typeof name === 'string' && name.length > 0 && sanitizeFileName(name) === name
        ? name
        : null;
    } catch {
      return null;
    }
  }

  async #saved(row: Row<'files'>): Promise<string | null> {
    if (this.#savedName === undefined) return null;
    try {
      const name = await this.#savedName(row);
      return typeof name === 'string' && name.length > 0 ? sanitizeFileName(name) : null;
    } catch {
      // A saved name that cannot be read shows as not saved (fail closed: no path is guessed).
      return null;
    }
  }

  /**
   * Fills one page: messages newest first (time, envelope ID), each message's files from the last
   * index down, so item IDs fall in newest-first order. The cursor names the last item returned.
   */
  async #page<T extends { readonly id: string; readonly at: number }>(
    direction: MessageBox,
    query: PageQuery,
    build: (file: {
      readonly row: Row<'envelopes'>;
      readonly entry: Payload['files'][number];
      readonly idx: number;
      readonly fileRow: Row<'files'> | undefined;
      readonly proof: boolean;
    }) => Promise<T | undefined>,
  ): Promise<Page<T>> {
    const limit = pageLimit(query);
    const parsed = parseCursor(query.cursor);
    let position: PagePosition | undefined;
    let below: number | undefined;
    if (parsed !== undefined) {
      const m = FILE_ID.exec(parsed.id);
      if (m === null) throw invalid();
      position = { at: parsed.at, id: m[1] as string };
      below = Number(m[2]);
    }
    const items: T[] = [];
    let scanned = 0;
    let exhausted = false;
    let unreadable = 0;
    let first = true;
    while (items.length <= limit && scanned < FILES_SCAN_CAP) {
      const from = position;
      const rest = first ? below : undefined;
      const batch = await this.#ctx.store.transaction((tx) => batchTx(tx, direction, from, rest));
      first = false;
      if (batch.candidates.length === 0) {
        exhausted = true;
        break;
      }
      for (const { row, below: cap } of batch.candidates) {
        if (items.length > limit || scanned >= FILES_SCAN_CAP) break;
        scanned += 1;
        position = { at: row.created_at, id: row.envelope_id };
        const opened = await openStoredPayload(this.#ctx, row);
        if (opened === undefined) {
          unreadable += 1;
          continue;
        }
        const files = opened.payload.files;
        for (let idx = Math.min(files.length, cap ?? files.length) - 1; idx >= 0; idx -= 1) {
          const entry = files[idx];
          if (entry === undefined) continue;
          const item = await build({
            row,
            entry,
            idx,
            fileRow: batch.fileRows.get(fileId(row.envelope_id, idx)),
            proof: batch.proofs.has(row.envelope_id),
          });
          if (item === undefined) {
            unreadable += 1;
            continue;
          }
          items.push(item);
          if (items.length > limit) break;
        }
      }
    }
    if (unreadable > 0) this.#ctx.log.warn('file rows unreadable', { rows: unreadable });
    let nextCursor: string | undefined;
    if (items.length > limit) {
      const last = items[limit - 1] as T;
      nextCursor = encodeCursor({ at: last.at, id: last.id });
      items.length = limit;
    } else if (!exhausted && position !== undefined) {
      // The scan cap ended the page: every file of the messages opened so far is on it.
      nextCursor = encodeCursor({ at: position.at, id: fileId(position.id, 0) });
    }
    return Object.freeze({
      items: Object.freeze(items.map((i) => Object.freeze(i))),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    });
  }
}

/**
 * Inside one transaction: the rest of the cursor's message (files below `below`), then the next
 * FILES_BATCH messages after `position`, newest first, with their `files` rows and proof flags.
 */
function batchTx(
  tx: StoreTx,
  direction: MessageBox,
  position: PagePosition | undefined,
  below: number | undefined,
): FileBatch {
  const scope = visibleTx(tx);
  if (scope.length === 0) return { candidates: [], fileRows: new Map(), proofs: new Set() };
  const where = whereOf(direction, scope);
  const candidates: FileCandidate[] = [];
  if (position !== undefined && below !== undefined && below > 0) {
    const row = tx.select('envelopes', { ...where, envelope_id: position.id }, { limit: 1 })[0];
    if (row !== undefined && row.created_at === position.at) candidates.push({ row, below });
  }
  const rows = candidatesTx(
    tx,
    'envelopes',
    where,
    'created_at',
    'envelope_id',
    '',
    position,
    FILES_BATCH - 1,
  )
    .map((row) => ({ at: row.created_at, id: row.envelope_id, row }))
    .filter((c) => position === undefined || newestFirst(position, c) < 0)
    .sort(newestFirst);
  candidates.push(...rows.map((c) => ({ row: c.row })));
  const ids = candidates.map((c) => c.row.envelope_id);
  const fileRows = new Map<string, Row<'files'>>();
  if (ids.length > 0) {
    for (const f of tx.select('files', { envelope_id: { in: ids } })) {
      fileRows.set(fileId(f.envelope_id, f.idx), f);
    }
  }
  return { candidates, fileRows, proofs: proofSetTx(tx, ids) };
}
