// @vitest-environment jsdom
// FILES-HOME-PANEL (D-152; 08 §1 "Home Files panel"; 11 §5.7; I-4, I-5): the panel's states. Empty,
// allowed, not allowed (the banner text and Allow Send folder inside the panel), Send folder
// missing, Inbox "{n} new" (a count, never a file name), Manage folders, Tips for {app}; the
// collapse is remembered and still works when `localStorage` throws, and is never collapsed while the
// Send folder is not allowed.
import { lintVocabulary } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RevealApi } from '../../api/reveal-folder.js';
import { FILES_COPY, appTip, computerWord, showInLabel } from '../files/folders-copy.js';
import { FILES_SEEN_KEY, type Getter } from '../files/folders-summary.js';
import { FILES_PANEL_COLLAPSED_KEY, FilesPanel, MANAGE_FOLDERS_PATH } from './files-panel.js';
import { filesLinkFor, type SendFolderApi } from './send-folder-banner.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const AT = 1_792_000_000;
const SECRET_NAME = 'Quarterly-Plan-Secret.md';

interface World {
  readonly folders: { path: string; resolved: string | null }[];
  readonly received?: readonly unknown[];
  readonly sent?: readonly unknown[];
  readonly inbox?: string;
}

const get =
  (w: World): Getter =>
  (path) => {
    const answer = (status: number, json: unknown) =>
      Promise.resolve({ kind: 'answer', status, json } as const);
    if (path === '/api/ui/files') return answer(200, { folders: w.folders, max: 32, version: 1 });
    if (path.startsWith('/api/ui/files/received')) {
      return answer(200, {
        items: w.received ?? [],
        autoSave: { on: true, folder: w.inbox ?? '~/AgentLink/Inbox', notice: false },
      });
    }
    if (path.startsWith('/api/ui/files/sent')) return answer(200, { items: w.sent ?? [] });
    return answer(404, {});
  };

const received = (id: string, at: number, state = 'saved') => ({
  id,
  from: 'Ana',
  at,
  name: SECRET_NAME,
  size: 10,
  state,
  savedName: SECRET_NAME,
  proof: false,
});

const ALLOWED = { path: '~/AgentLink/Send', resolved: '/h/AgentLink/Send' };

