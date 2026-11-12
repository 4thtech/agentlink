// WP-R2b (IR M-1; 04 §2.5 "KeyStore isolation"): AppHostSlot.visitOthers, the recovery-kit export's
// walk over the other IDs, is bounded. An open or a step that hangs (a keychain prompt with the
// owner away) stops the walk within its limit, the agent it later yields is closed, the open ID is
// opened again, and at no point are two agents open. A drain that does not finish is bounded by the
// drain time. An open ID that cannot be opened again leaves the host with none open (never
// half-open) and a new generation, so every page reloads and shows it.
import { describe, expect, it } from 'vitest';
import {
  AppHostSlot,
  type AgentDirectory,
  type AgentDirectoryEntry,
  type AppHostAgent,
} from './app-host.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface World {
  readonly log: string[];
  readonly open: Set<string>;
  readonly violations: string[];
  readonly slot: AppHostSlot;
  /** Hold `name`'s next open until `release(name)`. */
  hang(name: string): void;
  release(name: string): void;
  /** The open of `name` fails from now on. */
  fail(name: string): void;
}

function world(drainMs = 10_000): World {
  const log: string[] = [];
  const open = new Set<string>();
  const violations: string[] = [];
  const hung = new Map<string, () => void>();
  const hanging = new Set<string>();
  const failing = new Set<string>();
  const entries = new Map<string, AgentDirectoryEntry>(
    ['default', 'work', 'shop'].map((name) => [
      name,
      { name, label: name, available: true, removing: false },
    ]),
  );
  const directory: AgentDirectory = {
    list: () => Promise.resolve([...entries.values()]),
    read: (name) => Promise.resolve(entries.get(name)),
    stats: () => Promise.resolve(undefined),
    writeLabel: () => Promise.resolve(),
    markRemoving: () => Promise.resolve(),
    removeFolder: () => Promise.resolve(),
    readCurrent: () => Promise.resolve('default'),
    writeCurrent: () => Promise.resolve(),
  };
  const agent = (name: string): AppHostAgent => {
    if (open.size > 0) violations.push(`open ${name} with [${[...open]}]`);
    open.add(name);
    log.push(`open ${name}`);
    return {
      name,
      label: name,
      source: {} as never,
      localUi: {},
      close: () => {
        if (open.delete(name)) log.push(`close ${name}`);
        return Promise.resolve();
      },
    };
  };
  const slot = new AppHostSlot(
    {
      directory,
      initial: agent('default'),
      open: async (name) => {
        if (failing.has(name)) return undefined;
        if (hanging.has(name)) {
          hanging.delete(name);
          await new Promise<void>((resolve) => hung.set(name, resolve));
        }
        return agent(name);
      },
    },
    () => undefined,
    drainMs,
  );
  return {
    log,
    open,
    violations,
    slot,
    hang: (name) => void hanging.add(name),
    release: (name) => hung.get(name)?.(),
    fail: (name) => void failing.add(name),
  };
}

const stepped = (log: string[]) => async (name: string, agent: AppHostAgent | undefined) => {
  log.push(`step ${name} ${agent === undefined ? 'none' : 'open'}`);
  return Promise.resolve(true);
};

describe('visitOthers is bounded and keeps one agent open (WP-R2b, IR M-1)', () => {
  it('walks every name with one open at a time and opens the first ID again', async () => {
    const w = world();
    const own = await w.slot.enter();
    const out = await w.slot.visitOthers(['work', 'shop'], stepped(w.log), { stepMs: () => 1000 });
    own.leave();
    expect(out).toEqual({ ok: true, restored: true });
    expect(w.log).toEqual([
      'open default',
      'close default',
      'open work',
      'step work open',
      'close work',
      'open shop',
      'step shop open',
      'close shop',
      'open default',
    ]);
    expect(w.violations).toEqual([]);
    expect(w.slot.current).toBe('default');
    expect(w.slot.generation).toBe(1);
  });

  it('a peer open that hangs is cut off; the open ID is restored; the late agent is closed on arrival', async () => {
    const w = world();
    w.hang('work');
    const started = Date.now();
    const out = await w.slot.visitOthers(['work', 'shop'], stepped(w.log), {
      stepMs: () => 50,
      settleMs: 50,
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out).toEqual({ ok: false, restored: true });
    // `shop` is never reached; nothing was stepped.
    expect(w.log).toEqual(['open default', 'close default', 'open default']);
    expect(w.slot.current).toBe('default');
    // The prompt is answered later: that agent is closed at once, never kept.
    w.release('work');
    await sleep(10);
    expect(w.log.slice(-2)).toEqual(['open work', 'close work']);
    expect([...w.open]).toEqual(['default']);
  });

  it('a late open that settles within the settle time is closed before the open ID returns', async () => {
    const w = world();
    w.hang('work');
    setTimeout(() => w.release('work'), 80);
    const out = await w.slot.visitOthers(['work'], stepped(w.log), {
      stepMs: () => 30,
      settleMs: 1000,
    });
    expect(out).toEqual({ ok: false, restored: true });
    expect(w.log).toEqual([
      'open default',
      'close default',
      'open work',
      'close work',
      'open default',
    ]);
    expect(w.violations).toEqual([]);
  });

  it('a step that hangs is cut off; its agent is closed and the open ID restored', async () => {
    const w = world();
    const out = await w.slot.visitOthers(
      ['work', 'shop'],
      async (name) => {
        w.log.push(`step ${name}`);
        await new Promise<void>(() => undefined);
        return true;
      },
      { stepMs: () => 50 },
    );
    expect(out).toEqual({ ok: false, restored: true });
    expect(w.log).toEqual([
      'open default',
      'close default',
      'open work',
      'step work',
      'close work',
      'open default',
    ]);
    expect(w.violations).toEqual([]);
  });

  it('no time left (the export budget spent) opens nothing more', async () => {
    const w = world();
    const out = await w.slot.visitOthers(['work'], stepped(w.log), { stepMs: () => 0 });
    expect(out).toEqual({ ok: false, restored: true });
    expect(w.log).toEqual(['open default', 'close default', 'open default']);
  });

  it('a request that never leaves is drained for at most the drain time', async () => {
    const w = world(60);
    const own = await w.slot.enter();
    const stuck = await w.slot.enter();
    const started = Date.now();
    const out = await w.slot.visitOthers(['work'], stepped(w.log), { stepMs: () => 1000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out).toEqual({ ok: true, restored: true });
    own.leave();
    stuck.leave();
  });

  it('while the walk runs, writes are refused and a switch is busy', async () => {
    const w = world();
    let inside: { write: unknown; busy: unknown } | undefined;
    await w.slot.visitOthers(
      ['work'],
      async () => {
        inside = {
          write: w.slot.enterMutating('1'),
          busy: await w.slot.switchTo('shop', '1'),
        };
        return true;
      },
      { stepMs: () => 1000 },
    );
    expect(inside).toEqual({ write: undefined, busy: 'busy' });
  });

  it('an open ID that cannot be opened again leaves none open and a new generation', async () => {
    const w = world();
    w.fail('default');
    const out = await w.slot.visitOthers(['work'], stepped(w.log), { stepMs: () => 1000 });
    expect(out).toEqual({ ok: true, restored: false });
    expect(w.slot.current).toBeUndefined();
    expect(w.slot.generation).toBe(2);
    expect([...w.open]).toEqual([]);
    // The page's next write (built against generation 1) is refused: it reloads.
    expect(w.slot.enterMutating('1')).toBeUndefined();
  });
});
