// CI-823: every throw-away profile of the desktop smoke test is complete on its own. On macOS the
// default keychain lives in the preferences under HOME, so the fd 3 controls' own home needs its own
// keychain; without it the host stopped with `keychain`, exit 1, and the smoke read "the host did
// not send `ready` on the shell's pipe".
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeHome } from '../smoke/profile.mjs';

const roots: string[] = [];
const root = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-profile-test-'));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Call {
  readonly args: string[];
  readonly home: string | undefined;
}
const recorder = (status: (args: string[]) => number | null = () => 0) => {
  const calls: Call[] = [];
  return {
    calls,
    run: (args: string[], env: Record<string, string | undefined>) => {
      calls.push({ args, home: env['HOME'] });
      return { status: status(args) };
    },
  };
};

describe('smoke profiles (CI-823)', () => {
  it('gives EVERY macOS profile its own default, unlocked keychain under its own HOME', () => {
    const tmp = root();
    const r = recorder();
    const first = makeHome({}, { platform: 'darwin', tmp, run: r.run, warn: () => undefined });
    const second = makeHome({}, { platform: 'darwin', tmp, run: r.run, warn: () => undefined });
    expect(first.home).not.toBe(second.home);
    for (const profile of [first, second]) {
      const mine = r.calls.filter((c) => c.home === profile.home);
      const keychain = join(profile.home, 'Library', 'Keychains', 'login.keychain-db');
      expect(mine.map((c) => c.args[0])).toEqual([
        'create-keychain',
        'default-keychain',
        'unlock-keychain',
        'set-keychain-settings',
      ]);
      for (const c of mine) expect(c.args.at(-1)).toBe(keychain);
      expect(profile.env.HOME).toBe(profile.home);
    }
  });

  it('fails when the keychain cannot be created; a later step only warns', () => {
    const tmp = root();
    const failCreate = recorder((args) => (args[0] === 'create-keychain' ? 1 : 0));
    expect(() => makeHome({}, { platform: 'darwin', tmp, run: failCreate.run })).toThrow(
      'could not create the smoke keychain',
    );
    const warnings: string[] = [];
    const failUnlock = recorder((args) => (args[0] === 'unlock-keychain' ? 51 : 0));
    makeHome({}, { platform: 'darwin', tmp, run: failUnlock.run, warn: (l) => warnings.push(l) });
    expect(warnings).toEqual(['::warning::smoke setup: security unlock-keychain exited 51']);
  });

  it('makes no keychain off macOS', () => {
    const tmp = root();
    const r = recorder();
    makeHome({}, { platform: 'win32', tmp, run: r.run });
    makeHome({ noRoaming: true }, { platform: 'linux', tmp, run: r.run });
    expect(r.calls).toEqual([]);
  });

  it('smoke.mjs takes every profile (the controls’ one too) from profile.mjs', () => {
    const source = readFileSync(new URL('../smoke/smoke.mjs', import.meta.url), 'utf8');
    expect(source).toMatch(/import \{[^}]*\bmakeHome\b[^}]*\} from '\.\/profile\.mjs';/);
    expect(source).not.toMatch(/function makeHome\b/);
    expect(source).not.toMatch(/create-keychain/);
  });
});
