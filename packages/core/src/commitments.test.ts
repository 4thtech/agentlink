// M1-20 (S2): the commitments policy (D-31, D-55; 06 §3 "Commitments"; 04 §2.5, §3.4.2). Pure.
// - The default is `approval`; `deny` blocks; `allow` allows; a fail-closed policy asks (G-6).
// - Auto-accept only for an allowlisted contact, only in the owner's direction, only for a price in
//   the USD set (04 §3.4: USD, USDC, USDT, XDAI) that is not null, within the limits; never for a
//   `REJECTED` receipt or a firm offer; anything it cannot evaluate asks the owner (fail closed).
// - An `allow` is a policy grant bound to the scope and the verified policy's hash; it is re-checked
//   before each part and asks the owner once the policy changed (D-55).
// - The rule reads only the verified policy and the core's own scope and stored terms (I-4, I-5).
// - Commitments are never batch items (D-68, 04 §2.5.2), including `accepted`/`rejected`
//   acknowledgements (D-31).
import { encodeBase64url, termsHash } from '@agentlink/crypto';
import { POLICY_DEFAULTS, TERMS_TOKEN_SYMBOLS, defaultPolicy, type Policy } from '@agentlink/types';
import { describe, expect, it } from 'vitest';
import {
  AUTO_ACCEPT_USD_CURRENCIES,
  checkCommitmentBinding,
  commitmentParts,
  commitmentVoidedByPolicy,
  evaluateCommitment,
  isCommitmentAction,
  policyDocumentHash,
  recheckCommitmentGrant,
  type AutoAcceptMiss,
  type CommitmentEvaluation,
  type CommitmentFacts,
} from './commitments.js';
import { computeActionDigest } from './owner-action.js';
import { evaluate, type EffectivePolicy } from './policy-engine.js';

const SELF = `0x${'1a'.repeat(20)}`;
const C = `0x${'3d'.repeat(20)}`; // the counterparty (sorts after SELF)
const D = `0x${'4e'.repeat(20)}`; // another contact
const id16 = (byte: number) => encodeBase64url(new Uint8Array(16).fill(byte));
const TERMS_ID = id16(0x54);

type Obj = Record<string, unknown>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Buy terms: this agent pays `amount` USD, the counterparty delivers everything. */
const buyTerms = (over: Obj = {}): Obj => ({
  termsId: TERMS_ID,
  version: 2,
  parties: [SELF, C],
  subject: 'Logo design',
  deliverables: [{ id: 'd1', description: 'Three logo drafts', by: C, plaintextSha256: null }],
  price: { amount: '10', currency: 'USD', payer: SELF },
  deadlines: [],
  validUntil: 1_760_600_000,
  previousTermsHash: 'ab'.repeat(32),
  ...over,
});
/** Sell terms: the counterparty pays, this agent delivers everything. */
const sellTerms = (amount = '10'): Obj =>
  buyTerms({
    deliverables: [{ id: 'd1', description: 'Three logo drafts', by: SELF, plaintextSha256: null }],
    price: { amount, currency: 'USD', payer: C },
  });
const withPrice = (price: Obj | null): Obj => buyTerms({ price });
const priced = (amount: string, currency = 'USD', payer = SELF): Obj =>
  withPrice({ amount, currency, payer });

/** The scope the core builds for these terms (04 §3.4.2). */
const scopeFor = (terms: Obj, over: Obj = {}): Obj => {
  const decision = (over.decision as string | undefined) ?? 'accept';
  const offer = decision === 'offer';
  return {
    v: 1,
    kind: 'agentlink/commitment',
    agentId: SELF,
    decision,
    counterparty: { agentId: C, ownerKey: 'c4'.repeat(32) },
    thread: id16(0x01),
    termsId: terms.termsId,
    version: terms.version,
    termsHash: termsHash(terms),
    answers: offer ? null : { envelopeId: id16(0x02), envelopeHash: `0x${'e1'.repeat(32)}` },
    notarize: offer,
    maxFeeUsd: offer ? '0.1' : null,
    createdAt: 1_760_000_000,
    expiresAt: 1_760_500_000,
    ...over,
  };
};
const facts = (terms: Obj = buyTerms(), over: Obj = {}): CommitmentFacts => ({
  kind: 'terms',
  self: SELF,
  scope: scopeFor(terms, over),
  terms,
});

