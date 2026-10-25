// The activity feed of the local UI (M1-11r-a, M1-11r-d): one newest-first, paged list of events,
// merged from the stores that already hold them. No table of its own and no write.
//
// Sources (each row's own time):
// - `approvals` with a `decided_at`: the owner's signed decision (approved, denied, cancelled), or
//   a grant by the owner's signed rules (`approved_by_rules`); a request voided by the system or
//   lapsed undecided is not a decision and is left out (IR-M1-11r-a-1 M-1);
// - `proofs` records, own and received (not replaced; not stored receipts or waiting rows), with
//   the contact of the message they prove and their cost (M1-11r-d);
// - `envelopes` of the user message types (the inbox's PAGE_TYPES; M1-11r-d): received (`ok`),
//   requests from unknown senders (`request`) and our own sent rows. One entry per message: kind
//   `file` when it carries files, else `message`. Never a protocol type, a refused row or a row still
//   being received;
// - `blocked_keys`: an unknown sender the owner blocked, shown by its sender code (04 §2.9, D-72);
// - `contacts` with status `blocked`, at the row's `updated_at` (the store keeps no separate block
//   time, so a later change to a blocked contact moves it);
// - `policies`: the signed rules now in force, at `applied_at` (the store keeps only the current
//   version, so earlier changes are not listed).
//
// Display only: a decision shown here is the row's status cache, which authorises nothing (04
// §2.5.1). Zero access and I-5: an entry carries IDs, times, statuses, codes, sizes and USD amounts,
// and two kinds of display text, each in a form that is safe outside the untrusted block:
// - a contact's name only as ContactBook shows it (06 §2.1): an owner-set alias or the restricted
//   name (restrictName), with its identity label; never the raw declared name;
// - a file's name only as sanitizeFileName leaves it (one safe segment; still text another party
//   may have chosen, so a surface shows it as data, never as an instruction).
// Never a payload or body, a summary, an action, a signed object, a salt, a sender key, a URL, a
// file key or locator, or any other sealed or inbound value.
//
// Cost (12 §2): messages and files are free; a received proof is free (the sender paid); a sent
// proof's cost is its budget ledger entry (07 §3.5): `charged` (settled), `reserved` (held, at most
// that amount), `not_charged` (released), or `unknown` when no entry exists.
import { decodeHex, formatFingerprint, senderCode as senderDigest } from '@4thtech-io/crypto';
import type { ContactDisplayName } from '@4thtech-io/types';
import type { ContactBook } from './contacts.js';
import { open, type CoreContext } from './context.js';
import { CoreError } from './errors.js';
import { sanitizeFileName } from './file-name.js';
import { PAGE_TYPES } from './inbox-page.js';
import {
  candidatesByTimeTx,
  candidatesTx,
  pageLimit,
  pageOf,
  parseCursor,
  type Page,
  type PagePosition,
  type PageQuery,
} from './paging.js';
import { LISTED_PROOF_STATUSES } from './proofs/service.js';
import { senderCodesFor, unknownSenderCodesTx } from './sender-codes.js';
import { SINGLETON_SLOT, type Row } from './store/schema.js';
import type { StoreTx, Where } from './store/store.js';

interface EntryBase {
  /** Stable and unique in the feed: `<source>:<row ID>`. Pass it back only through a cursor. */
  readonly id: string;
  /** Unix seconds. */
  readonly at: number;
}

/**
 * The contact an entry concerns. `display` is how ContactBook shows it outside the untrusted block
 * (06 §2.1): an owner-set alias or the restricted name, with its identity label; render it with
 * renderContactName. Null for a contact that is removed (or gone) at the time of the read.
 */
export interface ActivityContact {
  readonly id: string;
  readonly display: ContactDisplayName | null;
}

/** What an entry cost (12 §2; 07 §3.5 budget ledger). USD amounts in the 04 §2.4.1 spelling. */
export type ActivityCost =
  /** Messages, files and received proofs. */
  | { readonly kind: 'free' }
  /** A sent proof whose charge settled. */
  | { readonly kind: 'charged'; readonly usd: string }
  /** A sent proof still held: at most `usd`, settled when the proof lands. */
  | { readonly kind: 'reserved'; readonly usd: string }
  /** A sent proof whose reservation was released: nothing charged. */
  | { readonly kind: 'not_charged' }
  /** A sent proof with no budget entry. */
  | { readonly kind: 'unknown' };

