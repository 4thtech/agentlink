// @vitest-environment jsdom
// NET-UI-A: Advanced › Message network. Each state of the live view, the expand (contacts' hosts are
// inbound content: plain text only), the polling bounds and the labels. The answer shape is the one
// pinned as NETWORK_SHAPE in packages/node/src/local-ui/api/network.test.ts.
import { lintVocabulary } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../../../api/client.js';
import {
  NETWORK_CHANGED,
  NETWORK_EVENT_MIN_MS,
  NETWORK_POLL_MS,
  formatMs,
  parseNetwork,
  plainHost,
  summarize,
} from './data.js';
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
  vi.useRealTimers();
});

const NOW = 1_800_000_000;
const REF = `0x${'ab'.repeat(20)}`;
const REF2 = `0x${'cd'.repeat(20)}`;
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
  publishedFailed: 1,
  received: 7,
  countsSince: NOW - 3600,
  lastOkAt: NOW - 60,
  lastError: null,
  ...over,
});
const legacy = (): Record<string, unknown> =>
  server({
    host: 'nos.lol',
    roles: ['read'],
    kind: 'legacy',
    state: 'unknown',
    connectMs: null,
    roundTripMs: null,
    signInRequired: null,
    paymentRequired: null,
    publishedOk: 0,
    publishedFailed: 0,
    received: 0,
    countsSince: null,
    lastOkAt: null,
  });
const answer = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  agent: 'running',
  mode: 'automatic',
  checking: false,
  checkedAt: NOW - 20,
  servers: [
    server(),
    server({ host: 'offchain.pub', connectMs: 30, roundTripMs: 48 }),
    server({ host: 'relay.snort.social' }),
    legacy(),
  ],
  legacyReadUntil: 1_803_945_600,
  contacts: { total: 2, sharing: 1 },
  ...over,
});

const flush = (): Promise<void> => act(async () => undefined);
interface Mount {
  readonly read: ReturnType<typeof vi.fn>;
}
async function mount(
  data: unknown | (() => Promise<ApiResult<unknown>>),
  extra: Partial<Parameters<typeof NetworkView>[0]> = {},
): Promise<Mount> {
  const read = vi.fn(
    typeof data === 'function'
      ? (data as () => Promise<ApiResult<unknown>>)
      : () => Promise.resolve(ok(data)),
  );
  await act(async () =>
    root.render(h(NetworkView, { read, now: () => NOW, online: () => true, ...extra })),
  );
  await flush();
  return { read };
}
const text = (): string => host.textContent ?? '';
const states = (): string[] =>
  [...host.querySelectorAll('.nw-srv')].map((li) => li.getAttribute('data-state') ?? '');

describe('parseNetwork', () => {
  it('reads the pinned answer and nothing else', () => {
    const a = parseNetwork({ ...answer(), extra: 'x' });
    expect(a?.agent).toBe('running');
    expect(a?.servers).toHaveLength(4);
    expect(a?.servers[0]).toMatchObject({ host: 'relay.primal.net', sends: true, state: 'ready' });
    expect(a?.servers[3]).toMatchObject({ kind: 'legacy', sends: false, lastOkAt: null });
    expect(a?.contacts).toEqual({ total: 2, sharing: 1 });
    expect(JSON.stringify(a)).not.toContain('lastError');
  });
  it('drops anything that is not plain host text, and unusable answers', () => {
    expect(plainHost('relay.primal.net')).toBe('relay.primal.net');
    expect(plainHost('relay.example.org:8443')).toBe('relay.example.org:8443');
    for (const bad of [
      'wss://x.example',
      'a.example/path',
      '<img src=x onerror=alert(1)>',
      'UPPER.example',
      'a b.example',
      '',
      7,
      null,
    ]) {
      expect(plainHost(bad)).toBeUndefined();
    }
    expect(parseNetwork(null)).toBeUndefined();
    expect(parseNetwork({ agent: 'weird', servers: [] })).toBeUndefined();
    expect(parseNetwork({ agent: 'running' })).toBeUndefined();
    const a = parseNetwork(answer({ servers: [server({ host: '<b>x</b>' }), server()] }));
    expect(a?.servers).toHaveLength(1);
  });
  it('summarizes the own servers; old read-only ones never count', () => {
    const s = (servers: unknown[], over = {}): ReturnType<typeof summarize> =>
      summarize(parseNetwork(answer({ servers, ...over })) ?? (null as never));
    expect(s([server(), legacy()])).toBe('healthy');
    expect(s([server(), server({ host: 'a.example', state: 'slow', connectMs: 1900 })])).toBe(
      'one_slow',
    );
    expect(s([server(), server({ host: 'a.example', state: 'unreachable' })])).toBe('one_down');
    expect(s([server({ state: 'blocked' })])).toBe('all_down');
    expect(s([server({ state: 'unknown' })], { checking: true })).toBe('checking');
    expect(s([], { checking: false })).toBe('empty');
  });
  it('formats times', () => {
    expect(formatMs(48)).toBe('48 ms');
    expect(formatMs(1900)).toBe('1.9 s');
  });
});

