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
// (apps/cli runtime/npm-update-check.ts): the npm registry's latest version, never a link. Every
// answer names how this copy was installed (`install`), so the page shows the one right action: the
// desktop app's release link, "Restart AgentLink" (the installer's command and npx run the latest at
// every start) or the one update command (a global npm install). A server with no desk (the MCP
// server's page, first run in a terminal) answers 501 `not_available` and the page says so. Every answer is rebuilt field by field and
// checked again here (the same rules as the pipe), so nothing but those fixed forms ever reaches the
// page. Not an MCP tool (I-4).
import type { JsonObject } from '@4thtech-io/crypto';
import type { LocalUiContext } from '../context.js';
import type { LocalUiReadRoute, LocalUiResult, LocalUiRoute } from '../route-types.js';
import { NOT_AVAILABLE, UI_INVALID_QUERY, UI_UNAVAILABLE } from '../route-types.js';

export const APP_UPDATE_PATH = '/api/ui/app-update';
export const APP_UPDATE_CHECK_PATH = '/api/ui/app-update/check';

export const APP_UPDATE_STATES = Object.freeze([
  'off',
  'idle',
  'checking',
  'current',
  'available',
  'failed',
  'offline',
] as const);
export type AppUpdateState = (typeof APP_UPDATE_STATES)[number];

export interface AppUpdateView {
  readonly state: AppUpdateState;
  readonly current: string;
  readonly latest: string;
  readonly download: string;
}

/** How this copy of AgentLink was installed (what the page offers to update it). */
export const APP_UPDATE_INSTALLS = Object.freeze([
  'desktop',
  'installer',
  'npx',
  'global',
] as const);
export type AppUpdateInstall = (typeof APP_UPDATE_INSTALLS)[number];

/** The host's side (desktop: apps/cli/src/desktop/host-core.ts; browser: runtime/npm-update-check.ts). */
export interface LocalUiAppUpdateDesk {
  /** How this copy was installed (fixed for the life of the process). */
  readonly install: AppUpdateInstall;
  /** The shell's last state, or undefined before it sent one. */
  view(): AppUpdateView | undefined;
  /** Asks the shell to check now; returns the state to show meanwhile. */
  check(): AppUpdateView | undefined;
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
): JsonObject | undefined {
  if (view === undefined) return undefined;
  if (!(APP_UPDATE_INSTALLS as readonly string[]).includes(install)) return undefined;
  const { state, current, latest, download } = view;
  if (!(APP_UPDATE_STATES as readonly string[]).includes(state)) return undefined;
  if (typeof current !== 'string' || !APP_VERSION.test(current)) return undefined;
  if (state === 'available') {
    if (typeof latest !== 'string' || !newer(latest, current)) return undefined;
    if (install === 'desktop' ? !linkFor(download, latest) : download !== '') return undefined;
  } else if (latest !== '' || download !== '') return undefined;
  return { state, current, latest, download, install };
}

const answer = (desk: LocalUiAppUpdateDesk, view: AppUpdateView | undefined): LocalUiResult => {
  const body = appUpdateBody(view, desk.install);
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

export const appUpdateRoutes: readonly LocalUiRoute[] = Object.freeze([readRoute, checkRoute]);
