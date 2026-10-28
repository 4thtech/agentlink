// U3-c (08 §1): the page's generation guard. Every same-origin change carries the page's generation;
// an answer with another one reloads the page once; outside the app host nothing is wrapped.
import { describe, expect, it } from 'vitest';
import { GENERATION_HEADER, generationGuard, pageGeneration } from './generation.js';

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
