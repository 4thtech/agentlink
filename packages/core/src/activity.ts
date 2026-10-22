// The activity feed of the local UI (M1-11r-a): one newest-first, paged list of the events that are
// not messages, merged from the stores that already hold them. No table of its own and no write.
//
// Sources (each row's own time):
// - `approvals` with a `decided_at`: the owner's decision (approved, denied, cancelled);
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
import { SINGLETON_SLOT } from './store/schema.js';

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
      readonly decision: 'approved' | 'denied' | 'cancelled';
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

type Candidate = PagePosition & { readonly entry: () => ActivityEntry };

const NOSTR_KEY = /^[0-9a-f]{64}$/;

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
      const add = (at: number, id: string, entry: () => ActivityEntry): void => {
        out.push({ at, id, entry });
      };

      const approvals = candidatesTx(
        tx,
        'approvals',
        {},
        'decided_at',
        'approval_id',
        cursor,
        limit,
      );
      for (const r of approvals) {
        const at = r.decided_at;
        if (at === null || r.status === 'pending') continue;
        // A cancel of an undecided request denied it (04 §2.5.1); `void` and `expired` after an
        // approve were approved (then used or lapsed).
        const decision =
          r.signed_decision === null || r.status === 'denied'
            ? 'denied'
            : r.status === 'cancelled'
              ? 'cancelled'
              : 'approved';
        const id = `approval_decided:${r.approval_id}`;
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

      const blocked = candidatesTx(tx, 'blocked_keys', {}, 'blocked_at', 'from_key', cursor, limit);
      const codes = senderCodesFor(blocked.map((r) => r.from_key));
      for (const r of blocked) {
        const code = codes.get(r.from_key);
        if (code === undefined || !NOSTR_KEY.test(r.from_key)) continue;
        // The ID is the long sender code: unique per key, and never the key itself.
        const long = formatFingerprint(senderDigest(decodeHex(r.from_key, { length: 32 })), 'long');
        const id = `sender_blocked:${long}`;
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
