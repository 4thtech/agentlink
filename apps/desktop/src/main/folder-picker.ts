// FILES-FOLDER-PICKER (D-161, proposed, owner confirms at merge; 08 §1 "Choosing a folder"): the
// native folder dialog for Settings › Files, the Files step and Home's Files panel in the app's
// window. Owner (14 Nov): "users should be able to click and then select via Finder."
//
// The one preload (preload.cjs) exposes `window.agentlinkDesktop.chooseFolder({purpose, current?})`
// and nothing else. It calls the main process only while the page has a fresh user activation (a
// real click or key press: a script can't make one), one dialog at a time. The main process answers
// it (this file) only when every one of these holds, else `null`:
// - the call comes from the main window's own web contents, from its top frame, on the locked
//   origin (the core's `http://localhost:<port>`), while a session page is shown (never the status
//   page);
// - the input is exactly `{purpose: 'send' | 'inbox'}` plus an optional `current` path that only
//   preselects where the dialog opens;
// - no other dialog is open (one at a time).
// The dialog is modal to the window (Electron `dialog.showOpenDialog`, `openDirectory`,
// `createDirectory`); the answer is ONE absolute path string, or `null` when cancelled. Nothing is
// logged, nothing is kept.
//
// The picker grants nothing by itself: the page treats the path exactly as typed text and runs the
// existing review (realpath, links, protected and too-broad folders, D-99; the Inbox rules of 04
// §4.1) and the confirm with the owner's presence and signature (D-119). It is not reachable from
// the core, from MCP or from any other process: only this window's renderer can invoke it.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  BrowserWindow,
  Dialog,
  IpcMain,
  IpcMainInvokeEvent,
  OpenDialogOptions,
} from './electron-api.js';
import type { OriginLock } from './security.js';

/** The one IPC channel; the preload names the same string. */
export const CHOOSE_FOLDER_CHANNEL = 'agentlink:choose-folder';

/** The preload's file name next to the bundled main (dist/main/preload.cjs). */
export const PRELOAD_FILE = 'preload.cjs';

export type FolderPurpose = 'send' | 'inbox';

/** The dialog's fixed words (11 §5: plain words). */
export const DIALOG_COPY: Readonly<
  Record<FolderPurpose, { readonly title: string; readonly buttonLabel: string }>
> = Object.freeze({
  send: Object.freeze({ title: 'Choose a folder your AI can send from', buttonLabel: 'Choose' }),
  inbox: Object.freeze({ title: 'Choose where received files are saved', buttonLabel: 'Choose' }),
});

const MAX_PATH_CHARS = 4096;
/** Control, format (bidi, zero-width) and separator characters: such a path is never answered. */
const UNSHOWABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

/** The preload's path when it is in the bundle; undefined otherwise (then no picker, the field). */
export function preloadPath(
  base: string = import.meta.url,
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  try {
    const file = fileURLToPath(new URL(`./${PRELOAD_FILE}`, base));
    return exists(file) ? file : undefined;
  } catch {
    return undefined;
  }
}

/** The request, strictly: `{purpose}` or `{purpose, current}`; anything else is undefined. */
export function parseChooseRequest(
  input: unknown,
): { readonly purpose: FolderPurpose; readonly current?: string } | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const keys = Object.keys(input);
  if (!keys.every((k) => k === 'purpose' || k === 'current')) return undefined;
  const { purpose, current } = input as { purpose?: unknown; current?: unknown };
  if (purpose !== 'send' && purpose !== 'inbox') return undefined;
  if (current === undefined) return { purpose };
  if (typeof current !== 'string' || current.length === 0 || current.length > MAX_PATH_CHARS) {
    return undefined;
  }
  return { purpose, current };
}

/** Where the dialog opens: the current folder (`~` expanded) when it is a full path, else none. */
export function defaultPathOf(
  current: string | undefined,
  home: string,
  platform: string,
): string | undefined {
  if (current === undefined || UNSHOWABLE.test(current)) return undefined;
  const api = platform === 'win32' ? path.win32 : path.posix;
  const sep = platform === 'win32' ? /^~[\\/]/ : /^~\//;
  const expanded =
    current === '~' ? home : sep.test(current) ? api.join(home, current.slice(2)) : current;
  return api.isAbsolute(expanded) ? expanded : undefined;
}

/** The dialog's answer as ONE absolute, showable path, or null. */
export function pickedPath(
  result: { readonly canceled: boolean; readonly filePaths: readonly unknown[] } | undefined,
  platform: string,
): string | null {
  if (result === undefined || result.canceled || result.filePaths.length !== 1) return null;
  const [picked] = result.filePaths;
  if (typeof picked !== 'string' || picked.length === 0 || picked.length > MAX_PATH_CHARS) {
    return null;
  }
  if (UNSHOWABLE.test(picked)) return null;
  const api = platform === 'win32' ? path.win32 : path.posix;
  return api.isAbsolute(picked) ? picked : null;
}

export interface ChooseFolderDeps {
  readonly lock: OriginLock;
  /** The main window when one exists and shows a session page (never the status page); else null. */
  readonly sessionWindow: () => BrowserWindow | null;
  readonly dialog: Pick<Dialog, 'showOpenDialog'>;
  readonly platform: string;
  readonly home?: string;
}

/** The IPC handler (see the header); never throws, answers a path string or null. */
export function createChooseFolderHandler(
  deps: ChooseFolderDeps,
): (event: IpcMainInvokeEvent, input: unknown) => Promise<string | null> {
  let open = false;
  return async (event, input) => {
    const window = deps.sessionWindow();
    if (window === null || window.isDestroyed()) return null;
    const frame = event.senderFrame;
    if (frame === null || frame.parent !== null) return null;
    if (window.webContents.id === undefined || event.sender.id !== window.webContents.id) {
      return null;
    }
    if (!deps.lock.allows(frame.url)) return null;
    const request = parseChooseRequest(input);
    if (request === undefined) return null;
    const show = deps.dialog.showOpenDialog;
    if (show === undefined || open) return null;
    const defaultPath = defaultPathOf(request.current, deps.home ?? homedir(), deps.platform);
    const options: OpenDialogOptions = {
      ...DIALOG_COPY[request.purpose],
      ...(defaultPath === undefined ? {} : { defaultPath }),
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
    };
    open = true;
    try {
      return pickedPath(await show.call(deps.dialog, window, options), deps.platform);
    } catch {
      return null;
    } finally {
      open = false;
    }
  };
}

/** Registers the one channel. */
export function registerFolderPicker(ipcMain: IpcMain, deps: ChooseFolderDeps): void {
  const handler = createChooseFolderHandler(deps);
  ipcMain.handle(CHOOSE_FOLDER_CHANNEL, (event, input) => handler(event, input));
}
