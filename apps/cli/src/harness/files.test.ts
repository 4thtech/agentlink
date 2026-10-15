// Safe config file access (M1-9a; 04 §4): links, other file types, hard links, a folder that others
// can write, a realpath escape, a file that changes under us, backups and atomic replacement.
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HarnessError } from './errors.js';
import { MAX_CONFIG_BYTES, readConfigFile, writeConfigFile } from './files.js';

const POSIX = process.platform !== 'win32';
let home: string;
let outside: string;

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'agentlink-files-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'agentlink-outside-')));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof HarnessError ? error.code : 'other';
  }
  return undefined;
}

const NOW = { now: 1_800_000_000 };

describe('readConfigFile', () => {
  it('reads a missing file, and a missing folder, as absent', async () => {
    expect((await readConfigFile(home, ['.codex', 'config.toml'])).text).toBeUndefined();
    await mkdir(join(home, '.codex'));
    expect((await readConfigFile(home, ['.codex', 'config.toml'])).bytes).toBeUndefined();
  });

  it('reads an existing file with its mode', async () => {
    await writeFile(join(home, '.claude.json'), '{"a":1}', { mode: 0o600 });
    const file = await readConfigFile(home, ['.claude.json']);
    expect(file.text).toBe('{"a":1}');
    if (POSIX) expect(file.mode).toBe(0o600);
  });

  it.skipIf(!POSIX)('refuses a symlinked file, even to a file inside home', async () => {
    await writeFile(join(home, 'real.json'), '{}');
    await symlink(join(home, 'real.json'), join(home, '.claude.json'));
    expect(await code(readConfigFile(home, ['.claude.json']))).toBe('unsafe_path');
  });

  it.skipIf(!POSIX)(
    'refuses a symlinked folder, whether it points outside or inside home',
    async () => {
      await symlink(outside, join(home, '.codex'));
      expect(await code(readConfigFile(home, ['.codex', 'config.toml']))).toBe('unsafe_path');
      await rm(join(home, '.codex'));
      await mkdir(join(home, 'elsewhere'));
      await symlink(join(home, 'elsewhere'), join(home, '.codex'));
      expect(await code(readConfigFile(home, ['.codex', 'config.toml']))).toBe('unsafe_path');
    },
  );

  it.skipIf(!POSIX)('refuses a folder that group or others can write', async () => {
    await mkdir(join(home, '.gemini'));
    await chmod(join(home, '.gemini'), 0o777);
    expect(await code(readConfigFile(home, ['.gemini', 'settings.json']))).toBe('unsafe_path');
  });

  it.skipIf(!POSIX)(
    'refuses a file owned by someone else and a file with a second name',
    async () => {
      await writeFile(join(home, '.claude.json'), '{}');
      const uid = process.getuid?.() ?? 0;
      expect(await code(readConfigFile(home, ['.claude.json'], { uid: uid + 1 }))).toBe(
        'unsafe_path',
      );
      await link(join(home, '.claude.json'), join(home, 'second-name'));
      expect(await code(readConfigFile(home, ['.claude.json']))).toBe('unsafe_path');
    },
  );

  it('refuses a folder where the file should be, and a file larger than the cap', async () => {
    await mkdir(join(home, '.claude.json'));
    expect(await code(readConfigFile(home, ['.claude.json']))).toBe('unsafe_path');
    await rm(join(home, '.claude.json'), { recursive: true });
    await writeFile(join(home, '.claude.json'), Buffer.alloc(MAX_CONFIG_BYTES + 1, 0x20));
    expect(await code(readConfigFile(home, ['.claude.json']))).toBe('malformed');
  });

  it('refuses bytes that are not UTF-8', async () => {
    await writeFile(join(home, '.claude.json'), Buffer.from([0xff, 0xfe, 0x00]));
    expect(await code(readConfigFile(home, ['.claude.json']))).toBe('malformed');
  });

  it('accepts a home folder that is itself a link (both sides are resolved)', async () => {
    const linkedHome = join(outside, 'home-link');
    await symlink(home, linkedHome);
    await writeFile(join(home, '.claude.json'), '{}');
    expect((await readConfigFile(linkedHome, ['.claude.json'])).text).toBe('{}');
  });
});

