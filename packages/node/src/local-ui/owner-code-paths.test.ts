// DESK051-C2 (S2; 04 §2.5 "Touch ID & master code page" and "Desktop app owner presence"): which kind
// of proof each owner-code step takes. Native presence (the desktop app's Touch ID or Windows Hello
// helper) carries no typed code and no passkey assertion, so it may stand in for Touch ID where the
// step asks for Touch ID (Test, and Replace which takes any presence) and never where the step is
// about the typed master code itself (Check, the new code typed back) or takes no proof (Cancel).
import { describe, expect, it } from 'vitest';
import { OWNER_CODE_STEPS, ownerCodeProofAllowed } from './owner-code-paths.js';

describe('ownerCodeProofAllowed: one rule per step and proof kind', () => {
  const table = {
    check: { code: true, passkey: false, native: false },
    test: { code: false, passkey: true, native: true },
    replace: { code: true, passkey: true, native: true },
    finish: { code: true, passkey: false, native: false },
    cancel: { code: true, passkey: false, native: false },
  } as const;

  it('covers every step', () => {
    expect(Object.keys(table).sort()).toEqual([...OWNER_CODE_STEPS].sort());
  });

  for (const step of OWNER_CODE_STEPS) {
    for (const kind of ['code', 'passkey', 'native'] as const) {
      it(`${step} with ${kind}: ${String(table[step][kind])}`, () => {
        expect(ownerCodeProofAllowed(step, kind)).toBe(table[step][kind]);
      });
    }
  }

  it('of the Touch ID & master code steps, native presence is never accepted where a typed code is the point', () => {
    expect(ownerCodeProofAllowed('check', 'native')).toBe(false);
    expect(ownerCodeProofAllowed('finish', 'native')).toBe(false);
  });
});
