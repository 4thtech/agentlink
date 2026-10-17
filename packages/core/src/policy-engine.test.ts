// The pure policy engine (M1-7d; 07 §2, 06 §3, G-6): contacts and envelopes, the plain
// `commitments.accept` rule, and the G-6 fail-closed result. The auto-accept limits are M1-20
// (commitments.test.ts); the files and proofs rules in full are M1-7i (policy-files-proofs.test.ts).
import { POLICY_DEFAULTS, defaultPolicy, type Policy } from '@agentlink/types';
import { describe, expect, it } from 'vitest';
import {
  FAIL_CLOSED_CONTACTS,
  FAIL_CLOSED_LIMITS,
  evaluate,
  policyLimits,
  type EffectivePolicy,
  type PolicyAction,
  type PolicyContext,
  type PolicyDecision,
} from './policy-engine.js';

const A = `0x${'0a'.repeat(20)}`;
const B = `0x${'0b'.repeat(20)}`;
const C = `0x${'0c'.repeat(20)}`;

const defaults: EffectivePolicy = { mode: 'defaults', policy: POLICY_DEFAULTS };
const signed = (edit: (p: Policy) => void = () => {}): EffectivePolicy => {
  const p = defaultPolicy();
  edit(p);
  return { mode: 'signed', policy: p, version: 1 };
};
const failClosed: EffectivePolicy = { mode: 'fail_closed', problem: 'rolled_back' };

const fromContact = (sizeBytes = 100, contact = A): PolicyAction => ({
  kind: 'envelope.receive',
  sender: { kind: 'contact', contact },
  sizeBytes,
});
const fromUnknown = (sizeBytes = 100): PolicyAction => ({
  kind: 'envelope.receive',
  sender: { kind: 'unknown' },
  sizeBytes,
});
const send = (sizeBytes = 100, contact = A): PolicyAction => ({
  kind: 'envelope.send',
  contact,
  sizeBytes,
});
const hour = (n: number): PolicyContext => ({ contactEnvelopesLastHour: n });
/** A paid proof well within the default limits, with an empty budget ledger (M1-7i). */
const PROOF: PolicyAction = {
  kind: 'proof',
  feeUsd: '0.01',
  maxFeeUsd: '0.01',
  counterparty: null,
};
const PAID: PolicyContext = {
  now: 1_800_000_000,
  ledger: { status: 'ok', epoch: 0, newestT: 0, entries: [] },
};
const WORK = '/home/u/Work';
const FILE_CTX: PolicyContext = {
  allowedFolderRealpaths: [WORK],
  ownStorageConfigured: false,
  dropCanTake: true,
};
const sendFile = (sizeBytes: number): PolicyAction => ({
  kind: 'file.send',
  sizeBytes,
  realpath: `${WORK}/a.pdf`,
});
/** A commitment without terms (an `accepted` acknowledgement): the plain rule; limits in commitments.test.ts. */
const ACK: PolicyAction = {
  kind: 'commitment',
  facts: { kind: 'acknowledge', receipt: 'ACCEPTED' },
};

interface Row {
  readonly name: string;
  readonly policy: EffectivePolicy;
  readonly action: PolicyAction;
  readonly context?: PolicyContext;
  readonly expected: PolicyDecision;
}

const KB = 1024;
const MB = 1024 * 1024;

