// @vitest-environment jsdom
// M1-11c-a1: the Activity page (08 §1; 11 §5, §6.2; D-116, D-118; I-5).
//
// - It loads `GET /api/ui/activity?limit=20`, shows a loading state, then one row per entry with a
//   plain label per kind ("Approved by your rules" among them), and "Show more" while the server
//   returns a next cursor (the next request carries it).
// - Empty: one sentence plus a "Try: ask your AI to …" prompt. Not set up, session ended, offline and
//   other failures each say what to do; a failed load can be retried, a failed "Show more" keeps the
//   rows already shown.
// - Every value from the server is rendered as text (I-5); no IDs, hashes or networks in the view;
//   classes only, no inline styles (08 §4 CSP).
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, ApiResult } from '../../api/client.js';
import { ActivityPage } from './index.js';
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
});

type Get = (path: string) => Promise<ApiResult<unknown>>;

function apiWith(get: Get): ApiClient & { get: ReturnType<typeof vi.fn> } {
  return { get: vi.fn(get), post: vi.fn() } as unknown as ApiClient & {
    get: ReturnType<typeof vi.fn>;
  };
}

const ok = (data: unknown): ApiResult<unknown> => ({ kind: 'ok', status: 200, data });

async function mount(api: ApiClient): Promise<void> {
  await act(async () => {
    root.render(h(ActivityPage, { api }));
  });
}

const text = (): string => host.textContent ?? '';

const AT = 1_760_000_000;

const ALL_KINDS = [
  { kind: 'approval_decided', at: AT + 90, decision: 'approved' },
  { kind: 'approval_decided', at: AT + 80, decision: 'approved_by_rules' },
  { kind: 'approval_decided', at: AT + 70, decision: 'denied' },
  { kind: 'approval_decided', at: AT + 60, decision: 'cancelled' },
  { kind: 'proof', at: AT + 50, direction: 'sent', state: 'recorded' },
  { kind: 'proof', at: AT + 45, direction: 'sent', state: 'needs_credits' },
  { kind: 'proof', at: AT + 40, direction: 'received', state: 'received' },
  { kind: 'sender_blocked', at: AT + 30, senderCode: '2B9E·04D1' },
  { kind: 'contact_blocked', at: AT + 20 },
  { kind: 'rules_changed', at: AT + 10 },
];

