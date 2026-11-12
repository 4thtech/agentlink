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
// - `contacts` with a `name_changed_at` (W4-RENAME-REACHES-CONTACTS, D-141; 08 §1): "{old} is now
//   called {new}", the contact's latest name change from a card-update, at that time; both names
//   under the name rule (restrictName), the old one from `former_name`, the new one the contact's own
//   name (also under an owner alias). It stays after the note was seen;
// - `policies`: the signed rules now in force, at `applied_at` (the store keeps only the current
//   version, so earlier changes are not listed);
// - UX1113 WP-A1 (design-1112 spec §7): `contacts` with a completed pairing (`contact_connected`,
//   at `created_at`, with how: a handshake the contact sent answers your invite, one this agent sent
//   answers theirs), with status `removed` (`contact_removed`) or `revoked` (`contact_revoked`), at
//   `updated_at` like a block; the `identity` row (`id_created`, and `id_removed` at `revoked_at`);
//   the `agent_pause` row (`id_paused`, while paused); and the applied owner actions of
//   `owner_action_nonces` (never pruned) whose op the feed does not already show from another row:
//   `agent.label` (`id_renamed`), `agent.resume` (`id_resumed`), `app.connect` / `app.disconnect`
//   (`app_connected` / `app_disconnected`) and `backup.export` (`backup_saved`). A rename names the
//   label, and an app change the app, only while that nonce's signed action is still the one
//   `local_owner_actions` keeps (the latest per record); otherwise null.
//
// A decided approval also says what it was about (WP-A1, `action`): the type from its stored action's
// tool (and decision or receipt), the other agent's ID as a contact reference, the files of a send
// (sanitizeFileName of the name the owner's AI gave, or of its path; never the path) and the fee the
// rules evaluated. The stored action is the core's own (approvals.ts: built from verified data); it is
// parsed with the strict approval schema, and one that does not pass gives `action: null`. Never
// `args.to`, `args.text`, `args.body`, a note or the summary: text the AI or another party may have
// written (I-5).
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
import {
  decodeHex,
  formatFingerprint,
  parseJson,
  senderCode as senderDigest,
} from '@4thtech-io/crypto';
import {
  AGENT_LABEL_MAX_CODE_POINTS,
  AI_APP_IDS,
  MAX_FILES_PER_PAYLOAD,
  approvalActionSchema,
  type ContactDisplayName,
} from '@4thtech-io/types';
import type { ContactBook } from './contacts.js';
import { open, type CoreContext } from './context.js';
import { CoreError } from './errors.js';
import { sanitizeFileName } from './file-name.js';
import { PAGE_TYPES } from './inbox-page.js';
import { restrictName } from './names.js';
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

/** What a decided approval was about (WP-A1), one per approval tool and decision. */
export type ActivityActionType =
  /** `agentlink_send` with a proof, no file. */
  | 'send_message'
  /** `agentlink_send` with a proof and files. */
  | 'send_file'
  /** `agentlink_notarize`. */
  | 'add_proof'
  | 'accept_invite'
  /** `agentlink_propose_terms`: a firm offer. */
  | 'offer_terms'
  /** `agentlink_respond_to_terms` `accept` / `reject` / `counter`. */
  | 'accept_terms'
  | 'reject_terms'
  | 'counter_terms'
  /** `agentlink_acknowledge` `ACCEPTED` / `REJECTED`. */
  | 'accept_record'
  | 'reject_record'
  /** `agentlink_export_proof_pack` with the content key. */
  | 'share_proof_key';

/** A decided approval's action as the feed shows it (WP-A1). Built only from the stored action. */
export interface ActivityApprovalAction {
  readonly type: ActivityActionType;
  /** The other agent's ID (a contact reference, 04 §2.9); null when the action has none. */
  readonly contactId: string | null;
  /**
   * The files of a send: sanitizeFileName of the name the owner's AI gave (or of its path's last
   * segment), and the size in bytes. Empty for every other type.
   */
  readonly files: readonly { readonly name: string; readonly size: number }[];
  /** The fee in USD (04 §2.4.1 spelling) the rules evaluated; null when the action has none. */
  readonly feeUsd: string | null;
}

