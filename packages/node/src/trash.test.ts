// RET-3 (S2; D-148; 04 §4.2 "Deleting a saved file", 04 §4 realpath rules): moving a saved Inbox
// file to the OS Trash. Never a hard delete; never a link followed; only the file the app saved, still
// unchanged (device, inode, size and sha256 all match, re-checked just before the move).
//
// Every test runs in its own temporary folder with a fake home: the real Trash, ~/.agentlink and the
// Keychain are never touched. Windows runs through a stub of the process launcher.
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { moveToTrash, trashSavedFile, type SavedFileExpectation, type TrashSpawn } from './trash.js';

let root: string;
let home: string;
let inbox: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'ret3-trash-')));
  home = path.join(root, 'home');
  inbox = path.join(home, 'AgentLink', 'Inbox');
  await mkdir(inbox, { recursive: true, mode: 0o700 });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const BYTES = Buffer.from('RET3 saved file content, unchanged since the save\n');
const hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function savedFile(name: string, bytes: Uint8Array = BYTES): Promise<SavedFileExpectation> {
  const file = path.join(inbox, name);
  await writeFile(file, bytes, { mode: 0o600 });
  const info = await lstat(file, { bigint: true });
  return { dev: info.dev.toString(), ino: info.ino.toString(), size: bytes.length, sha256: hex(bytes) };
}

const exists = (p: string) => lstat(p).then(() => true, () => false);

describe('macOS: a rename into ~/.Trash on the same volume', () => {
  it('moves an unchanged file; the original is gone and the bytes are in the Trash', async () => {
    const expected = await savedFile('report.pdf');
    const outcome = await trashSavedFile({ folder: inbox, name: 'report.pdf', expected, platform: 'darwin', home });
    expect(outcome).toBe('trashed');
    expect(await exists(path.join(inbox, 'report.pdf'))).toBe(false);
    const trash = path.join(home, '.Trash');
    expect(await readdir(trash)).toEqual(['report.pdf']);
    expect(await readFile(path.join(trash, 'report.pdf'))).toEqual(BYTES);
  });

  it('never overwrites an item already in the Trash under the same name', async () => {
    const trash = path.join(home, '.Trash');
    await mkdir(trash, { mode: 0o700 });
    await writeFile(path.join(trash, 'report.pdf'), 'older trashed file');
    const expected = await savedFile('report.pdf');
    expect(
      await trashSavedFile({ folder: inbox, name: 'report.pdf', expected, platform: 'darwin', home }),
    ).toBe('trashed');
    const names = (await readdir(trash)).sort();
    expect(names).toHaveLength(2);
    expect(await readFile(path.join(trash, 'report.pdf'), 'utf8')).toBe('older trashed file');
  });

  it('refuses a Trash that is a link', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    await mkdir(elsewhere);
    await symlink(elsewhere, path.join(home, '.Trash'));
    const expected = await savedFile('report.pdf');
    const outcome = await trashSavedFile({ folder: inbox, name: 'report.pdf', expected, platform: 'darwin', home });
    expect(outcome).toBe('no_trash');
    expect(await exists(path.join(inbox, 'report.pdf'))).toBe(true);
    expect(await readdir(elsewhere)).toEqual([]);
  });
});

