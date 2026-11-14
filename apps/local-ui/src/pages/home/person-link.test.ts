// NOTIFY-DEEPLINK (S1): Home opens the one person a notification click named, and nothing else.
import { describe, expect, it } from 'vitest';
import { personFromHash } from './person-link.js';

const ID = `0x${'ab'.repeat(20)}`;

describe('personFromHash', () => {
  it('reads one opaque contact ID', () => {
    expect(personFromHash(`#person=${ID}`)).toBe(ID);
  });

  it('ignores any other fragment, shape or extra part', () => {
    for (const hash of [
      '',
      '#',
      '#person=',
      '#person=0x12',
      `#person=${ID}&x=1`,
      `#x=${ID}`,
      `#person=${ID.toUpperCase()}`,
      '#person=../../etc',
    ]) {
      expect(personFromHash(hash)).toBeUndefined();
    }
  });
});
