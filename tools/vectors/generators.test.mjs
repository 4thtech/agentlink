import { describe, expect, it } from 'vitest';
import { MISMATCH_EXIT, describeGeneratorRun, generatorCheck } from './generators.mjs';

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
