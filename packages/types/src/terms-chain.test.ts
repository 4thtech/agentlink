// M1-21 (D-55, D-74): the pure negotiation-chain reducer (04 §3.4 "Negotiation chain", no forks rules
// 1-4, "Canonical-form and chain clarifications"). A core replays its own store through
// `recordSentTerms` and `receiveTerms`; duplicates (same envelopeHash) are dropped before, on the
// receive path (D-71 (3)), and `termsHash` is recomputed by the core with @4thtech-io/crypto.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_NEGOTIATION,
  checkSendAccept,
  negotiationKey,
  newestOpenOffer,
  nextTermsLink,
  receiveTerms,
  recordSentTerms,
  sameTermsHash,
  type NegotiationState,
  type Terms,
  type TermsEnvelope,
} from './index.js';
import { AGENT_EVM, CONTACT_A, CONTACT_B, b64u, hex, terms } from './testing/fixtures.js';

// A = AGENT_EVM (0x1a…) < B = CONTACT_A (0x3d…): parties [A, B].
const A = AGENT_EVM;
const B = CONTACT_A;
const C = CONTACT_B;
const T0 = 1_790_000_000;
const VALID_UNTIL = T0 + 604_800;
const H = (n: number) => hex(32, (0xa0 + n).toString(16));
const ID = (n: number) => b64u(16, String.fromCharCode(0x41 + n));

interface Spec {
  id: number;
  from: string;
  type?: 'offer' | 'accept' | 'reject';
  version: number;
  hash: number;
  prev?: number | null;
  replyTo?: number | null;
  createdAt?: number;
  parties?: [string, string];
}

/** An envelope of the pair; its terms carry `version` and the pointer `prev` (a hash number). */
function env(s: Spec): TermsEnvelope {
  const parties = s.parties ?? [A, B];
  const to = s.from === parties[0] ? parties[1] : parties[0];
  const t = terms({
    termsId: b64u(16, 'T'),
    parties,
    deliverables: [{ id: 'd1', description: 'x', by: parties[1], plaintextSha256: null }],
    price: null,
    deadlines: [],
    subject: `v${s.version} #${s.hash}`,
    version: s.version,
    validUntil: VALID_UNTIL,
    previousTermsHash:
      s.prev === undefined
        ? s.version === 1
          ? null
          : H(s.hash - 1)
        : s.prev === null
          ? null
          : H(s.prev),
  }) as unknown as Terms;
  return {
    envelopeId: ID(s.id),
    sender: s.from,
    recipient: to,
    createdAt: s.createdAt ?? T0,
    type: s.type ?? 'offer',
    replyTo: s.replyTo === undefined || s.replyTo === null ? null : ID(s.replyTo),
    terms: t,
    termsHash: H(s.hash),
  };
}

type Step = ['sent' | 'received', Spec];

/** Replays a log as `self` and returns the state (refused received envelopes change nothing). */
function replay(self: string, log: Step[]): NegotiationState {
  let state = EMPTY_NEGOTIATION;
  for (const [dir, spec] of log) {
    const e = env(spec);
    state = dir === 'sent' ? recordSentTerms(state, e) : receiveTerms(state, e, self).state;
  }
  return state;
}

const receive = (self: string, log: Step[], incoming: Spec) =>
  receiveTerms(replay(self, log), env(incoming), self);

const newest = (state: NegotiationState) => {
  const head = newestOpenOffer(state.offers);
  return head === undefined ? [0, null] : [head.version, head.termsHash];
};

describe('negotiation key and hash comparison', () => {
  it('termsId plus the unordered pair; another pair is another negotiation', () => {
    const id = b64u(16, 'T');
    expect(negotiationKey(id, [A, B])).toBe(negotiationKey(id, [B, A]));
    expect(negotiationKey(id, [A, B])).not.toBe(negotiationKey(id, [A, C]));
    expect(negotiationKey(id, [A, B])).not.toBe(negotiationKey(b64u(16, 'U'), [A, B]));
  });
  it('sameTermsHash compares canonical bytes only', () => {
    expect(sameTermsHash(H(1), H(1))).toBe(true);
    expect(sameTermsHash(H(1), H(2))).toBe(false);
    expect(sameTermsHash(H(1), H(1).toUpperCase())).toBe(false);
    expect(sameTermsHash(`0x${H(1)}`, `0x${H(1)}`)).toBe(false);
    expect(sameTermsHash(null, null)).toBe(false);
  });
});

