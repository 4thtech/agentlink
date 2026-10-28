// @vitest-environment jsdom
// UX2-h (S1): the compact view, b11 §25. No message text anywhere; never approves (Review opens the
// main app); one screen at 50+ contacts; every state of §25.2; axe; reduced motion; 320 px.
import axe from 'axe-core';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, ApiResult } from '../../api/client.js';
import { resetHealthFeedForTests } from '../../layout/health-feed.js';
import type { ApprovalItem, ListAnswer } from '../approvals/client.js';
import compactCss from './compact.css?raw';
import { HomePage } from '../home/index.js';
import { CompactPage, type CompactPageProps } from './index.js';
import { COMPACT_STRINGS as S } from './strings.js';

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
  resetHealthFeedForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setHidden(false);
});

const ok = (data: unknown): ApiResult<unknown> => ({ kind: 'ok', status: 200, data });
const NOW = new Date(2026, 9, 28, 14, 30, 0);
const SEC = Math.floor(NOW.getTime() / 1000);
const ref = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const HEALTH = {
  agent: 'running',
  relays: { connected: 3, total: 3 },
  lastSyncAt: SEC,
  version: '0.4.2',
};
const CREDITS = {
  status: 'ok',
  proofsLeft: 48,
  balance: '$4.80',
  price: '$0.10',
  test: false,
  partial: false,
};

function contacts(n: number): unknown {
  return {
    status: 'ok',
    contacts: Array.from({ length: n }, (_, i) => ({
      ref: ref(i + 1),
      name: `Person ${String(i + 1)}`,
      nameSource: 'owner',
      label: 'self-declared',
      status: 'active',
      pairing: 'complete',
      since: SEC - 86_400,
    })),
  };
}
function pulse(n: number): unknown {
  return {
    now: SEC,
    bucketSeconds: 7200,
    partial: false,
    contacts: Array.from({ length: n }, (_, i) => {
      const counts = Array.from({ length: 12 }, () => 0);
      counts[11] = i + 1;
      return {
        contactId: ref(i + 1),
        counts,
        lastAt: i === n - 1 ? SEC - 60 : SEC - 3600,
        activity: i === n - 1 ? 'active_now' : 'today',
        // Must never reach the page.
        text: 'PRIVATE MESSAGE TEXT',
        fileName: 'secret-plan.pdf',
      };
    }),
  };
}
const approval = (over: Partial<ApprovalItem> = {}): ApprovalItem => ({
  approvalId: `apr_${'A'.repeat(22)}`,
  summary: 'Send a file to Marko',
  actionDigest: 'f'.repeat(64),
  expiresAt: SEC + 9 * 60,
  commitment: false,
  paid: false,
  ...over,
});

interface Answers {
  health?: ApiResult<unknown>;
  contacts?: ApiResult<unknown>;
  pulse?: ApiResult<unknown>;
  credits?: ApiResult<unknown>;
  approvals?: ListAnswer;
}
function setup(a: Answers = {}): {
  props: CompactPageProps;
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  openMain: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn(async (path: string): Promise<ApiResult<unknown>> => {
    if (path === '/api/ui/health') return a.health ?? ok(HEALTH);
    if (path === '/api/ui/contacts') return a.contacts ?? ok(contacts(3));
    if (path === '/api/ui/messages/pulse') return a.pulse ?? ok(pulse(3));
    if (path === '/api/ui/proofs/credits') return a.credits ?? ok(CREDITS);
    return { kind: 'error', status: 404 };
  });
  const post = vi.fn();
  const openMain = vi.fn();
  const props: CompactPageProps = {
    api: { get, post, owner: vi.fn() } as unknown as ApiClient,
    approvals: { list: async () => a.approvals ?? { kind: 'ok', items: [] } },
    openMain,
    now: () => NOW,
  };
  return { props, get, post, openMain };
}
async function mount(props: CompactPageProps): Promise<void> {
  await act(async () => {
    root.render(h(CompactPage, props));
  });
  await act(async () => {
    await Promise.resolve();
  });
}
const text = (): string => host.textContent ?? '';
const block = (id: string): HTMLElement | null => host.querySelector(`[data-block="${id}"]`);
const find = (label: string): HTMLElement =>
  [...host.querySelectorAll('a, button')].find((e) => e.textContent === label) as HTMLElement;
