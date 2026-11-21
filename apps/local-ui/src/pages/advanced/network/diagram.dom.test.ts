// @vitest-environment jsdom
// NET-DIAGRAM: the three-column picture (this ID, servers, contacts) on Advanced › Message network:
// each health state, the dashed old server, contacts with "+ N more", the fallback when the hosts
// read fails, the stacked narrow layout, the text alternative and plain-text-only untrusted content.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../../../api/client.js';
import { MAX_DIAGRAM_CONTACTS, clip } from './diagram.js';
import { NETWORK_STRINGS as S } from './strings.js';
import { NetworkView } from './view.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const NOW = 1_800_000_000;
const ref = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const ok = (data: unknown): ApiResult<unknown> => ({ kind: 'ok', status: 200, data });
const server = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  host: 'relay.primal.net',
  roles: ['send', 'read'],
  kind: 'own',
  state: 'ready',
  connectMs: 42,
  roundTripMs: 48,
  signInRequired: false,
  paymentRequired: false,
  publishedOk: 3,
  publishedFailed: 0,
  received: 7,
  countsSince: NOW - 3600,
  lastOkAt: NOW - 60,
  lastError: null,
  ...over,
});
const legacy = (): Record<string, unknown> =>
  server({ host: 'nos.lol', roles: ['read'], kind: 'legacy', roundTripMs: 88, lastOkAt: null });
const answer = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  agent: 'running',
  mode: 'automatic',
  checking: false,
  checkedAt: NOW - 20,
  servers: [
    server(),
    server({ host: 'offchain.pub', roundTripMs: 30 }),
    server({ host: 'relay.snort.social' }),
    legacy(),
  ],
  legacyReadUntil: 1_803_945_600,
  contacts: { total: 2, sharing: 2 },
  ...over,
});
const hosts = (n: number, hostList: string[]): Record<string, unknown> => ({
  ref: ref(n),
  servers: hostList.length,
  shared: hostList.length,
  hosts: hostList,
});
const contactsRead = (names: Record<number, string>): (() => Promise<ApiResult<unknown>>) => {
  return () =>
    Promise.resolve(
      ok({
        status: 'ok',
        contacts: Object.entries(names).map(([n, name]) => ({
          ref: ref(Number(n)),
          name,
          nameSource: 'owner',
          label: 'self-declared',
          status: 'active',
          pairing: 'complete',
          since: 5,
        })),
      }),
    );
};

const flush = (): Promise<void> => act(async () => undefined);
async function mount(
  read: (c: boolean) => Promise<ApiResult<unknown>>,
  extra: Partial<Parameters<typeof NetworkView>[0]> = {},
): Promise<void> {
  await act(async () =>
    root.render(
      h(NetworkView, {
        read,
        now: () => NOW,
        online: () => true,
        agentLabel: 'Tali',
        readContacts: contactsRead({ 1: 'Natasa', 2: 'Denis' }),
        ...extra,
      }),
    ),
  );
  await flush();
}
const slot = (): HTMLElement => host.querySelector('[data-slot="network-diagram"]') as HTMLElement;
const wide = (): SVGElement | null => slot().querySelector('svg.nwd-wide');
const nodeText = (state: string): string =>
  host.querySelector(`.nwd-wide [data-node-state="${state}"]`)?.textContent ?? '';