const RULES: readonly Row[] = [
  // contacts.acceptInvites
  {
    name: 'invite, defaults',
    policy: defaults,
    action: { kind: 'invite.accept' },
    expected: 'approval',
  },
  {
    name: 'invite, auto',
    policy: signed((p) => (p.contacts.acceptInvites = 'auto')),
    action: { kind: 'invite.accept' },
    expected: 'allow',
  },
  // contacts.unknownSenders
  { name: 'unknown sender, queue', policy: defaults, action: fromUnknown(), expected: 'approval' },
  {
    name: 'unknown sender, drop',
    policy: signed((p) => (p.contacts.unknownSenders = 'drop')),
    action: fromUnknown(),
    expected: 'deny',
  },
  // contacts.allowed
  {
    name: 'paired contact',
    policy: defaults,
    action: fromContact(),
    context: hour(0),
    expected: 'allow',
  },
  {
    name: 'listed contact',
    policy: signed((p) => (p.contacts.allowed = [A, C])),
    action: fromContact(),
    context: hour(0),
    expected: 'allow',
  },
  {
    name: 'paired contact not in the list is an unknown sender (queue)',
    policy: signed((p) => (p.contacts.allowed = [C])),
    action: fromContact(),
    context: hour(0),
    expected: 'approval',
  },
  {
    name: 'paired contact not in the list is an unknown sender (drop)',
    policy: signed((p) => {
      p.contacts.allowed = [C];
      p.contacts.unknownSenders = 'drop';
    }),
    action: fromContact(),
    context: hour(0),
    expected: 'deny',
  },
  { name: 'send to a paired contact', policy: defaults, action: send(), expected: 'allow' },
  {
    name: 'send to a contact outside the list',
    policy: signed((p) => (p.contacts.allowed = [B])),
    action: send(),
    expected: 'deny',
  },
  // contacts.rateLimitPerContactPerHour: the Nth envelope in the hour passes, the N + 1th is dropped
  {
    name: 'rate 119 before (120th)',
    policy: defaults,
    action: fromContact(),
    context: hour(119),
    expected: 'allow',
  },
  {
    name: 'rate 120 before (121st)',
    policy: defaults,
    action: fromContact(),
    context: hour(120),
    expected: 'deny',
  },
  {
    name: 'rate limit 1: first',
    policy: signed((p) => (p.contacts.rateLimitPerContactPerHour = 1)),
    action: fromContact(),
    context: hour(0),
    expected: 'allow',
  },
  {
    name: 'rate limit 1: second',
    policy: signed((p) => (p.contacts.rateLimitPerContactPerHour = 1)),
    action: fromContact(),
    context: hour(1),
    expected: 'deny',
  },
  // envelopes.maxEnvelopeKB (KB = 1024 bytes)
  {
    name: 'receive 24 KB',
    policy: defaults,
    action: fromContact(24 * KB),
    context: hour(0),
    expected: 'allow',
  },
  {
    name: 'receive 24 KB + 1',
    policy: defaults,
    action: fromContact(24 * KB + 1),
    context: hour(0),
    expected: 'deny',
  },
  {
    name: 'unknown 24 KB + 1',
    policy: defaults,
    action: fromUnknown(24 * KB + 1),
    expected: 'deny',
  },
  { name: 'send 24 KB', policy: defaults, action: send(24 * KB), expected: 'allow' },
  { name: 'send 24 KB + 1', policy: defaults, action: send(24 * KB + 1), expected: 'deny' },
  {
    name: 'send 1 KB limit + 1',
    policy: signed((p) => (p.envelopes.maxEnvelopeKB = 1)),
    action: send(KB + 1),
    expected: 'deny',
  },
  // commitments.accept (the auto-accept limits: commitments.test.ts, M1-20)
  {
    name: 'commitment, defaults',
    policy: defaults,
    action: ACK,
    expected: 'approval',
  },
  {
    name: 'commitment, allow',
    policy: signed((p) => (p.commitments.accept = 'allow')),
    action: ACK,
    expected: 'allow',
  },
  {
    name: 'commitment, deny',
    policy: signed((p) => (p.commitments.accept = 'deny')),
    action: ACK,
    expected: 'deny',
  },
  {
    name: 'commitment without terms, allowlisted contact: never auto-accepted (M1-20)',
    policy: signed((p) => {
      p.commitments.autoAcceptContacts = [A];
      p.commitments.autoAcceptMaxUSD = '100';
    }),
    action: ACK,
    expected: 'approval',
  },
  // proofs (06 §3 defaults: notarize allow within $1 per action and $5 a day; M1-7i)
  { name: 'proof, defaults', policy: defaults, action: PROOF, context: PAID, expected: 'allow' },
  {
    name: 'proof, deny',
    policy: signed((p) => (p.proofs.notarize = 'deny')),
    action: PROOF,
    context: PAID,
    expected: 'deny',
  },
  // proofs.allowKeyDisclosure
  {
    name: 'key disclosure, defaults',
    policy: defaults,
    action: { kind: 'key.disclose' },
    expected: 'approval',
  },
  {
    name: 'key disclosure, deny',
    policy: signed((p) => (p.proofs.allowKeyDisclosure = 'deny')),
    action: { kind: 'key.disclose' },
    expected: 'deny',
  },
  // files (M1-7i): no folder allowed by default; an allowed folder and the size cap
  {
    name: 'file, defaults: no folder allowed',
    policy: defaults,
    action: sendFile(10),
    context: FILE_CTX,
    expected: 'deny',
  },
  {
    name: 'file 100 MB in an allowed folder',
    policy: signed((p) => (p.files.allowedFolders = ['~/Work'])),
    action: sendFile(100 * MB),
    context: FILE_CTX,
    expected: 'allow',
  },
  {
    name: 'file 100 MB + 1',
    policy: signed((p) => (p.files.allowedFolders = ['~/Work'])),
    action: sendFile(100 * MB + 1),
    context: FILE_CTX,
    expected: 'deny',
  },
  // receipts
  {
    name: 'auto DELIVERED, defaults',
    policy: defaults,
    action: { kind: 'receipt.auto', receipt: 'delivered' },
    expected: 'allow',
  },
  {
    name: 'auto OPENED, defaults',
    policy: defaults,
    action: { kind: 'receipt.auto', receipt: 'opened' },
    expected: 'deny',
  },
  {
    name: 'auto DELIVERED off',
    policy: signed((p) => (p.receipts.autoDelivered = false)),
    action: { kind: 'receipt.auto', receipt: 'delivered' },
    expected: 'deny',
  },
  {
    name: 'auto OPENED on',
    policy: signed((p) => (p.receipts.autoOpened = true)),
    action: { kind: 'receipt.auto', receipt: 'opened' },
    expected: 'allow',
  },
];

