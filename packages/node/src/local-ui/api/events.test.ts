// W4-LIVE-STATUS (D-143; 08 §1 `GET /api/ui/events`): the live event hub behind the stream. Changes
// only, allowlisted fields, `id: <boot>.<seq>` with a 64-event replay buffer for `Last-Event-ID`,
// `: ping` every 15 s, `retry: 2000`, at most 4 streams per page session and 8 in all, each closed
// after 30 min, when its session ends, when its reader falls 64 KiB behind and when the host stops.
// The gate in front of it (session, CSRF, Host, Origin, fetch metadata) is tested through the real
// server in events-server.test.ts.
import { describe, expect, it } from 'vitest';
import type { LiveAgentRecord } from '../live-status.js';
import { LIVE_EVENTS_LIMITS, LiveEvents, type LiveEventSink, type LiveSnapshot } from './events.js';

const NOW_MS = 1_800_000_000_000;

interface Parsed {
  readonly id?: string;
  readonly event?: string;
  readonly data?: Record<string, unknown>;
  readonly comment?: string;
  readonly retry?: string;
}

class Sink implements LiveEventSink {
  text = '';
  ended = false;
  buffered = 0;
  #onClose: (() => void) | undefined;
  write(chunk: string): void {
    if (this.ended) throw new Error('write after end');
    this.text += chunk;
  }
  end(): void {
    this.ended = true;
  }
  onClose(fn: () => void): void {
    this.#onClose = fn;
  }
  /** The reader went away. */
  drop(): void {
    this.#onClose?.();
  }
  /** Every block of the stream, parsed (data JSON-decoded). */
  blocks(): Parsed[] {
    return this.text
      .split('\n\n')
      .filter((b) => b !== '')
      .map((block) => {
        const out: Record<string, unknown> = {};
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) out['comment'] = line.slice(1).trim();
          else {
            const at = line.indexOf(': ');
            const key = line.slice(0, at);
            const value = line.slice(at + 2);
            out[key] = key === 'data' ? JSON.parse(value) : value;
          }
        }
        return out as Parsed;
      });
  }
  events(): Parsed[] {
    return this.blocks().filter((b) => b.event !== undefined);
  }
}

const agent = (name: string, over: Partial<LiveAgentRecord> = {}): LiveAgentRecord => ({
  name,
  label: name === 'default' ? 'Personal' : 'Work',
  current: name === 'default',
  removing: false,
  state: 'offline',
  apps: [],
  ...over,
});

function world() {
  let snapshot: LiveSnapshot = {
    generation: 1,
    current: 'default',
    agents: [agent('default'), agent('work')],
  };
  let ms = NOW_MS;
  let alive = new Set<string>(['s1', 's2', 's3']);
  let reads = 0;
  const hub = new LiveEvents({
    read: () => {
      reads += 1;
      return Promise.resolve(snapshot);
    },
    now: () => ms,
    sessionLive: (session) => alive.has(session),
    boot: () => 'BOOTboot',
    timers: { setInterval: () => 0, clearInterval: () => undefined },
  });
  return {
    hub,
    set(next: Partial<LiveSnapshot>) {
      snapshot = { ...snapshot, ...next };
    },
    advance(by: number) {
      ms += by;
    },
    end(session: string) {
      alive = new Set([...alive].filter((s) => s !== session));
    },
    get reads() {
      return reads;
    },
  };
}

const ALLOWED_TOP = ['generation', 'current', 'agents', 'gone', 'at'];
const ALLOWED_AGENT = ['name', 'label', 'current', 'removing', 'state', 'lastSeenAt', 'apps'];
const ALLOWED_APP = ['app', 'state', 'since', 'lastSeenAt'];

/** Every key of every event's data is on the allowlist (08 §1 "Allowlist"). */
function assertAllowlisted(sink: Sink): void {
  for (const e of sink.events()) {
    const data = e.data ?? {};
    for (const key of Object.keys(data)) expect(ALLOWED_TOP, key).toContain(key);
    for (const a of (data['agents'] as Record<string, unknown>[] | undefined) ?? []) {
      for (const key of Object.keys(a)) expect(ALLOWED_AGENT, key).toContain(key);
      for (const app of (a['apps'] as Record<string, unknown>[] | undefined) ?? []) {
        for (const key of Object.keys(app)) expect(ALLOWED_APP, key).toContain(key);
      }
    }
  }
}

