// U3-f (S2; D-138, U3-spec-04; 08 §1 "Agents and AI apps in the app", "Entry-only config display";
// 04 §2.5 "Writing AI app configs", §2.5.1 `app.connect`, `app.disconnect`; 06 §7 "The app as a
// second path"; b11 §30; proposed, owner confirms at merge): connect, move and disconnect AI apps from
// the local app. These replace the U3-c stubs of the same paths.
//
// - `GET /api/ui/apps` (read): the detected AI apps, the agent each one runs (from its `agentlink`
//   entry only) and whether Claude Desktop runs. Also allowed during setup, before an owner exists
//   (first run picks the app first), behind the same session and CSRF guard as every read; it needs
//   no client and no owner, and writes nothing.
// - `GET /api/ui/apps/preview?app=&agent=` (read; the owner must exist): the exact `agentlink` entry
//   change for the open agent (connect, move from another agent, or disconnect when the app already
//   runs it) and its `changeId` = SHA-256(JCS({app, path, oldEntry, newEntry, agent})), `path` the
//   resolved config path (bound, never answered) and `agent` the open agent's agentId. Writes nothing.
// - `POST /api/ui/apps/apply` and `/api/ui/apps/disconnect` `{changeId}` (presence; the generation in
//   its header, checked by the server before presence and again right before signing). In order:
//   the previewed change must be for the open agent, and the agent folder the entry runs must record
//   the open agent's agentId (otherwise nothing is signed); core prepares `app.connect` or
//   `app.disconnect` {app, agent, changeId} for this agent; the owner signs it with a statement that
//   names the AI app and the agent ("Connect Claude Code to Work"); after the gesture the change is
//   recomputed from the file as it is now and refused with `changed` on any difference (the entries,
//   the path or the file's identity), with nothing applied or written; core verifies and records the
//   signed object; only then the seam writes (and checks again: the bytes and identity, Claude
//   Desktop, the folder's agentId).
//
// The page never sends a path: the seam takes paths only from the fixed harness table (06 §7). Every
// answer holds only fixed words, fixed app names, display paths, AgentLink's own entries and valid
// agent names: never another entry of a config file or anything else read from it (I-7). Nothing
// here logs. No MCP tool reaches these routes (I-4).
import {
  canonicalize,
  encodeHex,
  sha256,
  type JsonObject,
  type JsonValue,
} from '@4thtech-io/crypto';
import type {
  LocalUiAiAppPlan,
  LocalUiAiApps,
  LocalUiAiAppView,
  LocalUiAiAppWrite,
  LocalUiContext,
} from '../context.js';
import {
  NOT_AVAILABLE,
  UI_INVALID_QUERY,
  UI_NOT_SET_UP,
  UI_UNAVAILABLE,
  type LocalUiOwnerOperation,
  type LocalUiOwnerRoute,
  type LocalUiReadRoute,
  type LocalUiRequest,
  type LocalUiResult,
  type LocalUiRoute,
} from '../route-types.js';

/** The AI app ids of the fixed harness table (06 §7; the same as `AI_APP_IDS` of @4thtech-io/types). */
export const AI_APP_IDS: readonly string[] = Object.freeze([
  'claude-code',
  'claude-desktop',
  'codex',
  'gemini-cli',
  'opencode',
  'antigravity',
  'cursor',
  'windsurf',
]);

/** 06 §6 agent-name rule (the folder name, the `--agent` value). */
const AGENT_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const CHANGE_ID = /^[0-9a-f]{64}$/;
/** A preview stays usable as long as the signed op may live (04 §2.5.1: 600 s). */
const PREVIEW_TTL_MS = 600_000;
/** At most this many open previews per seam; the oldest goes first. */
const MAX_PREVIEWS = 16;

const fixed = (status: number, error: string): LocalUiResult =>
  Object.freeze({ status, body: Object.freeze({ error }) });

const BAD_REQUEST = fixed(400, 'bad_request');
const INVALID = fixed(400, 'invalid');
/** 409: the agent is not the open one (the page re-reads; 08 §1). */
const NOT_OPEN = fixed(409, 'agent_changed');
/** 409: the agent folder the entry runs does not record the open agent's agentId. */
const AGENT_MISMATCH = fixed(409, 'agent_mismatch');
/** 409: the file is not the one the preview showed ("The file changed. Review it again."). */
const CHANGED = fixed(409, 'changed');
/** 409: signed, but core did not apply it. */
const NOT_APPLIED = fixed(409, 'not_applied');

