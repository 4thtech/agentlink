// The negotiation chain over the core's own store (M1-32; 04 §3.4, D-55, D-74).
//
// A negotiation (key = `termsId` plus the unordered pair of parties) is never kept as a separate
// row: each core computes it from the `offer`, `accept` and `reject` envelopes it stored (07 §3, §2.1
// step 1). Those rows are only the envelopes the chain took: the receive path runs the chain rules
// before an envelope is stored (`TermsInbound`, wired into the envelope pipeline), and an envelope
// the chain refuses is stored as `refused` without its payload (07 §3.2), so it never re-enters.
//
// Rebuilding is a replay through the pure reducer of @agentlink/types (`recordSentTerms`,
// `receiveTerms`) in a fixed order that never depends on store order or on a sender-chosen time:
// version; offers before answers; resend round (a resend follows the envelope it names); this side's
// envelope before the other side's; then createdAt and envelopeHash. Why this reproduces the state
// the live run reached: an envelope that the receive path refused is not in the set, every stored
// envelope of a version was valid against the versions below it, and within one version the only
// order the rules depend on is the one fixed above (an own envelope for version n exists only if it
// was sent before the other side's envelope for n was taken, since the core links to its newest
// version; a resend always follows the envelope its `replyTo` names; rule 1 already refused a second
// envelope from one sender). The two delivery orders of a resend reach the same state (04 §3.4 item
// 4 note): the live envelope for n is the resend and both originals are not acceptable.
//
// Rules: inbound terms are untrusted (I-5). Nothing here logs or throws inbound text; errors are
// fixed codes. A stored row whose payload does not open or parse fails the whole read closed
// (`store_unreadable`), never an empty chain.
import { termsHash as computeTermsHash, parseJson, verifyTermsHash } from '@agentlink/crypto';
import {
  EMPTY_NEGOTIATION,
  acceptBodySchema,
  negotiationKey,
  newestOpenOffer,
  offerBodySchema,
  receiveTerms,
  recordSentTerms,
  rejectBodySchema,
  type NegotiationState,
  type Payload,
  type Terms,
  type TermsEnvelope,
  type TermsReceipt,
  type TermsRefusal,
} from '@agentlink/types';
import { open, type CoreContext } from './context.js';
import { CoreError } from './errors.js';
import type { StoreTx } from './store/store.js';

/** The payload types that carry `terms` (04 §3.4). */
export const TERMS_PAYLOAD_TYPES = Object.freeze(['offer', 'accept', 'reject'] as const);
export type TermsPayloadType = (typeof TERMS_PAYLOAD_TYPES)[number];

export const isTermsType = (type: unknown): type is TermsPayloadType =>
  (TERMS_PAYLOAD_TYPES as readonly unknown[]).includes(type);

/** One stored terms envelope as the chain sees it: verified sender, parsed and hash-checked body. */
export interface TermsRecord {
  readonly envelopeId: string;
  /** `0x` + 64 lowercase hex (04 §2.4.1). */
  readonly envelopeHash: string;
  readonly direction: 'in' | 'out';
  readonly sender: string;
  readonly recipient: string;
  /** The signed envelope `createdAt`. */
  readonly createdAt: number;
  readonly type: TermsPayloadType;
  readonly replyTo: string | null;
  readonly thread: string;
  readonly terms: Terms;
  readonly termsHash: string;
  readonly note: string | null;
}

/** One negotiation rebuilt from the store. */
export interface Negotiation {
  readonly key: string;
  readonly termsId: string;
  readonly state: NegotiationState;
  /** The records the replay took, in replay order. */
  readonly records: readonly TermsRecord[];
  /**
   * Stored records the replay refused. Empty for a store the receive path wrote; non-empty only for
   * rows stored before the chain rules ran on receive. They never count for the chain.
   */
  readonly dropped: readonly TermsRecord[];
}

const BODY = {
  offer: offerBodySchema,
  accept: acceptBodySchema,
  reject: rejectBodySchema,
} as const;

/**
 * The terms body of a payload: strict schema for its type and a `termsHash` that is the recomputed
 * one (04 §3.4, through @agentlink/crypto). Undefined for anything else. Never throws.
 */
export function termsBodyOf(
  type: unknown,
  body: unknown,
): { readonly terms: Terms; readonly termsHash: string; readonly note: string | null } | undefined {
  try {
    if (!isTermsType(type)) return undefined;
    const parsed = BODY[type].safeParse(body);
    if (!parsed.success) return undefined;
    if (!verifyTermsHash(parsed.data.terms, parsed.data.termsHash)) return undefined;
    return parsed.data;
  } catch {
    return undefined;
  }
}

