// U3-c: the read-only look at an agent's store for the Agents list (08 §1; 06 §6): the active
// contact count, clear columns only, read-only, never failing.
// W4-LIVE-STATUS (D-143; 06 §6 "MCP session heartbeat", 04 §2.5 "Live status and Pause"): Running and
// the live sessions come from `mcp_sessions` rows (TTL and pid checked), never from the publisher
// lease; `mcp_last_seen` gives "last seen" per AI app. The pid never leaves the peek.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { peekAgentStore } from './agent-peek.js';
import { pidAlive } from './pid-alive.js';

const NOW = 1_800_000_000;
const AGENT = `0x${'a'.repeat(40)}`;
let dir: string;
let path: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'agentlink-u3c-peek-')));
  path = join(dir, 'store.sqlite');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface SessionSeed {
  readonly id?: string;
  readonly app?: unknown;
  readonly agentId?: string;
  readonly pid?: unknown;
  readonly startedAt?: number;
  readonly beatUntil?: unknown;
  readonly lastToolAt?: number | null;
}

function seed(
  statuses: readonly string[],
  leaseUntil?: number,
  live?: {
    readonly sessions?: readonly SessionSeed[];
    readonly lastSeen?: readonly (readonly [string, number])[];
  },
): void {
  const db = new Database(path);
  db.exec('CREATE TABLE contacts (contact_id TEXT PRIMARY KEY, status TEXT, name BLOB)');
  db.exec('CREATE TABLE publisher_lease (name TEXT PRIMARY KEY, holder TEXT, lease_until INTEGER)');
  statuses.forEach((status, i) => {
    db.prepare('INSERT INTO contacts VALUES (?, ?, ?)').run(
      `c${String(i)}`,
      status,
      Buffer.from('x'),
    );
  });
  if (leaseUntil !== undefined) {
    db.prepare('INSERT INTO publisher_lease VALUES (?, ?, ?)').run(
      'subscriptions',
      'h',
      leaseUntil,
    );
  }
  if (live !== undefined) {
    // Loose column types on purpose: a forged row may hold any value (04 §2.5).
    db.exec('CREATE TABLE identity (agent_id TEXT)');
    db.prepare('INSERT INTO identity VALUES (?)').run(AGENT);
    db.exec(
      'CREATE TABLE mcp_sessions (session_id TEXT PRIMARY KEY, app, agent_id, pid, started_at, ' +
        'beat_until, last_tool_at)',
    );
    db.exec('CREATE TABLE mcp_last_seen (app TEXT PRIMARY KEY, last_seen_at)');
    (live.sessions ?? []).forEach((s, i) => {
      db.prepare('INSERT INTO mcp_sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        s.id ?? `s${String(i)}`,
        s.app ?? 'codex',
        s.agentId ?? AGENT,
        'pid' in s ? s.pid : process.pid,
        s.startedAt ?? NOW - 5,
        s.beatUntil ?? NOW + 30,
        s.lastToolAt ?? null,
      );
    });
    for (const [app, at] of live.lastSeen ?? []) {
      db.prepare('INSERT INTO mcp_last_seen VALUES (?, ?)').run(app, at);
    }
  }
  db.close();
}

const deadPid = (): number => {
  const done = spawnSync(process.execPath, ['-e', '']);
  return done.pid;
};

