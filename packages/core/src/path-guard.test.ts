// M1-15: the pure allowed-folder decision (04 §4 "Allowed folders"), both path flavours on every
// platform. The realpath half is tested in @agentlink/node (allowed-path.test.ts).
import { describe, expect, it } from 'vitest';
import {
  decidePath,
  expandHome,
  isInsideFolder,
  parseAbsolutePath,
  protectedRoots,
  type PathDecisionInput,
} from './path-guard.js';

describe('parseAbsolutePath', () => {
  it.each([
    ['', 'posix'],
    ['relative/x', 'posix'],
    ['~/x', 'posix'],
    ['/a/../b', 'posix'],
    ['/a/./b', 'posix'],
    ['/a//b', 'posix'],
    ['/a/\u0000b', 'posix'],
    ['C:relative', 'win32'],
    ['\\rooted-no-drive', 'win32'],
    ['C:\\a\\..\\b', 'win32'],
    ['C:\\a\\file.txt:stream', 'win32'],
    ['C:\\a\\trailingdot.', 'win32'],
    ['C:\\a\\trailingspace ', 'win32'],
    ['\\\\?\\GLOBALROOT\\Device\\x', 'win32'],
    ['\\\\.\\PhysicalDrive0', 'win32'],
    ['\\\\server', 'win32'],
  ] as const)('refuses %j (%s)', (path, flavor) => {
    expect(parseAbsolutePath(path, flavor)).toBeUndefined();
  });

  it('parses drive, UNC and long-path forms on win32, case-folded', () => {
    expect(parseAbsolutePath('C:\\Users\\Me\\Work', 'win32')).toEqual({
      root: 'c:',
      segments: ['users', 'me', 'work'],
    });
    expect(parseAbsolutePath('\\\\?\\c:\\users\\me\\work\\', 'win32')).toEqual({
      root: 'c:',
      segments: ['users', 'me', 'work'],
    });
    expect(parseAbsolutePath('\\\\?\\UNC\\Srv\\Share\\x', 'win32')).toEqual({
      root: '\\\\srv\\share',
      segments: ['x'],
    });
    expect(parseAbsolutePath('c:/users/me', 'win32')?.segments).toEqual(['users', 'me']);
  });
});

describe('isInsideFolder', () => {
  it.each([
    ['/home/u/Work/a.txt', '/home/u/Work', 'posix', true],
    ['/home/u/Work', '/home/u/Work', 'posix', true],
    ['/home/u/Work/', '/home/u/Work', 'posix', true],
    ['/home/u/Workshop/a.txt', '/home/u/Work', 'posix', false],
    ['/home/u/a.txt', '/home/u/Work', 'posix', false],
    ['/home/u/work/a.txt', '/home/u/Work', 'posix', false],
    ['/home/u/Work/../a', '/home/u/Work', 'posix', false],
    ['C:\\Users\\Me\\Work\\a.txt', 'c:\\users\\me\\work', 'win32', true],
    ['D:\\Users\\Me\\Work\\a.txt', 'C:\\Users\\Me\\Work', 'win32', false],
    ['C:\\Users\\Me\\Workshop\\a.txt', 'C:\\Users\\Me\\Work', 'win32', false],
    ['\\\\?\\C:\\Users\\Me\\Work\\a', 'C:\\Users\\Me\\Work', 'win32', true],
    ['\\\\srv\\share\\a', 'C:\\', 'win32', false],
  ] as const)('%s in %s (%s) -> %s', (path, folder, flavor, expected) => {
    expect(isInsideFolder(path, folder, flavor)).toBe(expected);
  });
});

describe('expandHome', () => {
  it('expands ~ and ~/ only', () => {
    expect(expandHome('~', '/home/u', 'posix')).toBe('/home/u');
    expect(expandHome('~/Work', '/home/u', 'posix')).toBe('/home/u/Work');
    expect(expandHome('~/Work', '/home/u/', 'posix')).toBe('/home/u/Work');
    expect(expandHome('~root/x', '/home/u', 'posix')).toBe('~root/x');
    expect(expandHome('/abs', '/home/u', 'posix')).toBe('/abs');
    expect(expandHome('~\\Work', 'C:\\Users\\Me', 'win32')).toBe('C:\\Users\\Me\\Work');
    expect(expandHome('~/A/B', 'C:\\Users\\Me', 'win32')).toBe('C:\\Users\\Me\\A\\B');
  });
});

