// @vitest-environment jsdom
// W4-WIRE (U5 lows): an intent without its time is an old-format entry and is dropped (never treated
// as "now", which would keep it forever); every body string that carries an agent's label holds it
// as its own bidi-isolated run (I-5; #716 SEC L2).
import { afterEach, describe, expect, it } from 'vitest';
import { INTENT_KEY, takeIntent } from './intent.js';
import { AGENTS_STRINGS as S, iso } from './strings.js';

afterEach(() => sessionStorage.clear());

describe('W4-WIRE: the kept intent', () => {
  it('drops an entry with no time (old format) instead of keeping it as now', () => {
    sessionStorage.setItem(INTENT_KEY, JSON.stringify({ name: 'work', action: 'pause' }));
    expect(takeIntent('work')).toBeUndefined();
    expect(sessionStorage.getItem(INTENT_KEY)).toBeNull();
  });

  it('still takes a fresh one for the open agent', () => {
    const now = 1_000_000;
    sessionStorage.setItem(INTENT_KEY, JSON.stringify({ name: 'work', action: 'pause', at: now }));
    expect(takeIntent('work', now + 1000)).toBe('pause');
  });
});

describe('W4-WIRE: labels in body strings are bidi-isolated', () => {
  const L = 'Work‮';
  it.each([
    ['keysAndSettings', S.keysAndSettings(L)],
    ['contactsTold', S.contactsTold(L, 2)],
    ['quitAny', S.quitAny(L)],
    ['removeFailed', S.removeFailed(L)],
    ['removed', S.removed(L)],
    ['nowShowing', S.nowShowing(L)],
    ['switching', S.switching(L)],
    ['peopleOther', S.peopleOther(L)],
    ['rulesOther', S.rulesOther(L)],
  ])('%s', (_name, text) => {
    expect(text).toContain(iso(L));
  });
});
