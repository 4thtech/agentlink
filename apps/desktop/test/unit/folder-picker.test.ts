// FILES-FOLDER-PICKER (D-154): the native folder dialog. The preload calls the main process only on
// a user activation and answers only a path string or null; the main process answers only the main
// window's top frame on the locked origin, one dialog at a time, and only ONE absolute path.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import type {
  BrowserWindow,
  IpcMainInvokeEvent,
  OpenDialogOptions,
  OpenDialogResult,
} from '../../src/main/electron-api.js';
import {
  CHOOSE_FOLDER_CHANNEL,
  DIALOG_COPY,
  createChooseFolderHandler,
  defaultPathOf,
  parseChooseRequest,
  pickedPath,
  preloadPath,
} from '../../src/main/folder-picker.js';
import { OriginLock, webPreferences, windowOptions } from '../../src/main/security.js';
import { SESSION_URL } from './fakes.js';

const ORIGIN = 'http://localhost:4567';
const PRELOAD = new URL('../../src/main/preload.cjs', import.meta.url);

function lockedTo(): OriginLock {
  const lock = new OriginLock();
  expect(lock.acceptSessionUrl(SESSION_URL)).toBe(true);
  return lock;
}

const fakeWindow = (id = 7): BrowserWindow =>
  ({
    webContents: { id },
    isDestroyed: () => false,
  }) as unknown as BrowserWindow;

const event = (
  url = `${ORIGIN}/settings/files`,
  opts: { senderId?: number; top?: boolean } = {},
): IpcMainInvokeEvent => ({
  sender: { id: opts.senderId ?? 7 },
  senderFrame: {
    url,
    parent: opts.top === false ? { url: ORIGIN, parent: null } : null,
  },
});