describe('network diagram: servers', () => {
  it('draws this ID, one node per server and a solid line for each, in the owner s three columns', async () => {
    await mount(() => Promise.resolve(ok(answer({ contactHosts: [] }))));
    expect(slot().querySelector('.nwd')).not.toBeNull();
    const svg = wide() as SVGElement;
    expect(svg.textContent).toContain(S.diagramHeadThisId);
    expect(svg.textContent).toContain(S.diagramAgent('Tali'));
    expect(svg.textContent).toContain(S.diagramThisComputer);
    expect(svg.querySelectorAll('g[data-node-state]')).toHaveLength(4);
    expect(svg.querySelectorAll('path.nwd-ln.is-ok')).toHaveLength(3);
    expect(svg.textContent).toContain('relay.primal.net');
    expect(svg.textContent).toContain(`${S.diagramSendsReads} · 48 ms`);
    // No contacts shared: the server column alone, no third column.
    expect(svg.textContent).not.toContain(S.diagramHeadContacts);
    expect(svg.querySelectorAll('path.is-contact')).toHaveLength(0);
  });

  it('the old read-only server is drawn dashed, with its own line style', async () => {
    await mount(() => Promise.resolve(ok(answer({ contactHosts: [] }))));
    const svg = wide() as SVGElement;
    expect(svg.querySelectorAll('rect.nwd-node.is-old')).toHaveLength(1);
    expect(svg.querySelectorAll('path.nwd-ln.is-old')).toHaveLength(1);
    expect(nodeText('unknown')).toBe('');
    expect(svg.textContent).toContain(S.diagramReadOnly);
  });

  it('slow and down servers keep a different dot shape and the warning tone, never danger', async () => {
    await mount(() =>
      Promise.resolve(
        ok(
          answer({
            contactHosts: [],
            servers: [
              server(),
              server({ host: 'slow.example.net', state: 'slow', roundTripMs: 1900 }),
              server({ host: 'down.example.net', state: 'unreachable', roundTripMs: null }),
              server({ host: 'blocked.example.net', state: 'blocked', roundTripMs: null }),
              server({ host: 'new.example.net', state: 'unknown', roundTripMs: null }),
            ],
          }),
        ),
      ),
    );
    const svg = wide() as SVGElement;
    expect(svg.querySelectorAll('.nwd-ln.is-slow')).toHaveLength(1);
    expect(svg.querySelectorAll('.nwd-ln.is-down')).toHaveLength(2);
    expect(nodeText('slow')).toContain('slow \u00b7 1.9 s');
    expect(nodeText('unreachable')).toContain("can't reach");
    const dotOf = (state: string): string =>
      [...(host.querySelector(`.nwd-wide [data-node-state="${state}"]`)?.children ?? [])]
        .map((c) => `${c.tagName}${c.getAttribute('class') ?? ''}`)
        .join(' ');
    // Different shapes: filled circle, half, crossed (ring + slash), square, hollow ring.
    expect(dotOf('ready')).toContain('circlenwd-dot-fill');
    expect(dotOf('slow')).toContain('g');
    expect(host.querySelector('[data-node-state="slow"] path.nwd-dot-fill.is-warn')).not.toBeNull();
    expect(host.querySelector('[data-node-state="unreachable"] .nwd-dot-slash')).not.toBeNull();
    expect(
      host.querySelector('[data-node-state="blocked"] rect.nwd-dot-fill.is-warn'),
    ).not.toBeNull();
    expect(host.querySelector('[data-node-state="unknown"] circle.nwd-dot-ring')).not.toBeNull();
    expect(host.querySelector('.nwd [class*="danger"]')).toBeNull();
  });

  it('a long host is cut with an ellipsis and keeps its full name in a title', async () => {
    const long = 'a-very-long-server-name.example.org';
    await mount(() =>
      Promise.resolve(ok(answer({ contactHosts: [], servers: [server({ host: long })] }))),
    );
    const text = host.querySelector('.nwd-wide .nwd-t.is-code') as SVGElement;
    expect(text.textContent).toContain('…');
    expect(text.querySelector('title')?.textContent).toBe(long);
    expect(clip('abc', 5)).toBe('abc');
    expect(clip('abcdef', 4)).toBe('abc…');
  });

  it('draws nothing when there are no servers, or the agent is not running or paused', async () => {
    await mount(() => Promise.resolve(ok(answer({ servers: [] }))));
    expect(slot().querySelector('.nwd')).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    await mount(() => Promise.resolve(ok(answer({ agent: 'not_running' }))));
    expect(slot().querySelector('.nwd')).toBeNull();
  });
});

describe('old server date', () => {
  it('reads legacyReadUntil as unix seconds (about 2 Mar 2027 for LEGACY_CARD_UPDATE_UNTIL + 30 days)', async () => {
    await mount(() => Promise.resolve(ok(answer({ contactHosts: [] }))));
    const card = host.querySelector('.nw-srv.is-old') as HTMLElement;
    expect(card.textContent).toContain('2027');
    expect(card.textContent).toContain(
      S.oldGroup(
        1,
        new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
          new Date(1_803_945_600 * 1000),
        ),
      ),
    );
  });
});

