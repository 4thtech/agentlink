// M1-11s-b: the local UI route registry (08 §1; 04 §2.5; D-118; I-4).
//
// - Every route declares its method, its path under /api/ui/ and `presence`. Registration throws when
//   a mutating method (POST, PUT, PATCH, DELETE) does not declare `presence: true`, or a GET does,
//   so no route can reach an owner operation around the central presence gate (approval-server.ts).
// - M1-11s-c: a `presence: 'setup'` route is only a POST under /api/ui/first-run/, has no handler
//   and is registered at most once per step (begin, finish); the server's setup gate runs it.
// - MSG-FILES-IO-h (D-134): a `presence: 'reveal'` route (Show in Finder) is only a POST at
//   REVEAL_PATH with a handler, registered once; the server's reveal gate runs it. No other path,
//   method or route can use the kind, and every other mutating route still needs presence.
// - UX2-d1 (owner decision 1.1): a `presence: 'invite'` route is only a POST with a handler, step
//   `create` at INVITE_CREATE_PATH or step `check` at INVITE_CHECK_PATH, each registered once; the
//   server's invite gate runs it. Accepting an invite (INVITE_ACCEPT_PATH) is a `presence: true`
//   route like every other change.
// - U3-c (D-138, 08 §1): a `presence: 'switch'` route is only a POST at AGENTS_SWITCH_PATH with no
//   handler, registered once; the server's switch gate runs it. A `stub: true` route is a reserved U3
//   route (`presence: true`, with a handler that never runs): the server answers it 501
//   `not_available` before the presence gate. This file registers every U3 route of 08 §1 now, so the
//   later cards only replace the stubs in their own api/ files.
// - W4-PAUSE (D-143 (5), 08 §1): a `presence: 'pause'` route is only a POST at AGENTS_PAUSE_PATH with
//   no handler, registered once; the server's pause gate runs it. Resume (AGENTS_RESUME_PATH) is a
//   `presence: true` route like every other change.
// - A path is fixed segments `[a-z0-9-]` and `:name` parameters; a parameter matches only
//   `[A-Za-z0-9_-]{1,128}` (no dot, no percent-escape, no slash), so no handler sees `..` or an
//   encoded separator. Duplicates throw.
// - UX1113-R1 (D-147): a `presence: 'restore'` route is one of the eleven fixed RESTORE_PATHS, each
//   registered once, `found` a GET and every other step a POST, with no handler; the server's restore
//   gate runs it (recovery-kit-restore.ts). No other path, method or route can use the kind.
// - OWNER-START-OVER (D-153): a `presence: 'start-over'` route is one of the three fixed
//   START_OVER_PATHS, each registered once, `state` a GET and `begin` / `finish` POSTs, with no
//   handler; the server's start-over gate runs it (start-over.ts). No other path can use the kind.
// - WP-R2b (04 §2.3.3 "Kit record"): a `presence: 'kit-reveal'` route (Show in Finder for the
//   recovery kit) is only a POST at BACKUP_REVEAL_PATH with a handler, registered once; the server's
//   kit-reveal gate runs it with no input at all. No other path, method or route can use the kind.
// - R1-SEC-16: a `presence: 'mark'` route (a display mark: the auto-save notice's dismiss, a former
//   name's seen mark; ATT-SENDFOLDER-FIX: Home's Send folder set-up, which may also create an empty
//   0700 folder under ~/AgentLink and changes no rules) is only a POST at one of MARK_PATHS with a
//   handler, each registered once; the server's mark gate runs it with no input at all. A GET is
//   always a read.
// - RET-4 (D-148; 08 §1 "The delete sheet"): a `presence: 'history'` route (Delete history's begin,
//   undo and status) is only a POST at its step's fixed path (history-paths.ts) with a handler, each
//   registered once; the server's history gate runs it. The finish is an ordinary `presence: true`
//   POST that declares `historyFinish`, only at HISTORY_FINISH_PATH, once. A `presence:
//   'inbox-reveal'` route (Show in Finder for the Inbox folder) is only a POST at INBOX_REVEAL_PATH
//   with a handler, once; it takes no input at all.
// - ATT-APP-ATTACH: a `presence: 'attach'` route is only a POST at ATTACH_PATH with a handler,
//   registered once; the server's attach gate runs it.
// - The page files in api/ each own their routes; this file only lists them.
import { activityRoutes } from './api/activity.js';
import { attachRoute } from './api/attach.js';
// U3-c: the Agents list and the switch kind; the stubs of U3-d, U3-e, U3-f and U3-flow.
import { agentsRoutes } from './api/agents.js';
import { eventsRoutes } from './api/events.js';
import { agentsManageRoutes } from './api/agents-manage.js';
import { contactNamesRoutes } from './api/contacts-renamed.js';
import { agentsRemoveRoutes } from './api/agents-remove.js';
// W4-PAUSE: Pause (its own kind) and Resume (presence; signs `agent.resume`).
import { agentsPauseRoutes } from './api/agents-pause.js';
import { appsRoutes } from './api/apps.js';
import { flowRoutes } from './api/flow.js';
import { backupRoutes } from './api/backup.js';
import { contactsRoutes } from './api/contacts.js';
import { filesRoutes } from './api/files.js';
// MSG-FILES-IO-d: Files, Received and Sent (read-only); MSG-FILES-IO-h: Show in Finder.
import { filesIoRoutes, filesRevealRoute } from './api/files-io.js';
import { notificationsRoutes } from './api/notifications.js';
import { filesPreviewRoute } from './api/files-preview.js';
import { filesSaveRoute } from './api/files-save.js';
import { firstRunRoutes } from './api/first-run.js';
// M1-11s-a-d: the status bar's health read (read-only).
import { healthRoutes } from './api/health.js';
// UX2-d1: create, check and accept an invite.
import { invitesRoutes } from './api/invites.js';
import { messagesRoutes } from './api/messages.js';
// UX2-f1: the per-contact activity pulse (read-only).
import { pulseRoute } from './api/messages-pulse.js';
import { payConfirmRoutes } from './api/pay-confirm.js';
import { peopleAllRoutes } from './api/people-all.js';
import { storageRoutes } from './api/storage.js';
import { appUpdateRoutes } from './api/app-update.js';
import { proofsRoutes } from './api/proofs.js';
import { rulesRoutes } from './api/rules.js';
// UX1113 WP-S2: Settings › Touch ID & master code (check, test, replace; the owner-code kind).
import { ownerPresenceRoutes } from './api/owner-presence.js';
import { OWNER_CODE_PATHS, isOwnerCodeStep } from './owner-code-paths.js';
// UX1113-R1: restore from a recovery kit (the restore kind).
import { restoreRoutes } from './api/restore.js';
// OWNER-START-OVER (D-153): start over on this computer (the start-over kind).
import { startOverRoutes } from './api/start-over.js';
// RET-4 (D-148): Delete history (begin, finish, undo, status) and Show in Finder for the Inbox.
import { historyRoutes } from './api/history.js';
import { retentionRoutes } from './api/retention.js';
import {
  HISTORY_FINISH_PATH,
  HISTORY_STEP_PATHS,
  INBOX_REVEAL_PATH,
  isHistoryStep,
} from './history-paths.js';
import {
  AGENTS_PAUSE_PATH,
  AGENTS_REMOVE_PATH,
  AGENTS_RESUME_PATH,
  AGENTS_SWITCH_PATH,
  ATTACH_PATH,
  BACKUP_EXPORT_PATH,
  BACKUP_PATH,
  CREATE_AGENT_PATHS,
  MARK_PATHS,
  RESTORE_PATHS,
  START_OVER_PATHS,
  UI_SETTINGS_WRITE_PATH,
  type LocalUiRoute,
} from './route-types.js';
// W4-SHELL-V2: the app's own UI settings (read, and the ui-settings kind).
import { uiSettingsRoutes } from './api/ui-settings.js';
// The fixed path lives in reveal-path.ts so api/files-io.ts uses it without importing this file.
import { BACKUP_REVEAL_PATH, REVEAL_PATH } from './reveal-path.js';
// UX2-d1: the invite paths live in invite-paths.ts for the same reason.
import {
  INVITE_ACCEPT_PATH,
  INVITE_CANCEL_PATH,
  INVITE_LINK_PATH,
  INVITE_CHECK_PATH,
  INVITE_CONNECTING_CANCEL_PATH,
  INVITE_CREATE_PATH,
  JOIN_ACCEPT_PATH,
  JOIN_DISMISS_PATH,
  JOIN_HANDOFF_PATH,
  JOIN_PATH,
} from './invite-paths.js';
// U3-invite: the join screen's routes and the handoff kind.
import { joinRoutes } from './api/join.js';