/** The chain's view of a record (the reducer's input). */
export const chainEnvelopeOf = (r: TermsRecord): TermsEnvelope => ({
  envelopeId: r.envelopeId,
  sender: r.sender,
  recipient: r.recipient,
  createdAt: r.createdAt,
  type: r.type,
  replyTo: r.replyTo,
  terms: r.terms,
  termsHash: r.termsHash,
});

export const keyOf = (r: Pick<TermsRecord, 'terms'>): string =>
  negotiationKey(r.terms.termsId, r.terms.parties);

/** Resend round of an offer: 0, or one more than the offer of the same version its replyTo names. */
function rounds(records: readonly TermsRecord[]): Map<string, number> {
  const offers = new Map(records.filter((r) => r.type === 'offer').map((r) => [r.envelopeId, r]));
  const memo = new Map<string, number>();
  const roundOf = (r: TermsRecord, depth: number): number => {
    const known = memo.get(r.envelopeId);
    if (known !== undefined) return known;
    const target = r.replyTo === null ? undefined : offers.get(r.replyTo);
    const round =
      target === undefined || target.terms.version !== r.terms.version || depth > records.length
        ? 0
        : roundOf(target, depth + 1) + 1;
    memo.set(r.envelopeId, round);
    return round;
  };
  for (const r of offers.values()) roundOf(r, 0);
  return memo;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The replay order of one negotiation's records (see the header). */
export function replayOrder(records: readonly TermsRecord[]): TermsRecord[] {
  const round = rounds(records);
  return [...records].sort(
    (a, b) =>
      a.terms.version - b.terms.version ||
      (a.type === 'offer' ? 0 : 1) - (b.type === 'offer' ? 0 : 1) ||
      (round.get(a.envelopeId) ?? 0) - (round.get(b.envelopeId) ?? 0) ||
      (a.direction === 'out' ? 0 : 1) - (b.direction === 'out' ? 0 : 1) ||
      a.createdAt - b.createdAt ||
      cmp(a.envelopeHash, b.envelopeHash) ||
      cmp(a.envelopeId, b.envelopeId),
  );
}

/** Rebuilds every negotiation from a set of stored records, in any order. Pure; never throws. */
export function rebuildNegotiations(
  self: string,
  records: readonly TermsRecord[],
): ReadonlyMap<string, Negotiation> {
  const byKey = new Map<string, TermsRecord[]>();
  for (const r of records) {
    const key = keyOf(r);
    const list = byKey.get(key);
    if (list === undefined) byKey.set(key, [r]);
    else list.push(r);
  }
  const out = new Map<string, Negotiation>();
  for (const [key, list] of byKey) {
    let state: NegotiationState = EMPTY_NEGOTIATION;
    const taken: TermsRecord[] = [];
    const dropped: TermsRecord[] = [];
    for (const r of replayOrder(list)) {
      if (r.direction === 'out') {
        state = recordSentTerms(state, chainEnvelopeOf(r));
        taken.push(r);
        continue;
      }
      const receipt = receiveTerms(state, chainEnvelopeOf(r), self);
      if (receipt.outcome === 'refused') {
        dropped.push(r);
      } else {
        state = receipt.state;
        taken.push(r);
      }
    }
    out.set(key, { key, termsId: list[0]!.terms.termsId, state, records: taken, dropped });
  }
  return out;
}

/** The chain decision for one inbound record against the rebuilt negotiations (04 §3.4). */
export function admitInbound(
  self: string,
  negotiations: ReadonlyMap<string, Negotiation>,
  record: TermsRecord,
): TermsReceipt & { readonly key: string } {
  const key = keyOf(record);
  const state = negotiations.get(key)?.state ?? EMPTY_NEGOTIATION;
  return { ...receiveTerms(state, chainEnvelopeOf(record), self), key };
}

/** The newest open offer of a negotiation, as a record (undefined when there is none). */
export function newestOffer(n: Negotiation | undefined): TermsRecord | undefined {
  if (n === undefined) return undefined;
  const head = newestOpenOffer(n.state.offers);
  return head === undefined ? undefined : n.records.find((r) => r.envelopeId === head.envelopeId);
}

/** Whether a version of a negotiation is locked (an accept for it was sent or received; rule 2). */
export const isLocked = (n: Negotiation | undefined, version: number): boolean =>
  n?.state.lockedVersions.includes(version) ?? false;

/** The stored offer state of an envelope in its negotiation (`open`, `conflict`), if it is one. */
export const offerState = (
  n: Negotiation | undefined,
  envelopeId: string,
): 'open' | 'conflict' | undefined =>
  n?.state.offers.find((o) => o.envelopeId === envelopeId)?.state;

// --- the store -------------------------------------------------------------------------------------

/** What the chain read from the store for one contact, and the rows it was read from. */
export interface TermsSnapshot {
  readonly self: string;
  readonly contactId: string;
  readonly negotiations: ReadonlyMap<string, Negotiation>;
  /** Every record the chain took, by envelope ID. */
  readonly byEnvelope: ReadonlyMap<string, { readonly record: TermsRecord; readonly key: string }>;
  /** The rows read: compared inside a later transaction (`snapshotCurrentTx`). */
  readonly fingerprint: string;
}

const where = (contactId: string) =>
  ({ contact_id: contactId, state: 'ok', type: { in: [...TERMS_PAYLOAD_TYPES] } }) as const;

/** The stored terms rows of a contact as one string: IDs, hashes and directions, sorted. */
export function fingerprintTx(tx: StoreTx, contactId: string): string {
  return tx
    .select('envelopes', where(contactId))
    .map((r) => `${r.envelope_id}|${r.envelope_hash}|${r.direction}`)
    .sort()
    .join(',');
}

/** True while the contact's stored terms rows are exactly those the snapshot was built from. */
export function snapshotCurrentTx(tx: StoreTx, snapshot: TermsSnapshot): boolean {
  return fingerprintTx(tx, snapshot.contactId) === snapshot.fingerprint;
}

const unreadable = (): CoreError =>
  new CoreError('store_unreadable', 'A stored value could not be read.');

/**
 * Reads and rebuilds every negotiation with `contactId` (the contact's agent ID) from the store.
 * Every stored terms row must open and parse, and its body must hash to its `termsHash`; otherwise
 * the read fails closed. Envelope rows are matched on the sealed payload (07 §3.1 AAD binds it to its
 * row), the stored envelopeHash and the signed `createdAt`.
 */
export async function loadTermsSnapshot(
  ctx: CoreContext,
  self: string,
  contactId: string,
): Promise<TermsSnapshot> {
  const rows = await ctx.store.transaction((tx) => ({
    rows: tx.select('envelopes', where(contactId)),
    fingerprint: fingerprintTx(tx, contactId),
  }));
  const records: TermsRecord[] = [];
  for (const row of rows.rows) {
    if (row.payload_json === null) throw unreadable();
    let payload: unknown;
    try {
      const text = await open(
        ctx,
        'envelopes',
        'payload_json',
        [row.envelope_id],
        row.payload_json,
      );
      payload = parseJson(text);
    } catch {
      throw unreadable();
    }
    const p = payload as Partial<Payload> | null;
    const body = termsBodyOf(p?.type, p?.body);
    if (body === undefined || p?.type !== row.type) throw unreadable();
    const replyTo = (p as { replyTo?: unknown }).replyTo;
    if (replyTo !== null && typeof replyTo !== 'string') throw unreadable();
    records.push({
      envelopeId: row.envelope_id,
      envelopeHash: row.envelope_hash,
      direction: row.direction,
      sender: row.direction === 'out' ? self : contactId,
      recipient: row.direction === 'out' ? contactId : self,
      createdAt: row.created_at,
      type: row.type as TermsPayloadType,
      replyTo,
      thread: row.thread_id,
      terms: body.terms,
      termsHash: body.termsHash,
      note: body.note,
    });
  }
  const negotiations = rebuildNegotiations(self, records);
  const byEnvelope = new Map<string, { record: TermsRecord; key: string }>();
  for (const n of negotiations.values()) {
    for (const record of n.records) byEnvelope.set(record.envelopeId, { record, key: n.key });
  }
  return { self, contactId, negotiations, byEnvelope, fingerprint: rows.fingerprint };
}

// --- the receive path ------------------------------------------------------------------------------

/** An inbound terms envelope from a contact that passed 04 §3.1.1 steps 3–9. */
export interface TermsInboundInput {
  readonly envelopeId: string;
  readonly envelopeHash: string;
  readonly contactId: string;
  readonly createdAt: number;
  readonly thread: string;
  readonly payload: Payload;
}

/** Fixed reason codes of a chain refusal on receive (never inbound text). */
export type TermsInboundRefusal = TermsRefusal;

export type TermsAdmission =
  | {
      readonly refused: true;
      readonly reason: TermsInboundRefusal;
      /** Rule 1: a second envelope from the same sender for a version flags the contact. */
      readonly flagged: boolean;
    }
  | {
      readonly refused: false;
      readonly outcome: 'valid' | 'conflict';
      /** In the storing transaction: the chain rows are still those the decision was made on. */
      checkTx(tx: StoreTx): boolean;
      /** In the storing transaction, after checkTx: the effects of the outcome (rule 3). */
      effectTx(tx: StoreTx, now: number): void;
    };

/** The receive-side hook the envelope pipeline calls for `offer`, `accept` and `reject`. */
export interface TermsInboundHook {
  admit(input: TermsInboundInput): Promise<TermsAdmission>;
}

/**
 * Voids the pending commitment scopes a conflict ends (04 §3.4 rule 3; IR-D55-1 F04, IR-D55-2 N01):
 * pending scopes that answer an envelope of the conflict, and pending scopes on the version both
 * counters replaced. Only `pending` rows: a scope the owner approved keeps its parts (its `accept`
 * may have run, rule 4); the run-time checks of terms-flow refuse what the chain no longer allows.
 */
export function voidPendingScopesTx(tx: StoreTx, answered: readonly string[], now: number): number {
  let n = 0;
  for (const id of answered) {
    for (const row of tx.select('approvals', { answers_envelope_id: id, status: 'pending' })) {
      n += tx.update(
        'approvals',
        { approval_id: row.approval_id, status: 'pending' },
        { status: 'void', decided_at: now },
      );
      tx.update(
        'commitment_parts',
        { approval_id: row.approval_id, state: { in: ['unclaimed', 'claimed'] } },
        { state: 'void', void_reason: 'superseded', updated_at: now },
      );
    }
  }
  return n;
}

/** The receive-side chain rules over the store (`TermsInboundHook`). */
export class TermsInbound implements TermsInboundHook {
  readonly #ctx: CoreContext;
  readonly #self: () => Promise<string | undefined>;

  constructor(ctx: CoreContext, self: () => Promise<string | undefined>) {
    this.#ctx = ctx;
    this.#self = self;
  }

  async admit(input: TermsInboundInput): Promise<TermsAdmission> {
    const self = await this.#self();
    const p = input.payload as { type: unknown; body: unknown; replyTo: unknown };
    const body = termsBodyOf(p.type, p.body);
    if (self === undefined || body === undefined || !isTermsType(p.type)) {
      return { refused: true, reason: 'invalid', flagged: false };
    }
    const record: TermsRecord = {
      envelopeId: input.envelopeId,
      envelopeHash: input.envelopeHash,
      direction: 'in',
      sender: input.contactId,
      recipient: self,
      createdAt: input.createdAt,
      type: p.type,
      replyTo: typeof p.replyTo === 'string' ? p.replyTo : null,
      thread: input.thread,
      terms: body.terms,
      termsHash: body.termsHash,
      note: body.note,
    };
    const snapshot = await loadTermsSnapshot(this.#ctx, self, input.contactId);
    const receipt = admitInbound(self, snapshot.negotiations, record);
    if (receipt.outcome === 'refused') {
      const reason = receipt.reason ?? 'invalid';
      return { refused: true, reason, flagged: reason === 'same_sender' };
    }
    // Rule 3 (a conflict found here, or revealed by a resend, D-74 item 1): the envelopes of the
    // conflict, and the version both counters replaced.
    const voids: string[] = [];
    const neg = snapshot.negotiations.get(receipt.key);
    const before = neg?.state.conflicts.length ?? 0;
    if (receipt.state.conflicts.length > before) {
      const n = record.terms.version;
      const conflict = receipt.state.conflicts[receipt.state.conflicts.length - 1];
      for (const e of conflict?.envelopes ?? []) voids.push(e.envelopeId);
      voids.push(record.envelopeId);
      for (const r of neg?.records ?? []) {
        if (r.type === 'offer' && r.terms.version === n - 1) voids.push(r.envelopeId);
      }
    }
    return {
      refused: false,
      outcome: receipt.outcome,
      checkTx: (tx) => snapshotCurrentTx(tx, snapshot),
      effectTx: (tx, now) => {
        if (voids.length > 0) voidPendingScopesTx(tx, voids, now);
      },
    };
  }
}

/** sha256(JCS(terms)) as bare hex, through @agentlink/crypto (04 §3.4). */
export const termsHashOf = (terms: Terms): string => computeTermsHash(terms);