describe('the live event hub (08 §1 GET /api/ui/events)', () => {
  it('uses the spec limits', () => {
    expect(LIVE_EVENTS_LIMITS).toEqual({
      readIntervalMs: 2_000,
      pingMs: 15_000,
      retryMs: 2_000,
      perSession: 4,
      total: 8,
      lifetimeMs: 1_800_000,
      backlogBytes: 65_536,
      replay: 64,
      maxLastEventIdLength: 32,
    });
  });

  it('starts every stream with retry and a snapshot of every agent', async () => {
    const w = world();
    const sink = new Sink();
    expect(await w.hub.open(sink, 's1')).toBe('ok');
    expect(sink.text.startsWith('retry: 2000\n')).toBe(true);
    const [first] = sink.events();
    expect(first).toEqual({
      id: 'BOOTboot.0',
      event: 'snapshot',
      data: {
        generation: 1,
        current: 'default',
        agents: [agent('default'), agent('work')],
        at: NOW_MS / 1000,
      },
    });
  });

  it('sends only changes: nothing when no allowlisted field moved', async () => {
    const w = world();
    const sink = new Sink();
    await w.hub.open(sink, 's1');
    await w.hub.tick();
    await w.hub.tick();
    expect(sink.events()).toHaveLength(1);
    w.set({
      agents: [
        agent('default', {
          state: 'working',
          apps: [{ app: 'claude-code', state: 'working', since: 1 }],
        }),
        agent('work'),
      ],
    });
    w.advance(2_000);
    await w.hub.tick();
    const events = sink.events();
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({
      id: 'BOOTboot.1',
      event: 'agents',
      data: {
        agents: [
          agent('default', {
            state: 'working',
            apps: [{ app: 'claude-code', state: 'working', since: 1 }],
          }),
        ],
        at: NOW_MS / 1000 + 2,
      },
    });
  });

  it('names agents no longer listed, and sends a generation event after a switch', async () => {
    const w = world();
    const sink = new Sink();
    await w.hub.open(sink, 's1');
    w.set({ generation: 2, current: 'work', agents: [agent('default', { current: false })] });
    await w.hub.tick();
    const events = sink.events().slice(1);
    expect(events.map((e) => e.event)).toEqual(['generation', 'agents']);
    expect(events[0]?.data).toEqual({ generation: 2, current: 'work', at: NOW_MS / 1000 });
    expect(events[1]?.data).toEqual({
      agents: [agent('default', { current: false })],
      gone: ['work'],
      at: NOW_MS / 1000,
    });
  });

  it('replays from Last-Event-ID while it is in the buffer; otherwise starts with a snapshot', async () => {
    const w = world();
    const a = new Sink();
    await w.hub.open(a, 's1');
    for (const state of ['ready', 'working', 'idle'] as const) {
      w.set({ agents: [agent('default', { state }), agent('work')] });
      await w.hub.tick();
    }
    const ids = a.events().map((e) => e.id);
    expect(ids).toEqual(['BOOTboot.0', 'BOOTboot.1', 'BOOTboot.2', 'BOOTboot.3']);
    a.drop();

    const replay = new Sink();
    await w.hub.open(replay, 's1', 'BOOTboot.1');
    expect(replay.events().map((e) => e.id)).toEqual(['BOOTboot.2', 'BOOTboot.3']);
    expect(replay.events().some((e) => e.event === 'snapshot')).toBe(false);

    const upToDate = new Sink();
    await w.hub.open(upToDate, 's1', 'BOOTboot.3');
    expect(upToDate.events()).toEqual([]);
    upToDate.drop();
    replay.drop();

    for (const unknown of [
      'OTHERboo.1',
      'BOOTboot.9',
      'BOOTboot.-1',
      'BOOTboot.01',
      'x'.repeat(33),
      'BOOTboot',
      '',
    ]) {
      const s = new Sink();
      await w.hub.open(s, 's2', unknown);
      expect(s.events()[0]?.event, unknown).toBe('snapshot');
      s.drop();
    }
  });

  it('keeps 64 events: an id older than the buffer gets a snapshot', async () => {
    const w = world();
    const a = new Sink();
    await w.hub.open(a, 's1');
    for (let i = 0; i < 70; i += 1) {
      w.set({ agents: [agent('default', { lastSeenAt: i }), agent('work')] });
      await w.hub.tick();
    }
    a.drop();
    const old = new Sink();
    await w.hub.open(old, 's1', 'BOOTboot.5');
    expect(old.events()[0]?.event).toBe('snapshot');
    old.drop();
    const recent = new Sink();
    await w.hub.open(recent, 's1', 'BOOTboot.6');
    expect(recent.events()).toHaveLength(64);
    expect(recent.events()[0]?.id).toBe('BOOTboot.7');
  });

  it('refuses a 5th stream of one session and a 9th in all with busy', async () => {
    const w = world();
    const sinks: Sink[] = [];
    for (let i = 0; i < 4; i += 1) {
      const s = new Sink();
      sinks.push(s);
      expect(await w.hub.open(s, 's1')).toBe('ok');
    }
    expect(await w.hub.open(new Sink(), 's1')).toBe('busy');
    for (let i = 0; i < 4; i += 1) {
      const s = new Sink();
      sinks.push(s);
      expect(await w.hub.open(s, 's2')).toBe('ok');
    }
    expect(await w.hub.open(new Sink(), 's3')).toBe('busy');
    expect(w.hub.size).toBe(8);
    sinks[0]?.drop();
    expect(w.hub.size).toBe(7);
    expect(await w.hub.open(new Sink(), 's3')).toBe('ok');
  });

  it('pings every 15 s', async () => {
    const w = world();
    const sink = new Sink();
    await w.hub.open(sink, 's1');
    w.advance(14_000);
    await w.hub.tick();
    expect(sink.blocks().filter((b) => b.comment === 'ping')).toHaveLength(0);
    w.advance(1_000);
    await w.hub.tick();
    expect(sink.blocks().filter((b) => b.comment === 'ping')).toHaveLength(1);
  });

  it('ends a stream after 30 min, when its session ends, and on close', async () => {
    const w = world();
    const old = new Sink();
    await w.hub.open(old, 's1');
    w.advance(1_000_000);
    const young = new Sink();
    await w.hub.open(young, 's1');
    const other = new Sink();
    await w.hub.open(other, 's2');
    w.advance(800_000);
    await w.hub.tick();
    expect(old.ended).toBe(true);
    expect(young.ended).toBe(false);
    w.end('s2');
    await w.hub.tick();
    expect(other.ended).toBe(true);
    expect(young.ended).toBe(false);
    w.hub.close();
    expect(young.ended).toBe(true);
    expect(w.hub.size).toBe(0);
    expect(await w.hub.open(new Sink(), 's1')).toBe('busy');
  });

  it('closes a stream whose reader falls more than 64 KiB behind', async () => {
    const w = world();
    const slow = new Sink();
    await w.hub.open(slow, 's1');
    slow.buffered = 65_537;
    w.set({ agents: [agent('default', { state: 'ready' }), agent('work')] });
    await w.hub.tick();
    expect(slow.ended).toBe(true);
    expect(w.hub.size).toBe(0);
  });

  it('reads only while a stream is open', async () => {
    const w = world();
    await w.hub.tick();
    expect(w.reads).toBe(0);
    const s = new Sink();
    await w.hub.open(s, 's1');
    expect(w.reads).toBe(1);
    s.drop();
    await w.hub.tick();
    expect(w.reads).toBe(1);
  });

  it('carries only allowlisted fields, whatever the read returns (snapshot test of every event)', async () => {
    const w = world();
    const sink = new Sink();
    const leaky = (name: string) =>
      ({
        ...agent(name, {
          state: 'ready',
          lastSeenAt: 5,
          apps: [
            {
              app: 'codex',
              state: 'ready',
              since: 4,
              pid: 4242,
              sessionId: 'SESSION',
              clientInfo: 'CANARY-CLIENT',
            } as never,
          ],
        }),
        path: '/Users/me/.agentlink/agents/default',
        agentId: '0xabc',
        holder: 'HOLDER',
        pid: 4242,
        contacts: 3,
      }) as LiveAgentRecord;
    w.set({ agents: [leaky('default'), agent('work')] });
    await w.hub.open(sink, 's1');
    w.set({ agents: [leaky('default'), agent('work', { state: 'idle' })], generation: 2 });
    await w.hub.tick();
    expect(sink.events().map((e) => e.event)).toEqual(['snapshot', 'generation', 'agents']);
    assertAllowlisted(sink);
    for (const secret of ['/Users', '0xabc', 'HOLDER', '4242', 'SESSION', 'CANARY']) {
      expect(sink.text).not.toContain(secret);
    }
  });

  it('a busy open drives no host read, and opens waiting on a read hold their slot', async () => {
    let reads = 0;
    let release: () => void = () => undefined;
    const hub = new LiveEvents({
      read: () => {
        reads += 1;
        return new Promise((resolve) => {
          release = () => {
            resolve({ generation: 1, current: 'default', agents: [agent('default')] });
          };
        });
      },
      now: () => NOW_MS,
      sessionLive: () => true,
      boot: () => 'BOOTboot',
      timers: { setInterval: () => 0, clearInterval: () => undefined },
    });
    // Ten opens of one session while the first read is pending: only 4 can ever be taken.
    const opens = Array.from({ length: 10 }, () => hub.open(new Sink(), 's1'));
    await Promise.resolve();
    release();
    const results = await Promise.all(opens);
    expect(results.filter((r) => r === 'ok')).toHaveLength(4);
    expect(reads).toBe(1);
    // Full: further opens answer busy before any read.
    expect(await hub.open(new Sink(), 's1')).toBe('busy');
    expect(reads).toBe(1);
  });

  it('a reader that left while its open waited for the read frees its slot at once', async () => {
    const w = world();
    const gone = new Sink();
    let left = false;
    gone.onClose = (fn) => {
      if (left) fn();
    };
    left = true;
    expect(await w.hub.open(gone, 's1')).toBe('ok');
    expect(w.hub.size).toBe(0);
  });
});