export {
  BACKUP_EXPORT_PATH,
  BACKUP_PATH,
  AGENTS_PAUSE_PATH,
  AGENTS_REMOVE_PATH,
  AGENTS_RESUME_PATH,
  AGENTS_SWITCH_PATH,
  INVITE_ACCEPT_PATH,
  INVITE_CHECK_PATH,
  INVITE_CREATE_PATH,
  JOIN_ACCEPT_PATH,
  JOIN_DISMISS_PATH,
  JOIN_HANDOFF_PATH,
  JOIN_PATH,
  REVEAL_PATH,
};
/** UX2-d1: the one path of each invite-kind step (U3-invite: `dismiss`, "Not now"). */
const INVITE_STEP_PATHS: Readonly<Record<string, string>> = Object.freeze({
  create: INVITE_CREATE_PATH,
  check: INVITE_CHECK_PATH,
  dismiss: JOIN_DISMISS_PATH,
  cancel: INVITE_CANCEL_PATH,
  'cancel-connecting': INVITE_CONNECTING_CANCEL_PATH,
  link: INVITE_LINK_PATH,
});
export const LOCAL_UI_API_PREFIX = '/api/ui/';
/** M1-11s-c: setup routes live only under the first-run page's API. */
const SETUP_PREFIX = '/api/ui/first-run/';
/** M1-PAY-CONFIRM-a: paid-action confirmation routes live only here. */
const PAY_CONFIRM_PREFIX = '/api/ui/pay-confirm/';

