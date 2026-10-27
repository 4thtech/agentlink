// M1-11s-b: the local UI route registry (08 §1; 04 §2.5; D-118; I-4).
//
// - Every route declares its method, its path under /api/ui/ and `presence`. Registration throws when
//   a mutating method (POST, PUT, PATCH, DELETE) does not declare `presence: true`, or a GET does,
//   so no route can reach an owner operation around the central presence gate (approval-server.ts).
// - M1-11s-c: a `presence: 'setup'` route is only a POST under /api/ui/first-run/, has no handler
//   and is registered at most once per step (begin, finish); the server's setup gate runs it.
// - A path is fixed segments `[a-z0-9-]` and `:name` parameters; a parameter matches only
//   `[A-Za-z0-9_-]{1,128}` (no dot, no percent-escape, no slash), so no handler sees `..` or an
//   encoded separator. Duplicates throw.
// - The page files in api/ each own their routes; this file only lists them.
import { activityRoutes } from './api/activity.js';
import { advancedRoutes } from './api/advanced.js';
import { approvalsRoutes } from './api/approvals.js';
import { backupRoutes } from './api/backup.js';
import { contactsRoutes } from './api/contacts.js';
import { filesRoutes } from './api/files.js';
import { firstRunRoutes } from './api/first-run.js';
import { messagesRoutes } from './api/messages.js';
import { proofsRoutes } from './api/proofs.js';
import { rulesRoutes } from './api/rules.js';
import { storageRoutes } from './api/storage.js';
import type { LocalUiRoute } from './route-types.js';

export const LOCAL_UI_API_PREFIX = '/api/ui/';
/** M1-11s-c: setup routes live only under the first-run page's API. */
const SETUP_PREFIX = '/api/ui/first-run/';

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
    const { method, presence, handler, step } = route as unknown as {
      method: unknown;
      presence: unknown;
      handler: unknown;
      step: unknown;
    };
    if (presence === 'setup') {
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
    approvalsRoutes,
    activityRoutes,
    // MSG-FILES-IO-c: the Messages page (read-only).
    messagesRoutes,
    contactsRoutes,
    filesRoutes,
    storageRoutes,
    proofsRoutes,
    rulesRoutes,
    backupRoutes,
    advancedRoutes,
  ]) {
    for (const route of routes) registry.register(route);
  }
  return registry;
}