const WRITE_ANSWERS: Readonly<Record<Exclude<LocalUiAiAppWrite, 'written'>, LocalUiResult>> =
  Object.freeze({
    changed: CHANGED,
    quit_first: fixed(409, 'quit_first'),
    agent_mismatch: AGENT_MISMATCH,
    failed: fixed(409, 'write_failed'),
  });

/** The `changeId` of 04 §2.5.1: SHA-256 (through @4thtech-io/crypto) of the JCS of the change. */
export function appChangeId(change: {
  readonly app: string;
  readonly path: string;
  readonly oldEntry: JsonObject | null;
  readonly newEntry: JsonObject | null;
  readonly agent: string;
}): string {
  const text = canonicalize({
    app: change.app,
    path: change.path,
    oldEntry: change.oldEntry,
    newEntry: change.newEntry,
    agent: change.agent,
  });
  return encodeHex(sha256(new TextEncoder().encode(text)));
}

type Change = Extract<LocalUiAiAppPlan, { status: 'change' }>;

interface Pending {
  readonly app: string;
  readonly agent: string;
  readonly kind: Change['kind'];
  /** The app's fixed name and the agent it leaves (a move), for the owner statement. */
  readonly name: string;
  readonly oldAgent: string | null;
  readonly identity: string;
  readonly expiresAt: number;
}

/** The open previews, per seam (one seam per opened agent, so a switch drops them). */
const previews = new WeakMap<LocalUiAiApps, Map<string, Pending>>();

