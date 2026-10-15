import { describe, expect, it } from 'vitest';
import { parseYaml } from './yaml.mjs';

describe('parseYaml', () => {
  it('reads maps, nested maps, lists of maps, lists of scalars and flow lists', () => {
    const doc = [
      '# a comment',
      'name: plain value # trailing comment',
      'quoted: "a: b, # not a comment \\"x\\""',
      'empty:',
      'nested:',
      '  inner: 1',
      '  deeper:',
      '    - one',
      '    - two',
      'items:',
      '  - id: a',
      '    prs: [1, "contracts#4"]',
      '    sub:',
      '      - name: x',
      '        state: done',
      '  - id: b',
      '    prs: []',
      '',
    ].join('\n');
    expect(parseYaml(doc)).toEqual({
      name: 'plain value',
      quoted: 'a: b, # not a comment "x"',
      empty: '',
      nested: { inner: '1', deeper: ['one', 'two'] },
      items: [
        { id: 'a', prs: ['1', 'contracts#4'], sub: [{ name: 'x', state: 'done' }] },
        { id: 'b', prs: [] },
      ],
    });
  });

  it('keeps a comma inside a quoted flow-list item', () => {
    expect(parseYaml('k: ["a, b", c]')).toEqual({ k: ['a, b', 'c'] });
  });

  it('returns an empty object for an empty document', () => {
    expect(parseYaml('# only a comment\n\n')).toEqual({});
  });

  it.each([
    ['a tab', 'k:\n\tv: 1'],
    ['a duplicate key', 'k: 1\nk: 2'],
    ['an unterminated string', 'k: "abc'],
    ['text after a closing quote', 'k: "abc" def'],
    ['an unsupported escape', 'k: "a\\qb"'],
    ['a single-quoted string', "k: 'abc'"],
    ['an anchor', 'k: &a b'],
    ['a block scalar', 'k: |\n  text'],
    ['a flow map', 'k: {a: 1}'],
    ['an unclosed flow list', 'k: [a, b'],
    ['a line that is not "key: value"', 'k: 1\njust text'],
    ['a stray indent', 'k: 1\n    j: 2'],
    ['an empty list item', 'k:\n  -\nj: 1'],
  ])('rejects %s', (_label, doc) => {
    expect(() => parseYaml(doc)).toThrow(/status\.yaml line \d+/);
  });
});
