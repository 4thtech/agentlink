// The activity feed of the local UI (M1-11r-a): one newest-first, paged list of the events that are
// not messages, merged from the stores that already hold them. No table of its own and no write.
//
// Sources (each row's own time):
// - `approvals` with a `decided_at`: the owner's signed decision (approved, denied, cancelled), or
//   a grant by the owner's signed rules (`approved_by_rules`); a request voided by the system or
//   lapsed undecided is not a decision and is left out (IR-M1-11r-a-1 M-1);
// - `proofs` records, own and received (not replaced; not stored receipts or waiting rows);
// - `blocked_keys`: an unknown sender the owner blocked, shown by its sender code (04 §2.9, D-72);
// - `contacts` with status `blocked`, at the row's `updated_at` (the store keeps no separate block
//   time, so a later change to a blocked contact moves it);
// - `policies`: the signed rules now in force, at `applied_at` (the store keeps only the current
//   version, so earlier changes are not listed).
//
// Display only: a decision shown here is the row's status cache, which authorises nothing (04
// §2.5.1). Zero access and I-5: an entry carries IDs, times, statuses and codes only, never a
// summary, an action, a signed object, a salt, a sender key, a name or any other sealed or inbound
// value.
import { decodeHex, formatFingerprint, senderCode as senderDigest } from '@4thtech-io/crypto';
import type { CoreContext } from './context.js';
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
import { senderCodesFor } from './sender-codes.js';
import { SINGLETON_SLOT, type Row } from './store/schema.js';
import type { Where } from './store/store.js';

interface EntryBase {
  /** Stable and unique in the feed: `<kind>:<row ID>`. Pass it back only through a cursor. */
  readonly id: string;
  /** Unix seconds. */
  readonly at: number;
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
    })
  | (EntryBase & {
      readonly kind: 'sender_blocked';
      /** The blocked sender's code (04 §2.9): tells senders apart, authenticates nothing. */
      readonly senderCode: string;
    })
  | (EntryBase & { readonly kind: 'contact_blocked'; readonly contactId: string })
  | (EntryBase & { readonly kind: 'rules_changed'; readonly version: number });

export type ApprovalDecision = 'approved' | 'approved_by_rules' | 'denied' | 'cancelled';

type Candidate = PagePosition & { readonly entry: () => ActivityEntry };

const NOSTR_KEY = /^[0-9a-f]{64}$/;
const BLOCKED = 'sender_blocked:';

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

export class ActivityService {
  readonly #ctx: CoreContext;

  constructor(ctx: CoreContext) {
    this.#ctx = ctx;
  }

  /** One page of the feed, newest first by (time, id). Store only; writes nothing. */
  async list(query: PageQuery = {}): Promise<Page<ActivityEntry>> {
    const limit = pageLimit(query);
    const cursor = parseCursor(query.cursor);
    const candidates = await this.#ctx.store.transaction((tx): Candidate[] => {
      const out: Candidate[] = [];
      // `position` orders the feed and makes the cursor; it is always the entry's own `id`, a value
      // the caller already received (paging.ts).
      const add = (at: number, position: string, entry: () => ActivityEntry): void => {
        out.push({ at, id: position, entry });
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
          kind: 'approval_decided',
          id,
          at,
          approvalId: r.approval_id,
          decision,
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
        add(r.created_at, id, () => ({
          kind: 'proof',
          id,
          at: r.created_at,
          recordId: r.record_id,
          direction: r.status === 'received' ? 'received' : 'sent',
          status: r.status,
          chainId: r.chain_id,
        }));
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
        add(r.blocked_at, id, () => ({
          kind: 'sender_blocked',
          id,
          at: r.blocked_at,
          senderCode: code,
        }));
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
        add(r.updated_at, id, () => ({
          kind: 'contact_blocked',
          id,
          at: r.updated_at,
          contactId: r.contact_id,
        }));
      }

      const policy = tx.get('policies', { slot: SINGLETON_SLOT });
      if (policy !== undefined) {
        const id = `rules_changed:${String(policy.version)}`;
        add(policy.applied_at, id, () => ({
          kind: 'rules_changed',
          id,
          at: policy.applied_at,
          version: policy.version,
        }));
      }
      return out;
    });
    const page = pageOf(candidates, cursor, limit);
    return Object.freeze({
      items: Object.freeze(page.items.map((c) => Object.freeze(c.entry()))),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
  }
}
