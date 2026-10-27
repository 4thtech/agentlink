// @vitest-environment jsdom
// UI-REFRESH-h (S1): the Activity page refresh (B-11 §6 rows 3, §7, §16; I-5).
//
// - Loading: the status word stays; the shared Skeleton shows after its 400 ms delay.
// - A LiveDot in the header: "Connected" after a load, "Reconnecting…" plus "As of …" when a refresh fails
//   (the rows already shown stay).
// - Day headers (one per local day, sticky on the solid chrome colour, no blur) and filter chips that
//   swap the list inside one fading wrapper, so the chips never move.
// - A refresh every 20 s adds new rows at the top; at most two enter with the highlight, however many arrive.
// - Under the hood: no event IDs are served, so the panel shows its empty text; never an ID.
// - Reduced motion (attribute and media rule), tokens only in the stylesheet, axe.
import axe from 'axe-core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoodProvider } from '@4thtech-io/ui';
import type { ApiClient, ApiResult } from '../../api/client.js';
import { ACTIVITY_POLL_MS, ActivityPage } from './index.js';
import { ACTIVITY_STRINGS as S } from './strings.js';

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
  delete document.documentElement.dataset['motion'];
  vi.useRealTimers();
});

type Get = (path: string) => Promise<ApiResult<unknown>>;
const apiWith = (get: Get): ApiClient & { get: ReturnType<typeof vi.fn> } =>
  ({ get: vi.fn(get), post: vi.fn() }) as unknown as ApiClient & { get: ReturnType<typeof vi.fn> };
const ok = (data: unknown): ApiResult<unknown> => ({ kind: 'ok', status: 200, data });
const offline = { kind: 'offline' } as ApiResult<unknown>;

async function mount(api: ApiClient, hood = false): Promise<void> {
  await act(async () => {
    root.render(h(HoodProvider, { value: hood }, h(ActivityPage, { api })));
  });
}
const tick = async (ms: number): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const q = (sel: string): Element | null => host.querySelector(sel);
const qa = (sel: string): Element[] => [...host.querySelectorAll(sel)];
const ROWS = 'tbody tr';

const DAY = 86_400;
const AT = 1_760_000_000;
const MIXED = [
  { kind: 'approval_decided', at: AT + 4 * DAY, decision: 'approved' },
  { kind: 'proof', at: AT + 4 * DAY - 60, direction: 'sent', state: 'recorded' },
  { kind: 'sender_blocked', at: AT + 2 * DAY, senderCode: '2B9E·04D1' },
  { kind: 'rules_changed', at: AT },
];
const fresh = (n: number): unknown[] =>
  Array.from({ length: n }, (_, i) => ({
    kind: 'approval_decided',
    at: AT + 10 * DAY + i,
    decision: 'approved',
  }));

describe('first load', () => {
  it('keeps the status word and shows the Skeleton after its delay', async () => {
    vi.useFakeTimers();
    const api = apiWith(() => new Promise(() => undefined));
    await mount(api);
    expect(q('[role="status"]')?.textContent).toBe(S.loading);
    expect(q('.al-skeleton')).toBeNull();
    await tick(500);
    expect(q('.al-skeleton')).not.toBeNull();
    expect(q('.al-activity-head .al-livedot')?.textContent).toContain('Checking');
  });
});

describe('header, day groups and chips', () => {
  it('shows a LiveDot in the header once loaded', async () => {
    await mount(apiWith(async () => ok({ items: MIXED })));
    expect(q('.al-activity-head .al-livedot')?.textContent).toContain('Connected');
  });

  it('groups rows under one day header per local day', async () => {
    await mount(apiWith(async () => ok({ items: MIXED })));
    const days = qa('h2.al-activity-day');
    expect(days).toHaveLength(3);
    expect(days.every((d) => (d.textContent ?? '').length > 0)).toBe(true);
    expect(qa('section.al-activity-section')).toHaveLength(3);
    expect(qa(ROWS)).toHaveLength(4);
  });

  it('filters with chips: pressed state, only matching rows, chips stay the same nodes', async () => {
    await mount(apiWith(async () => ok({ items: MIXED })));
    const group = q(`[role="group"][aria-label="${S.filterLabel}"]`) as HTMLElement;
    const chips = [...group.querySelectorAll('button.al-activity-chip')] as HTMLButtonElement[];
    expect(chips.map((c) => c.textContent)).toEqual([
      S.filterAll,
      S.filterApprovals,
      S.filterProofs,
      S.filterOther,
    ]);
    expect(chips[0]?.getAttribute('aria-pressed')).toBe('true');
    const wrapper = q('.al-activity-list');
    act(() => chips[2]?.click());
    expect(chips[2]?.getAttribute('aria-pressed')).toBe('true');
    expect(chips[0]?.getAttribute('aria-pressed')).toBe('false');
    expect(qa(ROWS)).toHaveLength(1);
    expect(host.textContent).toContain(S.proofSent);
    // The chip row is never rebuilt; only the list wrapper is swapped (it carries the fade).
    expect([...group.querySelectorAll('button')]).toEqual(chips);
    expect(q('.al-activity-list')).not.toBe(wrapper);
    expect(q('.al-activity-list')?.getAttribute('data-filter')).toBe('proofs');
    expect(q('.al-activity-list')?.closest('.al-activity-stage')).not.toBeNull();
  });

  it('says so when a filter has no rows, and All brings them back', async () => {
    await mount(apiWith(async () => ok({ items: [MIXED[3]] })));
    const chips = qa('button.al-activity-chip') as HTMLButtonElement[];
    act(() => chips[2]?.click());
    expect(host.textContent).toContain(S.filterEmpty);
    act(() => chips[0]?.click());
    expect(host.textContent).toContain(S.rulesChanged);
  });
});

