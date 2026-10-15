// The agent directory under ~/.agentlink (M1-9k; 06 §6, 07 §9.1, 04 §4 realpath rule).
import { execFileSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeHex, randomBytes } from '@agentlink/crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentPaths,
  listAgentNames,
  parseAgentConfig,
  readAgentConfig,
  writeAgentConfig,
} from './agent-dir.js';
import { RUNTIME_MESSAGES } from './errors.js';

const agentId = (): string => `0x${encodeHex(randomBytes(20))}`;
let home: string;

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'agentlink-home-')));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const configText = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, name: 'default', agentId: agentId(), keyStore: 'keychain', ...over });

describe('agent paths', () => {
  it('one folder per agent under ~/.agentlink/agents, with the config and the store file', () => {
    const paths = agentPaths(home, 'work');
    expect(paths.dir).toBe(join(home, '.agentlink', 'agents', 'work'));
    expect(paths.config).toBe(join(paths.dir, 'config.json'));
    expect(paths.store).toBe(join(paths.dir, 'store.sqlite'));
  });

  it('refuses an invalid name before building any path', () => {
    for (const name of ['../x', '-x', 'a/b', 'A', '']) {
      expect(() => agentPaths(home, name)).toThrow(RUNTIME_MESSAGES.agent_name_invalid);
    }
  });
});

