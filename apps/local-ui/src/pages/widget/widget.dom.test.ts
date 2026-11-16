// @vitest-environment jsdom
// TRAY-WIDGET-UI (S1, D-155): the menu bar widget page. Rendering, previews off, an inbound preview as
// plain text only (I-5), clicks reaching the bridge (and only the bridge), empty and error states,
// keyboard, and the debounced re-read on the `activity` event.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import indexSrc from './index.tsx?raw';
import dataSrc from './data.ts?raw';
import bridgeSrc from './bridge.ts?raw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, ApiResult } from '../../api/client.js';
import type { LiveAgent, LiveSnapshot } from '../../api/live.js';
import { resetHealthFeedForTests } from '../../layout/health-feed.js';
import { WIDGET_ACTIVITY_DOM_EVENT, WidgetPage, type WidgetPageProps } from './index.js';
import { cleanPreview, parseWidget } from './data.js';
import { WIDGET_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_800_000_000;
const ANA = `0x${'a'.repeat(40)}`;
const MARKO = `0x${'b'.repeat(40)}`;
const zeros = (): number[] => Array.from({ length: 24 }, () => 0);
const ok = (data: unknown): ApiResult<unknown> => ({ kind: 'ok', status: 200, data });

function widgetBody(over: Record<string, unknown> = {}): unknown {
  const inB = zeros();
  inB[9] = 3;
  const out = zeros();
  out[10] = 2;
  return {
    now: NOW,
    previews: true,
    unread: [
      { contactId: ANA, count: 2, lastAt: NOW - 240, preview: 'Draft of the Q4 budget is ready.' },
      { contactId: MARKO, count: 1, lastAt: NOW - 1_080, preview: 'Please check line 14' },
    ],
    today: {
      start: NOW - 36_000,
      bucketSeconds: 3_600,
      in: inB,
      out,
      proofs: zeros(),
      files: zeros(),
      partial: false,
    },
    contacts: [
      { contactId: ANA, lastAt: NOW - 240, activity: 'active_now' },
      { contactId: MARKO, lastAt: NOW - 7_200, activity: 'today' },
    ],
    ...over,
  };
}
const contactsBody = {
  status: 'ok',
  contacts: [
    {
      ref: ANA,
      name: 'Ana',
      nameSource: 'owner',
      label: 'self-declared',
      status: 'active',
      pairing: 'complete',
      since: 1,
    },
    {
      ref: MARKO,
      name: 'Marko',
      nameSource: 'owner',
      label: 'self-declared',
      status: 'active',
      pairing: 'complete',
      since: 1,
    },
  ],
};
const HEALTH = {
  agent: 'running',
  relays: { connected: 3, total: 3 },
  lastSyncAt: NOW,
  version: '0.5.9',
};
const notes = (approvals: number, files = 0): unknown => ({
  items: [
    ...(approvals > 0
      ? [{ id: 'approvals', kind: 'approvals', count: approvals, at: NOW, read: false }]
      : []),
    ...(files > 0
      ? [{ id: `files-${ANA}`, kind: 'files', ref: ANA, count: files, at: NOW, read: false }]
      : []),
  ],
  unread: approvals + files,
  approvals,
});

interface Setup {
  widget?: ApiResult<unknown>;
  health?: unknown;
  notes?: unknown;
  update?: unknown;
  agents?: LiveAgent[];
  feed?: unknown;
}

let host: HTMLElement;
let root: Root;
let calls: string[];
let bridge: {
  open: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  calls = [];
  postSpy.mockClear();
  ownerSpy.mockClear();
  bridge = {
    open: vi.fn(() => Promise.resolve(true)),
    quit: vi.fn(() => Promise.resolve(true)),
    close: vi.fn(() => Promise.resolve(true)),
  };
  window.agentlinkWidget = bridge as unknown as NonNullable<typeof window.agentlinkWidget>;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetHealthFeedForTests();
  delete window.agentlinkWidget;
  vi.restoreAllMocks();
});

const postSpy = vi.fn(() => Promise.resolve({ kind: 'error', status: 404 } as ApiResult<unknown>));
const ownerSpy = vi.fn(() => Promise.reject(new Error('never')));

