// @vitest-environment jsdom
// UX1113-N2: every owner action on People is ONE step. The action's own button is the sensor
// ("Rename with your passkey" here; Touch ID on a Mac), with "Use your master code instead" as a link:
// one click -> exactly one gesture -> exactly one POST. A cancelled gesture keeps the state and sends
// nothing. The master code is the proof when the link is used. No second box after the button.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../api/client.js';
import { ContactsPage, type ContactsPageProps } from './index.js';
import type { OwnerClient, OwnerResult, PasskeyInfo, PresenceProof } from './owner.js';
import { PresenceSeamsContext, type PresenceSeams } from './presence-button.js';
import { DESKTOP_MARKER } from '../../presence/desktop.js';
import { CONTACTS_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The gesture: the test decides what the sensor answers (the presence seam, not the real browser).
const gestureAnswer: { proof: PresenceProof | undefined } = { proof: undefined };
const gesture = vi.fn(() => Promise.resolve(gestureAnswer.proof));

const ANA = '0x4c21a0f700000000000000000000000000000002';
const MARKO = '0x7f3a19c200000000000000000000000000000001';
const PASSKEY: PasskeyInfo = { credentialId: 'cred', prfSalt: 'salt' };
const PROOF: PresenceProof = { kind: 'passkey', gesture: () => Promise.resolve(undefined) };

const ana = {
  ref: ANA,
  name: 'Ana',
  nameSource: 'owner',
  label: 'safety-code-checked',
  status: 'active',
  pairing: 'complete',
  since: 1_759_449_600,
};
const marko = {
  ref: MARKO,
  name: 'Marko Novak',
  nameSource: 'counterparty',
  fingerprint: '7F3A·19C2',
  label: 'self-declared',
  status: 'active',
  pairing: 'complete',
  since: 1_759_449_600,
};

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  gesture.mockClear();
  gestureAnswer.proof = PROOF;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
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
const text = (): string => document.body.textContent ?? '';
const buttons = (): HTMLButtonElement[] => [...document.body.querySelectorAll('button')];
const named = (pattern: RegExp): HTMLButtonElement | undefined =>
  buttons().find((b) => pattern.test((b.textContent ?? '').trim()));
const click = async (el: HTMLElement | undefined): Promise<void> => {
  if (el === undefined) throw new Error(`no control in: ${text()}`);
  await act(async () => {
    el.click();
  });
  await settle();
};
const type = async (selector: string, value: string): Promise<void> => {
  const input = document.body.querySelector<HTMLInputElement>(selector);
  if (input === null) throw new Error(`no input ${selector}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle(400);
};
const openMenu = async (): Promise<void> => {
  await click(
    document.body.querySelector<HTMLButtonElement>('button[aria-label^="More for"]') ?? undefined,
  );
};

interface Rig {
  readonly posts: [string, unknown, PresenceProof][];
}

async function mount(
  contact: Record<string, unknown>,
  result: OwnerResult = { kind: 'done' },
  seams: PresenceSeams = {},
): Promise<Rig> {
  const posts: Rig['posts'] = [];
  const fetchFn = (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = url.endsWith('/api/ui/contacts')
      ? { status: 'ok', contacts: [contact] }
      : url.includes('/rename-check')
        ? { status: 'ok' }
        : url.includes('/safety-code')
          ? { status: 'ok', code: '4821 0937 5512' }
          : {};
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  const api = createApiClient({ fetch: fetchFn as typeof fetch, token: 't' });
  const owner: OwnerClient = {
    passkey: () => Promise.resolve(PASSKEY),
    post: (path, input, proof) => {
      posts.push([path, input, proof]);
      return Promise.resolve(result);
    },
  };
  await act(async () => {
    root.render(
      createElement(
        PresenceSeamsContext.Provider,
        { value: { gesture, platform: 'mac', userAgent: 'Mozilla/5.0 (Macintosh)', ...seams } },
        createElement<ContactsPageProps>(ContactsPage, { api, owner }),
      ),
    );
    await Promise.resolve();
  });
  await settle();
  await act(async () => {
    document.body.querySelector<HTMLButtonElement>('.ct-row')?.click();
  });
  await settle();
  return { posts };
}

const noSecondBox = (): void => {
  expect(document.body.querySelector('input[name="owner-code"]')).toBeNull();
  expect(text()).not.toContain(S.presenceIntro);
};

describe('People: one step, one gesture', () => {
  it('Rename: one click, one gesture, one POST with the alias; no second box', async () => {
    const rig = await mount(ana);
    await openMenu();
    await click(named(new RegExp(`^${S.rename}$`)));
    await type('input[name="alias"]', 'Ana K');
    await click(named(/^Rename with /));
    expect(gesture).toHaveBeenCalledTimes(1);
    expect(rig.posts).toEqual([[`/api/ui/contacts/${ANA}/rename`, { alias: 'Ana K' }, PROOF]]);
    noSecondBox();
  });

  it("Remove: the confirm's one button is the gesture (no third step)", async () => {
    const rig = await mount(ana);
    await openMenu();
    await click(named(new RegExp(`^${S.remove}$`)));
    expect(text()).toContain(S.removeExplain);
    expect(gesture).not.toHaveBeenCalled();
    await click(named(/^Remove with /));
    expect(gesture).toHaveBeenCalledTimes(1);
    expect(rig.posts).toEqual([[`/api/ui/contacts/${ANA}/remove`, undefined, PROOF]]);
    noSecondBox();
  });

  it('They match: the button is the gesture and posts the code that was shown', async () => {
    const rig = await mount(marko);
    await click(named(/^They match · /));
    expect(gesture).toHaveBeenCalledTimes(1);
    expect(rig.posts).toEqual([
      [`/api/ui/contacts/${MARKO}/check`, { code: '4821 0937 5512' }, PROOF],
    ]);
    noSecondBox();
  });

  it('Block: explains first, then the one button is the gesture', async () => {
    const rig = await mount(ana);
    await openMenu();
    await click(named(new RegExp(`^${S.block}$`)));
    expect(text()).toContain(S.blockExplain);
    await click(named(/^Block with /));
    expect(gesture).toHaveBeenCalledTimes(1);
    expect(rig.posts).toEqual([[`/api/ui/contacts/${ANA}/block`, undefined, PROOF]]);
    noSecondBox();
  });

  it('Unblock: one button on the blocked person is the gesture', async () => {
    const rig = await mount({ ...ana, status: 'blocked' });
    await click(named(/^Unblock with /));
    expect(gesture).toHaveBeenCalledTimes(1);
    expect(rig.posts).toEqual([[`/api/ui/contacts/${ANA}/unblock`, undefined, PROOF]]);
    noSecondBox();
  });

  it('a cancelled sensor keeps the state, says so and sends nothing', async () => {
    gestureAnswer.proof = undefined;
    const rig = await mount(ana);
    await openMenu();
    await click(named(new RegExp(`^${S.remove}$`)));
    await click(named(/^Remove with /));
    expect(gesture).toHaveBeenCalledTimes(1);
    expect(rig.posts).toEqual([]);
    expect(text()).toContain(S.removeExplain);
    expect(text()).toContain(S.passkeyNotUsed);
  });

  it('the master code link is the other way: the code is the proof, no gesture', async () => {
    const rig = await mount(ana);
    await openMenu();
    await click(named(new RegExp(`^${S.remove}$`)));
    await click(named(new RegExp(`^${S.useCode}$`)));
    expect(gesture).not.toHaveBeenCalled();
    await type('input[name="owner-code"]', 'ABCD-EFGH');
    await click(named(new RegExp(`^${S.confirmWithCode}$`)));
    expect(rig.posts).toHaveLength(1);
    expect(rig.posts[0]?.[2]).toEqual({ kind: 'code', code: 'ABCD-EFGH' });
  });

  it('a held name also holds the master code link (Rename)', async () => {
    const rig = await mount(ana);
    await openMenu();
    await click(named(new RegExp(`^${S.rename}$`)));
    await type('input[name="alias"]', '');
    expect(named(/^Rename with /)?.disabled).toBe(true);
    expect(named(new RegExp(`^${S.useCode}$`))?.disabled).toBe(true);
    expect(rig.posts).toEqual([]);
  });

  it('the Mac app with Touch ID on: one click, the native proof, one POST; no passkey or browser words', async () => {
    const rig = await mount(
      ana,
      { kind: 'done' },
      {
        userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Electron/39.0 ${DESKTOP_MARKER}`,
        nativeStatus: () => Promise.resolve({ available: true, registered: true }),
      },
    );
    await openMenu();
    await click(named(new RegExp(`^${S.remove}$`)));
    expect(named(/^Remove with Touch ID$/)).toBeDefined();
    await click(named(/^Remove with Touch ID$/));
    expect(gesture).not.toHaveBeenCalled();
    expect(rig.posts).toEqual([[`/api/ui/contacts/${ANA}/remove`, undefined, { kind: 'native' }]]);
    expect(text()).not.toMatch(/passkey|browser|Safari/i);
  });
});