function setup(
  answer: OpenDialogResult | Error = { canceled: false, filePaths: ['/Users/a/Work'] },
) {
  const calls: OpenDialogOptions[] = [];
  const handler = createChooseFolderHandler({
    lock: lockedTo(),
    sessionWindow: () => fakeWindow(),
    platform: 'darwin',
    home: '/Users/a',
    dialog: {
      showOpenDialog: (_window, options) => {
        calls.push(options);
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
    },
  });
  return { handler, calls };
}

describe('main process: who may open the dialog', () => {
  it('opens the native folder dialog for the window and answers ONE absolute path', async () => {
    const { handler, calls } = setup();
    await expect(handler(event(), { purpose: 'send' })).resolves.toBe('/Users/a/Work');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      title: DIALOG_COPY.send.title,
      buttonLabel: 'Choose',
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
    });
  });

  it('opens at the current folder (home as ~), with the Inbox words', async () => {
    const { handler, calls } = setup();
    await handler(event(), { purpose: 'inbox', current: '~/AgentLink/Inbox' });
    expect(calls[0]?.defaultPath).toBe('/Users/a/AgentLink/Inbox');
    expect(calls[0]?.title).toBe('Choose where received files are saved');
  });

  it.each([
    ['another origin', event('https://evil.example/')],
    ['a subframe', event(undefined, { top: false })],
    ['another web contents', event(undefined, { senderId: 99 })],
    ['the status page', event('data:text/html,status')],
  ])('refuses %s without a dialog', async (_name, from) => {
    const { handler, calls } = setup();
    await expect(handler(from, { purpose: 'send' })).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('refuses when no session page is shown', async () => {
    const calls: OpenDialogOptions[] = [];
    const handler = createChooseFolderHandler({
      lock: lockedTo(),
      sessionWindow: () => null,
      platform: 'darwin',
      dialog: {
        showOpenDialog: (_w, o) => (
          calls.push(o),
          Promise.resolve({ canceled: true, filePaths: [] })
        ),
      },
    });
    await expect(handler(event(), { purpose: 'send' })).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it.each([
    [undefined],
    ['send'],
    [{ purpose: 'other' }],
    [{ purpose: 'send', extra: 1 }],
    [{ purpose: 'send', current: 7 }],
    [{ purpose: 'send', current: 'x'.repeat(5000) }],
  ])('refuses the input %j', async (input) => {
    const { handler, calls } = setup();
    await expect(handler(event(), input)).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('one dialog at a time', async () => {
    let release: (r: OpenDialogResult) => void = () => undefined;
    const handler = createChooseFolderHandler({
      lock: lockedTo(),
      sessionWindow: () => fakeWindow(),
      platform: 'darwin',
      dialog: { showOpenDialog: () => new Promise((r) => (release = r)) },
    });
    const first = handler(event(), { purpose: 'send' });
    await expect(handler(event(), { purpose: 'send' })).resolves.toBeNull();
    release({ canceled: false, filePaths: ['/Users/a/Docs'] });
    await expect(first).resolves.toBe('/Users/a/Docs');
  });

  it('cancelled, several, relative, unshowable or a failing dialog: null', async () => {
    expect(pickedPath({ canceled: true, filePaths: ['/a'] }, 'darwin')).toBeNull();
    expect(pickedPath({ canceled: false, filePaths: ['/a', '/b'] }, 'darwin')).toBeNull();
    expect(pickedPath({ canceled: false, filePaths: ['a/b'] }, 'darwin')).toBeNull();
    expect(pickedPath({ canceled: false, filePaths: ['/a\u202eb'] }, 'darwin')).toBeNull();
    expect(pickedPath({ canceled: false, filePaths: ['C:\\Users\\a\\Work'] }, 'win32')).toBe(
      'C:\\Users\\a\\Work',
    );
    const { handler } = setup(new Error('boom'));
    await expect(handler(event(), { purpose: 'send' })).resolves.toBeNull();
  });

  it('parses the request strictly and expands ~ only for the preselected folder', () => {
    expect(parseChooseRequest({ purpose: 'inbox' })).toEqual({ purpose: 'inbox' });
    expect(defaultPathOf('relative', '/Users/a', 'darwin')).toBeUndefined();
    expect(defaultPathOf('~\\Docs', 'C:\\Users\\a', 'win32')).toBe('C:\\Users\\a\\Docs');
    // Fable r1: never a UNC or device path on Windows.
    expect(defaultPathOf('\\\\server\\share\\Inbox', 'C:\\Users\\a', 'win32')).toBeUndefined();
    expect(defaultPathOf('\\\\?\\C:\\Inbox', 'C:\\Users\\a', 'win32')).toBeUndefined();
    expect(defaultPathOf('C:/Users/a/Inbox', 'C:\\Users\\a', 'win32')).toBe('C:/Users/a/Inbox');
  });
});

describe('the window has the one preload, nothing else changes', () => {
  it('sets the preload only when given, and keeps every lockdown', () => {
    expect(webPreferences('darwin')).not.toHaveProperty('preload');
    const prefs = webPreferences('darwin', '/app/dist/main/preload.cjs');
    expect(prefs.preload).toBe('/app/dist/main/preload.cjs');
    expect(prefs).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false });
    expect(windowOptions('win32', '/p.cjs').webPreferences.preload).toBe('/p.cjs');
  });

  it('finds the preload next to the main bundle, or none', () => {
    expect(preloadPath(new URL('../../src/main/main.ts', import.meta.url).href)).toMatch(
      /preload\.cjs$/,
    );
    expect(preloadPath('file:///nowhere/main.js', () => false)).toBeUndefined();
  });
});

/** Runs preload.cjs with a fake Electron and a fake user activation. */
function loadPreload(active: { value: boolean }, answer: unknown = '/Users/a/Work') {
  const invoked: { channel: string; message: unknown }[] = [];
  const exposed: Record<string, unknown> = {};
  const electron = {
    contextBridge: {
      exposeInMainWorld: (name: string, value: unknown) => {
        exposed[name] = value;
      },
    },
    ipcRenderer: {
      invoke: (channel: string, message: unknown) => {
        invoked.push({ channel, message });
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
    },
  };
  const navigator = {
    userActivation: {
      get isActive() {
        return active.value;
      },
    },
  };
  const source = readFileSync(PRELOAD, 'utf8');
  runInNewContext(source, {
    require: (id: string) => {
      if (id !== 'electron') throw new Error(`no ${id}`);
      return electron;
    },
    navigator,
    globalThis: { navigator },
    Promise,
    Object,
    Boolean,
  });
  const api = exposed['agentlinkDesktop'] as {
    chooseFolder: (r: unknown) => Promise<string | null>;
  };
  return { api, invoked, exposed };
}

describe('preload: only chooseFolder, only on a user gesture, only a path', () => {
  it('exposes exactly one function', () => {
    const { api, exposed } = loadPreload({ value: true });
    expect(Object.keys(exposed)).toEqual(['agentlinkDesktop']);
    expect(Object.keys(api)).toEqual(['chooseFolder']);
    expect(Object.isFrozen(api)).toBe(true);
  });

  it('without a user activation nothing is asked', async () => {
    const { api, invoked } = loadPreload({ value: false });
    await expect(api.chooseFolder({ purpose: 'send' })).resolves.toBeNull();
    expect(invoked).toHaveLength(0);
  });

  it('on a click it sends only the purpose (and the current folder) and answers the path', async () => {
    const { api, invoked } = loadPreload({ value: true });
    await expect(
      api.chooseFolder({ purpose: 'inbox', current: '~/AgentLink/Inbox', other: 'x' }),
    ).resolves.toBe('/Users/a/Work');
    expect(invoked).toEqual([
      {
        channel: CHOOSE_FOLDER_CHANNEL,
        message: { purpose: 'inbox', current: '~/AgentLink/Inbox' },
      },
    ]);
  });

  it('anything but a path string is null; a failure is null; a bad purpose asks nothing', async () => {
    await expect(
      loadPreload({ value: true }, { path: '/x' }).api.chooseFolder({ purpose: 'send' }),
    ).resolves.toBeNull();
    await expect(
      loadPreload({ value: true }, new Error('x')).api.chooseFolder({ purpose: 'send' }),
    ).resolves.toBeNull();
    const { api, invoked } = loadPreload({ value: true });
    await expect(api.chooseFolder({ purpose: 'keys' })).resolves.toBeNull();
    await expect(api.chooseFolder(null)).resolves.toBeNull();
    expect(invoked).toHaveLength(0);
  });

  it('one at a time', async () => {
    const { api, invoked } = loadPreload({ value: true });
    const first = api.chooseFolder({ purpose: 'send' });
    await expect(api.chooseFolder({ purpose: 'send' })).resolves.toBeNull();
    await first;
    expect(invoked).toHaveLength(1);
  });
});