describe('evaluate: one row per rule and boundary (06 §3)', () => {
  it.each(RULES)('$name → $expected', ({ policy, action, context, expected }) => {
    expect(evaluate(policy, action, context)).toBe(expected);
  });

  it('refuses to guess a missing hourly count for a contact envelope', () => {
    expect(() => evaluate(defaults, fromContact())).toThrow(
      expect.objectContaining({ code: 'policy_context_invalid' }),
    );
    expect(() => evaluate(defaults, fromContact(), hour(-1))).toThrow(
      expect.objectContaining({ code: 'policy_context_invalid' }),
    );
    expect(() => evaluate(defaults, fromContact(), hour(1.5))).toThrow(
      expect.objectContaining({ code: 'policy_context_invalid' }),
    );
  });
});

// G-6 (06 §3): once a version was applied, an invalid policy never gives the defaults.
const FAIL_CLOSED: readonly Row[] = [
  { name: 'invite', policy: failClosed, action: { kind: 'invite.accept' }, expected: 'approval' },
  {
    name: 'unknown sender is queued, not dropped',
    policy: failClosed,
    action: fromUnknown(),
    expected: 'approval',
  },
  {
    // G-6 owner decision (Tali, 2026-10-15): a paired contact may Talk without approval.
    name: 'contact envelope: a paired contact counts as allowed',
    policy: failClosed,
    action: fromContact(),
    context: hour(0),
    expected: 'allow',
  },
  {
    name: 'contact envelope at the default rate cap still passes (119 before)',
    policy: failClosed,
    action: fromContact(),
    context: hour(119),
    expected: 'allow',
  },
  {
    name: 'contact envelope over the default rate cap',
    policy: failClosed,
    action: fromContact(),
    context: hour(120),
    expected: 'deny',
  },
  {
    name: 'contact envelope over the default size cap',
    policy: failClosed,
    action: fromContact(24 * KB + 1),
    context: hour(0),
    expected: 'deny',
  },
  { name: 'send to a paired contact', policy: failClosed, action: send(), expected: 'allow' },
  {
    name: 'send over the default size cap',
    policy: failClosed,
    action: send(24 * KB + 1),
    expected: 'deny',
  },
  { name: 'commitment', policy: failClosed, action: ACK, expected: 'approval' },
  { name: 'paid proof', policy: failClosed, action: PROOF, context: PAID, expected: 'approval' },
  {
    // No folder is allowed under fail closed, so nothing is uploaded (06 §3).
    name: 'file send: no folder',
    policy: failClosed,
    action: sendFile(10),
    context: FILE_CTX,
    expected: 'deny',
  },
  {
    name: 'file over the default cap',
    policy: failClosed,
    action: sendFile(100 * MB + 1),
    context: FILE_CTX,
    expected: 'deny',
  },
  {
    name: 'key disclosure',
    policy: failClosed,
    action: { kind: 'key.disclose' },
    expected: 'approval',
  },
  {
    name: 'no automatic DELIVERED',
    policy: failClosed,
    action: { kind: 'receipt.auto', receipt: 'delivered' },
    expected: 'deny',
  },
  {
    name: 'no automatic OPENED',
    policy: failClosed,
    action: { kind: 'receipt.auto', receipt: 'opened' },
    expected: 'deny',
  },
];