function fakeApi(s: Setup): ApiClient {
  return {
    get: (path: string) => {
      calls.push(path);
      if (path.startsWith('/api/ui/widget')) return Promise.resolve(s.widget ?? ok(widgetBody()));
      if (path === '/api/ui/health') return Promise.resolve(ok(s.health ?? HEALTH));
      if (path === '/api/ui/contacts') return Promise.resolve(ok(contactsBody));
      if (path === '/api/ui/notifications') return Promise.resolve(ok(s.notes ?? notes(0)));
      if (path.startsWith('/api/ui/activity')) {
        return Promise.resolve(ok(s.feed ?? { items: [{ kind: 'rules_changed', at: NOW - 600 }] }));
      }
      if (path === '/api/ui/app-update') {
        return Promise.resolve(
          ok(s.update ?? { state: 'current', current: '0.5.9', install: 'desktop' }),
        );
      }
      return Promise.resolve({ kind: 'error', status: 404 } as ApiResult<unknown>);
    },
    post: postSpy,
    owner: ownerSpy,
  } as unknown as ApiClient;
}

const agent = (over: Partial<LiveAgent> = {}): LiveAgent => ({
  name: 'work',
  label: 'Work ID',
  current: true,
  state: 'working',
  statusText: 'Working in Claude Code',
  apps: [
    { app: 'Claude Code', state: 'working', word: 'Working' },
    { app: 'Cursor', state: 'off', word: 'Not connected · last seen 5 min ago' },
  ],
  removing: false,
  ...over,
});