describe('live refresh', () => {
  const run = async (
    second: ApiResult<unknown>,
    first: unknown[] = MIXED,
  ): Promise<ReturnType<typeof apiWith>> => {
    vi.useFakeTimers();
    let n = 0;
    const api = apiWith(async () => (n++ === 0 ? ok({ items: first }) : second));
    await mount(api);
    await tick(ACTIVITY_POLL_MS + 50);
    return api;
  };

  it('does not animate the rows of the first load', async () => {
    await mount(apiWith(async () => ok({ items: MIXED })));
    expect(qa('.al-row-presence')).toHaveLength(0);
  });

  it('adds a new row at the top with the entrance, keeping the old rows', async () => {
    const api = await run(ok({ items: [...fresh(1), ...MIXED] }));
    expect(api.get).toHaveBeenCalledTimes(2);
    const rows = qa(ROWS);
    expect(rows).toHaveLength(5);
    expect(rows[0]?.classList.contains('al-row-presence')).toBe(true);
    expect(qa('.al-row-presence')).toHaveLength(1);
  });

  it('never enters more than two rows, however many arrive', async () => {
    await run(ok({ items: [...fresh(6), ...MIXED] }));
    expect(qa(ROWS)).toHaveLength(10);
    expect(qa('.al-row-presence').length).toBeLessThanOrEqual(2);
  });

  it('a 200-row fixture animates nothing on load and at most two rows after a refresh', async () => {
    const big = Array.from({ length: 200 }, (_, i) => ({
      kind: 'rules_changed',
      at: AT + 200 - i,
    }));
    await run(ok({ items: [...fresh(5), ...big] }), big);
    expect(qa(ROWS)).toHaveLength(205);
    expect(qa('.al-row-presence').length).toBeLessThanOrEqual(2);
  });

  it('keeps the rows and says "As of" when a refresh cannot reach the app', async () => {
    await run(offline);
    expect(qa(ROWS)).toHaveLength(4);
    expect(q('.al-activity-head .al-livedot')?.textContent).toContain('Reconnecting');
    expect(q('.al-activity-asof')?.textContent).toContain(S.asOf);
  });

  it('is quiet in reduced motion: the row appears, with no highlight', async () => {
    document.documentElement.dataset['motion'] = 'reduced';
    await run(ok({ items: [...fresh(1), ...MIXED] }));
    expect(qa(ROWS)).toHaveLength(5);
    expect(q('.al-row-hl')).toBeNull();
  });

  it('does not refresh while the tab is hidden', async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    try {
      const api = apiWith(async () => ok({ items: MIXED }));
      await mount(api);
      await tick(ACTIVITY_POLL_MS * 3);
      expect(api.get).toHaveBeenCalledTimes(1);
    } finally {
      delete (document as unknown as Record<string, unknown>)['hidden'];
    }
  });
});

describe('under the hood', () => {
  it('shows the panel with its empty text when on: no event IDs are served', async () => {
    await mount(
      apiWith(async () => ok({ items: MIXED })),
      true,
    );
    expect(q('.al-hood')).not.toBeNull();
    expect(q('.al-hood-empty')).not.toBeNull();
    expect(qa('.al-hood-row')).toHaveLength(0);
  });
  it('shows nothing when off', async () => {
    await mount(
      apiWith(async () => ok({ items: MIXED })),
      false,
    );
    expect(q('.al-hood')).toBeNull();
  });
});

describe('inbound text and accessibility', () => {
  it('shows a sender code as plain text, never as markup, and no inline style anywhere', async () => {
    const items = [{ kind: 'sender_blocked', at: AT, senderCode: '<b>x</b>' }];
    await mount(apiWith(async () => ok({ items })));
    expect(host.textContent).toContain('<b>x</b>');
    expect(q('b')).toBeNull();
    expect(qa('[style]')).toHaveLength(0);
  });

  it('has no WCAG 2.1 AA violations with rows, chips and the panel', async () => {
    await mount(
      apiWith(async () => ok({ items: MIXED })),
      true,
    );
    const r = await axe.run(host, {
      runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});

describe('stylesheet', () => {
  const css = readFileSync(
    resolve(process.cwd(), 'src/pages/activity/activity.css'),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '');
  it('sticks the day headers under the top bar on the solid chrome colour, with no blur', () => {
    const rule = /\.al-activity-day\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/position:\s*sticky/);
    expect(rule).toMatch(/top:\s*var\(--al-size-control-lg\)/);
    expect(rule).toMatch(/--al-material-chrome-bg/);
    expect(css).not.toMatch(/backdrop-filter|blur\(/);
  });
  it('uses tokens for every duration and has both reduced-motion rules', () => {
    expect(css).not.toMatch(/:\s*[\d.]+m?s\b/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toMatch(/\[data-motion=['"]?reduced/);
    expect(css).toMatch(/@keyframes al-activity-fade/);
  });
});
