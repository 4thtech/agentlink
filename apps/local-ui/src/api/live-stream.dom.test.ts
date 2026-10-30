// @vitest-environment jsdom
// W4-SHELL-LIVE (U1-b; D-143, 08 §1 "Live AI-app status" and `GET /api/ui/events`): the one shared
// live subscription reads K1's events stream with `fetch` (the CSRF header, Accept
// text/event-stream, Last-Event-ID), so the owner's bug is gone: quitting or starting Claude Code
// shows in the app within the stream's ~2 s, with no reload and no 5 s poll. It reconnects with
// backoff (1 s doubling to 30 s, jitter) and replays from the last ID; after three failures within a
// minute, or without a streamed body, it polls `GET /api/ui/agents` every 5 s while the tab is
// visible and tries the stream again every 60 s.
import {
  EVENTS_ACCEPT,
  EVENTS_PATH,
  LIVE_SAMPLE,
  type LiveAgentRecord,
} from '@4thtech-io/types/ui-contract/live';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIVE_POLL_MS,
  LIVE_STREAM_RETRY_MS,
  agoText,
  createSseParser,
  getLive,
  LIVE_ANSWER_MS,
  liveMode,
  resetLiveForTests,
  subscribeLive,
} from './live.js';

const NOW = 1_800_000_200;

interface Stream {
  readonly headers: Headers;
  push(text: string): void;
  end(): void;
}

interface Server {
  /** How each events request is answered: a stream, a status, a thrown error, no body, or never. */
  events: 'stream' | number | 'throw' | 'no-body' | 'hang';
  readonly streams: Stream[];
  agentReads: number;
  generation: number;
  records: LiveAgentRecord[];
  readonly requests: string[];
}

const record = (over: Partial<LiveAgentRecord> = {}): LiveAgentRecord => ({
  name: 'default',
  label: 'Personal',
  current: true,
  removing: false,
  state: 'ready',
  apps: [{ app: 'claude-code', state: 'ready', since: NOW - 60 }],
  ...over,
});

function serve(over: Partial<Server> = {}): Server {
  const s: Server = {
    events: 'stream',
    streams: [],
    agentReads: 0,
    generation: 1,
    records: [record()],
    requests: [],
    ...over,
  };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : String(input), 'http://localhost');
    s.requests.push(url.pathname);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'X-AgentLink-Generation': String(s.generation) },
      });
    if (url.pathname === '/api/ui/agents') {
      s.agentReads += 1;
      return json({
        switchable: true,
        generation: s.generation,
        current: 'default',
        label: 'Personal',
        agents: s.records.map((r) => ({
          ...r,
          labelled: true,
          available: true,
          contacts: 1,
          running: r.state === 'working' || r.state === 'ready' || r.state === 'idle',
        })),
      });
    }
    if (url.pathname === '/api/ui/apps') {
      return json({ desktopRunning: false, apps: [{ app: 'claude-code', name: 'Claude Code' }] });
    }
    if (url.pathname === EVENTS_PATH) {
      if (s.events === 'throw') throw new TypeError('network');
      if (typeof s.events === 'number') return json({ error: 'busy' }, s.events);
      if (s.events === 'no-body') return new Response(null, { status: 200 });
      if (s.events === 'hang') {
        return new Promise<Response>((_, fail) => {
          init?.signal?.addEventListener('abort', () => {
            fail(new DOMException('aborted', 'AbortError'));
          });
        });
      }
      const encoder = new TextEncoder();
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      init?.signal?.addEventListener('abort', () => {
        try {
          controller.error(new DOMException('aborted', 'AbortError'));
        } catch {
          /* closed */
        }
      });
      s.streams.push({
        headers: new Headers(init?.headers),
        push: (text) => controller.enqueue(encoder.encode(text)),
        end: () => controller.close(),
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': EVENTS_ACCEPT, 'X-AgentLink-Generation': String(s.generation) },
      });
    }
    return json({}, 404);
  });
  return s;
}

