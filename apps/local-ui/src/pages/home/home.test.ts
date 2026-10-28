// @vitest-environment jsdom
// UI-REFRESH-g (S1): Home, five live tiles and the Start here card (UX2-g replaced the Next step card) (B-11 §4, §7, §16, §17.4; plan §6).
//
// - It reads only existing read routes (health, activity, credits, contacts, the approvals list),
//   shows a skeleton on first load, and every §4 state: first visit, fine, approvals waiting,
//   paused, not running, offline ("as of"), read error (old values kept).
// - Polling is the health poller's: it pauses while the tab is hidden and reads again when shown.
// - I-5: contact names, approval summaries and message text are React text only; Last activity
//   never shows message text or others' file names; Under the hood shows only allowlisted fields.
// - Reduced motion: no animation call. No inline styles (08 §4). At 360 Waiting for you comes first.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import homeCss from './home.css?raw';
import type { ApiClient, ApiResult } from '../../api/client.js';
import type { ApprovalItem, ListAnswer } from '../approvals/client.js';
import type { ContactRow } from '../contacts/data.js';
import { PAGE_PARTS } from '../../lazy/pages.js';
import { ROUTES } from '../../router.js';
import { HoodProvider, HOOD_STRINGS } from '@4thtech-io/ui';
import { Layout } from '../../layout/index.js';
import { HomePage, type HomePageProps } from './index.js';
import { HOME_STRINGS as S } from './strings.js';

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
  vi.restoreAllMocks();
  delete document.documentElement.dataset['motion'];
  setHidden(false);
});

const ok = (data: unknown): ApiResult<unknown> => ({ kind: 'ok', status: 200, data });

const NOW = new Date(2026, 9, 27, 14, 30, 0); // 27 Oct 2026, 14:30 local
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

const HEALTH = {
  agent: 'running',
  relays: { connected: 3, total: 3 },
  lastSyncAt: NOW_SECONDS - 120,
  version: '0.4.0',
};
const ACTIVITY = {
  items: [
    { kind: 'approval_decided', at: NOW_SECONDS - 60, decision: 'approved' },
    { kind: 'proof', at: NOW_SECONDS - 600, direction: 'sent', state: 'recorded' },
    { kind: 'rules_changed', at: NOW_SECONDS - 3_600 },
    { kind: 'contact_blocked', at: NOW_SECONDS - 7_200 },
  ],
};
const CREDITS = {
  status: 'ok',
  proofsLeft: 48,
  balance: '$4.80',
  price: '$0.10',
  test: false,
  partial: false,
};
const CONTACT = {
  ref: `0x${'a'.repeat(40)}`,
  name: 'Marko',
  nameSource: 'owner',
  label: 'self-declared',
  status: 'active',
  pairing: 'complete',
  since: NOW_SECONDS - 86_400,
};
const CONTACTS = { status: 'ok', contacts: [CONTACT] };
const CONTACT_ROW = { ...CONTACT, since: NOW_SECONDS - 86_400 } as ContactRow;

function approval(over: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    approvalId: `apr_${'A'.repeat(22)}`,
    summary: 'Send a file to Marko',
    actionDigest: 'f'.repeat(64),
    expiresAt: NOW_SECONDS + 9 * 60,
    commitment: false,
    paid: false,
    ...over,
  };
}

interface Answers {
  health?: ApiResult<unknown> | (() => Promise<ApiResult<unknown>>);
  activity?: ApiResult<unknown>;
  credits?: ApiResult<unknown>;
  contacts?: ApiResult<unknown>;
  approvals?: ListAnswer;
}

function setup(answers: Answers = {}): {
  props: HomePageProps;
  get: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  answers: Answers;
} {
  const a: Answers = answers;
  const get = vi.fn(async (path: string): Promise<ApiResult<unknown>> => {
    const pick = (
      v: Answers[keyof Answers],
      fallback: unknown,
    ): ApiResult<unknown> | Promise<ApiResult<unknown>> =>
      typeof v === 'function' ? v() : ((v as ApiResult<unknown> | undefined) ?? ok(fallback));
    if (path === '/api/ui/health') return pick(a.health, HEALTH);
    if (path.startsWith('/api/ui/activity')) return pick(a.activity, ACTIVITY);
    if (path === '/api/ui/proofs/credits') return pick(a.credits, CREDITS);
    if (path === '/api/ui/contacts') return pick(a.contacts, CONTACTS);
    return { kind: 'error', status: 404 };
  });
  const list = vi.fn(async (): Promise<ListAnswer> => a.approvals ?? { kind: 'ok', items: [] });
  const props: HomePageProps = {
    api: { get, post: vi.fn(), owner: vi.fn() } as unknown as ApiClient,
    approvals: { list },
    startHere: {
      protect: async () => true,
      contacts: async () => [CONTACT_ROW],
      sent: async () => true,
      kitSaved: () => true,
    },
    platform: 'mac',
    now: () => NOW,
  };
  return { props, get, list, answers: a };
}

