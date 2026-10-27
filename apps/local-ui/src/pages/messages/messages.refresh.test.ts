// @vitest-environment jsdom
// UI-REFRESH-k: the Messages page after the visual refresh (B-11 §17.2, §13.1, §15; I-5).
// Contact list on level 1, the conversation solid, the shared Skeleton on first load, new contact rows
// enter, inbound text never animates, and the shared Under the hood panel shows metadata only.
import { HoodProvider, lintVocabulary } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, ApiResult } from '../../api/client.js';
import { MessagesPage } from './index.js';
import messagesCss from './messages.css?raw';
import { MESSAGES_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-motion');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.documentElement.removeAttribute('data-motion');
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (Element.prototype as { animate?: unknown }).animate;
  delete (window as { matchMedia?: unknown }).matchMedia;
});

const AT = 1_760_000_000;
const ok = (data: unknown): ApiResult<unknown> => ({ kind: 'ok', status: 200, data });
const ONE = [{ contactId: 'c-marko', name: 'Marko', lastAt: AT + 100, lastInAt: AT + 100 }];
const TWO = [...ONE, { contactId: 'c-zed', name: 'Zed', lastAt: AT + 200, lastInAt: AT + 200 }];
const item = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  at: AT + 10,
  type: 'message',
  text: `CANARY-${id}`,
  files: [],
  receipt: false,
  proof: false,
  size: 512,
  ...extra,
});
const INBOX = {
  items: [
    item('env-1', {
      proof: true,
      url: 'https://drop.example/o/SECRET-URL',
      fileKey: 'SECRET-FILE-KEY',
      proofLink: 'https://basescan.org/tx/0x' + 'ab'.repeat(32),
    }),
    item('env-2'),
  ],
};

type Get = (path: string) => Promise<ApiResult<unknown>>;
function api(conversations: () => unknown, override?: Get): ApiClient {
  const fallback: Get = (path) => {
    if (path === '/api/ui/messages') return Promise.resolve(ok({ conversations: conversations() }));
    if (path.startsWith('/api/ui/messages/c-marko')) return Promise.resolve(ok(INBOX));
    return Promise.resolve(ok({ items: [] }));
  };
  const get = vi.fn((path: string) => (override ?? fallback)(path));
  return { get, post: vi.fn(), owner: vi.fn() } as unknown as ApiClient;
}
const never: Get = () => new Promise<ApiResult<unknown>>(() => undefined);

async function mount(client: ApiClient, hood = false): Promise<void> {
  await act(async () => {
    root.render(h(HoodProvider, { value: hood }, h(MessagesPage, { api: client })));
  });
}
async function click(el: Element | null | undefined): Promise<void> {
  if (el === null || el === undefined) throw new Error('nothing to click');
  await act(async () => {
    (el as HTMLElement).click();
  });
}
const button = (label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
async function openMarko(hood = false): Promise<void> {
  await mount(api(() => ONE), hood);
  await click(button('Marko'));
}

describe('depth', () => {
  it('puts the contact list on a level 1 surface', async () => {
    await mount(api(() => ONE));
    const list = host.querySelector(`ul[aria-label="${S.listLabel}"]`);
    expect(list?.closest('.al-surface[data-level="1"]')).not.toBeNull();
  });

  it('shows each message on a solid level 1 surface, with no frosted material', async () => {
    await openMarko();
    const items = [...host.querySelectorAll('.ms-item')];
    expect(items.length).toBe(2);
    for (const i of items) {
      expect(i.classList.contains('al-surface')).toBe(true);
      expect(i.getAttribute('data-level')).toBe('1');
    }
    expect(messagesCss).not.toMatch(/backdrop-filter/);
  });
});

describe('first load', () => {
  it('shows the shared Skeleton after a short wait and no local placeholder', async () => {
    vi.useFakeTimers();
    await mount(api(() => ONE, never));
    expect(host.querySelector('.al-skeleton')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(450);
    });
    const sk = host.querySelector('.al-skeleton');
    expect(sk?.getAttribute('role')).toBe('status');
    expect(sk?.getAttribute('aria-busy')).toBe('true');
    expect(host.querySelector('.ms-skeleton')).toBeNull();
    expect(host.textContent).not.toContain('Loading messages');
    expect(messagesCss).not.toMatch(/\.ms-skeleton/);
  });

  it('shows the shared Skeleton while a conversation loads', async () => {
    vi.useFakeTimers();
    let release: (v: ApiResult<unknown>) => void = () => undefined;
    const client = api(
      () => ONE,
      (p) =>
        p.startsWith('/api/ui/messages/c-marko')
          ? new Promise<ApiResult<unknown>>((r) => (release = r))
          : Promise.resolve(ok({ conversations: ONE })),
    );
    await mount(client);
    await click(button('Marko'));
    await act(async () => {
      vi.advanceTimersByTime(450);
    });
    expect(host.querySelector('.ms-detail .al-skeleton')).not.toBeNull();
    await act(async () => {
      release(ok(INBOX));
      vi.advanceTimersByTime(600);
    });
    expect(host.querySelectorAll('.ms-item').length).toBe(2);
  });
});

