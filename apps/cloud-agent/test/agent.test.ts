// M2-3a acceptance (08 §3.1; D-131 (f), spike S-5; I-1, I-7): AgentDO under Miniflare with the
// AGENT_SEED path. Alarm sync picks up a message; a run that throws still leaves the alarm armed;
// a restart is idempotent; at most 5 relay sockets per run and none open afterwards; autonomous
// actions off (nothing published); the seed and the store key never appear in logs or in storage.
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import {
  decodeHex,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  hkdfSha256,
  randomBytes,
  type OwnerPresence,
} from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTONOMOUS_ACTIONS, type SyncRunSummary } from '../src/agent-do.js';
import { CLOUD_STORE_KEY_INFO } from '../src/worker-keystore.js';
import { relay } from './fake-relay.js';
import { RELAY_URLS, dumpStorage, freshAgent, sendToAgent, setUpAgent } from './helpers.js';
import { TEST_AGENT_SEED } from './secrets.js';
import type { TestAgentDO } from './worker.js';

const presence = (): OwnerPresence => ({
  kind: 'passphrase',
  secret: encodeUtf8('correct horse battery'),
});
const newOwner = () => new MemoryOwnerKeyStore(randomBytes(32), presence());

async function setUp(relays?: readonly string[]) {
  const stub = freshAgent();
  const agentNostr = await setUpAgent(stub, newOwner(), presence, relays);
  return { stub, agentNostr };
}

const alarmOf = (stub: DurableObjectStub<TestAgentDO>) =>
  runInDurableObject(stub, (_i: TestAgentDO, state: DurableObjectState) =>
    state.storage.getAlarm(),
  );

const rowsOf = (stub: DurableObjectStub<TestAgentDO>, sql: string) =>
  runInDurableObject(stub, (_i: TestAgentDO, state: DurableObjectState) =>
    state.storage.sql.exec(sql).toArray(),
  );

/** Every form a secret's bytes could take in text. */
function forms(bytes: Uint8Array): string[] {
  const b64 = btoa(String.fromCharCode(...bytes));
  return [encodeHex(bytes), encodeBase64url(bytes), b64, b64.replace(/=+$/, '')];
}

