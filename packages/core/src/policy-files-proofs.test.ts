// M1-7i: the 06 §3 rules for files (folders, size caps, `files.storage`, D-48), proofs
// (`notarize`, `perActionMaxUSD`, `dailyBudgetUSD` over the rolling 24 h window of G-7, the
// per-contact rules of G-32 and the 06 §3 evaluation steps) and receipts, all in the one pure
// `evaluate`. The budget ledger and the resolved folders are passed in as context.
import {
  MAX_INLINE_FILE_BYTES,
  POLICY_DEFAULTS,
  defaultPolicy,
  type Policy,
} from '@agentlink/types';
import { describe, expect, it } from 'vitest';
import { CoreError } from './errors.js';
import {
  BUDGET_WINDOW_SECONDS,
  budgetSpentMicros,
  evaluate,
  evaluateFileSend,
  evaluateProof,
  isInsideFolder,
  type BudgetEntryView,
  type BudgetLedgerView,
  type EffectivePolicy,
  type FileSendEvaluation,
  type PolicyAction,
  type PolicyContext,
  type ProofEvaluation,
} from './policy-engine.js';

const A = `0x${'0a'.repeat(20)}`;
const B = `0x${'0b'.repeat(20)}`;
const NOW = 1_800_000_000;
const MB = 1024 * 1024;

const defaults: EffectivePolicy = { mode: 'defaults', policy: POLICY_DEFAULTS };
const signed = (edit: (p: Policy) => void = () => {}): EffectivePolicy => {
  const p = defaultPolicy();
  edit(p);
  return { mode: 'signed', policy: p, version: 3 };
};
const failClosed: EffectivePolicy = { mode: 'fail_closed', problem: 'tampered' };

// --- proofs ---------------------------------------------------------------------------------------

const entry = (
  t: number,
  usd: string,
  state: BudgetEntryView['state'] = 'charged',
  over: Partial<BudgetEntryView> = {},
): BudgetEntryView => ({
  t,
  ledgerEpoch: 1,
  state,
  reservedUsd: usd,
  chargedUsd: state === 'charged' ? usd : null,
  ...over,
});
const ledger = (
  entries: readonly BudgetEntryView[] = [],
  over: { epoch?: number; newestT?: number } = {},
) =>
  ({
    status: 'ok',
    epoch: over.epoch ?? 1,
    newestT: over.newestT ?? NOW - 10,
    entries,
  }) as const satisfies BudgetLedgerView;
const ctx = (view: BudgetLedgerView = ledger(), now = NOW): PolicyContext => ({
  now,
  ledger: view,
});

const proof = (
  feeUsd: string,
  maxFeeUsd = feeUsd,
  counterparty: { contact: string; ruleEligible: boolean } | null = null,
): PolicyAction => ({ kind: 'proof', feeUsd, maxFeeUsd, counterparty });
const withA = (fee: string, eligible = true) =>
  proof(fee, fee, { contact: A, ruleEligible: eligible });
const ruleFor = (
  contact: string,
  proofs: Policy['contactRules'][number]['proofs'],
): Policy['contactRules'][number] => ({ contact, proofs });

interface ProofRow {
  readonly name: string;
  readonly policy: EffectivePolicy;
  readonly action: PolicyAction;
  readonly context?: PolicyContext;
  readonly expected: ProofEvaluation;
}

const allow: ProofEvaluation = { decision: 'allow', triggers: [] };
const approval = (...triggers: ProofEvaluation['triggers']): ProofEvaluation => ({
  decision: 'approval',
  triggers,
});
const deny: ProofEvaluation = { decision: 'deny', triggers: ['notarize'] };

