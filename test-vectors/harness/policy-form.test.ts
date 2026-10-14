// Cross-check of the owner-action `policy.set` vectors against the M1-2b strict policy schema
// (M1-1h-c, IR-M1-2b-1). The vectors come from the independent Python generator
// (tools/vectors/generate_owner_action.py) and the schema from @agentlink/types; neither is derived
// from the other, so agreement is evidence that both follow 06 §3 "Policy JSON form" (G-32) and
// 04 §2.5.1. Runs in the Node project only: the schema is plain data validation and the vector files
// are identical in every runtime. The owner-action suite itself stays pending until M1-7d.
import { defaultPolicy, policySetActionSchema, signedPolicySetSchema } from '@agentlink/types';
import { describe, expect, test } from 'vitest';
import { vectorFiles, type VectorCase } from './registry';

interface Body {
  readonly op?: unknown;
  readonly params?: { readonly policy?: { readonly contactRules?: unknown } };
}
interface Input {
  readonly op?: unknown;
  readonly body?: Body;
  readonly signed?: { readonly body?: Body };
}

const ownerAction = vectorFiles.find((f) => f.directory === 'owner-action')?.file;
const cases: readonly VectorCase[] = ownerAction?.cases ?? [];
const input = (c: VectorCase): Input => c.input as Input;

const signCases = cases.filter((c) => input(c).op === 'sign' && input(c).body?.op === 'policy.set');
const verifyCases = cases.filter(
  (c) => input(c).op === 'verify' && input(c).signed?.body?.op === 'policy.set',
);
const byId = (id: string) => cases.find((c) => c.id === id);

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

  test('the pre-G-32 form (JSON-number USD, no contactRules) is kept as a rejection vector', () => {
    const c = byId('reject-policy-set-pre-g32-form');
    expect(c, 'reject-policy-set-pre-g32-form is missing').toBeDefined();
    expect((c as VectorCase).expected).toStrictEqual({ outcome: 'reject' });
  });

  test('every policy.set verify vector agrees with the strict schema', () => {
    expect(verifyCases.length).toBeGreaterThan(0);
    for (const c of verifyCases) {
      const accept = (c.expected as { outcome?: unknown }).outcome === 'accept';
      const parsed = signedPolicySetSchema.safeParse(input(c).signed);
      expect(parsed.success, `${c.id}: schema ${parsed.success ? 'accepts' : 'rejects'}`).toBe(
        accept,
      );
      if (!accept) {
        // The refusal is the policy's alone: the same action with the defaults as `policy` passes.
        const signed = input(c).signed as { body: { params: object } };
        const fixed = {
          ...signed,
          body: { ...signed.body, params: { ...signed.body.params, policy: defaultPolicy() } },
        };
        expect(
          signedPolicySetSchema.safeParse(fixed).success,
          `${c.id}: not a policy refusal`,
        ).toBe(true);
      }
    }
  });
});
