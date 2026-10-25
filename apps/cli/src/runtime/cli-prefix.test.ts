import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cliPrefix, GLOBAL_PREFIX, NPX_PREFIX } from './cli-prefix.js';

describe('cliPrefix (M1-36a)', () => {
  it('a global install found on PATH gives the bare name', () => {
    expect(
      cliPrefix({
        script: '/usr/lib/node_modules/@4thtech-io/agentlink/dist/bin.js',
        onPath: () => true,
      }),
    ).toBe(GLOBAL_PREFIX);
    expect(GLOBAL_PREFIX).toBe('agentlink');
  });

  it.each([
    '/Users/a/.npm/_npx/abc/node_modules/@4thtech-io/agentlink/dist/bin.js',
    '/Users/a/.cache/pnpm/dlx/xyz/node_modules/@4thtech-io/agentlink/dist/bin.js',
    '/proj/node_modules/.bin/agentlink',
    'C:\\Users\\a\\AppData\\npm-cache\\_npx\\1\\bin.js',
  ])('not found on PATH (%s) gives the npx form', (script) => {
    expect(cliPrefix({ script, onPath: () => false })).toBe(NPX_PREFIX);
    expect(NPX_PREFIX).toBe('npx -y @4thtech-io/agentlink');
  });

  it('no script gives the npx form', () => {
    expect(cliPrefix({ onPath: () => true })).toBe(NPX_PREFIX);
  });

  it('the default check follows a PATH link to the same file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cliprefix-'));
    mkdirSync(join(dir, 'bin'));
    const script = join(dir, 'real.js');
    writeFileSync(script, '');
    symlinkSync(script, join(dir, 'bin', 'agentlink'));
    const saved = process.env['PATH'];
    try {
      process.env['PATH'] = join(dir, 'bin');
      expect(cliPrefix({ script })).toBe(GLOBAL_PREFIX);
      process.env['PATH'] = '/nonexistent';
      expect(cliPrefix({ script })).toBe(NPX_PREFIX);
    } finally {
      process.env['PATH'] = saved;
    }
  });

  // M1-36a-c: npx puts the package's `.bin` on PATH, so the PATH check finds the npx copy.
  describe('launched through npx (M1-36a-c)', () => {
    it('a cache copy that is also on PATH still gives the npx form', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cliprefix-npx-'));
      const pkg = join(dir, '.npm', '_npx', 'abc123', 'node_modules', '@4thtech-io', 'agentlink');
      const bin = join(dir, '.npm', '_npx', 'abc123', 'node_modules', '.bin');
      mkdirSync(join(pkg, 'dist'), { recursive: true });
      mkdirSync(bin, { recursive: true });
      const script = join(pkg, 'dist', 'bin.js');
      writeFileSync(script, '');
      symlinkSync(script, join(bin, 'agentlink'));
      const saved = process.env['PATH'];
      try {
        process.env['PATH'] = `${bin}:/usr/bin`;
        expect(cliPrefix({ script })).toBe(NPX_PREFIX);
        expect(cliPrefix({ script: join(bin, 'agentlink') })).toBe(NPX_PREFIX);
      } finally {
        process.env['PATH'] = saved;
      }
    });

    it('npm_command=exec gives the npx form even when found on PATH', () => {
      const saved = process.env['npm_command'];
      try {
        process.env['npm_command'] = 'exec';
        expect(cliPrefix({ script: '/somewhere/else/bin.js', onPath: () => true })).toBe(
          NPX_PREFIX,
        );
      } finally {
        if (saved === undefined) delete process.env['npm_command'];
        else process.env['npm_command'] = saved;
      }
    });

    it('a real global install is unchanged', () => {
      const saved = process.env['npm_command'];
      delete process.env['npm_command'];
      try {
        expect(
          cliPrefix({
            script: '/usr/lib/node_modules/@4thtech-io/agentlink/dist/bin.js',
            onPath: () => true,
          }),
        ).toBe(GLOBAL_PREFIX);
      } finally {
        if (saved !== undefined) process.env['npm_command'] = saved;
      }
    });
  });
});