const OWNER_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const FIXED = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PARAM = /^:([a-zA-Z][a-zA-Z0-9]{0,31})$/;
const PARAM_VALUE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_SEGMENTS = 8;

type Segment = { readonly fixed: string } | { readonly param: string };

interface Entry {
  readonly route: LocalUiRoute;
  readonly segments: readonly Segment[];
}

/** A route that matched: the route and its parameters. */
export interface LocalUiMatch {
  readonly route: LocalUiRoute;
  readonly params: Readonly<Record<string, string>>;
}

const invalid = (why: string): Error => new Error(`local UI route: ${why}`);

function parsePath(path: unknown): Segment[] {
  if (typeof path !== 'string' || !path.startsWith(LOCAL_UI_API_PREFIX)) {
    throw invalid('the path must start with /api/ui/');
  }
  const parts = path.slice(LOCAL_UI_API_PREFIX.length).split('/');
  if (parts.length > MAX_SEGMENTS) throw invalid('the path is too long');
  const names = new Set<string>();
  return parts.map((part) => {
    const param = PARAM.exec(part);
    if (param !== null) {
      const name = param[1] as string;
      if (names.has(name)) throw invalid('a parameter name is repeated');
      names.add(name);
      return { param: name };
    }
    if (!FIXED.test(part)) throw invalid('a path segment is malformed');
    return { fixed: part };
  });
}

const sameShape = (a: readonly Segment[], b: readonly Segment[]): boolean =>
  a.length === b.length &&
  a.every((s, i) => {
    const t = b[i] as Segment;
    return 'fixed' in s ? 'fixed' in t && t.fixed === s.fixed : 'param' in t;
  });

export class LocalUiRouteRegistry {
  readonly #entries: Entry[] = [];

