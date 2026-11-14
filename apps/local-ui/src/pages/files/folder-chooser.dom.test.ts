// @vitest-environment jsdom
// FILES-FOLDER-PICKER (D-161): the one folder control. Row states: default, pending (checking),
// confirming, error, success. In the app the click opens the native dialog (the preload's
// chooseFolder) and the picked path is only reviewed, never trusted; cancelling changes nothing and
// focus returns to the button. In a browser the click opens the path field with an example, paste
// help and the app tip (no fake dialog). The Inbox uses its own review and owner route.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Answer, CommitOutcome, FilesApi, Presence } from './files-api.js';
import { FolderChooser, FolderLine, desktopPicker } from './folder-chooser.js';
import { PICKER_COPY as P, middleTruncate } from './folders-copy.js';
import { FILES_STRINGS as S } from './strings.js';

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
  delete (globalThis as { agentlinkDesktop?: unknown }).agentlinkDesktop;
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

const TOKEN = 'A'.repeat(43);
const PICKED = '/Users/a/Documents/Received';

interface Fake {
  gets: string[];
  commits: { path: string; input: unknown; presence: Presence }[];
  review: Answer;
  outcome: CommitOutcome;
}

function api(fake: Fake): FilesApi {
  return {
    get: (path) => {
      fake.gets.push(path);
      if (path === '/api/ui/files') {
        return Promise.resolve({ kind: 'answer', status: 200, json: { folders: [], version: 3 } });
      }
      return Promise.resolve(fake.review);
    },
    passkey: () => Promise.resolve(undefined),
    commit: (path, input, presence) => {
      fake.commits.push({ path, input, presence });
      return Promise.resolve(fake.outcome);
    },
    reveal: () => Promise.resolve('shown'),
    preview: () => Promise.reject(new Error('not used')),
  } as FilesApi;
}

const inboxReview = (folder = PICKED): Answer => ({
  kind: 'answer',
  status: 200,
  json: {
    review: TOKEN,
    change: 'inbox',
    folder,
    typed: folder,
    elsewhere: false,
    warnings: ['folder_changed'],
    expiresAt: 2_000_000_000,
  },
});

function fake(review: Answer = inboxReview()): Fake {
  return {
    gets: [],
    commits: [],
    review,
    outcome: { kind: 'applied', confirmed: true } as CommitOutcome,
  };
}

const buttonNamed = (name: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === name || b.textContent?.startsWith(`${name} `) === true,
  );

async function click(el: Element | undefined): Promise<void> {
  expect(el).toBeDefined();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush();
}

async function mount(props: Parameters<typeof FolderChooser>[0]): Promise<void> {
  await act(async () => {
    root.render(h(FolderChooser, props));
  });
  await flush();
}

describe('the row (FolderLine)', () => {
  it('shows the folder name, the full path (cut in the middle when long) and its title', async () => {
    const long = `/Users/a/${'Very long folder name/'.repeat(4)}Received`;
    await act(async () => {
      root.render(h('ul', null, h(FolderLine, { label: 'Inbox', path: long, icon: 'inbox' })));
    });
    const path = host.querySelector('.fl-line-path') as HTMLElement;
    expect(path.title).toBe(long);
    expect(path.textContent).toContain(middleTruncate(long));
    expect(middleTruncate(long)).toContain('…');
    expect(middleTruncate(long).endsWith('Received')).toBe(true);
    // The whole path is read out.
    expect(host.querySelector('.fl-sr-only')?.textContent).toBe(long);
    expect(host.textContent).toContain('Inbox · Received');
  });
});

