// W4-AUTO-SAVE (S2; D-142; 06 §3 "Policy JSON form", "Per-contact rules"; proposed, owner confirms
// at merge): `files.autoSave` and `contactRules[].files.askBeforeSaving`.
import { describe, expect, it } from 'vitest';
import {
  AUTO_SAVE_DEFAULTS,
  contactRuleSchema,
  defaultPolicy,
  policyPatchSchema,
  policySchema,
} from './policy.js';

const CONTACT = `0x${'a'.repeat(40)}`;

describe('files.autoSave (06 §3, D-142)', () => {
  it('a policy without it (signed before D-142) stays valid', () => {
    const p = defaultPolicy();
    expect('autoSave' in p.files).toBe(false);
    expect(policySchema.safeParse(p).success).toBe(true);
  });

  it('when present it is a strict object with all five keys, in range', () => {
    const p = defaultPolicy() as unknown as { files: Record<string, unknown> };
    p.files['autoSave'] = { ...AUTO_SAVE_DEFAULTS };
    expect(policySchema.safeParse(p).success).toBe(true);
    for (const bad of [
      { on: true },
      { ...AUTO_SAVE_DEFAULTS, extra: 1 },
      { ...AUTO_SAVE_DEFAULTS, perContactFilesPerDay: 0 },
      { ...AUTO_SAVE_DEFAULTS, totalFilesPerDay: 1001 },
      { ...AUTO_SAVE_DEFAULTS, perContactMBPerDay: 10_241 },
      { ...AUTO_SAVE_DEFAULTS, totalMBPerDay: 1.5 },
      { ...AUTO_SAVE_DEFAULTS, on: 'yes' },
      null,
    ]) {
      p.files['autoSave'] = bad;
      expect(policySchema.safeParse(p).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('a patch replaces it whole', () => {
    expect(
      policyPatchSchema.safeParse({ files: { autoSave: { ...AUTO_SAVE_DEFAULTS, on: false } } })
        .success,
    ).toBe(true);
    expect(policyPatchSchema.safeParse({ files: { autoSave: { on: false } } }).success).toBe(false);
  });
});

describe('contactRules[].files.askBeforeSaving (06 §3, D-142)', () => {
  it('is exactly true, alone or with other parts', () => {
    expect(
      contactRuleSchema.safeParse({ contact: CONTACT, files: { askBeforeSaving: true } }).success,
    ).toBe(true);
    expect(
      contactRuleSchema.safeParse({
        contact: CONTACT,
        receipts: { autoDelivered: false },
        files: { askBeforeSaving: true },
      }).success,
    ).toBe(true);
    for (const files of [{ askBeforeSaving: false }, {}, { askBeforeSaving: true, x: 1 }]) {
      expect(contactRuleSchema.safeParse({ contact: CONTACT, files }).success).toBe(false);
    }
    expect(contactRuleSchema.safeParse({ contact: CONTACT }).success).toBe(false);
  });
});
