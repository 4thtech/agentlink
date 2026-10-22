import { describe, expect, it } from 'vitest';
import { cliPrefix, GLOBAL_PREFIX, NPX_PREFIX } from './cli-prefix.js';

describe('cliPrefix (M1-36a)', () => {
  it('a global install gives the bare name', () => {
    expect(
      cliPrefix({
        script: '/usr/local/lib/node_modules/@4thtech-io/agentlink/dist/bin.js',
        env: {},
      }),
    ).toBe(GLOBAL_PREFIX);
    expect(GLOBAL_PREFIX).toBe('agentlink');
  });

  it('npx (cache path) gives the npx form', () => {
    expect(
      cliPrefix({
        script: '/Users/a/.npm/_npx/abc123/node_modules/@4thtech-io/agentlink/dist/bin.js',
        env: {},
      }),
    ).toBe(NPX_PREFIX);
    expect(NPX_PREFIX).toBe('npx -y @4thtech-io/agentlink');
  });

  it('npm exec (npm_command=exec) gives the npx form', () => {
    expect(cliPrefix({ script: '/x/bin.js', env: { npm_command: 'exec' } })).toBe(NPX_PREFIX);
  });

  it('Windows npx cache paths are recognised', () => {
    expect(
      cliPrefix({ script: 'C:\\Users\\a\\AppData\\npm-cache\\_npx\\1\\bin.js', env: {} }),
    ).toBe(NPX_PREFIX);
  });
});