describe('the recorded config (07 §9.1)', () => {
  it('round-trips through writeAgentConfig and readAgentConfig, owner-only permissions', async () => {
    const id = agentId();
    await writeAgentConfig(home, { v: 1, name: 'work', agentId: id, keyStore: 'keychain' });
    const found = await readAgentConfig(home, 'work');
    expect(found?.config).toEqual({ v: 1, name: 'work', agentId: id, keyStore: 'keychain' });
    if (process.platform !== 'win32') {
      expect((await stat(found!.paths.config)).mode & 0o777).toBe(0o600);
      expect((await stat(found!.paths.dir)).mode & 0o777).toBe(0o700);
    }
  });

  it('a missing agent is undefined (the caller answers needs_setup, never creates one)', async () => {
    expect(await readAgentConfig(home, 'default')).toBeUndefined();
    await mkdir(agentPaths(home, 'default').dir, { recursive: true, mode: 0o700 });
    expect(await readAgentConfig(home, 'default')).toBeUndefined();
  });

  it('a recorded name that fails the pattern is refused with a fixed error that never shows it', async () => {
    const canary = 'Evil\u001b[2J; rm -rf ~';
    const parse = () => parseAgentConfig(configText({ name: canary }), 'default');
    expect(parse).toThrow(RUNTIME_MESSAGES.agent_name_invalid);
    try {
      parse();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('rm -rf');
    }
    expect(() => parseAgentConfig(configText({ name: 'default\n' }), 'default')).toThrow(
      RUNTIME_MESSAGES.agent_name_invalid,
    );
  });

  it('a recorded name that is not the folder it is in is refused', () => {
    expect(() => parseAgentConfig(configText({ name: 'other' }), 'default')).toThrow(
      RUNTIME_MESSAGES.agent_config_invalid,
    );
  });

  it.each([
    ['not JSON', '{'],
    ['an array', '[]'],
    ['an extra key', configText({ extra: 1 })],
    ['a wrong version', configText({ v: 2 })],
    ['an invalid agent ID', configText({ agentId: '0xABC' })],
    ['an unknown backend', configText({ keyStore: 'plain' })],
    ['a missing key', JSON.stringify({ v: 1, name: 'default', keyStore: 'keychain' })],
  ])('refuses %s', (_label, text) => {
    expect(() => parseAgentConfig(text, 'default')).toThrow(RUNTIME_MESSAGES.agent_config_invalid);
  });

  it('refuses an oversized config unread', async () => {
    const { dir, config } = agentPaths(home, 'default');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(config, `${configText()}${' '.repeat(5_000)}`, { mode: 0o600 });
    await expect(readAgentConfig(home, 'default')).rejects.toThrow(
      RUNTIME_MESSAGES.agent_config_invalid,
    );
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a config or an agent folder that is a link (04 §4)',
    async () => {
      const elsewhere = await mkdtemp(join(tmpdir(), 'agentlink-elsewhere-'));
      try {
        await writeFile(join(elsewhere, 'config.json'), configText());
        const { dir, config, agents } = agentPaths(home, 'default');
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await symlink(join(elsewhere, 'config.json'), config);
        await expect(readAgentConfig(home, 'default')).rejects.toThrow(
          RUNTIME_MESSAGES.agent_path_invalid,
        );
        await symlink(elsewhere, join(agents, 'linked'));
        await expect(readAgentConfig(home, 'linked')).rejects.toThrow(
          RUNTIME_MESSAGES.agent_path_invalid,
        );
      } finally {
        await rm(elsewhere, { recursive: true, force: true });
      }
    },
  );

  it('writes the exact keys and refuses an invalid agent ID', async () => {
    await expect(
      writeAgentConfig(home, { v: 1, name: 'work', agentId: 'nope', keyStore: 'keychain' }),
    ).rejects.toThrow();
    const id = agentId();
    const { config } = await writeAgentConfig(home, {
      v: 1,
      name: 'work',
      agentId: id,
      keyStore: 'keychain',
    });
    expect(JSON.parse(await readFile(config, 'utf8'))).toEqual({
      v: 1,
      name: 'work',
      agentId: id,
      keyStore: 'keychain',
    });
  });
});

describe('listing agents', () => {
  it('lists only folders with a valid name, sorted', async () => {
    const agents = join(home, '.agentlink', 'agents');
    for (const name of ['work', 'default', 'Bad', '-x', 'with space']) {
      await mkdir(join(agents, name), { recursive: true, mode: 0o700 });
    }
    await writeFile(join(agents, 'file'), '');
    expect(await listAgentNames(home)).toEqual(['default', 'work']);
  });

  it('no ~/.agentlink yet is an empty list', async () => {
    expect(await listAgentNames(home)).toEqual([]);
  });
});

// IR-M1-9k-1 F02: the agent folder follows the keystore folder rules (04 §2.8, §4): every level from
// ~/.agentlink down is a real directory (no link) with mode 0700 owned by this user; the config and
// any store file are regular files (no link, no FIFO, no folder) with mode 0600 owned by this user.
// Everything else fails closed with the fixed text.
const posix = process.platform !== 'win32';

describe.skipIf(!posix)('agent folder permissions, owner and file types (IR-M1-9k-1 F02)', () => {
  const PATH_INVALID = RUNTIME_MESSAGES.agent_path_invalid;

  const initDefault = () =>
    writeAgentConfig(home, { v: 1, name: 'default', agentId: agentId(), keyStore: 'keychain' });

  it('a written agent has 0700 folders at every level and a 0600 config, and reads back', async () => {
    const paths = await initDefault();
    for (const dir of [paths.root, paths.agents, paths.dir]) {
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    }
    expect((await stat(paths.config)).mode & 0o777).toBe(0o600);
    expect(await readAgentConfig(home, 'default')).toBeDefined();
  });

  it.each([
    ['~/.agentlink', 'root'],
    ['agents', 'agents'],
    ['the agent folder', 'dir'],
  ] as const)('refuses %s with group or other bits (0755, 0750, 0701)', async (_label, level) => {
    const paths = await initDefault();
    for (const mode of [0o755, 0o750, 0o701]) {
      await chmod(paths[level], mode);
      await expect(readAgentConfig(home, 'default')).rejects.toThrow(PATH_INVALID);
    }
    await chmod(paths[level], 0o700);
    expect(await readAgentConfig(home, 'default')).toBeDefined();
  });

  it.each([0o644, 0o640, 0o604, 0o660])('refuses a config with mode %o', async (mode) => {
    const paths = await initDefault();
    await chmod(paths.config, mode);
    await expect(readAgentConfig(home, 'default')).rejects.toThrow(PATH_INVALID);
  });

  it('refuses a symlinked ~/.agentlink or agents folder, even when the target is private', async () => {
    const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'agentlink-target-')));
    try {
      const paths = await initDefault();
      await rename(paths.agents, join(elsewhere, 'agents'));
      await symlink(join(elsewhere, 'agents'), paths.agents);
      await expect(readAgentConfig(home, 'default')).rejects.toThrow(PATH_INVALID);
      await rm(paths.agents);
      await rename(join(elsewhere, 'agents'), paths.agents);
      await rename(paths.root, join(elsewhere, 'root'));
      await symlink(join(elsewhere, 'root'), paths.root);
      await expect(readAgentConfig(home, 'default')).rejects.toThrow(PATH_INVALID);
      await expect(listAgentNames(home)).rejects.toThrow(PATH_INVALID);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('refuses a config that is a folder or a FIFO', async () => {
    const paths = await initDefault();
    await rm(paths.config);
    await mkdir(paths.config, { mode: 0o700 });
    await expect(readAgentConfig(home, 'default')).rejects.toThrow(PATH_INVALID);
    await rm(paths.config, { recursive: true });
    execFileSync('mkfifo', ['-m', '600', paths.config]);
    await expect(readAgentConfig(home, 'default')).rejects.toThrow(PATH_INVALID);
  });

  it('refuses a store file (and its -wal, -shm) that is a link, a folder, too open or a FIFO', async () => {
    const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'agentlink-target-')));
    try {
      const paths = await initDefault();
      await writeFile(join(elsewhere, 'store.sqlite'), '', { mode: 0o600 });
      for (const name of ['store.sqlite', 'store.sqlite-wal', 'store.sqlite-shm']) {
        const target = join(paths.dir, name);
        await symlink(join(elsewhere, 'store.sqlite'), target);
        await expect(readAgentConfig(home, 'default')).rejects.toThrow(PATH_INVALID);
        await rm(target);
        await mkdir(target, { mode: 0o700 });
        await expect(readAgentConfig(home, 'default')).rejects.toThrow(PATH_INVALID);
        await rm(target, { recursive: true });
        await writeFile(target, '', { mode: 0o600 });
        await chmod(target, 0o644);
        await expect(readAgentConfig(home, 'default')).rejects.toThrow(PATH_INVALID);
        await chmod(target, 0o600);
        expect(await readAgentConfig(home, 'default')).toBeDefined();
        await rm(target);
        execFileSync('mkfifo', ['-m', '600', target]);
        await expect(readAgentConfig(home, 'default')).rejects.toThrow(PATH_INVALID);
        await rm(target);
      }
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('refuses folders and files owned by another user', async () => {
    await initDefault();
    const uid = process.getuid!();
    expect(await readAgentConfig(home, 'default', { uid })).toBeDefined();
    await expect(readAgentConfig(home, 'default', { uid: uid + 1 })).rejects.toThrow(PATH_INVALID);
  });

  it('a pre-existing folder that is too open is refused on write, never loosened or tightened', async () => {
    const agents = join(home, '.agentlink', 'agents');
    await mkdir(agents, { recursive: true, mode: 0o755 });
    await chmod(join(home, '.agentlink'), 0o755);
    await chmod(agents, 0o755);
    await expect(initDefault()).rejects.toThrow(PATH_INVALID);
    expect((await stat(agents)).mode & 0o777).toBe(0o755);
  });

  it('the fixed text names the fix and never a path', async () => {
    const paths = await initDefault();
    await chmod(paths.dir, 0o755);
    const error: unknown = await readAgentConfig(home, 'default').catch((e: unknown) => e);
    expect((error as Error).message).toBe(PATH_INVALID);
    expect((error as Error).message).not.toContain(home);
  });
});

// IR-M1-9k-1 F03: writing a config never replaces an existing agent unless asked to.
describe('no clobber (IR-M1-9k-1 F03)', () => {
  it('a second write for the same name is refused and the first agent is kept', async () => {
    const first = agentId();
    await writeAgentConfig(home, { v: 1, name: 'default', agentId: first, keyStore: 'keychain' });
    await expect(
      writeAgentConfig(home, { v: 1, name: 'default', agentId: agentId(), keyStore: 'keychain' }),
    ).rejects.toThrow(RUNTIME_MESSAGES.agent_exists);
    expect((await readAgentConfig(home, 'default'))?.config.agentId).toBe(first);
  });

  it('replace: true is the explicit way to rewrite it', async () => {
    await writeAgentConfig(home, {
      v: 1,
      name: 'default',
      agentId: agentId(),
      keyStore: 'keychain',
    });
    const second = agentId();
    await writeAgentConfig(
      home,
      { v: 1, name: 'default', agentId: second, keyStore: 'keychain' },
      { replace: true },
    );
    expect((await readAgentConfig(home, 'default'))?.config.agentId).toBe(second);
  });
});