const PROOF_ROWS: readonly ProofRow[] = [
  // Defaults (06 §3): notarize allow, perActionMaxUSD "1", dailyBudgetUSD "5".
  {
    name: 'defaults, $1.00 fee, empty ledger',
    policy: defaults,
    action: proof('1'),
    context: ctx(),
    expected: allow,
  },
  {
    name: 'defaults, $1.01 fee',
    policy: defaults,
    action: proof('1.01'),
    context: ctx(),
    expected: approval('per_action'),
  },
  {
    name: 'defaults, $0.000001 fee',
    policy: defaults,
    action: proof('0.000001'),
    context: ctx(),
    expected: allow,
  },
  // Step 3 reads the fee (usd, the total); step 4 reads the reserved maximum fee.
  {
    name: 'fee $0.5 within the per-action max, maxFee $1.2 over it: per-action reads the fee',
    policy: defaults,
    action: proof('0.5', '1.2'),
    context: ctx(),
    expected: allow,
  },
  // Threshold: spent + maxFee equal to the budget is allowed; one cent more is not.
  {
    name: 'spent $4 + max $1 = $5 budget',
    policy: defaults,
    action: proof('0.5', '1'),
    context: ctx(ledger([entry(NOW - 100, '4')])),
    expected: allow,
  },
  {
    name: 'spent $4.01 + max $1 = $5.01',
    policy: defaults,
    action: proof('0.5', '1'),
    context: ctx(ledger([entry(NOW - 100, '4.01')])),
    expected: approval('budget'),
  },
  // Rolling window (G-7): t = now − 86 400 is outside, now − 86 399 inside.
  {
    name: 'an entry at now − 86 400 is outside the window',
    policy: defaults,
    action: proof('1'),
    context: ctx(ledger([entry(NOW - 86_400, '4.5')])),
    expected: allow,
  },
  {
    name: 'an entry at now − 86 399 is inside the window',
    policy: defaults,
    action: proof('1'),
    context: ctx(ledger([entry(NOW - 86_399, '4.5')])),
    expected: approval('budget'),
  },
  // Entry states: reserved and charged count, released does not; charged counts the charged fee.
  {
    name: 'a reserved entry counts its reservation',
    policy: defaults,
    action: proof('1'),
    context: ctx(ledger([entry(NOW - 5, '4.5', 'reserved')])),
    expected: approval('budget'),
  },
  {
    name: 'a released entry does not count',
    policy: defaults,
    action: proof('1'),
    context: ctx(ledger([entry(NOW - 5, '4.5', 'released')])),
    expected: allow,
  },
  {
    name: 'a charged entry counts the charged fee, not the reservation',
    policy: defaults,
    action: proof('1'),
    context: ctx(ledger([entry(NOW - 5, '4.5', 'charged', { chargedUsd: '0.3' })])),
    expected: allow,
  },
  {
    name: 'entries of an earlier epoch do not count',
    policy: defaults,
    action: proof('1'),
    context: ctx(ledger([entry(NOW - 5, '4.5', 'charged', { ledgerEpoch: 1 })], { epoch: 2 })),
    expected: allow,
  },
  {
    name: 'several entries add as exact decimals (0.1 + 0.2 + 4.7 = 5)',
    policy: defaults,
    action: proof('0.000001'),
    context: ctx(ledger([entry(NOW - 3, '0.1'), entry(NOW - 2, '0.2'), entry(NOW - 1, '4.7')])),
    expected: approval('budget'),
  },
  // Broken ledger (06 §3, 07 §3.5): approval for every paid action, never an empty sum.
  {
    name: 'ledger marked broken',
    policy: defaults,
    action: proof('0.01'),
    context: ctx({ status: 'broken' }),
    expected: approval('ledger_broken'),
  },
  {
    name: 'clock earlier than the newest entry',
    policy: defaults,
    action: proof('0.01'),
    context: ctx(ledger([], { newestT: NOW + 1 })),
    expected: approval('ledger_broken'),
  },
  {
    name: 'clock equal to the newest entry is fine',
    policy: defaults,
    action: proof('0.01'),
    context: ctx(ledger([], { newestT: NOW })),
    expected: allow,
  },
  {
    name: 'an entry from a later epoch than the state',
    policy: defaults,
    action: proof('0.01'),
    context: ctx(ledger([entry(NOW - 5, '0.01', 'charged', { ledgerEpoch: 2 })], { epoch: 1 })),
    expected: approval('ledger_broken'),
  },
  {
    name: 'a charged entry without a charged amount',
    policy: defaults,
    action: proof('0.01'),
    context: ctx(ledger([entry(NOW - 5, '0.01', 'charged', { chargedUsd: null })])),
    expected: approval('ledger_broken'),
  },
  {
    name: 'an entry with an unknown state',
    policy: defaults,
    action: proof('0.01'),
    context: ctx(
      ledger([
        entry(NOW - 5, '0.01', 'reserved', { state: 'pending' as BudgetEntryView['state'] }),
      ]),
    ),
    expected: approval('ledger_broken'),
  },
  {
    name: 'an entry whose amount is not a USD amount ("1.0")',
    policy: defaults,
    action: proof('0.01'),
    context: ctx(ledger([entry(NOW - 5, '1.0', 'reserved')])),
    expected: approval('ledger_broken'),
  },
  {
    name: 'a broken entry outside the window still breaks the ledger',
    policy: defaults,
    action: proof('0.01'),
    context: ctx(ledger([entry(NOW - 90_000, '1.00', 'reserved')])),
    expected: approval('ledger_broken'),
  },
  {
    name: 'broken ledger and a fee over the per-action max: both triggers',
    policy: defaults,
    action: proof('2'),
    context: ctx({ status: 'broken' }),
    expected: approval('per_action', 'ledger_broken'),
  },
  // proofs.notarize
  {
    name: 'notarize approval',
    policy: signed((p) => (p.proofs.notarize = 'approval')),
    action: proof('0.01'),
    context: ctx(),
    expected: approval('notarize'),
  },
  {
    name: 'notarize approval, over per-action and over budget: every trigger',
    policy: signed((p) => (p.proofs.notarize = 'approval')),
    action: proof('2'),
    context: ctx(ledger([entry(NOW - 5, '4')])),
    expected: approval('notarize', 'per_action', 'budget'),
  },
  {
    name: 'notarize deny',
    policy: signed((p) => (p.proofs.notarize = 'deny')),
    action: proof('0.01'),
    context: ctx(),
    expected: deny,
  },
  {
    name: 'notarize deny wins over a broken ledger',
    policy: signed((p) => (p.proofs.notarize = 'deny')),
    action: proof('0.01'),
    context: ctx({ status: 'broken' }),
    expected: deny,
  },
  {
    name: 'a raised perActionMaxUSD and budget allow more',
    policy: signed((p) => {
      p.proofs.perActionMaxUSD = '10';
      p.proofs.dailyBudgetUSD = '20';
    }),
    action: proof('10'),
    context: ctx(ledger([entry(NOW - 5, '10')])),
    expected: allow,
  },
  {
    name: 'a zero budget needs approval for any fee',
    policy: signed((p) => (p.proofs.dailyBudgetUSD = '0')),
    action: proof('0.000001'),
    context: ctx(),
    expected: approval('budget'),
  },
  {
    name: 'a zero fee under a zero budget is within it',
    policy: signed((p) => (p.proofs.dailyBudgetUSD = '0')),
    action: proof('0'),
    context: ctx(),
    expected: allow,
  },
  // G-6 fail closed: approval, never allow; an unreadable deny becomes approval.
  {
    name: 'fail closed',
    policy: failClosed,
    action: proof('0.01'),
    context: ctx(),
    expected: approval('policy_invalid'),
  },
  {
    name: 'fail closed, no ledger context needed',
    policy: failClosed,
    action: proof('0.01'),
    expected: approval('policy_invalid'),
  },
  // Contact rules (G-32) and the 06 §3 evaluation steps.
  {
    name: 'rule notarize allow under a global deny stays deny (step 1)',
    policy: signed((p) => {
      p.proofs.notarize = 'deny';
      p.contactRules = [ruleFor(A, { notarize: 'allow' })];
    }),
    action: withA('0.01'),
    context: ctx(),
    expected: deny,
  },
  {
    name: 'rule notarize allow replaces a global approval (step 2)',
    policy: signed((p) => {
      p.proofs.notarize = 'approval';
      p.contactRules = [ruleFor(A, { notarize: 'allow' })];
    }),
    action: withA('0.01'),
    context: ctx(),
    expected: allow,
  },
  {
    name: 'rule notarize approval under a global allow',
    policy: signed((p) => (p.contactRules = [ruleFor(A, { notarize: 'approval' })])),
    action: withA('0.01'),
    context: ctx(),
    expected: approval('notarize'),
  },
  {
    name: 'rule notarize deny under a global allow',
    policy: signed((p) => (p.contactRules = [ruleFor(A, { notarize: 'deny' })])),
    action: withA('0.01'),
    context: ctx(),
    expected: deny,
  },
  {
    name: 'rule perActionMaxUSD "2" allows $2.00 for that contact',
    policy: signed((p) => (p.contactRules = [ruleFor(A, { perActionMaxUSD: '2' })])),
    action: withA('2'),
    context: ctx(),
    expected: allow,
  },
  {
    name: 'rule perActionMaxUSD "2": $2.01 needs approval',
    policy: signed((p) => (p.contactRules = [ruleFor(A, { perActionMaxUSD: '2' })])),
    action: withA('2.01'),
    context: ctx(),
    expected: approval('per_action'),
  },
  {
    name: 'rule for A does not apply to B',
    policy: signed((p) => (p.contactRules = [ruleFor(A, { perActionMaxUSD: '2' })])),
    action: proof('2', '2', { contact: B, ruleEligible: true }),
    context: ctx(),
    expected: approval('per_action'),
  },
  {
    name: 'rule perActionMaxUSD below the global max lowers it for that contact',
    policy: signed((p) => (p.contactRules = [ruleFor(A, { perActionMaxUSD: '0.5' })])),
    action: withA('0.51'),
    context: ctx(),
    expected: approval('per_action'),
  },
  {
    name: 'the daily budget still applies to a contact with a rule (step 4)',
    policy: signed(
      (p) => (p.contactRules = [ruleFor(A, { perActionMaxUSD: '10', notarize: 'allow' })]),
    ),
    action: withA('6'),
    context: ctx(),
    expected: approval('budget'),
  },
  {
    name: 'a rule for a blocked or revoked contact has no effect',
    policy: signed((p) => (p.contactRules = [ruleFor(A, { perActionMaxUSD: '2' })])),
    action: withA('2', false),
    context: ctx(),
    expected: approval('per_action'),
  },
  {
    name: 'a notarize-allow rule for an ineligible contact has no effect',
    policy: signed((p) => {
      p.proofs.notarize = 'approval';
      p.contactRules = [ruleFor(A, { notarize: 'allow' })];
    }),
    action: withA('0.01', false),
    context: ctx(),
    expected: approval('notarize'),
  },
  {
    name: 'a rule has no effect without a verified policy (fail closed)',
    policy: failClosed,
    action: withA('0.01'),
    context: ctx(),
    expected: approval('policy_invalid'),
  },
  {
    name: 'no counterparty: the global values',
    policy: signed((p) => (p.contactRules = [ruleFor(A, { perActionMaxUSD: '2' })])),
    action: proof('2'),
    context: ctx(),
    expected: approval('per_action'),
  },
];

