// M1-11r-b (D-118): the typed policy patch a signing surface edits before the core builds the
// complete `policy.set` document (04 §2.5.1; 06 §3). The patch itself is never signed: `policy.set`
// always carries the whole document. The patch is strict at every level, like the policy: an unknown
// section or field, an explicit `undefined` and any value the policy schema refuses are rejected,
// never dropped or normalised.
import { describe, expect, it } from 'vitest';
import { POLICY_DEFAULTS, policyPatchSchema, policySchema } from './index.js';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';

describe('policyPatchSchema (M1-11r-b)', () => {
  it('has exactly the policy sections, and each object section exactly the policy fields', () => {
    expect(Object.keys(policyPatchSchema.shape).sort()).toEqual(
      Object.keys(policySchema.shape).sort(),
    );
    for (const section of Object.keys(POLICY_DEFAULTS) as (keyof typeof POLICY_DEFAULTS)[]) {
      const value = POLICY_DEFAULTS[section];
      if (Array.isArray(value)) continue;
      const patchSection = policyPatchSchema.shape[section] as unknown as {
        unwrap(): { shape: Record<string, unknown> };
      };
      expect(Object.keys(patchSection.unwrap().shape).sort()).toEqual(
        Object.keys(value as object).sort(),
      );
    }
  });

  it('accepts an empty patch, one field of one section, and a whole contactRules list', () => {
    expect(policyPatchSchema.safeParse({}).success).toBe(true);
    expect(policyPatchSchema.safeParse({ files: { allowedFolders: ['~/Projects'] } }).success).toBe(
      true,
    );
    expect(
      policyPatchSchema.safeParse({
        proofs: { notarize: 'approval', dailyBudgetUSD: '2.5' },
        contactRules: [{ contact: A, proofs: { notarize: 'allow' } }],
      }).success,
    ).toBe(true);
  });

  const refused: [string, unknown][] = [
    ['an unknown section', { network: { relays: [] } }],
    ['an unknown field', { files: { allowedFolders: [], extra: true } }],
    ['an explicit undefined field', { files: { allowedFolders: undefined } }],
    ['an explicit undefined section', { files: undefined }],
    ['key disclosure set to allow (never allow, 06 §3)', { proofs: { allowKeyDisclosure: 'allow' } }],
    ['an expiry above 7 days', { files: { defaultExpiryDays: 8 } }],
    ['a USD amount as a JSON number', { proofs: { dailyBudgetUSD: 5 } }],
    ['a non-canonical USD amount', { proofs: { perActionMaxUSD: '1.00' } }],
    ['an unsorted contact list', { commitments: { autoAcceptContacts: [B, A] } }],
    ['a duplicate allowed folder', { files: { allowedFolders: ['~/a', '~/a'] } }],
    ['a folder with a bidi control', { files: { allowedFolders: ['~/a‮b'] } }],
    ['33 allowed folders', { files: { allowedFolders: Array.from({ length: 33 }, (_, i) => `~/f${i}`) } }],
    ['a contactRules entry with no rule', { contactRules: [{ contact: A }] }],
    ['a partial contactRules list item', { contactRules: [{ proofs: { notarize: 'allow' } }] }],
    ['a section that is not an object', { files: [] }],
    ['a patch that is not an object', null],
  ];
  for (const [name, patch] of refused) {
    it(`refuses ${name}`, () => {
      expect(policyPatchSchema.safeParse(patch).success).toBe(false);
    });
  }
});