  /** Adds a route, or throws when it breaks a rule above (nothing is added then). */
  register(route: LocalUiRoute): void {
    if (typeof route !== 'object' || route === null) throw invalid('malformed');
    const { method, presence, handler, step, stub, recoveryKit } = route as unknown as {
      method: unknown;
      presence: unknown;
      handler: unknown;
      step: unknown;
      stub: unknown;
      recoveryKit: unknown;
    };
    // WP-11: only the one export route unlocks the owner store for a recovery kit.
    if (
      recoveryKit !== undefined &&
      (recoveryKit !== true ||
        presence !== true ||
        method !== 'POST' ||
        route.path !== BACKUP_EXPORT_PATH)
    ) {
      throw invalid('only the recovery-kit export route can export');
    }
    // UX1113 WP-S2: an owner-code step is a POST owner route at its own fixed path, once each.
    const ownerCode = (route as { ownerCode?: unknown }).ownerCode;
    if (ownerCode !== undefined) {
      if (
        !isOwnerCodeStep(ownerCode) ||
        presence !== true ||
        method !== 'POST' ||
        route.path !== OWNER_CODE_PATHS[ownerCode] ||
        recoveryKit !== undefined ||
        stub !== undefined ||
        this.#entries.some((e) => (e.route as { ownerCode?: unknown }).ownerCode === ownerCode)
      ) {
        throw invalid('an owner-code step is only its one POST route at its fixed path');
      }
    }
    // RET-4: only the one finish route at its fixed path declares `historyFinish`, once.
    const historyFinish = (route as { historyFinish?: unknown }).historyFinish;
    if (historyFinish !== undefined || route.path === HISTORY_FINISH_PATH) {
      if (
        historyFinish !== true ||
        presence !== true ||
        method !== 'POST' ||
        route.path !== HISTORY_FINISH_PATH ||
        recoveryKit !== undefined ||
        ownerCode !== undefined ||
        stub !== undefined ||
        this.#entries.some((e) => (e.route as { historyFinish?: unknown }).historyFinish === true)
      ) {
        throw invalid('the history finish is only its one POST owner route at its fixed path');
      }
    }
    // U3-c: only an owner route (POST, presence) can be a stub; the flag is `true` or absent.
    if (stub !== undefined && (stub !== true || presence !== true || method !== 'POST')) {
      throw invalid('only a POST owner route can be a stub');
    }
    if (presence === 'restore') {
      // UX1113-R1 (D-147): restore from a recovery kit; the server's restore gate runs it.
      const paths = RESTORE_PATHS as Readonly<Record<string, string>>;
      if (typeof step !== 'string' || !Object.hasOwn(paths, step)) {
        throw invalid('unknown restore step');
      }
      if (route.path !== paths[step]) throw invalid('a restore route is only at its fixed path');
      if (method !== (step === 'found' ? 'GET' : 'POST')) {
        throw invalid('a restore route has its fixed method');
      }
      if (handler !== undefined) throw invalid('a restore route has no handler');
      if (this.#entries.some((e) => e.route.presence === 'restore' && e.route.step === step)) {
        throw invalid('this restore step is already registered');
      }
    } else if (presence === 'start-over') {
      // OWNER-START-OVER (D-153): start over on this computer; the server's start-over gate runs it.
      const paths = START_OVER_PATHS as Readonly<Record<string, string>>;
      if (typeof step !== 'string' || !Object.hasOwn(paths, step)) {
        throw invalid('unknown start-over step');
      }
      if (route.path !== paths[step]) throw invalid('a start-over route is only at its fixed path');
      if (method !== (step === 'state' ? 'GET' : 'POST')) {
        throw invalid('a start-over route has its fixed method');
      }
      if (handler !== undefined) throw invalid('a start-over route has no handler');
      if (this.#entries.some((e) => e.route.presence === 'start-over' && e.route.step === step)) {
        throw invalid('this start-over step is already registered');
      }
    } else if (presence === 'handoff') {
      // U3-invite: `agentlink join` to a running app host; the server's handoff gate runs it.
      if (method !== 'POST') throw invalid('a handoff route is a POST');
      if (route.path !== JOIN_HANDOFF_PATH) {
        throw invalid('a handoff route is only at its fixed path');
      }
      if (handler !== undefined) throw invalid('a handoff route has no handler');
      if (this.#entries.some((e) => e.route.presence === 'handoff')) {
        throw invalid('the handoff route is already registered');
      }
    } else if (presence === 'mark') {
      // R1-SEC-16: the display marks (and the Send folder set-up, ATT-SENDFOLDER-FIX); the server's
      // mark gate runs them (no input, no presence).
      if (method !== 'POST') throw invalid('a mark route is a POST');
      if (!MARK_PATHS.includes(route.path)) throw invalid('a mark route is only at a mark path');
      if (typeof handler !== 'function') throw invalid('a mark route needs a handler');
      if (this.#entries.some((e) => e.route.presence === 'mark' && e.route.path === route.path)) {
        throw invalid('this mark route is already registered');
      }
    } else if (presence === 'ui-settings') {
      // W4-SHELL-V2: the app's own UI settings; the server's ui-settings gate runs it (no presence).
      if (method !== 'PUT') throw invalid('a ui-settings route is a PUT');
      if (route.path !== UI_SETTINGS_WRITE_PATH) {
        throw invalid('a ui-settings route is only at its fixed path');
      }
      if (typeof handler !== 'function') throw invalid('a ui-settings route needs a handler');
      if (this.#entries.some((e) => e.route.presence === 'ui-settings')) {
        throw invalid('the ui-settings route is already registered');
      }
    } else if (presence === 'remove') {
      // U3-e: removing an agent; the server's remove gate runs it (D-138).
      if (method !== 'POST') throw invalid('a remove route is a POST');
      if (route.path !== AGENTS_REMOVE_PATH) {
        throw invalid('a remove route is only at its fixed path');
      }
      if (handler !== undefined) throw invalid('a remove route has no handler');
      if (this.#entries.some((e) => e.route.presence === 'remove')) {
        throw invalid('the remove route is already registered');
      }
    } else if (presence === 'pause') {
      // W4-PAUSE: pausing the open agent; the server's pause gate runs it (D-143 (5)).
      if (method !== 'POST') throw invalid('a pause route is a POST');
      if (route.path !== AGENTS_PAUSE_PATH)
        throw invalid('a pause route is only at its fixed path');
      if (handler !== undefined) throw invalid('a pause route has no handler');
      if (this.#entries.some((e) => e.route.presence === 'pause')) {
        throw invalid('the pause route is already registered');
      }
    } else if (presence === 'switch') {
      // U3-c: switching the open agent; the server's switch gate runs it (D-138).
      if (method !== 'POST') throw invalid('a switch route is a POST');
      if (route.path !== AGENTS_SWITCH_PATH)
        throw invalid('a switch route is only at its fixed path');
      if (handler !== undefined) throw invalid('a switch route has no handler');
      if (this.#entries.some((e) => e.route.presence === 'switch')) {
        throw invalid('the switch route is already registered');
      }
    } else if (presence === 'setup') {
      // M1-11s-c: owner setup is run by the server's setup gate, never by a page handler.
      if (method !== 'POST') throw invalid('a setup route is a POST');
      if (handler !== undefined) throw invalid('a setup route has no handler');
      if (typeof route.path !== 'string' || !route.path.startsWith(SETUP_PREFIX)) {
        throw invalid('a setup route is under /api/ui/first-run/');
      }
      if (step !== 'begin' && step !== 'finish') throw invalid('unknown setup step');
      if (this.#entries.some((e) => e.route.presence === 'setup' && e.route.step === step)) {
        throw invalid('this setup step is already registered');
      }
    } else if (presence === 'pay-confirm') {
      // M1-PAY-CONFIRM-a: run by the server's pay-confirm gate, never by a page handler.
      if (method !== 'POST') throw invalid('a pay-confirm route is a POST');
      if (handler !== undefined) throw invalid('a pay-confirm route has no handler');
      if (typeof route.path !== 'string' || !route.path.startsWith(PAY_CONFIRM_PREFIX)) {
        throw invalid('a pay-confirm route is under /api/ui/pay-confirm/');
      }
      if (step !== 'begin' && step !== 'finish') throw invalid('unknown pay-confirm step');
      if (this.#entries.some((e) => e.route.presence === 'pay-confirm' && e.route.step === step)) {
        throw invalid('this pay-confirm step is already registered');
      }
    } else if (presence === 'create-agent') {
      // W4-ONE-TOUCH (D-140): New agent with one gesture; the server's create-agent gate runs it.
      if (method !== 'POST') throw invalid('a create-agent route is a POST');
      if (handler !== undefined) throw invalid('a create-agent route has no handler');
      if (step !== 'begin' && step !== 'finish') throw invalid('unknown create-agent step');
      if (route.path !== CREATE_AGENT_PATHS[step]) {
        throw invalid('a create-agent route is only at its fixed path');
      }
      if (this.#entries.some((e) => e.route.presence === 'create-agent' && e.route.step === step)) {
        throw invalid('this create-agent step is already registered');
      }
    } else if (presence === 'reveal') {
      // MSG-FILES-IO-h: Show in Finder only; the server's reveal gate runs it (D-134).
      if (method !== 'POST') throw invalid('a reveal route is a POST');
      if (route.path !== REVEAL_PATH) throw invalid('a reveal route is only at the reveal path');
      if (typeof handler !== 'function') throw invalid('a reveal route needs a handler');
      if (this.#entries.some((e) => e.route.presence === 'reveal')) {
        throw invalid('the reveal route is already registered');
      }
    } else if (presence === 'kit-reveal') {
      // WP-R2b: Show in Finder for the recovery kit only; the server's kit-reveal gate runs it.
      if (method !== 'POST') throw invalid('a kit-reveal route is a POST');
      if (route.path !== BACKUP_REVEAL_PATH) {
        throw invalid('a kit-reveal route is only at the kit reveal path');
      }
      if (typeof handler !== 'function') throw invalid('a kit-reveal route needs a handler');
      if (this.#entries.some((e) => e.route.presence === 'kit-reveal')) {
        throw invalid('the kit-reveal route is already registered');
      }
    } else if (presence === 'history') {
      // RET-4: Delete history's begin, undo and status; the server's history gate runs them.
      if (method !== 'POST') throw invalid('a history route is a POST');
      if (!isHistoryStep(step)) throw invalid('unknown history step');
      if (route.path !== HISTORY_STEP_PATHS[step]) {
        throw invalid('a history route is only at its fixed path');
      }
      if (typeof handler !== 'function') throw invalid('a history route needs a handler');
      if (this.#entries.some((e) => e.route.presence === 'history' && e.route.step === step)) {
        throw invalid('this history step is already registered');
      }
    } else if (presence === 'inbox-reveal') {
      // RET-4: Show in Finder for the Inbox folder only; no input, no presence.
      if (method !== 'POST') throw invalid('an inbox-reveal route is a POST');
      if (route.path !== INBOX_REVEAL_PATH) {
        throw invalid('an inbox-reveal route is only at its fixed path');
      }
      if (typeof handler !== 'function') throw invalid('an inbox-reveal route needs a handler');
      if (this.#entries.some((e) => e.route.presence === 'inbox-reveal')) {
        throw invalid('the inbox-reveal route is already registered');
      }
    } else if (presence === 'invite') {
      // UX2-d1 (decision 1.1): create and check an invite only; the server's invite gate runs it.
      if (method !== 'POST') throw invalid('an invite route is a POST');
      if (
        step !== 'create' &&
        step !== 'check' &&
        step !== 'dismiss' &&
        step !== 'cancel' &&
        step !== 'cancel-connecting' &&
        step !== 'link'
      ) {
        throw invalid('unknown invite step');
      }
      if (route.path !== INVITE_STEP_PATHS[step]) {
        throw invalid('an invite route is only at its fixed path');
      }
      if (typeof handler !== 'function') throw invalid('an invite route needs a handler');
      if (this.#entries.some((e) => e.route.presence === 'invite' && e.route.step === step)) {
        throw invalid('this invite step is already registered');
      }
    } else if (presence === 'attach') {
      // ATT-APP-ATTACH: the owner's attached files only; the server's attach gate runs it.
      if (method !== 'POST') throw invalid('an attach route is a POST');
      if (route.path !== ATTACH_PATH) throw invalid('an attach route is only at the attach path');
      if (typeof handler !== 'function') throw invalid('an attach route needs a handler');
      if (this.#entries.some((e) => e.route.presence === 'attach')) {
        throw invalid('the attach route is already registered');
      }
    } else if (typeof handler !== 'function') {
      throw invalid('no handler');
    } else if (method === 'GET') {
      if (presence !== false) throw invalid('a GET route never takes owner presence');
    } else if (typeof method === 'string' && OWNER_METHODS.has(method)) {
      // I-4: every change goes through the central presence gate.
      if (presence !== true) throw invalid(`a ${method} route must declare presence: true`);
    } else {
      throw invalid('unknown method');
    }
    const segments = parsePath(route.path);
    if (this.#entries.some((e) => e.route.method === method && sameShape(e.segments, segments))) {
      throw invalid('this method and path are already registered');
    }
    this.#entries.push({ route: Object.freeze({ ...route }), segments });
  }

