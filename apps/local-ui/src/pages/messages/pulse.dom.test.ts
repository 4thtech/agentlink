// @vitest-environment jsdom
// UX2-f2: the pulse and the activity word in Messages, and "Most active" (b11 §24; D-137).
import axe from 'axe-core';
import { HoodProvider } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, ApiResult } from '../../api/client.js';
import { resetPrefsForTests } from '../../prefs/store.js';
import { MessagesPage } from './index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  resetPrefsForTests();
  document.documentElement.removeAttribute('data-motion');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.documentElement.removeAttribute('data-motion');
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (Element.prototype as { animate?: unknown }).animate;
  delete (window as { matchMedia?: unknown }).matchMedia;
});

const AT = 1_760_000_000;
const PULSE = '/api/ui/messages/pulse';
const ok = (data: unknown): ApiResult<unknown> => ({ kind: 'ok', status: 200, data });
const flat = (): number[] => Array.from({ length: 12 }, () => 0);
const counts = (last: number, total = last): number[] => {
  const c = flat();
  c[11] = last;
  c[0] = total - last;
  return c;
};
const convs = [
  { contactId: 'c-ana', name: 'Ana', lastAt: AT - 50_000, lastInAt: AT - 50_000 },
  { contactId: 'c-ivo', name: 'Ivo', lastAt: AT - 90_000, lastInAt: AT - 90_000 },
  { contactId: 'c-marko', name: 'Marko', lastAt: AT - 100, lastInAt: AT - 100 },
];
interface Row {
  id: string;
  activity: string;
  lastAt: number;
  counts: number[];
}
const pulseOf = (rows: Row[], extra: Record<string, unknown> = {}): unknown => ({
  now: AT,
  bucketSeconds: 7200,
  partial: false,
  contacts: rows.map((r) => ({
    contactId: r.id,
    counts: r.counts,
    lastAt: r.lastAt,
    activity: r.activity,
  })),
  ...extra,
});
const BASE = pulseOf([
  { id: 'c-marko', activity: 'active_now', lastAt: AT - 100, counts: counts(3, 14) },
  { id: 'c-ana', activity: 'today', lastAt: AT - 5000, counts: counts(0, 2) },
]);

