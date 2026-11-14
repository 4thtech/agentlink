// DESK051-UPD (08 §8, before the signed updater; I-4, I-5, I-7): Settings > Updates in the desktop app.
//
// - `GET /api/ui/app-update` (read, `presence: false`): what the desktop app's shell last told this
//   core over its private pipe (apps/cli/src/desktop): a fixed state word, this app's version and,
//   only when a newer release is ready, its version and the exact release link the shell built
//   (this repository's release file for this Mac, or its release page).
// - `GET /api/ui/app-update/check` (read, `presence: false`): asks the shell to check now. It changes
//   nothing on this computer (no policy, key, approval or file): the shell makes one request to its
//   one fixed source and answers with a new state. A read route on purpose, with the gates of every
//   read (session cookie, CSRF header, fetch metadata): it needs no presence and carries no body.
//
// REL051-UPD2: the browser app (the local app server `agentlink` / npx starts) wires its own desk
// (apps/cli/src/runtime/npm-update-check.ts): the npm registry's latest version, never a link. Every
// answer names how this copy was installed (`install`), so the page shows the one right action: the
// desktop app's release link, "Restart AgentLink" (the installer's command and npx run the latest at
// every start) or the one update command (a global npm install). A server with no desk (the MCP
// server's page, first run in a terminal) answers 501 `not_available` and the page says so. Every answer is rebuilt field by field and
// checked again here (the same rules as the pipe), so nothing but those fixed forms ever reaches the
// page. Not an MCP tool (I-4).
//
// UPD-5 (desktop app only): `POST /api/ui/app-update/install` ("Update now") and
// `POST /api/ui/app-update/restart` ("Restart now"), routes of the mark kind: the server's mark gate
// runs them after the session cookie, CSRF, Origin, fetch-metadata, octet-stream and generation
// checks, with no query, input, presence header or body byte. They pass no value: the desk sends the
// shell one bare message, and the shell installs only the update it verified itself (signed manifest,
// zip hash, bundle checks) and restarts only once that update is ready. No owner presence: the trust
// anchor is the shell's verification, not the page (I-4: nothing here changes a policy, a key or an
// approval). Every desktop answer also carries `installable`, `percent` and `busy` (a request is
// waiting for the owner: the page warns before Restart now).
//
// BROWSER-UPDATE: the terminal `agentlink ui` host's desk (apps/cli/src/runtime/browser-update.ts)
// has the same two steps for the browser app: Update now stages the exact version the registry
// named (provenance from this repository required, npm by argv with no inherited npm configuration, scripts off, lockfile all registry.npmjs.org sha512, `npm audit signatures`), Restart now hands
// the terminal to it. Its answers carry `installable` (and the same in-app states), never a link.
// The same mark gate; the MCP server's page has no desk (501), and no MCP tool reaches it (I-4).
import type { JsonObject } from '@4thtech-io/crypto';
import type { LocalUiContext } from '../context.js';
import type {
  LocalUiMarkRoute,
  LocalUiReadRoute,
  LocalUiResult,
  LocalUiRoute,
} from '../route-types.js';
import { NOT_AVAILABLE, UI_INVALID_QUERY, UI_UNAVAILABLE } from '../route-types.js';

export const APP_UPDATE_PATH = '/api/ui/app-update';
export const APP_UPDATE_CHECK_PATH = '/api/ui/app-update/check';
/** UPD-5: "Update now" and "Restart now" (the mark kind, route-types.ts MARK_PATHS). */
export const APP_UPDATE_INSTALL_PATH = '/api/ui/app-update/install';
export const APP_UPDATE_RESTART_PATH = '/api/ui/app-update/restart';

export const APP_UPDATE_STATES = Object.freeze([
  'off',
  'idle',
  'checking',
  'current',
  'available',
  'failed',
  'offline',
  // UPD-5: the desktop app's in-app update.
  'downloading',
  'verifying',
  'ready',
  'restarting',
  'install_failed',
] as const);
export type AppUpdateState = (typeof APP_UPDATE_STATES)[number];

