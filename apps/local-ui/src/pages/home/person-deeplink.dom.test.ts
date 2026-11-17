// @vitest-environment jsdom
// NOTIFY-DEEPLINK (DESK-WIDGET-TARGET): `/#person=<id>` opens that person's conversation as soon as
// the people are here (also when they arrive late), scrolled to, focused and marked; the same on
// `hashchange` (in-app navigation); an ID that is not in the list says so, with a way to the archived.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPrefsForTests } from '../../prefs/index.js';
import { HomeScreen } from './home-screen.js';
import { HOME_STRINGS as S } from './people-strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
const scroll = vi.fn();
beforeEach(() => {
  localStorage.clear();
  resetPrefsForTests();
  history.replaceState(null, '', '/');
  scroll.mockClear();
  Element.prototype.scrollIntoView = scroll;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.textContent = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetPrefsForTests();
});

const AT = 1_792_000_000;
const DENIS = '0x' + '11'.repeat(20);
const ANA = '0x' + '22'.repeat(20);
const STRANGER = '0x' + '99'.repeat(20);
const people = [
  { contactId: DENIS, name: 'Denis', lastAt: AT + 60, lastInAt: AT + 50 },
  { contactId: ANA, name: 'Ana', lastAt: AT + 10, lastInAt: AT + 10 },
];
const contact = (ref: string, name: string) => ({
  ref,
  name,
  nameSource: 'counterparty',
  fingerprint: '7F3A91C20B4ED8A5',
  label: 'self-declared',
  status: 'active',
  pairing: 'complete',
  since: AT - 86_400,
});

function server(gate?: Promise<void>) {
  const body = (path: string): unknown => {
    if (path === '/api/ui/messages') return { conversations: people };
    if (path === '/api/ui/contacts') {
      return { status: 'ok', contacts: [contact(DENIS, 'Denis'), contact(ANA, 'Ana')] };
    }
    if (path.startsWith('/api/ui/files')) return { items: [] };
    if (path === '/api/approvals') return { approvals: [] };
    if (path === '/api/owner/passkey') return { passkey: null };
    if (path.startsWith('/api/ui/messages/')) return { items: [] };
    return {};
  };
  const fetchFn = async (input: RequestInfo | URL): Promise<Response> => {
    const path = (typeof input === 'string' ? input : input.toString()).split('?')[0] ?? '';
    if (gate !== undefined && path === '/api/ui/messages') await gate;
    return new Response(JSON.stringify(body(path)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return fetchFn as typeof fetch;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
async function mount(f: typeof fetch): Promise<void> {
  vi.stubGlobal('fetch', f);
  await act(async () => {
    root.render(h(HomeScreen, { fetch: f, token: 't', pollMs: 0 }));
  });
  await settle();
}
const opened = (ref: string): HTMLElement | null =>
  document.body.querySelector<HTMLElement>(`[data-person-open="${ref}"]`);

describe('#person= on Home', () => {
  it('opens the conversation, scrolls to it, focuses it and marks it; the fragment is cleared', async () => {
    history.replaceState(null, '', `/#person=${DENIS}`);
    await mount(server());
    const el = opened(DENIS);
    expect(el).not.toBeNull();
    expect(opened(ANA)).toBeNull();
    expect(scroll).toHaveBeenCalled();
    expect(document.activeElement).toBe(el);
    expect(el?.classList.contains('hm-target')).toBe(true);
    expect(el?.getAttribute('aria-label')).toBe('Conversation with Denis');
    expect(location.hash).toBe('');
  });

  it('data that arrives late still opens it, only once people are there', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    history.replaceState(null, '', `/#person=${ANA}`);
    await mount(server(gate));
    expect(opened(ANA)).toBeNull();
    release();
    await settle();
    expect(opened(ANA)).not.toBeNull();
    expect(document.activeElement).toBe(opened(ANA));
  });

  it('a hashchange after Home is up opens that person (in-app navigation)', async () => {
    await mount(server());
    expect(opened(ANA)).toBeNull();
    history.pushState(null, '', `/#person=${ANA}`);
    await act(async () => {
      window.dispatchEvent(new Event('hashchange'));
    });
    await settle();
    expect(opened(ANA)).not.toBeNull();
    expect(document.activeElement).toBe(opened(ANA));
  });

  it('an ID that is not in the list says so, and opens nothing', async () => {
    history.replaceState(null, '', `/#person=${STRANGER}`);
    await mount(server());
    expect(document.body.textContent).toContain(S.contactNotListed);
    expect(document.body.querySelector('[data-person-open]')).toBeNull();
    expect(location.hash).toBe('');
  });

  it('anything else in the fragment is ignored', async () => {
    history.replaceState(null, '', '/#person=../etc');
    await mount(server());
    expect(document.body.textContent).not.toContain(S.contactNotListed);
    expect(document.body.querySelector('[data-person-open]')).toBeNull();
  });

  it('when the conversation never appears the jump gives up quietly', async () => {
    vi.useFakeTimers();
    try {
      history.replaceState(null, '', `/#person=${DENIS}`);
      const f = server();
      vi.stubGlobal('fetch', f);
      const spy = vi.spyOn(document, 'querySelector').mockImplementation(() => null);
      await act(async () => {
        root.render(h(HomeScreen, { fetch: f, token: 't', pollMs: 0 }));
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(spy).toHaveBeenCalled();
      expect(scroll).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain(S.contactNotListed);
    } finally {
      vi.useRealTimers();
    }
  });
});