async function mount(props: HomePageProps, hood = false): Promise<void> {
  await act(async () => {
    root.render(hood ? h(HoodProvider, { value: true }, h(HomePage, props)) : h(HomePage, props));
  });
}

const text = (): string => host.textContent ?? '';
const tile = (id: string): HTMLElement => {
  const el = host.querySelector<HTMLElement>(`[data-tile="${id}"]`);
  if (el === null) throw new Error(`no tile ${id}`);
  return el;
};

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: hidden ? 'hidden' : 'visible',
  });
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('Home: where it lives', () => {
  it('is routed at /settings/home (D-135)', () => {
    // UI-REFRESH-u: the route holds the lazy wrapper of Home (loaded on first visit).
    const lazy = PAGE_PARTS['/settings/home']?.Part;
    expect(lazy).toBeDefined();
    expect(ROUTES.some((r) => r.path === '/settings/home' && r.page === lazy)).toBe(true);
  });

  it('shows the page title, the date and a greeting for the time of day', async () => {
    const { props } = setup();
    await mount(props);
    expect(host.querySelector('h1')?.textContent).toBe('Home');
    expect(text()).toContain(S.greetingAfternoon);
    expect(host.querySelector('time')?.getAttribute('datetime')).toBe(NOW.toISOString());
  });
});

describe('Home: loading', () => {
  it('shows skeleton tiles on first load, after the short delay, then the values', async () => {
    vi.useFakeTimers();
    let resolve: (r: ApiResult<unknown>) => void = () => undefined;
    const { props } = setup({
      health: () => new Promise<ApiResult<unknown>>((r) => (resolve = r)),
    });
    await mount(props);
    // The tile frames are there from the start, so nothing jumps later.
    expect(host.querySelectorAll('[data-tile]').length).toBe(5);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
    });
    expect(host.querySelectorAll('.al-skeleton').length).toBeGreaterThan(0);
    expect(text()).not.toContain(S.agentRunningLine);
    await act(async () => {
      resolve(ok(HEALTH));
      await vi.advanceTimersByTimeAsync(10);
    });
    // The skeleton, once shown, stays at least 500 ms (B-11 §15.2).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(host.querySelectorAll('.al-skeleton').length).toBe(0);
    expect(text()).toContain(S.agentRunningLine);
  });

  it('reads only the existing routes', async () => {
    const { props, get, list } = setup();
    await mount(props);
    const paths = get.mock.calls.map((c) => String(c[0]).split('?')[0]);
    expect(new Set(paths)).toEqual(
      new Set(['/api/ui/health', '/api/ui/activity', '/api/ui/proofs/credits']),
    );
    expect(list).toHaveBeenCalled();
  });
});

describe('Home: everything fine', () => {
  it('shows the five tiles, each a link, with their values', async () => {
    const { props } = setup();
    await mount(props);
    const ids = [...host.querySelectorAll('[data-tile]')].map((e) => e.getAttribute('data-tile'));
    expect(ids.sort()).toEqual(['activity', 'agent', 'credits', 'network', 'waiting']);
    for (const id of ids) expect(tile(id as string).querySelector('a[href]')).not.toBeNull();
    expect(tile('agent').textContent).toContain(S.agentRunning);
    expect(tile('agent').textContent).toContain(S.agentRunningLine);
    expect(tile('network').textContent).toContain(S.networkConnected);
    expect(tile('waiting').textContent).toContain(S.waitingNone);
    expect(tile('credits').textContent).toContain('$4.80, about 48 proofs');
    expect(tile('credits').querySelector('[role="meter"]')).not.toBeNull();
    expect(tile('waiting').getAttribute('data-attention')).toBeNull();
  });

  it('lists the last three events with a time and a plain label, no more', async () => {
    const { props } = setup();
    await mount(props);
    const rows = tile('activity').querySelectorAll('li');
    expect(rows.length).toBe(3);
    expect(rows[0]?.textContent).toContain('You approved a request');
    expect(rows[0]?.querySelector('time')).not.toBeNull();
    expect(tile('activity').textContent).not.toContain('You blocked a contact');
  });

  it('has no Start here card when setup is complete', async () => {
    const { props } = setup();
    await mount(props);
    expect(host.querySelector('[data-start-here]')).toBeNull();
    expect(host.querySelector('[data-next-step]')).toBeNull();
  });

  it('shows the credits empty line at zero', async () => {
    const { props } = setup({ credits: ok({ ...CREDITS, proofsLeft: 0, balance: '$0.00' }) });
    await mount(props);
    expect(tile('credits').textContent).toContain(S.creditsNone);
  });

  it('shows an empty Last activity', async () => {
    const { props } = setup({ activity: ok({ items: [] }) });
    await mount(props);
    expect(tile('activity').textContent).toContain(S.activityNone);
  });

  it('uses no inline styles', async () => {
    const { props } = setup({ approvals: { kind: 'ok', items: [approval()] } });
    await mount(props);
    expect(host.querySelectorAll('[style]').length).toBe(0);
  });
});

