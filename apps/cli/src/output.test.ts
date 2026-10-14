import { describe, expect, it } from 'vitest';
import { createOutput } from './output.js';

describe('CLI user-output channel', () => {
  it('prints results on stdout and errors on stderr', () => {
    const written: string[] = [];
    const output = createOutput({
      log: (text) => written.push(`out:${text}`),
      error: (text) => written.push(`err:${text}`),
    });
    output.print('0.0.0');
    output.printError('unknown command');
    expect(written).toEqual(['out:0.0.0', 'err:unknown command']);
  });

  it('defaults to the runtime console', () => {
    expect(() => createOutput()).not.toThrow();
  });
});