describe('decidePath (04 §4)', () => {
  const posixRoots = protectedRoots('/home/u', 'posix');
  const posix = (over: Partial<PathDecisionInput>): PathDecisionInput => ({
    requested: '/home/u/Work/a.txt',
    resolved: '/home/u/Work/a.txt',
    allowedFolders: ['/home/u/Work'],
    protectedRoots: posixRoots,
    flavor: 'posix',
    ...over,
  });

  it('allows a plain file inside an allowed folder', () => {
    expect(decidePath(posix({}))).toEqual({ ok: true, folder: '/home/u/Work' });
  });

  it('refuses when no folder is allowed', () => {
    expect(decidePath(posix({ allowedFolders: [] }))).toEqual({
      ok: false,
      reason: 'no_allowed_folder',
    });
  });

  it('refuses a symlink inside the folder that resolves to ~/.ssh', () => {
    expect(
      decidePath(posix({ requested: '/home/u/Work/key', resolved: '/home/u/.ssh/id_ed25519' })),
    ).toEqual({ ok: false, reason: 'protected' });
  });

  it('refuses a symlink that resolves outside every allowed folder', () => {
    expect(decidePath(posix({ resolved: '/etc/passwd' }))).toEqual({
      ok: false,
      reason: 'outside_allowed',
    });
  });

  it('refuses ~/.ssh and ~/.agentlink even when the owner allowed the home folder or them', () => {
    for (const allowed of ['/home/u', '/home/u/.ssh', '/home/u/.agentlink']) {
      for (const file of ['/home/u/.ssh/id_rsa', '/home/u/.agentlink/agent.alko']) {
        expect(
          decidePath(posix({ requested: file, resolved: file, allowedFolders: [allowed] })).ok,
        ).toBe(false);
      }
    }
    expect(
      decidePath(
        posix({
          requested: '/home/u/.agentlink/x',
          resolved: '/home/u/.agentlink/x',
          allowedFolders: ['/home/u/.agentlink'],
        }),
      ),
    ).toEqual({ ok: false, reason: 'protected' });
  });

  it('refuses keychain directories (case-insensitive)', () => {
    for (const file of [
      '/home/u/Library/Keychains/login.keychain-db',
      '/home/u/library/keychains/login.keychain-db',
      '/Library/Keychains/System.keychain',
      '/home/u/.local/share/keyrings/login.keyring',
      '/home/u/.SSH/id_rsa',
    ]) {
      expect(decidePath(posix({ requested: file, resolved: file, allowedFolders: ['/'] }))).toEqual(
        { ok: false, reason: 'protected' },
      );
    }
  });

  it('refuses hidden files and files below hidden folders under the allowed folder', () => {
    expect(
      decidePath(posix({ requested: '/home/u/Work/.env', resolved: '/home/u/Work/.env' })),
    ).toEqual({ ok: false, reason: 'hidden' });
    expect(
      decidePath(
        posix({ requested: '/home/u/Work/.git/config', resolved: '/home/u/Work/.git/config' }),
      ),
    ).toEqual({ ok: false, reason: 'hidden' });
    // a visible name that resolves to a hidden one
    expect(decidePath(posix({ resolved: '/home/u/Work/.secret' }))).toEqual({
      ok: false,
      reason: 'hidden',
    });
    // a hidden name that resolves to a visible one
    expect(decidePath(posix({ requested: '/home/u/Work/.alias' }))).toEqual({
      ok: false,
      reason: 'hidden',
    });
  });

  it('allows an allowed folder that itself sits below a hidden folder', () => {
    expect(
      decidePath(
        posix({
          requested: '/home/u/.config/share/a.txt',
          resolved: '/home/u/.config/share/a.txt',
          allowedFolders: ['/home/u/.config/share'],
        }),
      ),
    ).toEqual({ ok: true, folder: '/home/u/.config/share' });
  });

  it('refuses relative or dotted paths as malformed', () => {
    expect(decidePath(posix({ requested: 'Work/a.txt' }))).toEqual({
      ok: false,
      reason: 'path_malformed',
    });
    expect(decidePath(posix({ requested: '/home/u/Work/../.ssh/id_rsa' }))).toEqual({
      ok: false,
      reason: 'path_malformed',
    });
  });

  it('ignores malformed allowed folders', () => {
    expect(decidePath(posix({ allowedFolders: ['Work', '~/Work'] }))).toEqual({
      ok: false,
      reason: 'no_allowed_folder',
    });
  });

  describe('win32', () => {
    const winRoots = protectedRoots('C:\\Users\\Me', 'win32');
    const win = (over: Partial<PathDecisionInput>): PathDecisionInput => ({
      requested: 'C:\\Users\\Me\\Work\\a.txt',
      resolved: 'C:\\Users\\Me\\Work\\a.txt',
      allowedFolders: ['C:\\Users\\Me\\Work'],
      protectedRoots: winRoots,
      flavor: 'win32',
      ...over,
    });

    it('allows a file inside the folder, whatever the case or long-path prefix', () => {
      expect(decidePath(win({ resolved: '\\\\?\\c:\\users\\me\\WORK\\a.txt' })).ok).toBe(true);
    });

    it('refuses a junction resolving to the DPAPI or Credential folders', () => {
      for (const target of [
        'C:\\Users\\Me\\AppData\\Roaming\\Microsoft\\Protect\\S-1-5\\key',
        'C:\\Users\\Me\\AppData\\Local\\Microsoft\\Credentials\\x',
        'c:\\users\\me\\.ssh\\id_ed25519',
        'C:\\Users\\Me\\.agentlink\\agent.alko',
      ]) {
        expect(decidePath(win({ resolved: target, allowedFolders: ['C:\\'] }))).toEqual({
          ok: false,
          reason: 'protected',
        });
      }
    });

    it('refuses another drive, a UNC path and an NTFS stream', () => {
      expect(decidePath(win({ resolved: 'D:\\Users\\Me\\Work\\a.txt' })).ok).toBe(false);
      expect(decidePath(win({ resolved: '\\\\evil\\share\\a.txt' })).ok).toBe(false);
      expect(decidePath(win({ requested: 'C:\\Users\\Me\\Work\\a.txt:hidden' }))).toEqual({
        ok: false,
        reason: 'path_malformed',
      });
    });

    it('refuses hidden names', () => {
      expect(
        decidePath(
          win({ requested: 'C:\\Users\\Me\\Work\\.env', resolved: 'C:\\Users\\Me\\Work\\.env' }),
        ),
      ).toEqual({ ok: false, reason: 'hidden' });
    });
  });
});