describe('evaluate: G-6 fail closed (06 §3)', () => {
  it.each(FAIL_CLOSED)('$name → $expected', ({ policy, action, context, expected }) => {
    expect(evaluate(policy, action, context)).toBe(expected);
  });

  it('reads a paired contact as allowed for Talk under fail closed (G-6 owner decision, IR-M1-7d-1 F-1)', () => {
    expect(FAIL_CLOSED_CONTACTS).toBe('paired');
  });

  it('gives allow only for paired-contact Talk, whatever the action', () => {
    const talk = (a: PolicyAction) =>
      a.kind === 'envelope.send' || (a.kind === 'envelope.receive' && a.sender.kind === 'contact');
    for (const row of [...RULES, ...FAIL_CLOSED]) {
      const decision = evaluate(failClosed, row.action, row.context ?? hour(0));
      if (!talk(row.action)) expect(decision, row.name).not.toBe('allow');
    }
  });

  it('carries no policy document, so no value can be read from the defaults or a stored row', () => {
    expect(Object.keys(failClosed)).toEqual(['mode', 'problem']);
  });

  it('keeps the non-decision limits at the built-in hard caps and allows no folder', () => {
    expect(policyLimits(failClosed)).toEqual(FAIL_CLOSED_LIMITS);
    expect(FAIL_CLOSED_LIMITS).toEqual({
      maxEnvelopeBytes: 24 * KB,
      maxSendBytes: 100 * MB,
      maxReceiveBytes: 200 * MB,
      rateLimitPerContactPerHour: 120,
      defaultExpiryDays: 7,
      deleteAfter: 'expiry',
      allowedFolders: [],
      autoDelivered: false,
      autoOpened: false,
    });
    expect(Object.isFrozen(FAIL_CLOSED_LIMITS)).toBe(true);
  });

  it('reads the limits from a verified policy', () => {
    const p = signed((x) => {
      x.envelopes.maxEnvelopeKB = 2;
      x.files.maxSendSizeMB = 3;
      x.files.maxReceiveSizeMB = 4;
      x.files.allowedFolders = ['~/Work'];
      x.contacts.rateLimitPerContactPerHour = 5;
    });
    expect(policyLimits(p)).toMatchObject({
      maxEnvelopeBytes: 2 * KB,
      maxSendBytes: 3 * MB,
      maxReceiveBytes: 4 * MB,
      rateLimitPerContactPerHour: 5,
      allowedFolders: ['~/Work'],
    });
  });
});

