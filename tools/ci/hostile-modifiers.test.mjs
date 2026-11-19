// REL-0514 CI-E2E-MODIFIER: pins the modifier and call-count check used by e2e.yml.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scanTestSource } from './hostile-modifiers.mjs';

describe('hostile suite modifier check', () => {
  it('passes plain calls and counts them', () => {
    expect(scanTestSource("it('a', () => {});\n  test('b', async () => {});\n")).toEqual({
      modifier: false,
      count: 2,
    });
  });

  it.each([
    "it.skip('a', () => {});",
    "  test.only('a', () => {});",
    "describe.each([1])('x', () => {});",
    "it ('a', () => {}); it.todo('b');",
    "foo(); it.skip('a', () => {});",
    "const run = () => test\n  .only('a', () => {});",
    "describe('s', () => { it . fails('a', () => {}); });",
  ])('flags %j', (src) => {
    expect(scanTestSource(src).modifier).toBe(true);
  });

  it('ignores comment, string and template text', () => {
    const src = [
      '// the first it. is a false positive; test.skip is only comment text',
      '/* it.only( in a block comment */',
      "const a = 'it.skip(x)';",
      'const b = "test.only";',
      'const c = `it.todo ${x} describe.each`;',
      "it('says it. aloud and test.skip', () => { expect(obj.it.value).toBe(1); });",
      '',
    ].join('\n');
    expect(scanTestSource(src)).toEqual({ modifier: false, count: 1 });
  });

  it('does not treat property access as a declaration', () => {
    expect(scanTestSource('x.test.skip(); ctx.it(1);')).toEqual({ modifier: false, count: 0 });
  });

  it('counts a call that follows other code on the same line', () => {
    expect(scanTestSource("a(); it('x', () => {});").count).toBe(1);
  });

  it('the real hostile suites carry no modifier', () => {
    for (const name of ['relay-availability', 'hostile-contact', 'uploads-and-proofs']) {
      const src = readFileSync(
        new URL(`../../e2e/hostile/${name}.test.ts`, import.meta.url),
        'utf8',
      );
      const r = scanTestSource(src);
      expect(r.modifier, name).toBe(false);
      expect(r.count, name).toBeGreaterThan(0);
    }
  });
});
