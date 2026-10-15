// M1-32: the negotiation chain over the core's own store (04 §3.4, D-55, D-74). Every chain case
// of the M1-21 `terms` vector suite (ops chainReceive, nextOffer, sendAccept; test-vectors/terms) is
// re-expressed here as a scenario, because core tests may not read test-vectors/ (boundary rules):
// the same log, the same refusals and the same newest version, by the case's id. The store is
// emulated as the set of envelopes the receive path took; before each step the negotiations are
// REBUILT from that set in several shuffled orders, so the result must never depend on store order
// (terms-store.ts replay order) or on a sender-chosen time.
import { canonicalize, encodeBase64url, encodeUtf8, sha256, termsHash } from '@agentlink/crypto';
import { checkSendAccept, negotiationKey, nextTermsLink, type Terms } from '@agentlink/types';
import { describe, expect, it } from 'vitest';
import { admitInbound, rebuildNegotiations, replayOrder, type TermsRecord } from './terms-store.js';

const T0 = 1_790_000_000;
const VU = T0 + 604_800;
// Agent IDs in ascending byte order: X < S < Y, and O another pair's party.
const S = '0x5555555555555555555555555555555555555555';
const X = '0x3333333333333333333333333333333333333333';
const Y = '0x7777777777777777777777777777777777777777';
const O = '0x9999999999999999999999999999999999999999';
const TERMS_ID = 'AAECAwQFBgcICQoLDA0ODw';
const THREAD = 'EBESExQVFhcYGRobHB0eHw';

type Party = typeof S | typeof X | typeof Y | typeof O;
type Dir = 's' | 'r';

interface Step {
  readonly dir: Dir;
  readonly id: string;
  readonly from: Party;
  readonly to: Party;
  readonly type: 'offer' | 'accept' | 'reject';
  readonly terms: Terms;
  readonly replyTo: string | null;
  readonly createdAt: number;
}

/** Builds a scenario's envelopes; hashes are recomputed with @agentlink/crypto. */
class Log {
  readonly steps: Step[] = [];
  readonly #terms = new Map<string, Terms>();

