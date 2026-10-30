// W4-LIVE-STATUS (D-143; 06 §6 "MCP session heartbeat"; 07 §3.2 `mcp_sessions`, `mcp_last_seen`):
// every `agentlink mcp` process keeps one session row, lease holder or not. Written at `initialize`,
// renewed every 15 s with a TTL of 45 s, stamped on tool calls (at most one write per second),
// deleted on clean exit; `mcp_last_seen` keeps one time per AI app id. The node tests run the reader
// (agent-peek.ts) over a real SQLite file.
import { describe, expect, it } from 'vitest';
import {
  MCP_SESSION_BEAT_SECONDS,
  MCP_SESSION_TTL_SECONDS,
  McpSession,
  mcpSessionLive,
} from './mcp-session.js';
import { PublisherLease } from './publisher-lease.js';
import { STORE_SCHEMA_VERSION } from './constants.js';
import { MemoryStore } from './store/memory-store.js';
import type { Store } from './store/store.js';
import { FakeClock } from './testing/fixtures.js';

const AGENT = `0x${'a'.repeat(40)}`;
const OTHER_AGENT = `0x${'b'.repeat(40)}`;

const rows = (store: Store) => store.transaction((tx) => tx.select('mcp_sessions'));
const seen = (store: Store) => store.transaction((tx) => tx.select('mcp_last_seen'));

function session(store: Store, clock: FakeClock, pid = 4242, pidAlive?: (pid: number) => boolean) {
  return new McpSession({
    store,
    now: clock.now,
    agentId: AGENT,
    pid,
    ...(pidAlive === undefined ? {} : { pidAlive }),
  });
}

describe('MCP session heartbeat: values (06 §6, 07 §3.2)', () => {
  it('beats every 15 s with a TTL of 45 s, in the next store schema version', () => {
    expect(MCP_SESSION_BEAT_SECONDS).toBe(15);
    expect(MCP_SESSION_TTL_SECONDS).toBe(45);
    // W4-AUTO-SAVE (D-142) takes version 11 after it.
    expect(STORE_SCHEMA_VERSION).toBeGreaterThanOrEqual(10);
  });
});