/** UPD-5: the states of a running in-app update (always installable; desktop only). */
const IN_APP_STATES: readonly string[] = ['downloading', 'verifying', 'ready', 'restarting'];
/** The states that carry a newer version (and, in the desktop app, its link). */
const WITH_RELEASE: readonly string[] = ['available', 'install_failed', ...IN_APP_STATES];

export interface AppUpdateView {
  readonly state: AppUpdateState;
  readonly current: string;
  readonly latest: string;
  readonly download: string;
  /** UPD-5 (desktop): "Update now" can run here. Absent: false. */
  readonly installable?: boolean;
  /** UPD-5 (desktop): the download's whole percentage, only while downloading. Absent: 0. */
  readonly percent?: number;
}

/** How this copy of AgentLink was installed (what the page offers to update it). */
export const APP_UPDATE_INSTALLS = Object.freeze([
  'desktop',
  'installer',
  'npx',
  'global',
] as const);
export type AppUpdateInstall = (typeof APP_UPDATE_INSTALLS)[number];

/** The host's side (desktop: apps/cli/src/desktop/host-core.ts; browser: apps/cli/src/runtime/npm-update-check.ts). */
export interface LocalUiAppUpdateDesk {
  /** How this copy was installed (fixed for the life of the process). */
  readonly install: AppUpdateInstall;
  /** The shell's last state, or undefined before it sent one. */
  view(): AppUpdateView | undefined;
  /** Asks the shell to check now; returns the state to show meanwhile. */
  check(): AppUpdateView | undefined;
  /** UPD-5 (desktop): "Update now"; returns the state to show meanwhile. */
  startInstall?(): AppUpdateView | undefined;
  /** UPD-5 (desktop): "Restart now"; returns the state to show meanwhile. */
  restart?(): AppUpdateView | undefined;
  /** UPD-5 (desktop): a request is waiting for the owner (the page warns before a restart). */
  busy?(): boolean;
}

const NUM = '(0|[1-9][0-9]{0,5})';
const RELEASE_VERSION = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}$`);
const APP_VERSION = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-[0-9A-Za-z][0-9A-Za-z.]{0,31})?$`);
const RELEASES = 'https://github.com/4thtech/agentlink/releases';

function newer(latest: string, current: string): boolean {
  const a = RELEASE_VERSION.exec(latest);
  const b = RELEASE_VERSION.exec(current);
  if (a === null || b === null) return false;
  for (let i = 1; i <= 3; i += 1) {
    if (Number(a[i]) !== Number(b[i])) return Number(a[i]) > Number(b[i]);
  }
  return false;
}

function linkFor(url: unknown, version: string): boolean {
  return (
    url === `${RELEASES}/download/v${version}/AgentLink-${version}-mac-arm64.dmg` ||
    url === `${RELEASES}/download/v${version}/AgentLink-${version}-mac-x64.dmg` ||
    // WIN-DESK-2: the Windows app's setup (x64; no in-app update on Windows).
    url === `${RELEASES}/download/v${version}/AgentLink-${version}-win-x64-setup.exe` ||
    url === `${RELEASES}/tag/v${version}`
  );
}

/**
 * The view as an answer body, or undefined when any field breaks the rules. Only the desktop app
 * carries a link (this repository's release file or page); the browser app never does.
 */
