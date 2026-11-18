// @vitest-environment jsdom
// DEVICES-INTERIM: the bell's row "This ID is also in use on another computer", styled as every
// other state row of the centre (N5); its second line names the per-computer spending limits.
import { lintVocabulary } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationList } from '../api/notifications.js';
import { resetAttentionForTests } from './attention.js';
import { NotificationBell, devicesSeenDate, targetOf } from './notification-centre.js';
import { NOTIFY_STRINGS as S } from './notification-strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_800_000_000;
let host: HTMLElement;
let root: Root;

beforeEach(() => {
  document.head.innerHTML = '<meta name="agentlink-csrf" content="tok">';
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  resetAttentionForTests();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response('{"status":"done"}', { status: 200 }))),
  );
  history.replaceState(null, '', '/settings');
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const DEVICES = { id: 'devices', kind: 'devices', count: 1, at: NOW - 60, read: false } as const;

describe('the devices row (DEVICES-INTERIM)', () => {
  it('plain words (11 §5), naming the per-computer spending limits', () => {
    expect(S.devices).toBe('This ID is also in use on another computer');
    expect(S.devicesLine).toBe('Spending limits apply per computer for now');
    expect(lintVocabulary(JSON.stringify({ a: S.devices, b: S.devicesLine }))).toEqual([]);
    expect(S.devicesSeen('15 Jan 2027')).toBe('Last seen 15 Jan 2027');
    expect(lintVocabulary(S.devicesSeen('15 Jan 2027'))).toEqual([]);
  });

  it('says when the other computer was last seen, as a date', async () => {
    const seenAt = NOW - 3 * 86_400;
    const answer: NotificationList = {
      items: [{ ...DEVICES, at: seenAt }],
      unread: 1,
      approvals: 0,
    };
    await act(async () => {
      root.render(
        h(NotificationBell, {
          path: '/settings',
          read: () => Promise.resolve(answer),
          names: () => Promise.resolve(new Map()),
          now: () => NOW,
        }),
      );
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.al-nc-bell')?.click();
    });
    const row = host.querySelector<HTMLElement>('.al-nc-row[data-kind="devices"]');
    expect(row?.textContent).toContain(S.devicesSeen(devicesSeenDate(seenAt)));
    expect(devicesSeenDate(seenAt)).toContain('2027');
  });

  it('shows in New with its sentence and line, and opens Home', async () => {
    const answer: NotificationList = { items: [DEVICES], unread: 1, approvals: 0 };
    await act(async () => {
      root.render(
        h(NotificationBell, {
          path: '/settings',
          read: () => Promise.resolve(answer),
          names: () => Promise.resolve(new Map()),
          now: () => NOW,
        }),
      );
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.al-nc-bell')?.click();
    });
    const row = host.querySelector<HTMLElement>('.al-nc-row[data-kind="devices"]');
    expect(row?.textContent).toContain(S.devices);
    expect(row?.textContent).toContain(S.devicesLine);
    expect(targetOf(DEVICES)).toBe('/');
  });
});
