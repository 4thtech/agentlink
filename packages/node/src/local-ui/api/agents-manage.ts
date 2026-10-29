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
// - `POST /api/ui/agents` `{label}` (presence; also signs the first `agent.label`): the server
//   creates a keychain agent whose folder name is a slug of the label, then the gate's one owner
//   operation signs exactly its first card, its first policy (the 06 §3 defaults with the Send
//   folder, when ready) and its first label, for that agent only. All or nothing: unless every part
//   is in force, exactly what this request created is removed again; the owner item is never
//   touched. The new agent does not become the open one.
//
// W4-RENAME-REACHES-CONTACTS (S2; D-141; 04 §2.5.1 `agent.label`, §2.6; 08 §1; 11 §5.8; proposed,
// owner confirms at merge):
// - A label that differs from the name in the agent's current card is a rename that rotates: the
//   same gesture signs the agent's next card with that name, then the label (the gate's one-use
//   `renameAgent`, owner-rename.ts). The core's card-update then tells the contacts; the answer adds
//   `contacts` (how many active contacts will be told). A label equal to the card's name changes only
//   the label (D-141 (3); also the repair after a failed label write).
// - Before the gesture (`precheck`, the owner store is never opened): `rename_limited` with `retryAt`
//   (unix seconds) after 3 renames that rotate in 24 h (Decision 46), and `rotation_pending` while an
//   earlier rotation is unfinished. The limit is a cost bound, not a security boundary (04 §2.5.1).
// - `GET /api/ui/agents/card-name` (read): agents renamed before D-141 (Decision 46): when the open
//   agent's verified label differs from its card's name, `{status: 'differs', cardName}` (the page
//   shows "Contacts still see {cardName}" with "Update contacts", which posts the same rename with the
//   current label); otherwise `{status: 'same'}`. Never re-published by itself.
//
// The generation of the page (08 §1) is checked by the server before the presence gate and again
// right before the handler runs; it is a page guard only, never part of a signed object. Refusals are
// fixed codes; neither a label nor a name is ever logged (I-7). No MCP tool reaches these (I-4).
import { isRestrictedAlias } from '@4thtech-io/core';
import type { JsonObject, JsonValue } from '@4thtech-io/crypto';
import type { LocalUiAgentsManage, LocalUiContext, LocalUiReadClient } from '../context.js';
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
/** D-141: an earlier rotation is unfinished; nothing is signed. */
const ROTATION_PENDING = fixed(409, 'rotation_pending');
/** D-141 (Decision 46): the 4th rename that rotates in 24 h; nothing is signed. */
const renameLimited = (retryAt: number): LocalUiResult =>
  Object.freeze({ status: 409, body: Object.freeze({ error: 'rename_limited', retryAt }) });
/** The shown card name: plain short text only (the label rule made it), else nothing is shown. */
const MAX_CARD_NAME_CHARS = 128;

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

/** D-141: whether `label` renames the agent (differs from its card's name), or undefined (unread). */
async function rotates(context: LocalUiContext, label: string): Promise<boolean | undefined> {
  const cardName = context.client?.agent?.cardName;
  if (cardName === undefined) return undefined;
  try {
    return (await cardName()) !== label;
  } catch {
    return undefined;
  }
}

/**
 * D-141: the refusals a rename that rotates gets before the gesture (`rotation_pending`,
 * `rename_limited`), else undefined. Reads only.
 */
async function rotationRefusal(context: LocalUiContext): Promise<LocalUiResult | undefined> {
  const agent = context.client?.agent;
  if (agent?.renameAllowance === undefined || agent.sendState === undefined) return UI_UNAVAILABLE;
  try {
    const state = await agent.sendState();
    if (state === 'rotation_pending' || state === 'key_epoch_mismatch') return ROTATION_PENDING;
    const allowance = await agent.renameAllowance();
    if (allowance.status === 'limited') return renameLimited(allowance.retryAt);
  } catch {
    return UI_UNAVAILABLE;
  }
  return undefined;
}

/** The rename input, checked: the open agent's folder name and a label core would sign. */
function renameInput(
  context: LocalUiContext,
  request: LocalUiRequest,
): { readonly name: string; readonly label: string } | LocalUiResult {
  const manage = context.agentsManage;
  if (manage === undefined) return NOT_AVAILABLE;
  if (context.client?.agent === undefined) return UI_NOT_SET_UP;
  const input = inputWith(request.input, ['name', 'label']);
  if (input === undefined) return INVALID;
  const { name, label } = input;
  if (typeof name !== 'string' || !AGENT_NAME.test(name)) return INVALID;
  if (!isAgentLabelText(label)) return LABEL_INVALID;
  // 04 §2.5: only the open agent; the binding that counts is its agentId in the signed body.
  if (manage.current() !== name) return NOT_OPEN;
  return { name, label };
}

const isResult = (value: unknown): value is LocalUiResult =>
  typeof value === 'object' && value !== null && 'status' in value && 'body' in value;

/** D-141: before the presence gate, a rename that rotates is refused when it cannot happen. */
async function renamePrecheck(
  context: LocalUiContext,
  request: LocalUiRequest,
): Promise<LocalUiResult | undefined> {
  const checked = renameInput(context, request);
  // An invalid input is answered by the handler (it signs nothing either).
  if (isResult(checked)) return undefined;
  if ((await rotates(context, checked.label)) !== true) return undefined;
  return rotationRefusal(context);
}