describe('the chain link', () => {
  it('accepts version 1 on an empty store and newest + 1 on the newest hash', () => {
    const r1 = receive(B, [], { id: 0, from: A, version: 1, hash: 1 });
    expect(r1.outcome).toBe('valid');
    expect(newest(r1.state)).toEqual([1, H(1)]);
    const r2 = receive(A, [['sent', { id: 0, from: A, version: 1, hash: 1 }]], {
      id: 1,
      from: B,
      version: 2,
      hash: 2,
    });
    expect(r2.outcome).toBe('valid');
    expect(newest(r2.state)).toEqual([2, H(2)]);
  });

  it('refuses a first offer that is not version 1, a gap, an older or unknown pointer', () => {
    expect(receive(B, [], { id: 0, from: A, version: 2, hash: 2 }).outcome).toBe('refused');
    const log: Step[] = [
      ['received', { id: 0, from: B, version: 1, hash: 1 }],
      ['sent', { id: 1, from: A, version: 2, hash: 2 }],
    ];
    expect(receive(A, log, { id: 2, from: B, version: 4, hash: 4, prev: 2 }).outcome).toBe(
      'refused',
    );
    expect(receive(A, log, { id: 2, from: B, version: 3, hash: 3, prev: 1 }).outcome).toBe(
      'refused',
    );
    expect(receive(A, log, { id: 2, from: B, version: 3, hash: 3, prev: 9 }).outcome).toBe(
      'refused',
    );
    // An old version re-sent as new, with a newer version on top, is stale.
    const top: Step[] = [...log, ['received', { id: 2, from: B, version: 3, hash: 3 }]];
    expect(receive(A, top, { id: 3, from: B, version: 2, hash: 7, prev: 1 }).outcome).toBe(
      'refused',
    );
  });

  it('refuses terms whose parties are not exactly the sender and the receiver', () => {
    const r = receive(A, [], { id: 0, from: B, version: 1, hash: 1, parties: [A, C] });
    expect(r.outcome).toBe('refused');
    expect(r.reason).toBe('not_a_party');
    expect(newest(r.state)).toEqual([0, null]);
  });
});

