// U3-d (D-138; 08 §1 `POST /api/ui/agents`; 06 §6 agent-name rule; 07 §9.1; proposed, owner confirms
// at merge): creating an agent folder from the local app, and removing exactly what that created.
//
// - The folder name is a slug of the label under the agent-name rule (lower case, letters, digits and
//   hyphens, starting with a letter, at most 32), made unique with a suffix; "Claude Code agent" is
//   "claude-code-agent". A label with no usable letter gives `agent`.
// - The new config names the keychain agent and holds no label: the label is written only after the
//   server verified the signed `agent.label` (07 §9.1).
// - Discarding a new agent removes its keychain items and its folder, and only for that agent.
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeHex, randomBytes } from '@4thtech-io/crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentSlug, createAgentFolder, discardNewAgentFolder } from './agent-create.js';
import { agentDirectory, readAgentConfig, writeAgentConfig } from './agent-dir.js';
import { isAgentName } from './agent-name.js';

const newId = (): string => `0x${encodeHex(randomBytes(20))}`;
let home: string;

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'agentlink-u3d-create-')));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('agentSlug (U3-d; 06 §6)', () => {
  it('makes the folder name from the label', () => {
    expect(agentSlug('Claude Code agent', [])).toBe('claude-code-agent');
    expect(agentSlug('Personal', [])).toBe('personal');
    expect(agentSlug("Work's agent", [])).toBe('works-agent');
    expect(agentSlug('Ana Kovač', [])).toBe('ana-kovac');
    expect(agentSlug('2nd agent', [])).toBe('agent-2nd-agent');
    expect(agentSlug('Агент', [])).toBe('agent');
    expect(agentSlug('...', [])).toBe('agent');
  });

  it('is unique with a suffix and always a valid agent name of at most 32', () => {
    expect(agentSlug('Personal', ['personal'])).toBe('personal-2');
    expect(agentSlug('Personal', ['personal', 'personal-2'])).toBe('personal-3');
    const long = agentSlug('A very long agent name for testing it', []);
    expect(long.length).toBeLessThanOrEqual(32);
    expect(isAgentName(long)).toBe(true);
    const taken = [long];
    const next = agentSlug('A very long agent name for testing it', taken);
    expect(next).not.toBe(long);
    expect(next.length).toBeLessThanOrEqual(32);
    expect(isAgentName(next)).toBe(true);
    for (const label of ['x', 'Work  agent', '-a-', 'Ω', 'a'.repeat(40)]) {
      expect(isAgentName(agentSlug(label, [])), label).toBe(true);
    }
  });
});

describe('createAgentFolder and discardNewAgentFolder (U3-d)', () => {
  it('creates a keychain agent in a new folder named from the label, with no label yet', async () => {
    await writeAgentConfig(home, { v: 1, name: 'work', agentId: newId(), keyStore: 'keychain' });
    const agentId = newId();
    const name = await createAgentFolder(home, 'Work', {
      createAgent: () => Promise.resolve(agentId),
    });
    expect(name).toBe('work-2');
    const found = await readAgentConfig(home, name);
    expect(found?.config).toEqual({ v: 1, name: 'work-2', agentId, keyStore: 'keychain' });
  });

  it('U3-g-b: a fixed name (the first agent, default) is used as is, never slugged', async () => {
    const agentId = newId();
    const name = await createAgentFolder(
      home,
      'My agent',
      { createAgent: () => Promise.resolve(agentId) },
      'default',
    );
    expect(name).toBe('default');
    const found = await readAgentConfig(home, 'default');
    expect(found?.config).toEqual({ v: 1, name: 'default', agentId, keyStore: 'keychain' });
  });

  it('U3-g-b: a fixed name that exists is refused before any key is made', async () => {
    await writeAgentConfig(home, { v: 1, name: 'default', agentId: newId(), keyStore: 'keychain' });
    let made = 0;
    await expect(
      createAgentFolder(
        home,
        'My agent',
        {
          createAgent: () => {
            made += 1;
            return Promise.resolve(newId());
          },
        },
        'default',
      ),
    ).rejects.toBeDefined();
    expect(made).toBe(0);
  });

  it('a config that cannot be written discards the keychain agent it just made', async () => {
    const discarded: string[] = [];
    const agentId = newId();
    await expect(
      createAgentFolder(join(home, 'missing', '\0bad'), 'Work', {
        createAgent: () => Promise.resolve(agentId),
        discardKeys: (id) => {
          discarded.push(id);
          return Promise.resolve();
        },
      }),
    ).rejects.toBeDefined();
    expect(discarded).toEqual([agentId]);
  });

  it('discard removes the new agent keychain items and folder; other agents stay', async () => {
    const other = newId();
    await writeAgentConfig(home, { v: 1, name: 'personal', agentId: other, keyStore: 'keychain' });
    const agentId = newId();
    const name = await createAgentFolder(home, 'Work', {
      createAgent: () => Promise.resolve(agentId),
    });
    const discarded: string[] = [];
    await discardNewAgentFolder(home, name, {
      discardKeys: (id) => {
        discarded.push(id);
        return Promise.resolve();
      },
    });
    expect(discarded).toEqual([agentId]);
    expect(await readdir(join(home, '.agentlink', 'agents'))).toEqual(['personal']);
    expect((await readAgentConfig(home, 'personal'))?.config.agentId).toBe(other);
  });
});

describe('agentDirectory create and discardNew (U3-d)', () => {
  it('discardNew removes only an agent this directory created, once', async () => {
    const existing = newId();
    await writeAgentConfig(home, {
      v: 1,
      name: 'personal',
      agentId: existing,
      keyStore: 'keychain',
    });
    const discarded: string[] = [];
    const made = newId();
    const directory = agentDirectory(home, {
      createAgent: () => Promise.resolve(made),
      discardKeys: (id) => {
        discarded.push(id);
        return Promise.resolve();
      },
    });
    await expect(directory.discardNew?.('personal')).rejects.toBeDefined();
    expect(discarded).toEqual([]);
    const name = await directory.create?.('Work agent');
    expect(name).toBe('work-agent');
    await directory.discardNew?.(name ?? '');
    expect(discarded).toEqual([made]);
    await expect(directory.discardNew?.(name ?? '')).rejects.toBeDefined();
    expect(await readdir(join(home, '.agentlink', 'agents'))).toEqual(['personal']);
  });

  it('W4-ONE-TOUCH: create stores the keys the app held since begin (createKeys), never new ones', async () => {
    const made: string[] = [];
    const held = newId();
    const directory = agentDirectory(home, {
      createAgent: () => {
        const id = newId();
        made.push(id);
        return Promise.resolve(id);
      },
    });
    const name = await directory.create?.('Work', {
      name: 'work',
      createKeys: () => Promise.resolve(held),
    });
    expect(name).toBe('work');
    expect(made).toEqual([]);
    expect((await readAgentConfig(home, 'work'))?.config.agentId).toBe(held);
  });

  it('W4-ONE-TOUCH: nameFor gives the slug create would use, never a taken or reserved name', async () => {
    await writeAgentConfig(home, { v: 1, name: 'work', agentId: newId(), keyStore: 'keychain' });
    const directory = agentDirectory(home, { createAgent: () => Promise.resolve(newId()) });
    expect(await directory.nameFor?.('Work', [])).toBe('work-2');
    expect(await directory.nameFor?.('Work', ['work-2'])).toBe('work-3');
    expect(await directory.nameFor?.('Home base', [])).toBe('home-base');
    // Nothing was created.
    expect(await readdir(join(home, '.agentlink', 'agents'))).toEqual(['work']);
  });
});
