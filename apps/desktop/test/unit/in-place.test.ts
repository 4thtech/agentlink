// OWNER-FB-0512: an unrelated `ready` (an Updates open) must not use up the pending in-place ask.
import { describe, expect, it } from 'vitest';
import { inPlaceReply } from '../../src/main/in-place.js';

const PERSON = `0x${'ab'.repeat(20)}`;
const OTHER = `0x${'cd'.repeat(20)}`;
const TOKEN = 'T'.repeat(43);
const asked = { route: 'inbox', target: PERSON };
const url = (path: string, hash = ''): string => `http://localhost:4567${path}?t=${TOKEN}${hash}`;

describe('inPlaceReply', () => {
  it('an unrelated ready (Updates, another person, no ask) leaves the ask alone', () => {
    expect(inPlaceReply(asked, url('/settings/updates'), false)).toBe('other');
    expect(inPlaceReply(asked, url('/', `#person=${OTHER}`), false)).toBe('other');
    expect(inPlaceReply(null, url('/', `#person=${PERSON}`), false)).toBe('other');
  });

  it('the answer to the ask: loaded as usual when the window can move in place', () => {
    expect(inPlaceReply(asked, url('/', `#person=${PERSON}`), true)).toBe('answered');
    expect(inPlaceReply(asked, url('/', `#person=${PERSON}&files`), true)).toBe('answered');
  });

  it('the answer when the window cannot move in place any more: ask again', () => {
    expect(inPlaceReply(asked, url('/', `#person=${PERSON}`), false)).toBe('reask');
  });

  it('an Updates ready, then the answer: the ask survives the first', () => {
    expect(inPlaceReply(asked, url('/settings/updates'), true)).toBe('other');
    expect(inPlaceReply(asked, url('/', `#person=${PERSON}`), true)).toBe('answered');
  });
});
