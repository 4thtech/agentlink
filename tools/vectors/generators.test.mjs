import { describe, expect, it } from 'vitest';
import { generatorCheck } from './generators.mjs';

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
