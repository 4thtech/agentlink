// Unit tests of the harness verdict (IR-M0-9-1 F03). Node project only: the function is pure, and
// vectors.test.ts runs it in every runtime against the real vectors.
import { describe, expect, it } from 'vitest';
import { compareToVector } from './compare';

const digest = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('compareToVector', () => {
  it('accepts a suite that computed exactly the expected fields', () => {
    expect(compareToVector({ sha256: digest }, [{ field: 'sha256', actual: digest }])).toEqual([]);
  });

  it('rejects a mutated vector: the expected value comes from the vector, not the suite', () => {
    const mutated = `${digest.slice(0, -1)}e`;
    expect(compareToVector({ sha256: mutated }, [{ field: 'sha256', actual: digest }])).toEqual([
      `sha256: expected ${mutated}, got ${digest}`,
    ]);
  });

  it('rejects a suite that skips an expected field', () => {
    expect(
      compareToVector({ sha256: digest, length: '3' }, [{ field: 'sha256', actual: digest }]),
    ).toEqual(['length: expected but not computed by the suite']);
  });

  it('rejects a suite that computes nothing', () => {
    expect(compareToVector({ sha256: digest }, [])).toEqual([
      'sha256: expected but not computed by the suite',
    ]);
  });

  it('rejects a field the vector does not expect', () => {
    expect(
      compareToVector({ sha256: digest }, [
        { field: 'sha256', actual: digest },
        { field: 'extra', actual: 'x' },
      ]),
    ).toEqual(['extra: not an expected field of this case']);
  });

  it('rejects a field returned twice', () => {
    expect(
      compareToVector({ sha256: digest }, [
        { field: 'sha256', actual: digest },
        { field: 'sha256', actual: digest },
      ]),
    ).toEqual(['sha256: returned more than once']);
  });

  it('rejects an inherited property name as a field', () => {
    expect(compareToVector({ sha256: digest }, [{ field: 'toString', actual: 'x' }])).toContain(
      'toString: not an expected field of this case',
    );
  });

  it.each([[''], [42], [null]])('rejects an expected value of %j', (value) => {
    expect(compareToVector({ sha256: value }, [{ field: 'sha256', actual: '' }])).toEqual([
      'sha256: the expected value must be a non-empty string',
    ]);
  });

  it.each([[undefined], [null], ['abc'], [[digest]]])('rejects expected = %j', (value) => {
    expect(compareToVector(value, [{ field: 'sha256', actual: digest }])).toEqual([
      'the case has no expected object',
    ]);
  });

  it('rejects an empty expected object', () => {
    expect(compareToVector({}, [])).toEqual(['the case has no expected fields']);
  });
});
