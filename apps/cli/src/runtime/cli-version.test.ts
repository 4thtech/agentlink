// HOTFIX-NOID (owner report: the Mac app's status strip said 0.0.0): both entries set the version
// from this package's package.json, wherever the build put them.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readPackageVersion } from './cli-version.js';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
  version: string;
};
const at = (...parts: string[]): URL => pathToFileURL(join(packageDir, ...parts));

describe('readPackageVersion', () => {
  it('the bundles (dist/agentlink.js, dist/desktop-host.js) read the real version, never 0.0.0', () => {
    for (const entry of ['agentlink.js', 'desktop-host.js']) {
      const version = readPackageVersion([new URL('../package.json', at('dist', entry))]);
      expect(version).toBe(manifest.version);
      expect(version).not.toBe('0.0.0');
    }
  });

  it("the per-file desktop entry (dist/desktop/host.js) finds it with the host's second candidate", () => {
    const host = at('dist', 'desktop', 'host.js');
    expect(
      readPackageVersion([new URL('../package.json', host), new URL('../../package.json', host)]),
    ).toBe(manifest.version);
  });

  it('another package.json or none is not taken: 0.0.0', () => {
    expect(readPackageVersion([at('no-such', 'package.json')])).toBe('0.0.0');
    expect(readPackageVersion([pathToFileURL(join(packageDir, '..', '..', 'package.json'))])).toBe(
      '0.0.0',
    );
  });

  it('the desktop host entry sets the version before it starts', () => {
    const source = readFileSync(join(packageDir, 'src', 'desktop', 'host.ts'), 'utf8');
    expect(source.indexOf('setCliVersion(')).toBeGreaterThan(-1);
    expect(source.indexOf('setCliVersion(')).toBeLessThan(source.indexOf('await desktopHostMain('));
  });

  it('a built desktop-host bundle carries the version read (when built)', () => {
    const bundle = join(packageDir, 'dist', 'desktop-host.js');
    if (!existsSync(bundle)) return;
    const text = readFileSync(bundle, 'utf8');
    expect(text).toContain('setCliVersion(readPackageVersion(');
  });
});
