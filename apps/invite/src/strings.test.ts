// M1-19 (S1; 11 §5.1): the page copy passes the in-chat vocabulary lint, and none of it is built
// from the invite.
import { describe, expect, it } from 'vitest';
import { strings } from './strings.js';
import { BANNED } from './testing/vocabulary.js';

const texts = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Object.values(value as Record<string, unknown>).flatMap(texts);

describe('page copy', () => {
  it('passes the vocabulary lint (11 §5.1)', () => {
    for (const text of texts(strings)) {
      for (const [name, pattern] of BANNED)
        expect(pattern.test(text), `${name}: ${text}`).toBe(false);
    }
  });

  it('has no placeholder, so nothing from the invite can be formatted into it', () => {
    for (const text of texts(strings)) expect(text).not.toMatch(/[{}]/);
  });

  it('labels the inviter Self-declared (11 §5.2)', () => {
    expect(strings.inviter.label).toBe('Self-declared');
  });
});
