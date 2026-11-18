// NOTIFY-DEEPLINK (S1): Home opens the one person a notification click named, and nothing else.
import { describe, expect, it } from 'vitest';
import { filesFromHash, personFromHash } from './person-link.js';

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

describe('filesFromHash (OWNER-FB-0512)', () => {
  it('is true only for the person link with the files marker', () => {
    expect(personFromHash(`#person=${ID}&files`)).toBe(ID);
    expect(filesFromHash(`#person=${ID}&files`)).toBe(true);
    expect(filesFromHash(`#person=${ID}`)).toBe(false);
    expect(filesFromHash(`#person=${ID}&files=1`)).toBe(false);
    expect(filesFromHash('#files')).toBe(false);
  });
});