function api(pulse: () => ApiResult<unknown>): ApiClient {
  const get = vi.fn((path: string): Promise<ApiResult<unknown>> => {
    if (path === '/api/ui/messages') return Promise.resolve(ok({ conversations: convs }));
    if (path === PULSE) return Promise.resolve(pulse());
    return Promise.resolve(ok({ items: [] }));
  });
  return { get, post: vi.fn(), owner: vi.fn() } as unknown as ApiClient;
}
const pulseCalls = (c: ApiClient): number =>
  (c.get as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((x) => x[0] === PULSE).length;

async function mount(client: ApiClient, hood = false): Promise<void> {
  await act(async () => {
    root.render(h(HoodProvider, { value: hood }, h(MessagesPage, { api: client })));
  });
}
const row = (id: string): HTMLElement => {
  const el = host.querySelector<HTMLElement>(`button[data-contact="${id}"]`)?.closest('li');
  if (el === null || el === undefined) throw new Error(`no row ${id}`);
  return el;
};
const word = (id: string): string => row(id).querySelector('.act-word')?.textContent ?? '';
const shape = (id: string): string | null =>
  row(id).querySelector('.act-marker')?.getAttribute('data-shape') ?? null;
const order = (): string[] =>
  [...host.querySelectorAll('button[data-contact]')].map(
    (b) => b.getAttribute('data-contact') ?? '',
  );

describe('words and markers', () => {
  it('shows Active now, Today and Quiet with shapes that differ', async () => {
    await mount(api(() => ok(BASE)));
    expect(word('c-marko')).toBe('Active now');
    expect(word('c-ana')).toBe('Today');
    expect(word('c-ivo')).toBe('Quiet');
    expect(shape('c-marko')).toBe('dot');
    expect(shape('c-ana')).toBe('ring');
    expect(shape('c-ivo')).toBe('none');
  });

  it('names the pulse as one image with the count in words', async () => {
    await mount(api(() => ok(BASE)));
    expect(row('c-marko').querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      '14 messages in the last 24 hours',
    );
    expect(row('c-ivo').querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      'No messages in the last 24 hours',
    );
    expect(row('c-marko').querySelectorAll('.act-bar').length).toBe(12);
  });

  it('never shows message text from the read', async () => {
    const dirty = pulseOf([{ id: 'c-marko', activity: 'today', lastAt: AT, counts: counts(1) }]);
    (dirty as { contacts: Record<string, unknown>[] }).contacts[0]!['text'] = 'CANARY-BODY';
    await mount(api(() => ok(dirty)));
    expect(host.textContent).not.toContain('CANARY-BODY');
  });
});

describe('degrades gracefully', () => {
  it('keeps the rows and a flat pulse, and says nothing loud, when the read fails', async () => {
    await mount(api(() => ({ kind: 'error', status: 503 })));
    expect(order().length).toBe(3);
    expect(host.querySelector('.act-word')).toBeNull();
    expect(row('c-marko').querySelectorAll('.act-bar').length).toBe(12);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows no Quiet word for a contact the answer left out when it is partial', async () => {
    await mount(api(() => ok({ ...(BASE as object), partial: true })));
    expect(word('c-marko')).toBe('Active now');
    expect(word('c-ivo')).toBe('');
  });
});

describe('the arrival pulse (b11 §24.4)', () => {
  it('does not play for a row that is already Active now when the list loads', async () => {
    const animate = vi.fn();
    (Element.prototype as { animate?: unknown }).animate = animate;
    await mount(api(() => ok(BASE)));
    expect(animate).not.toHaveBeenCalled();
  });

  it('plays one ring when a row becomes Active now, once, never looping', async () => {
    vi.useFakeTimers();
    const animate = vi.fn();
    (Element.prototype as { animate?: unknown }).animate = animate;
    let n = 0;
    const client = api(() => {
      n += 1;
      return ok(
        n === 1
          ? pulseOf([{ id: 'c-ana', activity: 'today', lastAt: AT - 900, counts: counts(1) }])
          : pulseOf([{ id: 'c-ana', activity: 'active_now', lastAt: AT, counts: counts(2) }]),
      );
    });
    await mount(client);
    expect(word('c-ana')).toBe('Today');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(word('c-ana')).toBe('Active now');
    expect(animate).toHaveBeenCalledTimes(1);
    const opts = animate.mock.calls[0]?.[1] as { duration?: number; iterations?: number };
    expect(opts.duration).toBe(480);
    expect(opts.iterations ?? 1).toBe(1);
    // A later read that keeps it Active now plays nothing more.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it('plays nothing under reduced motion, and the filled dot and word still show', async () => {
    vi.useFakeTimers();
    document.documentElement.setAttribute('data-motion', 'reduced');
    const animate = vi.fn();
    (Element.prototype as { animate?: unknown }).animate = animate;
    let n = 0;
    await mount(
      api(() => {
        n += 1;
        const activity = n === 1 ? 'today' : 'active_now';
        return ok(pulseOf([{ id: 'c-ana', activity, lastAt: AT, counts: counts(1) }]));
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(animate).not.toHaveBeenCalled();
    expect(word('c-ana')).toBe('Active now');
    expect(shape('c-ana')).toBe('dot');
  });
});

describe('polling', () => {
  it('re-reads every 60 seconds while the tab is visible', async () => {
    vi.useFakeTimers();
    const client = api(() => ok(BASE));
    await mount(client);
    expect(pulseCalls(client)).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(pulseCalls(client)).toBe(2);
  });

  it('pauses while the tab is hidden and reads again when it comes back', async () => {
    vi.useFakeTimers();
    const client = api(() => ok(BASE));
    await mount(client);
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(300_000);
    });
    expect(pulseCalls(client)).toBe(1);
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(pulseCalls(client)).toBe(2);
  });

  it('stops when the page goes away', async () => {
    vi.useFakeTimers();
    const client = api(() => ok(BASE));
    await mount(client);
    act(() => root.unmount());
    await vi.advanceTimersByTimeAsync(180_000);
    expect(pulseCalls(client)).toBe(1);
    root = createRoot(host);
  });
});

describe('Most active', () => {
  const group = (): HTMLElement | null =>
    host.querySelector('[role="radiogroup"][aria-label="Sort"]');
  const radios = (): HTMLElement[] => [...(group()?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])];
  const pick = async (label: string): Promise<void> => {
    const r = radios().find((x) => x.textContent === label);
    await act(async () => {
      r?.click();
    });
  };

  it('offers Recent (the default) and Most active in a Sort group', async () => {
    await mount(api(() => ok(BASE)));
    expect(radios().map((x) => x.textContent)).toEqual(['Recent', 'Most active']);
    expect(radios().find((x) => x.getAttribute('aria-checked') === 'true')?.textContent).toBe(
      'Recent',
    );
    expect(order()).toEqual(['c-ana', 'c-ivo', 'c-marko']);
  });

  it('orders by activity, then the last exchange, and remembers the choice', async () => {
    await mount(api(() => ok(BASE)));
    await pick('Most active');
    expect(order()).toEqual(['c-marko', 'c-ana', 'c-ivo']);
    expect(localStorage.getItem('agentlink.prefs')).toContain('"activitySort":"active"');
    act(() => root.unmount());
    root = createRoot(host);
    resetPrefsForTests();
    await mount(api(() => ok(BASE)));
    expect(order()).toEqual(['c-marko', 'c-ana', 'c-ivo']);
  });

  it('falls back to Recent when storage holds something else', async () => {
    localStorage.setItem('agentlink.prefs', '{"activitySort":"loudest"}');
    resetPrefsForTests();
    await mount(api(() => ok(BASE)));
    expect(order()).toEqual(['c-ana', 'c-ivo', 'c-marko']);
  });
});

describe('axe and scale', () => {
  it('finds no WCAG A/AA violation on the list with pulses and the sort', async () => {
    await mount(api(() => ok(BASE)), true);
    const r = await axe.run(host, {
      runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });

  it('reads the pulse once for 60 contacts, never once per conversation', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      contactId: `c-${String(i)}`,
      name: `P${String(i)}`,
      lastAt: AT - i,
      lastInAt: AT - i,
    }));
    const get = vi.fn((path: string) =>
      Promise.resolve(path === '/api/ui/messages' ? ok({ conversations: many }) : ok(BASE)),
    );
    await mount({ get, post: vi.fn(), owner: vi.fn() } as unknown as ApiClient);
    expect(get.mock.calls.filter((c) => c[0] === PULSE).length).toBe(1);
    expect(host.querySelectorAll('.act-spark').length).toBe(60);
  });
});
