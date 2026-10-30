// U3-d (D-138, U3-spec-04; 04 §2.5 "One entry", §2.5.1 `agent.label`, §2.8 "From the local app"; 08
// §1; proposed, owner confirms at merge): the agent's first `agent.label`, signed by the same owner
// gesture as its first card and its first policy, when the agent is created from the local app (Add
// an agent) or at first run with a name.
//
// - After the card is stored and verified, still inside the one unlocked owner session: core
//   `prepareLabel` builds the body. Node does not trust what was prepared: it signs only an
//   `agent.label` for exactly this agent and this owner with exactly the label the page showed, in
//   its one encoding, with a lifetime of at most 600 s (L(op)). Anything else is not signed.
// - The signed object is then applied through core `apply()`, which checks the owner signature, the
//   nonce, the restricted-label rule and stores it (07 §3.4 `local_owner_actions`).
// - The label is display text only: it never decides which agent anything applies to (the body binds
//   `agent`, the agentId). Nothing here logs the label (I-7); results are fixed values.
// - I-4: nothing here is reachable from MCP. The owner session never leaves node.
import {
  PREPARED_OWNER_ACTION_LIFETIME_SECONDS,
  isRestrictedAlias,
  type OwnerActionOutcome,
  type PreparedOwnerAction,
} from '@4thtech-io/core';
import {
  canonicalize,
  encodeHex,
  parseJson,
  type JsonObject,
  type OwnerPublicKeys,
  type OwnerSession,
} from '@4thtech-io/crypto';
import { NodeKeyStoreError } from './errors.js';
import { assertAllowedOwnerAction } from './owner-allowlist.js';
import { PlanOwnerSession } from './owner-add-agent-plan.js';
import { FirstCardSession, type FirstAgentCard, type FirstConnect } from './owner-first-card.js';
import {
  cardNamesOwner,
  signFirstPolicy,
  type SendFolderPlan,
  type SendFolderResult,
} from './owner-first-policy.js';

/** What the first label needs of core's OwnerActions (`client.ownerActions`). */
export interface FirstLabelActions {
  /** Builds the unsigned `agent.label` for this agent (core); signs and writes nothing. */
  prepareLabel(label: string): Promise<PreparedOwnerAction>;
  /** Verifies and applies one SignedOwnerAction (owner signature, nonce, label rule). */
  apply(input: object): Promise<OwnerActionOutcome>;
}

/** The label the page showed, and the agent's own core actions to sign and apply it with. */
export interface FirstLabel {
  readonly label: string;
  readonly actions: FirstLabelActions;
  /**
   * W4-ONE-TOUCH: the unsigned `agent.label` fixed at begin (04 §2.8). With it, exactly this body is
   * signed (after the same checks), never a newly prepared one.
   */
  readonly body?: JsonObject;
}

/** Whether the first label is in force (fixed values only). */
export type FirstLabelResult = 'saved' | 'not_saved';

const BODY_KEYS = 'agent,expiresAt,issuedAt,nonce,op,owner,params,v';
const PARAMS_KEYS = 'agent,label';
const NONCE = /^[A-Za-z0-9_-]{22}$/;

const keysOf = (value: JsonObject): string => Object.keys(value).sort().join(',');
const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Exactly one `agent.label` for `agent`, `owner` and `label`, within L(op) (see the header). */
export function isFirstLabelBody(
  body: JsonObject,
  agent: string,
  owner: OwnerPublicKeys,
  label: string,
): boolean {
  if (keysOf(body) !== BODY_KEYS) return false;
  if (body['v'] !== 1 || body['op'] !== 'agent.label') return false;
  if (body['agent'] !== agent || body['owner'] !== encodeHex(owner.ownerNostr)) return false;
  if (typeof body['nonce'] !== 'string' || !NONCE.test(body['nonce'])) return false;
  const params = body['params'];
  if (!isObject(params) || keysOf(params) !== PARAMS_KEYS) return false;
  if (params['agent'] !== agent || params['label'] !== label) return false;
  const issuedAt = body['issuedAt'];
  const expiresAt = body['expiresAt'];
  if (!isTime(issuedAt) || !isTime(expiresAt) || expiresAt <= issuedAt) return false;
  // L(op) of `agent.label` is 600 s (04 §2.5.1), the lifetime of every body the local app prepares.
  return expiresAt - issuedAt <= PREPARED_OWNER_ACTION_LIFETIME_SECONDS;
}

