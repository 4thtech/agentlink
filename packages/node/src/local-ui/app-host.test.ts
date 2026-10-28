// U3-c: the app host's state (08 §1 generation; 04 §2.5 "Several agents in one app"). One agent open
// at a time; a switch raises the generation first, waits for the requests in flight, closes the old
// agent and only then opens the other; a stale or missing generation is refused; `removing` agents
// and unknown names are never opened; nothing is signed.
import { describe, expect, it } from 'vitest';
import type { ApprovalServerSource } from '../approval-server.js';
import {
  AppHostSlot,
  type AgentDirectory,
  type AgentDirectoryEntry,
  type AppHostAgent,
} from './app-host.js';

const source: ApprovalServerSource = {
  context: () => Promise.resolve(undefined),
  list: () => Promise.resolve([]),
  get: () => Promise.resolve(undefined),
  apply: () => Promise.reject(new Error('never')),
};

interface World {
  readonly log: string[];
  readonly directory: AgentDirectory;
  readonly entries: Map<string, AgentDirectoryEntry>;
  readonly written: string[];
  agent(name: string): AppHostAgent;
  failOpen: Set<string>;
}

function world(names: readonly string[] = ['default', 'work']): World {
  const log: string[] = [];
  const written: string[] = [];
  const entries = new Map<string, AgentDirectoryEntry>(
    names.map((name) => [name, { name, label: name, available: true, removing: false }]),
  );
  const agent = (name: string): AppHostAgent => ({
    name,
    label: name,
    source,
    localUi: {},
    close: () => {
      log.push(`close ${name}`);
      return Promise.resolve();
    },
  });
  const directory: AgentDirectory = {
    list: () => Promise.resolve([...entries.values()]),
    read: (name) => Promise.resolve(entries.get(name)),
    stats: () => Promise.resolve(undefined),
    writeLabel: () => Promise.reject(new Error('not here')),
    markRemoving: () => Promise.reject(new Error('not here')),
    removeFolder: () => Promise.reject(new Error('not here')),
    readCurrent: () => Promise.resolve(undefined),
    writeCurrent: (name) => {
      written.push(name);
      return Promise.resolve();
    },
  };
  return { log, directory, entries, written, agent, failOpen: new Set() };
}

function slot(w: World, drainMs?: number): { slot: AppHostSlot; bound: (string | undefined)[] } {
  const bound: (string | undefined)[] = [];
  const host = new AppHostSlot(
    {
      directory: w.directory,
      initial: w.agent('default'),
      open: (name) => {
        w.log.push(`open ${name}`);
        return Promise.resolve(w.failOpen.has(name) ? undefined : w.agent(name));
      },
    },
    (agent) => bound.push(agent?.name),
    drainMs,
  );
  return { slot: host, bound };
}

