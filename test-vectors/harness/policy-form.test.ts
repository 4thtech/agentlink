// Cross-check of the owner-action `policy.set` vectors against the M1-2b strict policy schema
// (M1-1h-c, IR-M1-2b-1). The vectors come from the independent Python generator
// (tools/vectors/generate_owner_action.py) and the schema from @4thtech-io/types; neither is derived
// from the other, so agreement is evidence that both follow 06 §3 "Policy JSON form" (G-32) and
// 04 §2.5.1. Runs in the Node project only: the schema is plain data validation and the vector files
// are identical in every runtime. The owner-action suite itself stays pending until M1-7d.
import { defaultPolicy, policySetActionSchema, signedPolicySetSchema } from '@4thtech-io/types';
import { describe, expect, test } from 'vitest';
import { vectorFiles, type VectorCase } from './registry';

type Json = Record<string, unknown>;
interface Body {
  readonly op?: unknown;
  readonly params?: { readonly version?: unknown; readonly policy?: Json };
}
interface Input {
  readonly op?: unknown;
  readonly body?: Body;
  readonly signed?: { readonly body?: Body };
  readonly context?: { readonly appliedPolicyVersion?: unknown };
}

const ownerAction = vectorFiles.find((f) => f.directory === 'owner-action')?.file;
const cases: readonly VectorCase[] = ownerAction?.cases ?? [];
const input = (c: VectorCase): Input => c.input as Input;

const signCases = cases.filter((c) => input(c).op === 'sign' && input(c).body?.op === 'policy.set');
const verifyCases = cases.filter(
  (c) => input(c).op === 'verify' && input(c).signed?.body?.op === 'policy.set',
);
const byId = (id: string) => cases.find((c) => c.id === id);
const outcome = (c: VectorCase) => (c.expected as { outcome?: unknown }).outcome;
const version = (c: VectorCase) => input(c).signed?.body?.params?.version;
/** 06 §3, 04 §2.5.1: an agent with no policy applied yet has highest applied version 0. */
const applied = (c: VectorCase) => input(c).context?.appliedPolicyVersion ?? 0;

const clone = <T>(v: T): T => structuredClone(v);
const at = (p: Json, ...path: string[]): Json =>
  path.reduce<Json>((node, key) => node[key] as Json, p);

/**
 * The smallest repair for each schema rejection: undoing exactly the rule the vector names must
 * make the strict schema accept it (IR-M1-1h-c-1 L-2). A vector that broke a second rule, or another
 * rule than its name says, still fails after the repair.
 */
const REPAIRS: Readonly<Record<string, (p: Json) => void>> = {
  'reject-policy-set-pre-g32-form': (p) => {
    // The whole pre-G-32 form on purpose: JSON-number USD and no contactRules.
    at(p, 'proofs').dailyBudgetUSD = '5';
    at(p, 'proofs').perActionMaxUSD = '1';
    at(p, 'commitments').autoAcceptMaxUSD = '0';
    p.contactRules = [];
  },
  'reject-policy-set-usd-number': (p) => {
    at(p, 'proofs').dailyBudgetUSD = String(at(p, 'proofs').dailyBudgetUSD);
  },
  'reject-policy-set-usd-seven-decimals': (p) => {
    at(p, 'proofs').perActionMaxUSD = '5';
  },
  'reject-policy-set-usd-trailing-zeros': (p) => {
    at(p, 'proofs').dailyBudgetUSD = '5';
  },
  'reject-policy-set-unsorted-auto-accept-contacts': (p) => {
    (at(p, 'commitments').autoAcceptContacts as string[]).sort();
  },
  'reject-policy-set-unsorted-contact-rules': (p) => {
    (p.contactRules as { contact: string }[]).sort((a, b) => (a.contact < b.contact ? -1 : 1));
  },
  'reject-policy-set-duplicate-contact-rule': (p) => {
    (p.contactRules as unknown[]).pop();
  },
  'reject-policy-set-contact-rule-empty-proofs': (p) => {
    (p.contactRules as { proofs: Json }[])[0]!.proofs.notarize = 'allow';
  },
  'reject-policy-set-contact-rule-unknown-key': (p) => {
    delete (p.contactRules as Json[])[0]!.note;
  },
  // D-109 (M1-33a): a ContactRule's `receipts` part.
  'reject-policy-set-contact-rule-no-part': (p) => {
    (p.contactRules as Json[])[0]!.receipts = { autoDelivered: true };
  },
  'reject-policy-set-contact-rule-empty-receipts': (p) => {
    (p.contactRules as { receipts: Json }[])[0]!.receipts.autoDelivered = true;
  },
  'reject-policy-set-contact-rule-receipts-opened': (p) => {
    delete (p.contactRules as { receipts: Json }[])[0]!.receipts.autoOpened;
  },
  'reject-policy-set-missing-key': (p) => {
    at(p, 'files').storage = 'auto';
  },
};