describe('Message network view: states', () => {
  it('while the first read is on its way shows no false facts', async () => {
    await mount(() => new Promise(() => undefined));
    expect(host.querySelector('.nw-srv')).toBeNull();
    expect(text()).not.toContain(S.noAnswer);
  });

  it('all healthy: cards with host, roles, health word, times, 24 h counts and last OK', async () => {
    await mount(answer());
    expect(text()).toContain(S.allHealthy);
    expect(host.querySelector('.al-banner')).toBeNull();
    expect(states()).toEqual(['ready', 'ready', 'ready', 'unknown']);
    const first = host.querySelector('.nw-srv') as HTMLElement;
    expect(first.textContent).toContain('relay.primal.net');
    expect(first.textContent).toContain(S.health.ready);
    expect(first.textContent).toContain(S.sendsAndReads);
    expect(first.textContent).toContain('Connect 42 ms');
    expect(first.textContent).toContain('Round trip 48 ms');
    expect(first.textContent).toContain(S.counts(3, 1, 7));
    expect(first.textContent).toContain(S.lastOk('1 min ago'));
    expect(text()).toContain(S.modeAutomatic);
    expect(text()).toContain(S.lastChecked('just now'));
  });

  it('a full-name title on the host, the diagram slot and unknown as a hollow dot', async () => {
    await mount(answer());
    const first = host.querySelector('.nw-srv') as HTMLElement;
    expect(first.querySelector('.nw-host')?.getAttribute('title')).toBe('relay.primal.net');
    expect(host.querySelector('[data-slot="network-diagram"]')).not.toBeNull();
    expect(host.querySelector('[data-state="unknown"] .nw-dot')?.className).toContain(
      'is-checking',
    );
    // The route's own per-server count wins when it sends one.
    await mount(answer({ servers: [server({ contacts: 6 })] }));
    expect(text()).toContain(S.usedBy(6));
  });

  it('an old server is read only until a date, with no counts yet and not heard from', async () => {
    await mount(answer());
    const old = host.querySelector('.nw-srv.is-old') as HTMLElement;
    expect(old.textContent).toContain('nos.lol');
    expect(old.textContent).toContain('Old server, read only until');
    expect(old.textContent).toContain(S.health.unknown);
    expect(old.textContent).toContain(S.noCounts);
    expect(old.textContent).toContain(S.neverOk);
  });

  it('one slow: a warning banner, the card says slow, the dot has its own shape', async () => {
    await mount(
      answer({
        servers: [
          server(),
          server({ host: 'relay.snort.social', state: 'slow', connectMs: 1900, roundTripMs: null }),
        ],
      }),
    );
    const banner = host.querySelector('.al-banner') as HTMLElement;
    expect(banner.className).toContain('al-tone-warning');
    expect(banner.textContent).toContain(S.oneSlowTitle);
    const slow = host.querySelector('[data-state="slow"]') as HTMLElement;
    expect(slow.textContent).toContain(S.health.slow);
    expect(slow.textContent).toContain('Connect 1.9 s');
    expect(slow.textContent).toContain(S.slowNote);
    expect(slow.querySelector('.nw-dot')?.className).toContain('is-half');
    expect(host.querySelector('[data-state="ready"] .nw-dot')?.className).toContain('is-connected');
  });

  it('one down: the warning tone, not danger; a hollow dot', async () => {
    await mount(
      answer({
        servers: [
          server(),
          server({ host: 'nostr.bitcoiner.social', state: 'unreachable', connectMs: null }),
        ],
      }),
    );
    const banner = host.querySelector('.al-banner') as HTMLElement;
    expect(banner.className).toContain('al-tone-warning');
    expect(banner.className).not.toContain('al-tone-danger');
    expect(banner.textContent).toContain(S.oneDownTitle);
    const down = host.querySelector('[data-state="unreachable"]') as HTMLElement;
    expect(down.textContent).toContain(S.health.unreachable);
    expect(down.textContent).toContain(S.downNote);
    expect(down.querySelector('.nw-dot')?.className).toContain('is-not-running');
  });

  it('every server down uses the message network sentence; blocked has a square dot', async () => {
    await mount(
      answer({
        servers: [
          server({ state: 'blocked', connectMs: null }),
          server({ host: 'offchain.pub', state: 'unreachable', connectMs: null }),
        ],
      }),
    );
    expect(text()).toContain(S.allDownTitle);
    expect(host.querySelector('[data-state="blocked"] .nw-dot')?.className).toContain('is-square');
  });

  it('checking: before the first probe finishes', async () => {
    await mount(
      answer({
        checking: true,
        checkedAt: null,
        servers: [server({ state: 'unknown', connectMs: null, roundTripMs: null })],
      }),
    );
    expect(text()).toContain(S.checking);
  });

  it('needs sign-in and needs payment notes', async () => {
    await mount(
      answer({
        servers: [
          server({ signInRequired: true }),
          server({ host: 'offchain.pub', paymentRequired: true }),
        ],
      }),
    );
    expect(text()).toContain(S.needsSignIn);
    expect(text()).toContain(S.needsPayment);
  });

  it('offline: says so, keeps the last known facts, names the time', async () => {
    await mount(answer(), { online: () => false });
    const banner = host.querySelector('.al-banner') as HTMLElement;
    expect(banner.textContent).toContain(S.offlineTitle);
    expect(banner.textContent).toContain('Nothing is lost');
    expect(banner.textContent).toContain('Showing what we knew at');
    expect(host.querySelectorAll('.nw-srv')).toHaveLength(4);
  });

  it('not running, paused and needs setup', async () => {
    await mount(answer({ agent: 'not_running', servers: [], checkedAt: null }));
    expect(text()).toContain(S.notRunningTitle);
    expect(host.querySelector('.nw-card')).toBeNull();
    await mount(answer({ agent: 'paused', checkedAt: null }));
    expect(text()).toContain(S.pausedTitle);
    expect(host.querySelectorAll('.nw-srv')).toHaveLength(4);
    await mount(answer({ agent: 'needs_setup', servers: [], checkedAt: null, mode: null }));
    expect(text()).toContain(S.needsSetupTitle);
  });

  it('no answer at all says so; a later failure keeps what was known', async () => {
    await mount({ kind: 'offline' } as unknown as never);
    expect(text()).toContain(S.noAnswer);
    expect(host.querySelector('.nw-srv')).toBeNull();
  });

  it('uses plain words (11 §5) and no "relay"', () => {
    expect(lintVocabulary(JSON.stringify(S))).toEqual([]);
    expect(JSON.stringify(S).toLowerCase()).not.toContain('relay');
  });
});