  /** Every registered route, in registration order. */
  routes(): readonly LocalUiRoute[] {
    return this.#entries.map((e) => e.route);
  }

  /**
   * The route for `method` and `path` (a URL pathname), `'method'` when the path is known only for
   * other methods, or undefined.
   */
  match(method: string, path: string): LocalUiMatch | 'method' | undefined {
    if (!path.startsWith(LOCAL_UI_API_PREFIX)) return undefined;
    const parts = path.slice(LOCAL_UI_API_PREFIX.length).split('/');
    let otherMethod = false;
    for (const { route, segments } of this.#entries) {
      if (segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      const hit = segments.every((segment, i) => {
        const part = parts[i] as string;
        if ('fixed' in segment) return part === segment.fixed;
        if (!PARAM_VALUE.test(part)) return false;
        params[segment.param] = part;
        return true;
      });
      if (!hit) continue;
      if (route.method !== method) {
        otherMethod = true;
        continue;
      }
      return { route, params: Object.freeze(params) };
    }
    return otherMethod ? 'method' : undefined;
  }
}

/** The registry with every page's routes (api/*.ts). */
export function createLocalUiRoutes(): LocalUiRouteRegistry {
  const registry = new LocalUiRouteRegistry();
  for (const routes of [
    firstRunRoutes,
    // M1-11s-a-d: the status bar's health read.
    healthRoutes,
    activityRoutes,
    // UX2-f1: the activity pulse, before the Messages routes so `pulse` never reaches :contactId.
    [pulseRoute],
    // MSG-FILES-IO-c: the Messages page (read-only).
    messagesRoutes,
    contactsRoutes,
    // UX2-d1: create and check an invite (the invite kind) and accept one (owner presence).
    invitesRoutes,
    filesRoutes,
    // MSG-FILES-IO-d: Files, Received and Sent (read-only).
    filesIoRoutes,
    // MSG-FILES-IO-h: Show in Finder (the one reveal route, D-134).
    [filesRevealRoute],
    // REL051-A34 (D-149): the in-app preview of a received text file (read, by item ID only).
    [filesPreviewRoute],
    proofsRoutes,
    rulesRoutes,
    payConfirmRoutes,
    backupRoutes,
    // U3-c: every U3 route of 08 §1. The switch kind and the Agents list are live; the rest are
    // stubs answering `not_available` until their cards (U3-d, U3-e, U3-f, U3-flow) fill them.
    agentsRoutes,
    agentsManageRoutes,
    agentsRemoveRoutes,
    appsRoutes,
    flowRoutes,
    // U3-invite: the waiting invite (read, accept, "Not now") and the handoff kind.
    joinRoutes,
    // W4-FILES-SAVE: "Save to Inbox" (owner presence, one signed `file.save`).
    [filesSaveRoute],
    // W4-RENAME-REACHES-CONTACTS: the seen mark of a contact's former-name note.
    contactNamesRoutes,
    // W4-LIVE-STATUS (D-143): the live AI app status stream (its own events gate in the server).
    eventsRoutes,
    // W4-PAUSE (D-143 (5)): Pause and Resume.
    agentsPauseRoutes,
    uiSettingsRoutes,
    // N4: the notification centre (a read and two display marks).
    notificationsRoutes,
    // WP-P2: People across all IDs (read only).
    peopleAllRoutes,
    // REL051-RET1: Settings > Storage, sizes only (read only).
    storageRoutes,
    // DESK051-UPD: Settings > Updates in the desktop app (reads; the shell checks).
    appUpdateRoutes,
    // UX1113 WP-S2: Touch ID & master code.
    ownerPresenceRoutes,
    // UX1113-R1 (D-147): restore from a recovery kit, in the app.
    restoreRoutes,
    // OWNER-START-OVER (D-153): start over on this computer.
    startOverRoutes,
    // RET-4 (D-148): Delete history and Show in Finder for the Inbox folder.
    historyRoutes,
    // RET-6 (D-148): Settings > Storage > Keep automatically (a read; the save behind presence).
    retentionRoutes,
    // ATT-APP-ATTACH: the owner attaches light text files in a conversation (the attach kind).
    [attachRoute],
  ]) {
    for (const route of routes) registry.register(route);
  }
  return registry;
}