describe('network diagram: contacts', () => {
  it('draws contacts with an initial and a thin line to each server they share', async () => {
    await mount(() =>
      Promise.resolve(
        ok(
          answer({
            contactHosts: [
              hosts(1, ['relay.primal.net', 'offchain.pub']),
              hosts(2, ['offchain.pub', 'unrelated.example.net']),
            ],
          }),
        ),
      ),
    );
    const svg = wide() as SVGElement;
    expect(svg.textContent).toContain(S.diagramHeadContacts);
    expect(svg.textContent).toContain('Natasa');
    expect(svg.textContent).toContain('Denis');
    expect(svg.querySelectorAll('path.nwd-ln.is-contact')).toHaveLength(3);
    expect(svg.textContent).toContain('N');
    // The legend names every line and dot.
    const legend = (slot().querySelector('.nwd-legend') as HTMLElement).textContent ?? '';
    for (const w of [
      S.legendSends,
      S.legendOld,
      S.legendContact,
      S.legendWorking,
      S.legendSlow,
      S.legendDown,
    ]) {
      expect(legend).toContain(w);
    }
  });

  it('shows at most five contacts, then "+ N more contacts"', async () => {
    const many = Array.from({ length: 9 }, (_, i) => hosts(i + 1, ['relay.primal.net']));
    const names: Record<number, string> = {};
    for (let i = 1; i <= 9; i += 1) names[i] = `Person ${String(i)}`;
    await mount(
      () =>
        Promise.resolve(ok(answer({ contactHosts: many, contacts: { total: 12, sharing: 9 } }))),
      { readContacts: contactsRead(names) },
    );
    const svg = wide() as SVGElement;
    expect(svg.querySelectorAll('.nwd-av:not(.is-id)')).toHaveLength(MAX_DIAGRAM_CONTACTS);
    expect(slot().querySelector('.nwd-more')?.textContent).toContain(S.diagramMore(4));
    expect(slot().querySelector('.nwd-stack')?.textContent).toContain(S.reaches(9));
  });

  it('shows at most five servers, problems first, then "+N more servers" that opens the full list', async () => {
    const twelve = Array.from({ length: 12 }, (_, i) =>
      server({ host: `s${String(i)}.example.org`, state: i === 11 ? 'unreachable' : 'ready' }),
    );
    await mount(() =>
      Promise.resolve(ok(answer({ servers: twelve, contacts: { total: 0, sharing: 0 } }))),
    );
    const svg = wide() as SVGElement;
    const drawn = [...svg.querySelectorAll('[data-node-state]')];
    expect(drawn).toHaveLength(5);
    // The one that cannot be reached is the last in the answer, yet drawn first.
    expect(drawn[0]?.textContent).toContain('s11.example.org');
    expect(slot().querySelectorAll('.nwd-stack .nwd-stack-item')).toHaveLength(5);
    const more = [...slot().querySelectorAll('.nwd-more button')];
    expect(more.map((b) => b.textContent)).toEqual([S.diagramMoreServers(7)]);
    expect(slot().querySelector('.nwd-pic')?.getAttribute('aria-label')).toBe(S.diagramSummary(12));
    await act(async () => (more[0] as HTMLElement).click());
    // Pressing it opens the full list below: all 12 rows, no "Show all" left to press.
    expect(host.querySelectorAll('.nw-list > .nw-srv[data-state]')).toHaveLength(12);
  });

  it('draws own servers first (problems first), then old read-only ones, even when those are unreachable', async () => {
    const list = [
      server({ host: 'old1.example.org', kind: 'legacy', sends: false, state: 'unreachable' }),
      server({ host: 'old2.example.org', kind: 'legacy', sends: false, state: 'unreachable' }),
      ...Array.from({ length: 5 }, (_, i) =>
        server({ host: `own${String(i)}.example.org`, state: i === 4 ? 'slow' : 'ready' }),
      ),
    ];
    await mount(() =>
      Promise.resolve(ok(answer({ servers: list, contacts: { total: 0, sharing: 0 } }))),
    );
    const svg = wide() as SVGElement;
    const drawn = [...svg.querySelectorAll('[data-node-state]')].map((n) => n.textContent ?? '');
    expect(drawn).toHaveLength(5);
    expect(drawn[0]).toContain('own4.example.org');
    expect(drawn.some((t) => t.includes('old1.example.org'))).toBe(false);
    expect(drawn.every((t) => t.includes('own'))).toBe(true);
    expect(slot().querySelector('.nwd-more')?.textContent).toContain(S.diagramMoreServers(2));
  });

  it('falls back to the server column alone when the contacts read fails, and shows the cards', async () => {
    const read = vi.fn((c: boolean) =>
      Promise.resolve(
        c
          ? ({ kind: 'error', status: 500 } as unknown as ApiResult<unknown>)
          : ok(answer({ contacts: { total: 2, sharing: 0 } })),
      ),
    );
    await mount(read);
    expect(read.mock.calls.map((c) => c[0])).toEqual([true, false]);
    const svg = wide() as SVGElement;
    expect(svg.querySelectorAll('g[data-node-state]')).toHaveLength(4);
    expect(svg.textContent).not.toContain(S.diagramHeadContacts);
    expect(host.querySelectorAll('.nw-srv')).toHaveLength(4);
    expect(host.textContent).not.toContain(S.noAnswer);
  });

  it('stays on one read per check (the hosts ride along) and asks for names once', async () => {
    const read = vi.fn(() =>
      Promise.resolve(ok(answer({ contactHosts: [hosts(1, ['offchain.pub'])] }))),
    );
    const readContacts = vi.fn(contactsRead({ 1: 'Natasa' }));
    await mount(read, { readContacts });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(true);
    expect(readContacts).toHaveBeenCalledTimes(1);
  });
});