describe('MCP session heartbeat: write, beat, stamp, exit', () => {
  it('writes nothing before start (initialize), then one row with a random 16-byte id', async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const s = session(store, clock);
    expect(await rows(store)).toEqual([]);
    expect(await s.start('claude-code')).toBe(true);
    const [row] = await rows(store);
    expect(row).toEqual({
      session_id: s.sessionId,
      app: 'claude-code',
      agent_id: AGENT,
      pid: 4242,
      started_at: clock.t,
      beat_until: clock.t + 45,
      last_tool_at: null,
    });
    expect(s.sessionId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(session(store, clock).sessionId).not.toBe(s.sessionId);
    expect(await seen(store)).toEqual([{ app: 'claude-code', last_seen_at: clock.t }]);
  });

  it('keeps any app id outside the fixed table as `other`', async () => {
    const store = new MemoryStore();
    const s = session(store, new FakeClock());
    await s.start('CANARY-not-an-app </x>');
    const [row] = await rows(store);
    expect(row?.app).toBe('other');
    expect(JSON.stringify(await seen(store))).not.toContain('CANARY');
  });

  it('starts once: a second start writes no second row', async () => {
    const store = new MemoryStore();
    const s = session(store, new FakeClock());
    await s.start('codex');
    await s.start('claude-code');
    expect(await rows(store)).toHaveLength(1);
    expect((await rows(store))[0]?.app).toBe('codex');
  });

  it('renews beat_until with a compare-and-set on its id and writes last seen', async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const s = session(store, clock);
    await s.start('codex');
    clock.t += 15;
    expect(await s.beat()).toBe(true);
    const [row] = await rows(store);
    expect(row?.beat_until).toBe(clock.t + 45);
    expect(await seen(store)).toEqual([{ app: 'codex', last_seen_at: clock.t }]);
  });

  it('inserts its row again on the next beat when it was pruned', async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const s = session(store, clock);
    await s.start('codex');
    await store.transaction((tx) => tx.delete('mcp_sessions', {}));
    clock.t += 15;
    expect(await s.beat()).toBe(true);
    const [row] = await rows(store);
    expect(row).toMatchObject({ session_id: s.sessionId, app: 'codex', beat_until: clock.t + 45 });
  });

  it('a beat before start writes nothing', async () => {
    const store = new MemoryStore();
    const s = session(store, new FakeClock());
    expect(await s.beat()).toBe(false);
    expect(await rows(store)).toEqual([]);
  });

  it('stamps tool calls at start and end, at most one write per second', async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const s = session(store, clock);
    await s.start('claude-code');
    let writes = 0;
    const counting: Store = {
      get schemaVersion() {
        return store.schemaVersion;
      },
      transaction: (body) => {
        writes += 1;
        return store.transaction(body);
      },
      close: () => store.close(),
    };
    const t = new McpSession({ store: counting, now: clock.now, agentId: AGENT, pid: 7 });
    await t.start('claude-code');
    writes = 0;
    await t.toolCall();
    await t.toolCall();
    expect(writes).toBe(1);
    clock.t += 1;
    await t.toolCall();
    expect(writes).toBe(2);
    await s.toolCall();
    const mine = (await rows(store)).find((r) => r.session_id === s.sessionId);
    expect(mine?.last_tool_at).toBe(clock.t);
  });

  it('deletes its own row on exit (compare-and-set on its id) and keeps last seen', async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const a = session(store, clock);
    const b = session(store, clock);
    await a.start('claude-code');
    await b.start('claude-code');
    clock.t += 3;
    expect(await a.end()).toBe(true);
    const left = await rows(store);
    expect(left.map((r) => r.session_id)).toEqual([b.sessionId]);
    expect(await seen(store)).toEqual([{ app: 'claude-code', last_seen_at: clock.t }]);
    expect(await a.end()).toBe(false);
    expect(await a.beat()).toBe(false);
  });

  it('never throws on a store failure: a failed beat is tried again at the next tick', async () => {
    const broken: Store = {
      schemaVersion: STORE_SCHEMA_VERSION,
      transaction: () => Promise.reject(new Error('busy')),
      close: () => Promise.resolve(),
    };
    const s = new McpSession({ store: broken, now: new FakeClock().now, agentId: AGENT, pid: 9 });
    await expect(s.start('codex')).resolves.toBe(false);
    await expect(s.beat()).resolves.toBe(false);
    await expect(s.toolCall()).resolves.toBeUndefined();
    await expect(s.end()).resolves.toBe(false);
  });

  it('prunes rows that are no longer live when it inserts its own', async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    await store.transaction((tx) => {
      const base = { app: 'codex', agent_id: AGENT, started_at: clock.t - 100, last_tool_at: null };
      tx.insert('mcp_sessions', { ...base, session_id: 'expired', pid: 11, beat_until: clock.t });
      tx.insert('mcp_sessions', { ...base, session_id: 'gone', pid: 12, beat_until: clock.t + 30 });
      tx.insert('mcp_sessions', {
        ...base,
        session_id: 'alive',
        pid: 13,
        beat_until: clock.t + 30,
      });
      tx.insert('mcp_sessions', {
        ...base,
        session_id: 'pid-one',
        pid: 1,
        beat_until: clock.t + 30,
      });
      tx.insert('mcp_sessions', {
        ...base,
        session_id: 'other-agent',
        agent_id: OTHER_AGENT,
        pid: 13,
        beat_until: clock.t + 30,
      });
    });
    const s = session(store, clock, 4242, (pid) => pid === 13 || pid === 4242);
    await s.start('claude-code');
    expect((await rows(store)).map((r) => r.session_id).sort()).toEqual(
      ['alive', s.sessionId].sort(),
    );
  });

  it('a second process on the same agent writes its row while the first holds the lease', async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const lease = new PublisherLease({ store, now: clock.now });
    expect(await lease.take()).toBe(true);
    const first = session(store, clock, 100);
    const second = session(store, clock, 200);
    await first.start('claude-code');
    await second.start('codex');
    const live = (await rows(store)).filter((r) => mcpSessionLive(r, clock.t, AGENT, () => true));
    expect(live.map((r) => r.app).sort()).toEqual(['claude-code', 'codex']);
    // The lease is untouched by the heartbeat.
    expect(
      await store.transaction((tx) => tx.get('publisher_lease', { name: 'subscriptions' })),
    ).toMatchObject({ holder: lease.holder });
  });
});

describe('mcpSessionLive: the reader rule (06 §6 "Read", 04 §2.5)', () => {
  const now = 1_800_000_000;
  const row = (over: Record<string, unknown> = {}) => ({
    session_id: 's',
    app: 'codex',
    agent_id: AGENT,
    pid: 500,
    started_at: now - 10,
    beat_until: now + 30,
    last_tool_at: null,
    ...over,
  });
  const alive = () => true;

  it('is live while now < beat_until <= now + 90 and the pid exists', () => {
    expect(mcpSessionLive(row(), now, AGENT, alive)).toBe(true);
    expect(mcpSessionLive(row({ beat_until: now }), now, AGENT, alive)).toBe(false);
    expect(mcpSessionLive(row({ beat_until: now + 90 }), now, AGENT, alive)).toBe(true);
    expect(mcpSessionLive(row({ beat_until: now + 91 }), now, AGENT, alive)).toBe(false);
    expect(mcpSessionLive(row(), now, AGENT, () => false)).toBe(false);
  });

  it.each([0, -1, 1, 1.5, '500', null, 2 ** 31, Number.NaN])(
    'refuses pid %s without checking it',
    (pid) => {
      let asked = false;
      const check = () => {
        asked = true;
        return true;
      };
      expect(mcpSessionLive(row({ pid }), now, AGENT, check)).toBe(false);
      expect(asked).toBe(false);
    },
  );

  it('accepts pid 2 and 2^31 - 1', () => {
    expect(mcpSessionLive(row({ pid: 2 }), now, AGENT, alive)).toBe(true);
    expect(mcpSessionLive(row({ pid: 2 ** 31 - 1 }), now, AGENT, alive)).toBe(true);
  });

  it('ignores a row of another agent', () => {
    expect(mcpSessionLive(row({ agent_id: OTHER_AGENT }), now, AGENT, alive)).toBe(false);
  });
});