/** How a connection was made: the contact accepted your invite, or you accepted theirs. */
export type ActivityConnectedVia = 'your_invite' | 'their_invite';

export type ActivityEntry =
  | (EntryBase & {
      readonly kind: 'approval_decided';
      readonly approvalId: string;
      /**
       * `approved` / `denied` / `cancelled`: the owner's signed decision. `approved_by_rules`: the
       * owner's signed rules granted it without asking (a rules grant, 04 §3.4.2).
       */
      readonly decision: ApprovalDecision;
      /** WP-A1: what it was about; null when the stored action does not pass the schema. */
      readonly action: ActivityApprovalAction | null;
    })
  | (EntryBase & {
      /** WP-A1: a completed pairing, at the contact's creation. Listed whatever the status now. */
      readonly kind: 'contact_connected';
      /** A contact reference only (spec §7): the page resolves the name with its people read. */
      readonly contactId: string;
      /** Null when the handshake is not stored. */
      readonly via: ActivityConnectedVia | null;
    })
  | (EntryBase & {
      /** WP-A1: `removed`, the owner removed the contact; `revoked`, its agent was revoked. */
      readonly kind: 'contact_removed' | 'contact_revoked';
      /** A contact reference only, as for `contact_connected`. */
      readonly contactId: string;
    })
  | (EntryBase & {
      /** WP-A1: this ID's own events. `id_paused` only while it is paused. */
      readonly kind: 'id_created' | 'id_removed' | 'id_paused' | 'id_resumed' | 'backup_saved';
    })
  | (EntryBase & {
      /** WP-A1: the owner renamed this ID (`agent.label`): the owner's own label, or null. */
      readonly kind: 'id_renamed';
      readonly name: string | null;
    })
  | (EntryBase & {
      /** WP-A1: an AI app connected or disconnected: an id of the 06 §7 table, or null. */
      readonly kind: 'app_connected' | 'app_disconnected';
      readonly app: string | null;
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
  | (EntryBase & {
      /** D-141: "{formerName} is now called {newName}"; both restricted (06 §2.1). */
      readonly kind: 'contact_renamed';
      readonly contactId: string;
      readonly contact: ActivityContact;
      readonly formerName: string;
      readonly newName: string;
    })
  | (EntryBase & { readonly kind: 'rules_changed'; readonly version: number });

export type ApprovalDecision = 'approved' | 'approved_by_rules' | 'denied' | 'cancelled';

export type ActivityMessageStatus = 'received' | 'request' | 'queued' | 'sent' | 'not_delivered';

/** What a page item still needs once the store transaction has ended (contact and file names). */
interface Pending {
  readonly contactId: string | null;
  readonly files: readonly Row<'files'>[];
  /** D-141: a rename entry's sealed former and own names and the contact's short fingerprint. */
  readonly renamed?: {
    readonly row: Row<'contacts'>;
    readonly short: string;
  };
  /** WP-A1: an approval entry's sealed stored action. */
  readonly approval?: {
    readonly approvalId: string;
    readonly sealed: Row<'approvals'>['action_json'];
  };
  /** WP-A1: an owner action entry's nonce and the local rows that may hold its signed action. */
  readonly local?: { readonly nonce: string; readonly rows: readonly Row<'local_owner_actions'>[] };
  readonly build: (resolved: Resolved) => ActivityEntry;
}

interface Resolved {
  readonly contact: ActivityContact | null;
  readonly files: readonly ActivityFile[];
  /** D-141: the rename entry's names, opened and restricted outside the transaction. */
  readonly renamed?: { readonly formerName: string; readonly newName: string };
  /** WP-A1: the approval's action, opened and parsed outside the transaction. */
  readonly action?: ActivityApprovalAction | null;
  /** WP-A1: the params of the owner action's signed body, while it is still stored. */
  readonly params?: Readonly<Record<string, unknown>> | null;
}

/** A feed position; `pending` runs inside the transaction, for the page items only. */
type Candidate = PagePosition & { readonly pending: (tx: StoreTx) => Pending };

const plain =
  (build: (resolved: Resolved) => ActivityEntry, contactId: string | null = null) =>
  (): Pending => ({ contactId, files: [], build });

const NOSTR_KEY = /^[0-9a-f]{64}$/;
const OWNER_ACTION = 'owner_action:';
/** WP-A1: the owner action ops the feed lists from `owner_action_nonces`, and their kinds. */
const OWNER_ACTION_KINDS = Object.freeze({
  'agent.label': 'id_renamed',
  'agent.resume': 'id_resumed',
  'app.connect': 'app_connected',
  'app.disconnect': 'app_disconnected',
  'backup.export': 'backup_saved',
} as const);
type ListedOwnerOp = keyof typeof OWNER_ACTION_KINDS;
const LISTED_OWNER_OPS = Object.keys(OWNER_ACTION_KINDS) as ListedOwnerOp[];
const isListedOwnerOp = (op: string): op is ListedOwnerOp => Object.hasOwn(OWNER_ACTION_KINDS, op);
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

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Control, format (bidi and invisible) and line or paragraph separator characters. */
const NOT_PLAIN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const AI_APPS: ReadonlySet<string> = new Set(AI_APP_IDS);
const isAiAppId = (v: unknown): v is string => typeof v === 'string' && AI_APPS.has(v);

/** The owner's ID label when it is short plain text (agent.label: at most 32 code points), else null. */
function plainLabel(label: unknown): string | null {
  if (typeof label !== 'string' || label.length === 0 || NOT_PLAIN.test(label)) return null;
  return Array.from(label).length <= AGENT_LABEL_MAX_CODE_POINTS ? label : null;
}

type ActionFiles = ActivityApprovalAction['files'];

/**
 * The files of a send's `args.files` (send.ts readInput: `{realpath, size, name, mime}` each), with
 * sanitized names and their sizes; [] when there are none, undefined when the list is malformed.
 */
function sendFilesOf(args: Readonly<Record<string, unknown>>): ActionFiles | undefined {
  const files = args.files;
  if (files === undefined || files === null) return [];
  if (!Array.isArray(files) || files.length > MAX_FILES_PER_PAYLOAD) return undefined;
  const out: { name: string; size: number }[] = [];
  for (const f of files as unknown[]) {
    if (!isRecord(f)) return undefined;
    const { size, name, realpath } = f;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return undefined;
    const raw = typeof name === 'string' && name.length > 0 ? name : realpath;
    if (typeof raw !== 'string' || raw.length === 0) return undefined;
    out.push({ name: sanitizeFileName(raw), size });
  }
  return out;
}

/**
 * WP-A1: what a stored approval action was about, from the strict approval schema only (the core
 * built it from verified data). Other fields of `args`, such as `to`, `text` or a note, are never
 * read. Null when the action does not pass.
 */
function approvalActionOf(value: unknown): ActivityApprovalAction | null {
  const parsed = approvalActionSchema.safeParse(value);
  if (!parsed.success) return null;
  const action = parsed.data;
  const of = (
    type: ActivityActionType,
    contactId: string | null,
    feeUsd: string | null,
    files: ActionFiles = [],
  ): ActivityApprovalAction => ({ type, contactId, files, feeUsd });
  switch (action.tool) {
    case 'agentlink_send': {
      const files = sendFilesOf(action.args);
      if (files === undefined) return null;
      const type = files.length > 0 || action.context.file !== null ? 'send_file' : 'send_message';
      return of(type, action.context.counterparty.agentId, action.context.fee.usd, files);
    }
    case 'agentlink_notarize':
      return of('add_proof', action.context.counterparty?.agentId ?? null, action.context.fee.usd);
    case 'agentlink_accept_invite':
      return of('accept_invite', action.context.counterparty.agentId, null);
    case 'agentlink_propose_terms':
      return of(
        'offer_terms',
        action.context.scope.counterparty.agentId,
        action.context.fee?.usd ?? null,
      );
    case 'agentlink_respond_to_terms': {
      const decision = action.args.decision;
      const type =
        decision === 'accept'
          ? 'accept_terms'
          : decision === 'reject'
            ? 'reject_terms'
            : 'counter_terms';
      return of(type, action.context.scope.counterparty.agentId, action.context.fee?.usd ?? null);
    }
    case 'agentlink_acknowledge':
      return of(
        action.context.receipt === 'ACCEPTED' ? 'accept_record' : 'reject_record',
        action.context.counterparty.agentId,
        null,
      );
    case 'agentlink_export_proof_pack':
      return of('share_proof_key', null, null);
    default:
      return null;
  }
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
        add(at, id, () => ({
          contactId: null,
          files: [],
          approval: { approvalId: r.approval_id, sealed: r.action_json },
          build: ({ action }) => ({
            kind: 'approval_decided',
            id,
            at,
            approvalId: r.approval_id,
            decision,
            action: action ?? null,
          }),
        }));
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

      // D-141: the latest name change of each contact (rows without one are never read).
      const renamed = candidatesTx(
        tx,
        'contacts',
        { status: { ne: 'removed' } },
        'name_changed_at',
        'contact_id',
        'contact_renamed:',
        cursor,
        limit,
      );
      for (const r of renamed) {
        const at = r.name_changed_at;
        if (at === null || r.former_name === null) continue;
        const id = `contact_renamed:${r.contact_id}`;
        const short = formatFingerprint(decodeHex(r.owner_fingerprint, { length: 32 }), 'short');
        add(at, id, () => ({
          contactId: r.contact_id,
          files: [],
          renamed: { row: r, short },
          build: ({ contact, renamed: names }) => ({
            kind: 'contact_renamed',
            id,
            at,
            contactId: r.contact_id,
            contact: contact ?? { id: r.contact_id, display: null },
            formerName: names?.formerName ?? '',
            newName: names?.newName ?? '',
          }),
        }));
      }

      // WP-A1: people. A completed pairing (whatever the contact's status now), a removal by the
      // owner and a revoked agent, each at its own row time.
      const connected = candidatesTx(
        tx,
        'contacts',
        { pairing: 'complete' },
        'created_at',
        'contact_id',
        'contact_connected:',
        cursor,
        limit,
      );
      for (const r of connected) {
        const id = `contact_connected:${r.contact_id}`;
        add(r.created_at, id, (t) => {
          // The invitee sends the handshake (04 §3.6.1): a received one answers your invite.
          const handshake =
            r.handshake_envelope_id === null
              ? undefined
              : t.get('envelopes', { envelope_id: r.handshake_envelope_id });
          const via: ActivityConnectedVia | null =
            handshake === undefined
              ? null
              : handshake.direction === 'in'
                ? 'your_invite'
                : 'their_invite';
          return {
            contactId: null,
            files: [],
            build: () => ({
              kind: 'contact_connected',
              id,
              at: r.created_at,
              contactId: r.contact_id,
              via,
            }),
          };
        });
      }
      for (const kind of ['contact_removed', 'contact_revoked'] as const) {
        const status = kind === 'contact_removed' ? 'removed' : 'revoked';
        const rows = candidatesTx(
          tx,
          'contacts',
          { status },
          'updated_at',
          'contact_id',
          `${kind}:`,
          cursor,
          limit,
        );
        for (const r of rows) {
          const id = `${kind}:${r.contact_id}`;
          add(
            r.updated_at,
            id,
            plain(() => ({ kind, id, at: r.updated_at, contactId: r.contact_id })),
          );
        }
      }

      // WP-A1: this ID's own rows (one each).
      const identity = tx.select('identity', {}, { limit: 1 })[0];
      if (identity !== undefined) {
        const created = `id_created:${identity.agent_id}`;
        const createdAt = identity.created_at;
        add(
          createdAt,
          created,
          plain(() => ({ kind: 'id_created', id: created, at: createdAt })),
        );
        const revokedAt = identity.revoked_at;
        if (revokedAt !== null) {
          const removed = `id_removed:${identity.agent_id}`;
          add(
            revokedAt,
            removed,
            plain(() => ({ kind: 'id_removed', id: removed, at: revokedAt })),
          );
        }
      }
      // A pause is listed only while it lasts: the row is deleted on resume, so past pauses are gone.
      const pause = tx.get('agent_pause', { slot: SINGLETON_SLOT });
      if (pause !== undefined) {
        const id = `id_paused:${String(pause.paused_at)}`;
        add(
          pause.paused_at,
          id,
          plain(() => ({ kind: 'id_paused', id, at: pause.paused_at })),
        );
      }

      // WP-A1: applied owner actions the feed does not show from another row.
      const owned = candidatesTx(
        tx,
        'owner_action_nonces',
        { op: { in: LISTED_OWNER_OPS } },
        'applied_at',
        'nonce',
        OWNER_ACTION,
        cursor,
        limit,
      );
      for (const r of owned) {
        const op = r.op;
        if (!isListedOwnerOp(op)) continue;
        const id = `${OWNER_ACTION}${r.nonce}`;
        const at = r.applied_at;
        add(at, id, (t) => {
          const kind = OWNER_ACTION_KINDS[op];
          const local =
            op === 'agent.label' || op === 'app.connect' || op === 'app.disconnect'
              ? { nonce: r.nonce, rows: t.select('local_owner_actions', { op }) }
              : undefined;
          return {
            contactId: null,
            files: [],
            ...(local === undefined ? {} : { local }),
            build: ({ params }): ActivityEntry => {
              if (kind === 'id_renamed') {
                return { kind, id, at, name: plainLabel(params?.label) };
              }
              if (kind === 'app_connected' || kind === 'app_disconnected') {
                const app = params?.app;
                return { kind, id, at, app: isAiAppId(app) ? app : null };
              }
              return { kind, id, at };
            },
          };
        });
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
      const renamed = p.renamed === undefined ? undefined : await this.#renamedNames(p.renamed);
      const action = p.approval === undefined ? undefined : await this.#actionOf(p.approval);
      const params = p.local === undefined ? undefined : await this.#paramsOf(p.local);
      items.push(
        deepFreeze(
          p.build({
            contact,
            files,
            ...(renamed === undefined ? {} : { renamed }),
            ...(action === undefined ? {} : { action }),
            ...(params === undefined ? {} : { params }),
          }),
        ),
      );
    }
    return Object.freeze({
      items: Object.freeze(items),
      ...(read.nextCursor === undefined ? {} : { nextCursor: read.nextCursor }),
    });
  }

  /** WP-A1: an approval's stored action as the feed shows it; null when it does not parse. */
  async #actionOf(
    approval: NonNullable<Pending['approval']>,
  ): Promise<ActivityApprovalAction | null> {
    const key = [approval.approvalId];
    const text = await open(this.#ctx, 'approvals', 'action_json', key, approval.sealed);
    let value: unknown;
    try {
      value = parseJson(text);
    } catch {
      return null;
    }
    return approvalActionOf(value);
  }

  /**
   * WP-A1: the params of the owner action with this nonce, while `local_owner_actions` still keeps
   * its signed action (the latest per record); null otherwise. Display only: the row was verified
   * when it was applied, and nothing here authorises anything.
   */
  async #paramsOf(
    local: NonNullable<Pending['local']>,
  ): Promise<Readonly<Record<string, unknown>> | null> {
    for (const row of local.rows) {
      const key = [row.record];
      const text = await open(
        this.#ctx,
        'local_owner_actions',
        'signed_json',
        key,
        row.signed_json,
      );
      let value: unknown;
      try {
        value = parseJson(text);
      } catch {
        continue;
      }
      const body = isRecord(value) ? value.body : undefined;
      if (!isRecord(body) || body.nonce !== local.nonce) continue;
      return isRecord(body.params) ? body.params : null;
    }
    return null;
  }

  /** D-141: a rename entry's former and own new names, opened and restricted (06 §2.1). */
  async #renamedNames(renamed: NonNullable<Pending['renamed']>): Promise<{
    readonly formerName: string;
    readonly newName: string;
  }> {
    const { row, short } = renamed;
    const key = [row.contact_id];
    const former =
      row.former_name === null
        ? ''
        : await open(this.#ctx, 'contacts', 'former_name', key, row.former_name);
    const own =
      row.declared_name !== null
        ? await open(this.#ctx, 'contacts', 'declared_name', key, row.declared_name)
        : await open(this.#ctx, 'contacts', 'name', key, row.name);
    return { formerName: restrictName(former, short), newName: restrictName(own, short) };
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