describe('AppHostSlot (U3-c)', () => {
  it('starts at generation 1 with the initial agent bound', () => {
    const w = world();
    const { slot: host, bound } = slot(w);
    expect(host.generation).toBe(1);
    expect(host.current).toBe('default');
    expect(bound).toEqual(['default']);
  });

  it('a mutating request needs exactly the current generation', () => {
    const { slot: host } = slot(world());
    for (const bad of [undefined, '', '0', '2', ' 1', '1 ', '01', '1.0', 1, '1e0', 'x']) {
      expect(host.enterMutating(bad), String(bad)).toBeUndefined();
    }
    const hold = host.enterMutating('1');
    expect(hold?.valid()).toBe(true);
    hold?.leave();
  });

  it('switch closes the old agent before it opens the other, bumps the generation and writes app.json', async () => {
    const w = world();
    const { slot: host, bound } = slot(w);
    expect(await host.switchTo('work', '1')).toBe('done');
    expect(w.log).toEqual(['close default', 'open work']);
    expect(host.generation).toBe(2);
    expect(host.current).toBe('work');
    expect(bound).toEqual(['default', undefined, 'work']);
    expect(w.written).toEqual(['work']);
    // The old generation is refused everywhere from now on.
    expect(host.enterMutating('1')).toBeUndefined();
    expect(await host.switchTo('default', '1')).toBe('agent_changed');
  });

  it('a switch waits for a request in flight, and that request fails its re-check', async () => {
    const w = world();
    const { slot: host } = slot(w);
    const hold = host.enterMutating('1');
    if (hold === undefined) throw new Error('no hold');
    const switching = host.switchTo('work', '1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The generation is raised at once, but nothing is closed while the request runs.
    expect(hold.valid()).toBe(false);
    expect(w.log).toEqual([]);
    // New requests are refused while the switch is in progress.
    expect(host.enterMutating('2')).toBeUndefined();
    hold.leave();
    expect(await switching).toBe('done');
    expect(w.log).toEqual(['close default', 'open work']);
  });

  it('a read that arrives during a switch waits for it and then sees the new agent', async () => {
    const w = world();
    const { slot: host } = slot(w);
    const hold = host.enterMutating('1');
    const switching = host.switchTo('work', '1');
    const reading = host.enter().then((read) => {
      const seen = host.current;
      read.leave();
      return seen;
    });
    hold?.leave();
    expect(await switching).toBe('done');
    expect(await reading).toBe('work');
  });

  it('refuses unknown, unavailable and removing agents without closing anything', async () => {
    const w = world(['default', 'work', 'old', 'broken']);
    w.entries.set('old', { name: 'old', label: 'Old', available: true, removing: true });
    w.entries.set('broken', { name: 'broken', label: 'broken', available: false, removing: false });
    const { slot: host } = slot(w);
    expect(await host.switchTo('nobody', '1')).toBe('unknown_agent');
    expect(await host.switchTo('../work', '1')).toBe('unknown_agent');
    expect(await host.switchTo('Work', '1')).toBe('unknown_agent');
    expect(await host.switchTo(7, '1')).toBe('unknown_agent');
    expect(await host.switchTo('broken', '1')).toBe('unknown_agent');
    expect(await host.switchTo('old', '1')).toBe('removing');
    expect(w.log).toEqual([]);
    expect(host.generation).toBe(1);
  });

  it('switching to the open agent changes nothing but app.json', async () => {
    const w = world();
    const { slot: host } = slot(w);
    expect(await host.switchTo('default', '1')).toBe('done');
    expect(host.generation).toBe(1);
    expect(w.log).toEqual([]);
    expect(w.written).toEqual(['default']);
  });

  it('when the other agent cannot be opened, the previous one is opened again', async () => {
    const w = world();
    w.failOpen.add('work');
    const { slot: host } = slot(w);
    expect(await host.switchTo('work', '1')).toBe('unavailable');
    expect(w.log).toEqual(['close default', 'open work', 'open default']);
    expect(host.current).toBe('default');
    expect(w.written).toEqual([]);
  });

  it('a second switch while one is in progress is busy', async () => {
    const w = world(['default', 'work', 'home']);
    const { slot: host } = slot(w);
    const hold = host.enterMutating('1');
    const first = host.switchTo('work', '1');
    expect(await host.switchTo('home', '2')).toBe('busy');
    hold?.leave();
    expect(await first).toBe('done');
  });

  it('close closes whichever agent is open', async () => {
    const w = world();
    const { slot: host } = slot(w);
    await host.switchTo('work', '1');
    await host.close();
    expect(w.log).toEqual(['close default', 'open work', 'close work']);
    expect(await host.switchTo('default', '2')).toBe('unavailable');
  });
});

// U3-g-b: with no agent at all, the host starts with none open and opens the first agent that first
// run created (adoptFirst): the generation increases first, its own request hold is released, the
// requests in flight drain, then the agent is opened and app.json written. Never while one is open.
describe('AppHostSlot with no agent yet (U3-g-b)', () => {
  function empty(w: World): { slot: AppHostSlot; bound: (string | undefined)[] } {
    const bound: (string | undefined)[] = [];
    const host = new AppHostSlot(
      {
        directory: w.directory,
        open: (name) => {
          w.log.push(`open ${name}`);
          return Promise.resolve(w.failOpen.has(name) ? undefined : w.agent(name));
        },
      },
      (agent) => bound.push(agent?.name),
      50,
    );
    return { slot: host, bound };
  }

  it('starts at generation 1 with no agent bound', () => {
    const w = world([]);
    const { slot: s, bound } = empty(w);
    expect(s.current).toBeUndefined();
    expect(s.generation).toBe(1);
    expect(bound).toEqual([undefined]);
  });

  it('adoptFirst opens the new agent, raises the generation and writes app.json', async () => {
    const w = world(['my-agent']);
    const { slot: s, bound } = empty(w);
    const own = s.enterMutating('1');
    expect(own).toBeDefined();
    await expect(s.adoptFirst('my-agent', own)).resolves.toBe(true);
    expect(s.current).toBe('my-agent');
    expect(s.generation).toBe(2);
    expect(own?.valid()).toBe(false);
    expect(bound).toEqual([undefined, 'my-agent']);
    expect(w.written).toEqual(['my-agent']);
  });

  it('adoptFirst is refused while an agent is open, for a bad name, or when it cannot open', async () => {
    const w = world(['default', 'my-agent']);
    const { slot: open } = slot(w);
    await expect(open.adoptFirst('my-agent')).resolves.toBe(false);
    expect(open.current).toBe('default');
    const { slot: s } = empty(world([]));
    await expect(s.adoptFirst('Bad Name')).resolves.toBe(false);
    const w2 = world(['my-agent']);
    w2.failOpen.add('my-agent');
    const { slot: s2 } = empty(w2);
    await expect(s2.adoptFirst('my-agent')).resolves.toBe(false);
    expect(s2.current).toBeUndefined();
  });

  it('adoptFirst refuses an agent marked removing', async () => {
    const w = world(['my-agent']);
    w.entries.set('my-agent', { name: 'my-agent', label: 'x', available: true, removing: true });
    const { slot: s } = empty(w);
    await expect(s.adoptFirst('my-agent')).resolves.toBe(false);
    expect(w.log).toEqual([]);
  });
});