describe('network diagram: narrow layout, text alternative, untrusted text', () => {
  it('has the stacked layout (ID card, servers with a connector, reach row) for narrow screens', async () => {
    await mount(() =>
      Promise.resolve(ok(answer({ contactHosts: [hosts(1, ['relay.primal.net'])] }))),
    );
    const stack = slot().querySelector('.nwd-stack') as HTMLElement;
    expect(stack).not.toBeNull();
    expect(stack.querySelectorAll('.nwd-conn')).toHaveLength(4);
    expect(stack.querySelectorAll('.nwd-conn.is-old')).toHaveLength(1);
    expect(stack.querySelector('.nwd-nd.is-id')?.textContent).toContain(S.diagramAgent('Tali'));
    expect(stack.querySelectorAll('.nwd-nd.is-old')).toHaveLength(1);
    expect(stack.querySelector('.nwd-cap')?.textContent).toBe(S.reaches(2));
    expect(stack.querySelectorAll('.nw-dot')).toHaveLength(4);
  });

  it('is one described image: a label, a hidden description of every server, the cards stay readable', async () => {
    await mount(() =>
      Promise.resolve(
        ok(
          answer({
            contactHosts: [hosts(1, ['relay.primal.net'])],
            servers: [
              server(),
              server({ host: 'slow.example.net', state: 'slow', roundTripMs: 1900 }),
            ],
          }),
        ),
      ),
    );
    const pic = slot().querySelector('.nwd-pic') as HTMLElement;
    expect(pic.getAttribute('role')).toBe('img');
    expect(pic.getAttribute('aria-label')).toBe(S.diagramSummary(2));
    const desc = document.getElementById(pic.getAttribute('aria-describedby') ?? '');
    expect(desc?.hasAttribute('hidden')).toBe(true);
    const text = desc?.textContent ?? '';
    expect(text).toContain('relay.primal.net, sends and receives, working');
    expect(text).toContain('slow.example.net, sends and receives, slow, 1.9 s');
    expect(text).toContain('Natasa');
    // The server cards below are still there, as the primary content.
    expect(host.querySelectorAll('.nw-srv')).toHaveLength(2);
  });

  it('shows hostile contact names and hosts as text only, never markup, a link or an image', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    await mount(
      () =>
        Promise.resolve(
          ok(
            answer({
              contactHosts: [hosts(1, ['relay.primal.net', evil, 'wss://x.example/path'])],
              contacts: { total: 1, sharing: 1 },
            }),
          ),
        ),
      { readContacts: contactsRead({ 1: evil }) },
    );
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('.nwd a')).toBeNull();
    expect(host.querySelector('.nwd [style]')).toBeNull();
    expect(host.querySelector('.nwd script')).toBeNull();
    expect(slot().textContent).toContain(evil);
    expect(slot().textContent).not.toContain('wss://');
    expect(slot().textContent).not.toContain(ref(1));
  });
});