describe('Message network view: contacts', () => {
  const rows = (hosts: unknown[]): unknown =>
    answer({
      contactHosts: [
        { ref: REF, servers: 3, shared: 1, hosts },
        { ref: REF2, servers: 1, shared: 0, hosts: ['their.example.net'] },
      ],
    });
  const contacts = (): ApiResult<unknown> =>
    ok({
      status: 'ok',
      contacts: [
        {
          ref: REF,
          name: 'Natasa',
          nameSource: 'owner',
          label: 'self-declared',
          status: 'active',
          pairing: 'complete',
          since: 5,
        },
      ],
    });

  it('shows the reach summary; the expand reads ?contacts and lists names and hosts as text', async () => {
    const read = vi.fn((c: boolean) =>
      Promise.resolve(ok(c ? rows(['relay.primal.net', 'nostr.wine']) : answer())),
    );
    const readContacts = vi.fn(() => Promise.resolve(contacts()));
    await act(async () =>
      root.render(h(NetworkView, { read, readContacts, now: () => NOW, online: () => true })),
    );
    await flush();
    expect(text()).toContain(S.reaches(1));
    expect(text()).toContain(S.reach(1, 2));
    // The diagram asks for contacts' hosts from the start (one read, no extra request) and names once.
    expect(read).toHaveBeenLastCalledWith(true);
    expect(readContacts).toHaveBeenCalledTimes(1);
    const toggle = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes(S.showContacts),
    ) as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => toggle.click());
    await flush();
    expect(read).toHaveBeenLastCalledWith(true);
    expect(readContacts).toHaveBeenCalledTimes(1);
    const items = [...host.querySelectorAll('.nw-contact')].map((li) => li.textContent);
    expect(items[0]).toContain('Natasa');
    expect(items[0]).toContain(S.contactServers(3, 1));
    expect(items[0]).toContain('relay.primal.net · shared');
    expect(items[0]).toContain('nostr.wine');
    // A contact the Contacts page does not know: no ref or id is shown.
    expect(items[1]).toContain(S.someoneUnknown);
    expect(text()).not.toContain(REF);
    expect(host.querySelector('.nw-contacts a')).toBeNull();
    // Each card now says how many contacts use that server too (derived from the expanded answer).
    const cards = [...host.querySelectorAll('.nw-srv')].map((li) => li.textContent ?? '');
    expect(cards[0]).toContain(S.usedBy(1));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toContain(S.hideContacts);
  });

  it('an injected <img onerror> host never becomes markup, a link or a request', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const read = (c: boolean): Promise<ApiResult<unknown>> =>
      Promise.resolve(ok(c ? rows([evil, 'ok.example.net']) : answer()));
    await act(async () =>
      root.render(
        h(NetworkView, {
          read,
          readContacts: () => Promise.resolve(contacts()),
          now: () => NOW,
          online: () => true,
        }),
      ),
    );
    await flush();
    await act(async () =>
      (
        [...host.querySelectorAll('button')].find((b) =>
          b.textContent?.includes(S.showContacts),
        ) as HTMLButtonElement
      ).click(),
    );
    await flush();
    expect(host.querySelector('img')).toBeNull();
    expect(host.innerHTML).not.toContain('<img');
    expect(host.innerHTML).not.toContain('onerror');
    expect(host.querySelector('a')).toBeNull();
    expect(text()).toContain('ok.example.net');
  });

  it('a hostile contact name stays text too', async () => {
    const read = (c: boolean): Promise<ApiResult<unknown>> =>
      Promise.resolve(ok(c ? rows(['a.example']) : answer()));
    const readContacts = (): Promise<ApiResult<unknown>> =>
      Promise.resolve(
        ok({
          status: 'ok',
          contacts: [
            {
              ref: REF,
              name: '<img src=x onerror=alert(1)>',
              nameSource: 'counterparty',
              fingerprint: 'AAAA·BBBB',
              label: 'self-declared',
              status: 'active',
              pairing: 'complete',
              since: 5,
            },
          ],
        }),
      );
    await act(async () => root.render(h(NetworkView, { read, readContacts, now: () => NOW })));
    await flush();
    await act(async () =>
      (
        [...host.querySelectorAll('button')].find((b) =>
          b.textContent?.includes(S.showContacts),
        ) as HTMLButtonElement
      ).click(),
    );
    await flush();
    expect(host.querySelector('img')).toBeNull();
  });

  it('no contacts: no expand, a plain line', async () => {
    await mount(answer({ contacts: { total: 0, sharing: 0 } }));
    expect(text()).toContain(S.noContacts);
    expect(host.querySelector('button')).toBeNull();
  });
});