/** One file of a message. */
export interface ActivityFile {
  /**
   * sanitizeFileName's output: one safe path segment. Another party may have chosen it (I-5): data
   * to show, never an instruction.
   */
  readonly name: string;
  /** Bytes. */
  readonly size: number;
  /** True once the file was removed from storage (after delivery or at expiry). */
  readonly removed: boolean;
}

export type ActivityEntry =
  | (EntryBase & {
      readonly kind: 'approval_decided';
      readonly approvalId: string;
      /**
       * `approved` / `denied` / `cancelled`: the owner's signed decision. `approved_by_rules`: the
       * owner's signed rules granted it without asking (a rules grant, 04 §3.4.2).
       */
      readonly decision: ApprovalDecision;
    })
  | (EntryBase & {
      readonly kind: 'proof';
      readonly recordId: string;
      readonly direction: 'sent' | 'received';
      readonly status: string;
      readonly chainId: number;
      /** The contact of the proved message; null when that message is not stored or has none. */
      readonly contact: ActivityContact | null;
      readonly cost: ActivityCost;
    })
  | (EntryBase & {
      /** `file` when the message carries files, else `message`. ID `envelope:<envelope ID>`. */
      readonly kind: 'message' | 'file';
      readonly envelopeId: string;
      readonly direction: 'sent' | 'received';
      /** The message type (06 §2.2 `MessageBase.type`), one of the inbox's PAGE_TYPES. */
      readonly type: string;
      /**
       * `received`; `request`: from an unknown sender, not a contact (D-72); or a sent message's
       * delivery state.
       */
      readonly status: ActivityMessageStatus;
      /** Null for a request from an unknown sender. */
      readonly contact: ActivityContact | null;
      /** A request's sender code (04 §2.9): tells senders apart, authenticates nothing. */
      readonly senderCode: string | null;
      /** Empty for kind `message`. */
      readonly files: readonly ActivityFile[];
      readonly cost: ActivityCost;
    })
  | (EntryBase & {
      readonly kind: 'sender_blocked';
      /** The blocked sender's code (04 §2.9): tells senders apart, authenticates nothing. */
      readonly senderCode: string;
    })
  | (EntryBase & {
      readonly kind: 'contact_blocked';
      readonly contactId: string;
      readonly contact: ActivityContact;
    })
  | (EntryBase & { readonly kind: 'rules_changed'; readonly version: number });

export type ApprovalDecision = 'approved' | 'approved_by_rules' | 'denied' | 'cancelled';

export type ActivityMessageStatus = 'received' | 'request' | 'queued' | 'sent' | 'not_delivered';

/** What a page item still needs once the store transaction has ended (contact and file names). */
interface Pending {
  readonly contactId: string | null;
  readonly files: readonly Row<'files'>[];
  readonly build: (resolved: Resolved) => ActivityEntry;
}

interface Resolved {
  readonly contact: ActivityContact | null;
  readonly files: readonly ActivityFile[];
}

/** A feed position; `pending` runs inside the transaction, for the page items only. */
type Candidate = PagePosition & { readonly pending: (tx: StoreTx) => Pending };

const plain =
  (build: (resolved: Resolved) => ActivityEntry, contactId: string | null = null) =>
  (): Pending => ({ contactId, files: [], build });

const NOSTR_KEY = /^[0-9a-f]{64}$/;
const BLOCKED = 'sender_blocked:';
const ENVELOPE = 'envelope:';
const DELIVERY_STATES = ['queued', 'sent', 'not_delivered'] as const;
const FREE: ActivityCost = Object.freeze({ kind: 'free' });

/**
 * What a decided approval row shows (display only: the status cache authorises nothing, 04
 * §2.5.1). Undefined for a row that records no decision: a request voided by the system (a newer
 * scope, a revoked contact, a terms conflict) or one that lapsed undecided.
 */
function decisionOf(r: Row<'approvals'>): ApprovalDecision | undefined {
  // A denial is always owner-signed: a signed deny, or a signed cancel of a pending request.
  if (r.status === 'denied') {
    return r.signed_decision !== null || r.signed_cancel !== null ? 'denied' : undefined;
  }
  if (r.status === 'cancelled') return r.signed_cancel !== null ? 'cancelled' : undefined;
  if (r.status === 'pending') return undefined;
  // approved, or void / expired after it was granted (used or lapsed).
  if (r.source === 'policy_grant') return 'approved_by_rules';
  return r.signed_decision !== null ? 'approved' : undefined;
}

