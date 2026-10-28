// U3-c: opening an agent for the app host (08 §1; 04 §2.5). The host opens agents only through the
// same open path as every command, never one that is not listed, unavailable or marked `removing`,
// and closes whatever it opened when the wiring fails.
import type { AgentDirectory, AgentDirectoryEntry } from '@4thtech-io/node';
import { describe, expect, it } from 'vitest';
import type { OwnerAgent, OwnerCommandDeps } from './owner/deps.js';
import { openUiHostAgent, type UiHostDeps } from './ui-host.js';

function deps(
  entries: readonly AgentDirectoryEntry[],
  over: { failWiring?: boolean } = {},
): { deps: UiHostDeps; log: string[] } {
  const log: string[] = [];
  const directory = {
    read: (name: string) => Promise.resolve(entries.find((e) => e.name === name)),
  } as unknown as AgentDirectory;
  const owner: Pick<OwnerCommandDeps, 'open'> = {
    open: (name) => {
      log.push(`open ${String(name)}`);
      const agent = {
        name: name ?? 'default',
        client: { agentId: '0x1' },
        store: {},
        cipher: {},
        close: () => {
          log.push(`close ${String(name)}`);
          return Promise.resolve();
        },
      } as unknown as OwnerAgent;
      return Promise.resolve({ status: 'ok', agent });
    },
  };
  return {
    log,
    deps: {
      owner,
      directory,
      localUi: () =>
        over.failWiring === true
          ? Promise.reject(new Error('wiring'))
          : Promise.resolve({ assets: { files: new Map() }, client: {} as never }),
      now: () => 1,
    },
  };
}

describe('openUiHostAgent (U3-c)', () => {
  it('opens a listed agent with its label and without the app files', async () => {
    const { deps: d, log } = deps([{ name: 'work', label: 'Work', available: true, removing: false }]);
    const agent = await openUiHostAgent(d, 'work');
    expect(agent?.name).toBe('work');
    expect(agent?.label).toBe('Work');
    expect(agent && 'assets' in agent.localUi).toBe(false);
    await agent?.close();
    expect(log).toEqual(['open work', 'close work']);
  });

  it('never opens an unlisted, unavailable or removing agent', async () => {
    const { deps: d, log } = deps([
      { name: 'old', label: 'Old', available: true, removing: true },
      { name: 'broken', label: 'broken', available: false, removing: false },
    ]);
    expect(await openUiHostAgent(d, 'old')).toBeUndefined();
    expect(await openUiHostAgent(d, 'broken')).toBeUndefined();
    expect(await openUiHostAgent(d, 'nobody')).toBeUndefined();
    expect(log).toEqual([]);
  });

  it('closes the agent again when the page wiring fails', async () => {
    const { deps: d, log } = deps([{ name: 'work', label: 'Work', available: true, removing: false }], {
      failWiring: true,
    });
    expect(await openUiHostAgent(d, 'work')).toBeUndefined();
    expect(log).toEqual(['open work', 'close work']);
  });
});