export function appUpdateBody(
  view: AppUpdateView | undefined,
  install: AppUpdateInstall,
  busy = false,
): JsonObject | undefined {
  if (view === undefined) return undefined;
  if (!(APP_UPDATE_INSTALLS as readonly string[]).includes(install)) return undefined;
  const { state, current, latest, download } = view;
  const installable = view.installable ?? false;
  const percent = view.percent ?? 0;
  if (!(APP_UPDATE_STATES as readonly string[]).includes(state)) return undefined;
  if (typeof current !== 'string' || !APP_VERSION.test(current)) return undefined;
  if (typeof installable !== 'boolean' || typeof busy !== 'boolean') return undefined;
  if (typeof percent !== 'number' || !Number.isSafeInteger(percent)) return undefined;
  if (percent < 0 || percent > 100 || (state !== 'downloading' && percent !== 0)) return undefined;
  if (IN_APP_STATES.includes(state) ? !installable : state !== 'available' && installable) {
    return undefined;
  }
  if (WITH_RELEASE.includes(state)) {
    // BROWSER-UPDATE: the browser app's in-app update (its desk says `installable`) follows the
    // same state rules as the desktop app's, never with a link; a browser view without
    // `installable` is the restart or the one command, as before (available only).
    const browserInApp = install !== 'desktop' && view.installable !== undefined;
    if (install !== 'desktop' && !browserInApp && state !== 'available') return undefined;
    if (typeof latest !== 'string' || !newer(latest, current)) return undefined;
    if (install === 'desktop' ? !linkFor(download, latest) : download !== '') return undefined;
  } else if (latest !== '' || download !== '') return undefined;
  if (install !== 'desktop' && view.installable === undefined) {
    return { state, current, latest, download, install };
  }
  return { state, current, latest, download, install, installable, percent, busy };
}

const busyOf = (desk: LocalUiAppUpdateDesk): boolean => desk.busy?.() === true;

const answer = (desk: LocalUiAppUpdateDesk, view: AppUpdateView | undefined): LocalUiResult => {
  const body = appUpdateBody(view, desk.install, busyOf(desk));
  return body === undefined ? UI_UNAVAILABLE : { status: 200, body };
};

const readRoute: LocalUiReadRoute = Object.freeze<LocalUiReadRoute>({
  method: 'GET',
  path: APP_UPDATE_PATH,
  presence: false,
  handler: (context: LocalUiContext, request): Promise<LocalUiResult> => {
    if ([...request.query.keys()].length > 0) return Promise.resolve(UI_INVALID_QUERY);
    const desk = context.appUpdate;
    if (desk === undefined) return Promise.resolve(NOT_AVAILABLE);
    try {
      return Promise.resolve(answer(desk, desk.view()));
    } catch {
      return Promise.resolve(UI_UNAVAILABLE);
    }
  },
});

const checkRoute: LocalUiReadRoute = Object.freeze<LocalUiReadRoute>({
  method: 'GET',
  path: APP_UPDATE_CHECK_PATH,
  presence: false,
  handler: (context: LocalUiContext, request): Promise<LocalUiResult> => {
    if ([...request.query.keys()].length > 0) return Promise.resolve(UI_INVALID_QUERY);
    const desk = context.appUpdate;
    if (desk === undefined) return Promise.resolve(NOT_AVAILABLE);
    try {
      return Promise.resolve(answer(desk, desk.check()));
    } catch {
      return Promise.resolve(UI_UNAVAILABLE);
    }
  },
});

/** UPD-5: one in-app step (desktop app only; 501 elsewhere). */
const stepRoute = (path: string, step: 'startInstall' | 'restart'): LocalUiMarkRoute =>
  Object.freeze<LocalUiMarkRoute>({
    method: 'POST',
    path,
    presence: 'mark',
    handler: (context: LocalUiContext): Promise<LocalUiResult> => {
      const desk = context.appUpdate;
      const run = desk?.[step];
      // BROWSER-UPDATE: any desk with the step (the desktop app's, or the terminal `agentlink ui`
      // host's BrowserUpdater desk); the MCP server's page has no desk at all.
      if (desk === undefined || run === undefined) {
        return Promise.resolve(NOT_AVAILABLE);
      }
      try {
        return Promise.resolve(answer(desk, run.call(desk)));
      } catch {
        return Promise.resolve(UI_UNAVAILABLE);
      }
    },
  });

export const appUpdateRoutes: readonly LocalUiRoute[] = Object.freeze([
  readRoute,
  checkRoute,
  stepRoute(APP_UPDATE_INSTALL_PATH, 'startInstall'),
  stepRoute(APP_UPDATE_RESTART_PATH, 'restart'),
]);
