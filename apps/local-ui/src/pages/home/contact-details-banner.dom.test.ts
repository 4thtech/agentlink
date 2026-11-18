// @vitest-environment jsdom
// RELAY-CARD-MIGRATION (S2; 04 §2.5, §2.6; 08 §1; 11 §5): Home's "Update your contact details".
// - Shown only while `GET /api/ui/contact-details` answers `needed`.
// - Its one button is the owner gesture (Touch ID, passkey or the master code, as every owner
//   action); the proof goes to `POST /api/ui/contact-details`. The page never signs.
// - After it is done the notice disappears. The copy never says "relay" (11 §5).
import { HoodProvider } from '@4thtech-io/ui';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOwnerClient } from '../contacts/owner.js';
import { createAgentsApi } from '../agents/api.js';
import {
  CONTACT_DETAILS_PATH,
  CONTACT_DETAILS_TEXT,
  ContactDetailsBanner,
} from './contact-details-banner.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Call {
  url: string;
  method: string;
}
let host: HTMLElement;
let root: Root;
let calls: Call[];
let answers: Record<string, { status: number; body: unknown }>;

const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  calls.push({ url, method });
  const a = answers[`${method} ${url}`] ?? { status: 404, body: {} };
  return new Response(JSON.stringify(a.body), { status: a.status });
}) as typeof fetch;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  calls = [];
  answers = {
    'GET /api/owner/passkey': {
      status: 200,
      body: { passkey: { registered: false, rpId: 'localhost', userId: 'AA', prfSalt: 'AA' } },
    },
    [`GET ${CONTACT_DETAILS_PATH}`]: { status: 200, body: { status: 'needed' } },
    [`POST ${CONTACT_DETAILS_PATH}`]: { status: 200, body: { status: 'done', contacts: 2 } },
  };
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation(() => undefined);
  }
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
async function mount(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        HoodProvider,
        { value: false },
        createElement(ContactDetailsBanner, {
          api: createAgentsApi({ fetch: fetchFn, token: 't' }),
          owner: createOwnerClient({ fetch: fetchFn, token: 't' }),
          agentKey: 'cc-test',
        }),
      ),
    );
  });
  await settle();
}
const button = (text: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text,
  );
async function click(el: Element | undefined): Promise<void> {
  expect(el).toBeTruthy();
  await act(async () => (el as HTMLElement).click());
  await settle();
}
async function confirmWithCode(): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('input[name="owner-code"]');
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      '123456',
    );
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  await click(button('Confirm with your master code'));
}
const posts = () => calls.filter((c) => c.method === 'POST' && c.url === CONTACT_DETAILS_PATH);

describe('Update your contact details (Home)', () => {
  it('shows while needed; never says "relay"', async () => {
    await mount();
    expect(host.textContent).toContain(CONTACT_DETAILS_TEXT.title);
    expect(host.textContent).toContain(CONTACT_DETAILS_TEXT.body);
    expect(host.textContent ?? '').not.toMatch(/relay/i);
  });

  it('the button needs the owner gesture first; nothing is posted without it', async () => {
    await mount();
    await click(button(CONTACT_DETAILS_TEXT.withCode));
    expect(posts()).toHaveLength(0);
    await confirmWithCode();
    expect(posts()).toHaveLength(1);
  });

  it('disappears once updated', async () => {
    await mount();
    await click(button(CONTACT_DETAILS_TEXT.withCode));
    answers[`GET ${CONTACT_DETAILS_PATH}`] = { status: 200, body: { status: 'current' } };
    await confirmWithCode();
    expect(host.textContent).not.toContain(CONTACT_DETAILS_TEXT.title);
  });

  it('nothing shows when the details are current', async () => {
    answers[`GET ${CONTACT_DETAILS_PATH}`] = { status: 200, body: { status: 'current' } };
    await mount();
    expect(host.textContent).not.toContain(CONTACT_DETAILS_TEXT.title);
  });
});