const signed = (edit: (p: Policy) => void = () => {}): EffectivePolicy & { mode: 'signed' } => {
  const p = defaultPolicy();
  edit(p);
  return { mode: 'signed', policy: p, version: 2 };
};
/** Buy auto-accept for C up to `max`. */
const autoBuy = (max = '20', edit: (p: Policy) => void = () => {}) =>
  signed((p) => {
    p.commitments.autoAcceptContacts = [C];
    p.commitments.autoAcceptMaxUSD = max;
    edit(p);
  });
/** Sell auto-accept for C from `min`. */
const autoSell = (min: string | null = '5') =>
  signed((p) => {
    p.commitments.autoAcceptContacts = [C];
    p.commitments.autoAcceptDirection = 'sell';
    p.commitments.autoAcceptMinUSD = min;
  });
const defaults: EffectivePolicy = { mode: 'defaults', policy: POLICY_DEFAULTS };
const failClosed: EffectivePolicy = { mode: 'fail_closed', problem: 'tampered' };

const asks = (e: CommitmentEvaluation): AutoAcceptMiss | undefined =>
  e.decision === 'approval' ? e.autoAccept : undefined;

// --- the default and the plain rule ---------------------------------------------------------------

describe('commitments.accept: the default asks the owner (D-31)', () => {
  it('the 06 §3 defaults: accept approval, no contacts, max "0", buy, sell off', () => {
    expect(POLICY_DEFAULTS.commitments).toEqual({
      accept: 'approval',
      autoAcceptContacts: [],
      autoAcceptMaxUSD: '0',
      autoAcceptDirection: 'buy',
      autoAcceptMinUSD: null,
    });
  });

  it('every decision under the defaults is approval (pending_approval)', () => {
    for (const decision of ['accept', 'reject', 'confirm', 'offer'] as const) {
      const e = evaluateCommitment(defaults, facts(buyTerms(), { decision }));
      expect(e.decision).toBe('approval');
    }
    expect(evaluateCommitment(defaults, { kind: 'acknowledge', receipt: 'ACCEPTED' })).toEqual({
      decision: 'approval',
      autoAccept: 'not_terms',
    });
  });

  it('an allowlisted contact under the default maximum "0" still asks', () => {
    const p = signed((x) => (x.commitments.autoAcceptContacts = [C]));
    expect(asks(evaluateCommitment(p, facts()))).toBe('over_maximum');
  });

  it('deny blocks every commitment, also within the limits', () => {
    const p = autoBuy('20', (x) => (x.commitments.accept = 'deny'));
    for (const decision of ['accept', 'reject', 'confirm', 'offer'] as const) {
      expect(evaluateCommitment(p, facts(buyTerms(), { decision }))).toEqual({ decision: 'deny' });
    }
    expect(evaluateCommitment(p, { kind: 'acknowledge', receipt: 'REJECTED' })).toEqual({
      decision: 'deny',
    });
  });

  it('allow covers every decision, REJECTED and firm offers included, as a rule grant', () => {
    const p = signed((x) => (x.commitments.accept = 'allow'));
    for (const decision of ['accept', 'reject', 'confirm', 'offer'] as const) {
      expect(evaluateCommitment(p, facts(buyTerms(), { decision }))).toEqual({
        decision: 'allow',
        grant: { basis: 'rule', policyHash: policyDocumentHash(p.policy) },
      });
    }
    expect(evaluateCommitment(p, { kind: 'acknowledge', receipt: 'REJECTED' }).decision).toBe(
      'allow',
    );
  });

  it('a fail-closed policy asks for every commitment and never allows or denies (G-6)', () => {
    for (const decision of ['accept', 'reject', 'confirm', 'offer'] as const) {
      expect(evaluateCommitment(failClosed, facts(buyTerms(), { decision }))).toEqual({
        decision: 'approval',
        autoAccept: 'policy_invalid',
      });
    }
    expect(evaluateCommitment(failClosed, { kind: 'acknowledge', receipt: 'ACCEPTED' })).toEqual({
      decision: 'approval',
      autoAccept: 'policy_invalid',
    });
  });

  it('the policy hash is sha256(JCS(policy)), as the store keeps it (owner-actions)', () => {
    const p = autoBuy();
    expect(policyDocumentHash(p.policy)).toBe(computeActionDigest(p.policy));
    expect(policyDocumentHash(p.policy)).not.toBe(policyDocumentHash(autoBuy('21').policy));
  });
});

