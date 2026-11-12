// @vitest-environment jsdom
// REL051-B1 (N2; 08 §1): an accept that waits on a person blocked here. The server flags the row
// (`blocked`), and both buttons are real:
// - Cancel posts `POST /api/ui/invites/connecting/cancel` (the invite kind, body `{ref}`); the row
//   leaves only when the server says it is gone, and says so when it could not cancel.
// - Unblock, for a person who is not in the list (blocked and then removed), asks for owner presence
//   on People and posts `POST /api/ui/contacts/:ref/unblock`; the page never signs.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../api/client.js';
import { ConnectingInviteRow } from '../invite/pending-row.js';
import { FEEDBACK_STRINGS as F } from '../invite/strings.js';
import { ContactsPage, type ContactsPageProps } from './index.js';
import { CONNECTING_CANCEL_PATH, createInviteApi, type ConnectingRow } from './invite-api.js';
import { createOwnerClient } from './owner.js';
import { CONTACTS_STRINGS as S } from './strings.js';

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

const BO = `0x${'b0'.repeat(20)}`;
const EXPIRES = '2099-01-15T08:00:00Z';
const row: ConnectingRow = {
  ref: BO,
  name: 'Bo',
  expiresAt: Date.parse(EXPIRES),
  sent: true,
  again: false,
  blocked: true,
};

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

function server(routes: Record<string, { status: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const raw = init?.body;
    const body =
      raw === undefined || raw === null
        ? ''
        : ArrayBuffer.isView(raw)
          ? new TextDecoder().decode(raw)
          : String(raw);
    calls.push({ url, method, headers: new Headers(init?.headers), body });
    const found = routes[`${method} ${url}`];
    const answer = found ?? { status: 404, body: {} };
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetch: fetchFn as typeof fetch };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const buttons = (label: string): HTMLButtonElement[] =>
  [...host.querySelectorAll('button')].filter((b) => (b.textContent ?? '').trim() === label);

async function click(label: string): Promise<void> {
  const [found] = buttons(label);
  if (found === undefined) throw new Error(`no button "${label}" in: ${host.textContent ?? ''}`);
  await act(async () => {
    found.click();
  });
  await settle();
}

describe('ConnectingInviteRow: Cancel is real (N2)', () => {
  it('asks the server; the row leaves only once it is cancelled', async () => {
    const onCancel = vi.fn(() => Promise.resolve('cancelled' as const));
    act(() => root.render(h(ConnectingInviteRow, { row, onCancel })));
    await click(F.cancelConnecting);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(host.querySelector('li')).toBeNull();
  });

  it('keeps the row and says so when the server could not cancel', async () => {
    const onCancel = vi.fn(() => Promise.resolve('failed' as const));
    act(() => root.render(h(ConnectingInviteRow, { row, onCancel })));
    await click(F.cancelConnecting);
    expect(host.querySelector('li')).not.toBeNull();
    expect(host.textContent).toContain(F.cancelConnectingFailed);
  });

  it('offers no Cancel it cannot carry out', () => {
    act(() => root.render(h(ConnectingInviteRow, { row })));
    expect(buttons(F.cancelConnecting)).toEqual([]);
  });
});

describe('createInviteApi().cancelConnecting (N2)', () => {
  it('posts exactly {ref} as the invite kind and reads the answer', async () => {
    const s = server({
      [`POST ${CONNECTING_CANCEL_PATH}`]: { status: 200, body: { status: 'cancelled' } },
    });
    const api = createInviteApi({ fetch: s.fetch, token: 't' });
    expect(CONNECTING_CANCEL_PATH).toBe('/api/ui/invites/connecting/cancel');
    expect(await api.cancelConnecting(BO)).toEqual({ kind: 'cancelled' });
    const [call] = s.calls;
    expect(call?.method).toBe('POST');
    expect(JSON.parse(call?.body ?? '')).toEqual({ ref: BO });
    expect(call?.headers.get('content-type')).toBe('application/octet-stream');
    expect(call?.headers.get('x-agentlink-input')).toBeNull();
    expect(call?.headers.get('x-agentlink-presence')).toBeNull();
    // A ref of another shape never leaves the page.
    expect(await api.cancelConnecting('bo')).toEqual({ kind: 'failed' });
    expect(s.calls).toHaveLength(1);
  });

  it('answers not_found and failed', async () => {
    const gone = server({
      [`POST ${CONNECTING_CANCEL_PATH}`]: { status: 404, body: { error: 'not_found' } },
    });
    expect(await createInviteApi({ fetch: gone.fetch, token: 't' }).cancelConnecting(BO)).toEqual({
      kind: 'not_found',
    });
    const down = server({});
    down.fetch = (() => Promise.resolve(new Response('{}', { status: 503 }))) as typeof fetch;
    expect(await createInviteApi({ fetch: down.fetch, token: 't' }).cancelConnecting(BO)).toEqual({
      kind: 'failed',
    });
  });
});

describe('People: a waiting accept on a person blocked and then removed (N2)', () => {
  async function mount(extra: Record<string, { status: number; body: unknown }> = {}) {
    const s = server({
      'GET /api/owner/passkey': {
        status: 200,
        body: { passkey: { registered: false, rpId: 'localhost', userId: 'AA', prfSalt: 'AA' } },
      },
      'GET /api/ui/contacts': { status: 200, body: { status: 'ok', contacts: [] } },
      'GET /api/ui/invites': {
        status: 200,
        body: {
          invites: [],
          connecting: [
            { ref: BO, name: 'Bo', expiresAt: EXPIRES, sent: true, again: false, blocked: true },
          ],
        },
      },
      ...extra,
    });
    const api = createApiClient({ fetch: s.fetch, token: 't' });
    const owner = createOwnerClient({ fetch: s.fetch, token: 't' });
    const invites = createInviteApi({ fetch: s.fetch, token: 't' });
    await act(async () => {
      root.render(h<ContactsPageProps>(ContactsPage, { api, owner, invites, pollMs: 60_000 }));
      await Promise.resolve();
    });
    await settle();
    return s.calls;
  }

  it('says they are blocked; Unblock asks for presence and posts /unblock for that person', async () => {
    const calls = await mount({
      [`POST /api/ui/contacts/${BO}/unblock`]: { status: 200, body: { status: 'done' } },
    });
    expect(host.textContent).toContain(F.youBlocked('Bo'));
    await click(F.unblockAction);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(host.textContent).toContain('Unblock Bo.');
    const input = host.querySelector<HTMLInputElement>('input[name="owner-code"]');
    if (input === null) throw new Error('no master code field');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'ABCD-EFGH',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(S.confirmWithCode);
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.url)).toEqual([`/api/ui/contacts/${BO}/unblock`]);
    expect(posts[0]?.headers.get('x-agentlink-input')).toBeNull();
    expect(host.textContent).toContain(S.unblocked);
  });

  it('Cancel posts the waiting accept’s cancel route with its ref', async () => {
    const calls = await mount({
      [`POST ${CONNECTING_CANCEL_PATH}`]: { status: 200, body: { status: 'cancelled' } },
    });
    await click(F.cancelConnecting);
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe(CONNECTING_CANCEL_PATH);
    expect(JSON.parse(post?.body ?? '')).toEqual({ ref: BO });
  });
});
