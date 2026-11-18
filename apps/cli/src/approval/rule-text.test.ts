// SEC-RESTORE-GUARD (D-156; 11 §5): why a paid action waits for the owner after a restore or an
// update, in its own words, never as the daily limit.
import { describe, expect, it } from 'vitest';

describe('approval card reason after a restore or an update', () => {
  it('a restore and an update each have their own sentence', async () => {
    const { ruleText } = await import('./ui-source.js');
    const restored = ruleText(['proofs.restored']);
    const updated = ruleText(['proofs.updated']);
    expect(restored).toMatch(/restored from a backup/);
    expect(restored).toMatch(/asks you before anything that costs money/);
    expect(updated).toMatch(/updated/);
    expect(updated).not.toMatch(/restored/);
    expect(updated).toMatch(/asks you before anything that costs money/);
    for (const text of [restored, updated]) expect(text).not.toMatch(/daily limit/);
  });
});