describe('Linux: the freedesktop.org Trash specification', () => {
  it('writes info/<name>.trashinfo first, then moves the file into files/', async () => {
    const expected = await savedFile('notes v2.txt');
    const outcome = await trashSavedFile({ folder: inbox, name: 'notes v2.txt', expected, platform: 'linux', home });
    expect(outcome).toBe('trashed');
    const trash = path.join(home, '.local', 'share', 'Trash');
    expect(await readdir(path.join(trash, 'files'))).toEqual(['notes v2.txt']);
    const info = await readFile(path.join(trash, 'info', 'notes v2.txt.trashinfo'), 'utf8');
    expect(info).toMatch(/^\[Trash Info\]\nPath=.*\nDeletionDate=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\n$/);
    expect(info).toContain(
      'Path=' + path.join(inbox, 'notes v2.txt').split('/').map(encodeURIComponent).join('/') + '\n',
    );
    expect(await exists(path.join(inbox, 'notes v2.txt'))).toBe(false);
  });

  it('uses XDG_DATA_HOME when it is an absolute path', async () => {
    const data = path.join(home, 'data');
    const expected = await savedFile('a.txt');
    expect(
      await trashSavedFile({ folder: inbox, name: 'a.txt', expected, platform: 'linux', home, xdgDataHome: data }),
    ).toBe('trashed');
    expect(await readdir(path.join(data, 'Trash', 'files'))).toEqual(['a.txt']);
  });

  it('a second file of the same name gets its own entry', async () => {
    const first = await savedFile('a.txt');
    await trashSavedFile({ folder: inbox, name: 'a.txt', expected: first, platform: 'linux', home });
    const second = await savedFile('a.txt', Buffer.from('second'));
    expect(
      await trashSavedFile({ folder: inbox, name: 'a.txt', expected: second, platform: 'linux', home }),
    ).toBe('trashed');
    const trash = path.join(home, '.local', 'share', 'Trash');
    expect((await readdir(path.join(trash, 'files'))).sort()).toHaveLength(2);
    expect((await readdir(path.join(trash, 'info'))).sort()).toHaveLength(2);
  });
});

describe('only the file the app saved, still unchanged (re-checked just before the move)', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    it(`${platform}: a changed file (same size, other bytes) is untouched`, async () => {
      const expected = await savedFile('edited.txt');
      const other = Buffer.from(BYTES);
      other[0] = other[0]! ^ 1;
      await writeFile(path.join(inbox, 'edited.txt'), other);
      const outcome = await trashSavedFile({ folder: inbox, name: 'edited.txt', expected, platform, home });
      expect(outcome).toBe('changed');
      expect(await readFile(path.join(inbox, 'edited.txt'))).toEqual(other);
    });

    it(`${platform}: another size, another inode or another device is untouched`, async () => {
      const expected = await savedFile('x.txt');
      for (const wrong of [
        { ...expected, size: expected.size + 1 },
        { ...expected, ino: String(BigInt(expected.ino) + 1n) },
        { ...expected, dev: String(BigInt(expected.dev) + 1n) },
      ]) {
        expect(await trashSavedFile({ folder: inbox, name: 'x.txt', expected: wrong, platform, home })).toBe(
          'changed',
        );
      }
      expect(await exists(path.join(inbox, 'x.txt'))).toBe(true);
    });

    it(`${platform}: a symlink at the saved name is refused; the link and its target stay`, async () => {
      const target = path.join(root, 'target.txt');
      await writeFile(target, BYTES);
      const info = await lstat(target, { bigint: true });
      await symlink(target, path.join(inbox, 'link.txt'));
      const expected = { dev: info.dev.toString(), ino: info.ino.toString(), size: BYTES.length, sha256: hex(BYTES) };
      const outcome = await trashSavedFile({ folder: inbox, name: 'link.txt', expected, platform, home });
      expect(outcome).toBe('changed');
      expect((await lstat(path.join(inbox, 'link.txt'))).isSymbolicLink()).toBe(true);
      expect(await readFile(target)).toEqual(BYTES);
    });

    it(`${platform}: a missing file is missing; a name that is not one segment is refused`, async () => {
      const expected = await savedFile('here.txt');
      expect(await trashSavedFile({ folder: inbox, name: 'gone.txt', expected, platform, home })).toBe('missing');
      for (const name of ['../here.txt', 'sub/here.txt', '', '.', '..', '.hidden']) {
        expect(await trashSavedFile({ folder: inbox, name, expected, platform, home })).toBe('failed');
      }
      expect(await exists(path.join(inbox, 'here.txt'))).toBe(true);
    });

    it(`${platform}: a folder that is no longer the held one moves nothing`, async () => {
      const expected = await savedFile('held.txt');
      const outcome = await trashSavedFile({
        folder: inbox,
        name: 'held.txt',
        expected,
        platform,
        home,
        stillSame: () => Promise.resolve(false),
      });
      expect(outcome).toBe('failed');
      expect(await exists(path.join(inbox, 'held.txt'))).toBe(true);
    });
  }

  it('a platform with no known Trash answers no_trash and moves nothing', async () => {
    const expected = await savedFile('a.txt');
    expect(await trashSavedFile({ folder: inbox, name: 'a.txt', expected, platform: 'aix', home })).toBe(
      'no_trash',
    );
    expect(await exists(path.join(inbox, 'a.txt'))).toBe(true);
  });
});