describe('Home: approvals waiting', () => {
  it('shows the count, the soonest item with its time left, and a Review link; orange edge', async () => {
    const { props } = setup({
      approvals: {
        kind: 'ok',
        items: [
          approval({
            approvalId: `apr_${'B'.repeat(22)}`,
            summary: 'Later one',
            expiresAt: NOW_SECONDS + 3_000,
          }),
          approval(),
        ],
      },
    });
    await mount(props);
    const t = tile('waiting');
    expect(t.getAttribute('data-attention')).toBe('true');
    expect(t.textContent).toContain('2');
    expect(t.textContent).toContain('Send a file to Marko · 9 min left');
    expect(t.textContent).not.toContain(S.waitingNone);
    const review = [...t.querySelectorAll('a')].find((a) => a.textContent === S.review);
    expect(review?.getAttribute('href')).toBe('/');
  });
});

describe('Home: agent states', () => {
  it('paused', async () => {
    const { props } = setup({ health: ok({ ...HEALTH, agent: 'paused' }) });
    await mount(props);
    expect(tile('agent').textContent).toContain(S.agentPaused);
    expect(tile('agent').textContent).toContain(S.agentPausedLine);
  });

  it('not running: the tiles go quiet with one instruction', async () => {
    const { props } = setup({
      health: ok({ agent: 'not_running', relays: null, lastSyncAt: null, version: null }),
    });
    await mount(props);
    expect(tile('agent').textContent).toContain(S.agentNotRunning);
    expect(text()).toContain(S.agentNotRunningLine);
    expect(text().split(S.agentNotRunningLine).length - 1).toBe(1);
    expect(host.querySelector('[data-tiles]')?.getAttribute('data-quiet')).toBe('true');
    expect(tile('network').textContent).toContain(S.networkNotConnected);
  });

  it('needs setup', async () => {
    const { props } = setup({
      health: ok({ agent: 'needs_setup', relays: null, lastSyncAt: null, version: null }),
    });
    await mount(props);
    expect(tile('agent').textContent).toContain(S.agentNeedsSetup);
  });

  it('reconnecting when no route is up', async () => {
    const { props } = setup({ health: ok({ ...HEALTH, relays: { connected: 0, total: 3 } }) });
    await mount(props);
    expect(tile('network').textContent).toContain(S.networkReconnecting);
  });
});

describe('Home: offline and read errors', () => {
  it('offline: Network warns, the others keep the last values marked "as of"', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { props, answers } = setup();
    await mount(props);
    expect(tile('credits').textContent).toContain('$4.80');
    answers.health = { kind: 'offline' };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    expect(tile('network').textContent).toContain(S.networkOffline);
    expect(tile('credits').textContent).toContain('$4.80, about 48 proofs');
    expect(tile('credits').textContent).toContain(S.asOf);
    expect(tile('credits').textContent).toMatch(/as of \d{1,2}:\d{2}/);
    expect(text()).toContain(S.offlineLine);
  });

  it('a read error keeps the old values and says it is trying again', async () => {
    vi.useFakeTimers();
    const { props, answers } = setup({ approvals: { kind: 'ok', items: [approval()] } });
    await mount(props);
    answers.health = { kind: 'error', status: 500 };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    expect(text()).toContain(S.errorLine);
    expect(tile('credits').textContent).toContain('$4.80, about 48 proofs');
    expect(tile('waiting').textContent).toContain('Send a file to Marko');
    expect(tile('agent').textContent).toContain(S.agentRunning);
    expect(host.querySelector('[role="alert"], [role="status"]')).not.toBeNull();
  });

  it('the error line goes away once the read works again', async () => {
    vi.useFakeTimers();
    const { props, answers } = setup();
    await mount(props);
    answers.health = { kind: 'error', status: 500 };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    expect(text()).toContain(S.errorLine);
    answers.health = ok(HEALTH);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(text()).not.toContain(S.errorLine);
  });
});