function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: hidden ? 'hidden' : 'visible',
  });
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('Compact: layout (b11 §25.1)', () => {
  it('has the five blocks in order, titled AgentLink only', async () => {
    const { props } = setup({ approvals: { kind: 'ok', items: [approval()] } });
    await mount(props);
    expect(
      [...host.querySelectorAll('[data-block]')].map((b) => b.getAttribute('data-block')),
    ).toEqual(['agent', 'needs', 'contacts', 'credits', 'footer']);
    expect(document.title).toBe('AgentLink');
    expect(block('agent')?.textContent).toContain('Running');
  });

  it('shows waiting count, the soonest item and Review, with the orange edge', async () => {
    const { props } = setup({
      approvals: {
        kind: 'ok',
        items: [
          approval(),
          approval({ approvalId: `apr_${'B'.repeat(22)}`, expiresAt: SEC + 3600 }),
        ],
      },
    });
    await mount(props);
    const needs = block('needs');
    expect(needs?.textContent).toContain('Waiting for you');
    expect(needs?.textContent).toContain('2');
    expect(needs?.textContent).toContain('Send a file to Marko · 9 min left');
    expect(needs?.getAttribute('data-attention')).toBe('true');
    expect(needs?.querySelector('a, button')?.textContent).toBe('Review');
  });

  it('zero waiting: "Nothing is waiting." and no button', async () => {
    const { props } = setup();
    await mount(props);
    expect(block('needs')?.textContent).toContain('Nothing is waiting.');
    expect(block('needs')?.querySelector('a, button')).toBeNull();
    expect(block('needs')?.getAttribute('data-attention')).toBeNull();
  });

  it('shows credits in one line', async () => {
    const { props } = setup();
    await mount(props);
    expect(block('credits')?.textContent).toContain('$4.80, about 48 proofs');
  });

  it('shows the top five by activity with a word and a pulse image, then "+n more"', async () => {
    const { props } = setup({ contacts: ok(contacts(8)), pulse: ok(pulse(8)) });
    await mount(props);
    const rows = [...(block('contacts')?.querySelectorAll('[data-contact]') ?? [])];
    expect(rows).toHaveLength(5);
    // Person 8 has the most messages and the newest exchange.
    expect(rows[0]?.textContent).toContain('Person 8');
    expect(rows[0]?.textContent).toContain('Active now');
    expect(rows[1]?.textContent).toContain('Today');
    expect(rows[0]?.querySelector('svg[role="img"]')?.getAttribute('aria-label')).toBe(
      '8 messages in the last 24 hours',
    );
    expect(block('contacts')?.textContent).toContain('+3 more');
    expect(block('contacts')?.textContent).toContain('Most active');
  });

  it('fits one screen at 50+ contacts: five rows and one "+n more"', async () => {
    const { props } = setup({ contacts: ok(contacts(60)), pulse: ok(pulse(60)) });
    await mount(props);
    expect(host.querySelectorAll('[data-contact]')).toHaveLength(5);
    expect(block('contacts')?.textContent).toContain('+55 more');
  });

  it('no contacts: "No contacts yet." with Add contact', async () => {
    const { props, openMain } = setup({
      contacts: ok(contacts(0)),
      pulse: ok({ now: SEC, contacts: [] }),
    });
    await mount(props);
    expect(block('contacts')?.textContent).toContain('No contacts yet.');
    act(() => find('Add contact').click());
    expect(openMain).toHaveBeenCalledWith('/settings/contacts?add-contact');
  });

  it('a failed pulse read keeps the contacts, flat and without a word', async () => {
    const { props } = setup({ pulse: { kind: 'error', status: 503 } });
    await mount(props);
    expect(host.querySelectorAll('[data-contact]')).toHaveLength(3);
    expect(text()).not.toContain('Active now');
  });
});