// --- auto-accept limits ---------------------------------------------------------------------------

interface Row {
  readonly name: string;
  readonly policy: EffectivePolicy;
  readonly facts: CommitmentFacts;
  /** `allow` (an auto-accept grant) or the reason auto-accept did not apply. */
  readonly expected: 'allow' | AutoAcceptMiss;
}

const ROWS: readonly Row[] = [
  // buy (the default direction)
  { name: 'buy, under the limit', policy: autoBuy('20'), facts: facts(), expected: 'allow' },
  { name: 'buy, at the limit', policy: autoBuy('10'), facts: facts(), expected: 'allow' },
  {
    name: 'buy, trailing zeros are the same amount',
    policy: autoBuy('10'),
    facts: facts(priced('10.000000')),
    expected: 'allow',
  },
  {
    name: 'buy, 1 micro over the limit',
    policy: autoBuy('10'),
    facts: facts(priced('10.000001')),
    expected: 'over_maximum',
  },
  {
    name: 'buy, far over any limit (18 digits)',
    policy: autoBuy('999999999.999999'),
    facts: facts(priced('999999999999999999')),
    expected: 'over_maximum',
  },
  {
    name: 'contact not allowlisted',
    policy: signed((p) => {
      p.commitments.autoAcceptContacts = [D];
      p.commitments.autoAcceptMaxUSD = '20';
    }),
    facts: facts(),
    expected: 'contact_not_listed',
  },
  { name: 'confirm (ACCEPTED on their ACCEPT)', policy: autoBuy(), facts: facts(buyTerms(), { decision: 'confirm' }), expected: 'allow' },
  // never covered by the limits
  {
    name: 'REJECTED for an allowlisted contact under the limit',
    policy: autoBuy(),
    facts: facts(buyTerms(), { decision: 'reject' }),
    expected: 'reject',
  },
  {
    name: 'a firm offer within the limits',
    policy: autoBuy(),
    facts: facts(buyTerms(), { decision: 'offer' }),
    expected: 'firm_offer',
  },
  // price and currency (04 §3.4 USD set)
  { name: 'price is null', policy: autoBuy(), facts: facts(withPrice(null)), expected: 'no_price' },
  { name: 'EUR', policy: autoBuy(), facts: facts(priced('10', 'EUR')), expected: 'currency' },
  { name: 'DAI (passes the grammar)', policy: autoBuy(), facts: facts(priced('10', 'DAI')), expected: 'currency' },
  { name: 'ETH', policy: autoBuy(), facts: facts(priced('10', 'ETH')), expected: 'currency' },
  { name: 'USDC', policy: autoBuy(), facts: facts(priced('10', 'USDC')), expected: 'allow' },
  { name: 'USDT', policy: autoBuy(), facts: facts(priced('10', 'USDT')), expected: 'allow' },
  { name: 'XDAI', policy: autoBuy(), facts: facts(priced('10', 'XDAI')), expected: 'allow' },
  // direction (IR-D55-1 F01)
  {
    name: 'buy, but the contact pays',
    policy: autoBuy(),
    facts: facts(priced('10', 'USD', C)),
    expected: 'direction',
  },
  {
    name: 'buy, but this agent delivers an item',
    policy: autoBuy(),
    facts: facts(
      buyTerms({
        deliverables: [
          { id: 'd1', description: 'Three logo drafts', by: C, plaintextSha256: null },
          { id: 'd2', description: 'A brief', by: SELF, plaintextSha256: null },
        ],
      }),
    ),
    expected: 'direction',
  },
  {
    name: 'buy, this agent delivers everything',
    policy: autoBuy(),
    facts: facts(sellTerms()),
    expected: 'direction',
  },
  { name: 'sell with autoAcceptMinUSD unset (default)', policy: autoSell(null), facts: facts(sellTerms()), expected: 'sell_off' },
  { name: 'sell, at the minimum', policy: autoSell('10'), facts: facts(sellTerms('10')), expected: 'allow' },
  { name: 'sell, above the minimum', policy: autoSell('5'), facts: facts(sellTerms('10')), expected: 'allow' },
  { name: 'sell, under the minimum', policy: autoSell('5'), facts: facts(sellTerms('4.99')), expected: 'under_minimum' },
  { name: 'sell, but this agent pays', policy: autoSell('5'), facts: facts(buyTerms()), expected: 'direction' },
  {
    name: 'sell, but the contact delivers an item',
    policy: autoSell('5'),
    facts: facts(
      buyTerms({
        deliverables: [
          { id: 'd1', description: 'Three logo drafts', by: SELF, plaintextSha256: null },
          { id: 'd2', description: 'A brief', by: C, plaintextSha256: null },
        ],
        price: { amount: '10', currency: 'USD', payer: C },
      }),
    ),
    expected: 'direction',
  },
  { name: 'sell, price null', policy: autoSell('5'), facts: facts(withPrice(null)), expected: 'no_price' },
  // terms the limits cannot evaluate (fail closed)
  {
    name: 'acknowledge on a record without terms',
    policy: autoBuy(),
    facts: { kind: 'acknowledge', receipt: 'ACCEPTED' },
    expected: 'not_terms',
  },
];

