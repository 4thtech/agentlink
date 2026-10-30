// U3-d (S2; D-138, U3-spec-04; 08 §1 "Agents and AI apps in the app", "Signed local owner actions";
// 04 §2.5 "Several agents in one app", §2.5.1 `agent.label`, §2.8 "From the local app"; b11 §29.3,
// §29.5; proposed, owner confirms at merge): create an agent and rename one from the local app. These
// replace the U3-c stubs of the same paths.
//
// - `GET /api/ui/agents/label-check?label=` (read): whether core would sign that label, so the page
//   asks for Touch ID only for a label that can be applied: 1 to 32 code points, already its own
//   restricted form (06 §2.1, as `contact.rename` `alias`); otherwise `label_invalid`. Signs and
//   writes nothing.
// - `POST /api/ui/agents/label` `{name, label}` (presence; signs `agent.label`): the open agent only
//   (`name` must be its folder name). Core prepares the body for the open agent's `agentId`; node
//   signs it only when it names that agent and exactly that label. The owner statement names the
//   agent by its verified label, else its folder name, never the unsigned label in config.json
//   ("Rename Personal to Home", b11 §29.5). After core verified and applied it, config.json's label
//   is written (07 §9.1). The folder name, AI app entries and identity stay the same.
// - W4-ONE-TOUCH (D-140): `POST /api/ui/agents/begin` `{label, app?}` and `POST /api/ui/agents`
//   `{nonce}` (the create-agent kind, run by the server's createAgentGate; owner-add-agent-plan.ts):
//   one gesture creates the agent (its first card, first policy and first label) and, with an app
//   picked, signs its first `app.connect` and writes that app's entry last. No handler here.
//
// The generation of the page (08 §1) is checked by the server before the presence gate and again
// right before the handler runs; it is a page guard only, never part of a signed object. Refusals are
// fixed codes; neither a label nor a name is ever logged (I-7). No MCP tool reaches these (I-4).
import { isRestrictedAlias } from '@4thtech-io/core';
import type { JsonObject, JsonValue } from '@4thtech-io/crypto';
import type { LocalUiContext } from '../context.js';
import {
  NOT_AVAILABLE,
  UI_INVALID_QUERY,
  UI_NOT_SET_UP,
  UI_UNAVAILABLE,
  type LocalUiCreateAgentRoute,
  type LocalUiOwnerOperation,
  type LocalUiOwnerRoute,
  type LocalUiReadRoute,
  type LocalUiRequest,
  type LocalUiResult,
  type LocalUiRoute,
} from '../route-types.js';
import { CREATE_AGENT_PATHS } from '../route-types.js';

/** 06 §6 agent-name rule (the folder name). */
const AGENT_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** The longest label: 32 code points (06 §6). A longer input is never parsed further. */
const MAX_LABEL_CODE_POINTS = 32;
const MAX_LABEL_CHARS = 128;

const fixed = (status: number, error: string): LocalUiResult =>
  Object.freeze({ status, body: Object.freeze({ error }) });

/** 400: the label is not 1 to 32 code points in its own restricted form. */
const LABEL_INVALID = fixed(400, 'label_invalid');
/** 400: the input is not exactly the keys this route takes. */
const INVALID = fixed(400, 'invalid');
/** 409: the name is not the open agent (the page re-reads; 08 §1). */
const NOT_OPEN = fixed(409, 'agent_changed');
/** Signed, but core did not apply it, or a part of a new agent is not in force. */
const NOT_APPLIED = fixed(409, 'not_applied');

/** True for a label core would sign: 1 to 32 code points, already its own restricted form. */
export function isAgentLabelText(label: unknown): label is string {
  return (
    typeof label === 'string' &&
    label.length <= MAX_LABEL_CHARS &&
    [...label].length <= MAX_LABEL_CODE_POINTS &&
    isRestrictedAlias(label)
  );
}

/** A plain object with exactly these keys, or undefined. */
function inputWith(input: JsonValue | undefined, keys: readonly string[]): JsonObject | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const own = Object.keys(input);
  if (own.length !== keys.length || !keys.every((k) => own.includes(k))) return undefined;
  return input as JsonObject;
}