/**
 * After the first card (the caller checked it is stored and names this owner): signs and applies
 * the first label with `inner`, the owner session the one gesture unlocked (the caller closes it).
 * `saved` only when core applied exactly that body.
 */
export async function signFirstLabel(
  inner: OwnerSession,
  agent: string,
  owner: OwnerPublicKeys,
  first: FirstLabel,
): Promise<FirstLabelResult> {
  let body: JsonObject;
  try {
    if (first.body !== undefined) {
      // W4-ONE-TOUCH: the body fixed at begin (in the challenge), a plain copy read once.
      body = parseJson(canonicalize(first.body)) as JsonObject;
    } else {
      const prepared = await first.actions.prepareLabel(first.label);
      if (prepared.status !== 'prepared') return 'not_saved';
      // A plain copy, read once: what is checked is what is signed and applied.
      body = parseJson(canonicalize(prepared.body as unknown as JsonObject)) as JsonObject;
    }
  } catch {
    return 'not_saved';
  }
  if (!isFirstLabelBody(body, agent, owner, first.label)) return 'not_saved';
  let sig: string;
  try {
    assertAllowedOwnerAction(body);
    sig = await inner.signOwnerAction(body);
  } catch {
    return 'not_saved';
  }
  try {
    const outcome = await first.actions.apply({ body, sig });
    return outcome.status === 'applied' && outcome.op === 'agent.label' ? 'saved' : 'not_saved';
  } catch {
    return 'not_saved';
  }
}

/** What one owner gesture signed for an agent's first parts (fixed values only). */
export interface FirstPartsResult {
  /** The first rules, when a ready Send folder plan and `firstPolicy` were given. */
  readonly sendFolder?: SendFolderResult;
  /** The first label, when `firstLabel` was given. */
  readonly label?: FirstLabelResult;
  /**
   * W4-ONE-TOUCH: the first `app.connect`, when `firstConnect` was given: `stored` when core stored
   * and nonce-checked exactly that body (the config entry is written later, by the caller).
   */
  readonly connect?: FirstConnectResult;
}

/** W4-ONE-TOUCH: whether the first `app.connect` is stored (fixed values only). */
export type FirstConnectResult = 'stored' | 'not_stored';

const CONNECT_PARAMS_KEYS = 'agent,app,changeId';
const CHANGE_ID = /^[0-9a-f]{64}$/;

/** Exactly one `app.connect` for `agent` and `owner`, within L(op) (04 §2.5.1). */
export function isFirstConnectBody(
  body: JsonObject,
  agent: string,
  owner: OwnerPublicKeys,
): boolean {
  if (keysOf(body) !== BODY_KEYS) return false;
  if (body['v'] !== 1 || body['op'] !== 'app.connect') return false;
  if (body['agent'] !== agent || body['owner'] !== encodeHex(owner.ownerNostr)) return false;
  if (typeof body['nonce'] !== 'string' || !NONCE.test(body['nonce'])) return false;
  const params = body['params'];
  if (!isObject(params) || keysOf(params) !== CONNECT_PARAMS_KEYS) return false;
  if (params['agent'] !== agent || typeof params['app'] !== 'string') return false;
  if (typeof params['changeId'] !== 'string' || !CHANGE_ID.test(params['changeId'])) return false;
  const issuedAt = body['issuedAt'];
  const expiresAt = body['expiresAt'];
  if (!isTime(issuedAt) || !isTime(expiresAt) || expiresAt <= issuedAt) return false;
  return expiresAt - issuedAt <= PREPARED_OWNER_ACTION_LIFETIME_SECONDS;
}

/**
 * W4-ONE-TOUCH (04 §2.8 step 6): after the card, the rules and the label are stored and verified,
 * signs the `app.connect` fixed at begin with `inner` and stores it through core `apply` (owner
 * signature, nonce, this agent). `stored` only when core applied exactly that body. The config entry
 * is never written here.
 */
