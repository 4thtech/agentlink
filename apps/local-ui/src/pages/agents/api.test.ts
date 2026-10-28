// U3-h: the Agents requests. The switch carries {name, generation} (a number); owner operations send
// the proof as the body, the input in X-AgentLink-Input and the generation; a stub answers 501.
import { describe, expect, it } from 'vitest';
import { createAgentsApi } from './api.js';

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}
function api(status: number, body: unknown) {
  const seen: Seen[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = init?.body;
    seen.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: raw === undefined || raw === null ? '' : ArrayBuffer.isView(raw) ? new TextDecoder().decode(raw) : String(raw),
    });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { seen, agents: createAgentsApi({ fetch: fetchFn, token: 't' }) };
}
const input = (s: Seen): Record<string, unknown> =>
  JSON.parse(atob(s.headers.get('X-AgentLink-Input')!.replace(/-/g, '+').replace(/_/g, '/')));

describe('switch', () => {
  it('posts the name and the number generation to the switch route', async () => {
    const t = api(200, { status: 'done', generation: 5, current: 'work' });
    expect(await t.agents.switchTo('work', 4)).toEqual({ kind: 'done' });
    expect(t.seen[0]?.url).toBe('/api/ui/agents/switch');
    expect(JSON.parse(t.seen[0]!.body)).toEqual({ name: 'work', generation: 4 });
    expect(t.seen[0]?.headers.get('X-AgentLink-CSRF')).toBe('t');
  });
  it('maps the refusals', async () => {
    expect(await api(409, { status: 'agent_changed' }).agents.switchTo('w', 1)).toEqual({ kind: 'agent_changed' });
    expect(await api(404, { status: 'unknown_agent' }).agents.switchTo('w', 1)).toEqual({ kind: 'failed' });
    expect(await api(501, {}).agents.switchTo('w', 1)).toEqual({ kind: 'not_available' });
  });
});

describe('owner operations', () => {
  const proof = { kind: 'code', code: '123456' } as const;
  it('rename sends name, label and generation in the input, the code as the body', async () => {
    const t = api(200, { status: 'done' });
    expect(await t.agents.rename({ name: 'work', label: 'Home', generation: 4 }, proof)).toEqual({ kind: 'done' });
    const s = t.seen[0]!;
    expect(s.url).toBe('/api/ui/agents/label');
    expect(input(s)).toEqual({ name: 'work', label: 'Home', generation: '4' });
    expect(s.body).toBe('123456');
    expect(s.headers.get('X-AgentLink-Input')).not.toContain('123456');
  });
  it('remove sends the typed label; add posts to the collection', async () => {
    const r = api(200, { status: 'done' });
    await r.agents.remove({ name: 'w', typedLabel: 'Work', generation: 4 }, proof);
    expect(r.seen[0]?.url).toBe('/api/ui/agents/remove');
    expect(input(r.seen[0]!)).toEqual({ name: 'w', typedLabel: 'Work', generation: '4' });
    const a = api(200, { status: 'done' });
    await a.agents.add({ label: 'New', generation: 4 }, proof);
    expect(a.seen[0]?.url).toBe('/api/ui/agents');
    expect(input(a.seen[0]!)).toEqual({ label: 'New', generation: '4' });
  });
  it('maps each answer to a word', async () => {
    const p = { name: 'w', label: 'L', generation: 1 };
    expect((await api(501, {}).agents.rename(p, proof)).kind).toBe('not_available');
    expect((await api(409, { status: 'agent_changed' }).agents.rename(p, proof)).kind).toBe('agent_changed');
    expect((await api(409, { status: 'in_use' }).agents.remove({ name: 'w', typedLabel: 'x', generation: 1 }, proof)).kind).toBe('in_use');
    expect((await api(403, { status: 'presence_rejected' }).agents.rename(p, proof)).kind).toBe('rejected');
    expect((await api(429, {}).agents.rename(p, proof)).kind).toBe('wait');
    expect((await api(400, { status: 'label_invalid' }).agents.rename(p, proof)).kind).toBe('label_invalid');
    expect((await api(409, { status: 'refused' }).agents.rename(p, proof)).kind).toBe('refused');
    expect((await api(500, {}).agents.rename(p, proof)).kind).toBe('failed');
  });
  it('wipes nothing it does not own and never puts the code in the URL', async () => {
    const t = api(200, { status: 'done' });
    await t.agents.rename({ name: 'w', label: 'L', generation: 1 }, proof);
    expect(t.seen[0]?.url).not.toContain('123456');
  });
});