describe('proofs: one row per rule and boundary (06 §3, G-7, G-32)', () => {
  it.each(PROOF_ROWS)('$name', ({ policy, action, context, expected }) => {
    if (action.kind !== 'proof') throw new Error('proof rows only');
    expect(evaluateProof(policy, action, context)).toEqual(expected);
    expect(evaluate(policy, action, context)).toBe(expected.decision);
  });

  it('fixes the window at 86 400 s', () => {
    expect(BUDGET_WINDOW_SECONDS).toBe(86_400);
  });

  it('sums the window exactly in micro-dollars, or reports a broken ledger', () => {
    expect(budgetSpentMicros(ledger([entry(NOW - 1, '0.1'), entry(NOW - 2, '0.2')]), NOW)).toBe(
      300_000n,
    );
    expect(budgetSpentMicros(ledger([entry(NOW - 86_400, '1')]), NOW)).toBe(0n);
    expect(budgetSpentMicros({ status: 'broken' }, NOW)).toBe('broken');
    expect(budgetSpentMicros(ledger([], { newestT: NOW + 1 }), NOW)).toBe('broken');
  });

  it.each([
    ['a fee that is not a USD amount', proof('1.0', '1')],
    ['a maximum fee that is not a USD amount', proof('1', '01')],
    ['a JSON-number-like fee', { kind: 'proof', feeUsd: 1, maxFeeUsd: '1', counterparty: null }],
    ['a fee above the maximum fee', proof('1.01', '1')],
  ] as const)('refuses %s (policy_context_invalid), never guesses', (_n, action) => {
    expect(() => evaluate(defaults, action as PolicyAction, ctx())).toThrow(CoreError);
  });

  it.each([
    ['no ledger', { now: NOW }],
    ['no clock', { ledger: ledger() }],
    ['a clock that is not a safe integer', { now: 1.5, ledger: ledger() }],
  ] as const)('refuses a missing context fact: %s', (_n, context) => {
    try {
      evaluate(defaults, proof('0.01'), context as PolicyContext);
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(CoreError);
      expect((e as CoreError).code).toBe('policy_context_invalid');
    }
  });

  it('a global deny needs no ledger (step 1 first)', () => {
    const p = signed((x) => (x.proofs.notarize = 'deny'));
    expect(evaluate(p, proof('0.01'))).toBe('deny');
  });
});

