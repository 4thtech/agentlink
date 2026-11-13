// @vitest-environment jsdom
// RET-6 (D-148; 04 §4.2 "Retention policy"; 08 §1; 11 §5): Settings › Storage › "Keep
// automatically". Two choices from the 06 §3 lists ("Keep messages", "Keep saved files"), the values
// in force, a preview of what a new choice removes now (before anything is signed), and one Save
// button that is the sensor; the press sends exactly `{base, messagesKeepDays, filesKeepDays}` to
// the presence route. Nothing is deleted from this page directly.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, ApiResult } from '../../api/client.js';
import type { PresenceProof } from '../contacts/owner.js';
import { PresenceSeamsContext } from '../contacts/presence-button.js';
import { KeepAutomatically } from './keep.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROOF: PresenceProof = { kind: 'code', code: 'ABCD-EFGH' };
const gesture = vi.fn(() => Promise.resolve<PresenceProof | undefined>(PROOF));

let host: HTMLElement;
let root: Root;
let gets: string[];
let posts: { path: string; input: unknown }[];
let current: unknown;
let saveAnswer: { status: number; body: unknown };

beforeEach(() => {
  gesture.mockClear();
  gets = [];
  posts = [];
  current = { status: 'ok', version: 3, keep: { messagesKeepDays: 0, filesKeepDays: 90 } };
  saveAnswer = { status: 200, body: { status: 'done', version: 4 } };
  (window as { PublicKeyCredential?: unknown }).PublicKeyCredential = class {};
  Object.defineProperty(navigator, 'credentials', { value: {}, configurable: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  act(() => root.unmount());
  host.remove();
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

const api = {
  get: vi.fn((path: string): Promise<ApiResult<unknown>> => {
    gets.push(path);
    const data = path.includes('?')
      ? {
          ...(current as object),
          preview: { messages: { count: 0, bytes: 0 }, files: { count: 4, bytes: 30_000_000 } },
        }
      : current;
    return Promise.resolve({ kind: 'ok', status: 200, data });
  }),
} as unknown as ApiClient;

function decodeInput(value: string | null): unknown {
  if (value === null) return undefined;
  return JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/'))) as unknown;
}

const reply = (status: number, body: unknown): Promise<Response> =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );

const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const path = typeof input === 'string' ? input : input.toString();
  if (path.includes('/api/owner/passkey')) {
    return reply(200, {
      passkey: { registered: true, rpId: 'localhost', credentialId: 'CQ', prfSalt: 'BQY' },
    });
  }
  if ((init?.method ?? 'GET') === 'POST') {
    const headers = new Headers(init?.headers);
    posts.push({ path, input: decodeInput(headers.get('X-AgentLink-Input')) });
    return reply(saveAnswer.status, saveAnswer.body);
  }
  return reply(404, { error: 'not_found' });
}) as typeof fetch;

async function show(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        PresenceSeamsContext.Provider,
        { value: { gesture, platform: 'mac', userAgent: 'Mozilla/5.0 (Macintosh)' } },
        createElement(KeepAutomatically, { api, fetch: fetchFn, token: 't' }),
      ),
    );
  });
  await settle();
}

const text = (): string => host.textContent ?? '';
const selectOf = (label: string): HTMLSelectElement => {
  const el = [...host.querySelectorAll('label')]
    .find((l) => (l.textContent ?? '').includes(label))
    ?.querySelector('select');
  if (el === undefined || el === null) throw new Error(`no ${label} in: ${text()}`);
  return el;
};
const choose = async (label: string, value: string): Promise<void> => {
  const el = selectOf(label);
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
};
const button = (pattern: RegExp): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => pattern.test((b.textContent ?? '').trim()));

describe('Keep automatically (RET-6)', () => {
  it('shows the values in force from the 06 §3 lists, and no Save until something changes', async () => {
    await show();
    expect(gets[0]).toBe('/api/ui/storage/retention');
    expect(text()).toContain('Keep automatically');
    expect(selectOf('Keep messages').value).toBe('0');
    expect(selectOf('Keep saved files').value).toBe('90');
    const values = (label: string): string[] => [...selectOf(label).options].map((o) => o.value);
    expect(values('Keep messages')).toEqual(['0', '90', '365', '730']);
    expect(values('Keep saved files')).toEqual(['0', '30', '90', '180', '365']);
    expect(button(/^Save with Touch ID$/)).toBeUndefined();
    expect(text()).not.toMatch(/wallet|gas|seed phrase|transaction/i);
  });

  it('a new choice first shows what it removes now; Save sends exactly the three fields', async () => {
    await show();
    await choose('Keep saved files', '30');
    expect(gets.at(-1)).toBe('/api/ui/storage/retention?messages=0&files=30');
    expect(text()).toContain('Right now this moves 4 files (30 MB) to the Trash.');
    expect(posts).toEqual([]);
    const save = button(/^Save with Touch ID$/);
    expect(save).toBeDefined();
    await act(async () => {
      save?.click();
    });
    await settle();
    expect(posts).toEqual([
      {
        path: '/api/ui/storage/retention',
        input: { base: 3, messagesKeepDays: 0, filesKeepDays: 30 },
      },
    ]);
    expect(text()).toContain('Saved.');
  });

  it('rules that are not valid: says so and offers no Save', async () => {
    current = { status: 'not_valid' };
    await show();
    expect(text()).toContain('Your rules need to be confirmed again');
    expect(host.querySelector('select')).toBeNull();
  });

  it('a refused save says so and keeps the choice', async () => {
    saveAnswer = { status: 409, body: { error: 'refused' } };
    await show();
    await choose('Keep messages', '365');
    await act(async () => {
      button(/^Save with Touch ID$/)?.click();
    });
    await settle();
    expect(text()).toContain('Nothing was changed.');
    expect(selectOf('Keep messages').value).toBe('365');
  });
});
