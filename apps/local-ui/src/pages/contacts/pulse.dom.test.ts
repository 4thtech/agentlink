// @vitest-environment jsdom
// UX2-f2: the pulse and the activity word in Contacts, and "Most active" (b11 §24; D-137).
import axe from 'axe-core';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../api/client.js';
import { resetPrefsForTests } from '../../prefs/store.js';
import { ContactsPage } from './index.js';
import { createOwnerClient } from './owner.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  resetPrefsForTests();
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
  delete (Element.prototype as { animate?: unknown }).animate;
});

const A = '0x7f3a19c200000000000000000000000000000001';
const B = '0x4c21a0f700000000000000000000000000000002';
const C = '0x9d00000000000000000000000000000000000003';
const NOW = 1_760_000_000;
const contact = (ref: string, name: string): Record<string, unknown> => ({
  ref,
  name,
  nameSource: 'owner',
  label: 'self-declared',
  status: 'active',
  pairing: 'complete',
  since: 1_759_449_600,
});
const flat = (): number[] => Array.from({ length: 12 }, () => 0);
const busy = (): number[] => [...flat().slice(0, 11), 5];
const PULSE = {
  now: NOW,
  bucketSeconds: 7200,
  partial: false,
  contacts: [
    { contactId: C, counts: busy(), lastAt: NOW - 30, activity: 'active_now' },
    { contactId: B, counts: flat(), lastAt: NOW - 4000, activity: 'today' },
  ],
};

let pulseReads = 0;
function fetchFor(pulse: () => Response): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (b: unknown): Response =>
      new Response(JSON.stringify(b), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url === '/api/ui/contacts') {
      return json({
        status: 'ok',
        contacts: [contact(A, 'Ana'), contact(B, 'Bo'), contact(C, 'Cy')],
      });
    }
    if (url === '/api/ui/messages/pulse') {
      pulseReads += 1;
      return pulse();
    }
    if (url === '/api/owner/passkey') {
      return json({ passkey: { registered: false, rpId: 'localhost', userId: 'AA', prfSalt: 'AA' } });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
}
const okPulse = (): Response =>
  new Response(JSON.stringify(PULSE), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
async function mount(pulse: () => Response = okPulse): Promise<void> {
  pulseReads = 0;
  const f = fetchFor(pulse);
  const api = createApiClient({ fetch: f, token: 't' });
  const owner = createOwnerClient({ fetch: f, token: 't' });
  await act(async () => {
    root.render(createElement(ContactsPage, { api, owner }));
    await Promise.resolve();
  });
  await settle();
}
const rows = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('.ct-row')];
const rowText = (i: number, sel: string): string =>
  rows()[i]?.querySelector(sel)?.textContent ?? '';

describe('Contacts rows', () => {
  it('shows the word and a shaped marker on each row, the pulse beside them', async () => {
    await mount();
    expect(rows().length).toBe(3);
    expect(rowText(0, '.act-word')).toBe('Quiet');
    expect(rows()[0]?.querySelector('.act-marker')?.getAttribute('data-shape')).toBe('none');
    expect(rowText(1, '.act-word')).toBe('Today');
    expect(rowText(2, '.act-word')).toBe('Active now');
    expect(rows()[2]?.querySelector('.act-marker')?.getAttribute('data-shape')).toBe('dot');
    expect(rows()[1]?.querySelector('.act-marker')?.getAttribute('data-shape')).toBe('ring');
    expect(rows()[2]?.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      '5 messages in the last 24 hours',
    );
    expect(rows()[2]?.querySelectorAll('.act-bar').length).toBe(12);
  });

  it('keeps the list when the read fails: no word, a flat pulse, no alert', async () => {
    await mount(() => new Response('{}', { status: 503 }));
    expect(rows().length).toBe(3);
    expect(host.querySelector('.act-word')).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('reads once for the whole list and again after 60 seconds, not while hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    await mount();
    expect(pulseReads).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(pulseReads).toBe(2);
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(240_000);
    });
    expect(pulseReads).toBe(2);
  });
});

describe('Most active in Contacts', () => {
  it('sorts by activity then the last exchange, and Recent restores the list order', async () => {
    await mount();
    const radios = (): HTMLElement[] => [
      ...host.querySelectorAll<HTMLElement>('[role="radiogroup"][aria-label="Sort"] [role="radio"]'),
    ];
    expect(radios().map((r) => r.textContent)).toEqual(['Recent', 'Most active']);
    await act(async () => {
      radios()[1]?.click();
    });
    expect(rows().map((r) => r.textContent?.slice(0, 4))).toEqual([
      expect.stringContaining('Cy'),
      expect.stringContaining('Bo'),
      expect.stringContaining('Ana'),
    ]);
    await act(async () => {
      radios()[0]?.click();
    });
    expect(rows()[0]?.textContent).toContain('Ana');
  });
});

describe('axe', () => {
  it('finds no WCAG A/AA violation on the list with pulses and the sort', async () => {
    await mount();
    const r = await axe.run(host, {
      runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});