// --- files ----------------------------------------------------------------------------------------

const WORK = '/home/u/Work';
const withFolder = (edit: (p: Policy) => void = () => {}) =>
  signed((p) => {
    p.files.allowedFolders = ['~/Work'];
    edit(p);
  });
const fileCtx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  allowedFolderRealpaths: [WORK],
  ownStorageConfigured: false,
  dropCanTake: true,
  ...over,
});
const sendFile = (sizeBytes: number, realpath = `${WORK}/report.pdf`): PolicyAction => ({
  kind: 'file.send',
  sizeBytes,
  realpath,
});

interface FileRow {
  readonly name: string;
  readonly policy: EffectivePolicy;
  readonly action: PolicyAction;
  readonly context: PolicyContext;
  readonly expected: FileSendEvaluation;
}

const BIG = MAX_INLINE_FILE_BYTES + 1;
const FILE_ROWS: readonly FileRow[] = [
  // Folders: empty (the default) means needs_setup; outside means refused.
  {
    name: 'defaults: no folder allowed',
    policy: defaults,
    action: sendFile(10),
    context: fileCtx(),
    expected: { decision: 'deny', reason: 'no_folder' },
  },
  {
    name: 'resolved folders in context are ignored when the policy allows none',
    policy: signed(),
    action: sendFile(10),
    context: fileCtx(),
    expected: { decision: 'deny', reason: 'no_folder' },
  },
  {
    name: 'inside the allowed folder, small: inline',
    policy: withFolder(),
    action: sendFile(10),
    context: fileCtx(),
    expected: { decision: 'allow', storage: 'inline' },
  },
  {
    name: 'nested inside the allowed folder',
    policy: withFolder(),
    action: sendFile(10, `${WORK}/a/b/c.txt`),
    context: fileCtx(),
    expected: { decision: 'allow', storage: 'inline' },
  },
  {
    name: 'a sibling folder sharing the prefix is outside',
    policy: withFolder(),
    action: sendFile(10, '/home/u/Workshop/a.txt'),
    context: fileCtx(),
    expected: { decision: 'deny', reason: 'outside_folder' },
  },
  {
    name: 'another folder is outside',
    policy: withFolder(),
    action: sendFile(10, '/home/u/.ssh/id_ed25519'),
    context: fileCtx(),
    expected: { decision: 'deny', reason: 'outside_folder' },
  },
  {
    name: 'the folder itself is not a file inside it',
    policy: withFolder(),
    action: sendFile(10, WORK),
    context: fileCtx(),
    expected: { decision: 'deny', reason: 'outside_folder' },
  },
  {
    name: 'a path with a .. segment is outside',
    policy: withFolder(),
    action: sendFile(10, `${WORK}/../.ssh/id_ed25519`),
    context: fileCtx(),
    expected: { decision: 'deny', reason: 'outside_folder' },
  },
  {
    name: 'a relative path is outside',
    policy: withFolder(),
    action: sendFile(10, 'Work/report.pdf'),
    context: fileCtx(),
    expected: { decision: 'deny', reason: 'outside_folder' },
  },
  // Size cap (maxSendSizeMB) before anything else.
  {
    name: 'maxSendSizeMB 1: exactly 1 MB',
    policy: withFolder((p) => (p.files.maxSendSizeMB = 1)),
    action: sendFile(MB),
    context: fileCtx(),
    expected: { decision: 'allow', storage: 'drop' },
  },
  {
    name: 'maxSendSizeMB 1: 1 MB + 1',
    policy: withFolder((p) => (p.files.maxSendSizeMB = 1)),
    action: sendFile(MB + 1),
    context: fileCtx(),
    expected: { decision: 'deny', reason: 'too_large' },
  },
  {
    name: 'defaults: 100 MB + 1 is too large even without a folder',
    policy: defaults,
    action: sendFile(100 * MB + 1),
    context: fileCtx(),
    expected: { decision: 'deny', reason: 'too_large' },
  },
  // files.storage (D-48): inline up to 12 255 bytes whatever the setting.
  {
    name: `inline at exactly ${MAX_INLINE_FILE_BYTES} bytes, even under own`,
    policy: withFolder((p) => (p.files.storage = 'own')),
    action: sendFile(MAX_INLINE_FILE_BYTES),
    context: fileCtx(),
    expected: { decision: 'allow', storage: 'inline' },
  },
  {
    name: 'auto, no own storage, drop can take it: drop',
    policy: withFolder(),
    action: sendFile(BIG),
    context: fileCtx(),
    expected: { decision: 'allow', storage: 'drop' },
  },
  {
    name: 'auto, own storage configured: own',
    policy: withFolder(),
    action: sendFile(BIG),
    context: fileCtx({ ownStorageConfigured: true }),
    expected: { decision: 'allow', storage: 'own' },
  },
  {
    name: 'auto, no own storage, drop cannot take it: needs storage',
    policy: withFolder(),
    action: sendFile(BIG),
    context: fileCtx({ dropCanTake: false }),
    expected: { decision: 'deny', reason: 'needs_storage' },
  },
  {
    name: 'own, none configured: needs storage, never the drop',
    policy: withFolder((p) => (p.files.storage = 'own')),
    action: sendFile(BIG),
    context: fileCtx({ dropCanTake: true }),
    expected: { decision: 'deny', reason: 'needs_storage' },
  },
  {
    name: 'own, configured: own',
    policy: withFolder((p) => (p.files.storage = 'own')),
    action: sendFile(BIG),
    context: fileCtx({ ownStorageConfigured: true }),
    expected: { decision: 'allow', storage: 'own' },
  },
  {
    name: 'drop, own configured too: drop',
    policy: withFolder((p) => (p.files.storage = 'drop')),
    action: sendFile(BIG),
    context: fileCtx({ ownStorageConfigured: true }),
    expected: { decision: 'allow', storage: 'drop' },
  },
  {
    name: 'drop, drop cannot take it: needs storage, no fallback to own',
    policy: withFolder((p) => (p.files.storage = 'drop')),
    action: sendFile(BIG),
    context: fileCtx({ ownStorageConfigured: true, dropCanTake: false }),
    expected: { decision: 'deny', reason: 'needs_storage' },
  },
  // G-6 fail closed: no folder is allowed, so nothing is uploaded.
  {
    name: 'fail closed: no folder, whatever the context says',
    policy: failClosed,
    action: sendFile(10),
    context: fileCtx(),
    expected: { decision: 'deny', reason: 'no_folder' },
  },
  {
    name: 'fail closed: over the hard cap',
    policy: failClosed,
    action: sendFile(100 * MB + 1),
    context: fileCtx(),
    expected: { decision: 'deny', reason: 'too_large' },
  },
];

