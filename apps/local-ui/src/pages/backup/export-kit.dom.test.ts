// @vitest-environment jsdom
// WP-11 + WP-R4 (§6.3): Settings › Backup saves the recovery kit in the app, behind Touch ID or the
// master code. The new recovery code is shown once, then a three-line checklist (move the file, write
// the code down, check it opens); Done turns on only when all three are ticked. The code is never put
// in storage, a URL, an attribute or a file.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiClient, OwnerApiResult, OwnerPresence } from '../../api/client.js';
import { RECOVERY_KIT_LATER_KEY, rememberRecoveryKitLater } from '../../states/index.js';
import { BackupPage } from './index.js';
import { BACKUP_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CODE = 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX';
const OWNER_CODE = 'WXYZ-WXYZ-WXYZ-WXYZ-WXYZ-WXYZ';
const CHECK = 'abcdefghijklmnopqrstuv';
const CHECK_PATH = '/api/ui/restore/check';

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
const button = (label: string): HTMLButtonElement => {
  const b = [...host.querySelectorAll('button')].find(
    (x) => (x.textContent ?? '').trim() === label,
  );
  if (b === undefined) throw new Error(`no button "${label}" in: ${labels().join(' | ')}`);
  return b;
};
async function click(label: string): Promise<void> {
  const b = button(label);
  await act(async () => {
    b.click();
  });
  await settle();
}
async function tick(step: string): Promise<void> {
  const box = host.querySelector<HTMLInputElement>(`input[aria-label="${S.tickLabel(step)}"]`);
  if (box === null) throw new Error(`no tick for ${step}`);
  await act(async () => {
    box.click();
  });
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

interface Fake {
  api: ApiClient;
  owner: { path: string; input: unknown; presence: OwnerPresence }[];
  posts: { path: string; body: unknown }[];
}
function fakeApi(
  answer: OwnerApiResult,
  available: 'available' | 'not_available' = 'available',
  checkAnswer: 'ok' | 'wrong' = 'ok',
): Fake {
  const owner: Fake['owner'] = [];
  const posts: Fake['posts'] = [];
  const api: ApiClient = {
    get: (path) =>
      Promise.resolve(
        path === '/api/ui/backup'
          ? ({
              kind: 'ok',
              status: 200,
              data: {
                export: available,
                record: 'none',
                state: 'none',
                lastKit: null,
                missing: null,
              },
            } as never)
          : ({ kind: 'error', status: 404 } as const),
      ),
    post: (path, body) => {
      posts.push({ path, body });
      if (path === CHECK_PATH && checkAnswer === 'wrong')
        return Promise.resolve({ kind: 'error', status: 409 });
      return Promise.resolve({ kind: 'ok', status: 200, data: {} } as never);
    },
    owner: (path, input, presence) => {
      owner.push({ path, input, presence });
      return Promise.resolve(answer);
    },
  };
  return { api, owner, posts };
}

const SAVED: OwnerApiResult = {
  kind: 'ok',
  status: 200,
  data: {
    status: 'saved',
    file: 'agentlink-recovery-kit-2026-11-12.alkk',
    folder: 'Downloads',
    code: CODE,
    covers: [{ name: 'Tali', label: 'Tali' }],
    check: CHECK,
  },
};

function fakeWindow(): { open: () => Window | null; sheet: { text: string; printed: number } } {
  const doc = document.implementation.createHTMLDocument('');
  const sheet = { text: '', printed: 0 };
  const win = {
    document: doc,
    focus: () => undefined,
    print: () => {
      sheet.printed += 1;
      sheet.text = doc.body.textContent ?? '';
    },
    close: () => undefined,
  } as unknown as Window;
  return { open: () => win, sheet };
}

async function render(f: Fake, extra: Record<string, unknown> = {}): Promise<void> {
  await act(async () =>
    root.render(h(BackupPage, { api: f.api, passkey: () => Promise.resolve(undefined), ...extra })),
  );
  await settle();
}
async function saveKit(f: Fake, extra: Record<string, unknown> = {}): Promise<void> {
  await render(f, extra);
  await click(S.saveFirst);
  await typeCode(OWNER_CODE);
  await click('Confirm with your master code');
}

describe('Back up: save the recovery kit in the app', () => {
  it('offers Save a recovery kit, never a terminal command', async () => {
    await render(fakeApi(SAVED));
    expect(labels()).toContain(S.saveFirst);
    expect(host.textContent).not.toContain('agentlink backup');
    expect(host.textContent).not.toContain('terminal');
  });

  it('asks for presence once, with an empty input, and shows the file and the code once', async () => {
    rememberRecoveryKitLater();
    const f = fakeApi(SAVED);
    await saveKit(f);
    expect(f.owner).toEqual([{ path: '/api/ui/backup/export', input: {}, presence: OWNER_CODE }]);
    expect(host.textContent).toContain('agentlink-recovery-kit-2026-11-12.alkk');
    expect(host.textContent).toContain(S.savedIn('Downloads'));
    expect(host.querySelector('[data-recovery-code]')?.textContent).toBe(CODE.replace(/-/g, ''));
  });

  it('Done stays off until the three steps are ticked; the check ticks itself when it opens', async () => {
    const f = fakeApi(SAVED);
    await saveKit(f, { checkPath: CHECK_PATH, openWindow: fakeWindow().open });
    expect(button(S.finish).disabled).toBe(true);
    await tick(S.stepMove);
    await tick(S.stepWrite);
    expect(button(S.finish).disabled).toBe(true);
    await click(S.checkNow);
    expect(f.posts).toContainEqual({ path: CHECK_PATH, body: { check: CHECK } });
    expect(host.textContent).toContain(S.checkOk);
    expect(button(S.finish).disabled).toBe(false);
    await click(S.finish);
    expect(host.querySelector('[data-recovery-code]')).toBeNull();
    expect(host.textContent).not.toContain(CODE.replace(/-/g, ''));
    expect(host.textContent).toContain(S.done('Tali'));
    expect(localStorage.getItem(RECOVERY_KIT_LATER_KEY)).toBeNull();
  });

  it('a wrong check does not tick and says nothing was changed', async () => {
    const f = fakeApi(SAVED, 'available', 'wrong');
    await saveKit(f, { checkPath: CHECK_PATH, openWindow: fakeWindow().open });
    await tick(S.stepMove);
    await tick(S.stepWrite);
    await click(S.checkNow);
    expect(host.textContent).toContain(S.checkWrong);
    expect(button(S.finish).disabled).toBe(true);
  });

  it('without a check route the check is disabled with a plain note', async () => {
    await saveKit(fakeApi(SAVED));
    expect(button(S.checkNow).disabled).toBe(true);
    expect(host.textContent).toContain(S.checkUnavailable);
    expect(button(S.finish).disabled).toBe(true);
  });

  it('Show in Finder posts no input; Print draws the sheet in memory with no download or file', async () => {
    const f = fakeApi(SAVED);
    const w = fakeWindow();
    const created: unknown[] = [];
    const original = URL.createObjectURL;
    URL.createObjectURL = ((o: unknown) => (created.push(o), 'blob:x')) as never;
    try {
      await saveKit(f, { checkPath: CHECK_PATH, openWindow: w.open });
      await click(S.showInFinder);
      expect(f.posts).toContainEqual({ path: '/api/ui/backup/reveal', body: undefined });
      await click(S.print);
      expect(w.sheet.printed).toBe(1);
      expect(w.sheet.text).toContain(CODE);
      expect(w.sheet.text).toContain('agentlink-recovery-kit-2026-11-12.alkk');
      expect(created).toEqual([]);
      expect(host.querySelector('a[download]')).toBeNull();
    } finally {
      URL.createObjectURL = original;
    }
  });

  it('a blocked print window says so', async () => {
    await saveKit(fakeApi(SAVED), { openWindow: () => null });
    await click(S.print);
    expect(host.textContent).toContain(S.printBlocked);
  });

  it('the code is never in storage, the URL or any attribute', async () => {
    await saveKit(fakeApi(SAVED), { checkPath: CHECK_PATH, openWindow: fakeWindow().open });
    const flat = CODE.replace(/-/g, '');
    expect(
      JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
    ).not.toContain(flat);
    expect(location.href).not.toContain(flat);
    for (const el of host.querySelectorAll('*'))
      for (const a of el.getAttributeNames())
        expect(`${a}=${el.getAttribute(a)}`).not.toContain(flat);
  });

  it('a wrong master code says so and saves nothing', async () => {
    await saveKit(fakeApi({ kind: 'presence_rejected' }));
    expect(host.querySelector('[role="alert"]')?.textContent ?? '').not.toBe('');
    expect(host.querySelector('[data-recovery-code]')).toBeNull();
  });

  it('where the kit cannot be saved here, says why and has no save button', async () => {
    await render(fakeApi(SAVED, 'not_available'));
    expect(labels()).not.toContain(S.saveFirst);
    expect(host.textContent).toContain(S.notHere);
  });
});
