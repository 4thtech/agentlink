// M1-PAY-CONFIRM-a (04 §2.5.3 rules 2, 3 and 7; 06 §3 "Remember for this contact"; D-132):
// the statement, the unsigned body and the challenge of a paid-action confirmation.
import {
  canonicalizeToBytes,
  concatBytes,
  encodeHex,
  encodeUtf8,
  randomBytes,
  sha256,
  type JsonObject,
  type JsonValue,
} from '@4thtech-io/crypto';
import { POLICY_DEFAULTS, type Policy } from '@4thtech-io/types';
import { describe, expect, it } from 'vitest';
import {
  PAY_CONFIRM_DOMAIN,
  PAY_CONFIRM_TTL_MS,
  PayConfirmError,
  buildPayConfirmFlow,
  isPaidPendingAction,
  payConfirmChallenge,
  rememberContactRules,
  spendingChanges,
  type PayConfirmInput,
} from './pay-confirm.js';

/** A JSON object the test edits in place. */
type Mutable = Record<string, JsonValue>;

const CONTACT = `0x${'12'.repeat(20)}`;
const OTHER = `0x${'34'.repeat(20)}`;
const FEE_TOKEN = `0x${'ab'.repeat(20)}`;

const policy = (): Policy => JSON.parse(JSON.stringify(POLICY_DEFAULTS)) as Policy;

const notarize = (
  usd = '0.1',
  triggers: string[] = ['proofs.perActionMaxUSD'],
  counterparty: JsonObject | null = { agentId: CONTACT, ownerKey: 'cd'.repeat(32) },
): JsonObject => ({
  tool: 'agentlink_notarize',
  args: { envelopeId: 'A'.repeat(22) },
  context: {
    triggers,
    counterparty,
    envelopeHash: `0x${'ef'.repeat(32)}`,
    fee: { token: FEE_TOKEN, amount: '100000', usd },
  },
});

const policySet = (p: Policy, version = 2): JsonObject => ({
  v: 1,
  agent: OTHER,
  owner: `0x${'aa'.repeat(32)}`,
  op: 'policy.set',
  params: { version, policy: p as unknown as JsonValue },
  nonce: 'B'.repeat(22),
  issuedAt: 1_800_000_000,
  expiresAt: 1_800_000_600,
});

const reason = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PayConfirmError);
    return (error as PayConfirmError).reason;
  }
  throw new Error('expected a refusal');
};

describe('which actions are paid (04 §2.5.3)', () => {
  it('a pending request with a fee is paid; one without is not', () => {
    expect(isPaidPendingAction(notarize())).toBe(true);
    expect(
      isPaidPendingAction({
        tool: 'agentlink_export_proof_pack',
        args: {},
        context: { triggers: [] },
      }),
    ).toBe(false);
  });

  it('a fee that does not parse counts as paid (fail closed)', () => {
    const action = notarize();
    (action['context'] as Mutable)['fee'] = { usd: 'lots' };
    expect(isPaidPendingAction(action)).toBe(true);
  });

  it('a policy change without a spending field is no paid flow (the ordinary prompt)', () => {
    const before = policy();
    const after = policy();
    after.files.maxSendSizeMB = before.files.maxSendSizeMB === 10 ? 11 : 10;
    expect(spendingChanges(before, after)).toEqual([]);
    expect(
      reason(() => buildPayConfirmFlow({ kind: 'limits', before, policySet: policySet(after) })),
    ).toBe('no_spending_change');
  });
});

describe('a proof approval (rule 2)', () => {
  it('the statement amount is exactly the pending request context.fee.usd; the body is the action', () => {
    const action = notarize('0.25');
    const flow = buildPayConfirmFlow({
      kind: 'proof',
      pendingAction: action,
      counterpartyName: 'Ana',
    });
    expect(flow.statement).toEqual({
      v: 1,
      kind: 'proof',
      amountUsd: '0.25',
      purpose: 'proof',
      counterparty: 'Ana',
      changes: [],
    });
    expect(flow.body).toEqual(action);
  });

  it('refuses a request without a fee (not a paid action)', () => {
    const action = notarize();
    delete (action['context'] as Mutable)['fee'];
    expect(
      reason(() =>
        buildPayConfirmFlow({ kind: 'proof', pendingAction: action, counterpartyName: 'Ana' }),
      ),
    ).toBe('not_paid');
  });

  it('refuses a statement built from a URL or tool value (an amount, name or limit key)', () => {
    for (const extra of [
      { amountUsd: '0.01' },
      { amount: '0.01' },
      { name: 'x' },
      { limit: '9' },
    ]) {
      const input = {
        kind: 'proof',
        pendingAction: notarize(),
        counterpartyName: 'Ana',
        ...extra,
      } as unknown as PayConfirmInput;
      expect(reason(() => buildPayConfirmFlow(input))).toBe('invalid');
    }
  });

  it('names a counterparty exactly when the action has one', () => {
    expect(
      reason(() =>
        buildPayConfirmFlow({ kind: 'proof', pendingAction: notarize(), counterpartyName: null }),
      ),
    ).toBe('invalid');
    const self = notarize('0.1', ['proofs.notarize'], null);
    expect(
      reason(() =>
        buildPayConfirmFlow({ kind: 'proof', pendingAction: self, counterpartyName: 'Ana' }),
      ),
    ).toBe('invalid');
    expect(
      buildPayConfirmFlow({ kind: 'proof', pendingAction: self, counterpartyName: null }).statement
        .counterparty,
    ).toBeNull();
  });

  it('keeps no reference to its input', () => {
    const action = notarize();
    const flow = buildPayConfirmFlow({
      kind: 'proof',
      pendingAction: action,
      counterpartyName: 'Ana',
    });
    ((action['context'] as Mutable)['fee'] as Mutable)['usd'] = '9';
    expect((flow.body as JsonObject)['context']).toMatchObject({ fee: { usd: '0.1' } });
  });
});

