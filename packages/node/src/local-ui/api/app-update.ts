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
// Only the desktop host wires a desk (ApprovalServerOptions.appUpdate); everywhere else both routes
// answer 501 `not_available` and the page is not offered. Every answer is rebuilt field by field and
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

/** The desktop host's side (apps/cli/src/desktop/host-core.ts). */
export interface LocalUiAppUpdateDesk {
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

/** The view as an answer body, or undefined when any field breaks the rules. */
export function appUpdateBody(view: AppUpdateView | undefined): JsonObject | undefined {
  if (view === undefined) return undefined;
  const { state, current, latest, download } = view;
  if (!(APP_UPDATE_STATES as readonly string[]).includes(state)) return undefined;
  if (typeof current !== 'string' || !APP_VERSION.test(current)) return undefined;
  if (state === 'available') {
    if (typeof latest !== 'string' || !newer(latest, current) || !linkFor(download, latest)) {
      return undefined;
    }
  } else if (latest !== '' || download !== '') return undefined;
  return { state, current, latest, download };
}

const answer = (view: AppUpdateView | undefined): LocalUiResult => {
  const body = appUpdateBody(view);
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
      return Promise.resolve(answer(desk.view()));
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
      return Promise.resolve(answer(desk.check()));
    } catch {
      return Promise.resolve(UI_UNAVAILABLE);
    }
  },
});

export const appUpdateRoutes: readonly LocalUiRoute[] = Object.freeze([readRoute, checkRoute]);
