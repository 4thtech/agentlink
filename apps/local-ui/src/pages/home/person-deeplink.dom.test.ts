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
  posts.length = 0;
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

const posts: string[] = [];
const FILE_MSG = {
  id: 'AQEBAQEBAQEBAQEBAQEBAQ',
  at: AT + 50,
  text: '',
  files: [{ name: 'plan.pdf', size: 1200 }],
  receipt: false,
  proof: false,
  size: 1200,
};
function server(gate?: Promise<void>, withFile = false) {
  const body = (path: string): unknown => {
    if (path === '/api/ui/messages') return { conversations: people };
    if (path === '/api/ui/contacts') {
      return { status: 'ok', contacts: [contact(DENIS, 'Denis'), contact(ANA, 'Ana')] };
    }
    if (path.startsWith('/api/ui/files')) return { items: [] };
    if (path === '/api/approvals') return { approvals: [] };
    if (path === '/api/owner/passkey') return { passkey: null };
    if (path.startsWith('/api/ui/messages/')) return { items: withFile ? [FILE_MSG] : [] };
    return {};
  };
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = (typeof input === 'string' ? input : input.toString()).split('?')[0] ?? '';
    if (init?.method === 'POST') posts.push(path);
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
/** The mark waits for the conversation to render, checking every 100 ms. */
async function waitMark(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 250));
  });
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
    await waitMark();
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

  // WIDGET-POLISH-0511: the widget's deep link showed a full-area accent box over the conversation
  // while it loaded. Now: no overlay at all, and the mark only once the conversation has rendered.
  it('no full-area overlay; the mark waits until the conversation content is visible', async () => {
    let release: () => void = () => undefined;
    const thread = new Promise<void>((r) => {
      release = r;
    });
    const base = server();
    const gated = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = (typeof input === 'string' ? input : input.toString()).split('?')[0] ?? '';
      if (path.startsWith('/api/ui/messages/')) {
        await thread;
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 'AQEBAQEBAQEBAQEBAQEBAQ',
                at: AT + 50,
                text: 'Here is the plan.',
                files: [],
                receipt: false,
                proof: false,
                size: 1200,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return base(input, init);
    }) as typeof fetch;
    history.replaceState(null, '', `/#person=${DENIS}`);
    await mount(gated);
    await waitMark();
    const el = opened(DENIS);
    expect(el).not.toBeNull();
    expect(document.activeElement).toBe(el);
    // Still loading: focused and scrolled, but not marked.
    expect(el?.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(el?.classList.contains('hm-target')).toBe(false);
    release();
    await settle();
    await waitMark();
    expect(el?.querySelector('[aria-busy="true"]')).toBeNull();
    expect(el?.classList.contains('hm-target')).toBe(true);
    expect(el?.querySelector('.hm-open-head')).not.toBeNull();
    expect(el?.textContent).toContain('Here is the plan.');
    // The stylesheet side (no overlay, opacity only) is checked in deeplink-mark.css.test.ts.
  });

  // OWNER-FB-0512: opening from the widget marks what it was about as seen, as the bell does.
  it("a message link marks that person's messages item read, nothing else", async () => {
    history.replaceState(null, '', `/#person=${DENIS}`);
    await mount(server());
    await waitMark();
    expect(posts).toEqual([`/api/ui/notifications/messages-${DENIS}/read`]);
  });

  it("a file link marks that person's files item read and focuses the newest received file", async () => {
    history.replaceState(null, '', `/#person=${DENIS}&files`);
    await mount(server(undefined, true));
    await waitMark();
    expect(posts).toEqual([`/api/ui/notifications/files-${DENIS}/read`]);
    const row = document.body.querySelector<HTMLElement>('[data-file-newest]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('plan.pdf');
    expect(document.activeElement).toBe(row);
    expect(row?.classList.contains('hm-file-target')).toBe(true);
    // The conversation itself is not marked: the file is.
    expect(opened(DENIS)?.classList.contains('hm-target')).toBe(false);
    expect(location.hash).toBe('');
  });

  it('a person who is not in the list marks nothing', async () => {
    history.replaceState(null, '', `/#person=${STRANGER}`);
    await mount(server());
    expect(posts).toEqual([]);
  });
});