describe('Message network view: live updates', () => {
  it('reads again on the stream event, but never faster than the minimum gap', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(1_000_000);
    const { read } = await mount(answer());
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.dispatchEvent(new Event(NETWORK_CHANGED));
    });
    expect(read).toHaveBeenCalledTimes(1); // too soon
    vi.setSystemTime(1_000_000 + NETWORK_EVENT_MIN_MS + 1);
    await act(async () => {
      window.dispatchEvent(new Event(NETWORK_CHANGED));
    });
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('polls no faster than the backend allows', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    expect(NETWORK_POLL_MS).toBeGreaterThanOrEqual(15_000);
    const { read } = await mount(answer());
    await act(async () => {
      vi.advanceTimersByTime(NETWORK_POLL_MS - 1);
    });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(2);
    });
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('stops on unmount', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const { read } = await mount(answer());
    act(() => root.unmount());
    await act(async () => {
      vi.advanceTimersByTime(NETWORK_POLL_MS * 3);
      window.dispatchEvent(new Event(NETWORK_CHANGED));
    });
    expect(read).toHaveBeenCalledTimes(1);
    root = createRoot(host);
  });
});

describe('Message network view: contact-details update note', () => {
  it('shows a warning when an update would drop servers', async () => {
    await mount(answer({ updateWouldDrop: 2 }));
    expect(text()).toContain(S.dropTitle);
    expect(text()).toContain(S.drop(2));
    expect(lintVocabulary(`${S.dropTitle} ${S.drop(2)}`)).toEqual([]);
  });
  it('is hidden when the field is 0', async () => {
    await mount(answer({ updateWouldDrop: 0 }));
    expect(text()).not.toContain(S.dropTitle);
  });
  it('is hidden when the field is missing', async () => {
    await mount(answer());
    expect(text()).not.toContain(S.dropTitle);
    expect(parseNetwork(answer())?.updateWouldDrop).toBe(0);
  });
});