describe('writeConfigFile', () => {
  it('creates a missing folder (0700) and file, with no backup', async () => {
    const before = await readConfigFile(home, ['.codex', 'config.toml']);
    const result = await writeConfigFile(home, ['.codex', 'config.toml'], before, 'x = 1\n', {
      ...NOW,
    });
    expect(result.backup).toBeUndefined();
    expect(await readFile(join(home, '.codex', 'config.toml'), 'utf8')).toBe('x = 1\n');
    if (POSIX) {
      expect((await stat(join(home, '.codex'))).mode & 0o777).toBe(0o700);
      expect((await stat(join(home, '.codex', 'config.toml'))).mode & 0o777).toBe(0o600);
    }
  });

  it('replaces atomically, keeps the mode, and leaves a backup of the exact old bytes', async () => {
    await writeFile(join(home, '.claude.json'), '{"old":true}\n', { mode: 0o640 });
    if (POSIX) await chmod(join(home, '.claude.json'), 0o640);
    const before = await readConfigFile(home, ['.claude.json']);
    const result = await writeConfigFile(home, ['.claude.json'], before, '{"new":true}\n', {
      ...NOW,
    });
    expect(result.backup).toBe('.claude.json.agentlink-backup-1800000000');
    expect(await readFile(join(home, '.claude.json'), 'utf8')).toBe('{"new":true}\n');
    expect(await readFile(join(home, result.backup ?? ''), 'utf8')).toBe('{"old":true}\n');
    if (POSIX) {
      expect((await stat(join(home, '.claude.json'))).mode & 0o777).toBe(0o640);
      expect((await stat(join(home, result.backup ?? ''))).mode & 0o777).toBe(0o600);
    }
    // No temporary file is left behind.
    expect((await readdir(home)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('never replaces an older backup', async () => {
    await writeFile(join(home, '.claude.json'), 'v1');
    const first = await writeConfigFile(
      home,
      ['.claude.json'],
      await readConfigFile(home, ['.claude.json']),
      'v2',
      { ...NOW },
    );
    const second = await writeConfigFile(
      home,
      ['.claude.json'],
      await readConfigFile(home, ['.claude.json']),
      'v3',
      { ...NOW },
    );
    expect(first.backup).not.toBe(second.backup);
    expect(await readFile(join(home, first.backup ?? ''), 'utf8')).toBe('v1');
    expect(await readFile(join(home, second.backup ?? ''), 'utf8')).toBe('v2');
  });

  it('writes nothing when the file changed after it was shown', async () => {
    await writeFile(join(home, '.claude.json'), 'shown');
    const before = await readConfigFile(home, ['.claude.json']);
    await writeFile(join(home, '.claude.json'), 'changed meanwhile');
    expect(await code(writeConfigFile(home, ['.claude.json'], before, 'new', { ...NOW }))).toBe(
      'changed',
    );
    expect(await readFile(join(home, '.claude.json'), 'utf8')).toBe('changed meanwhile');
    expect((await readdir(home)).sort()).toEqual(['.claude.json']);
  });

  it('writes nothing when a file appeared where none was shown', async () => {
    const before = await readConfigFile(home, ['.claude.json']);
    await writeFile(join(home, '.claude.json'), 'appeared');
    expect(await code(writeConfigFile(home, ['.claude.json'], before, 'new', { ...NOW }))).toBe(
      'changed',
    );
    expect(await readFile(join(home, '.claude.json'), 'utf8')).toBe('appeared');
  });

  it.skipIf(!POSIX)('refuses to write through a link that appeared after the read', async () => {
    const before = await readConfigFile(home, ['.codex', 'config.toml']);
    await symlink(outside, join(home, '.codex'));
    expect(
      await code(writeConfigFile(home, ['.codex', 'config.toml'], before, 'x', { ...NOW })),
    ).toBe('unsafe_path');
    expect(await readdir(outside)).toEqual([]);
  });
});