let logs: string[];
beforeEach(() => {
  relay.reset();
  logs = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('AgentDO alarm sync (08 §3.1, spike S-5)', () => {
  it('picks up a message from the relay on an alarm run and re-arms the alarm', async () => {
    const { stub, agentNostr } = await setUp();
    expect(await alarmOf(stub)).not.toBeNull();
    const sender = new MemoryKeyStore(randomBytes(32));
    const { envelopeHash, wrap } = await sendToAgent(sender, agentNostr);

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const seen = await rowsOf(stub, `SELECT kind, id FROM seen WHERE kind = 'wrap'`);
    expect(seen.map((r) => r['id'])).toContain(wrap.id);
    // Verified and stored as `received` (07 §3.2), then processed: its envelopeHash is in the seen set.
    const hashes = await rowsOf(stub, `SELECT id FROM seen WHERE kind = 'envelope'`);
    expect(hashes.map((r) => r['id'])).toContain(envelopeHash);
    expect(logs.some((l) => l.includes('"code":"sync_ok"') && l.includes('"stored":1'))).toBe(true);
    const cursors = await rowsOf(stub, 'SELECT relay_url FROM sync_cursors');
    expect(cursors.map((r) => r['relay_url']).sort()).toEqual([...RELAY_URLS].sort());
    expect(relay.reqs).toBeGreaterThan(0);
    // No relay socket outlives the run; the next alarm is armed.
    expect(relay.openSockets).toBe(0);
    expect(await alarmOf(stub)).not.toBeNull();
  });

  it('keeps autonomous actions off: a run publishes nothing (no acks, no replies)', async () => {
    expect(AUTONOMOUS_ACTIONS).toBe(false);
    const { stub, agentNostr } = await setUp();
    await sendToAgent(new MemoryKeyStore(randomBytes(32)), agentNostr);
    await runDurableObjectAlarm(stub);
    expect(relay.published).toHaveLength(0);
  });

  it('a run that throws still leaves the next alarm armed, and reports only a fixed code', async () => {
    const { stub } = await setUp();
    await stub.setFailRuns(true);
    await runInDurableObject(stub, (_i: TestAgentDO, state: DurableObjectState) =>
      state.storage.deleteAlarm(),
    );
    await runInDurableObject(stub, (_i: TestAgentDO, state: DurableObjectState) =>
      state.storage.setAlarm(Date.now() + 1_000),
    );
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const next = await alarmOf(stub);
    expect(next).not.toBeNull();
    expect(next as number).toBeGreaterThan(Date.now() + 30_000);
    const summary: SyncRunSummary = await stub.syncNow();
    expect(summary).toMatchObject({ status: 'failed', code: 'unexpected' });
    expect(logs.join('\n')).toContain('sync_failed');
    expect(logs.join('\n')).not.toContain('injected run failure');
    // It recovers on the next run.
    await stub.setFailRuns(false);
    expect((await stub.syncNow()).status).toBe('ok');
  });

  it('is idempotent across a restart: same alarm, no duplicate rows, data kept', async () => {
    const { stub, agentNostr } = await setUp();
    await sendToAgent(new MemoryKeyStore(randomBytes(32)), agentNostr);
    await runDurableObjectAlarm(stub);
    const count = async () => ({
      envelopes: (await rowsOf(stub, 'SELECT count(*) AS n FROM envelopes'))[0]?.['n'],
      seen: (await rowsOf(stub, 'SELECT count(*) AS n FROM seen'))[0]?.['n'],
      identity: (await rowsOf(stub, 'SELECT count(*) AS n FROM identity'))[0]?.['n'],
    });
    const before = await count();
    const alarm = await alarmOf(stub);

    // Eviction completes only once nothing is pending in the object: a run leaves no socket or timer.
    await evictDurableObject(stub);
    // The constructor runs again: the schema opens as it is, the armed alarm is kept.
    expect(await stub.health()).toEqual({ setUp: true, alarmArmed: true });
    expect(await alarmOf(stub)).toBe(alarm);
    // The same relay events again (at-least-once alarms, a restart mid-run): nothing doubles.
    await runDurableObjectAlarm(stub);
    expect(await stub.syncNow()).toMatchObject({ status: 'ok', stored: 0 });
    expect(await count()).toEqual(before);
    expect(before.identity).toBe(1);
  });

  it('does not run concurrently with itself: a second run while one is going is `busy`', async () => {
    const { stub } = await setUp();
    const [a, b] = await runInDurableObject(stub, (instance: TestAgentDO) =>
      Promise.all([instance.syncNow(), instance.syncNow()]),
    );
    expect([a.status, b.status].sort()).toEqual(['busy', 'ok']);
  });

  it('opens at most 5 relay sockets per run and closes them all', async () => {
    const relays = Array.from({ length: 8 }, (_, i) => `wss://relay${i}.cloud-agent-test.net`);
    const { stub } = await setUp(relays);
    const summary = await stub.syncNow();
    expect(summary.status).toBe('ok');
    expect(relay.opens.length).toBeLessThanOrEqual(5);
    expect(summary.sockets).toBeLessThanOrEqual(5);
    expect(relay.openSockets).toBe(0);
  });

  it('stops the loop while the agent is not set up', async () => {
    const stub = freshAgent();
    expect(await stub.health()).toEqual({ setUp: false, alarmArmed: false });
    expect(await stub.start()).toBe(false);
    expect((await stub.syncNow()).status).toBe('not_set_up');
    await runInDurableObject(stub, (_i: TestAgentDO, state: DurableObjectState) =>
      state.storage.setAlarm(Date.now() + 1_000),
    );
    await runDurableObjectAlarm(stub);
    expect(await alarmOf(stub)).toBeNull();
    expect(relay.opens).toHaveLength(0);
  });
});

describe('AgentDO secrets (I-1, I-7; 04 §2.2)', () => {
  it('never writes the seed or the store key to a log or to storage', async () => {
    const { stub, agentNostr } = await setUp();
    await sendToAgent(new MemoryKeyStore(randomBytes(32)), agentNostr);
    await runDurableObjectAlarm(stub);
    await stub.setFailRuns(true);
    await stub.syncNow();
    await stub.setFailRuns(false);

    const seed = decodeHex(TEST_AGENT_SEED, { length: 32 });
    const storeKey = hkdfSha256(
      seed,
      encodeUtf8('agentlink-v1'),
      encodeUtf8(CLOUD_STORE_KEY_INFO),
      32,
    );
    const secrets = [...forms(seed), ...forms(storeKey)];
    const logText = logs.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    const storage = await dumpStorage(stub);
    expect(storage).toContain(RELAY_URLS[0]); // the dump reads real rows (sync_cursors)
    for (const secret of secrets) {
      expect(logText.includes(secret)).toBe(false);
      expect(storage.includes(secret)).toBe(false);
    }
    // The AGENT_SEED path keeps no seed item at all.
    expect(await rowsOf(stub, `SELECT name FROM agent_items WHERE name = 'seed'`)).toEqual([]);
  });

  it('refuses to provision a sealed seed while AGENT_SEED is set', async () => {
    await runInDurableObject(freshAgent(), async (instance: TestAgentDO) => {
      await expect(instance.provisionSeed()).rejects.toThrow(
        expect.objectContaining({ code: 'seed_conflict' }),
      );
    });
  });
});
