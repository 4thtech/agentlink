// @vitest-environment jsdom
// W4-PEOPLE-INVITE: the parts other screens import (prototype v23 A4, A7, A10).
// - PendingInviteRow (Home's People list): the name or "Someone", "Waiting for … · link works N more
//   days", Cancel invite, then "Invite cancelled. The link no longer works."; Under the hood: the
//   invite's ID and exact expiry. Never a link.
// - PersonMenu: the ⋯ button ("More for {name}") with Rename, Check safety code and Remove, a
//   keyboard menu that closes on Escape and gives focus back.
// - ConnectedMoment: "You and {name} are connected", the 12-digit safety code read from this app's
//   server, and "Numbers don't match?" with the plain next step.
import { HoodProvider } from '@4thtech-io/ui';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, ApiResult } from '../../api/client.js';
import { lintVocabulary } from '@4thtech-io/ui';
import { ConnectedMoment, PendingInviteRow, PersonMenu, type CancelResult } from './index.js';
import {
  INVITE_STRINGS as S,
  connectedWith,
  invitesYou,
  lastCheck,
  linkLabel,
  waitingLine,
  worksFor,
} from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 30, 12);
const ID = 'inv5d21AAAAAAAAAAAAAAA';
const REF = '0x7f3a19c200000000000000000000000000000001';

let host: HTMLElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};
async function show(element: ReactElement, hood = false): Promise<void> {
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(HoodProvider, { value: hood }, element));
  });
  await settle();
}
const text = (): string => host.textContent ?? '';
const byText = (label: string): HTMLElement => {
  const found = [...host.querySelectorAll<HTMLElement>('button,[role="menuitem"]')].find(
    (b) => (b.textContent ?? '').trim() === label,
  );
  if (found === undefined) throw new Error(`no control ${label}`);
  return found;
};
const click = async (el: HTMLElement): Promise<void> => {
  await act(async () => {
    el.click();
  });
  await settle();
};

describe('PendingInviteRow', () => {
  it('waits, counts the days left, cancels, then says the link no longer works', async () => {
    let finish: (outcome: CancelResult) => void = () => undefined;
    const onCancel = vi.fn(
      () =>
        new Promise<CancelResult>((r) => {
          finish = r;
        }),
    );
    await show(
      createElement(
        'ul',
        null,
        createElement(PendingInviteRow, {
          invite: { inviteId: ID, name: 'Marko', expiresAt: NOW + 6 * DAY },
          now: NOW,
          onCancel,
        }),
      ),
    );
    expect(text()).toContain('Marko');
    expect(text()).toContain('Waiting for Marko to accept · link works 6 more days');
    expect(text()).not.toContain(ID);
    await click(byText(S.cancelInvite));
    expect(onCancel).toHaveBeenCalledWith(ID);
    await act(async () => {
      finish('cancelled');
    });
    await settle();
    expect(text()).toContain(S.cancelled);
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === S.cancelInvite)).toBe(
      false,
    );
  });

  it('a row with no name says Someone; a failed cancel says so and keeps the button', async () => {
    await show(
      createElement(
        'ul',
        null,
        createElement(PendingInviteRow, {
          invite: { inviteId: ID, name: null, expiresAt: NOW + 1 * DAY },
          now: NOW,
          onCancel: () => Promise.resolve('failed' as const),
        }),
      ),
    );
    expect(text()).toContain(S.someone);
    expect(text()).toContain('Waiting for them to accept · link works 1 more day');
    await click(byText(S.cancelInvite));
    expect(text()).toContain(S.cantCancel);
    expect(byText(S.cancelInvite)).toBeTruthy();
  });

  it('Under the hood shows the ID and the exact expiry', async () => {
    await show(
      createElement(
        'ul',
        null,
        createElement(PendingInviteRow, {
          invite: { inviteId: ID, name: 'Marko', expiresAt: NOW + 6 * DAY },
          now: NOW,
          onCancel: () => Promise.resolve('cancelled' as const),
        }),
      ),
      true,
    );
    expect(text()).toContain(ID);
    expect(text()).toContain('2026-11-05');
  });
});

describe('PersonMenu', () => {
  it('opens a menu with Rename, Check safety code and Remove; Escape closes it', async () => {
    const onRename = vi.fn();
    const onCheck = vi.fn();
    const onRemove = vi.fn();
    await show(createElement(PersonMenu, { name: 'Denis', onRename, onCheck, onRemove }));
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="More for Denis"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    await click(trigger as HTMLButtonElement);
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    const items = [...host.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent);
    expect(items).toEqual([S.rename, S.checkCode, S.remove]);
    expect(document.activeElement?.textContent).toBe(S.rename);
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await click(trigger as HTMLButtonElement);
    await click(byText(S.checkCode));
    expect(onCheck).toHaveBeenCalledTimes(1);
    await click(trigger as HTMLButtonElement);
    await click(byText(S.remove));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRename).not.toHaveBeenCalled();
  });

  it('leaves out an action the caller does not offer', async () => {
    await show(createElement(PersonMenu, { name: 'Ana', onRename: () => undefined }));
    await click(host.querySelector('button') as HTMLButtonElement);
    expect([...host.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent)).toEqual([
      S.rename,
    ]);
  });
});

describe('ConnectedMoment (A7)', () => {
  const api = (code: unknown): ApiClient & { paths: string[] } => {
    const paths: string[] = [];
    return {
      paths,
      get: <T>(path: string) => {
        paths.push(path);
        return Promise.resolve({ kind: 'ok', status: 200, data: code } as ApiResult<T>);
      },
      post: () => Promise.resolve({ kind: 'error', status: 500 }),
      owner: () => Promise.resolve({ kind: 'error', status: 500 }),
    };
  };

  it("says who is connected and shows the 12-digit safety code; Numbers don't match? explains", async () => {
    const client = api({ status: 'ok', code: '4821 0937 5512' });
    const done = vi.fn();
    await show(
      createElement(ConnectedMoment, {
        name: 'Denis',
        me: 'Tali',
        contactRef: REF,
        api: client,
        onDone: done,
      }),
    );
    expect(host.querySelector('h1')?.textContent).toBe('You and Denis are connected');
    expect(client.paths).toEqual([`/api/ui/contacts/${REF}/safety-code`]);
    expect(text()).toContain('4821');
    expect(text()).toContain('5512');
    expect(host.querySelector('[aria-label^="Safety code: 4 8 2 1"]')).not.toBeNull();
    expect(text()).toContain('ask Denis which numbers they see');
    await click(byText(S.dontMatch));
    expect(text()).toContain(
      "Don't send anything yet. Remove Denis from People and invite them again, in person or on a call.",
    );
    await click(byText(S.done));
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('without the code yet it says where it will appear; never a wrong code', async () => {
    await show(
      createElement(ConnectedMoment, { name: 'Ana', api: api({ status: 'ok', code: 'x' }) }),
    );
    expect(text()).toContain(S.codeLater);
  });
});

describe('the copy (11 §5)', () => {
  it('uses none of the never-say words', () => {
    const all = [
      ...Object.values(S).map((v) => (typeof v === 'function' ? v('Marko') : v)),
      linkLabel('Marko'),
      worksFor(7),
      waitingLine('Marko', 6),
      waitingLine(null, 1),
      invitesYou('Marko'),
      connectedWith('Marko'),
      lastCheck('Marko'),
    ];
    for (const line of all) expect([line, lintVocabulary(line)]).toEqual([line, []]);
  });
});