describe('new rows enter; inbound text never animates', () => {
  const animate = vi.fn(() => ({ cancel: vi.fn(), reverse: vi.fn(), onfinish: null }));
  const refreshWithNew = async (): Promise<void> => {
    let n = 0;
    await mount(api(() => (n++ === 0 ? ONE : TWO)));
    expect(host.querySelector('.al-row-presence')).toBeNull();
    await click(button(S.refresh));
  };

  it('first load: no row animates; a contact that arrives on refresh enters', async () => {
    (Element.prototype as { animate?: unknown }).animate = animate;
    animate.mockClear();
    await refreshWithNew();
    const rows = [...host.querySelectorAll('ul.ms-list > li')];
    expect(rows.length).toBe(2);
    const entered = rows.filter((r) => r.classList.contains('al-row-presence'));
    expect(entered.length).toBe(1);
    expect(entered[0]?.textContent).toContain('Zed');
    expect(animate).toHaveBeenCalled();
  });

  it('with reduced motion (the app setting) nothing is animated', async () => {
    document.documentElement.setAttribute('data-motion', 'reduced');
    (Element.prototype as { animate?: unknown }).animate = animate;
    animate.mockClear();
    await refreshWithNew();
    expect(host.querySelectorAll('ul.ms-list > li').length).toBe(2);
    expect(animate).not.toHaveBeenCalled();
    expect(host.querySelector('.al-row-hl')).toBeNull();
  });

  it('with reduced motion (the system setting) nothing is animated', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (q: string) => ({
        matches: q.includes('prefers-reduced-motion: reduce'),
        media: q,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    (Element.prototype as { animate?: unknown }).animate = animate;
    animate.mockClear();
    await refreshWithNew();
    expect(host.querySelectorAll('ul.ms-list > li').length).toBe(2);
    expect(animate).not.toHaveBeenCalled();
  });

  it('message text and file names sit in no animated container, and the CSS animates nothing', async () => {
    (Element.prototype as { animate?: unknown }).animate = animate;
    animate.mockClear();
    await openMarko();
    expect(host.querySelector('.ms-item.al-row-presence, .ms-item .al-row-presence')).toBeNull();
    expect(animate).not.toHaveBeenCalled();
    expect(messagesCss).not.toMatch(/@keyframes/);
    expect(messagesCss).not.toMatch(/animation\s*:\s*(?!none)/);
    expect(messagesCss).not.toMatch(/transition\s*:\s*(?!none)/);
    expect(messagesCss).toContain('prefers-reduced-motion');
  });
});

describe('Under the hood', () => {
  it('uses the shared panel, off until the global switch is on', async () => {
    await openMarko(false);
    expect(host.querySelector('.al-hood')).toBeNull();
    expect(host.querySelector('details')).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    await openMarko(true);
    expect(host.querySelector('details')).toBeNull();
    expect(host.querySelector('.ms-hood')).toBeNull();
    expect(host.querySelectorAll('.ms-item .al-hood').length).toBe(2);
  });

  it('shows the message ID, the size and the proof status', async () => {
    await openMarko(true);
    const first = host.querySelectorAll('.ms-item .al-hood')[0];
    const rows = [...(first?.querySelectorAll('.al-hood-row') ?? [])].map((r) => [
      r.querySelector('dt')?.textContent,
      r.querySelector('dd')?.textContent,
    ]);
    expect(rows).toEqual([
      [S.idLabel, 'env-1'],
      [S.sizeLabel, '512 B'],
      [S.proofLabel, S.proofYes],
    ]);
    expect(host.querySelectorAll('.ms-item .al-hood')[1]?.textContent).toContain(S.proofNo);
  });

  it('omits the public record link (the server sends a yes or no) and anything it should not send', async () => {
    await openMarko(true);
    for (const p of host.querySelectorAll('.ms-item .al-hood')) {
      expect(p.querySelector('a')).toBeNull();
    }
    expect(host.textContent).not.toContain('SECRET');
    expect(host.innerHTML).not.toMatch(/drop\.example|basescan/);
  });

  it('drops an ID the panel does not accept, without a trace', async () => {
    const long = 'a'.repeat(64);
    const client = api(
      () => ONE,
      (p) =>
        p.startsWith('/api/ui/messages/c-marko')
          ? Promise.resolve(ok({ items: [item(long)] }))
          : Promise.resolve(ok({ conversations: ONE })),
    );
    await mount(client, true);
    await click(button('Marko'));
    const panel = host.querySelector('.ms-item .al-hood');
    expect(panel?.textContent).not.toContain(long);
    expect(panel?.textContent).toContain(S.sizeLabel);
  });
});

describe('still the same page', () => {
  it('keeps Copy text, the reply line, plain text and no compose control', async () => {
    await openMarko();
    expect(host.textContent).toContain(S.reply);
    expect(button(S.copy)).toBeDefined();
    expect(host.querySelector('textarea, input[type="text"], form')).toBeNull();
    expect(host.querySelector('.ms-item a')).toBeNull();
  });

  it('has default text that passes the vocabulary lint', async () => {
    await openMarko(false);
    expect(lintVocabulary(host.textContent ?? '')).toEqual([]);
  });
});

describe('accessibility', () => {
  it('has no axe violations in the list and in a conversation, with the panel open', async () => {
    type Axe = { run: (n: Element, o: unknown) => Promise<{ violations: { id: string }[] }> };
    const axe = (
      (await import(
        /* @vite-ignore */ '../../../../../packages/ui/node_modules/axe-core/axe.js'
      )) as { default: Axe }
    ).default;
    const opts = {
      runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
      rules: { 'color-contrast': { enabled: false } },
    };
    await mount(api(() => ONE), true);
    expect((await axe.run(host, opts)).violations.map((v) => v.id)).toEqual([]);
    await click(button('Marko'));
    expect((await axe.run(host, opts)).violations.map((v) => v.id)).toEqual([]);
  });
});
