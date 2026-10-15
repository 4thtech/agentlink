// M1-7k-b acceptance over the real Node store (M1-8b): the per-agent publisher lease (07 §3.2
// `publisher_lease`; 06 §6 "One active publisher per agent"). Several harness MCP processes share one
// agent store, each with its own SQLite connection; exactly one of them holds the lease. A holder that
// is killed (SIGKILL: no release, no renewal) is taken over within one lease period of its last
// write; a lease never holds forever after a crash.
//
// The child process runs this package's TypeScript sources directly (Node's type stripping and a
// resolve hook, as store-concurrency.test.ts does) and the built @agentlink/core, as sqlite-store.ts
// itself imports it.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PUBLISHER_LEASE_RENEW_SECONDS,
  PUBLISHER_LEASE_SECONDS,
  PublisherLease,
} from '@agentlink/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from './sqlite-store.js';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const CORE = pathToFileURL(createRequire(import.meta.url).resolve('@agentlink/core')).href;

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

/** A server process: takes the lease, reports, renews every 20 s until it is killed. */
const HOLDER = `
import { SqliteStore } from ${JSON.stringify(pathToFileURL(join(SRC, 'sqlite-store.ts')).href)};
import { PublisherLease } from ${JSON.stringify(CORE)};
const [path, offset] = process.argv.slice(2);
const store = await SqliteStore.open(path, { lockTimeoutMs: 60000 });
const lease = new PublisherLease({ store, now: () => Math.floor(Date.now() / 1000) + Number(offset) });
const held = await lease.take();
process.send?.(held ? 'held:' + lease.holder : 'not-held');
setInterval(() => void lease.renew(), 20000);
`;

let dir: string;
const stores: SqliteStore[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-lease-'));
  await writeFile(join(dir, 'hooks.mjs'), HOOKS);
  await writeFile(join(dir, 'register.mjs'), REGISTER);
  await writeFile(join(dir, 'holder.mjs'), HOLDER);
});
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  await rm(dir, { recursive: true, force: true });
});

const stripFlag = process.allowedNodeEnvironmentFlags.has('--experimental-strip-types')
  ? ['--experimental-strip-types', '--disable-warning=ExperimentalWarning']
  : [];

const path = (): string => join(dir, 'agent.db');

async function open(): Promise<SqliteStore> {
  const store = await SqliteStore.open(path());
  stores.push(store);
  return store;
}

const leaseRow = (store: SqliteStore) =>
  store.transaction((tx) => tx.get('publisher_lease', { name: 'subscriptions' }));

describe('publisher lease over one SQLite store shared by several processes (M1-7k-b, 06 §6)', () => {
  it('two connections: only one holds; renewal keeps it; the other takes over within one lease period', async () => {
    let t = 1_800_000_000;
    const now = (): number => t;
    const a = new PublisherLease({ store: await open(), now });
    const b = new PublisherLease({ store: await open(), now });
    const results = await Promise.all([a.take(), b.take()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const [holder, other] = results[0] === true ? [a, b] : [b, a];
    for (let i = 0; i < 5; i += 1) {
      t += PUBLISHER_LEASE_RENEW_SECONDS;
      expect(await holder.renew()).toBe(true);
      expect(await other.take()).toBe(false);
      expect([a.held, b.held].filter(Boolean)).toHaveLength(1);
    }
    // The holder stops renewing (stalled or dead).
    t += PUBLISHER_LEASE_SECONDS - 1;
    expect(await other.take()).toBe(false);
    t += 1;
    expect(await other.take()).toBe(true);
    expect(await holder.renew()).toBe(false);
    expect(holder.held).toBe(false);
    expect((await leaseRow(await open()))?.holder).toBe(other.holder);
  });

  it('a clock jump either way: one round of renewals leaves exactly one holder', async () => {
    let t = 1_800_000_000;
    const now = (): number => t;
    const a = new PublisherLease({ store: await open(), now });
    const b = new PublisherLease({ store: await open(), now });
    expect(await a.take()).toBe(true);
    let [holder, other] = [a, b];
    for (const jump of [3_600, -3_600, 86_400, -86_400]) {
      t += jump;
      expect(holder.held).toBe(false); // the jump made its own view of the lease invalid
      expect(await other.take()).toBe(true);
      expect(await holder.renew()).toBe(false);
      expect(await other.renew()).toBe(true);
      expect([a.held, b.held].filter(Boolean)).toHaveLength(1);
      [holder, other] = [other, holder];
    }
  });

  it('a killed holder process is taken over within one lease period, never earlier', async () => {
    const offset = 0;
    const child = spawn(
      process.execPath,
      [
        ...stripFlag,
        '--import',
        pathToFileURL(join(dir, 'register.mjs')).href,
        join(dir, 'holder.mjs'),
        path(),
        String(offset),
      ],
      { cwd: SRC, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    let err = '';
    child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString()));
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    const message = await new Promise<string>((resolve) => {
      child.on('message', (m) => resolve(String(m)));
      child.on('exit', () => resolve('exit'));
    });
    expect(message, err).toMatch(/^held:/);
    const childHolder = message.slice('held:'.length);

    let skew = 0;
    const store = await open();
    const lease = new PublisherLease({
      store,
      now: () => Math.floor(Date.now() / 1000) + skew,
    });
    expect(await lease.take()).toBe(false);
    expect((await leaseRow(store))?.holder).toBe(childHolder);

    child.kill('SIGKILL');
    await exited;
    // No release ran: the row is still the dead process's until it lapses.
    expect((await leaseRow(store))?.holder).toBe(childHolder);
    expect(await lease.take()).toBe(false);
    // One lease period later (this process's view of the same clock moved on).
    skew = PUBLISHER_LEASE_SECONDS;
    expect(await lease.take()).toBe(true);
    expect((await leaseRow(store))?.holder).toBe(lease.holder);
  });
});
