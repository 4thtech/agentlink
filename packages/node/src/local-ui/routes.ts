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
// - The page files in api/ each own their routes; this file only lists them.
import { activityRoutes } from './api/activity.js';
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
import { advancedRoutes } from './api/advanced.js';
import { approvalsRoutes } from './api/approvals.js';
import { backupRoutes } from './api/backup.js';
import { contactsRoutes } from './api/contacts.js';
import { filesRoutes } from './api/files.js';
// MSG-FILES-IO-d: Files, Received and Sent (read-only); MSG-FILES-IO-h: Show in Finder.
import { filesIoRoutes, filesRevealRoute } from './api/files-io.js';
import { firstRunRoutes } from './api/first-run.js';
// M1-11s-a-d: the status bar's health read (read-only).
import { healthRoutes } from './api/health.js';
// UX2-d1: create, check and accept an invite.
import { invitesRoutes } from './api/invites.js';
import { messagesRoutes } from './api/messages.js';
// UX2-f1: the per-contact activity pulse (read-only).
import { pulseRoute } from './api/messages-pulse.js';
import { payConfirmRoutes } from './api/pay-confirm.js';
import { proofsRoutes } from './api/proofs.js';
import { rulesRoutes } from './api/rules.js';
import { storageRoutes } from './api/storage.js';
import {
  AGENTS_PAUSE_PATH,
  AGENTS_REMOVE_PATH,
  AGENTS_RESUME_PATH,
  AGENTS_SWITCH_PATH,
  CREATE_AGENT_PATHS,
  type LocalUiRoute,
} from './route-types.js';
// The fixed path lives in reveal-path.ts so api/files-io.ts uses it without importing this file.
import { REVEAL_PATH } from './reveal-path.js';
// UX2-d1: the invite paths live in invite-paths.ts for the same reason.
import {
  INVITE_ACCEPT_PATH,
  INVITE_CANCEL_PATH,
  INVITE_CHECK_PATH,
  INVITE_CREATE_PATH,
  JOIN_ACCEPT_PATH,
  JOIN_DISMISS_PATH,
  JOIN_HANDOFF_PATH,
  JOIN_PATH,
} from './invite-paths.js';
// U3-invite: the join screen's routes and the handoff kind.
import { joinRoutes } from './api/join.js';

export {
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
    const { method, presence, handler, step, stub } = route as unknown as {
      method: unknown;
      presence: unknown;
      handler: unknown;
      step: unknown;
      stub: unknown;
    };
    // U3-c: only an owner route (POST, presence) can be a stub; the flag is `true` or absent.
    if (stub !== undefined && (stub !== true || presence !== true || method !== 'POST')) {
      throw invalid('only a POST owner route can be a stub');
    }
    if (presence === 'handoff') {
      // U3-invite: `agentlink join` to a running app host; the server's handoff gate runs it.
      if (method !== 'POST') throw invalid('a handoff route is a POST');
      if (route.path !== JOIN_HANDOFF_PATH) {
        throw invalid('a handoff route is only at its fixed path');
      }
      if (handler !== undefined) throw invalid('a handoff route has no handler');
      if (this.#entries.some((e) => e.route.presence === 'handoff')) {
        throw invalid('the handoff route is already registered');
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
      if (route.path !== AGENTS_PAUSE_PATH) throw invalid('a pause route is only at its fixed path');
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
    } else if (presence === 'invite') {
      // UX2-d1 (decision 1.1): create and check an invite only; the server's invite gate runs it.
      if (method !== 'POST') throw invalid('an invite route is a POST');
      if (step !== 'create' && step !== 'check' && step !== 'dismiss' && step !== 'cancel') {
        throw invalid('unknown invite step');
      }
      if (route.path !== INVITE_STEP_PATHS[step]) {
        throw invalid('an invite route is only at its fixed path');
      }
      if (typeof handler !== 'function') throw invalid('an invite route needs a handler');
      if (this.#entries.some((e) => e.route.presence === 'invite' && e.route.step === step)) {
        throw invalid('this invite step is already registered');
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
    approvalsRoutes,
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
    storageRoutes,
    proofsRoutes,
    rulesRoutes,
    payConfirmRoutes,
    backupRoutes,
    advancedRoutes,
    // U3-c: every U3 route of 08 §1. The switch kind and the Agents list are live; the rest are
    // stubs answering `not_available` until their cards (U3-d, U3-e, U3-f, U3-flow) fill them.
    agentsRoutes,
    agentsManageRoutes,
    agentsRemoveRoutes,
    appsRoutes,
    flowRoutes,
    // U3-invite: the waiting invite (read, accept, "Not now") and the handoff kind.
    joinRoutes,
    // W4-RENAME-REACHES-CONTACTS: the seen mark of a contact's former-name note.
    contactNamesRoutes,
    // W4-LIVE-STATUS (D-143): the live AI app status stream (its own events gate in the server).
    eventsRoutes,
    // W4-PAUSE (D-143 (5)): Pause and Resume.
    agentsPauseRoutes,
  ]) {
    for (const route of routes) registry.register(route);
  }
  return registry;
}