async function mount(s: Setup = {}, props: Partial<WidgetPageProps> = {}): Promise<void> {
  const snap: LiveSnapshot = {
    list: { generation: 7, agents: [], switchable: true } as unknown as LiveSnapshot['list'],
    agents: s.agents ?? [agent()],
    error: false,
  };
  await act(async () => {
    root.render(
      h(WidgetPage, {
        api: fakeApi(s),
        subscribe: () => () => undefined,
        snapshot: () => snap,
        now: () => NOW,
        ...props,
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
  });
}

const q = <T extends Element = HTMLElement>(sel: string): T | null => host.querySelector<T>(sel);
const text = (): string => host.textContent ?? '';
const click = async (el: Element | null): Promise<void> => {
  expect(el).not.toBeNull();
  await act(async () => {
    (el as HTMLElement).click();
  });
};
const buttonNamed = (name: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(name));

describe('widget page', () => {
  it('shows the status, the connected apps, contacts, messages, today and the live feed', async () => {
    await mount({ notes: notes(2, 3) });
    expect(text()).toContain(S.running);
    expect(text()).toContain('1 AI app active');
    expect(text()).toContain('last activity 4 min ago');
    // Needs you
    expect(text()).toContain('2 waiting for you');
    expect(text()).toContain('3 new files');
    // Connected now
    expect(text()).toContain('Work ID');
    expect(text()).toContain('Claude Code');
    expect(text()).toContain('Working');
    expect(text()).toContain('Not running · last seen 5 min ago');
    // Contacts: last exchange, never "online"
    expect(text()).toContain('Active now');
    expect(text()).toContain(S.today);
    expect(text().toLowerCase()).not.toContain('online');
    // Messages with a preview and counts
    expect(text()).toContain('Ana');
    expect(text()).toContain('Draft of the Q4 budget is ready.');
    expect(q('[data-block="messages"]')?.textContent).toContain('3');
    // Today legend, Live feed
    expect(q('[data-block="today"]')?.textContent).toContain('In 3');
    expect(q('[data-block="today"]')?.textContent).toContain('Out 2');
    expect(q('[data-block="live"] li')).not.toBeNull();
    // Footer
    for (const label of [S.openApp, S.pause, S.quit]) expect(buttonNamed(label)).toBeDefined();
    expect(buttonNamed(S.updateReady)).toBeUndefined();
  });

  it('always shows Needs you, with "Nothing is waiting." when empty', async () => {
    await mount();
    expect(q('[data-block="needs"]')?.textContent).toContain(S.noneWaiting);
    expect(q('[data-block="needs"]')?.getAttribute('data-attention')).toBeNull();
  });

  it('with previews off shows the count line only, and drops a preview that still arrives', async () => {
    await mount({ widget: ok(widgetBody({ previews: false })) });
    expect(q('[data-untrusted-preview]')).toBeNull();
    expect(text()).not.toContain('Draft of the Q4 budget');
    expect(text()).toContain('2 new');
    expect(text()).not.toContain(S.untrustedNote);
  });

  it('renders a hostile preview as inert text: no markup, no link, no control characters', async () => {
    const hostile =
      '<img src=x onerror=alert(1)><a href="https://evil.example">click</a>‮\u0007​ **bold** [x](https://e.example)';
    await mount({
      widget: ok(
        widgetBody({ unread: [{ contactId: ANA, count: 1, lastAt: NOW - 60, preview: hostile }] }),
      ),
    });
    const el = q('[data-untrusted-preview]');
    expect(el).not.toBeNull();
    expect(el?.children.length).toBe(0);
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('a')).toBeNull();
    expect(el?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(el?.textContent).toContain('**bold**');
    expect(
      [...(el?.textContent ?? '')].some(
        (c) => c.charCodeAt(0) < 32 || c === '\u202e' || c === '\u200b',
      ),
    ).toBe(false);
    expect(el?.hasAttribute('title')).toBe(false);
    expect(el?.getAttribute('dir')).toBe('auto');
    expect(q('[data-block="messages"] [title]')).toBeNull();
  });

  it('never uses innerHTML for content', () => {
    for (const src of [indexSrc, dataSrc, bridgeSrc]) {
      expect(src).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML|insertAdjacentHTML/);
    }
  });

  it('opens the right page of the main window through the bridge, and nothing else', async () => {
    await mount({
      notes: notes(1, 2),
      update: {
        state: 'ready',
        current: '0.5.9',
        latest: '0.5.10',
        download: 'https://github.com/4thtech/agentlink/releases/tag/v0.5.10',
        install: 'desktop',
        installable: true,
      },
    });
    await click(q('[data-unread]'));
    expect(bridge.open).toHaveBeenLastCalledWith({ route: 'inbox', target: ANA });
    await click(buttonNamed('1 waiting for you') ?? null);
    expect(bridge.open).toHaveBeenLastCalledWith({ route: 'approvals' });
    await click(buttonNamed(S.review) ?? null);
    expect(bridge.open).toHaveBeenLastCalledWith({ route: 'approvals' });
    await click(buttonNamed('2 new files') ?? null);
    expect(bridge.open).toHaveBeenLastCalledWith({ route: 'inbox' });
    await click(buttonNamed(S.openApp) ?? null);
    expect(bridge.open).toHaveBeenLastCalledWith({ route: 'home' });
    await click(buttonNamed(S.updateReady) ?? null);
    expect(bridge.open).toHaveBeenLastCalledWith({ route: 'updates' });
    await click(buttonNamed(S.quit) ?? null);
    expect(bridge.quit).toHaveBeenCalledTimes(1);
    // Never a write from a click that only opens a page.
    expect(calls.every((c) => c.startsWith('/api/'))).toBe(true);
    expect(buttonNamed('Approve')).toBeUndefined();
    expect(buttonNamed('Deny')).toBeUndefined();
  });

  it('Pause and Resume open the main window; nothing is written here', async () => {
    await mount();
    await click(buttonNamed(S.pause) ?? null);
    expect(bridge.open).toHaveBeenLastCalledWith({ route: 'home' });
    resetHealthFeedForTests();
    act(() => root.unmount());
    root = createRoot(host);
    await mount({ health: { ...HEALTH, agent: 'paused' } });
    expect(text()).toContain(S.paused);
    await click(buttonNamed(S.resume) ?? null);
    expect(bridge.open).toHaveBeenLastCalledWith({ route: 'home' });
  });

  it('makes no non-GET request and no history navigation (popover rule)', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('offline')));
    vi.stubGlobal('fetch', fetchSpy);
    const push = vi.spyOn(history, 'pushState');
    const replace = vi.spyOn(history, 'replaceState');
    await mount({ notes: notes(1, 1) });
    for (const b of [...host.querySelectorAll('button')]) await click(b);
    await act(async () => {
      window.dispatchEvent(new Event(WIDGET_ACTIVITY_DOM_EVENT));
      await new Promise((r) => setTimeout(r, 500));
    });
    const methods = (fetchSpy.mock.calls as unknown as [unknown, RequestInit?][]).map((c) =>
      (c[1]?.method ?? 'GET').toUpperCase(),
    );
    expect(methods.every((m) => m === 'GET' || m === 'HEAD')).toBe(true);
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(host.querySelector('a[href]')).toBeNull();
    expect(postSpy).not.toHaveBeenCalled();
    expect(ownerSpy).not.toHaveBeenCalled();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.every((c) => c.startsWith('/api/'))).toBe(true);
    vi.unstubAllGlobals();
  });

  it('shows the empty states', async () => {
    await mount({
      widget: ok(widgetBody({ unread: [], contacts: [] })),
      agents: [],
      feed: { items: [] },
    });
    expect(text()).toContain(S.noMessages);
    expect(text()).toContain(S.noContacts);
    expect(text()).toContain(S.noApps);
    expect(text()).toContain(S.noLive);
  });

  it('shows an error line when the widget read fails, and the process-gone line when offline', async () => {
    await mount({ widget: { kind: 'error', status: 500 } });
    expect(text()).toContain(S.readError);
    expect(buttonNamed(S.openApp)).toBeDefined();
    act(() => root.unmount());
    root = createRoot(host);
    resetHealthFeedForTests();
    const offline = fakeApi({});
    const get = offline.get.bind(offline);
    offline.get = ((path: string) =>
      path === '/api/ui/health'
        ? Promise.resolve({ kind: 'offline' } as ApiResult<unknown>)
        : get(path)) as ApiClient['get'];
    await act(async () => {
      root.render(
        h(WidgetPage, {
          api: offline,
          subscribe: () => () => undefined,
          snapshot: () => ({ list: undefined, agents: [], error: false }),
          now: () => NOW,
        }),
      );
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(text()).toContain(S.notRunning);
    expect(text()).toContain(S.processGone);
  });

  it('Escape closes; arrows move focus between rows; Enter (a click) opens', async () => {
    await mount({ notes: notes(1) });
    const items = [...host.querySelectorAll<HTMLElement>('[data-wg-nav]')];
    expect(items.length).toBeGreaterThan(2);
    expect(document.activeElement).toBe(items[0]);
    await act(async () => {
      items[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(document.activeElement).toBe(items[1]);
    await act(async () => {
      items[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    expect(document.activeElement).toBe(items[0]);
    await act(async () => {
      items[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(bridge.close).toHaveBeenCalledTimes(1);
  });

  it('reads again, debounced, on the activity event', async () => {
    await mount();
    const before = calls.filter((c) => c.startsWith('/api/ui/widget')).length;
    await act(async () => {
      window.dispatchEvent(new Event(WIDGET_ACTIVITY_DOM_EVENT));
      window.dispatchEvent(new Event(WIDGET_ACTIVITY_DOM_EVENT));
      window.dispatchEvent(new Event(WIDGET_ACTIVITY_DOM_EVENT));
      await new Promise((r) => setTimeout(r, 600));
    });
    expect(calls.filter((c) => c.startsWith('/api/ui/widget')).length).toBe(before + 1);
  });
});

describe('widget data', () => {
  it('parseWidget keeps the exact shape and refuses extras', () => {
    expect(parseWidget(widgetBody())).toBeDefined();
    expect(parseWidget({ ...(widgetBody() as object), extra: 1 })).toBeUndefined();
    expect(parseWidget(widgetBody({ now: 'x' }))).toBeUndefined();
    const bad = parseWidget(
      widgetBody({
        unread: [
          { contactId: 'nope', count: 1, lastAt: 1 },
          { contactId: ANA, count: 1, lastAt: 1, extra: true },
        ],
      }),
    );
    expect(bad?.unread).toEqual([]);
  });

  it('cleanPreview strips control, format and bidi characters and cuts at 80 code points', () => {
    expect(cleanPreview('a\u0000b‮c​d\n\n e')).toBe('a b c d e');
    expect(cleanPreview('\u0007​ ')).toBeUndefined();
    const long = cleanPreview('x'.repeat(200)) ?? '';
    expect([...long].length).toBe(80);
    expect(long.endsWith('…')).toBe(true);
  });
});