describe('Home: live updates', () => {
  it('re-reads on the poller and updates the waiting count in place', async () => {
    vi.useFakeTimers();
    const { props, answers, get } = setup();
    await mount(props);
    const frame = tile('waiting');
    expect(frame.textContent).toContain(S.waitingNone);
    answers.approvals = { kind: 'ok', items: [approval()] };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });
    // The same element is updated: no remount, so no layout jump.
    expect(tile('waiting')).toBe(frame);
    expect(frame.textContent).toContain('Send a file to Marko');
    expect(get.mock.calls.filter((c) => c[0] === '/api/ui/health').length).toBeGreaterThanOrEqual(
      3,
    );
  });

  it('pauses while the tab is hidden and reads again when shown', async () => {
    vi.useFakeTimers();
    const { props, get } = setup();
    await mount(props);
    const reads = (): number => get.mock.calls.filter((c) => c[0] === '/api/ui/health').length;
    await act(async () => {
      setHidden(true);
      await vi.advanceTimersByTimeAsync(60_000);
    });
    const before = reads();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(reads()).toBe(before);
    await act(async () => {
      setHidden(false);
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(reads()).toBeGreaterThan(before);
  });

  it('stops reading once the page is left', async () => {
    vi.useFakeTimers();
    const { props, get } = setup();
    await mount(props);
    await act(async () => root.unmount());
    root = createRoot(host);
    const n = get.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(get.mock.calls.length).toBe(n);
  });
});

describe('Home: reduced motion', () => {
  it('plays no animation when motion is reduced, even when values change', async () => {
    vi.useFakeTimers();
    document.documentElement.dataset['motion'] = 'reduced';
    const animate = vi.fn(() => ({
      cancel: () => undefined,
      finish: () => undefined,
      onfinish: null,
    }));
    (Element.prototype as unknown as { animate: unknown }).animate = animate;
    const { props, answers } = setup();
    await mount(props);
    answers.approvals = { kind: 'ok', items: [approval()] };
    answers.activity = ok({
      items: [{ kind: 'rules_changed', at: NOW_SECONDS + 5 }, ...ACTIVITY.items],
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });
    expect(animate).not.toHaveBeenCalled();
    expect(tile('waiting').textContent).toContain('Send a file to Marko');
    delete (Element.prototype as unknown as { animate?: unknown }).animate;
  });
});

describe('Home: inbound content is plain text (I-5, §17.4)', () => {
  const EVIL = '<img src=x onerror=alert(1)><script>boom()</script>';

  it('renders an approval summary as text and clamps it', async () => {
    const { props } = setup({
      approvals: { kind: 'ok', items: [approval({ summary: `${EVIL} ${'x'.repeat(400)}` })] },
    });
    await mount(props);
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('script')).toBeNull();
    expect(tile('waiting').textContent).toContain('<img src=x');
    expect(tile('waiting').textContent?.length ?? 0).toBeLessThan(300);
  });

  it('never shows contact names, message text or file names in any tile', async () => {
    const { props } = setup({
      contacts: ok({
        status: 'ok',
        contacts: [{ ...CONTACT, name: 'CONTACT-NAME-CANARY <b>x</b>' }],
      }),
      activity: ok({
        items: [
          {
            kind: 'rules_changed',
            at: NOW_SECONDS,
            body: 'MESSAGE-BODY-CANARY',
            fileName: 'secret-plan.pdf',
            from: 'Marko',
          },
          { kind: 'message', at: NOW_SECONDS - 1, from: 'Marko', body: 'MESSAGE-BODY-CANARY' },
        ],
      }),
    });
    await mount(props);
    expect(text()).not.toContain('MESSAGE-BODY-CANARY');
    expect(text()).not.toContain('secret-plan.pdf');
    expect(text()).not.toContain('CONTACT-NAME-CANARY');
    expect(host.querySelector('b')).toBeNull();
  });

  it('shows only a fixed word when a health body carries extra fields', async () => {
    const { props } = setup({
      health: ok({
        ...HEALTH,
        sessionLink: 'http://127.0.0.1:1/#s=SESSIONCANARY',
        token: 'TOKENCANARY',
        agentCard: 'CARDCANARY',
      }),
    });
    await mount(props, true);
    for (const canary of ['SESSIONCANARY', 'TOKENCANARY', 'CARDCANARY', '127.0.0.1']) {
      expect(text()).not.toContain(canary);
    }
  });
});