/** POST /api/ui/agents/label `{name, label}`: rename the open agent (signs `agent.label`). */
async function renameAgent(
  context: LocalUiContext,
  request: LocalUiRequest,
  owner: LocalUiOwnerOperation,
): Promise<LocalUiResult> {
  const checked = renameInput(context, request);
  if (isResult(checked)) return checked;
  const { name, label } = checked;
  const manage = context.agentsManage as LocalUiAgentsManage;
  const client = context.client as LocalUiReadClient;
  const agent = client.agent as NonNullable<LocalUiReadClient['agent']>;
  const rotating = await rotates(context, label);
  if (rotating === undefined) return UI_UNAVAILABLE;
  if (rotating) {
    // Checked again after presence (the precheck ran before it): nothing is signed on a refusal.
    const refusal = await rotationRefusal(context);
    if (refusal !== undefined) return refusal;
    if (owner.renameAgent === undefined) return NOT_AVAILABLE;
  }
  let shown: string;
  let prepared: Awaited<ReturnType<typeof agent.prepareLabel>>;
  try {
    const reading = await agent.label();
    // The statement names the verified label, else the folder name (never config.json's text).
    shown = reading.status === 'verified' ? reading.label : name;
    prepared = await agent.prepareLabel(label);
  } catch {
    return UI_UNAVAILABLE;
  }
  if (prepared.status !== 'prepared') {
    return prepared.reason === 'label_invalid' ? LABEL_INVALID : NOT_APPLIED;
  }
  const body = prepared.body as unknown as JsonObject;
  if (!isLabelBody(body, client.agentId, label)) return NOT_APPLIED;
  let signed: { readonly body: JsonObject; readonly sig: string };
  let contacts: number | undefined;
  if (rotating && owner.renameAgent !== undefined) {
    // 11 §5.8: one gesture renames for the contacts too.
    const outcome = await owner.renameAgent(
      { lines: [`Rename ${shown} to ${label}`, 'Your contacts will see the new name.'] },
      { label, labelBody: body },
    );
    if (outcome.status !== 'signed') {
      if (outcome.reason === 'rename_limited') return renameLimited(outcome.retryAt ?? 0);
      if (outcome.reason === 'rotation_pending') return ROTATION_PENDING;
      return NOT_APPLIED;
    }
    signed = outcome.label;
    contacts = outcome.contacts;
  } else {
    const signatures = await owner.sign({ lines: [`Rename ${shown} to ${label}`] }, [
      { kind: 'owner-action', action: body },
    ]);
    const first = signatures[0];
    if (signatures.length !== 1 || first === undefined || first.kind !== 'owner-action') {
      return NOT_APPLIED;
    }
    signed = first.signed;
  }
  const outcome = await context.applyOwnerAction(signed);
  if (outcome.status !== 'applied') return NOT_APPLIED;
  // Display only (07 §9.1): the verified label is in the agent's store; a failed write leaves the
  // old text in config.json, which never authorises anything.
  await manage.labelSaved(name, label).catch(() => undefined);
  return {
    status: 200,
    body: { status: 'done', label, ...(contacts === undefined ? {} : { contacts }) },
  };
}

/** GET /api/ui/agents/card-name: "Contacts still see {cardName}" (D-141, Decision 46). */
async function cardNameRead(
  context: LocalUiContext,
  request: LocalUiRequest,
): Promise<LocalUiResult> {
  if ([...request.query.keys()].length > 0) return UI_INVALID_QUERY;
  const agent = context.client?.agent;
  if (agent === undefined) return UI_NOT_SET_UP;
  if (agent.cardName === undefined) return NOT_AVAILABLE;
  try {
    const reading = await agent.label();
    const cardName = await agent.cardName();
    if (
      reading.status === 'verified' &&
      typeof cardName === 'string' &&
      cardName !== reading.label &&
      cardName.length <= MAX_CARD_NAME_CHARS
    ) {
      return { status: 200, body: { status: 'differs', cardName } };
    }
    return { status: 200, body: { status: 'same' } };
  } catch {
    return UI_UNAVAILABLE;
  }
}

/** POST /api/ui/agents `{label}`: add an agent (card, first policy and first label, one gesture). */
async function addAgent(
  context: LocalUiContext,
  request: LocalUiRequest,
  owner: LocalUiOwnerOperation,
): Promise<LocalUiResult> {
  const manage = context.agentsManage;
  if (manage === undefined || owner.addAgent === undefined) return NOT_AVAILABLE;
  const input = inputWith(request.input, ['label']);
  if (input === undefined) return INVALID;
  const { label } = input;
  if (!isAgentLabelText(label)) return LABEL_INVALID;
  const created = await manage.create(label).catch(() => undefined);
  if (created === undefined) return UI_UNAVAILABLE;
  let ok = false;
  try {
    const outcome = await owner.addAgent({ lines: [`Add a new agent: ${label}`] }, created);
    ok = outcome.status === 'done';
  } finally {
    // All or nothing: a new agent that is not complete is removed again.
    await manage.settle(created, ok);
  }
  if (!ok) return NOT_APPLIED;
  return { status: 200, body: { status: 'done', name: created.name, label } };
}

const labelCheckRoute: LocalUiReadRoute = Object.freeze({
  method: 'GET',
  path: '/api/ui/agents/label-check',
  presence: false,
  handler: labelCheck,
});

const addRoute: LocalUiOwnerRoute = Object.freeze({
  method: 'POST',
  path: '/api/ui/agents',
  presence: true,
  handler: addAgent,
});

const renameRoute: LocalUiOwnerRoute = Object.freeze({
  method: 'POST',
  path: '/api/ui/agents/label',
  presence: true,
  precheck: renamePrecheck,
  handler: renameAgent,
});

const cardNameRoute: LocalUiReadRoute = Object.freeze({
  method: 'GET',
  path: '/api/ui/agents/card-name',
  presence: false,
  handler: cardNameRead,
});

export const agentsManageRoutes: readonly LocalUiRoute[] = Object.freeze([
  labelCheckRoute,
  addRoute,
  renameRoute,
  cardNameRoute,
]);
