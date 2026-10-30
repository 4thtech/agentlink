// U3-c (08 §1): the page's generation guard. Every same-origin change carries the page's generation;
// an answer with another one refreshes the page in place (W4-SHELL: no reload); outside the app host nothing is wrapped.
import { describe, expect, it } from 'vitest';
import {
  ADOPTED_HEADER,
  GENERATION_HEADER,
  generationGuard,
  installGenerationGuard,
  onAgentChanged,
  pageGeneration,
} from './generation.js';

const ORIGIN = 'http://localhost:4123';

function setup(generation: string | undefined, answer = '1') {
  const sent: { url: string; method: string; generation: string | null }[] = [];
  let changes = 0;
  const base = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    sent.push({
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      generation: new Headers(init?.headers).get(GENERATION_HEADER),
    });
    return Promise.resolve(new Response('{}', { headers: { [GENERATION_HEADER]: answer } }));
  }) as typeof fetch;
  const guarded = generationGuard({
    generation,
    origin: ORIGIN,
    fetch: base,
    onChange: () => {
      changes += 1;
    },
  });
  return { guarded, sent, changes: () => changes };
}

describe('generationGuard (U3-c)', () => {
  it('wraps nothing outside the app host', () => {
    expect(setup(undefined).guarded).toBeUndefined();
    expect(setup('0').guarded).toBeUndefined();
    expect(setup('x').guarded).toBeUndefined();
  });

  it('adds the generation to same-origin changes only, keeping the other headers', async () => {
    const { guarded, sent } = setup('3', '3');
    if (guarded === undefined) throw new Error('not wrapped');
    await guarded('/api/ui/rules', {
      method: 'POST',
      headers: { 'X-AgentLink-CSRF': 't', 'Content-Type': 'application/octet-stream' },
    });
    await guarded('/api/ui/agents');
    await guarded('https://example.com/x', { method: 'POST' });
    expect(sent).toEqual([
      { url: '/api/ui/rules', method: 'POST', generation: '3' },
      { url: '/api/ui/agents', method: 'GET', generation: null },
      { url: 'https://example.com/x', method: 'POST', generation: null },
    ]);
  });

  it('announces the change once when an answer carries another generation (a switch here or in another tab)', async () => {
    const same = setup('2', '2');
    await same.guarded?.('/api/ui/health');
    expect(same.changes()).toBe(0);
    const other = setup('2', '3');
    await other.guarded?.('/api/ui/health');
    await other.guarded?.('/api/ui/health');
    expect(other.changes()).toBe(1);
  });

  it('reads the meta tag only in its exact form', () => {
    const doc = (content: string | null) =>
      ({
        querySelector: () => (content === null ? null : { getAttribute: () => content }),
      }) as unknown as Document;
    expect(pageGeneration(doc('4'))).toBe('4');
    expect(pageGeneration(doc(null))).toBeUndefined();
    expect(pageGeneration(doc(''))).toBeUndefined();
    expect(pageGeneration(doc('4"><script>'))).toBeUndefined();
  });
});

// U3-g-b (IR-U3-g-b-1 H-1): first run with no agent yet opens the first agent in the same host, so
// the successful setup `finish` answer carries a new generation. Only that answer, marked by the
// server with `X-AgentLink-Generation-Adopted: 1`, makes the page adopt the new generation instead of
// refreshing (the one-time backup code stays on screen); every other mismatch still refreshes.
describe('generationGuard adopts the first agent after first run (U3-g-b)', () => {
  const FINISH = '/api/ui/first-run/owner/finish';
  interface Answer {
    readonly generation: string;
    readonly status?: number;
    readonly adopted?: boolean;
    /** Resolved later by the test (a request still in flight). */
    readonly hold?: Promise<void>;
  }

  function scripted(generation: string, answers: (url: string, method: string) => Answer) {
    const sent: { url: string; method: string; generation: string | null }[] = [];
    let changes = 0;
    const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      sent.push({ url, method, generation: new Headers(init?.headers).get(GENERATION_HEADER) });
      const a = answers(url, method);
      await a.hold;
      return new Response('{}', {
        status: a.status ?? 200,
        headers: {
          [GENERATION_HEADER]: a.generation,
          ...(a.adopted === true ? { [ADOPTED_HEADER]: '1' } : {}),
        },
      });
    }) as typeof fetch;
    const guarded = generationGuard({
      generation,
      origin: ORIGIN,
      fetch: base,
      onChange: () => {
        changes += 1;
      },
    });
    if (guarded === undefined) throw new Error('not wrapped');
    return { guarded, sent, changes: () => changes };
  }

  it('a marked successful finish adopts the new generation; later changes carry it', async () => {
    const g = scripted('1', (url) =>
      url === FINISH ? { generation: '2', adopted: true } : { generation: '2' },
    );
    await g.guarded(FINISH, { method: 'POST' });
    expect(g.changes()).toBe(0);
    await g.guarded('/api/ui/apps/apply', { method: 'POST' });
    await g.guarded('/api/ui/health');
    expect(g.changes()).toBe(0);
    expect(g.sent[1]).toEqual({ url: '/api/ui/apps/apply', method: 'POST', generation: '2' });
  });

  it.each([
    ['the marker on another route', '/api/ui/agents', 'POST', 200],
    ['the marker on a read', '/api/ui/health', 'GET', 200],
    ['the marker on a GET of the finish path', FINISH, 'GET', 200],
    ['the marker on a refused finish', FINISH, 'POST', 409],
  ] as const)('%s is ignored: the page refreshes', async (_why, path, method, status) => {
    const g = scripted('1', () => ({ generation: '2', adopted: true, status }));
    await g.guarded(path, { method });
    expect(g.changes()).toBe(1);
  });

  it('a finish with a new generation and no marker refreshes', async () => {
    const g = scripted('1', () => ({ generation: '2' }));
    await g.guarded(FINISH, { method: 'POST' });
    expect(g.changes()).toBe(1);
  });

  it('a cross-origin answer with the marker changes nothing', async () => {
    const g = scripted('1', () => ({ generation: '2', adopted: true }));
    await g.guarded(`https://example.com${FINISH}`, { method: 'POST' });
    await g.guarded('/api/ui/rules', { method: 'POST' });
    expect(g.sent[1]?.generation).toBe('1');
  });

  it('a read answered with the new generation while finish is in flight waits for the finish', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const g = scripted('1', (url) =>
      url === FINISH ? { generation: '2', adopted: true, hold } : { generation: '2' },
    );
    const finish = g.guarded(FINISH, { method: 'POST' });
    await g.guarded('/api/ui/health');
    expect(g.changes()).toBe(0);
    release();
    await finish;
    expect(g.changes()).toBe(0);
  });

  it('a read with another generation during finish still refreshes when finish adopts none', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const g = scripted('1', (url) =>
      url === FINISH ? { generation: '1', status: 409, hold } : { generation: '5' },
    );
    const finish = g.guarded(FINISH, { method: 'POST' });
    await g.guarded('/api/ui/health');
    release();
    await finish;
    expect(g.changes()).toBe(1);
  });
});