/** Rejections that the schema accepts: `version` not above the highest applied one (04 §2.5.1). */
const ROLLBACKS = new Set(['reject-policy-set-version-equal', 'reject-policy-set-version-lower']);

describe('owner-action policy.set vectors follow the 06 §3 policy JSON form (G-32)', () => {
  test('the owner-action suite is committed', () => {
    expect(ownerAction).toBeDefined();
  });

  test('every policy.set signing body is accepted by the strict schema', () => {
    expect(signCases.length).toBeGreaterThan(0);
    for (const c of signCases) {
      const parsed = policySetActionSchema.safeParse(input(c).body);
      expect(parsed.success, `${c.id}: ${parsed.error?.message ?? ''}`).toBe(true);
    }
  });

  test('`sign-policy-set` signs exactly the 06 §3 defaults (04 §2.5.1 signing vectors)', () => {
    const c = byId('sign-policy-set');
    expect(c, 'sign-policy-set is missing').toBeDefined();
    expect(input(c as VectorCase).body?.params?.policy).toStrictEqual(defaultPolicy());
  });

  test('one policy.set signing vector carries a non-empty contactRules (04 §2.5.1)', () => {
    const withRules = signCases.filter((c) => {
      const rules = input(c).body?.params?.policy?.contactRules;
      return Array.isArray(rules) && rules.length >= 2;
    });
    expect(withRules.map((c) => c.id)).not.toHaveLength(0);
  });

  test('every named rejection and rollback vector is committed', () => {
    for (const id of [...Object.keys(REPAIRS), ...ROLLBACKS]) {
      expect(byId(id), `${id} is missing`).toBeDefined();
      expect(byId(id)?.expected, id).toStrictEqual({ outcome: 'reject' });
    }
  });

  test('policy.set verifies when version is above the applied version (IR-M1-1h-c-1 M-1)', () => {
    const accepts = verifyCases.filter((c) => outcome(c) === 'accept');
    // One with no policy applied yet (context field absent = 0), one above an applied version.
    expect(accepts.some((c) => input(c).context?.appliedPolicyVersion === undefined)).toBe(true);
    expect(accepts.some((c) => typeof input(c).context?.appliedPolicyVersion === 'number')).toBe(
      true,
    );
    for (const c of accepts) {
      expect(signedPolicySetSchema.safeParse(input(c).signed).success, c.id).toBe(true);
      expect(version(c) as number, c.id).toBeGreaterThan(applied(c) as number);
    }
  });

  test('a version equal to or below the applied version is a rollback (04 §2.5.1)', () => {
    const rollbacks = verifyCases.filter((c) => ROLLBACKS.has(c.id));
    expect(rollbacks.map((c) => version(c) === applied(c)).sort()).toStrictEqual([false, true]);
    for (const c of rollbacks) {
      expect(signedPolicySetSchema.safeParse(input(c).signed).success, c.id).toBe(true);
      expect(version(c) as number, c.id).toBeLessThanOrEqual(applied(c) as number);
    }
  });

  test('every policy.set rejection is refused by the schema for exactly its named rule', () => {
    const rejects = verifyCases.filter((c) => outcome(c) === 'reject' && !ROLLBACKS.has(c.id));
    expect(rejects.length).toBeGreaterThan(0);
    for (const c of rejects) {
      const repair = REPAIRS[c.id];
      expect(repair, `${c.id}: no minimal repair listed`).toBeDefined();
      const signed = input(c).signed;
      expect(signedPolicySetSchema.safeParse(signed).success, `${c.id}: schema accepts`).toBe(
        false,
      );
      const fixed = clone(signed) as { body: { params: { policy: Json } } };
      repair!(fixed.body.params.policy);
      const parsed = signedPolicySetSchema.safeParse(fixed);
      expect(parsed.success, `${c.id} after repair: ${parsed.error?.message ?? ''}`).toBe(true);
    }
  });
});