describe('auto-accept within the owner-signed limits (06 §3, 04 §3.4.2)', () => {
  for (const row of ROWS) {
    it(row.name, () => {
      const e = evaluateCommitment(row.policy, row.facts);
      if (row.expected === 'allow') {
        expect(e).toEqual({
          decision: 'allow',
          grant: {
            basis: 'auto_accept',
            policyHash: policyDocumentHash((row.policy as { policy: Policy }).policy),
          },
        });
      } else {
        expect(e).toEqual({ decision: 'approval', autoAccept: row.expected });
      }
      // evaluate() gives the same decision.
      expect(evaluate(row.policy, { kind: 'commitment', facts: row.facts })).toBe(e.decision);
    });
  }

  it('the USD set is exactly USD and the D-46 token symbols (D-74 F05)', () => {
    expect([...AUTO_ACCEPT_USD_CURRENCIES]).toEqual(['USD', ...TERMS_TOKEN_SYMBOLS]);
    expect([...AUTO_ACCEPT_USD_CURRENCIES]).toEqual(['USD', 'USDC', 'USDT', 'XDAI']);
  });
});

describe('amounts the schema refuses are never auto-accepted (IR-D55-1)', () => {
  for (const amount of ['0', '0.0', '-5', '1e3', '1,500', '01', '1.', '.5', '1.0000001', ' 5']) {
    it(`"${amount}" asks the owner, even with the widest limit`, () => {
      const t = priced(amount);
      expect(evaluateCommitment(autoBuy('999999999.999999'), facts(t))).toEqual({
        decision: 'approval',
        autoAccept: 'unevaluable',
      });
    });
  }
  it('a JSON number amount asks the owner', () => {
    const t = withPrice({ amount: 5, currency: 'USD', payer: SELF });
    expect(asks(evaluateCommitment(autoBuy(), facts(t)))).toBe('unevaluable');
  });
});

