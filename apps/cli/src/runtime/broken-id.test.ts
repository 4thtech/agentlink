// WIN-BROKEN-ID: "Remove this ID from this computer" for an ID whose key is missing. The folder is
// moved, never deleted, to a dated folder outside `agents` (so it is no longer listed and can be
// moved back), and only then are the ID's leftover keychain items erased. Any failure is a fixed
// error the page shows: nothing is half removed in silence.
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeHex, randomBytes } from '@4thtech-io/crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAgentConfig, writeAgentConfig } from './agent-dir.js';
import { SET_ASIDE_DIR, setAsideBrokenAgent } from './broken-id.js';

const newId = (): string => `0x${encodeHex(randomBytes(20))}`;
const NOW = Date.UTC(2026, 10, 14, 9, 30, 5);
let home: string;

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'agentlink-set-aside-')));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('setAsideBrokenAgent (WIN-BROKEN-ID)', () => {
  it('moves the folder to a dated folder first, then erases the leftover items', async () => {
    const agentId = newId();
    await writeAgentConfig(home, { v: 1, name: 'default', agentId, keyStore: 'keychain' });
    await writeAgentConfig(home, { v: 1, name: 'work', agentId: newId(), keyStore: 'keychain' });
    const order: string[] = [];
    await setAsideBrokenAgent(home, 'default', {
      seedMissing: () => Promise.resolve(true),
      eraseLeftovers: async (id) => {
        // The folder is already gone from `agents` when the keys are touched.
        order.push(`erase ${id}`);
        expect(await readAgentConfig(home, 'default')).toBeUndefined();
      },
      now: () => NOW,
    });
    expect(order).toEqual([`erase ${agentId}`]);
    expect(await readdir(join(home, '.agentlink', 'agents'))).toEqual(['work']);
    const aside = await readdir(join(home, '.agentlink', SET_ASIDE_DIR));
    expect(aside).toEqual(['default.20261114-093005']);
    const kept = await readdir(join(home, '.agentlink', SET_ASIDE_DIR, aside[0] as string));
    expect(kept).toContain('config.json');
  });

  it('refuses an ID whose key is here, and changes nothing', async () => {
    await writeAgentConfig(home, { v: 1, name: 'default', agentId: newId(), keyStore: 'keychain' });
    let erased = 0;
    await expect(
      setAsideBrokenAgent(home, 'default', {
        seedMissing: () => Promise.resolve(false),
        eraseLeftovers: () => {
          erased += 1;
          return Promise.resolve();
        },
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: 'agent_not_broken' });
    expect(erased).toBe(0);
    expect(await readAgentConfig(home, 'default')).toBeDefined();
  });

  it('a folder that cannot be moved keeps its keys and rejects (no silent partial removal)', async () => {
    await writeAgentConfig(home, { v: 1, name: 'default', agentId: newId(), keyStore: 'keychain' });
    // A file where the set-aside folder must be: the move cannot happen.
    await writeFile(join(home, '.agentlink', SET_ASIDE_DIR), 'x');
    let erased = 0;
    await expect(
      setAsideBrokenAgent(home, 'default', {
        seedMissing: () => Promise.resolve(true),
        eraseLeftovers: () => {
          erased += 1;
          return Promise.resolve();
        },
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: 'agent_path_invalid' });
    expect(erased).toBe(0);
    expect(await readAgentConfig(home, 'default')).toBeDefined();
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a set-aside folder that is a link (realpath rule, 04 §4)',
    async () => {
      await writeAgentConfig(home, {
        v: 1,
        name: 'default',
        agentId: newId(),
        keyStore: 'keychain',
      });
      const elsewhere = join(home, 'elsewhere');
      await mkdir(elsewhere);
      await symlink(elsewhere, join(home, '.agentlink', SET_ASIDE_DIR));
      await expect(
        setAsideBrokenAgent(home, 'default', {
          seedMissing: () => Promise.resolve(true),
          eraseLeftovers: () => Promise.resolve(),
          now: () => NOW,
        }),
      ).rejects.toMatchObject({ code: 'agent_path_invalid' });
      expect(await readdir(elsewhere)).toEqual([]);
    },
  );

  it('a failed erase after the move rejects with its own code (the page says so)', async () => {
    await writeAgentConfig(home, { v: 1, name: 'default', agentId: newId(), keyStore: 'keychain' });
    await expect(
      setAsideBrokenAgent(home, 'default', {
        seedMissing: () => Promise.resolve(true),
        eraseLeftovers: () => Promise.reject(new Error('keychain')),
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: 'agent_keys_left' });
    // The folder is out of `agents` either way: the ID is no longer listed.
    expect(await readAgentConfig(home, 'default')).toBeUndefined();
  });

  it('refuses a file-KeyStore ID and a bad name', async () => {
    await writeAgentConfig(home, { v: 1, name: 'filed', agentId: newId(), keyStore: 'file' });
    const deps = {
      seedMissing: () => Promise.resolve(true),
      eraseLeftovers: () => Promise.resolve(),
      now: () => NOW,
    };
    await expect(setAsideBrokenAgent(home, 'filed', deps)).rejects.toMatchObject({
      code: 'agent_not_broken',
    });
    await expect(setAsideBrokenAgent(home, '../x', deps)).rejects.toMatchObject({
      code: 'agent_name_invalid',
    });
  });

  it('a seed check that fails is its own error, never "the key is here" (r2)', async () => {
    await writeAgentConfig(home, { v: 1, name: 'default', agentId: newId(), keyStore: 'keychain' });
    await expect(
      setAsideBrokenAgent(home, 'default', {
        seedMissing: () => Promise.reject(new Error('locked')),
        eraseLeftovers: () => Promise.resolve(),
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: 'agent_keys_unchecked' });
    expect(await readAgentConfig(home, 'default')).toBeDefined();
  });
});
