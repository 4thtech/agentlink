// ATT-SENDFOLDER-FIX (D-121 D6; 04 §4; 06 §3): the Send folder is tolerant.
//
// - An existing `~/AgentLink/Send` that is a real folder owned by this OS user is used even when it
//   already holds files (an earlier ID on the same computer put them there). The owner is told before
//   the gesture that those files can be sent too.
// - A link, a non-folder or a folder owned by someone else at `Send` is never used. With `fallback`
//   (the app's New ID and the Home banner), a fresh `Send-2` … `Send-9` beside it is used instead: a
//   missing one is created 0700, an existing one only when it is a real, owned, EMPTY folder.
// - A link or non-folder at `AgentLink` is never used, fallback or not.
// - The pinned folder must still be the same one before and after signing; a folder that was empty
//   at the check must still be empty (what the owner read stays true).
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareSendFolder, sendFolderReview, stillReady } from './owner-first-policy.js';

let dir: string;
let home: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-att-sendfolder-'));
  home = join(dir, 'home');
  await mkdir(home);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const base = async (): Promise<string> => join(await realpath(home), 'AgentLink');
const onWindows = process.platform === 'win32';

describe('ATT-SENDFOLDER-FIX: an existing Send folder that holds files', () => {
  it('is accepted when it is a real folder owned by this user, and nothing in it is touched', async () => {
    await mkdir(join(home, 'AgentLink', 'Send'), { recursive: true });
    await writeFile(join(home, 'AgentLink', 'Send', 'earlier.txt'), 'x');
    const plan = await prepareSendFolder(home);
    expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') return;
    expect(plan.folder).toBe(join(await base(), 'Send'));
    expect(plan.holdsFiles).toBe(true);
    expect(plan.created).toEqual([]);
    expect(await readdir(plan.folder)).toEqual(['earlier.txt']);
  });

  it('an empty or new Send folder holds no files', async () => {
    const plan = await prepareSendFolder(home);
    expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') return;
    expect(plan.holdsFiles).toBe(false);
  });

  it('the review the owner reads says the files already there can be sent too', async () => {
    await mkdir(join(home, 'AgentLink', 'Send'), { recursive: true });
    await writeFile(join(home, 'AgentLink', 'Send', 'earlier.txt'), 'x');
    const plan = await prepareSendFolder(home);
    const text = sendFolderReview(plan);
    expect(text).toMatch(/already holds files/);
    expect(text).not.toMatch(/empty for now/);
    expect(text).not.toMatch(/wallet|gas|seed phrase|transaction/i);
  });

  it('stillReady keeps a folder that held files at the check, but not one that was empty', async () => {
    const folder = join(home, 'F');
    await mkdir(folder);
    await writeFile(join(folder, 'a.txt'), 'x');
    const real = await realpath(folder);
    expect(await stillReady(real, false)).toBe(true);
    expect(await stillReady(real)).toBe(false);
    expect(await stillReady(real, true)).toBe(false);
  });

  it.skipIf(onWindows || typeof process.getuid !== 'function')(
    'a Send folder owned by someone else is not used',
    async () => {
      await mkdir(join(home, 'AgentLink', 'Send'), { recursive: true });
      const other = (process.getuid?.() ?? 0) + 1;
      expect(await prepareSendFolder(home, { uid: other })).toEqual({
        status: 'unavailable',
        reason: 'folder_unavailable',
      });
    },
  );
});

describe('ATT-SENDFOLDER-FIX: an unusable Send path', () => {
  it.skipIf(onWindows)('a symlinked Send is refused without fallback', async () => {
    const target = join(dir, 'elsewhere');
    await mkdir(target);
    await mkdir(join(home, 'AgentLink'));
    await symlink(target, join(home, 'AgentLink', 'Send'));
    expect(await prepareSendFolder(home)).toEqual({
      status: 'unavailable',
      reason: 'folder_unavailable',
    });
    expect(await readdir(target)).toEqual([]);
  });

  it.skipIf(onWindows)(
    'with fallback, a symlinked Send is never used: a fresh Send-2 is created instead',
    async () => {
      const target = join(dir, 'elsewhere');
      await mkdir(target);
      await writeFile(join(target, 'secret.txt'), 'x');
      await mkdir(join(home, 'AgentLink'));
      await symlink(target, join(home, 'AgentLink', 'Send'));
      const plan = await prepareSendFolder(home, { fallback: true });
      expect(plan.status).toBe('ready');
      if (plan.status !== 'ready') return;
      expect(plan.folder).toBe(join(await base(), 'Send-2'));
      expect(plan.holdsFiles).toBe(false);
      expect(plan.created).toEqual([plan.folder]);
      expect((await lstat(plan.folder)).isSymbolicLink()).toBe(false);
      expect((await lstat(plan.folder)).mode & 0o777).toBe(0o700);
      // The link and its target are untouched.
      expect((await lstat(join(home, 'AgentLink', 'Send'))).isSymbolicLink()).toBe(true);
      expect(await readdir(target)).toEqual(['secret.txt']);
    },
  );

  it('with fallback, a file at Send leads to Send-2', async () => {
    await mkdir(join(home, 'AgentLink'));
    await writeFile(join(home, 'AgentLink', 'Send'), 'not a folder');
    const plan = await prepareSendFolder(home, { fallback: true });
    expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') return;
    expect(plan.folder).toBe(join(await base(), 'Send-2'));
  });

  it('a fallback folder that already holds files is skipped (only a fresh one is used)', async () => {
    await mkdir(join(home, 'AgentLink', 'Send-2'), { recursive: true });
    await writeFile(join(home, 'AgentLink', 'Send'), 'not a folder');
    await writeFile(join(home, 'AgentLink', 'Send-2', 'old.txt'), 'x');
    const plan = await prepareSendFolder(home, { fallback: true });
    expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') return;
    expect(plan.folder).toBe(join(await base(), 'Send-3'));
    expect(await readdir(join(home, 'AgentLink', 'Send-2'))).toEqual(['old.txt']);
  });

  it('an existing empty fallback folder is used', async () => {
    await mkdir(join(home, 'AgentLink', 'Send-2'), { recursive: true });
    await writeFile(join(home, 'AgentLink', 'Send'), 'not a folder');
    const plan = await prepareSendFolder(home, { fallback: true });
    expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') return;
    expect(plan.folder).toBe(join(await base(), 'Send-2'));
    expect(plan.created).toEqual([]);
  });

  it.skipIf(onWindows)('a link at AgentLink is never used, even with fallback', async () => {
    const target = join(dir, 'elsewhere');
    await mkdir(join(target, 'Send'), { recursive: true });
    await symlink(target, join(home, 'AgentLink'));
    expect(await prepareSendFolder(home, { fallback: true })).toEqual({
      status: 'unavailable',
      reason: 'folder_unavailable',
    });
    expect(await readdir(target)).toEqual(['Send']);
  });

  it('when every fallback is taken, nothing is used and nothing is left behind', async () => {
    await mkdir(join(home, 'AgentLink'));
    await writeFile(join(home, 'AgentLink', 'Send'), 'x');
    for (let n = 2; n <= 9; n += 1) await writeFile(join(home, 'AgentLink', `Send-${n}`), 'x');
    expect(await prepareSendFolder(home, { fallback: true })).toEqual({
      status: 'unavailable',
      reason: 'folder_unavailable',
    });
    expect((await readdir(join(home, 'AgentLink'))).sort()).toHaveLength(9);
  });
});