describe('only the exact stored terms are evaluated (I-5, D-55)', () => {
  it('terms that do not match the scope termsHash never auto-accept and never allow', () => {
    const t = buyTerms();
    const other = priced('9');
    const f: CommitmentFacts = { kind: 'terms', self: SELF, scope: scopeFor(t), terms: other };
    expect(asks(evaluateCommitment(autoBuy(), f))).toBe('unevaluable');
    // Even an explicit allow does not cover terms the scope does not bind.
    const allow = signed((p) => (p.commitments.accept = 'allow'));
    expect(asks(evaluateCommitment(allow, f))).toBe('unevaluable');
    // deny still wins.
    const deny = signed((p) => (p.commitments.accept = 'deny'));
    expect(evaluateCommitment(deny, f).decision).toBe('deny');
  });

  it('a scope for another agent, another version or another termsId asks', () => {
    const t = buyTerms();
    const cases: Obj[] = [
      { agentId: D },
      { version: 3 },
      { termsId: id16(0x55) },
      { counterparty: { agentId: D, ownerKey: 'c4'.repeat(32) } },
    ];
    for (const over of cases) {
      const f: CommitmentFacts = { kind: 'terms', self: SELF, scope: scopeFor(t, over), terms: t };
      expect(asks(evaluateCommitment(autoBuy(), f))).toBe('unevaluable');
    }
  });

  it('terms whose parties are not exactly this agent and the counterparty ask', () => {
    const t = buyTerms({ parties: [SELF, D], deliverables: [{ id: 'd1', description: 'x', by: D, plaintextSha256: null }] });
    expect(asks(evaluateCommitment(autoBuy(), facts(t)))).toBe('unevaluable');
  });

  it('an extra key in the terms or the scope (strict schemas) asks', () => {
    const t = { ...buyTerms(), autoAcceptMaxUSD: '1000000' };
    expect(asks(evaluateCommitment(autoBuy(), facts(t)))).toBe('unevaluable');
    const u = buyTerms();
    const f: CommitmentFacts = {
      kind: 'terms',
      self: SELF,
      scope: { ...scopeFor(u), policy: { commitments: { accept: 'allow' } } },
      terms: u,
    };
    expect(asks(evaluateCommitment(autoBuy(), f))).toBe('unevaluable');
  });

  it('non-canonical terms text asks (refused, never rewritten)', () => {
    const t = buyTerms({ subject: 'Logo‮design' });
    expect(asks(evaluateCommitment(autoBuy(), facts(t)))).toBe('unevaluable');
  });

  it('a self that is not the scope agent asks', () => {
    const t = buyTerms();
    const f: CommitmentFacts = { kind: 'terms', self: D, scope: scopeFor(t), terms: t };
    expect(asks(evaluateCommitment(autoBuy(), f))).toBe('unevaluable');
  });

  it('never throws on garbage facts, and never allows them', () => {
    const garbage: unknown[] = [null, undefined, 1, 'x', [], {}, { kind: 'terms' }, { kind: 'other' }];
    for (const g of garbage) {
      for (const p of [autoBuy(), signed((x) => (x.commitments.accept = 'allow'))]) {
        const e = evaluateCommitment(p, g as CommitmentFacts);
        expect(e.decision).toBe('approval');
      }
    }
  });

  it('does not change its inputs', () => {
    const p = autoBuy();
    const f = facts();
    const before = JSON.stringify([p, f]);
    evaluateCommitment(p, f);
    expect(JSON.stringify([p, f])).toBe(before);
  });
});

// --- the binding: one approval or grant per exact agreement ---------------------------------------

describe('a commitment is bound to the exact termsHash (04 §3.4.2)', () => {
  it('checkCommitmentBinding accepts the stored terms and refuses any other', () => {
    const t = buyTerms();
    const scope = scopeFor(t);
    expect(checkCommitmentBinding(SELF, scope, t)).toEqual({ ok: true });
    expect(checkCommitmentBinding(SELF, scope, priced('10.5'))).toEqual({
      ok: false,
      reason: 'terms_hash_mismatch',
    });
    // Same meaning, other spelling: a different hash, so a different agreement.
    expect(checkCommitmentBinding(SELF, scope, priced('10.00'))).toEqual({
      ok: false,
      reason: 'terms_hash_mismatch',
    });
    expect(checkCommitmentBinding(D, scope, t)).toEqual({ ok: false, reason: 'not_this_agent' });
    expect(checkCommitmentBinding(SELF, { ...scope, extra: 1 }, t)).toEqual({
      ok: false,
      reason: 'scope_invalid',
    });
    expect(checkCommitmentBinding(SELF, scope, { ...t, extra: 1 })).toEqual({
      ok: false,
      reason: 'terms_invalid',
    });
  });

  it('an approval action digest changes with the termsHash, so one approval covers one agreement', () => {
    const t1 = buyTerms();
    const t2 = priced('11');
    const action = (t: Obj) => ({
      tool: 'agentlink_respond_to_terms',
      args: { envelopeId: id16(0x02), decision: 'accept' },
      context: { triggers: ['commitments.accept'], scope: scopeFor(t), terms: t, fee: null },
    });
    expect(computeActionDigest(action(t1))).not.toBe(computeActionDigest(action(t2)));
  });

  it('the parts one decision authorises (04 §3.4.2)', () => {
    expect(commitmentParts({ decision: 'accept', notarize: false })).toEqual([
      'accept_envelope',
      'accepted_receipt',
    ]);
    expect(commitmentParts({ decision: 'accept', notarize: true })).toEqual([
      'accept_envelope',
      'accept_record',
      'accepted_receipt',
    ]);
    expect(commitmentParts({ decision: 'reject', notarize: false })).toEqual(['rejected_receipt']);
    expect(commitmentParts({ decision: 'confirm', notarize: false })).toEqual(['accepted_receipt']);
    expect(commitmentParts({ decision: 'offer', notarize: true })).toEqual([
      'offer_envelope',
      'offer_record',
    ]);
  });
});

