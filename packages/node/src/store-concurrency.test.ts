// M1-8b acceptance (07 §3.7, 06 §6): several processes share one agent's store. Two processes
// writing concurrently cause no corruption and lose no update (read-modify-write in BEGIN IMMEDIATE
// transactions); a process killed mid-write leaves a store that opens and passes integrity_check;
// the inter-process lock admits one holder at a time across processes.
//
// The child processes run this package's TypeScript sources directly (Node's type stripping, and a
// resolve hook that maps the sources' `.js` specifiers to `.ts`), so they exercise the same code.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withInterProcessLock } from './inter-process-lock.js';
import { SqliteStore } from './sqlite-store.js';

const SRC = fileURLToPath(new URL('.', import.meta.url));

const HOOKS = `
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (specifier.startsWith('.') && specifier.endsWith('.js')) {
      return next(specifier.slice(0, -3) + '.ts', context);
    }
    throw error;
  }
}
`;

const REGISTER = `import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
`;

const WRITER = `
import { SqliteStore } from ${JSON.stringify(pathToFileURL(join(SRC, 'sqlite-store.ts')).href)};
const [path, name, count, lockstep] = process.argv.slice(2);
const store = await SqliteStore.open(path, { lockTimeoutMs: 60000 });
process.send?.('ready');
await new Promise((resolve) => process.once('message', resolve));
process.disconnect?.();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (let i = 0; i < Number(count); i += 1) {
  if (lockstep === 'lockstep') {
    // Round i starts only once the peer has committed its row i - 1 (this process has committed
    // exactly i rows, so a total of 2 * i rows means the peer has i). Both writers then reach the
    // lock together every round, and the insertion order cannot run one writer's rows in a long
    // streak whatever the speed of the machine: SQLite's lock is not fair, and on a slow disk one
    // writer could otherwise take most of the run.
    const deadline = Date.now() + 60000;
    while ((await store.transaction((tx) => tx.count('seen'))) < 2 * i) {
      if (Date.now() > deadline) throw new Error('lockstep: the peer made no progress');
      await sleep(1);
    }
  }
  await store.transaction((tx) => {
    const row = tx.get('budget_state', { slot: 'current' });
    tx.update('budget_state', { slot: 'current', newest_t: row.newest_t }, { newest_t: row.newest_t + 1 });
    tx.insert('seen', { kind: 'wrap', id: name + '-' + i, first_seen_at: i });
  });
  // Free-running writers (the kill test): a harness does other work between writes.
  if (lockstep !== 'lockstep' && i % 2 === 0) await sleep(1);
}
await store.close();
`;

const LOCKER = `
import { readFileSync, writeFileSync } from 'node:fs';
import { withInterProcessLock } from ${JSON.stringify(pathToFileURL(join(SRC, 'inter-process-lock.ts')).href)};
const [lockPath, counterPath, count] = process.argv.slice(2);
for (let i = 0; i < Number(count); i += 1) {
  await withInterProcessLock(lockPath, async () => {
    const n = Number(readFileSync(counterPath, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 2));
    writeFileSync(counterPath, String(n + 1));
  }, { timeoutMs: 60000 });
}
`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-procs-'));
  await writeFile(join(dir, 'hooks.mjs'), HOOKS);
  await writeFile(join(dir, 'register.mjs'), REGISTER);
  await writeFile(join(dir, 'writer.mjs'), WRITER);
  await writeFile(join(dir, 'locker.mjs'), LOCKER);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const stripFlag = process.allowedNodeEnvironmentFlags.has('--experimental-strip-types')
  ? ['--experimental-strip-types', '--disable-warning=ExperimentalWarning']
  : [];

interface Child {
  readonly done: Promise<number | null>;
  readonly ready: Promise<void>;
  go(): void;
  kill(): void;
  stderr(): string;
}

function run(script: string, args: readonly string[]): Child {
  const child = spawn(
    process.execPath,
    // --import takes a URL: a bare Windows path (C:\...) is not one.
    [
      ...stripFlag,
      '--import',
      pathToFileURL(join(dir, 'register.mjs')).href,
      join(dir, script),
      ...args,
    ],
    { cwd: SRC, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  let err = '';
  child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString()));
  // Settles on exit too, so a child that fails to start fails the test at once instead of timing out.
  const ready = new Promise<void>((resolve) => {
    child.on('message', () => resolve());
    child.on('exit', () => resolve());
  });
  const done = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return {
    done,
    ready,
    go: () => child.send('go'),
    kill: () => child.kill('SIGKILL'),
    stderr: () => err,
  };
}

async function seed(path: string): Promise<void> {
  const store = await SqliteStore.open(path);
  await store.transaction((tx) =>
    tx.insert('budget_state', {
      slot: 'current',
      ledger_epoch: 0,
      status: 'ok',
      newest_t: 0,
      since: 0,
      broken_at: null,
    }),
  );
  await store.close();
}

