// U3-c: opening an agent for the app host (08 §1; 04 §2.5). The host opens agents only through the
// same open path as every command, never one that is not listed, unavailable or marked `removing`,
// and closes whatever it opened when the wiring fails.
import type {
  AgentDirectory,
  AgentDirectoryEntry,
  ApprovalServerOptions,
  LocalUiAssets,
} from '@4thtech-io/node';
import { describe, expect, it } from 'vitest';
import type { OwnerAgent, OwnerCommandDeps } from './owner/deps.js';
import { openUiHostAgent, startUiWelcome, type UiHostDeps, type UiWelcomeDeps } from './ui-host.js';

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
    const { deps: d, log } = deps([
      { name: 'work', label: 'Work', available: true, removing: false },
    ]);
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
    const { deps: d, log } = deps(
      [{ name: 'work', label: 'Work', available: true, removing: false }],
      {
        failWiring: true,
      },
    );
    expect(await openUiHostAgent(d, 'work')).toBeUndefined();
    expect(log).toEqual(['open work', 'close work']);
  });
});

// U3-g-b: the no-agent app host (Welcome). Started only when there is no agent folder at all (not
// even one being removed), the OS keychain can hold a new agent and this build has the app; it
// starts with no open agent and lets first run create the first one (host.firstRun).
describe('startUiWelcome (U3-g-b)', () => {
  const APP: LocalUiAssets = { files: new Map([['index.html', new Uint8Array([60])]]) };

  function welcome(
    over: {
      entries?: readonly AgentDirectoryEntry[];
      keychain?: boolean;
      assets?: LocalUiAssets;
    } = {},
  ): { deps: UiWelcomeDeps; started: ApprovalServerOptions[]; log: string[] } {
    const started: ApprovalServerOptions[] = [];
    const log: string[] = [];
    const directory = {
      list: () => Promise.resolve(over.entries ?? []),
    } as unknown as AgentDirectory;
    return {
      started,
      log,
      deps: {
        directory,
        keychainUsable: () => Promise.resolve(over.keychain ?? true),
        assets: () => over.assets ?? APP,
        open: () => Promise.resolve(undefined),
        startServer: (options) => {
          started.push(options);
          return Promise.resolve({
            openFirstRun: () => {
              log.push('openFirstRun');
              return Promise.resolve(true);
            },
            close: () => {
              log.push('close');
              return Promise.resolve();
            },
          });
        },
      },
    };
  }

  it('starts the host with no open agent and with first run, and opens the first-run page', async () => {
    const w = welcome();
    const server = await startUiWelcome(w.deps);
    expect(server?.page).toBe('first-run');
    expect(w.started).toHaveLength(1);
    const options = w.started[0];
    expect(options?.host?.initial).toBeUndefined();
    expect(options?.host?.firstRun).toBeDefined();
    expect(options?.localUi?.assets).toBe(APP);
    expect(options?.localUi?.client).toBeUndefined();
    await expect(server?.open()).resolves.toBe(true);
    await server?.close();
    expect(w.log).toEqual(['openFirstRun', 'close']);
  });

  it.each([
    ['an agent exists', { entries: [{ name: 'a', label: 'a', available: true, removing: false }] }],
    [
      'an agent is being removed',
      { entries: [{ name: 'a', label: 'a', available: true, removing: true }] },
    ],
    ['no usable keychain', { keychain: false }],
    ['no app in this build', { assets: { files: new Map() } }],
  ] as const)('starts nothing when %s', async (_why, over) => {
    const w = welcome(over);
    expect(await startUiWelcome(w.deps)).toBeUndefined();
    expect(w.started).toEqual([]);
  });
});