describe('a policy grant is a ledger row, re-checked before each part (D-55)', () => {
  const grantOf = (e: CommitmentEvaluation) => {
    if (e.decision !== 'allow') throw new Error('expected allow');
    return e.grant;
  };

  it('the same verified policy and the same scope: the part may run', () => {
    const p = autoBuy();
    const f = facts();
    const grant = grantOf(evaluateCommitment(p, f));
    expect(recheckCommitmentGrant(p, f, grant)).toEqual({ status: 'allow' });
  });

  it('any policy change voids the grant, even one that still allows: ask the owner', () => {
    const f = facts();
    const grant = grantOf(evaluateCommitment(autoBuy('20'), f));
    expect(recheckCommitmentGrant(autoBuy('30'), f, grant)).toEqual({
      status: 'ask_owner',
      reason: 'policy_changed',
    });
  });

  it('a policy that no longer allows, or fails closed, asks the owner', () => {
    const f = facts();
    const grant = grantOf(evaluateCommitment(autoBuy('20'), f));
    expect(recheckCommitmentGrant(autoBuy('5'), f, grant).status).toBe('ask_owner');
    expect(recheckCommitmentGrant(failClosed, f, grant)).toEqual({
      status: 'ask_owner',
      reason: 'policy_invalid',
    });
    expect(recheckCommitmentGrant(defaults, f, grant).status).toBe('ask_owner');
  });

  it('a deny voids the grant: nothing is sent or signed', () => {
    const f = facts();
    const grant = grantOf(evaluateCommitment(autoBuy('20'), f));
    const deny = autoBuy('20', (p) => (p.commitments.accept = 'deny'));
    expect(recheckCommitmentGrant(deny, f, grant)).toEqual({ status: 'deny' });
  });

  it('a grant row with a forged hash or basis authorises nothing', () => {
    const p = autoBuy();
    const f = facts();
    for (const grant of [
      { basis: 'auto_accept', policyHash: '00'.repeat(32) },
      { basis: 'rule', policyHash: policyDocumentHash(p.policy) },
      { basis: 'auto_accept' },
      null,
      'grant',
    ]) {
      expect(recheckCommitmentGrant(p, f, grant as never).status).not.toBe('allow');
    }
  });

  it('the grant does not carry over to other terms (termsHash binding)', () => {
    const p = autoBuy();
    const grant = grantOf(evaluateCommitment(p, facts()));
    const t = buyTerms();
    const other: CommitmentFacts = { kind: 'terms', self: SELF, scope: scopeFor(t), terms: priced('9') };
    expect(recheckCommitmentGrant(p, other, grant).status).toBe('ask_owner');
  });

  it('an owner approval is void once the rule is deny, never under fail closed (04 §3.4.2 rule 4)', () => {
    expect(commitmentVoidedByPolicy(signed((p) => (p.commitments.accept = 'deny')))).toBe(true);
    expect(commitmentVoidedByPolicy(signed())).toBe(false);
    expect(commitmentVoidedByPolicy(defaults)).toBe(false);
    // An unreadable deny cannot be trusted: the approval stands (06 §3 G-6).
    expect(commitmentVoidedByPolicy(failClosed)).toBe(false);
  });
});