/** GET /api/ui/agents/label-check?label= */
async function labelCheck(
  _context: LocalUiContext,
  request: LocalUiRequest,
): Promise<LocalUiResult> {
  const keys = [...request.query.keys()];
  const values = request.query.getAll('label');
  if (keys.length !== 1 || keys[0] !== 'label' || values.length !== 1) {
    return Promise.resolve(UI_INVALID_QUERY);
  }
  const ok = isAgentLabelText(values[0]);
  return Promise.resolve(
    ok
      ? { status: 200, body: { status: 'ok' } }
      : { status: 200, body: { status: 'refused', reason: 'label_invalid' } },
  );
}

/** Exactly an `agent.label` for `agent` and `label` (what node signs; core checks it all again). */
function isLabelBody(body: unknown, agent: string, label: string): body is JsonObject {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const b = body as JsonObject;
  const params = b['params'];
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return false;
  const p = params as JsonObject;
  return (
    b['op'] === 'agent.label' &&
    b['agent'] === agent &&
    Object.keys(p).length === 2 &&
    p['agent'] === agent &&
    p['label'] === label
  );
}

/** POST /api/ui/agents/label `{name, label}`: rename the open agent (signs `agent.label`). */
async function renameAgent(
  context: LocalUiContext,
  request: LocalUiRequest,
  owner: LocalUiOwnerOperation,
): Promise<LocalUiResult> {
  const manage = context.agentsManage;
  if (manage === undefined) return NOT_AVAILABLE;
  const client = context.client;
  if (client?.agent === undefined) return UI_NOT_SET_UP;
  const input = inputWith(request.input, ['name', 'label']);
  if (input === undefined) return INVALID;
  const { name, label } = input;
  if (typeof name !== 'string' || !AGENT_NAME.test(name)) return INVALID;
  if (!isAgentLabelText(label)) return LABEL_INVALID;
  // 04 §2.5: only the open agent; the binding that counts is its agentId in the signed body.
  if (manage.current() !== name) return NOT_OPEN;
  let shown: string;
  let prepared: Awaited<ReturnType<NonNullable<typeof client.agent>['prepareLabel']>>;
  try {
    const reading = await client.agent.label();
    // The statement names the verified label, else the folder name (never config.json's text).
    shown = reading.status === 'verified' ? reading.label : name;
    prepared = await client.agent.prepareLabel(label);
  } catch {
    return UI_UNAVAILABLE;
  }
  if (prepared.status !== 'prepared') {
    return prepared.reason === 'label_invalid' ? LABEL_INVALID : NOT_APPLIED;
  }
  const body = prepared.body as unknown as JsonObject;
  if (!isLabelBody(body, client.agentId, label)) return NOT_APPLIED;
  const signatures = await owner.sign({ lines: [`Rename ${shown} to ${label}`] }, [
    { kind: 'owner-action', action: body },
  ]);
  const first = signatures[0];
  if (signatures.length !== 1 || first === undefined || first.kind !== 'owner-action') {
    return NOT_APPLIED;
  }
  const outcome = await context.applyOwnerAction(first.signed);
  if (outcome.status !== 'applied') return NOT_APPLIED;
  // Display only (07 §9.1): the verified label is in the agent's store; a failed write leaves the
  // old text in config.json, which never authorises anything.
  await manage.labelSaved(name, label).catch(() => undefined);
  return { status: 200, body: { status: 'done', label } };
}

const labelCheckRoute: LocalUiReadRoute = Object.freeze({
  method: 'GET',
  path: '/api/ui/agents/label-check',
  presence: false,
  handler: labelCheck,
});

// W4-ONE-TOUCH (D-140; 08 §1): New agent is two calls and one gesture, run by the server's
// create-agent gate (approval-server.ts createAgentGate; owner-add-agent-plan.ts): begin creates the
// keys in memory and fixes the plan; finish takes only the nonce and the presence proof.
const beginRoute: LocalUiCreateAgentRoute = Object.freeze({
  method: 'POST',
  path: CREATE_AGENT_PATHS.begin,
  presence: 'create-agent',
  step: 'begin',
});

const addRoute: LocalUiCreateAgentRoute = Object.freeze({
  method: 'POST',
  path: CREATE_AGENT_PATHS.finish,
  presence: 'create-agent',
  step: 'finish',
});

const renameRoute: LocalUiOwnerRoute = Object.freeze({
  method: 'POST',
  path: '/api/ui/agents/label',
  presence: true,
  handler: renameAgent,
});

export const agentsManageRoutes: readonly LocalUiRoute[] = Object.freeze([
  labelCheckRoute,
  beginRoute,
  addRoute,
  renameRoute,
]);
