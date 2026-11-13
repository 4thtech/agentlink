// @vitest-environment jsdom
// UX1113-N2: the Home person menu. Rename, "They match" and Remove are one step each: the action's own
// button is the sensor; one click -> one gesture -> one POST. A cancelled sensor sends nothing.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../api/client.js';
import type { ContactRow } from '../contacts/data.js';
import type { PresenceProof } from '../contacts/owner.js';
import { PresenceSeamsContext } from '../contacts/presence-button.js';
import { CONTACTS_STRINGS as C } from '../contacts/strings.js';
import { PersonMenu } from './person-menu.js';
import { HOME_STRINGS as S } from './people-strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REF = '0x4c21a0f700000000000000000000000000000002';
const CONTACT = {
  ref: REF,
  name: 'Ana',
  nameSource: 'counterparty',
  fingerprint: '4C21·A0F7',
  label: 'self-declared',
  status: 'active',
  pairing: 'complete',
  since: 1_759_449_600,
} as unknown as ContactRow;
const PROOF: PresenceProof = { kind: 'code', code: 'ABCD-EFGH' };
const answer: { proof: PresenceProof | undefined } = { proof: PROOF };
const gesture = vi.fn(() => Promise.resolve(answer.proof));

let host: HTMLElement;
let root: Root;
let posts: string[];
beforeEach(() => {
  gesture.mockClear();
  answer.proof = PROOF;
  posts = [];
  // A passkey-capable browser (the person menu reads its own owner client).
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

const settle = async (ms = 0): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  }
};
const named = (pattern: RegExp): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button, [role="menuitem"]')].find((b) =>
    pattern.test((b.textContent ?? '').trim()),
  ) as HTMLButtonElement | undefined;
const click = async (el: HTMLElement | undefined): Promise<void> => {
  if (el === undefined) throw new Error(`no control in: ${host.textContent ?? ''}`);
  await act(async () => {
    el.click();
  });
  await settle();
};

const fetchFn = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input.toString();
  if ((init?.method ?? 'GET') === 'POST') posts.push(url);
  const body = url.includes('/rename-check')
    ? { status: 'ok' }
    : url.includes('/safety-code')
      ? { status: 'ok', code: '4821 0937 5512' }
      : url.includes('/api/owner/passkey')
        ? {
            passkey: {
              registered: true,
              rpId: 'localhost',
              credentialId: 'CQ',
              prfSalt: 'BQY',
              userId: 'AQ',
            },
          }
        : { status: 'done' };
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}) as typeof fetch;

async function show(): Promise<void> {
  const api = createApiClient({ fetch: fetchFn, token: 't' });
  await act(async () => {
    root.render(
      createElement(
        PresenceSeamsContext.Provider,
        { value: { gesture, platform: 'mac', userAgent: 'Mozilla/5.0 (Macintosh)' } },
        createElement(PersonMenu, {
          name: 'Ana',
          contact: CONTACT,
          api,
          fetch: fetchFn,
          token: 't',
          onChanged: () => undefined,
        }),
      ),
    );
  });
  await settle();
  await click(host.querySelector<HTMLButtonElement>('button[aria-label^="More for"]') ?? undefined);
}

describe('Home person menu: one step, one gesture', () => {
  it('Remove: asks once in words; its one button is the gesture; one POST', async () => {
    await show();
    await click(named(new RegExp(`^${S.remove}$`)));
    expect(host.textContent).toContain('Remove Ana?');
    expect(gesture).not.toHaveBeenCalled();
    await click(named(/^Remove with /));
    expect(gesture).toHaveBeenCalledTimes(1);
    expect(posts).toEqual([`/api/ui/contacts/${REF}/remove`]);
    expect(host.querySelector('input[name="owner-code"]')).toBeNull();
  });

  it('Rename: the name is checked while typing; one click, one gesture, one POST', async () => {
    await show();
    await click(named(new RegExp(`^${S.rename}$`)));
    const input = host.querySelector<HTMLInputElement>('input[type="text"]');
    if (input === null) throw new Error('no field');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'Ana K',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle(400);
    await click(named(/^Rename with /));
    expect(gesture).toHaveBeenCalledTimes(1);
    expect(posts).toEqual([`/api/ui/contacts/${REF}/rename`]);
  });

  it('They match: the button is the gesture', async () => {
    await show();
    await click(named(new RegExp(`^${S.checkSafetyCode}$`)));
    await click(named(/^They match · /));
    expect(gesture).toHaveBeenCalledTimes(1);
    expect(posts).toEqual([`/api/ui/contacts/${REF}/check`]);
  });

  it('a cancelled sensor sends nothing and keeps the step', async () => {
    answer.proof = undefined;
    await show();
    await click(named(new RegExp(`^${S.remove}$`)));
    await click(named(/^Remove with /));
    expect(gesture).toHaveBeenCalledTimes(1);
    expect(posts).toEqual([]);
    expect(host.textContent).toContain('Remove Ana?');
    expect(host.textContent).toContain(C.passkeyNotUsed);
  });

  it('the master code link opens the code field, no gesture', async () => {
    await show();
    await click(named(new RegExp(`^${S.remove}$`)));
    await click(named(new RegExp(`^${C.useCode}$`)));
    expect(gesture).not.toHaveBeenCalled();
    expect(host.querySelector('input[name="owner-code"]')).not.toBeNull();
    expect(posts).toEqual([]);
  });
});
