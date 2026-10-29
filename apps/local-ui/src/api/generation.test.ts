// U3-c (08 §1): the page's generation guard. Every same-origin change carries the page's generation;
// an answer with another one reloads the page once; outside the app host nothing is wrapped.
import { describe, expect, it } from 'vitest';
import {
  ADOPTED_HEADER,
  GENERATION_HEADER,
  generationGuard,
  pageGeneration,
} from './generation.js';

const ORIGIN = 'http://localhost:4123';

function setup(generation: string | undefined, answer = '1') {
  const sent: { url: string; method: string; generation: string | null }[] = [];
  let reloads = 0;
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
    reload: () => {
      reloads += 1;
    },
  });
  return { guarded, sent, reloads: () => reloads };
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

  it('reloads once when an answer carries another generation (a switch here or in another tab)', async () => {
    const same = setup('2', '2');
    await same.guarded?.('/api/ui/health');
    expect(same.reloads()).toBe(0);
    const other = setup('2', '3');
    await other.guarded?.('/api/ui/health');
    await other.guarded?.('/api/ui/health');
    expect(other.reloads()).toBe(1);
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
// reloading (the one-time backup code stays on screen); every other mismatch still reloads.
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
    let reloads = 0;
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
      reload: () => {
        reloads += 1;
      },
    });
    if (guarded === undefined) throw new Error('not wrapped');
    return { guarded, sent, reloads: () => reloads };
  }

  it('a marked successful finish adopts the new generation; later changes carry it', async () => {
    const g = scripted('1', (url) =>
      url === FINISH ? { generation: '2', adopted: true } : { generation: '2' },
    );
    await g.guarded(FINISH, { method: 'POST' });
    expect(g.reloads()).toBe(0);
    await g.guarded('/api/ui/apps/apply', { method: 'POST' });
    await g.guarded('/api/ui/health');
    expect(g.reloads()).toBe(0);
    expect(g.sent[1]).toEqual({ url: '/api/ui/apps/apply', method: 'POST', generation: '2' });
  });

  it.each([
    ['the marker on another route', '/api/ui/agents', 'POST', 200],
    ['the marker on a read', '/api/ui/health', 'GET', 200],
    ['the marker on a GET of the finish path', FINISH, 'GET', 200],
    ['the marker on a refused finish', FINISH, 'POST', 409],
  ] as const)('%s is ignored: the page reloads', async (_why, path, method, status) => {
    const g = scripted('1', () => ({ generation: '2', adopted: true, status }));
    await g.guarded(path, { method });
    expect(g.reloads()).toBe(1);
  });

  it('a finish with a new generation and no marker reloads', async () => {
    const g = scripted('1', () => ({ generation: '2' }));
    await g.guarded(FINISH, { method: 'POST' });
    expect(g.reloads()).toBe(1);
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
    expect(g.reloads()).toBe(0);
    release();
    await finish;
    expect(g.reloads()).toBe(0);
  });

  it('a read with another generation during finish still reloads when finish adopts none', async () => {
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
    expect(g.reloads()).toBe(1);
  });
});