describe('Windows: the Recycle Bin through a fixed PowerShell command (stubbed here)', () => {
  const TARGET = 'C:\\Users\\u\\AgentLink\\Inbox\\it\'s; & rm -rf $(x) `y`.pdf';

  it('the path goes only through the environment: fixed executable, fixed arguments, no shell', async () => {
    const calls: { file: string; args: readonly string[]; options: Parameters<TrashSpawn>[2] }[] = [];
    const spawn: TrashSpawn = (file, args, options) => {
      calls.push({ file, args, options });
      return Promise.resolve({ code: 0 });
    };
    const outcome = await moveToTrash(TARGET, {
      platform: 'win32',
      spawn,
      systemRoot: 'C:\\Windows',
      gone: () => Promise.resolve(true),
    });
    expect(outcome).toBe('trashed');
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(call.options.shell).toBe(false);
    expect(call.options.windowsHide).toBe(true);
    expect(call.options.env.AGENTLINK_TRASH_TARGET).toBe(TARGET);
    const joined = call.args.join(' ');
    expect(joined).not.toContain('Inbox');
    expect(joined).not.toContain('rm -rf');
    expect(joined).toContain('Microsoft.VisualBasic.FileIO.FileSystem');
    expect(joined).toContain('SendToRecycleBin');
    expect(joined).toContain('$env:AGENTLINK_TRASH_TARGET');
    expect(call.args).toContain('-NoProfile');
    expect(call.args).toContain('-NonInteractive');
    // The same arguments for any path: nothing from the file name is ever part of the command.
    const again: (typeof calls)[number][] = [];
    await moveToTrash('C:\\other.txt', {
      platform: 'win32',
      spawn: (file, args, options) => {
        again.push({ file, args, options });
        return Promise.resolve({ code: 0 });
      },
      systemRoot: 'C:\\Windows',
      gone: () => Promise.resolve(true),
    });
    expect(again[0]!.args).toEqual(call.args);
  });

  it('a failing command, a file still there, or a launcher that throws answers failed', async () => {
    const base = { platform: 'win32' as const, systemRoot: 'C:\\Windows' };
    expect(
      await moveToTrash(TARGET, { ...base, spawn: () => Promise.resolve({ code: 1 }), gone: () => Promise.resolve(true) }),
    ).toBe('failed');
    expect(
      await moveToTrash(TARGET, { ...base, spawn: () => Promise.resolve({ code: 0 }), gone: () => Promise.resolve(false) }),
    ).toBe('failed');
    expect(
      await moveToTrash(TARGET, { ...base, spawn: () => Promise.reject(new Error(TARGET)), gone: () => Promise.resolve(true) }),
    ).toBe('failed');
  });
});

describe('no name or path leaves the module (I-7)', () => {
  it('outcomes are fixed codes; nothing is thrown with a path', async () => {
    const expected = await savedFile('secret-name.txt');
    const outcomes = await Promise.all([
      trashSavedFile({ folder: inbox, name: 'secret-name.txt', expected: { ...expected, size: 1 }, platform: 'linux', home }),
      trashSavedFile({ folder: path.join(root, 'nope'), name: 'secret-name.txt', expected, platform: 'linux', home }),
    ]);
    for (const o of outcomes) expect(['trashed', 'changed', 'missing', 'no_trash', 'failed']).toContain(o);
  });
});