describe('the challenge (rule 2)', () => {
  const flow = () =>
    buildPayConfirmFlow({ kind: 'proof', pendingAction: notarize(), counterpartyName: 'Ana' });

  it('is SHA-256(domain ‖ nonce ‖ SHA-256(JCS(statement)) ‖ SHA-256(JCS(body)))', () => {
    const f = flow();
    const nonce = randomBytes(32);
    const expected = sha256(
      concatBytes(
        encodeUtf8(PAY_CONFIRM_DOMAIN),
        nonce,
        sha256(canonicalizeToBytes(f.statement as unknown as JsonValue)),
        sha256(canonicalizeToBytes(f.body)),
      ),
    );
    expect(encodeHex(payConfirmChallenge(nonce, f))).toBe(encodeHex(expected));
    expect(PAY_CONFIRM_TTL_MS).toBe(120_000);
  });

  it('changes with the amount and needs a 32-byte nonce', () => {
    const nonce = randomBytes(32);
    const a = payConfirmChallenge(nonce, flow());
    const b = payConfirmChallenge(
      nonce,
      buildPayConfirmFlow({
        kind: 'proof',
        pendingAction: notarize('0.11'),
        counterpartyName: 'Ana',
      }),
    );
    expect(encodeHex(a)).not.toBe(encodeHex(b));
    expect(reason(() => payConfirmChallenge(randomBytes(16), flow()))).toBe('invalid');
  });
});

describe('a limits change (04 §2.5.3 table)', () => {
  it('lists each spending field old and new, in a fixed order', () => {
    const before = policy();
    const after = policy();
    after.proofs.perActionMaxUSD = '2';
    after.proofs.notarize = 'approval';
    after.contactRules = [{ contact: CONTACT, proofs: { perActionMaxUSD: '3' } }];
    const flow = buildPayConfirmFlow({ kind: 'limits', before, policySet: policySet(after) });
    expect(flow.statement).toMatchObject({
      kind: 'limits',
      amountUsd: null,
      purpose: 'limits_change',
    });
    expect(flow.statement.changes).toEqual([
      { field: 'proofs.notarize', old: 'allow', new: 'approval' },
      { field: 'proofs.perActionMaxUSD', old: '1', new: '2' },
      { field: 'contactRules.proofs.perActionMaxUSD', contact: CONTACT, old: null, new: '3' },
    ]);
    expect(flow.body).toEqual(policySet(after));
  });
});

describe('"Remember for this contact" (rule 2, 06 §3)', () => {
  const remember = (after: Policy, action = notarize('0.123')): PayConfirmInput => ({
    kind: 'proof_remember',
    pendingAction: action,
    counterpartyName: 'Ana',
    before: policy(),
    policySet: policySet(after),
  });

  it('builds the 06 §3 rule: step 3 gives the fee rounded up to whole cents', () => {
    expect(rememberContactRules(policy(), notarize('0.123'))).toEqual([
      { contact: CONTACT, proofs: { perActionMaxUSD: '0.13' } },
    ]);
    expect(rememberContactRules(policy(), notarize('0.1', ['proofs.notarize']))).toEqual([
      { contact: CONTACT, proofs: { notarize: 'allow' } },
    ]);
  });

  it('is not offered when the daily budget triggered it, or for a note to self', () => {
    expect(rememberContactRules(policy(), notarize('0.1', ['proofs.dailyBudgetUSD']))).toBeNull();
    expect(rememberContactRules(policy(), notarize('0.1', ['proofs.notarize'], null))).toBeNull();
  });

  it('digests both bodies in one challenge and states the fee and the rule', () => {
    const after = policy();
    after.contactRules = [...(rememberContactRules(policy(), notarize('0.123')) ?? [])];
    const input = remember(after);
    const flow = buildPayConfirmFlow(input);
    expect(flow.body).toEqual([notarize('0.123'), policySet(after)]);
    expect(flow.statement).toMatchObject({
      kind: 'proof_remember',
      amountUsd: '0.123',
      counterparty: 'Ana',
      changes: [
        { field: 'contactRules.proofs.perActionMaxUSD', contact: CONTACT, old: null, new: '0.13' },
      ],
    });
    // The challenge differs from the proof-only flow: the policy.set is in it.
    const nonce = randomBytes(32);
    const alone = buildPayConfirmFlow({
      kind: 'proof',
      pendingAction: notarize('0.123'),
      counterpartyName: 'Ana',
    });
    expect(encodeHex(payConfirmChallenge(nonce, flow))).not.toBe(
      encodeHex(payConfirmChallenge(nonce, alone)),
    );
  });

  it('refuses a policy.set that changes more than that contact rule', () => {
    const after = policy();
    after.contactRules = [...(rememberContactRules(policy(), notarize('0.123')) ?? [])];
    after.proofs.dailyBudgetUSD = '500';
    expect(reason(() => buildPayConfirmFlow(remember(after)))).toBe('remember_mismatch');
    const higher = policy();
    higher.contactRules = [{ contact: CONTACT, proofs: { perActionMaxUSD: '100' } }];
    expect(reason(() => buildPayConfirmFlow(remember(higher)))).toBe('remember_mismatch');
    const other = policy();
    other.contactRules = [{ contact: OTHER, proofs: { perActionMaxUSD: '0.13' } }];
    expect(reason(() => buildPayConfirmFlow(remember(other)))).toBe('remember_mismatch');
  });
});