describe('Home: Under the hood', () => {
  it('is off by default (the global switch decides)', async () => {
    const { props } = setup();
    await mount(props);
    expect(host.querySelector('.al-hood')).toBeNull();
    expect(text()).not.toContain(HOOD_STRINGS.title);
  });

  it('shows only the listed fields when the global switch is on, and not Last sync', async () => {
    const { props } = setup();
    await mount(props, true);
    const panel = host.querySelector('.al-hood') as HTMLElement;
    expect(panel.textContent).toContain(HOOD_STRINGS.title);
    expect(panel.textContent).toContain('0.4.0');
    expect(panel.textContent).toContain('3 of 3');
    expect(panel.textContent).not.toContain('Last sync');
    expect(panel.querySelectorAll('a').length).toBe(0);
    expect(panel.querySelectorAll('dt').length).toBe(2);
  });

  it('says so when there is nothing technical to show', async () => {
    const { props } = setup({
      health: ok({ agent: 'running', relays: null, lastSyncAt: null, version: null }),
    });
    await mount(props, true);
    expect((host.querySelector('.al-hood') as HTMLElement).textContent).toContain(
      HOOD_STRINGS.empty,
    );
  });
});

describe('Home: one health poller with the shell', () => {
  it('shares the shell poller: no doubled /api/ui/health reads', async () => {
    vi.useFakeTimers();
    const { props, get } = setup();
    const shellRead = vi.fn(async (): Promise<ApiResult<unknown>> => ok(HEALTH));
    await act(async () => {
      root.render(
        h(
          Layout,
          {
            path: '/settings/home',
            readHealth: shellRead,
            nextStep: async () => false,
            startHere: {
              protect: async () => true,
              contacts: async () => [CONTACT_ROW],
              sent: async () => true,
              kitSaved: () => true,
            },
            unseenMessages: async () => 0,
          },
          h(HomePage, props),
        ),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });
    const homeReads = get.mock.calls.filter((c) => c[0] === '/api/ui/health').length;
    // Ticks at 0, 5, 10 and 15 s: one poller reads four times between the two of them, not eight.
    expect(shellRead.mock.calls.length + homeReads).toBe(4);
    // Both still see every answer: the tile and the status bar.
    expect(text()).toContain(S.agentRunningLine);
    expect(host.querySelector('.al-sb-state .is-connected')).not.toBeNull();
  });
});

describe('Home: a request that throws', () => {
  it('lets the next tick read again (the reading flag is reset)', async () => {
    vi.useFakeTimers();
    const { props, get, answers } = setup();
    let fail = true;
    const base = get.getMockImplementation() as (p: string) => Promise<ApiResult<unknown>>;
    get.mockImplementation(async (path: string) => {
      if (fail && path.startsWith('/api/ui/activity')) throw new Error('boom');
      return base(path);
    });
    await mount(props);
    const activityReads = (): number =>
      get.mock.calls.filter((c) => String(c[0]).startsWith('/api/ui/activity')).length;
    expect(activityReads()).toBe(1);
    // The failed round settles the tiles instead of leaving them loading.
    expect(host.querySelectorAll('.al-skeleton').length).toBe(0);
    fail = false;
    answers.contacts = ok(CONTACTS);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });
    expect(activityReads()).toBeGreaterThan(1);
    expect(tile('activity').textContent).not.toContain(S.activityNone);
  });
});

describe('Home: layout at 1280 and 360 (stylesheet)', () => {
  it('uses tokens only: no literal durations', () => {
    const css = homeCss.replace(/\/\*[\s\S]*?\*\//g, '');
    const decls = [...css.matchAll(/(?:^|[\s{;])(?:transition|animation)\s*:\s*([^;]+);/g)];
    expect(decls.length).toBeGreaterThan(0);
    for (const d of decls) {
      if ((d[1] ?? '').trim() === 'none') continue;
      expect(d[1]).toMatch(/var\(--al-duration-/);
      expect(d[1]).not.toMatch(/\d(ms|s)\b/);
    }
  });

  it('only opacity and transform ever animate', () => {
    for (const m of homeCss.matchAll(/transition(?:-property)?:\s*([^;]+);/g)) {
      expect(m[1]).not.toMatch(/\b(width|height|top|left|margin|box-shadow|filter)\b/);
    }
  });

  it('puts Waiting for you first when the tiles stack, and has a reduced-motion rule', () => {
    expect(homeCss).toMatch(
      /@media \(max-width: [^)]+\)\s*\{[\s\S]*\[data-tile='waiting'\][\s\S]*order:\s*-1/,
    );
    expect(homeCss).toMatch(/prefers-reduced-motion|data-motion='reduced'/);
  });
});