/** A sent proof's cost, from its budget ledger entry (07 §3.5; one entry per record). */
function proofCostTx(tx: StoreTx, recordId: string): ActivityCost {
  const entry = tx.select('budget_ledger', { record_id: recordId }, { limit: 1 })[0];
  if (entry === undefined) return { kind: 'unknown' };
  if (entry.state === 'charged' && entry.charged_usd !== null) {
    return { kind: 'charged', usd: entry.charged_usd };
  }
  if (entry.state === 'reserved') return { kind: 'reserved', usd: entry.reserved_usd };
  if (entry.state === 'released') return { kind: 'not_charged' };
  return { kind: 'unknown' };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

export class ActivityService {
  readonly #ctx: CoreContext;
  readonly #contacts: ContactBook;

  constructor(ctx: CoreContext, contacts: ContactBook) {
    this.#ctx = ctx;
    this.#contacts = contacts;
  }

  /** One page of the feed, newest first by (time, id). Store only; writes nothing. */
  async list(query: PageQuery = {}): Promise<Page<ActivityEntry>> {
    const limit = pageLimit(query);
    const cursor = parseCursor(query.cursor);
    const read = await this.#ctx.store.transaction((tx) => {
      const out: Candidate[] = [];
      // `position` orders the feed and makes the cursor; it is always the entry's own `id`, a value
      // the caller already received (paging.ts).
      const add = (at: number, position: string, pending: (t: StoreTx) => Pending): void => {
        out.push({ at, id: position, pending });
      };

      // Three disjoint selections, so a row that is not shown never takes a row's place on a page:
      // (1) denied, cancelled and approved rows; (2) `void` or `expired` rows with an owner-signed
      // decision (an approve later used or lapsed); (3) `void` or `expired` rules grants (used or
      // lapsed). A `void` or `expired` owner request without a decision (voided by the system, or
      // never decided) is not a decision and is left out, as approvals.ts readApproval does.
      const AP = 'approval_decided:';
      const ENDED = { in: ['void', 'expired'] } as const;
      const approvals = (
        [
          { status: { in: ['approved', 'denied', 'cancelled'] } },
          { status: ENDED, signed_decision: { gte: '' } },
          { status: ENDED, source: 'policy_grant' },
        ] satisfies Where<'approvals'>[]
      ).flatMap((where) =>
        candidatesTx(tx, 'approvals', where, 'decided_at', 'approval_id', AP, cursor, limit),
      );
      for (const r of approvals) {
        const at = r.decided_at;
        if (at === null) continue;
        const decision = decisionOf(r);
        if (decision === undefined) continue;
        const id = `${AP}${r.approval_id}`;
        add(
          at,
          id,
          plain(() => ({ kind: 'approval_decided', id, at, approvalId: r.approval_id, decision })),
        );
      }

      const proofs = candidatesTx(
        tx,
        'proofs',
        { status: { in: [...LISTED_PROOF_STATUSES] } },
        'created_at',
        'record_id',
        'proof:',
        cursor,
        limit,
      );
      for (const r of proofs) {
        const id = `proof:${r.record_id}`;
        add(r.created_at, id, (t) => {
          const direction = r.status === 'received' ? 'received' : 'sent';
          // A received proof was paid for by its sender (12 §2).
          const cost = direction === 'received' ? FREE : proofCostTx(t, r.record_id);
          const contactId = t.get('envelopes', { envelope_id: r.envelope_id })?.contact_id ?? null;
          return {
            contactId,
            files: [],
            build: ({ contact }) => ({
              kind: 'proof',
              id,
              at: r.created_at,
              recordId: r.record_id,
              direction,
              status: r.status,
              chainId: r.chain_id,
              contact,
              cost,
            }),
          };
        });
      }

      // Messages: two disjoint selections, received (with requests) and sent. Only the inbox's user
      // message types; a protocol type, a refused row or a row still being received is not activity.
      const types = { in: [...PAGE_TYPES] };
      const envelopes = (
        [
          { direction: 'in', state: { in: ['ok', 'request'] }, type: types },
          { direction: 'out', state: 'ok', type: types, delivery: { in: [...DELIVERY_STATES] } },
        ] satisfies Where<'envelopes'>[]
      ).flatMap((where) =>
        candidatesTx(tx, 'envelopes', where, 'created_at', 'envelope_id', ENVELOPE, cursor, limit),
      );
      for (const r of envelopes) {
        const id = `${ENVELOPE}${r.envelope_id}`;
        add(r.created_at, id, (t) => {
          const files = t.select(
            'files',
            { envelope_id: r.envelope_id },
            { orderBy: [['idx', 'asc']] },
          );
          const request = r.direction === 'in' && r.state === 'request' && r.contact_id === null;
          // A request's code is judged against every unknown sender in the store (04 §2.9).
          const senderCode = request ? (unknownSenderCodesTx(t).get(r.from_key) ?? null) : null;
          const status: ActivityMessageStatus =
            r.direction === 'out' ? (r.delivery ?? 'queued') : request ? 'request' : 'received';
          return {
            contactId: request ? null : r.contact_id,
            files,
            build: (resolved) => ({
              kind: resolved.files.length > 0 ? 'file' : 'message',
              id,
              at: r.created_at,
              envelopeId: r.envelope_id,
              direction: r.direction === 'out' ? 'sent' : 'received',
              type: r.type,
              status,
              contact: resolved.contact,
              senderCode,
              files: resolved.files,
              cost: FREE,
            }),
          };
        });
      }

      // Blocked senders are positioned by their long sender code, the entry's own ID, never by the
      // key (IR-M1-11r-a-2 M-2). The store cannot order by that digest, so rows that share one
      // second are read whole (candidatesByTimeTx); each row is one owner Block.
      const blocked = candidatesByTimeTx(
        tx,
        'blocked_keys',
        'blocked_at',
        'from_key',
        cursor,
        limit,
      );
      const codes = senderCodesFor(blocked.map((r) => r.from_key));
      for (const r of blocked) {
        const code = codes.get(r.from_key);
        if (code === undefined || !NOSTR_KEY.test(r.from_key)) continue;
        const long = formatFingerprint(senderDigest(decodeHex(r.from_key, { length: 32 })), 'long');
        const id = `${BLOCKED}${long}`;
        add(
          r.blocked_at,
          id,
          plain(() => ({ kind: 'sender_blocked', id, at: r.blocked_at, senderCode: code })),
        );
      }

      const contacts = candidatesTx(
        tx,
        'contacts',
        { status: 'blocked' },
        'updated_at',
        'contact_id',
        'contact_blocked:',
        cursor,
        limit,
      );
      for (const r of contacts) {
        const id = `contact_blocked:${r.contact_id}`;
        add(
          r.updated_at,
          id,
          plain(
            ({ contact }) => ({
              kind: 'contact_blocked',
              id,
              at: r.updated_at,
              contactId: r.contact_id,
              contact: contact ?? { id: r.contact_id, display: null },
            }),
            r.contact_id,
          ),
        );
      }

      const policy = tx.get('policies', { slot: SINGLETON_SLOT });
      if (policy !== undefined) {
        const id = `rules_changed:${String(policy.version)}`;
        add(
          policy.applied_at,
          id,
          plain(() => ({
            kind: 'rules_changed',
            id,
            at: policy.applied_at,
            version: policy.version,
          })),
        );
      }

      // Only the page's items read more (their message's contact, files, ledger entry).
      const page = pageOf(out, cursor, limit);
      return { pending: page.items.map((c) => c.pending(tx)), nextCursor: page.nextCursor };
    });

    // Outside the transaction (no await inside one, 07 §3.1): names are opened and restricted.
    const contacts = await this.#contactsOf(read.pending);
    const items: ActivityEntry[] = [];
    for (const p of read.pending) {
      const files: ActivityFile[] = [];
      for (const f of p.files) {
        const name = await open(this.#ctx, 'files', 'name', [f.envelope_id, f.idx], f.name);
        files.push({ name: sanitizeFileName(name), size: f.size, removed: f.deleted_at !== null });
      }
      const contact = p.contactId === null ? null : (contacts.get(p.contactId) ?? null);
      items.push(deepFreeze(p.build({ contact, files })));
    }
    return Object.freeze({
      items: Object.freeze(items),
      ...(read.nextCursor === undefined ? {} : { nextCursor: read.nextCursor }),
    });
  }

  /** The display of every contact a page names, once each; a null display for a removed one. */
  async #contactsOf(pending: readonly Pending[]): Promise<Map<string, ActivityContact>> {
    const out = new Map<string, ActivityContact>();
    for (const { contactId } of pending) {
      if (contactId === null || out.has(contactId)) continue;
      let display: ContactDisplayName | null;
      try {
        display = (await this.#contacts.get(contactId)).display;
      } catch (e) {
        if (!(e instanceof CoreError) || e.code !== 'contact_not_found') throw e;
        display = null;
      }
      out.set(contactId, { id: contactId, display });
    }
    return out;
  }
}