const block = (id: string, event: string, data: unknown): string =>
  `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

async function flush(ms = 0): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

let changed = 0;
const onChanged = (): void => {
  changed += 1;
};

beforeEach(() => {
  vi.useFakeTimers({ now: NOW * 1000 });
  resetLiveForTests();
  changed = 0;
  window.addEventListener('agentlink:agents-changed', onChanged);
  document.head.innerHTML = '<meta name="agentlink-csrf" content="page-token" />';
});
afterEach(() => {
  window.removeEventListener('agentlink:agents-changed', onChanged);
  resetLiveForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the events stream format (08 §1)', () => {
  it('parses the shared sample into its events, comments and retry ignored', () => {
    const out: { id: string; event: string; data: unknown }[] = [];
    const parser = createSseParser((e) => out.push({ id: e.id, event: e.event, data: e.data }));
    // Split anywhere, also inside a line and a UTF-8 sequence's text: the parser buffers.
    const text = LIVE_SAMPLE.text;
    parser.push(text.slice(0, 37));
    parser.push(text.slice(37, 200));
    parser.push(text.slice(200));
    expect(out).toEqual(LIVE_SAMPLE.events.map((e) => ({ ...e })));
  });

  it('reads CRLF lines and skips a block whose data is not JSON', () => {
    const out: string[] = [];
    const parser = createSseParser((e) => out.push(e.event));
    parser.push('id: A.1\r\nevent: agents\r\ndata: {not json\r\n\r\n');
    parser.push(
      'id: A.2\r\nevent: generation\r\ndata: {"generation":2,"current":null,"at":1}\r\n\r\n',
    );
    expect(out).toEqual(['generation']);
  });
});

describe('relative times ("5 min ago")', () => {
  it('says just now, minutes, hours and days', () => {
    expect(agoText(NOW - 20, NOW)).toBe('just now');
    expect(agoText(NOW - 5 * 60, NOW)).toBe('5 min ago');
    expect(agoText(NOW - 3 * 3600, NOW)).toBe('3 h ago');
    expect(agoText(NOW - 86_400, NOW)).toBe('1 day ago');
    expect(agoText(NOW - 4 * 86_400, NOW)).toBe('4 days ago');
  });
});

describe('the shared live subscription over the events stream', () => {
  it("the owner's bug: an AI app that quits shows Not running at once, one that starts shows Working, with no reload and no poll", async () => {
    const s = serve();
    const stop = subscribeLive(() => undefined);
    await flush();
    expect(s.streams).toHaveLength(1);
    const headers = s.streams[0]?.headers;
    expect(headers?.get('X-AgentLink-CSRF')).toBe('page-token');
    expect(headers?.get('Accept')).toBe(EVENTS_ACCEPT);
    expect(headers?.get('Last-Event-ID')).toBeNull();
    expect(liveMode()).toBe('stream');
    s.streams[0]?.push(
      block('B.0', 'snapshot', { generation: 1, current: 'default', agents: [record()], at: NOW }),
    );
    await flush();
    expect(getLive().agents[0]?.statusText).toBe('Ready in Claude Code');
    const reads = s.agentReads;

    // Claude Code quits.
    s.streams[0]?.push(
      block('B.1', 'agents', {
        agents: [
          record({
            state: 'offline',
            lastSeenAt: NOW - 5,
            apps: [
              { app: 'claude-code', state: 'not_running', since: NOW - 5, lastSeenAt: NOW - 5 },
            ],
          }),
        ],
        at: NOW,
      }),
    );
    await flush();
    const quit = getLive().agents[0];
    expect(quit?.apps.map((a) => `${a.app}: ${a.word}`)).toEqual([
      'Claude Code: Not running · last seen just now',
    ]);
    expect(quit?.statusText).toBe('Offline · last seen just now');
    expect(quit?.state).toBe('off');
    expect(changed).toBeGreaterThanOrEqual(1);

    // It starts again and works.
    s.streams[0]?.push(
      block('B.2', 'agents', {
        agents: [
          record({
            state: 'working',
            apps: [{ app: 'claude-code', state: 'working', since: NOW }],
          }),
        ],
        at: NOW,
      }),
    );
    await flush();
    expect(getLive().agents[0]?.statusText).toBe('Working in Claude Code');
    expect(getLive().agents[0]?.apps[0]?.state).toBe('working');
    // Nothing polled: the stream carried both changes.
    await flush(LIVE_POLL_MS * 3);
    expect(s.agentReads).toBe(reads);
    stop();
  });

  it('one shared stream however many views listen; the last one closes it', async () => {
    const s = serve();
    const a = subscribeLive(() => undefined);
    const b = subscribeLive(() => undefined);
    await flush();
    expect(s.streams).toHaveLength(1);
    a();
    b();
    expect(liveMode()).toBe('idle');
  });

  it('a gone agent leaves; another app reads "Another AI app"; unknown events are ignored', async () => {
    const s = serve({
      records: [record(), record({ name: 'work', label: 'Work', current: false })],
    });
    subscribeLive(() => undefined);
    await flush();
    s.streams[0]?.push(': ping\n\n');
    s.streams[0]?.push(block('B.1', 'mystery', { x: 1 }));
    s.streams[0]?.push(
      block('B.2', 'agents', {
        agents: [record({ state: 'ready', apps: [{ app: 'other', state: 'ready', since: NOW }] })],
        gone: ['work'],
        at: NOW,
      }),
    );
    await flush();
    expect(getLive().agents.map((a) => a.name)).toEqual(['default']);
    expect(getLive().agents[0]?.statusText).toBe('Ready in Another AI app');
  });

  it('a generation event re-reads the agents once (the generation guard sees the switch)', async () => {
    const s = serve();
    subscribeLive(() => undefined);
    await flush();
    const reads = s.agentReads;
    s.generation = 2;
    s.streams[0]?.push(block('B.1', 'generation', { generation: 2, current: 'default', at: NOW }));
    await flush();
    expect(s.agentReads).toBe(reads + 1);
    expect(getLive().list?.generation).toBe(2);
  });

  it('another view announcing a change (an agent added here) reads the list at once, stream or not', async () => {
    const s = serve();
    subscribeLive(() => undefined);
    await flush();
    const reads = s.agentReads;
    s.records = [record(), record({ name: 'side', label: 'Side project', current: false })];
    window.dispatchEvent(new Event('agentlink:agents-changed'));
    await flush();
    expect(s.agentReads).toBe(reads + 1);
    expect(getLive().agents.map((a) => a.label)).toEqual(['Personal', 'Side project']);
  });

  it('a read asked for while one is in flight runs after it (IR-1 L1)', async () => {
    const s = serve();
    subscribeLive(() => undefined);
    await flush();
    const reads = s.agentReads;
    // Two announcements in one turn: the second arrives while the first read is in flight.
    window.dispatchEvent(new Event('agentlink:agents-changed'));
    s.records = [record(), record({ name: 'side', label: 'Side project', current: false })];
    window.dispatchEvent(new Event('agentlink:agents-changed'));
    await flush();
    await flush();
    expect(s.agentReads).toBe(reads + 2);
    expect(getLive().list?.agents.map((a) => a.name)).toEqual(['default', 'side']);
  });

  it('an agent that arrives only on the stream reaches the list (IR-1 L2)', async () => {
    const s = serve();
    subscribeLive(() => undefined);
    await flush();
    const reads = s.agentReads;
    s.records = [record(), record({ name: 'side', label: 'Side project', current: false })];
    s.streams[0]?.push(
      block('B.1', 'agents', {
        agents: [record({ name: 'side', label: 'Side project', current: false })],
        at: NOW,
      }),
    );
    await flush();
    expect(s.agentReads).toBe(reads + 1);
    expect(getLive().list?.agents.map((a) => a.name)).toEqual(['default', 'side']);
    // A known agent's change reads nothing.
    s.streams[0]?.push(block('B.2', 'agents', { agents: [record()], at: NOW }));
    await flush();
    expect(s.agentReads).toBe(reads + 1);
  });

  it('reconnects with Last-Event-ID after the stream ends and applies the replay', async () => {
    const s = serve();
    subscribeLive(() => undefined);
    await flush();
    s.streams[0]?.push(block('B.7', 'agents', { agents: [record()], at: NOW }));
    await flush();
    s.streams[0]?.end();
    await flush(1_300);
    expect(s.streams).toHaveLength(2);
    expect(s.streams[1]?.headers.get('Last-Event-ID')).toBe('B.7');
    s.streams[1]?.push(
      block('B.8', 'agents', {
        agents: [
          record({ state: 'idle', apps: [{ app: 'claude-code', state: 'idle', since: NOW }] }),
        ],
        at: NOW,
      }),
    );
    await flush();
    expect(getLive().agents[0]?.statusText).toBe('Idle');
    expect(liveMode()).toBe('stream');
  });

  it('backs off 1 s, then 2 s, between failed tries (with jitter)', async () => {
    const s = serve({ events: 'throw' });
    subscribeLive(() => undefined, { random: () => 0.5 });
    await flush();
    const tries = (): number => s.requests.filter((p) => p === EVENTS_PATH).length;
    expect(tries()).toBe(1);
    await flush(900);
    expect(tries()).toBe(1);
    await flush(200);
    expect(tries()).toBe(2);
    await flush(1_800);
    expect(tries()).toBe(2);
    await flush(300);
    expect(tries()).toBe(3);
  });

  it('after three failures within a minute it polls every 5 s and tries the stream again after 60 s', async () => {
    const s = serve({ events: 500 });
    subscribeLive(() => undefined, { random: () => 0.5 });
    await flush(4_000);
    expect(liveMode()).toBe('poll');
    const reads = s.agentReads;
    await flush(LIVE_POLL_MS + 10);
    expect(s.agentReads).toBe(reads + 1);
    // The stream works again: the 60 s retry finds it and the polling stops.
    s.events = 'stream';
    await flush(LIVE_STREAM_RETRY_MS);
    expect(liveMode()).toBe('stream');
    const after = s.agentReads;
    await flush(LIVE_POLL_MS * 2);
    expect(s.agentReads).toBe(after);
  });

  it('without a streamed body it polls at once; a hidden tab does not poll', async () => {
    const s = serve({ events: 'no-body' });
    subscribeLive(() => undefined);
    await flush();
    expect(liveMode()).toBe('poll');
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    const hidden = s.agentReads;
    await flush(LIVE_POLL_MS * 3);
    expect(s.agentReads).toBe(hidden);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(s.agentReads).toBe(hidden + 1);
  });

  // W4-WIRE-3 (owner walkthrough 30 Oct): a stream that never answers (the host dropped it before its
  // first byte) is given up after LIVE_ANSWER_MS and counts as a failure, so the page falls back to
  // polling instead of keeping the status it loaded with.
  it('a stream that never answers is a failure after LIVE_ANSWER_MS; three of them fall back to polling', async () => {
    const s = serve({ events: 'hang' });
    subscribeLive(() => undefined, { random: () => 0.5 });
    await flush();
    const tries = (): number => s.requests.filter((p) => p === EVENTS_PATH).length;
    expect(tries()).toBe(1);
    await flush(LIVE_ANSWER_MS - 100);
    expect(tries()).toBe(1);
    await flush(100 + 1_000);
    expect(tries()).toBe(2);
    await flush(LIVE_ANSWER_MS * 2 + 3_000);
    expect(liveMode()).toBe('poll');
    const reads = s.agentReads;
    await flush(LIVE_POLL_MS + 10);
    expect(s.agentReads).toBe(reads + 1);
  });

  it('a busy answer (429) polls instead of retrying at once', async () => {
    const s = serve({ events: 429 });
    subscribeLive(() => undefined);
    await flush();
    expect(liveMode()).toBe('poll');
    expect(s.requests.filter((p) => p === EVENTS_PATH)).toHaveLength(1);
  });
});
