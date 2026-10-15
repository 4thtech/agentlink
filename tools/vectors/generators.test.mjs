import { describe, expect, it } from 'vitest';
import {
  MISMATCH_EXIT,
  describeGeneratorRun,
  generatorCheck,
  suitesTableProblems,
} from './generators.mjs';

const path = 'test-vectors/placeholder-sha256/vectors.json';
const present = () => true;
const file = (script) => ({ generator: { tool: 't', version: '1', script } });

describe('generatorCheck', () => {
  it('runs the named generator in check mode against the committed file', () => {
    expect(generatorCheck(path, file('tools/vectors/generate_sha256.py'), present)).toEqual({
      problems: [],
      argv: ['python3', '-I', 'tools/vectors/generate_sha256.py', '--check', path],
    });
  });

  it('runs the generator with the given interpreter (the pinned virtual environment)', () => {
    const python = '/tmp/vectors-py/bin/python';
    expect(generatorCheck(path, file('tools/vectors/generate_hpke.py'), present, python)).toEqual({
      problems: [],
      argv: [python, '-I', 'tools/vectors/generate_hpke.py', '--check', path],
    });
  });

  it.each([[undefined], [null], [{}], [{ generator: {} }], [file('')], [file(7)]])(
    'rejects a file without generator.script (%j)',
    (content) => {
      expect(generatorCheck(path, content, present)).toEqual({
        problems: [`${path}: generator.script is missing`],
        argv: null,
      });
    },
  );

  it.each([
    'packages/crypto/src/gen.py',
    'tools/vectors/../../packages/crypto/gen.py',
    'tools/vectors/sub/gen.py',
    '/tmp/gen.py',
    'tools/vectors/gen.ts',
    'tools/vectors/gen.py --write',
  ])('rejects a generator outside tools/vectors/ or not a Python script: %s', (script) => {
    expect(generatorCheck(path, file(script), present)).toEqual({
      problems: [`${path}: generator.script must be a Python script directly under tools/vectors/`],
      argv: null,
    });
  });

  it('rejects a generator script that does not exist', () => {
    expect(generatorCheck(path, file('tools/vectors/missing.py'), () => false)).toEqual({
      problems: [`${path}: generator.script does not exist`],
      argv: null,
    });
  });
});

// M1-1h-d (IR-M1-2a-1 note): a generator that crashes or refuses to run (wrong interpreter, a
// missing or unpinned package) was reported as "does not match its generator's output", the same
// words as a real mismatch, so a broken environment read as drifted vectors. The generator now
// exits with MISMATCH_EXIT only when it compared and found a difference; every other failure is
// reported as a failure to compare. Both still fail the check.
describe('describeGeneratorRun', () => {
  it('uses a dedicated exit status for a mismatch, distinct from 1 (sys.exit) and 2 (argparse)', () => {
    expect(MISMATCH_EXIT).toBe(3);
  });

  it('reports nothing when the generator output matches', () => {
    expect(describeGeneratorRun(path, { status: 0, signal: null })).toBeNull();
  });

  it('reports a mismatch only for the mismatch exit status', () => {
    expect(describeGeneratorRun(path, { status: MISMATCH_EXIT, signal: null })).toBe(
      `${path}: does not match its generator's output`,
    );
  });

  it.each([1, 2, 4, 127])(
    'reports any other exit status (%i) as a failure to compare, never as a match or a mismatch',
    (status) => {
      const problem = describeGeneratorRun(path, { status, signal: null });
      expect(problem).toBe(
        `${path}: the generator failed (exit ${String(status)}) before comparing; its message is above ` +
          '(VECTORS_PYTHON must be a virtual environment with the pinned packages, test-vectors/README.md)',
      );
      expect(problem).not.toContain('does not match');
    },
  );

  it('reports a generator stopped by a signal as a failure to compare', () => {
    expect(describeGeneratorRun(path, { status: null, signal: 'SIGKILL' })).toBe(
      `${path}: the generator was stopped by SIGKILL before comparing`,
    );
  });

  it('reports a generator that could not start', () => {
    expect(
      describeGeneratorRun(path, { status: null, signal: null, error: new Error('spawn ENOENT') }),
    ).toBe(`${path}: could not run the generator: spawn ENOENT`);
  });

  it('never treats a missing status as a match', () => {
    expect(describeGeneratorRun(path, { status: null, signal: null })).not.toBeNull();
  });
});

// M1-1h-d (IR-M1-2a-1 F01): the Suites table of test-vectors/README.md listed suites as pending
// after their cards had removed them from pending-suites.json. The table must agree with the
// committed vector files and the pending list.
describe('suitesTableProblems', () => {
  const table = (rows) =>
    ['## Suites', '', '| Suite | Status | Content |', '|---|---|---|', ...rows, '', '## Next'].join(
      '\n',
    );
  const row = (suite, status) => `| \`${suite}\` | ${status} | text |`;

  it('accepts a table that agrees with the committed suites and the pending list', () => {
    const readme = table([
      row('a', 'committed (M1-1a)'),
      row('b', 'pending (M1-1b)'),
      row('c', 'planned (M1-1i)'),
    ]);
    expect(suitesTableProblems(readme, ['b'], ['a', 'b'])).toEqual([]);
  });

  it('rejects a suite listed as pending that is not in pending-suites.json', () => {
    const readme = table([row('a', 'pending (M1-2a)')]);
    expect(suitesTableProblems(readme, [], ['a'])).toEqual([
      'test-vectors/README.md: suite a is pending in the table but not in pending-suites.json',
    ]);
  });

  it('rejects a pending suite listed as committed', () => {
    const readme = table([row('a', 'committed (M1-2a)')]);
    expect(suitesTableProblems(readme, ['a'], ['a'])).toEqual([
      'test-vectors/README.md: suite a is in pending-suites.json but committed in the table',
    ]);
  });

  it('rejects a committed suite without a row, and a row twice', () => {
    const readme = table([row('a', 'committed'), row('a', 'committed')]);
    expect(suitesTableProblems(readme, [], ['a', 'b'])).toEqual([
      'test-vectors/README.md: suite a has more than one row',
      'test-vectors/README.md: suite b has vectors but no row in the Suites table',
    ]);
  });

  it('rejects a committed or pending row without vectors, and a planned row with vectors', () => {
    const readme = table([row('a', 'committed'), row('b', 'pending (M1-1b)'), row('c', 'planned')]);
    expect(suitesTableProblems(readme, ['b'], ['c'])).toEqual([
      'test-vectors/README.md: suite a is committed in the table but has no vectors.json',
      'test-vectors/README.md: suite b is pending in the table but has no vectors.json',
      'test-vectors/README.md: suite c has vectors.json but is planned in the table',
    ]);
  });

  it('rejects an unknown status and a missing table', () => {
    expect(suitesTableProblems(table([row('a', 'done')]), [], ['a'])).toEqual([
      'test-vectors/README.md: suite a has an unknown status "done" (committed, pending or planned)',
    ]);
    expect(suitesTableProblems('# test-vectors', [], [])).toEqual([
      'test-vectors/README.md: no Suites table',
    ]);
  });
});