// W4-SHELL (WAVE-4 build plan §0.4, b11 §29.1): a switch never reloads the page. The guard tells the
// app (onChange) and fences: until the app has swapped its views and calls `adopt`, every change
// still carries the OLD generation, so a view of the agent you left can never act on the new one
// (the server refuses it with `agent_changed`). Only then do changes carry the new generation.
describe('generationGuard soft change (W4-SHELL)', () => {
  function fenced(answer: { current: string }) {
    const sent: (string | null)[] = [];
    const changes: { next: string; adopt: () => void }[] = [];
    const base = ((_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get(GENERATION_HEADER));
      return Promise.resolve(
        new Response('{}', { headers: { [GENERATION_HEADER]: answer.current } }),
      );
    }) as typeof fetch;
    const guarded = generationGuard({
      generation: '4',
      origin: ORIGIN,
      fetch: base,
      onChange: (next, adopt) => changes.push({ next, adopt }),
    });
    if (guarded === undefined) throw new Error('not wrapped');
    return { guarded, sent, changes };
  }

  it('announces the new generation once, however many answers carry it', async () => {
    const g = fenced({ current: '5' });
    await g.guarded('/api/ui/health');
    await g.guarded('/api/ui/agents');
    expect(g.changes.map((c) => c.next)).toEqual(['5']);
  });

  it('keeps sending the old generation until the app adopts the new one', async () => {
    const g = fenced({ current: '5' });
    await g.guarded('/api/ui/agents/switch', { method: 'POST' });
    await g.guarded('/api/ui/rules', { method: 'POST' });
    expect(g.sent).toEqual(['4', '4']);
    g.changes[0]?.adopt();
    await g.guarded('/api/ui/rules', { method: 'POST' });
    expect(g.sent[2]).toBe('5');
  });

  it('a newer change before adopt supersedes the older one (its adopt does nothing)', async () => {
    const answer = { current: '5' };
    const g = fenced(answer);
    await g.guarded('/api/ui/health');
    answer.current = '6';
    await g.guarded('/api/ui/health');
    expect(g.changes.map((c) => c.next)).toEqual(['5', '6']);
    g.changes[0]?.adopt();
    await g.guarded('/api/ui/rules', { method: 'POST' });
    expect(g.sent.at(-1)).toBe('4');
    g.changes[1]?.adopt();
    await g.guarded('/api/ui/rules', { method: 'POST' });
    expect(g.sent.at(-1)).toBe('6');
  });

  it('after adopt, the same generation is quiet and a later one is announced again', async () => {
    const answer = { current: '5' };
    const g = fenced(answer);
    await g.guarded('/api/ui/health');
    g.changes[0]?.adopt();
    await g.guarded('/api/ui/health');
    expect(g.changes).toHaveLength(1);
    answer.current = '7';
    await g.guarded('/api/ui/health');
    expect(g.changes.map((c) => c.next)).toEqual(['5', '7']);
  });
});

describe('installGenerationGuard (W4-SHELL)', () => {
  it('hands a change to the app in place; reloads only when nothing in the app listens', async () => {
    let reloads = 0;
    let answer = '2';
    const win = {
      document: { querySelector: () => ({ getAttribute: () => '1' }) },
      location: {
        origin: ORIGIN,
        reload: () => {
          reloads += 1;
        },
      },
      fetch: () =>
        Promise.resolve(new Response('{}', { headers: { [GENERATION_HEADER]: answer } })),
    } as unknown as Window;
    installGenerationGuard(win);
    const seen: string[] = [];
    const stop = onAgentChanged((next, adopt) => {
      seen.push(next);
      adopt();
    });
    await win.fetch('/api/ui/health');
    expect(seen).toEqual(['2']);
    expect(reloads).toBe(0);
    stop();
    answer = '3';
    await win.fetch('/api/ui/health');
    expect(reloads).toBe(1);
  });
});