function integrity(path: string): string {
  const raw = new Database(path, { readonly: true });
  try {
    return String(raw.pragma('integrity_check', { simple: true }));
  } finally {
    raw.close();
  }
}

describe('SqliteStore shared by several processes (06 §6)', () => {
  it('two processes writing concurrently: no corruption, no lost update', async () => {
    const path = join(dir, 'agent.sqlite');
    await seed(path);
    const n = 150;
    const a = run('writer.mjs', [path, 'a', String(n), 'lockstep']);
    const b = run('writer.mjs', [path, 'b', String(n), 'lockstep']);
    await Promise.all([a.ready, b.ready]);
    a.go();
    b.go();
    const codes = await Promise.all([a.done, b.done]);
    expect(codes, a.stderr() + b.stderr()).toEqual([0, 0]);
    expect(integrity(path)).toBe('ok');
    const store = await SqliteStore.open(path);
    expect(await store.transaction((tx) => tx.count('seen'))).toBe(2 * n);
    const state = await store.transaction((tx) => tx.get('budget_state', { slot: 'current' }));
    expect(state?.newest_t).toBe(2 * n);
    await store.close();
    // The two writers really interleaved: in lockstep, every round commits one row of each, so the
    // insertion order switches writer at least once per round (n times in all), on any machine.
    const raw = new Database(path, { readonly: true });
    const order = raw.prepare('SELECT id FROM "seen" ORDER BY rowid').pluck().all() as string[];
    raw.close();
    const switches = order.filter((id, i) => i > 0 && id[0] !== order[i - 1]?.[0]).length;
    expect(switches).toBeGreaterThanOrEqual(n);
  }, 60_000);

  it('a process killed while writing leaves a store that opens and passes integrity_check', async () => {
    const path = join(dir, 'agent.sqlite');
    await seed(path);
    const victim = run('writer.mjs', [path, 'v', '100000']);
    const other = run('writer.mjs', [path, 'o', '100']);
    await Promise.all([victim.ready, other.ready]);
    victim.go();
    other.go();
    await new Promise((resolve) => setTimeout(resolve, 150));
    victim.kill();
    await victim.done;
    expect(await other.done, other.stderr()).toBe(0);
    expect(integrity(path)).toBe('ok');
    const store = await SqliteStore.open(path);
    // Every committed transaction wrote one seen row and one increment: they still agree.
    const [seen, state] = await store.transaction(
      (tx) => [tx.count('seen'), tx.get('budget_state', { slot: 'current' })] as const,
    );
    expect(state?.newest_t).toBe(seen);
    expect(seen).toBeGreaterThanOrEqual(100);
    await store.close();
  }, 60_000);
});

describe('withInterProcessLock (06 §6; 07 §3.4)', () => {
  it('admits one holder at a time across processes (no lost update across awaits)', async () => {
    const lockPath = join(dir, 'agent.sqlite.lock');
    const counter = join(dir, 'counter');
    await writeFile(counter, '0');
    const n = 25;
    const a = run('locker.mjs', [lockPath, counter, String(n)]);
    const b = run('locker.mjs', [lockPath, counter, String(n)]);
    expect(await Promise.all([a.done, b.done]), a.stderr() + b.stderr()).toEqual([0, 0]);
    expect(await readFile(counter, 'utf8')).toBe(String(2 * n));
  }, 60_000);

  it('admits one holder at a time inside one process, and times out with store_busy', async () => {
    const lockPath = join(dir, 'x.lock');
    let inside = 0;
    let most = 0;
    const holder = async (): Promise<void> => {
      inside += 1;
      most = Math.max(most, inside);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inside -= 1;
    };
    await Promise.all(Array.from({ length: 8 }, () => withInterProcessLock(lockPath, holder)));
    expect(most).toBe(1);
    let release: () => void = () => undefined;
    const held = withInterProcessLock(lockPath, () => new Promise<void>((r) => (release = r)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const error = await withInterProcessLock(lockPath, () => 1, { timeoutMs: 100 }).catch(
      (e: unknown) => e,
    );
    expect((error as { code?: string }).code).toBe('store_busy');
    release();
    await held;
    expect(await withInterProcessLock(lockPath, () => 2)).toBe(2);
  });

  it('is released when the holder throws', async () => {
    const lockPath = join(dir, 'y.lock');
    await expect(
      withInterProcessLock(lockPath, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await withInterProcessLock(lockPath, () => 3, { timeoutMs: 100 })).toBe(3);
  });

  it('is reachable from the store as the agent lock next to its file', async () => {
    const store = await SqliteStore.open(join(dir, 'agent.sqlite'));
    expect(await store.withInterProcessLock(() => 'held')).toBe('held');
    await store.close();
  });
});