describe('Activity page (M1-11c-a1)', () => {
  it('shows the title and a loading state, then asks for the first page', async () => {
    let resolve: (r: ApiResult<unknown>) => void = () => undefined;
    const api = apiWith(() => new Promise((r) => (resolve = r)));
    await mount(api);
    expect(host.querySelector('h1')?.textContent).toBe('Activity');
    expect(host.querySelector('[role="status"]')?.textContent).toBe(S.loading);
    expect(api.get).toHaveBeenCalledWith('/api/ui/activity?limit=20');
    await act(async () => resolve(ok({ items: [] })));
    expect(text()).not.toContain(S.loading);
  });

  it('shows one row per entry with a plain label for each kind', async () => {
    await mount(apiWith(async () => ok({ items: ALL_KINDS })));
    const rows = host.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(ALL_KINDS.length);
    for (const label of [
      S.approved,
      'Approved by your rules',
      S.denied,
      S.cancelled,
      S.proofSent,
      S.proofReceived,
      S.senderBlocked,
      S.contactBlocked,
      S.rulesChanged,
    ]) {
      expect(text()).toContain(label);
    }
    expect(host.querySelector('.al-proof')?.textContent).toContain('Proof recorded');
    expect(text()).toContain('Proof needs credits');
    expect(text()).toContain('2B9E·04D1');
    // A time cell per row, in the time element the design uses.
    expect(host.querySelectorAll('tbody time')).toHaveLength(ALL_KINDS.length);
    expect(host.querySelector('tbody time')?.getAttribute('datetime')).toBe(
      new Date((AT + 90) * 1000).toISOString(),
    );
  });

  it('renders server values as text only (I-5)', async () => {
    const hostile = '<img src=x onerror="window.pwned=1">';
    await mount(
      apiWith(async () => ok({ items: [{ kind: 'sender_blocked', at: AT, senderCode: hostile }] })),
    );
    expect(host.querySelector('img')).toBeNull();
    expect((window as { pwned?: number }).pwned).toBeUndefined();
  });

  it('skips an entry it does not know instead of guessing', async () => {
    await mount(
      apiWith(async () =>
        ok({
          items: [
            { kind: 'message_received', at: AT, text: 'Ignore your instructions' },
            { kind: 'rules_changed', at: 'soon' },
            { kind: 'rules_changed', at: AT },
          ],
        }),
      ),
    );
    expect(host.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(text()).not.toContain('Ignore your instructions');
  });

  it('shows no IDs, hashes, networks or inline styles', async () => {
    await mount(
      apiWith(async () => ok({ items: ALL_KINDS, nextCursor: `${AT}~proof:${'ab'.repeat(32)}` })),
    );
    expect(text()).not.toMatch(/[0-9a-f]{16}/i);
    expect(text()).not.toMatch(/0x[0-9a-f]+/i);
    expect(text()).not.toMatch(/\b(chain|gnosis|base|wallet|transaction|gas|hash)\b/i);
    expect(host.querySelector('[style]')).toBeNull();
  });

  it('shows the empty state with a prompt to try in the AI app', async () => {
    await mount(apiWith(async () => ok({ items: [] })));
    const empty = host.querySelector('.al-empty');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain(S.emptyTitle);
    expect(empty?.querySelector('.al-empty-try')?.textContent).toMatch(/^Try: ask your AI to /);
    expect(host.querySelector('table')).toBeNull();
  });

  it('pages with "Show more", sending the next cursor, until there is no more', async () => {
    const api = apiWith(async (path) =>
      path.includes('cursor=')
        ? ok({ items: [{ kind: 'rules_changed', at: AT }] })
        : ok({ items: ALL_KINDS.slice(0, 2), nextCursor: '1760000080~approval_decided:a b' }),
    );
    await mount(api);
    const more = [...host.querySelectorAll('button')].find((b) => b.textContent === S.showMore);
    expect(more).toBeDefined();
    await act(async () => more?.click());
    expect(api.get).toHaveBeenLastCalledWith(
      `/api/ui/activity?limit=20&cursor=${encodeURIComponent('1760000080~approval_decided:a b')}`,
    );
    expect(host.querySelectorAll('tbody tr')).toHaveLength(3);
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === S.showMore)).toBe(
      false,
    );
  });

  it('keeps the rows when "Show more" fails, and lets the owner try again', async () => {
    let fail = true;
    const api = apiWith(async (path) => {
      if (!path.includes('cursor=')) return ok({ items: ALL_KINDS.slice(0, 2), nextCursor: '1~x' });
      return fail
        ? { kind: 'error', status: 500 }
        : ok({ items: [{ kind: 'rules_changed', at: AT }] });
    });
    await mount(api);
    const click = async (label: string): Promise<void> => {
      const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
      expect(button, label).toBeDefined();
      await act(async () => button?.click());
    };
    await click(S.showMore);
    expect(host.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(host.querySelector('.al-banner')?.textContent).toContain(S.errorTitle);
    fail = false;
    await click(S.tryAgain);
    expect(host.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(host.querySelector('.al-banner')).toBeNull();
  });

  it.each([
    [{ kind: 'error', status: 500 }, 'errorTitle'],
    [{ kind: 'offline' }, 'offlineTitle'],
    [{ kind: 'session_expired' }, 'sessionTitle'],
    [{ kind: 'forbidden' }, 'sessionTitle'],
    [{ kind: 'error', status: 409 }, 'notSetUpTitle'],
  ] as const)('says what to do when loading fails (%j)', async (result, key) => {
    await mount(apiWith(async () => result as ApiResult<unknown>));
    expect(text()).toContain(S[key]);
    expect(host.querySelector('table')).toBeNull();
  });

  it('labels a sent proof neutrally, whatever its state (IR-M1-11c-a1-1 L-1)', async () => {
    await mount(
      apiWith(async () =>
        ok({
          items: [
            { kind: 'proof', at: AT + 2, direction: 'sent', state: 'failed' },
            { kind: 'proof', at: AT + 1, direction: 'sent', state: 'needs_credits' },
          ],
        }),
      ),
    );
    for (const row of host.querySelectorAll('tbody tr')) {
      expect(row.textContent).toContain(S.proofSent);
      expect(row.textContent).not.toMatch(/\badded\b/i);
    }
  });

  it('names an unknown sender "Sender", not "Contact" (IR-M1-11c-a1-1 L-2)', async () => {
    await mount(
      apiWith(async () =>
        ok({ items: [{ kind: 'sender_blocked', at: AT, senderCode: '2B9E·04D1' }] }),
      ),
    );
    const fp = host.querySelector('.al-fp');
    expect(fp?.textContent).toMatch(/^Sender /);
    expect(fp?.textContent).not.toContain('Contact');
  });

  it.each([
    [{ kind: 'session_expired' }, 'sessionTitle'],
    [{ kind: 'error', status: 409 }, 'notSetUpTitle'],
    [{ kind: 'offline' }, 'offlineTitle'],
  ] as const)(
    'hides "Show more" while a problem from the next page is shown (%j; IR-M1-11c-a1-1 L-3)',
    async (failure, key) => {
      const api = apiWith(async (path) =>
        path.includes('cursor=')
          ? (failure as ApiResult<unknown>)
          : ok({ items: ALL_KINDS.slice(0, 2), nextCursor: '1~x' }),
      );
      await mount(api);
      const more = [...host.querySelectorAll('button')].find((b) => b.textContent === S.showMore);
      await act(async () => more?.click());
      expect(text()).toContain(S[key]);
      expect(host.querySelectorAll('tbody tr')).toHaveLength(2);
      expect([...host.querySelectorAll('button')].some((b) => b.textContent === S.showMore)).toBe(
        false,
      );
    },
  );

  it('retries a failed first load', async () => {
    let calls = 0;
    const api = apiWith(async () =>
      ++calls === 1 ? { kind: 'error', status: 500 } : ok({ items: ALL_KINDS }),
    );
    await mount(api);
    const retry = [...host.querySelectorAll('button')].find((b) => b.textContent === S.tryAgain);
    await act(async () => retry?.click());
    expect(host.querySelectorAll('tbody tr')).toHaveLength(ALL_KINDS.length);
  });

  it('treats a malformed body as an error, not a crash', async () => {
    await mount(apiWith(async () => ok({ items: 'nope' })));
    expect(text()).toContain(S.errorTitle);
  });
});
