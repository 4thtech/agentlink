// TRAY-POPOVER (D-155; plan §4): the popover's one IPC channel, `agentlink:widget`.
//
// The popover's preload (widget-preload.cjs) exposes `window.agentlinkWidget.{open({route, target?}),
// quit(), close()}` and nothing else, each only on a fresh user activation, one call at a time. The
// main process (this file) answers `true` only when every one of these holds, else `false`:
// - the call comes from the popover's own web contents while it is on screen and shows the widget
//   page (Popover.widgetContentsId), from its top frame, on the locked origin (the core's
//   `http://localhost:<port>`), at exactly `/settings/widget` with no query;
// - the input is exactly `{action: 'open', route, target?}`, `{action: 'quit'}` or
//   `{action: 'close'}`; `route` is one of WIDGET_ROUTES and `target` follows the pipe's
//   notify-target rules for that route (a person's `0x…` local ID for inbox, an `apr_…` request ID
//   for approvals, none for home and updates).
// `open` becomes the shell's existing `show {route, target}` (TRAY-SHELL wires `openPage`): the main
// window opens on that page, and the popover closes. Approving, resuming and every other owner
// operation happen there, never in the popover. Nothing but a boolean comes back; nothing is logged.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isNotifyTarget } from '../shared/protocol.js';
import type { IpcMain, IpcMainInvokeEvent } from './electron-api.js';
import { POPOVER_PATH, type OriginLock } from './security.js';

/** The one channel; widget-preload.js names the same string. */
export const WIDGET_CHANNEL = 'agentlink:widget';

/** The popover preload's file name next to the bundled main (dist-release/main/). */
export const WIDGET_PRELOAD_FILE = 'widget-preload.cjs';

/** The pages the popover may open in the main window (a subset of the pipe's SHOW_ROUTES). */
export const WIDGET_ROUTES = ['home', 'inbox', 'approvals', 'updates'] as const;
export type WidgetRoute = (typeof WIDGET_ROUTES)[number];

export type WidgetRequest =
  | { readonly action: 'open'; readonly route: WidgetRoute; readonly target?: string }
  | { readonly action: 'quit' }
  | { readonly action: 'close' };

/** The preload's path when it is in the bundle; undefined otherwise (then the popover has no IPC). */
export function widgetPreloadPath(
  base: string = import.meta.url,
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  try {
    const file = fileURLToPath(new URL(`./${WIDGET_PRELOAD_FILE}`, base));
    return exists(file) ? file : undefined;
  } catch {
    return undefined;
  }
}

const own = (value: object, key: string): boolean => Object.hasOwn(value, key);

/** The request, strictly (exact own keys, fixed values); anything else is undefined. */
export function parseWidgetRequest(input: unknown): WidgetRequest | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  if (Object.getPrototypeOf(input) !== Object.prototype) return undefined;
  const keys = Object.keys(input);
  if (!own(input, 'action')) return undefined;
  const action = (input as { action?: unknown }).action;
  if (action === 'quit' || action === 'close') {
    return keys.length === 1 ? { action } : undefined;
  }
  if (action !== 'open') return undefined;
  const withTarget = own(input, 'target');
  if (keys.length !== (withTarget ? 3 : 2) || !own(input, 'route')) return undefined;
  const { route, target } = input as { route?: unknown; target?: unknown };
  if (!(WIDGET_ROUTES as readonly unknown[]).includes(route)) return undefined;
  const widgetRoute = route as WidgetRoute;
  if (!withTarget) return { action, route: widgetRoute };
  if (!isNotifyTarget(widgetRoute, target)) return undefined;
  return { action, route: widgetRoute, target };
}

/** True for the widget page's own URL on the locked origin (no query). */
function isWidgetPage(lock: OriginLock, url: string): boolean {
  if (!lock.allows(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && parsed.pathname === POPOVER_PATH && parsed.search === '';
  } catch {
    return false;
  }
}

export interface WidgetIpcDeps {
  readonly lock: OriginLock;
  /** Popover.widgetContentsId: the popover's id while it is visible on the widget page, else null. */
  readonly widgetContentsId: () => number | null;
  /** The existing `show {route, target}`: the main window on that page. */
  readonly openPage: (route: WidgetRoute, target?: string) => void;
  readonly quit: () => void;
  /** Hides the popover. */
  readonly close: () => void;
}

/** The IPC handler (see the header); never throws, answers true or false. */
export function createWidgetHandler(
  deps: WidgetIpcDeps,
): (event: IpcMainInvokeEvent, input: unknown) => Promise<boolean> {
  return (event, input) => {
    try {
      const id = deps.widgetContentsId();
      if (id === null || event.sender.id !== id) return Promise.resolve(false);
      const frame = event.senderFrame;
      if (frame === null || frame.parent !== null) return Promise.resolve(false);
      if (!isWidgetPage(deps.lock, frame.url)) return Promise.resolve(false);
      const request = parseWidgetRequest(input);
      if (request === undefined) return Promise.resolve(false);
      switch (request.action) {
        case 'open':
          if (request.target === undefined) deps.openPage(request.route);
          else deps.openPage(request.route, request.target);
          deps.close();
          break;
        case 'close':
          deps.close();
          break;
        case 'quit':
          deps.quit();
          break;
      }
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  };
}

/** Registers the one channel. */
export function registerWidgetIpc(ipcMain: IpcMain, deps: WidgetIpcDeps): void {
  const handler = createWidgetHandler(deps);
  ipcMain.handle(WIDGET_CHANNEL, (event, input) => handler(event, input));
}
