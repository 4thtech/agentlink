// W4-AUTO-SAVE (S2; D-142; 04 §4.1): the CLI's Node files platform on a real disk, for every save
// (automatic, Save, agentlink_fetch_file).
// - Only the default Inbox folder is created; any other missing folder is unavailable.
// - The folder rules: not writable by group or others, not a send folder (equal, inside, containing).
// - An entry of any kind at the name (file, folder, link) is never replaced or followed.
// - The temporary file is created 0600, never executable; on macOS it gets com.apple.quarantine.
// - A write that fails leaves nothing behind once removed; errors never carry a path.
import { execFileSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeFilesPlatform } from '../src/runtime/files.js';

let home: string;

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), 'agentlink-k3-')));
  await chmod(home, 0o700);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const platform = () => nodeFilesPlatform({ home, drop: false });

describe('the Inbox folder (04 §4.1)', () => {
  it('creates only the default folder (0700); any other missing folder is unavailable', async () => {
    const inbox = await platform().inbox('~/AgentLink/Inbox');
    expect(inbox.realpath).toBe(path.join(home, 'AgentLink', 'Inbox'));
    expect((await lstat(inbox.realpath)).mode & 0o777).toBe(0o700);
    await inbox.close?.();
    const err = await platform()
      .inbox('~/Elsewhere/Inbox')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).not.toContain(home);
    await expect(lstat(path.join(home, 'Elsewhere'))).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a folder writable by group or others, and a send folder',
    async () => {
      const shared = path.join(home, 'Shared');
      await mkdir(shared);
      await chmod(shared, 0o777);
      await expect(platform().inbox('~/Shared')).rejects.toThrow();
      const send = path.join(home, 'Send');
      await mkdir(path.join(send, 'In'), { recursive: true, mode: 0o700 });
      await chmod(send, 0o700);
      await expect(platform().inbox('~/Send', ['~/Send'])).rejects.toThrow();
      await expect(platform().inbox('~/Send/In', ['~/Send'])).rejects.toThrow();
      await expect(platform().inbox('~/AgentLink/Inbox', ['~/AgentLink'])).rejects.toThrow();
    },
  );
});

describe('writing the file (04 §4.1)', () => {
  it.skipIf(process.platform === 'win32')(
    'a link or a folder at the name is never replaced or followed',
    async () => {
      const inbox = await platform().inbox('~/AgentLink/Inbox');
      const outside = path.join(home, 'outside.txt');
      await writeFile(outside, 'ORIGINAL');
      await symlink(outside, path.join(inbox.realpath, 'a.txt'));
      await mkdir(path.join(inbox.realpath, 'b.txt'));
      for (const target of ['a.txt', 'b.txt']) {
        const temp = `.agentlink-partial-${'0'.repeat(31)}${target === 'a.txt' ? '1' : '2'}`;
        const handle = await inbox.ops.create(temp);
        await handle.write(new TextEncoder().encode('NEW'));
        await handle.close();
        expect((await lstat(path.join(inbox.realpath, temp))).mode & 0o777).toBe(0o600);
        await expect(inbox.ops.rename(temp, target)).rejects.toThrow();
        await inbox.ops.remove(temp);
      }
      expect(await readFile(outside, 'utf8')).toBe('ORIGINAL');
      expect(await readlink(path.join(inbox.realpath, 'a.txt'))).toBe(outside);
      expect(await inbox.isSavedFile?.('a.txt')).toBe(false);
      expect(await inbox.isSavedFile?.('b.txt')).toBe(false);
      await inbox.close?.();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'the exclusive create never follows a link planted at the temporary name',
    async () => {
      const inbox = await platform().inbox('~/AgentLink/Inbox');
      const outside = path.join(home, 'victim.txt');
      await writeFile(outside, 'ORIGINAL');
      const temp = `.agentlink-partial-${'a'.repeat(32)}`;
      await symlink(outside, path.join(inbox.realpath, temp));
      await expect(inbox.ops.create(temp)).rejects.toThrow();
      expect(await readFile(outside, 'utf8')).toBe('ORIGINAL');
      await inbox.close?.();
    },
  );

  it('the free space is read from the folder volume', async () => {
    const inbox = await platform().inbox('~/AgentLink/Inbox');
    expect(await inbox.freeBytes?.()).toBeGreaterThan(0);
    await inbox.close?.();
  });

  it.runIf(process.platform === 'darwin')(
    'macOS: the temporary file gets com.apple.quarantine before the move; the saved file keeps it',
    async () => {
      const inbox = await platform().inbox('~/AgentLink/Inbox');
      const temp = `.agentlink-partial-${'b'.repeat(32)}`;
      const handle = await inbox.ops.create(temp);
      await handle.write(new TextEncoder().encode('X'));
      await handle.close();
      expect(await inbox.mark?.(temp)).toBe('marked');
      await inbox.ops.rename(temp, 'saved.bin');
      const saved = path.join(inbox.realpath, 'saved.bin');
      const value = execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', saved], {
        encoding: 'utf8',
      });
      expect(value).toMatch(/^0081;[0-9a-f]+;AgentLink;[0-9A-F-]{36}\s*$/);
      expect((await lstat(saved)).mode & 0o111).toBe(0);
      expect(await inbox.isSavedFile?.('saved.bin')).toBe(true);
      await inbox.close?.();
    },
  );

  it.runIf(process.platform === 'linux')('Linux: no common mark (accepted residual)', async () => {
    const inbox = await platform().inbox('~/AgentLink/Inbox');
    const temp = `.agentlink-partial-${'c'.repeat(32)}`;
    const handle = await inbox.ops.create(temp);
    await handle.close();
    expect(await inbox.mark?.(temp)).toBe('unsupported');
    await inbox.close?.();
  });
});
