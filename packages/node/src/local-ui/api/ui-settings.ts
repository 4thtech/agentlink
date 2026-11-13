// W4-SHELL-V2 (Decisions 49–51; 08 §1, proposed): the app's own UI settings, stored by the local
// app (not per browser), so "Under the hood" and the section menu are the same in every window.
//
// - `GET /api/ui/ui-settings` (a read route): the stored allowlisted switches, `{}` when none was
//   ever set or outside the app host. Answers with no agent open too (first run shows the shell).
// - `PUT /api/ui/ui-settings` (the `ui-settings` kind, routes.ts): one fixed path, registered once,
//   no owner presence and nothing signed: it changes how the app looks, never what an agent may do
//   (I-4: no policy, key or approval is reachable from here). The server's ui-settings gate runs it
//   after the same session, CSRF, Origin, Host, fetch-metadata and octet-stream checks as every write,
//   refuses a query, an operation input or a presence header, and parses the body itself (strict
//   JSON, allowlisted keys, boolean switches and the strict `kept` page choices of UX1113-QA-HOST,
//   at most UI_SETTINGS_MAX_BODY_BYTES). The handler gets only
//   that checked change. The file write is the app host's (`~/.agentlink/ui-settings.json`, 0600, a
//   fresh exclusive temp file renamed into place, never following a link;
//   apps/cli/src/runtime/agent-dir.ts).
// - Fixed answers only; nothing here logs a value or a path.
import type { JsonObject } from '@4thtech-io/crypto';
import {
  UI_KEPT_KEYS,
  UI_SETTINGS_PATH,
  mergeUiSettings,
  readKeptValue,
  type UiSettings,
} from '@4thtech-io/types/ui-contract/ui-settings';
import { NOTIFY_PREF_KEYS } from '@4thtech-io/types/ui-contract/notifications';
import type { LocalUiContext } from '../context.js';
import {
  NOT_AVAILABLE,
  UI_INVALID_QUERY,
  UI_UNAVAILABLE,
  type LocalUiReadRoute,
  type LocalUiResult,
  type LocalUiRoute,
  type LocalUiUiSettingsRoute,
} from '../route-types.js';

export { UI_SETTINGS_PATH };

/** The app host's settings store (LocalUiContext.uiSettings). Never throws a value or a path. */
export interface LocalUiSettingsDesk {
  read(): Promise<UiSettings>;
  /** Merges the change into the stored settings and returns what is stored now. */
  update(change: UiSettings): Promise<UiSettings>;
}

/**
 * A body of the allowlisted settings, built key by key (nothing of the source object is passed on).
 * UX1113-QA-HOST: `kept` carries only allowlisted keys whose value passes its own check again.
 */
function body(settings: UiSettings): JsonObject {
  const out: Record<string, boolean | Record<string, string> | Record<string, boolean>> = {};
  if (typeof settings.underTheHood === 'boolean') out['underTheHood'] = settings.underTheHood;
  if (typeof settings.menuExpanded === 'boolean') out['menuExpanded'] = settings.menuExpanded;
  if (settings.kept !== undefined) {
    const kept: Record<string, string> = {};
    for (const key of UI_KEPT_KEYS) {
      const value = readKeptValue(key, settings.kept[key]);
      if (value !== undefined) kept[key] = value;
    }
    out['kept'] = kept;
  }
  if (settings.notify !== undefined) {
    // N6: the Settings › Notifications switches, key by key (readNotifyPrefs checked them).
    const notify: Record<string, boolean> = {};
    for (const key of NOTIFY_PREF_KEYS) {
      const value = settings.notify[key];
      if (typeof value === 'boolean') notify[key] = value;
    }
    out['notify'] = notify;
  }
  return out;
}

const readRoute: LocalUiReadRoute = Object.freeze<LocalUiReadRoute>({
  method: 'GET',
  path: UI_SETTINGS_PATH,
  presence: false,
  handler: async (context: LocalUiContext, request): Promise<LocalUiResult> => {
    if ([...request.query.keys()].length > 0) {
      return UI_INVALID_QUERY;
    }
    const desk = context.uiSettings;
    if (desk === undefined) return { status: 200, body: {} };
    try {
      return { status: 200, body: body(await desk.read()) };
    } catch {
      return UI_UNAVAILABLE;
    }
  },
});

/** The ui-settings kind's one route (approval-server.ts uiSettingsGate runs it). */
export const uiSettingsWriteRoute: LocalUiUiSettingsRoute = Object.freeze<LocalUiUiSettingsRoute>({
  method: 'PUT',
  path: UI_SETTINGS_PATH,
  presence: 'ui-settings',
  handler: async (context: LocalUiContext, change: UiSettings): Promise<LocalUiResult> => {
    const desk = context.uiSettings;
    if (desk === undefined) return NOT_AVAILABLE;
    try {
      return { status: 200, body: body(await desk.update(change)) };
    } catch {
      return UI_UNAVAILABLE;
    }
  },
});

export const uiSettingsRoutes: readonly LocalUiRoute[] = Object.freeze([
  readRoute,
  uiSettingsWriteRoute,
]);

/**
 * The desk over the app host's directory: one change at a time (a later PUT never overwrites an
 * earlier one with a stale read), each a read, a merge and one atomic write.
 */
export function createUiSettingsDesk(store: {
  readonly read: () => Promise<UiSettings | undefined>;
  readonly write: (settings: UiSettings) => Promise<void>;
}): LocalUiSettingsDesk {
  let queue: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<UiSettings> => (await store.read()) ?? {};
  return Object.freeze<LocalUiSettingsDesk>({
    read,
    update: (change) => {
      const run = queue.then(async () => {
        // UX1113-QA-HOST: `kept` merges key by key; a null forgets that key (never stored).
        const next: UiSettings = mergeUiSettings(await read(), change);
        await store.write(next);
        return next;
      });
      queue = run.catch(() => undefined);
      return run;
    },
  });
}