describe('no forks', () => {
  const base: Step[] = [
    ['sent', { id: 0, from: A, version: 1, hash: 1 }],
    ['received', { id: 1, from: B, version: 2, hash: 2 }],
  ];

  it('rule 1: a second, different envelope for one version from the same sender is refused', () => {
    const r = receive(A, base, { id: 2, from: B, version: 2, hash: 3, prev: 1 });
    expect(r.outcome).toBe('refused');
    expect(r.reason).toBe('same_sender');
    // The first one seen wins even after a refused second one.
    const again = receive(
      A,
      [...base, ['received', { id: 2, from: B, version: 2, hash: 3, prev: 1 }]],
      { id: 3, from: B, version: 2, hash: 4, prev: 1 },
    );
    expect(again.outcome).toBe('refused');
    expect(newest(again.state)).toEqual([2, H(2)]);
  });

  it('rule 2: a version is locked once an accept was sent or received', () => {
    const sentAccept: Step[] = [
      ...base,
      ['sent', { id: 2, from: A, type: 'accept', version: 2, hash: 2, prev: 1, replyTo: 1 }],
    ];
    expect(receive(A, sentAccept, { id: 3, from: B, version: 2, hash: 3, prev: 1 }).reason).toBe(
      'locked',
    );
    const received: Step[] = [
      ['sent', { id: 0, from: A, version: 1, hash: 1 }],
      ['sent', { id: 1, from: A, version: 2, hash: 2 }],
      ['received', { id: 2, from: B, type: 'accept', version: 2, hash: 2, replyTo: 1 }],
    ];
    const counter = receive(A, received, { id: 3, from: B, version: 2, hash: 3, prev: 1 });
    expect(counter.reason).toBe('locked');
    expect(newest(counter.state)).toEqual([2, H(2)]);
    const second = receive(A, received, {
      id: 3,
      from: B,
      type: 'accept',
      version: 2,
      hash: 2,
      replyTo: 1,
      createdAt: T0 + 1,
    });
    expect(second.outcome).toBe('refused');
    // Rule 2 takes precedence over a resend.
    expect(
      receive(A, received, { id: 3, from: B, version: 2, hash: 3, prev: 1, replyTo: 1 }).outcome,
    ).toBe('refused');
    // Only the accepted version is locked: n + 1 continues (D-74 Q15).
    const amend = receive(A, received, { id: 3, from: B, version: 3, hash: 3, prev: 2 });
    expect(amend.outcome).toBe('valid');
    expect(newest(amend.state)).toEqual([3, H(3)]);
  });

  it('rule 3: concurrent counters are a conflict on both sides; the previous version stays newest', () => {
    const a = receive(
      A,
      [
        ['sent', { id: 0, from: A, version: 1, hash: 1 }],
        ['sent', { id: 1, from: A, version: 2, hash: 2 }],
      ],
      { id: 2, from: B, version: 2, hash: 3, prev: 1 },
    );
    expect(a.outcome).toBe('conflict');
    expect(newest(a.state)).toEqual([1, H(1)]);
    const b = receive(
      B,
      [
        ['received', { id: 0, from: A, version: 1, hash: 1 }],
        ['sent', { id: 2, from: B, version: 2, hash: 3, prev: 1 }],
      ],
      { id: 1, from: A, version: 2, hash: 2 },
    );
    expect(b.outcome).toBe('conflict');
    expect(newest(b.state)).toEqual([1, H(1)]);
    // A conflicted offer is never a base.
    expect(receive(A, logConflict, { id: 3, from: B, version: 3, hash: 4, prev: 3 }).outcome).toBe(
      'refused',
    );
  });
});

// A sent v1 (e0) and v2 (e1); B's v2 (e2) arrived: conflict on version 2.
const logConflict: Step[] = [
  ['sent', { id: 0, from: A, version: 1, hash: 1 }],
  ['sent', { id: 1, from: A, version: 2, hash: 2 }],
  ['received', { id: 2, from: B, version: 2, hash: 3, prev: 1 }],
];

