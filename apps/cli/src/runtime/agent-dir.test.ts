// The agent directory under ~/.agentlink (M1-9k; 06 §6, 07 §9.1, 04 §4 realpath rule).
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
    await mkdir(agentPaths(home, 'default').dir, { recursive: true });
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
    await mkdir(dir, { recursive: true });
    await writeFile(config, `${configText()}${' '.repeat(5_000)}`);
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
        await mkdir(dir, { recursive: true });
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
      await mkdir(join(agents, name), { recursive: true });
    }
    await writeFile(join(agents, 'file'), '');
    expect(await listAgentNames(home)).toEqual(['default', 'work']);
  });

  it('no ~/.agentlink yet is an empty list', async () => {
    expect(await listAgentNames(home)).toEqual([]);
  });
});