function remember(desk: LocalUiAiApps, changeId: string, pending: Pending, now: number): void {
  let map = previews.get(desk);
  if (map === undefined) {
    map = new Map();
    previews.set(desk, map);
  }
  for (const [id, item] of map) if (item.expiresAt <= now) map.delete(id);
  map.delete(changeId);
  map.set(changeId, pending);
  while (map.size > MAX_PREVIEWS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function recall(desk: LocalUiAiApps, changeId: string, now: number): Pending | undefined {
  const item = previews.get(desk)?.get(changeId);
  return item !== undefined && item.expiresAt > now ? item : undefined;
}

/** A plain JSON copy of one entry (AgentLink's own: it holds no secret), or null. */
function entryCopy(entry: JsonObject | null): JsonObject | null {
  return entry === null ? null : (JSON.parse(canonicalize(entry)) as JsonObject);
}

/** The plan is one of the three changes for exactly `agent` (fail closed on anything else). */
function coherent(plan: Change, app: string, agent: string): boolean {
  if (plan.app !== app) return false;
  switch (plan.kind) {
    case 'connect':
      return plan.newAgent === agent && plan.oldAgent === null && plan.oldEntry === null;
    case 'move':
      return (
        plan.newAgent === agent &&
        plan.oldAgent !== null &&
        plan.oldAgent !== agent &&
        plan.oldEntry !== null &&
        plan.newEntry !== null
      );
    case 'disconnect':
      return plan.oldAgent === agent && plan.newAgent === null && plan.newEntry === null;
  }
}

const STATE_WORDS = Object.freeze({
  none: 'not_connected',
  agent: 'connected',
  foreign: 'not_ours',
  unreadable: 'unreadable',
} as const);

/** One app as the page sees it: fixed fields only (never anything else the seam's object holds). */
function appView(view: LocalUiAiAppView): JsonObject | undefined {
  if (!AI_APP_IDS.includes(view.app)) return undefined;
  const state = view.state;
  const word = STATE_WORDS[state.kind];
  if (word === undefined) return undefined;
  const agent = state.kind === 'agent' && AGENT_NAME.test(state.agent) ? state.agent : undefined;
  if (state.kind === 'agent' && agent === undefined) return undefined;
  return {
    app: view.app,
    name: String(view.name),
    path: String(view.path),
    state: word,
    ...(agent === undefined ? {} : { agent }),
    quitFirst: view.quitFirst === true,
  };
}

/** GET /api/ui/apps */
async function listApps(context: LocalUiContext, request: LocalUiRequest): Promise<LocalUiResult> {
  if ([...request.query.keys()].length > 0) return UI_INVALID_QUERY;
  const desk = context.aiApps;
  if (desk === undefined) return NOT_AVAILABLE;
  try {
    const listed = await desk.list();
    const apps = listed.apps.flatMap((view) => {
      const shown = appView(view);
      return shown === undefined ? [] : [shown];
    });
    return { status: 200, body: { desktopRunning: listed.desktopRunning === true, apps } };
  } catch {
    return UI_UNAVAILABLE;
  }
}

/** One query value that occurs exactly once, or undefined. */
function only(query: URLSearchParams, key: string): string | undefined {
  const values = query.getAll(key);
  return values.length === 1 ? values[0] : undefined;
}

/** GET /api/ui/apps/preview?app=&agent= */
async function previewChange(
  context: LocalUiContext,
  request: LocalUiRequest,
): Promise<LocalUiResult> {
  const desk = context.aiApps;
  const manage = context.agentsManage;
  if (desk === undefined || manage === undefined) return NOT_AVAILABLE;
  const keys = [...request.query.keys()];
  const app = only(request.query, 'app');
  const agent = only(request.query, 'agent');
  if (
    keys.length !== 2 ||
    app === undefined ||
    agent === undefined ||
    !AI_APP_IDS.includes(app) ||
    !AGENT_NAME.test(agent)
  ) {
    return BAD_REQUEST;
  }
  const client = context.client;
  if (client === undefined) return UI_NOT_SET_UP;
  try {
    if ((await context.ownerContext()) === undefined) return UI_NOT_SET_UP;
    // 04 §2.5: only the open agent (its agentId is what the signed op binds).
    if (manage.current() !== agent) return NOT_OPEN;
    if ((await desk.agentIdOf(agent)) !== client.agentId) return AGENT_MISMATCH;
    const plan = await desk.plan(app, agent);
    if (plan.status !== 'change') {
      return { status: 200, body: { status: plan.status, app, name: String(plan.name) } };
    }
    if (!coherent(plan, app, agent)) return UI_UNAVAILABLE;
    const oldEntry = entryCopy(plan.oldEntry);
    const newEntry = entryCopy(plan.newEntry);
    const changeId = appChangeId({
      app,
      path: plan.file,
      oldEntry,
      newEntry,
      agent: client.agentId,
    });
    remember(
      desk,
      changeId,
      {
        app,
        agent,
        kind: plan.kind,
        name: String(plan.name),
        oldAgent: plan.oldAgent,
        identity: plan.identity,
        expiresAt: context.now() + PREVIEW_TTL_MS,
      },
      context.now(),
    );
    return {
      status: 200,
      body: {
        status: 'change',
        kind: plan.kind,
        app,
        name: String(plan.name),
        path: String(plan.path),
        // b11 §30.3: "Agent folder: work" under the entry.
        folder: agent,
        oldEntry,
        newEntry,
        oldAgent: plan.oldAgent,
        newAgent: plan.newAgent,
        changeId,
      },
    };
  } catch {
    return UI_UNAVAILABLE;
  }
}

/** A plain object with exactly these keys, or undefined. */
function inputWith(input: JsonValue | undefined, keys: readonly string[]): JsonObject | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const own = Object.keys(input);
  if (own.length !== keys.length || !keys.every((k) => own.includes(k))) return undefined;
  return input as JsonObject;
}

/** Exactly the op core prepared for this agent, app and changeId (core checks it all again). */
function isAppBody(
  body: unknown,
  op: string,
  agent: string,
  app: string,
  changeId: string,
): body is JsonObject {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const b = body as JsonObject;
  const params = b['params'];
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return false;
  const p = params as JsonObject;
  return (
    b['op'] === op &&
    b['agent'] === agent &&
    Object.keys(p).length === 3 &&
    p['app'] === app &&
    p['agent'] === agent &&
    p['changeId'] === changeId
  );
}

/** The owner statement (b11 §30.3): the AI app and the open agent's verified label or folder. */
function statement(
  kind: Change['kind'],
  appName: string,
  shown: string,
  old: string | null,
): string {
  switch (kind) {
    case 'connect':
      return `Connect ${appName} to ${shown}`;
    case 'move':
      // Another agent is named by its folder name only (04 §2.5.1: a presence statement names the
      // open agent by its verified label; a listed agent's label is unverified text).
      return `${appName} will use ${shown} instead of ${old ?? ''}`;
    case 'disconnect':
      return `${appName} will stop using ${shown}`;
  }
}

/** POST apply (`app.connect`) and disconnect (`app.disconnect`) `{changeId}`. */
async function changeApp(
  op: 'app.connect' | 'app.disconnect',
  context: LocalUiContext,
  request: LocalUiRequest,
  owner: LocalUiOwnerOperation,
): Promise<LocalUiResult> {
  const desk = context.aiApps;
  const manage = context.agentsManage;
  if (desk === undefined || manage === undefined) return NOT_AVAILABLE;
  const client = context.client;
  const prepare = client?.apps?.prepare;
  if (client === undefined || prepare === undefined) return UI_NOT_SET_UP;
  const input = inputWith(request.input, ['changeId']);
  const changeId = input?.['changeId'];
  if (typeof changeId !== 'string' || !CHANGE_ID.test(changeId)) return INVALID;
  const pending = recall(desk, changeId, context.now());
  if (pending === undefined) return CHANGED;
  if ((op === 'app.disconnect') !== (pending.kind === 'disconnect')) return INVALID;
  if (manage.current() !== pending.agent) return NOT_OPEN;
  let shown: string;
  let body: JsonObject;
  try {
    // 04 §2.5 "Fixed content": the folder the entry runs must be the agent the op binds; a
    // mismatch is refused before anything is signed.
    if ((await desk.agentIdOf(pending.agent)) !== client.agentId) return AGENT_MISMATCH;
    const reading = await client.agent?.label();
    shown = reading?.status === 'verified' ? reading.label : pending.agent;
    const prepared = await prepare(op, pending.app, changeId);
    if (prepared.status !== 'prepared') return NOT_APPLIED;
    body = prepared.body as unknown as JsonObject;
  } catch {
    return UI_UNAVAILABLE;
  }
  if (!isAppBody(body, op, client.agentId, pending.app, changeId)) return NOT_APPLIED;
  const signatures = await owner.sign(
    { lines: [statement(pending.kind, pending.name, shown, pending.oldAgent)] },
    [{ kind: 'owner-action', action: body }],
  );
  const first = signatures[0];
  if (signatures.length !== 1 || first === undefined || first.kind !== 'owner-action') {
    return NOT_APPLIED;
  }
  // After the gesture, before the write (04 §2.5): the change written is the change shown,
  // recomputed from the file as it is now.
  let fresh: LocalUiAiAppPlan;
  try {
    fresh = await desk.plan(pending.app, pending.agent);
  } catch {
    return CHANGED;
  }
  if (
    fresh.status !== 'change' ||
    fresh.kind !== pending.kind ||
    fresh.identity !== pending.identity ||
    !coherent(fresh, pending.app, pending.agent) ||
    appChangeId({
      app: pending.app,
      path: fresh.file,
      oldEntry: entryCopy(fresh.oldEntry),
      newEntry: entryCopy(fresh.newEntry),
      agent: client.agentId,
    }) !== changeId
  ) {
    return CHANGED;
  }
  previews.get(desk)?.delete(changeId);
  const outcome = await context.applyOwnerAction(first.signed);
  if (outcome.status !== 'applied' || outcome.op !== op) return NOT_APPLIED;
  const written = await fresh.commit(client.agentId).catch((): LocalUiAiAppWrite => 'failed');
  if (written !== 'written') return WRITE_ANSWERS[written] ?? WRITE_ANSWERS.failed;
  // "Restart {app} to finish" (b11 §30.3).
  return { status: 200, body: { status: 'done', app: pending.app } };
}

const listRoute: LocalUiReadRoute = Object.freeze({
  method: 'GET',
  path: '/api/ui/apps',
  presence: false,
  handler: listApps,
});

const previewRoute: LocalUiReadRoute = Object.freeze({
  method: 'GET',
  path: '/api/ui/apps/preview',
  presence: false,
  handler: previewChange,
});

const applyRoute: LocalUiOwnerRoute = Object.freeze({
  method: 'POST',
  path: '/api/ui/apps/apply',
  presence: true,
  handler: (context: LocalUiContext, request: LocalUiRequest, owner: LocalUiOwnerOperation) =>
    changeApp('app.connect', context, request, owner),
});

const disconnectRoute: LocalUiOwnerRoute = Object.freeze({
  method: 'POST',
  path: '/api/ui/apps/disconnect',
  presence: true,
  handler: (context: LocalUiContext, request: LocalUiRequest, owner: LocalUiOwnerOperation) =>
    changeApp('app.disconnect', context, request, owner),
});

export const appsRoutes: readonly LocalUiRoute[] = Object.freeze([
  listRoute,
  previewRoute,
  applyRoute,
  disconnectRoute,
]);
