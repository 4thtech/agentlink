// RET-6 (S2; D-148; 06 §3 `history`; 04 §4.2 "Retention policy"; proposed, owner confirms at merge):
// the two retention keys of the owner-signed policy.
// - `history.messagesKeepDays` takes 0 (keep forever), 90, 365 or 730; `history.filesKeepDays` takes
//   0, 30, 90, 180 or 365. Any other value, type or spelling is rejected (fail closed).
// - `history` may be absent only in a policy signed before D-148; it then reads as 0 and 0, so an
//   update never starts deleting. When present it is a strict object with both keys.
// - The 06 §3 defaults (the first rules of a new ID) carry `filesKeepDays: 90`, `messagesKeepDays: 0`.
import { describe, expect, it } from 'vitest';
import {
  HISTORY_FILES_KEEP_DAYS,
  HISTORY_MESSAGES_KEEP_DAYS,
  HISTORY_PRE_D148,
  POLICY_DEFAULTS,
  defaultPolicy,
  historyOf,
  policyPatchSchema,
  policySchema,
  type Policy,
} from './index.js';

const withHistory = (history: unknown): unknown => ({ ...defaultPolicy(), history });

describe('history.* policy keys (RET-6, 06 §3)', () => {
  it('lists exactly the 06 §3 values', () => {
    expect([...HISTORY_MESSAGES_KEEP_DAYS]).toEqual([0, 90, 365, 730]);
    expect([...HISTORY_FILES_KEEP_DAYS]).toEqual([0, 30, 90, 180, 365]);
  });

  it('accepts every listed value', () => {
    for (const m of HISTORY_MESSAGES_KEEP_DAYS) {
      for (const f of HISTORY_FILES_KEEP_DAYS) {
        const doc = withHistory({ messagesKeepDays: m, filesKeepDays: f });
        expect(policySchema.safeParse(doc).success, `${String(m)}/${String(f)}`).toBe(true);
      }
    }
  });

  it('rejects any other value, type or shape (fail closed)', () => {
    const bad: unknown[] = [
      { messagesKeepDays: 30, filesKeepDays: 90 },
      { messagesKeepDays: 0, filesKeepDays: 7 },
      { messagesKeepDays: -1, filesKeepDays: 0 },
      { messagesKeepDays: 0, filesKeepDays: 90.5 },
      { messagesKeepDays: '90', filesKeepDays: 0 },
      { messagesKeepDays: 0, filesKeepDays: 'off' },
      { messagesKeepDays: 0, filesKeepDays: null },
      { messagesKeepDays: 0 },
      { filesKeepDays: 90 },
      { messagesKeepDays: 0, filesKeepDays: 90, extra: 1 },
      { messagesKeepDays: 0, filesKeepDays: 1e9 },
      null,
      'forever',
      [],
    ];
    for (const history of bad) {
      expect(policySchema.safeParse(withHistory(history)).success, JSON.stringify(history)).toBe(
        false,
      );
    }
  });

  it('may be absent (a policy signed before D-148) and then reads as keep forever', () => {
    const old = defaultPolicy() as Partial<Policy>;
    delete old.history;
    const parsed = policySchema.safeParse(old);
    expect(parsed.success).toBe(true);
    expect(HISTORY_PRE_D148).toEqual({ messagesKeepDays: 0, filesKeepDays: 0 });
    expect(historyOf(parsed.data as Policy)).toEqual({ messagesKeepDays: 0, filesKeepDays: 0 });
  });

  it('an explicit undefined is rejected, never read as absent', () => {
    expect(policySchema.safeParse({ ...defaultPolicy(), history: undefined }).success).toBe(false);
  });

  it('the 06 §3 defaults (a new ID): files 90 days, messages forever', () => {
    expect(POLICY_DEFAULTS.history).toEqual({ messagesKeepDays: 0, filesKeepDays: 90 });
    expect(historyOf(defaultPolicy())).toEqual({ messagesKeepDays: 0, filesKeepDays: 90 });
  });

  it('a patch may name history fields, each from the same list', () => {
    expect(policyPatchSchema.safeParse({ history: { filesKeepDays: 30 } }).success).toBe(true);
    expect(policyPatchSchema.safeParse({ history: { messagesKeepDays: 730 } }).success).toBe(true);
    expect(policyPatchSchema.safeParse({ history: { filesKeepDays: 31 } }).success).toBe(false);
    expect(policyPatchSchema.safeParse({ history: { other: 1 } }).success).toBe(false);
  });
});