function fakes() {
  const reveals: string[] = [];
  const reveal: RevealApi = {
    revealSendFolder: () => {
      reveals.push('send');
      return Promise.resolve('shown');
    },
    revealInbox: () => {
      reveals.push('inbox');
      return Promise.resolve('shown');
    },
  };
  const prepared: string[] = [];
  const sendFolder: SendFolderApi = {
    noFolder: () => Promise.resolve(false),
    prepare: () => {
      prepared.push('prepare');
      return Promise.resolve('~/AgentLink/Send');
    },
  };
  const went: string[] = [];
  return { reveals, reveal, prepared, sendFolder, went };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount(world: World, props: { appName?: string } = {}) {
  const f = fakes();
  await act(async () => {
    root.render(
      h(FilesPanel, {
        get: get(world),
        reveal: f.reveal,
        sendFolder: f.sendFolder,
        go: (to: string) => f.went.push(to),
        ...props,
      }),
    );
  });
  await settle();
  return f;
}

const q = (sel: string): HTMLElement | null => host.querySelector<HTMLElement>(sel);
const buttons = (): HTMLButtonElement[] => [...host.querySelectorAll('button')];
const byLabel = (text: string): HTMLButtonElement | undefined =>
  buttons().find((b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text);
async function click(el: Element | undefined | null): Promise<void> {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

describe('the Files panel states', () => {
  it('empty: the Send and Inbox rows, the short line, the empty state, no "new"', async () => {
    await mount({ folders: [ALLOWED] });
    const text = q('[data-files-panel]')?.textContent ?? '';
    expect(text).toContain(FILES_COPY.panelTitle);
    expect(text).toContain(FILES_COPY.oneLineShort);
    expect(text).toContain(FILES_COPY.panelEmpty);
    expect(text).toContain('~/AgentLink/Send');
    expect(text).toContain('~/AgentLink/Inbox');
    expect(text).toContain(FILES_COPY.chipAllowed);
    expect(text).not.toMatch(/\d+ new/);
    expect(lintVocabulary(text)).toEqual([]);
  });

  it('allowed with files: the empty state is gone; both rows have Show in Finder', async () => {
    const f = await mount({ folders: [ALLOWED], sent: [{}], received: [] });
    const show = buttons().filter((b) => b.textContent?.trim() === showInLabel());
    expect(show).toHaveLength(2);
    await click(show[0]);
    await click(show[1]);
    expect(f.reveals).toEqual(['send', 'inbox']);
  });

  it('Inbox "{n} new" is a count of saved files since Files was last opened, never a name', async () => {
    localStorage.setItem(FILES_SEEN_KEY, String(AT));
    await mount({
      folders: [ALLOWED],
      received: [
        received('a', AT + 5),
        received('b', AT + 9),
        received('old', AT - 5),
        received('c', AT + 20, 'not_saved'),
      ],
    });
    const text = q('[data-files-panel]')?.textContent ?? '';
    expect(text).toContain('2 new');
    expect(text).not.toContain(SECRET_NAME);
    expect(text).not.toContain('Ana');
  });

  it('not allowed: the banner text and Allow Send folder sit inside the panel; one action', async () => {
    const f = await mount({ folders: [] });
    const panel = q('[data-files-panel]');
    expect(panel?.textContent).toContain(FILES_COPY.noFolder);
    expect(q('[data-send-folder-banner]')).toBeNull();
    const allow = byLabel(FILES_COPY.allowSendFolder);
    expect(allow).toBeTruthy();
    expect(allow && panel?.contains(allow)).toBe(true);
    // No Show in Finder for a folder that is not allowed (nothing to show).
    expect(buttons().some((b) => b.textContent?.trim() === showInLabel())).toBe(false);
    await click(allow);
    expect(f.prepared).toEqual(['prepare']);
    expect(f.went).toEqual([filesLinkFor('~/AgentLink/Send')]);
    expect(sessionStorage.length).toBe(1);
  });

  it('not allowed and the set-up fails: a fixed line and a way to Files', async () => {
    const f = fakes();
    await act(async () => {
      root.render(
        h(FilesPanel, {
          get: get({ folders: [] }),
          reveal: f.reveal,
          sendFolder: {
            noFolder: () => Promise.resolve(true),
            prepare: () => Promise.resolve(undefined),
          },
          go: (to: string) => f.went.push(to),
        }),
      );
    });
    await settle();
    await click(byLabel(FILES_COPY.allowSendFolder));
    expect(q('[data-files-panel]')?.textContent).toContain(FILES_COPY.allowFailed);
    expect(f.went).toEqual([]);
  });

  it('Send folder missing: the chip says so, and there is no Show in Finder for it', async () => {
    await mount({ folders: [{ path: '~/AgentLink/Send', resolved: null }] });
    expect(q('[data-files-panel]')?.textContent).toContain(FILES_COPY.chipNotFound(computerWord()));
    // Only the Inbox row has one.
    expect(buttons().filter((b) => b.textContent?.trim() === showInLabel())).toHaveLength(1);
  });

  it('only the ID own Send folder counts: another allowed folder is not a Send folder', async () => {
    await mount({ folders: [{ path: '~/Documents/Shared', resolved: '/h/Documents/Shared' }] });
    expect(q('[data-files-panel]')?.textContent).toContain(FILES_COPY.noFolder);
  });
});

describe('Manage folders and Tips', () => {
  it('Manage folders goes to Settings › Files, Send folders tab', async () => {
    await mount({ folders: [ALLOWED] });
    const link = [...host.querySelectorAll('a')].find(
      (a) => a.textContent === FILES_COPY.manageFolders,
    );
    expect(link?.getAttribute('href')).toBe(MANAGE_FOLDERS_PATH);
  });

  it('Tips for {app} expands the fixed tip of that app', async () => {
    await mount({ folders: [ALLOWED] }, { appName: 'Claude Code' });
    expect(q('[data-app-tip]')).toBeNull();
    await click(byLabel(FILES_COPY.tipsFor('Claude Code')));
    expect(q('[data-app-tip]')?.textContent).toContain(appTip('Claude Code', computerWord()));
    expect(q('[data-app-tip]')?.textContent).toContain(
      'Ask it to save the file into your Send folder',
    );
  });

  it('an unknown or no app takes the unknown-app tip', async () => {
    await mount({ folders: [ALLOWED] }, { appName: 'Another AI app' });
    await click(byLabel(FILES_COPY.tipsForUnknown));
    expect(q('[data-app-tip]')?.textContent).toContain("If your AI can't put files on this");
  });

  it('Claude Desktop has its own tip', async () => {
    await mount({ folders: [ALLOWED] }, { appName: 'Claude Desktop' });
    await click(byLabel(FILES_COPY.tipsFor('Claude Desktop')));
    expect(q('[data-app-tip]')?.textContent).toContain(
      'files Claude makes in a chat stay in Claude',
    );
  });
});

describe('collapse', () => {
  it('is remembered across visits', async () => {
    await mount({ folders: [ALLOWED] });
    await click(byLabel(FILES_COPY.collapse));
    expect(localStorage.getItem(FILES_PANEL_COLLAPSED_KEY)).toBe('1');
    expect(q('[data-files-panel]')?.textContent).not.toContain(FILES_COPY.oneLineShort);
    act(() => root.unmount());
    root = createRoot(host);
    await mount({ folders: [ALLOWED] });
    expect(q('[data-files-panel]')?.textContent).not.toContain(FILES_COPY.oneLineShort);
    await click(byLabel(FILES_COPY.expand));
    expect(q('[data-files-panel]')?.textContent).toContain(FILES_COPY.oneLineShort);
    expect(localStorage.getItem(FILES_PANEL_COLLAPSED_KEY)).toBeNull();
  });

  it('still works when localStorage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    await mount({ folders: [ALLOWED] });
    expect(q('[data-files-panel]')?.textContent).toContain(FILES_COPY.oneLineShort);
    await click(byLabel(FILES_COPY.collapse));
    expect(q('[data-files-panel]')?.textContent).not.toContain(FILES_COPY.oneLineShort);
    await click(byLabel(FILES_COPY.expand));
    expect(q('[data-files-panel]')?.textContent).toContain(FILES_COPY.oneLineShort);
  });

  it('is never collapsed while the Send folder is not allowed', async () => {
    localStorage.setItem(FILES_PANEL_COLLAPSED_KEY, '1');
    await mount({ folders: [] });
    expect(q('[data-files-panel]')?.textContent).toContain(FILES_COPY.noFolder);
    expect(byLabel(FILES_COPY.collapse)).toBeUndefined();
    expect(byLabel(FILES_COPY.expand)).toBeUndefined();
  });
});