// Property test (M1-7d acceptance): evaluate is deterministic and has no side effects. A seeded
// generator (no new dependency) draws policies, actions and contexts; inputs are deep-frozen, so a
// write would throw, and each call is repeated and compared.
function prng(seedValue: number): () => number {
  let s = seedValue >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

describe('evaluate is deterministic and side-effect free (property)', () => {
  it('returns the same decision twice and leaves every input unchanged', () => {
    const rand = prng(20261015);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const int = (max: number) => Math.floor(rand() * (max + 1));
    for (let i = 0; i < 2_000; i += 1) {
      const policy: EffectivePolicy = pick([
        () => defaults,
        () => failClosed,
        () =>
          signed((p) => {
            p.contacts.acceptInvites = pick(['approval', 'auto'] as const);
            p.contacts.unknownSenders = pick(['queue', 'drop'] as const);
            p.contacts.allowed = pick([
              'paired',
              [A],
              [A, B],
              [C],
            ] as const) as Policy['contacts']['allowed'];
            p.contacts.rateLimitPerContactPerHour = 1 + int(3599);
            p.envelopes.maxEnvelopeKB = 1 + int(23);
            p.commitments.accept = pick(['allow', 'approval', 'deny'] as const);
            p.proofs.notarize = pick(['allow', 'approval', 'deny'] as const);
            p.proofs.perActionMaxUSD = pick(['0', '0.5', '1', '2'] as const);
            p.proofs.dailyBudgetUSD = pick(['0', '1', '5'] as const);
            p.files.allowedFolders = pick([[], ['~/Work']] as const) as string[];
            p.files.storage = pick(['auto', 'drop', 'own'] as const);
            p.contactRules = pick([
              [],
              [{ contact: A, proofs: { notarize: 'allow' } }],
              [{ contact: A, proofs: { perActionMaxUSD: '3' } }],
            ] as const) as Policy['contactRules'];
            p.receipts.autoDelivered = rand() < 0.5;
            p.receipts.autoOpened = rand() < 0.5;
          }),
      ])();
      const action: PolicyAction = pick([
        () => ({ kind: 'invite.accept' }) as const,
        () => fromContact(int(30 * KB), pick([A, B, C])),
        () => fromUnknown(int(30 * KB)),
        () => send(int(30 * KB), pick([A, B, C])),
        () => ACK,
        () =>
          ({
            kind: 'proof',
            feeUsd: pick(['0', '0.5', '1', '2.5'] as const),
            maxFeeUsd: '3',
            counterparty: pick([null, { contact: A, ruleEligible: rand() < 0.5 }]),
          }) as const,
        () =>
          ({
            kind: 'file.send',
            sizeBytes: int(300 * MB),
            realpath: pick([`${WORK}/a.pdf`, '/etc/passwd']),
          }) as const,
        () => ({ kind: 'file.receive', sizeBytes: int(300 * MB) }) as const,
        () => ({ kind: 'key.disclose' }) as const,
        () => ({ kind: 'receipt.auto', receipt: pick(['delivered', 'opened'] as const) }) as const,
      ])();
      const context: PolicyContext = {
        ...hour(int(4000)),
        ...FILE_CTX,
        ownStorageConfigured: rand() < 0.5,
        dropCanTake: rand() < 0.5,
        now: PAID.now!,
        ledger: pick([
          PAID.ledger!,
          { status: 'broken' } as const,
          {
            status: 'ok',
            epoch: 1,
            newestT: PAID.now! - int(90_000),
            entries: [
              {
                t: PAID.now! - int(90_000),
                ledgerEpoch: 1,
                state: pick(['reserved', 'charged', 'released'] as const),
                reservedUsd: '2',
                chargedUsd: '1',
              },
            ],
          } as const,
        ]),
      };
      const before = JSON.stringify([policy, action, context]);
      deepFreeze(policy);
      deepFreeze(action);
      deepFreeze(context);
      const first = evaluate(policy, action, context);
      const second = evaluate(policy, action, context);
      expect(second).toBe(first);
      expect(['allow', 'approval', 'deny']).toContain(first);
      expect(JSON.stringify([policy, action, context])).toBe(before);
      const talk =
        action.kind === 'envelope.send' ||
        (action.kind === 'envelope.receive' && action.sender.kind === 'contact');
      if (policy.mode === 'fail_closed' && !talk) expect(first).not.toBe('allow');
    }
  });
});