describe('D-74 resend after a conflict (Q17, IR-D-74-1 F01)', () => {
  it('the next offer is a resend for the conflicted version, naming the other side’s envelope', () => {
    expect(nextTermsLink(replay(A, logConflict), A)).toEqual({
      version: 2,
      previousTermsHash: H(1),
      replyTo: ID(2),
    });
    const ownResend = replay(A, [
      ...logConflict,
      ['sent', { id: 3, from: A, version: 2, hash: 4, prev: 1, replyTo: 2 }],
    ]);
    expect(nextTermsLink(ownResend, A)).toEqual({
      version: 3,
      previousTermsHash: H(4),
      replyTo: null,
    });
  });

  it('item 2: the other side’s first resend naming this side’s envelope is valid', () => {
    const r = receive(A, logConflict, { id: 3, from: B, version: 2, hash: 4, prev: 1, replyTo: 1 });
    expect(r.outcome).toBe('valid');
    expect(newest(r.state)).toEqual([2, H(4)]);
    // A second resend from the same sender is refused (rule 1).
    const second = receive(
      A,
      [...logConflict, ['received', { id: 3, from: B, version: 2, hash: 4, prev: 1, replyTo: 1 }]],
      { id: 4, from: B, version: 2, hash: 5, prev: 1, replyTo: 1 },
    );
    expect(second.outcome).toBe('refused');
  });

  it('item 2/3: refused without the link, with an unknown or wrong link, or a wrong pointer', () => {
    for (const spec of [
      { id: 3, from: B, version: 2, hash: 4, prev: 1 },
      { id: 3, from: B, version: 2, hash: 4, prev: 1, replyTo: 9 },
      { id: 3, from: B, version: 2, hash: 4, prev: 1, replyTo: 0 },
      { id: 3, from: B, version: 2, hash: 4, prev: 1, replyTo: 2 },
      { id: 3, from: B, version: 2, hash: 4, prev: 3, replyTo: 1 },
    ] as Spec[]) {
      const r = receive(A, logConflict, spec);
      expect(r.outcome, JSON.stringify(spec)).toBe('refused');
      expect(newest(r.state)).toEqual([1, H(1)]);
    }
  });

  it('item 1: a resend that arrives before the original reveals the conflict; the original is then refused', () => {
    const before: Step[] = [
      ['sent', { id: 0, from: A, version: 1, hash: 1 }],
      ['sent', { id: 1, from: A, version: 2, hash: 2 }],
    ];
    const r = receive(A, before, { id: 3, from: B, version: 2, hash: 4, prev: 1, replyTo: 1 });
    expect(r.outcome).toBe('valid');
    expect(newest(r.state)).toEqual([2, H(4)]);
    const original = receive(
      A,
      [...before, ['received', { id: 3, from: B, version: 2, hash: 4, prev: 1, replyTo: 1 }]],
      { id: 2, from: B, version: 2, hash: 3, prev: 1 },
    );
    expect(original.outcome).toBe('refused');
    expect(newest(original.state)).toEqual([2, H(4)]);
  });

  it('item 4: two resends are a new conflict; the next resends name the other side’s resend', () => {
    const own: Step[] = [
      ...logConflict,
      ['sent', { id: 3, from: A, version: 2, hash: 4, prev: 1, replyTo: 2 }],
    ];
    const r = receive(A, own, { id: 4, from: B, version: 2, hash: 5, prev: 1, replyTo: 1 });
    expect(r.outcome).toBe('conflict');
    expect(newest(r.state)).toEqual([1, H(1)]);
    const after: Step[] = [
      ...own,
      ['received', { id: 4, from: B, version: 2, hash: 5, prev: 1, replyTo: 1 }],
    ];
    const ok = receive(A, after, { id: 5, from: B, version: 2, hash: 6, prev: 1, replyTo: 3 });
    expect(ok.outcome).toBe('valid');
    expect(newest(ok.state)).toEqual([2, H(6)]);
    const stale = receive(A, after, { id: 5, from: B, version: 2, hash: 6, prev: 1, replyTo: 1 });
    expect(stale.outcome).toBe('refused');
  });
});

describe('answers: accept and reject (D-74 Q13, Q14)', () => {
  const offers: Step[] = [
    ['sent', { id: 0, from: A, version: 1, hash: 1 }],
    ['sent', { id: 1, from: A, version: 2, hash: 2 }],
  ];
  const accept = (over: Partial<Spec> = {}): Spec => ({
    id: 2,
    from: B,
    type: 'accept',
    version: 2,
    hash: 2,
    replyTo: 1,
    ...over,
  });

  it('an accept naming this side’s open offer by replyTo with its exact terms is valid and locks', () => {
    const r = receive(A, offers, accept());
    expect(r.outcome).toBe('valid');
    expect(r.state.lockedVersions).toEqual([2]);
    expect(newest(r.state)).toEqual([2, H(2)]);
  });

  it('refuses a mismatched hash, other terms, no replyTo and the sender’s own offer', () => {
    expect(receive(A, offers, accept({ version: 1, hash: 1 })).outcome).toBe('refused');
    expect(receive(A, offers, accept({ hash: 7 })).outcome).toBe('refused');
    expect(receive(A, offers, accept({ replyTo: null })).outcome).toBe('refused');
    const theirs: Step[] = [
      ['sent', { id: 0, from: A, version: 1, hash: 1 }],
      ['received', { id: 1, from: B, version: 2, hash: 2 }],
    ];
    expect(receive(A, theirs, accept()).outcome).toBe('refused');
  });

  it('an accept of this side’s superseded offer is valid (path (b) warns at approval)', () => {
    const r = receive(A, offers, accept({ version: 1, hash: 1, replyTo: 0 }));
    expect(r.outcome).toBe('valid');
    expect(newest(r.state)).toEqual([2, H(2)]);
  });

  it('refuses an answer to a conflicted offer', () => {
    expect(receive(A, logConflict, accept({ id: 3 })).outcome).toBe('refused');
  });

  it('judges a received answer by its createdAt: valid at validUntil, refused after', () => {
    expect(receive(A, offers, accept({ createdAt: VALID_UNTIL })).outcome).toBe('valid');
    expect(receive(A, offers, accept({ createdAt: VALID_UNTIL + 1 })).outcome).toBe('refused');
    expect(receive(A, offers, accept({ type: 'reject', createdAt: VALID_UNTIL + 1 })).outcome).toBe(
      'refused',
    );
  });

  it('a reject is valid, does not lock, and is refused on a locked version (rule 2 first)', () => {
    const r = receive(A, offers, accept({ type: 'reject' }));
    expect(r.outcome).toBe('valid');
    expect(r.state.lockedVersions).toEqual([]);
    // Path (b): B accepted A's v1; A's reject naming its own offer is refused (locked).
    const pathB: Step[] = [
      ['received', { id: 0, from: A, version: 1, hash: 1 }],
      ['sent', { id: 1, from: B, type: 'accept', version: 1, hash: 1, replyTo: 0 }],
    ];
    expect(
      receive(B, pathB, { id: 2, from: A, type: 'reject', version: 1, hash: 1, replyTo: 0 })
        .outcome,
    ).toBe('refused');
    expect(
      receive(B, pathB, { id: 2, from: A, type: 'reject', version: 1, hash: 1, replyTo: 1 })
        .outcome,
    ).toBe('refused');
    // A reject naming the sender's own offer that was never accepted is refused.
    expect(
      receive(B, [['received', { id: 0, from: A, version: 1, hash: 1 }]], {
        id: 1,
        from: A,
        type: 'reject',
        version: 1,
        hash: 1,
        replyTo: 0,
      }).outcome,
    ).toBe('refused');
  });
});

