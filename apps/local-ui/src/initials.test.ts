// R1-UI-24: Home and People draw the same monogram for a person.
import { describe, expect, it } from 'vitest';
import { initials } from './initials.js';

describe('initials', () => {
  it('takes the first letter of the first two words', () => {
    expect(initials('Bo')).toBe('B');
    expect(initials('Bartholomew Maximilian Fitzgera')).toBe('BM');
    expect(initials('  ana novak ')).toBe('AN');
  });
  it('is "#" for an unnamed contact and "?" for nothing', () => {
    expect(initials('Contact 7F3A')).toBe('#');
    expect(initials('')).toBe('?');
  });
});