  hash(id: string): string {
    return termsHash(this.#terms.get(id) as Terms);
  }

  terms(id: string): Terms {
    return this.#terms.get(id) as Terms;
  }

  /** An offer of `version` from `from` to `to`, linking to the envelope `prev` (or a raw hash). */
  offer(
    dir: Dir,
    id: string,
    from: Party,
    to: Party,
    version: number,
    prev: string | null,
    opts: {
      subject?: string;
      replyTo?: string;
      prevHash?: string;
      pair?: readonly Party[];
      t?: number;
    } = {},
  ): Step {
    const parties = [...(opts.pair ?? [from, to])].sort() as [string, string];
    const terms: Terms = {
      termsId: TERMS_ID,
      version,
      parties,
      subject: opts.subject ?? 'Spec v2 – milestone 3',
      deliverables: [
        { id: 'd1', description: 'Milestone 3 report', by: parties[0]!, plaintextSha256: null },
      ],
      price: { amount: '1500.00', currency: 'EUR', payer: parties[1]! },
      deadlines: [{ ref: 'd1', due: '2026-11-30T17:00:00Z' }],
      validUntil: VU,
      previousTermsHash: opts.prevHash ?? (prev === null ? null : this.hash(prev)),
    };
    // A reused ID (a crafted second envelope) never replaces the first one's terms here.
    if (!this.#terms.has(id)) this.#terms.set(id, terms);
    const step: Step = {
      dir,
      id,
      from,
      to,
      type: 'offer',
      terms,
      replyTo: opts.replyTo ?? null,
      createdAt: T0 + (opts.t ?? 0),
    };
    this.steps.push(step);
    return step;
  }

  /** An accept or reject carrying the terms of `of` (or of `copy`), replyTo `replyTo` (or `of`). */
  answer(
    dir: Dir,
    id: string,
    from: Party,
    to: Party,
    type: 'accept' | 'reject',
    of: string,
    opts: { replyTo?: string | null; subject?: string; t?: number } = {},
  ): Step {
    const base = this.terms(of);
    const terms = opts.subject === undefined ? base : { ...base, subject: opts.subject };
    this.#terms.set(id, terms);
    const step: Step = {
      dir,
      id,
      from,
      to,
      type,
      terms,
      replyTo: opts.replyTo === undefined ? of : opts.replyTo,
      createdAt: T0 + (opts.t ?? 0),
    };
    this.steps.push(step);
    return step;
  }
}

/** A distinct 16-byte envelope ID (base64url) per step name. */
const idOf = (name: string): string => encodeBase64url(sha256(encodeUtf8(name)).slice(0, 16));

function record(step: Step): TermsRecord {
  const hash = termsHash(step.terms);
  return {
    envelopeId: idOf(step.id),
    // A stand-in for the envelopeHash: different envelopes, different hashes.
    envelopeHash: `0x${termsHash({ id: step.id, h: hash, t: step.createdAt, r: step.replyTo })}`,
    direction: step.from === S ? 'out' : 'in',
    sender: step.from,
    recipient: step.to,
    createdAt: step.createdAt,
    type: step.type,
    replyTo: step.replyTo === null ? null : idOf(step.replyTo),
    thread: THREAD,
    terms: step.terms,
    termsHash: hash,
    note: null,
  };
}

/** A seeded shuffle, so a failure reproduces. */
function shuffled<T>(list: readonly T[], seed: number): T[] {
  const out = [...list];
  let s = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const ORDERS = [0, 1, 2, 3, 4, 5, 6, 7];

/** The emulated store: the envelopes the receive path took, rebuilt in every order checked. */
class ChainStore {
  readonly stored: TermsRecord[] = [];
  readonly #seen = new Set<string>();

  rebuild(seed = 0) {
    const negotiations = rebuildNegotiations(S, shuffled(this.stored, seed));
    for (const n of negotiations.values()) expect(n.dropped).toEqual([]);
    return negotiations;
  }

  /** Every order gives the same states. */
  stable() {
    const first = this.rebuild(0);
    for (const seed of ORDERS.slice(1)) {
      const again = this.rebuild(seed);
      expect([...again.keys()].sort()).toEqual([...first.keys()].sort());
      for (const [key, n] of first) {
        expect(canonicalize(again.get(key)!.state as never)).toBe(canonicalize(n.state as never));
      }
    }
    return first;
  }

  apply(step: Step): 'valid' | 'conflict' | 'refused' | 'duplicate' {
    const r = record(step);
    const identity = canonicalize(r as never);
    if (this.#seen.has(identity)) return 'duplicate';
    this.#seen.add(identity);
    if (step.dir === 's') {
      this.stored.push(r);
      return 'valid';
    }
    const outcomes = new Set(ORDERS.map((seed) => admitInbound(S, this.rebuild(seed), r).outcome));
    expect(outcomes.size).toBe(1);
    const outcome = [...outcomes][0]!;
    if (outcome !== 'refused') this.stored.push(r);
    return outcome;
  }

  newest(pair: readonly Party[]): { version: number; hash: string | null } {
    const n = this.stable().get(negotiationKey(TERMS_ID, pair));
    let head: { version: number; termsHash: string } | undefined;
    for (const o of n?.state.offers ?? []) {
      if (o.state === 'open' && (head === undefined || o.version > head.version)) head = o;
    }
    return { version: head?.version ?? 0, hash: head?.termsHash ?? null };
  }
}

interface ChainCase {
  readonly id: string;
  readonly build: (l: Log) => Step;
  readonly outcome: 'valid' | 'conflict' | 'refused' | 'duplicate';
  /** The envelope whose version is newest after the step, or null for none. */
  readonly newest: string | null;
  /** The pair whose negotiation `newest` is read from (default: the incoming step's parties). */
  readonly pair?: readonly Party[];
}

const conflictBase = (l: Log) => {
  l.offer('s', 'e0', S, X, 1, null);
  l.offer('s', 'e1', S, X, 2, 'e0', { subject: "A's revision" });
  l.offer('r', 'e2', X, S, 2, 'e0', { subject: "B's counter" });
};

// chainReceive (52 cases).
const RECEIVE: ChainCase[] = [
  {
    id: 'chain-new-negotiation',
    build: (l) => l.offer('r', 'e0', Y, S, 1, null),
    outcome: 'valid',
    newest: 'e0',
  },
  {
    id: 'chain-counter',
    build: (l) => (l.offer('s', 'e0', S, X, 1, null), l.offer('r', 'e1', X, S, 2, 'e0')),
    outcome: 'valid',
    newest: 'e1',
  },
  {
    id: 'chain-third-version',
    build: (l) => (
      l.offer('r', 'e0', Y, S, 1, null),
      l.offer('s', 'e1', S, Y, 2, 'e0'),
      l.offer('r', 'e2', Y, S, 3, 'e1')
    ),
    outcome: 'valid',
    newest: 'e2',
  },
  {
    id: 'chain-new-not-version-1',
    build: (l) => l.offer('r', 'e0', Y, S, 2, null, { prevHash: '1c'.repeat(32) }),
    outcome: 'refused',
    newest: null,
  },
  {
    id: 'chain-version-gap',
    build: (l) => (l.offer('s', 'e0', S, X, 1, null), l.offer('r', 'e1', X, S, 3, 'e0')),
    outcome: 'refused',
    newest: 'e0',
  },
  {
    id: 'chain-pointer-to-older',
    build: (l) => (
      l.offer('r', 'e0', Y, S, 1, null),
      l.offer('s', 'e1', S, Y, 2, 'e0'),
      l.offer('r', 'e2', Y, S, 3, 'e0')
    ),
    outcome: 'refused',
    newest: 'e1',
  },
  {
    id: 'chain-pointer-unknown',
    build: (l) => (
      l.offer('s', 'e0', S, X, 1, null),
      l.offer('r', 'e1', X, S, 2, null, { prevHash: '1c'.repeat(32) })
    ),
    outcome: 'refused',
    newest: 'e0',
  },
  {
    id: 'chain-same-terms-id-other-pair',
    build: (l) => (
      l.offer('r', 'e0', O, S, 1, null),
      l.offer('s', 'e1', S, O, 2, 'e0'),
      l.offer('r', 'e2', O, S, 3, 'e1'),
      l.offer('r', 'e3', X, S, 1, null)
    ),
    outcome: 'valid',
    newest: 'e3',
  },
  {
    id: 'chain-same-terms-id-other-pair-continued',
    build: (l) => (
      l.offer('r', 'e0', O, S, 1, null),
      l.offer('s', 'e1', S, O, 2, 'e0'),
      l.offer('r', 'e2', O, S, 3, 'e1'),
      l.offer('r', 'e3', X, S, 4, 'e2')
    ),
    outcome: 'refused',
    newest: null,
  },
  {
    id: 'chain-not-a-party',
    build: (l) => l.offer('r', 'e0', X, S, 1, null, { pair: [O, S] }),
    outcome: 'refused',
    newest: null,
  },
  {
    id: 'chain-duplicate',
    build: (l) => {
      l.offer('s', 'e0', S, X, 1, null);
      const e1 = l.offer('r', 'e1', X, S, 2, 'e0');
      l.steps.push(e1);
      return e1;
    },
    outcome: 'duplicate',
    newest: 'e1',
  },
  {
    id: 'chain-same-sender-same-terms',
    build: (l) => (
      l.offer('s', 'e0', S, X, 1, null),
      l.offer('r', 'e1', X, S, 2, 'e0'),
      l.offer('r', 'e2', X, S, 2, 'e0')
    ),
    outcome: 'refused',
    newest: 'e1',
  },
  {
    id: 'chain-same-sender-other-terms',
    build: (l) => (
      l.offer('s', 'e0', S, X, 1, null),
      l.offer('r', 'e1', X, S, 2, 'e0'),
      l.offer('r', 'e2', X, S, 2, 'e0', { subject: 'other' })
    ),
    outcome: 'refused',
    newest: 'e1',
  },
  {
    id: 'chain-same-sender-same-id-other-content',
    build: (l) => (
      l.offer('s', 'e0', S, X, 1, null),
      l.offer('r', 'e1', X, S, 2, 'e0'),
      l.offer('r', 'e1', X, S, 2, 'e0', { subject: 'same id, other content' })
    ),
    outcome: 'refused',
    newest: 'e1',
  },
  {
    id: 'chain-same-sender-first-refused-replay',
    build: (l) => (
      l.offer('s', 'e0', S, X, 1, null),
      l.offer('r', 'e1', X, S, 2, 'e0'),
      l.offer('r', 'e2', X, S, 2, 'e0'),
      l.offer('r', 'e3', X, S, 2, 'e0', { subject: 'third' })
    ),
    outcome: 'refused',
    newest: 'e1',
  },
  {
    id: 'chain-fork-after-accept-sent',
    build: (l) => (
      l.offer('s', 'e0', S, X, 1, null),
      l.offer('r', 'e1', X, S, 2, 'e0'),
      l.answer('s', 'e2', S, X, 'accept', 'e1'),
      l.offer('r', 'e3', X, S, 2, 'e0', { subject: 'fork' })
    ),
    outcome: 'refused',
    newest: 'e1',
  },
  {
    id: 'chain-fork-after-accept-received',
    build: (l) => (
      l.offer('s', 'e0', S, X, 1, null),
      l.offer('s', 'e1', S, X, 2, 'e0'),
      l.answer('r', 'e2', X, S, 'accept', 'e1'),
      l.offer('r', 'e3', X, S, 2, 'e0', { subject: 'late counter' })
    ),
    outcome: 'refused',
    newest: 'e1',
  },
  {
    id: 'chain-second-accept',
    build: (l) => (
      l.offer('s', 'e0', S, X, 1, null),
      l.offer('s', 'e1', S, X, 2, 'e0'),
      l.answer('r', 'e2', X, S, 'accept', 'e1'),
      l.answer('r', 'e3', X, S, 'accept', 'e1', { t: 1 })
    ),
    outcome: 'refused',
    newest: 'e1',
  },
  {
    id: 'chain-offer-after-accept',
    build: (l) => (
      l.offer('s', 'e0', S, X, 1, null),
      l.offer('s', 'e1', S, X, 2, 'e0'),
      l.answer('r', 'e2', X, S, 'accept', 'e1'),
      l.offer('r', 'e3', X, S, 3, 'e1')
    ),
    outcome: 'valid',
    newest: 'e3',
  },
  {
    id: 'chain-resend-on-locked',
    build: (l) => (
      l.offer('s', 'e0', S, X, 1, null),
      l.offer('s', 'e1', S, X, 2, 'e0'),
      l.answer('r', 'e2', X, S, 'accept', 'e1'),
      l.offer('r', 'e3', X, S, 2, 'e0', { subject: 'void it', replyTo: 'e1' })
    ),
    outcome: 'refused',
    newest: 'e1',
  },
  {
    id: 'chain-concurrent-counters-a',
    build: (l) => (
      l.offer('s', 'e0', S, X, 1, null),
      l.offer('s', 'e1', S, X, 2, 'e0', { subject: "A's revision" }),
      l.offer('r', 'e2', X, S, 2, 'e0', { subject: "B's counter" })
    ),
    outcome: 'conflict',
    newest: 'e0',
  },
  {
    id: 'chain-concurrent-counters-b',
    build: (l) => (
      l.offer('r', 'e0', Y, S, 1, null),
      l.offer('s', 'e1', S, Y, 2, 'e0', { subject: "B's counter" }),
      l.offer('r', 'e2', Y, S, 2, 'e0', { subject: "A's revision" })
    ),
    outcome: 'conflict',
    newest: 'e0',
  },
  {
    id: 'chain-resend-after-original-a',
    build: (l) => (
      conflictBase(l),
      l.offer('r', 'e3', X, S, 2, 'e0', { subject: "B's resend", replyTo: 'e1' })
    ),
    outcome: 'valid',
    newest: 'e3',
  },
  {
    id: 'chain-resend-after-original-b',
    build: (l) => (
      l.offer('r', 'e0', Y, S, 1, null),
      l.offer('s', 'e1', S, Y, 2, 'e0', { subject: "B's counter" }),
      l.offer('r', 'e2', Y, S, 2, 'e0', { subject: "A's revision" }),
      l.offer('r', 'e3', Y, S, 2, 'e0', { subject: "A's resend", replyTo: 'e1' })
    ),
    outcome: 'valid',
    newest: 'e3',
  },
  {
    id: 'chain-resend-before-original-a',
    build: (l) => (
      l.offer('s', 'e0', S, X, 1, null),
      l.offer('s', 'e1', S, X, 2, 'e0', { subject: "A's revision" }),
      l.offer('r', 'e2', X, S, 2, 'e0', { subject: "B's resend", replyTo: 'e1' })
    ),
    outcome: 'valid',
    newest: 'e2',
  },
  {
    id: 'chain-resend-before-original-b',
    build: (l) => (
      l.offer('r', 'e0', Y, S, 1, null),
      l.offer('s', 'e1', S, Y, 2, 'e0', { subject: "B's counter" }),
      l.offer('r', 'e2', Y, S, 2, 'e0', { subject: "A's resend", replyTo: 'e1' })
    ),
    outcome: 'valid',
    newest: 'e2',
  },
  {
    id: 'chain-original-after-resend-a',
    build: (l) => (
      l.offer('s', 'e0', S, X, 1, null),
      l.offer('s', 'e1', S, X, 2, 'e0', { subject: "A's revision" }),
      l.offer('r', 'e2', X, S, 2, 'e0', { subject: "B's resend", replyTo: 'e1' }),
      l.offer('r', 'e3', X, S, 2, 'e0', { subject: "B's counter" })
    ),
    outcome: 'refused',
    newest: 'e2',
  },
  {
    id: 'chain-original-after-resend-b',
    build: (l) => (
      l.offer('r', 'e0', Y, S, 1, null),
      l.offer('s', 'e1', S, Y, 2, 'e0', { subject: "B's counter" }),
      l.offer('r', 'e2', Y, S, 2, 'e0', { subject: "A's resend", replyTo: 'e1' }),
      l.offer('r', 'e3', Y, S, 2, 'e0', { subject: "A's revision" })
    ),
    outcome: 'refused',
    newest: 'e2',
  },
  {
    id: 'chain-resend-without-link',
    build: (l) => (conflictBase(l), l.offer('r', 'e3', X, S, 2, 'e0', { subject: 'no link' })),
    outcome: 'refused',
    newest: 'e0',
  },
  {
    id: 'chain-second-resend',
    build: (l) => (
      conflictBase(l),
      l.offer('r', 'e3', X, S, 2, 'e0', { subject: "B's resend", replyTo: 'e1' }),
      l.offer('r', 'e4', X, S, 2, 'e0', { subject: 'second resend', replyTo: 'e1' })
    ),
    outcome: 'refused',
    newest: 'e3',
  },
  {
    id: 'chain-resend-unknown-reply-to',
    build: (l) => (
      conflictBase(l),
      l.offer('r', 'e3', X, S, 2, 'e0', { subject: 'unknown', replyTo: 'e4' })
    ),
    outcome: 'refused',
    newest: 'e0',
  },
  {
    id: 'chain-resend-names-other-version',
    build: (l) => (
      conflictBase(l),
      l.offer('r', 'e3', X, S, 2, 'e0', { subject: 'wrong link', replyTo: 'e0' })
    ),
    outcome: 'refused',
    newest: 'e0',
  },
  {
    id: 'chain-resend-names-own',
    build: (l) => (
      conflictBase(l),
      l.offer('r', 'e3', X, S, 2, 'e0', { subject: 'self link', replyTo: 'e2' })
    ),
    outcome: 'refused',
    newest: 'e0',
  },
  {
    id: 'chain-resend-wrong-pointer',
    build: (l) => (
      conflictBase(l),
      l.offer('r', 'e3', X, S, 2, null, {
        subject: 'bad pointer',
        replyTo: 'e1',
        prevHash: '1c'.repeat(32),
      })
    ),
    outcome: 'refused',
    newest: 'e0',
  },
  {
    id: 'chain-two-resends-new-conflict',
    build: (l) => (
      conflictBase(l),
      l.offer('s', 'e3', S, X, 2, 'e0', { subject: "A's resend", replyTo: 'e2' }),
      l.offer('r', 'e4', X, S, 2, 'e0', { subject: "B's resend", replyTo: 'e1' })
    ),
    outcome: 'conflict',
    newest: 'e0',
  },
  {
    id: 'chain-resend-after-second-conflict',
    build: (l) => (
      conflictBase(l),
      l.offer('s', 'e3', S, X, 2, 'e0', { subject: "A's resend", replyTo: 'e2' }),
      l.offer('r', 'e4', X, S, 2, 'e0', { subject: "B's resend", replyTo: 'e1' }),
      l.offer('r', 'e5', X, S, 2, 'e0', { subject: "B's second-round resend", replyTo: 'e3' })
    ),
    outcome: 'valid',
    newest: 'e5',
  },
  {
    id: 'chain-stale-link-after-second-conflict',
    build: (l) => (
      conflictBase(l),
      l.offer('s', 'e3', S, X, 2, 'e0', { subject: "A's resend", replyTo: 'e2' }),
      l.offer('r', 'e4', X, S, 2, 'e0', { subject: "B's resend", replyTo: 'e1' }),
      l.offer('r', 'e5', X, S, 2, 'e0', { subject: 'stale', replyTo: 'e1' })
    ),
    outcome: 'refused',
    newest: 'e0',
  },
  {
    id: 'chain-conflicted-not-a-base',
    build: (l) => (conflictBase(l), l.offer('r', 'e3', X, S, 3, 'e2')),
    outcome: 'refused',
    newest: 'e0',
  },
  {
    id: 'chain-accept-matching',
    build: (l) => (
      l.offer('s', 'e0', S, X, 1, null),
      l.offer('s', 'e1', S, X, 2, 'e0'),
      l.answer('r', 'e2', X, S, 'accept', 'e1')
    ),
    outcome: 'valid',
    newest: 'e1',
  },
  {
    id: 'chain-accept-hash-mismatch',
    build: (l) => (
      l.offer('s', 'e0', S, X, 1, null),
      l.offer('s', 'e1', S, X, 2, 'e0'),
      l.answer('r', 'e2', X, S, 'accept', 'e0', { replyTo: 'e1' })
    ),
    outcome: 'refused',
    newest: 'e1',
  },
  {
    id: 'chain-accept-terms-changed',
    build: (l) => (
      l.offer('s', 'e0', S, X, 1, null),
      l.offer('s', 'e1', S, X, 2, 'e0'),
      l.answer('r', 'e2', X, S, 'accept', 'e1', { subject: 'changed' })
    ),
    outcome: 'refused',
    newest: 'e1',
  },
  {
    id: 'chain-accept-no-reply-to',
    build: (l) => (
      l.offer('s', 'e0', S, X, 1, null),
      l.offer('s', 'e1', S, X, 2, 'e0'),
      l.answer('r', 'e2', X, S, 'accept', 'e1', { replyTo: null })
    ),
    outcome: 'refused',
    newest: 'e1',
  },
  {
    id: 'chain-accept-own-offer',
    build: (l) => (
      l.offer('s', 'e0', S, X, 1, null),
      l.offer('r', 'e1', X, S, 2, 'e0'),
      l.answer('r', 'e2', X, S, 'accept', 'e1')
    ),
    outcome: 'refused',
    newest: 'e1',
  },
  {
    id: 'chain-accept-superseded-own-offer',
    build: (l) => (
      l.offer('s', 'e0', S, X, 1, null),
      l.offer('s', 'e1', S, X, 2, 'e0'),
      l.answer('r', 'e2', X, S, 'accept', 'e0')
    ),
    outcome: 'valid',
    newest: 'e1',
  },
  {
    id: 'chain-accept-conflicted-offer',
    build: (l) => (conflictBase(l), l.answer('r', 'e3', X, S, 'accept', 'e1')),
    outcome: 'refused',
    newest: 'e0',
  },
  {
    id: 'chain-accept-created-at-valid-until',
    build: (l) => (
      l.offer('s', 'e0', S, X, 1, null),
      l.offer('s', 'e1', S, X, 2, 'e0'),
      l.answer('r', 'e2', X, S, 'accept', 'e1', { t: 604_800 })
    ),
    outcome: 'valid',
    newest: 'e1',
  },
  {
    id: 'chain-accept-created-at-after-valid-until',
    build: (l) => (
      l.offer('s', 'e0', S, X, 1, null),
      l.offer('s', 'e1', S, X, 2, 'e0'),
      l.answer('r', 'e2', X, S, 'accept', 'e1', { t: 604_801 })
    ),
    outcome: 'refused',
    newest: 'e1',
  },
  {
    id: 'chain-reject-message',
    build: (l) => (
      l.offer('s', 'e0', S, X, 1, null),
      l.offer('s', 'e1', S, X, 2, 'e0'),
      l.answer('r', 'e2', X, S, 'reject', 'e1')
    ),
    outcome: 'valid',
    newest: 'e1',
  },
  {
    id: 'chain-reject-created-at-after-valid-until',
    build: (l) => (
      l.offer('s', 'e0', S, X, 1, null),
      l.offer('s', 'e1', S, X, 2, 'e0'),
      l.answer('r', 'e2', X, S, 'reject', 'e1', { t: 604_801 })
    ),
    outcome: 'refused',
    newest: 'e1',
  },
  {
    id: 'chain-reject-path-b-locked',
    build: (l) => (
      l.offer('r', 'e0', Y, S, 1, null),
      l.answer('s', 'e1', S, Y, 'accept', 'e0'),
      l.answer('r', 'e2', Y, S, 'reject', 'e0')
    ),
    outcome: 'refused',
    newest: 'e0',
  },
  {
    id: 'chain-reject-path-b-names-accept',
    build: (l) => (
      l.offer('r', 'e0', Y, S, 1, null),
      l.answer('s', 'e1', S, Y, 'accept', 'e0'),
      l.answer('r', 'e2', Y, S, 'reject', 'e0', { replyTo: 'e1' })
    ),
    outcome: 'refused',
    newest: 'e0',
  },
  {
    id: 'chain-reject-own-offer-not-accepted',
    build: (l) => (l.offer('r', 'e0', Y, S, 1, null), l.answer('r', 'e1', Y, S, 'reject', 'e0')),
    outcome: 'refused',
    newest: 'e0',
  },
];

describe('the negotiation chain rebuilt from the store: every chainReceive case (04 §3.4, D-74)', () => {
  it('covers the 52 chainReceive cases of the terms vectors', () => {
    expect(RECEIVE).toHaveLength(52);
    expect(new Set(RECEIVE.map((c) => c.id)).size).toBe(52);
  });

  for (const c of RECEIVE) {
    it(c.id, () => {
      const l = new Log();
      const incoming = c.build(l);
      const store = new ChainStore();
      // The log before the incoming step (the incoming one is the last step pushed).
      const steps = l.steps;
      const last = steps.lastIndexOf(incoming);
      for (const step of steps.slice(0, last)) store.apply(step);
      expect(store.apply(incoming)).toBe(c.outcome);
      const pair = c.pair ?? incoming.terms.parties;
      const newest = store.newest(pair as readonly Party[]);
      if (c.newest === null) {
        expect(newest).toEqual({ version: 0, hash: null });
      } else {
        expect(newest).toEqual({ version: l.terms(c.newest).version, hash: l.hash(c.newest) });
      }
    });
  }
});

const C = X; // the contact of the nextOffer and sendAccept cases

describe('the sending side over the rebuilt store: nextOffer and sendAccept cases (04 §3.4)', () => {
  const link = (build: (l: Log) => void, pair: readonly Party[] = [S, C]) => {
    const l = new Log();
    build(l);
    const store = new ChainStore();
    for (const step of l.steps) store.apply(step);
    const n = store.stable().get(negotiationKey(TERMS_ID, pair));
    return {
      l,
      link: nextTermsLink(n?.state ?? { offers: [], conflicts: [], lockedVersions: [] }, S),
    };
  };

  it('next-new: version 1, no pointer, no replyTo', () => {
    expect(link(() => {}).link).toEqual({ version: 1, previousTermsHash: null, replyTo: null });
  });
  it('next-after-counter: newest + 1 on the newest hash', () => {
    const r = link((l) => (l.offer('s', 'e0', S, C, 1, null), l.offer('r', 'e1', C, S, 2, 'e0')));
    expect(r.link).toEqual({ version: 3, previousTermsHash: r.l.hash('e1'), replyTo: null });
  });
  it('next-ignores-pointer: a refused counterparty pointer never moves the chain', () => {
    const r = link((l) => (l.offer('s', 'e0', S, C, 1, null), l.offer('r', 'e1', C, S, 3, 'e0')));
    expect(r.link).toEqual({ version: 2, previousTermsHash: r.l.hash('e0'), replyTo: null });
  });
  it('next-other-pair: a termsId of another pair starts a new negotiation', () => {
    const r = link(
      (l) => (
        l.offer('r', 'e0', O, S, 1, null),
        l.offer('s', 'e1', S, O, 2, 'e0'),
        l.offer('r', 'e2', O, S, 3, 'e1')
      ),
    );
    expect(r.link).toEqual({ version: 1, previousTermsHash: null, replyTo: null });
  });
  it('next-after-accept: a new version after the accepted one', () => {
    const r = link(
      (l) => (
        l.offer('s', 'e0', S, C, 1, null),
        l.offer('s', 'e1', S, C, 2, 'e0'),
        l.answer('r', 'e2', C, S, 'accept', 'e1')
      ),
    );
    expect(r.link).toEqual({ version: 3, previousTermsHash: r.l.hash('e1'), replyTo: null });
  });
  it("next-after-conflict: the resend names the other side's envelope", () => {
    const r = link((l) => conflictBase(l));
    expect(r.link).toEqual({ version: 2, previousTermsHash: r.l.hash('e0'), replyTo: idOf('e2') });
  });
  it('next-after-own-resend: links to the own resend', () => {
    const r = link(
      (l) => (
        conflictBase(l),
        l.offer('s', 'e3', S, C, 2, 'e0', { subject: "A's resend", replyTo: 'e2' })
      ),
    );
    expect(r.link).toEqual({ version: 3, previousTermsHash: r.l.hash('e3'), replyTo: null });
  });

  const accept = (build: (l: Log) => void, answers: string, now = T0) => {
    const l = new Log();
    build(l);
    const store = new ChainStore();
    for (const step of l.steps) store.apply(step);
    const negs = store.stable();
    const id = idOf(answers);
    const n = [...negs.values()].find((x) => x.state.offers.some((o) => o.envelopeId === id));
    return {
      l,
      r: n === undefined ? ({ result: 'refuse' } as const) : checkSendAccept(n.state, id, S, now),
    };
  };
  const base = (l: Log) => (l.offer('s', 'e0', S, C, 1, null), l.offer('r', 'e1', C, S, 2, 'e0'));

  it('send-accept-newest', () => {
    const { l, r } = accept(base, 'e1');
    expect(r).toEqual({ result: 'allowed', termsHash: l.hash('e1') });
  });
  it('send-accept-at-valid-until', () => {
    expect(accept(base, 'e1', VU).r.result).toBe('allowed');
  });
  it('send-accept-expired', () => {
    expect(accept(base, 'e1', VU + 1).r.result).toBe('refuse');
  });
  it('send-accept-superseded', () => {
    expect(accept((l) => (base(l), l.offer('s', 'e2', S, C, 3, 'e1')), 'e1').r.result).toBe(
      'refuse',
    );
  });
  it('send-accept-older-version', () => {
    const r = accept(
      (l) => (
        l.offer('r', 'e0', Y, S, 1, null),
        l.offer('s', 'e1', S, Y, 2, 'e0'),
        l.offer('r', 'e2', Y, S, 3, 'e1')
      ),
      'e0',
    );
    expect(r.r.result).toBe('refuse');
  });
  it('send-accept-own-offer', () => {
    expect(accept(base, 'e0').r.result).toBe('refuse');
  });
  it('send-accept-refused-offer', () => {
    const r = accept(
      (l) => (l.offer('s', 'e0', S, C, 1, null), l.offer('r', 'e1', C, S, 3, 'e0')),
      'e1',
    );
    expect(r.r.result).toBe('refuse');
  });
  it('send-accept-conflicted', () => {
    expect(accept(conflictBase, 'e2').r.result).toBe('refuse');
  });
  it('send-accept-resend', () => {
    const { l, r } = accept(
      (lg) => (
        conflictBase(lg),
        lg.offer('r', 'e3', C, S, 2, 'e0', { subject: "B's resend", replyTo: 'e1' })
      ),
      'e3',
    );
    expect(r).toEqual({ result: 'allowed', termsHash: l.hash('e3') });
  });
  it('send-accept-locked', () => {
    expect(accept((l) => (base(l), l.answer('s', 'e2', S, C, 'accept', 'e1')), 'e1').r.result).toBe(
      'refuse',
    );
  });
  it('send-accept-unknown-envelope', () => {
    expect(accept(base, 'e2').r.result).toBe('refuse');
  });
});

describe('replay order (terms-store.ts)', () => {
  it('never depends on a sender-chosen createdAt across versions or rounds', () => {
    const l = new Log();
    conflictBase(l);
    l.offer('r', 'e3', X, S, 2, 'e0', { subject: "B's resend", replyTo: 'e1', t: -500 });
    const store = new ChainStore();
    for (const step of l.steps) store.apply(step);
    const order = replayOrder(store.stored).map((r) => r.envelopeId);
    // Version 1, then version 2 round 0 (own first), then the resend (round 1), whatever the times.
    expect(order).toEqual(['e0', 'e1', 'e2', 'e3'].map(idOf));
  });
});