describe('checkSendAccept (04 §3.4 sending an accept)', () => {
  const log: Step[] = [
    ['sent', { id: 0, from: A, version: 1, hash: 1 }],
    ['received', { id: 1, from: B, version: 2, hash: 2 }],
  ];
  const check = (steps: Step[], id: number, now = T0) =>
    checkSendAccept(replay(A, steps), ID(id), A, now);

  it('allows the newest received open offer up to and including validUntil', () => {
    expect(check(log, 1)).toEqual({ result: 'allowed', termsHash: H(2) });
    expect(check(log, 1, VALID_UNTIL).result).toBe('allowed');
    expect(check(log, 1, VALID_UNTIL + 1)).toEqual({ result: 'refuse', reason: 'expired' });
  });

  it('refuses superseded, own, unknown, conflicted and locked offers', () => {
    expect(check([...log, ['sent', { id: 2, from: A, version: 3, hash: 3 }]], 1).result).toBe(
      'refuse',
    );
    expect(check(log, 0).result).toBe('refuse');
    expect(check(log, 7).result).toBe('refuse');
    expect(check(logConflict, 2).result).toBe('refuse');
    expect(
      check(
        [...log, ['sent', { id: 2, from: A, type: 'accept', version: 2, hash: 2, replyTo: 1 }]],
        1,
      ).result,
    ).toBe('refuse');
  });

  it('allows the other side’s resend after a conflict', () => {
    const steps: Step[] = [
      ...logConflict,
      ['received', { id: 3, from: B, version: 2, hash: 4, prev: 1, replyTo: 1 }],
    ];
    expect(check(steps, 3)).toEqual({ result: 'allowed', termsHash: H(4) });
  });
});

describe('totality', () => {
  it('never throws on hostile input', () => {
    fc.assert(
      fc.property(fc.anything(), fc.anything(), fc.anything(), (a, b, c) => {
        expect(() => receiveTerms(a as never, b as never, c as never)).not.toThrow();
        expect(() => recordSentTerms(a as never, b as never)).not.toThrow();
        expect(() => nextTermsLink(a as never, c as never)).not.toThrow();
        expect(() => checkSendAccept(a as never, b as never, c as never, 0)).not.toThrow();
      }),
      { numRuns: 200, seed: 0x7e24 },
    );
  });
  it('refuses invalid input instead of changing the state', () => {
    const r = receiveTerms(EMPTY_NEGOTIATION, null as never, A);
    expect(r.outcome).toBe('refused');
    expect(r.state).toBe(EMPTY_NEGOTIATION);
  });
});