describe('Compact: no message text, never approves', () => {
  it('shows no message text, file name or size', async () => {
    const { props } = setup({ approvals: { kind: 'ok', items: [approval()] } });
    await mount(props);
    expect(text()).not.toContain('PRIVATE MESSAGE TEXT');
    expect(text()).not.toContain('secret-plan');
    expect(host.innerHTML).not.toContain('PRIVATE MESSAGE TEXT');
  });

  it('has no Approve or Deny control and sends nothing', async () => {
    const { props, post } = setup({ approvals: { kind: 'ok', items: [approval()] } });
    await mount(props);
    const labels = [...host.querySelectorAll('a, button')].map((e) => e.textContent ?? '');
    expect(labels.join(' ')).not.toMatch(/approve|deny|allow|confirm|decline/i);
    expect(post).not.toHaveBeenCalled();
    expect(host.querySelector('input, textarea, select, form')).toBeNull();
  });

  it('Review hands over to the main app at Approvals', async () => {
    const { props, openMain, post } = setup({
      approvals: { kind: 'ok', items: [approval()] },
    });
    await mount(props);
    const review = block('needs')?.querySelector('a, button') as HTMLElement;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    act(() => {
      review.dispatchEvent(ev);
    });
    expect(openMain).toHaveBeenCalledWith('/');
    expect(ev.defaultPrevented).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  it('Open AgentLink and "+n more" open the main app', async () => {
    const { props, openMain } = setup({ contacts: ok(contacts(8)), pulse: ok(pulse(8)) });
    await mount(props);
    act(() => find('+3 more').click());
    expect(openMain).toHaveBeenLastCalledWith('/settings/messages');
    act(() => find('Open AgentLink').click());
    expect(openMain).toHaveBeenLastCalledWith('/settings/home');
  });

  it('reads with GET only, from routes that exist', async () => {
    const { props, get } = setup();
    await mount(props);
    const paths = get.mock.calls.map((c) => c[0] as string);
    expect(paths).toContain('/api/ui/messages/pulse');
    expect(paths).toContain('/api/ui/health');
    for (const p of paths) expect(p.startsWith('/api/ui/')).toBe(true);
  });
});

describe('Compact: states (b11 §25.2)', () => {
  it('paused: the word, the line, and the other blocks keep their values', async () => {
    const { props } = setup({ health: ok({ ...HEALTH, agent: 'paused' }) });
    await mount(props);
    expect(block('agent')?.textContent).toContain('Paused');
    expect(block('agent')?.textContent).toContain('Nothing is sent or received for now.');
    expect(block('credits')?.textContent).toContain('$4.80');
  });

  it('loading: skeleton blocks in their final sizes', async () => {
    vi.useFakeTimers();
    const never = new Promise<ApiResult<unknown>>(() => undefined);
    const { props } = setup();
    (props.api as unknown as { get: unknown }).get = vi.fn(() => never);
    await mount({ ...props, approvals: { list: () => new Promise<ListAnswer>(() => undefined) } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
    });
    expect(host.querySelectorAll('[data-block]')).toHaveLength(5);
    expect(host.querySelectorAll('.al-skeleton').length).toBeGreaterThan(0);
  });

  it('offline after values: last values marked "as of", Review hidden', async () => {
    vi.useFakeTimers();
    let healthy = true;
    const { props, get } = setup({ approvals: { kind: 'ok', items: [approval()] } });
    get.mockImplementation(async (path: string): Promise<ApiResult<unknown>> => {
      if (path === '/api/ui/health') return healthy ? ok(HEALTH) : { kind: 'offline' };
      if (path === '/api/ui/contacts') return ok(contacts(3));
      if (path === '/api/ui/messages/pulse') return ok(pulse(3));
      if (path === '/api/ui/proofs/credits') return ok(CREDITS);
      return { kind: 'error', status: 404 };
    });
    await mount(props);
    expect(block('needs')?.querySelector('a, button')?.textContent).toBe('Review');
    healthy = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(text()).toMatch(/as of \d/);
    expect(block('needs')?.querySelector('a, button')).toBeNull();
    expect(block('credits')?.textContent).toContain('$4.80');
  });

  it('process gone (never reached): the whole-app message', async () => {
    const { props, get } = setup({ health: { kind: 'offline' } });
    get.mockImplementation(async () => ({ kind: 'offline' }));
    await mount({ ...props, approvals: { list: async () => ({ kind: 'offline' }) } });
    expect(text()).toContain("AgentLink isn't running. Start your AI app, then reload.");
  });

  it('a read error keeps old values and says it is trying again', async () => {
    vi.useFakeTimers();
    let broken = false;
    const { props, get } = setup();
    get.mockImplementation(async (path: string): Promise<ApiResult<unknown>> => {
      if (broken) return { kind: 'error', status: 500 };
      if (path === '/api/ui/health') return ok(HEALTH);
      if (path === '/api/ui/contacts') return ok(contacts(3));
      if (path === '/api/ui/messages/pulse') return ok(pulse(3));
      if (path === '/api/ui/proofs/credits') return ok(CREDITS);
      return { kind: 'error', status: 404 };
    });
    await mount(props);
    broken = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(text()).toContain("Couldn't read the latest. Trying again.");
    expect(block('credits')?.textContent).toContain('$4.80');
  });

  it('reserves the agent row for a later second agent (a list, one item today)', async () => {
    const { props } = setup();
    await mount(props);
    expect(block('agent')?.querySelectorAll('[data-agent-row]')).toHaveLength(1);
  });

  it('does not poll while the window is hidden', async () => {
    vi.useFakeTimers();
    const { props, get } = setup();
    await mount(props);
    setHidden(true);
    const before = get.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(get.mock.calls.length).toBe(before);
  });
});

describe('Compact: accessibility and motion', () => {
  it('passes axe, with waiting items and 50+ contacts', async () => {
    const { props } = setup({
      contacts: ok(contacts(60)),
      pulse: ok(pulse(60)),
      approvals: { kind: 'ok', items: [approval()] },
    });
    await mount(props);
    const result = await axe.run(host, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' ')}`)).toEqual(
      [],
    );
  });

  it('has one main landmark and a heading', async () => {
    const { props } = setup();
    await mount(props);
    expect(host.querySelectorAll('main')).toHaveLength(1);
    expect(host.querySelector('h1')).not.toBeNull();
  });

  it('the marker is a shape, not just colour: Active now filled, Today a ring, Quiet none', async () => {
    const { props } = setup({ contacts: ok(contacts(3)), pulse: ok(pulse(2)) });
    await mount(props);
    const kinds = [...host.querySelectorAll('[data-contact]')].map((r) =>
      r.querySelector('[data-marker]')?.getAttribute('data-marker'),
    );
    expect(kinds).toContain('filled');
    expect(kinds).toContain('ring');
    expect(kinds).toContain('none');
  });

  it('reduced motion: no ring pulse element, no animation started', async () => {
    document.documentElement.dataset['motion'] = 'reduced';
    const { props } = setup({ contacts: ok(contacts(3)), pulse: ok(pulse(3)) });
    const animate = vi.fn();
    (Element.prototype as unknown as { animate: unknown }).animate = animate;
    await mount(props);
    expect(animate).not.toHaveBeenCalled();
    expect(host.querySelector('[data-pulse-ring]')).toBeNull();
    delete (Element.prototype as unknown as { animate?: unknown }).animate;
  });

  it('has no inline styles (CSP) and no fixed width that breaks 320 px', async () => {
    const { props } = setup({ contacts: ok(contacts(8)), pulse: ok(pulse(8)) });
    await mount(props);
    expect(host.querySelectorAll('[style]')).toHaveLength(0);
    expect(compactCss).toMatch(/min-inline-size:\s*0|max-inline-size:\s*100%/);
    expect(compactCss).not.toMatch(/(?:min-)?(?:width|inline-size):\s*(?:3[2-9]\d|[4-9]\d\d)px/);
  });
});

describe('Home: Open compact window', () => {
  it('has a secondary button with the external-link icon that opens the compact window', async () => {
    const { props } = setup();
    const open = vi.fn();
    await act(async () => {
      root.render(
        h(HomePage, {
          api: props.api,
          approvals: props.approvals,
          startHere: {
            protect: async () => true,
            contacts: async () => [],
            sent: async () => true,
            kitSaved: () => true,
          },
          platform: 'mac',
          now: props.now,
          openCompact: open,
        } as never),
      );
    });
    const btn = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === S.openCompact,
    ) as HTMLElement;
    expect(btn).toBeDefined();
    expect(btn.className).toContain('al-btn-secondary');
    expect(btn.querySelector('svg')).not.toBeNull();
    act(() => btn.click());
    expect(open).toHaveBeenCalledTimes(1);
  });
});