// --- never batched (D-68, D-71) -------------------------------------------------------------------

describe('commitments are never batch items (D-68; 04 §2.5.2)', () => {
  it('a terms action with a scope is a commitment', () => {
    const t = buyTerms();
    expect(
      isCommitmentAction({
        tool: 'agentlink_respond_to_terms',
        args: {},
        context: { triggers: ['commitments.accept'], scope: scopeFor(t), terms: t, fee: null },
      }),
    ).toBe(true);
  });

  it('an accepted/rejected acknowledgement (commitments.accept, no scope) is a commitment (D-31)', () => {
    expect(
      isCommitmentAction({
        tool: 'agentlink_acknowledge',
        args: { envelopeId: id16(0x02), type: 'accepted' },
        context: {
          triggers: ['commitments.accept'],
          counterparty: { agentId: C, ownerKey: 'c4'.repeat(32) },
          recordId: `0x${'e2'.repeat(32)}`,
          receipt: 'ACCEPTED',
        },
      }),
    ).toBe(true);
  });

  it('a plain send or proof approval is not; garbage is treated as a commitment (fail closed)', () => {
    expect(
      isCommitmentAction({
        tool: 'agentlink_notarize',
        args: {},
        context: { triggers: ['proofs.notarize'] },
      }),
    ).toBe(false);
    expect(isCommitmentAction({ tool: 'agentlink_send', args: { to: 'Bob' } })).toBe(false);
    expect(isCommitmentAction({ tool: 'agentlink_send', args: {}, context: { scope: null } })).toBe(
      true,
    );
    expect(
      isCommitmentAction({ tool: 'x', args: {}, context: { triggers: 'commitments.accept' } }),
    ).toBe(true);
  });
});

describe('evaluateCommitment is deterministic (property)', () => {
  it('never allows outside the conditions, over random policies and terms', () => {
    let s = 20261015;
    const rand = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    for (let i = 0; i < 1_500; i += 1) {
      const policy = signed((p) => {
        p.commitments.accept = pick(['allow', 'approval', 'deny'] as const);
        p.commitments.autoAcceptContacts = pick([[], [C], [D], [C, D]]);
        p.commitments.autoAcceptMaxUSD = pick(['0', '5', '10', '100']);
        p.commitments.autoAcceptDirection = pick(['buy', 'sell'] as const);
        p.commitments.autoAcceptMinUSD = pick([null, '0', '5', '50']);
      });
      const payer = pick([SELF, C]);
      const by = pick([[C], [SELF], [C, SELF]]);
      const terms = buyTerms({
        deliverables: by.map((b, n) => ({ id: `d${n}`, description: 'x', by: b, plaintextSha256: null })),
        price: pick([
          null,
          { amount: pick(['1', '5', '10', '10.5', '1000']), currency: pick(['USD', 'EUR', 'USDC']), payer },
        ]),
      });
      const decision = pick(['accept', 'reject', 'confirm', 'offer'] as const);
      const f = facts(clone(terms), { decision });
      const e = evaluateCommitment(policy, f);
      expect(evaluateCommitment(policy, f)).toEqual(e);
      const c = policy.policy.commitments;
      if (c.accept === 'deny') expect(e.decision).toBe('deny');
      if (e.decision === 'allow' && e.grant.basis === 'auto_accept') {
        expect(c.accept).toBe('approval');
        expect(['accept', 'confirm']).toContain(decision);
        expect(c.autoAcceptContacts).toContain(C);
        const price = terms.price as { currency: string; payer: string } | null;
        expect(price).not.toBeNull();
        expect(AUTO_ACCEPT_USD_CURRENCIES).toContain(price!.currency);
        if (c.autoAcceptDirection === 'buy') {
          expect(price!.payer).toBe(SELF);
          expect(by.every((b) => b === C)).toBe(true);
        } else {
          expect(c.autoAcceptMinUSD).not.toBeNull();
          expect(price!.payer).toBe(C);
          expect(by.every((b) => b === SELF)).toBe(true);
        }
      }
    }
  });
});