describe('desktop app: the native folder dialog', () => {
  it('default: one Change… button, nothing asked yet', async () => {
    const f = fake();
    await mount({
      api: api(f),
      purpose: 'inbox',
      current: '~/AgentLink/Inbox',
      picker: () => Promise.resolve(null),
    });
    expect(buttonNamed(P.change)).toBeDefined();
    expect(host.querySelector('input')).toBeNull();
    expect(f.gets).toHaveLength(0);
  });

  it('cancelled dialog: nothing changes, focus is back on the button', async () => {
    const f = fake();
    const asked: unknown[] = [];
    await mount({
      api: api(f),
      purpose: 'inbox',
      current: '~/AgentLink/Inbox',
      picker: (request) => (asked.push(request), Promise.resolve(null)),
    });
    await click(buttonNamed(P.change));
    expect(asked).toEqual([{ purpose: 'inbox', current: '~/AgentLink/Inbox' }]);
    expect(f.gets).toHaveLength(0);
    expect(document.activeElement).toBe(buttonNamed(P.change));
  });

  it('pending then confirming: the picked folder shows at once, then the confirm sheet', async () => {
    const f = fake();
    let release: (path: string | null) => void = () => undefined;
    let answer: (a: Answer) => void = () => undefined;
    const slow: FilesApi = {
      ...api(f),
      get: (path) =>
        path === '/api/ui/files'
          ? Promise.resolve({ kind: 'answer', status: 200, json: { folders: [], version: 3 } })
          : new Promise<Answer>((r) => {
              f.gets.push(path);
              answer = r;
            }),
    };
    await mount({ api: slow, purpose: 'inbox', picker: () => new Promise((r) => (release = r)) });
    await click(buttonNamed(P.change));
    await act(async () => release(PICKED));
    await flush();
    // Pending: the row with the picked folder and "Checking…".
    const pending = host.querySelector('[data-row="pending"]');
    expect(pending?.hasAttribute('data-pending')).toBe(true);
    expect(pending?.textContent).toContain(PICKED);
    expect(pending?.textContent).toContain(P.checking);
    expect(f.gets[0]).toBe(
      `/api/ui/files/inbox/review?${new URLSearchParams({ set: PICKED, version: '3' }).toString()}`,
    );
    await act(async () => answer(inboxReview()));
    await flush();
    // Confirming: "Not saved yet" and the sheet, every warning to tick, the master code.
    expect(host.querySelector('[data-row="pending"]')?.textContent).toContain(P.pending);
    expect(host.textContent).toContain(P.inboxConfirmTitle);
    expect(host.textContent).toContain(P.inboxConfirmBody);
    expect(buttonNamed(P.inboxConfirm)?.disabled).toBe(true);
  });

  it('success: signs on the Inbox route with every warning and the code, then says so', async () => {
    const f = fake();
    let done = 0;
    await mount({
      api: api(f),
      purpose: 'inbox',
      picker: () => Promise.resolve(PICKED),
      onDone: () => (done += 1),
    });
    await click(buttonNamed(P.change));
    const tick = host.querySelector<HTMLInputElement>('fieldset input[type="checkbox"]');
    await click(tick ?? undefined);
    const code = host.querySelector<HTMLInputElement>(
      'input[name="owner-code"]',
    ) as HTMLInputElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(code, 'ABCD-EFGH');
      code.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(buttonNamed(P.inboxConfirm));
    expect(f.commits).toEqual([
      {
        path: '/api/ui/files/inbox',
        input: { review: TOKEN, acknowledged: ['folder_changed'] },
        presence: { kind: 'code', code: 'ABCD-EFGH' },
      },
    ]);
    expect(host.textContent).toContain(P.inboxChanged);
    expect(host.querySelector('[data-row="pending"]')).toBeNull();
    expect(done).toBe(1);
  });

  it('error: a refused folder is said in plain words next to the row; nothing is signed', async () => {
    const f = fake({
      kind: 'answer',
      status: 422,
      json: { error: 'folder_refused', reason: 'link' },
    });
    await mount({
      api: api(f),
      purpose: 'inbox',
      picker: () => Promise.resolve('/Users/a/Shortcut'),
    });
    await click(buttonNamed(P.change));
    const row = host.querySelector('[data-row="pending"]');
    expect(row?.textContent).toContain('/Users/a/Shortcut');
    expect(row?.querySelector('[role="alert"]')?.textContent).toBe(
      "That folder can't be used: it’s a shortcut to another place. Choose the folder itself.",
    );
    expect(f.commits).toHaveLength(0);
    // Try again is the same button.
    expect(buttonNamed(P.change)).toBeDefined();
  });

  it('a Send folder: Add folder… reviews the picked path as an add', async () => {
    const f = fake({
      kind: 'answer',
      status: 422,
      json: { error: 'folder_refused', reason: 'inbox_folder' },
    });
    await mount({
      api: api(f),
      purpose: 'send',
      picker: () => Promise.resolve('/Users/a/AgentLink'),
    });
    await click(buttonNamed(P.addFolder));
    expect(f.gets[1]).toBe(
      `/api/ui/files/review?${new URLSearchParams({ add: '/Users/a/AgentLink', version: '3' }).toString()}`,
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'received files are saved there',
    );
  });

  it('reads the preload bridge only as a function that answers a string', async () => {
    expect(desktopPicker()).toBeUndefined();
    (globalThis as { agentlinkDesktop?: unknown }).agentlinkDesktop = {
      chooseFolder: () => Promise.resolve({ path: '/x' }),
    };
    const choose = desktopPicker();
    expect(choose).toBeDefined();
    await expect(choose?.({ purpose: 'send' })).resolves.toBeNull();
  });
});

describe('browser: the typed field, no fake dialog', () => {
  it('Change… opens the path field with an example, paste help and the app tip', async () => {
    const f = fake();
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    await mount({ api: api(f), purpose: 'inbox', picker: null });
    await click(buttonNamed(P.change));
    const input = host.querySelector<HTMLInputElement>('input[name="inbox-folder"]');
    expect(input).not.toBeNull();
    expect(host.textContent).toContain(P.inboxExample);
    expect(host.textContent).toContain(P.pasteHelp('Mac'));
    expect(host.querySelector('[data-app-pick-tip]')?.textContent).toContain(
      'Tip: in the AgentLink app you can pick the folder in Finder.',
    );
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(input, PICKED);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(buttonNamed(P.use));
    expect(host.textContent).toContain(P.inboxConfirmTitle);
    expect(f.commits).toHaveLength(0);
    // Cancel leaves everything as it was.
    await click(buttonNamed(S.cancel));
    expect(host.textContent).not.toContain(P.inboxConfirmTitle);
    expect(f.commits).toHaveLength(0);
  });
});