describe('peekAgentStore (U3-c)', () => {
  it('counts active contacts; a live lease alone is not Running any more (D-143)', () => {
    seed(['active', 'active', 'removed', 'blocked', 'revoked'], NOW + 30);
    expect(peekAgentStore(path, NOW)).toEqual({
      contacts: 2,
      running: false,
      sessions: [],
      lastSeen: [],
    });
  });

  it('no lease row and no heartbeat tables (an older store) read as not Running', () => {
    seed(['active']);
    expect(peekAgentStore(path, NOW)).toEqual({
      contacts: 1,
      running: false,
      sessions: [],
      lastSeen: [],
    });
  });

  it('answers undefined for a missing or unreadable store and writes nothing', () => {
    expect(peekAgentStore(join(dir, 'missing.sqlite'), NOW)).toBeUndefined();
    const db = new Database(path);
    db.exec('CREATE TABLE other (x)');
    db.close();
    const before = readFileSync(path);
    expect(peekAgentStore(path, NOW)).toBeUndefined();
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});

describe('peekAgentStore: live MCP sessions (W4-LIVE-STATUS, 06 §6 "Read")', () => {
  it('a live row is Running, with its app id and times; never its pid or session id', () => {
    seed(['active'], undefined, {
      sessions: [
        { id: 'SESSION-SECRET', app: 'claude-code', startedAt: NOW - 50, lastToolAt: NOW - 3 },
      ],
      lastSeen: [['claude-code', NOW - 2]],
    });
    const peek = peekAgentStore(path, NOW);
    expect(peek).toEqual({
      contacts: 1,
      running: true,
      sessions: [{ app: 'claude-code', startedAt: NOW - 50, lastToolAt: NOW - 3 }],
      lastSeen: [{ app: 'claude-code', at: NOW - 2 }],
    });
    const text = JSON.stringify(peek);
    expect(text).not.toContain('SESSION-SECRET');
    expect(text).not.toContain(String(process.pid));
  });

  it('a second process on the same agent counts while the first holds the lease', () => {
    seed([], NOW + 30, {
      sessions: [
        { app: 'claude-code', pid: process.pid },
        { app: 'codex', pid: process.ppid },
      ],
    });
    expect(peekAgentStore(path, NOW)?.sessions.map((s) => s.app)).toEqual(['claude-code', 'codex']);
  });

  it('drops a row past its TTL, and one too far ahead (a clock that went back)', () => {
    seed([], undefined, {
      sessions: [
        { app: 'codex', beatUntil: NOW },
        { app: 'cursor', beatUntil: NOW + 91 },
        { app: 'windsurf', beatUntil: NOW + 90 },
      ],
    });
    expect(peekAgentStore(path, NOW)?.sessions.map((s) => s.app)).toEqual(['windsurf']);
  });

  it.each([
    ['0', 0],
    ['-1', -1],
    ['1', 1],
    ['1.5', 1.5],
    ["'4242'", '4242'],
    ['null', null],
    ['2^31', 2 ** 31],
  ])('a row with pid %s is not live', (_label, pid) => {
    seed([], undefined, { sessions: [{ app: 'codex', pid }] });
    expect(peekAgentStore(path, NOW)?.sessions).toEqual([]);
    expect(peekAgentStore(path, NOW)?.running).toBe(false);
  });

  it('a row whose process exited is not live (signal 0 only)', () => {
    seed([], undefined, { sessions: [{ app: 'codex', pid: deadPid() }] });
    expect(peekAgentStore(path, NOW)?.sessions).toEqual([]);
  });

  it('a killed process disappears at the next read', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    const pid = child.pid as number;
    seed([], undefined, { sessions: [{ app: 'claude-code', pid }] });
    expect(peekAgentStore(path, NOW)?.running).toBe(true);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
    expect(peekAgentStore(path, NOW)?.running).toBe(false);
  });

  it('ignores a row of another agent and maps an unknown app id to `other`', () => {
    seed([], undefined, {
      sessions: [
        { app: 'codex', agentId: `0x${'b'.repeat(40)}` },
        { app: 'CANARY-app </x>' },
        { app: 42 },
      ],
      lastSeen: [
        ['CANARY-seen', NOW - 9],
        ['codex', NOW - 10],
      ],
    });
    const peek = peekAgentStore(path, NOW);
    expect(peek?.sessions.map((s) => s.app)).toEqual(['other', 'other']);
    expect(peek?.lastSeen).toEqual([
      { app: 'codex', at: NOW - 10 },
      { app: 'other', at: NOW - 9 },
    ]);
    expect(JSON.stringify(peek)).not.toContain('CANARY');
  });

  it('odd times are not trusted: a bad start or beat drops the row, a bad tool time reads null', () => {
    seed([], undefined, {
      sessions: [
        { app: 'codex', startedAt: 'x' as unknown as number },
        { app: 'cursor', beatUntil: 'y' },
        { app: 'windsurf', lastToolAt: -5 },
      ],
      lastSeen: [['codex', 'y' as unknown as number]],
    });
    const peek = peekAgentStore(path, NOW);
    expect(peek?.sessions).toEqual([{ app: 'windsurf', startedAt: NOW - 5, lastToolAt: null }]);
    expect(peek?.lastSeen).toEqual([]);
  });
});

describe('pidAlive (04 §2.5 "The pid is used for one check only")', () => {
  it('sends signal 0 only, and only to an integer pid in 2..2^31-1', () => {
    const calls: [number, unknown][] = [];
    const kill = (pid: number, signal: unknown): true => {
      calls.push([pid, signal]);
      return true;
    };
    for (const pid of [0, -1, 1, 1.5, Number.NaN, 2 ** 31, '42', null, undefined]) {
      expect(pidAlive(pid, kill)).toBe(false);
    }
    expect(calls).toEqual([]);
    expect(pidAlive(2, kill)).toBe(true);
    expect(pidAlive(2 ** 31 - 1, kill)).toBe(true);
    expect(calls).toEqual([
      [2, 0],
      [2 ** 31 - 1, 0],
    ]);
  });

  it('EPERM means the process exists; ESRCH and anything else mean gone', () => {
    const throwing = (code: string) => () => {
      throw Object.assign(new Error('x'), { code });
    };
    expect(pidAlive(500, throwing('EPERM'))).toBe(true);
    expect(pidAlive(500, throwing('ESRCH'))).toBe(false);
    expect(pidAlive(500, throwing('EINVAL'))).toBe(false);
  });

  it('this process is alive and an exited child is not', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(deadPid())).toBe(false);
  });
});

// W4-PAUSE (D-143 (5); 07 §3.2 `agent_pause`; 08 §1 "Per agent state"): the Agents list and the live
// stream show `paused` from the pause row, read-only like the rest of the peek.
describe('peekAgentStore: the pause row (W4-PAUSE)', () => {
  function withPause(rows: number | 'no-table'): void {
    seed(['active'], undefined, { sessions: [] });
    const db = new Database(path);
    if (rows !== 'no-table') {
      db.exec('CREATE TABLE agent_pause (slot TEXT PRIMARY KEY, paused_at INTEGER)');
      for (let i = 0; i < rows; i += 1) {
        db.prepare('INSERT INTO agent_pause VALUES (?, ?)').run(`s${String(i)}`, NOW - 60);
      }
    }
    db.close();
  }

  it('a pause row reads as paused', () => {
    withPause(1);
    expect(peekAgentStore(path, NOW)?.paused).toBe(true);
  });

  it('no row, or a store from before the pause table, is not paused', () => {
    withPause(0);
    expect(peekAgentStore(path, NOW)?.paused).toBeUndefined();
    rmSync(path);
    withPause('no-table');
    expect(peekAgentStore(path, NOW)?.paused).toBeUndefined();
  });

  it('reading the pause row writes nothing', () => {
    withPause(1);
    const before = readFileSync(path);
    peekAgentStore(path, NOW);
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});
