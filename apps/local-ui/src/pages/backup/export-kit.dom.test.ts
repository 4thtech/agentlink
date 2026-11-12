// @vitest-environment jsdom
// WP-11 (F-1 full, D-117 A): Settings › Backup saves the recovery kit in the app, behind Touch ID or
// the backup code. No terminal command, no button that does nothing. The new recovery code is shown
// once, with Copy; "I saved it" takes it off the screen and ends the "you put this off" reminder.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiClient, OwnerApiResult, OwnerPresence } from '../../api/client.js';
import { recoveryKitPending, rememberRecoveryKitLater } from '../../states/index.js';
import { BackupPage } from './index.js';
import { BACKUP_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CODE = 'ABCD EFGH IJKL MNOP QRST UVWX';
const OWNER_CODE = 'WXYZ-WXYZ-WXYZ-WXYZ-WXYZ-WXYZ';

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
const labels = (): string[] =>
  [...host.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());
async function click(label: string): Promise<void> {
  const b = [...host.querySelectorAll('button')].find((x) => (x.textContent ?? '').trim() === label);
  if (b === undefined) throw new Error(`no button "${label}" in: ${labels().join(' | ')}`);
  await act(async () => {
    b.click();
  });
  await settle();
}
async function typeCode(value: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('input[type="password"]');
  if (input === null) throw new Error('no code field');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

function fakeApi(
  answer: OwnerApiResult,
  available: 'available' | 'not_available' = 'available',
): { api: ApiClient; calls: { path: string; input: unknown; presence: OwnerPresence }[] } {
  const calls: { path: string; input: unknown; presence: OwnerPresence }[] = [];
  const api: ApiClient = {
    get: (path) =>
      Promise.resolve(
        path === '/api/ui/backup'
          ? ({ kind: 'ok', status: 200, data: { export: available } } as never)
          : ({ kind: 'error', status: 404 } as const),
      ),
    post: () => Promise.resolve({ kind: 'error', status: 404 }),
    owner: (path, input, presence) => {
      calls.push({ path, input, presence });
      return Promise.resolve(answer);
    },
  };
  return { api, calls };
}

const SAVED: OwnerApiResult = {
  kind: 'ok',
  status: 200,
  data: { status: 'saved', file: 'agentlink-recovery-kit-2026-11-12.alkk', folder: 'Downloads', code: CODE },
};

describe('Back up: save the recovery kit in the app (WP-11)', () => {
  it('offers Save recovery kit, never a terminal command', async () => {
    const { api } = fakeApi(SAVED);
    await act(async () => root.render(h(BackupPage, { api, passkey: () => Promise.resolve(undefined) })));
    await settle();
    expect(labels()).toContain(S.saveKit);
    expect(host.textContent).not.toContain('agentlink backup');
    expect(host.textContent).not.toContain('terminal');
  });

  it('asks for presence, sends the code once, shows the file and the new recovery code once', async () => {
    rememberRecoveryKitLater();
    const { api, calls } = fakeApi(SAVED);
    await act(async () => root.render(h(BackupPage, { api, passkey: () => Promise.resolve(undefined) })));
    await settle();
    await click(S.saveKit);
    await typeCode(OWNER_CODE);
    await click('Confirm with your backup code');
    expect(calls).toEqual([{ path: '/api/ui/backup/export', input: {}, presence: OWNER_CODE }]);
    expect(host.textContent).toContain('agentlink-recovery-kit-2026-11-12.alkk');
    expect(host.textContent).toContain(S.savedIn('Downloads'));
    expect(host.textContent).toContain(CODE);
    expect(labels()).toContain(S.copy);
    // The code is not kept: after "I saved it" it is gone, and so is the reminder.
    await click(S.savedIt);
    expect(host.textContent).not.toContain(CODE);
    expect(host.textContent).toContain(S.done);
    expect(recoveryKitPending()).toBe(false);
  });

  it('a wrong backup code says so and saves nothing', async () => {
    const { api } = fakeApi({ kind: 'presence_rejected' });
    await act(async () => root.render(h(BackupPage, { api, passkey: () => Promise.resolve(undefined) })));
    await settle();
    await click(S.saveKit);
    await typeCode(OWNER_CODE);
    await click('Confirm with your backup code');
    expect(host.querySelector('[role="alert"]')?.textContent ?? '').not.toBe('');
    expect(host.textContent).not.toContain(CODE);
  });

  it('where the kit cannot be saved here, says why and has no button that does nothing', async () => {
    const { api } = fakeApi(SAVED, 'not_available');
    await act(async () => root.render(h(BackupPage, { api, passkey: () => Promise.resolve(undefined) })));
    await settle();
    expect(labels()).not.toContain(S.saveKit);
    expect(host.textContent).toContain(S.notHere);
  });
});