export async function signFirstConnect(
  inner: OwnerSession,
  agent: string,
  owner: OwnerPublicKeys,
  connect: FirstConnect,
): Promise<FirstConnectResult> {
  let body: JsonObject;
  try {
    body = parseJson(canonicalize(connect.body)) as JsonObject;
  } catch {
    return 'not_stored';
  }
  if (!isFirstConnectBody(body, agent, owner)) return 'not_stored';
  let sig: string;
  try {
    assertAllowedOwnerAction(body);
    sig = await inner.signOwnerAction(body);
  } catch {
    return 'not_stored';
  }
  try {
    const outcome = await connect.apply({ body, sig });
    return outcome.status === 'applied' && outcome.op === 'app.connect' ? 'stored' : 'not_stored';
  } catch {
    return 'not_stored';
  }
}

/** 06 §6: a label is 1 to 32 code points. */
const MAX_LABEL_CODE_POINTS = 32;

/**
 * U3-d-b: the self-declared name the first card commits to (`nameHash`, what contacts see): the first
 * label when one is signed in the same gesture, else `first.name`. A label that is not its own
 * restricted form (06 §2.1) is refused before anything is signed.
 */
export function cardNameOf(first: FirstAgentCard): string {
  const label = first.firstLabel?.label;
  if (label === undefined) return first.name;
  if (!isRestrictedAlias(label) || [...label].length > MAX_LABEL_CODE_POINTS) {
    throw new NodeKeyStoreError('owner_operation_invalid', 'The label is not a restricted name.');
  }
  return label;
}

/**
 * The agent's first parts with one unlocked owner session `inner` (owner init, first run, Add an
 * agent; the caller closes `inner`): exactly one card for `first.agent` and `owner` through the
 * restricted FirstCardSession (any other request is refused); then, only once that card is stored
 * and verified, the first rules (signFirstPolicy, when `plan` is ready and `firstPolicy` given) and
 * the first label (signFirstLabel, when `firstLabel` given). Rejects when the card is refused or
 * cannot be stored; callers decide from what core stored (cardNamesOwner), never from the error.
 */
export async function signFirstParts(
  given: OwnerSession,
  owner: OwnerPublicKeys,
  first: FirstAgentCard,
  plan?: SendFolderPlan,
): Promise<FirstPartsResult> {
  // W4-ONE-TOUCH (04 §2.8 "The restricted session"): with a plan fixed at begin, the owner session
  // signs exactly the plan's bodies, in order, each once and byte for byte, and nothing else.
  const inner: OwnerSession =
    first.plan === undefined ? given : new PlanOwnerSession(given, first.plan);
  // The wrapper signs one card for this agent and owner, then nothing; `inner` stays open for the
  // rules and the label, which are checked here byte for byte before `inner` signs them.
  const session = new FirstCardSession(inner, first.agent, owner);
  // U3-d-b (06 §6, 04 §2.8): with a first label, the card's self-declared name is that label (the
  // text the owner typed, already its own restricted form, 06 §2.1), never the folder name. Fixed
  // at creation: a later `agent.label` is local only and never re-publishes the card.
  await first.identity.init({
    owner: session,
    ownerKeys: owner,
    name: cardNameOf(first),
    relays: first.relays,
  });
  const { firstPolicy, firstLabel } = first;
  let sendFolder: SendFolderResult | undefined;
  if (plan?.status === 'ready' && firstPolicy !== undefined) {
    sendFolder = await signFirstPolicy(inner, { ...first, firstPolicy }, plan, owner);
  }
  let label: FirstLabelResult | undefined;
  if (firstLabel !== undefined) {
    label = (await cardNamesOwner(first, owner))
      ? await signFirstLabel(inner, first.agent, owner, firstLabel)
      : 'not_saved';
  }
  // W4-ONE-TOUCH (04 §2.8 step 6): the app.connect last, only when the card is stored and verified,
  // the label is in force and the rules are in force (or were not part of the plan).
  let connect: FirstConnectResult | undefined;
  if (first.firstConnect !== undefined) {
    const rulesOk =
      plan?.status !== 'ready' || firstPolicy === undefined || sendFolder?.status === 'allowed';
    connect =
      label === 'saved' && rulesOk && (await cardNamesOwner(first, owner))
        ? await signFirstConnect(inner, first.agent, owner, first.firstConnect)
        : 'not_stored';
  }
  return {
    ...(sendFolder === undefined ? {} : { sendFolder }),
    ...(label === undefined ? {} : { label }),
    ...(connect === undefined ? {} : { connect }),
  };
}