describe('files: send (06 §2.3, §3, D-48)', () => {
  it.each(FILE_ROWS)('$name', ({ policy, action, context, expected }) => {
    if (action.kind !== 'file.send') throw new Error('file rows only');
    expect(evaluateFileSend(policy, action, context)).toEqual(expected);
    expect(evaluate(policy, action, context)).toBe(expected.decision);
  });

  it.each([
    ['no resolved folders', { ownStorageConfigured: false, dropCanTake: true }, 10],
    [
      'no own-storage fact above the inline size',
      { allowedFolderRealpaths: [WORK], dropCanTake: true },
      BIG,
    ],
    [
      'no drop fact above the inline size',
      { allowedFolderRealpaths: [WORK], ownStorageConfigured: false },
      BIG,
    ],
  ] as const)('refuses a missing context fact: %s', (_n, context, size) => {
    expect(() => evaluate(withFolder(), sendFile(size), context as PolicyContext)).toThrow(
      CoreError,
    );
  });

  it('isInsideFolder is a strict descendant check on resolved paths', () => {
    expect(isInsideFolder('/a/b/c', '/a/b')).toBe(true);
    expect(isInsideFolder('/a/b/c', '/a/b/')).toBe(true);
    expect(isInsideFolder('/a/bc', '/a/b')).toBe(false);
    expect(isInsideFolder('/a/b', '/a/b')).toBe(false);
    expect(isInsideFolder('/a/b/./c', '/a/b')).toBe(false);
    expect(isInsideFolder('/a/b//c', '/a/b')).toBe(false);
    expect(isInsideFolder('a/b/c', 'a/b')).toBe(false);
    expect(isInsideFolder('/a/b/c', 'relative')).toBe(false);
    expect(isInsideFolder('C:\\Users\\u\\Work\\x.pdf', 'C:\\Users\\u\\Work')).toBe(true);
    expect(isInsideFolder('C:\\Users\\u\\Workshop\\x.pdf', 'C:\\Users\\u\\Work')).toBe(false);
  });
});

describe('files: receive (06 §2.3, maxReceiveSizeMB)', () => {
  const receive = (sizeBytes: number): PolicyAction => ({ kind: 'file.receive', sizeBytes });
  it.each([
    ['defaults, 200 MB', defaults, 200 * MB, 'allow'],
    ['defaults, 200 MB + 1', defaults, 200 * MB + 1, 'deny'],
    ['maxReceiveSizeMB 4, 4 MB', signed((p) => (p.files.maxReceiveSizeMB = 4)), 4 * MB, 'allow'],
    [
      'maxReceiveSizeMB 4, 4 MB + 1',
      signed((p) => (p.files.maxReceiveSizeMB = 4)),
      4 * MB + 1,
      'deny',
    ],
    // Fail closed: file access is owner-gated, and no inbox folder can be read (06 §3).
    ['fail closed, within the hard cap: owner approval', failClosed, 200 * MB, 'approval'],
    ['fail closed, 200 MB + 1', failClosed, 200 * MB + 1, 'deny'],
  ] as const)('%s → %s', (_n, policy, size, expected) => {
    expect(evaluate(policy, receive(size))).toBe(expected);
  });
});
