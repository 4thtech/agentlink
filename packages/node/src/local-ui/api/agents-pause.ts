// W4-PAUSE (S2; D-143 (5); 08 §1 "Pause an agent", `POST /api/ui/agents/pause`,
// `POST /api/ui/agents/resume`; 04 §2.5 "Live status and Pause", §2.5.1 `agent.resume`; 06 §6 "Paused
// agents"; gestures decided by Tali in chat, 2026-10-30, Decision 50 (Q-143-1); route details
// proposed, owner confirms at merge).
//
// - `POST /api/ui/agents/pause` `{generation}`: the pause kind (route-types.ts), run by the server's
//   pause gate; no handler here, no presence, nothing signed, only the open agent's pause row written.
// - `POST /api/ui/agents/resume` (presence; signs `agent.resume`): the open agent only. Before the
//   gesture (`precheck`, the owner store is never opened) it is refused with `not_paused` when the
//   agent is not paused, so the page asks for Touch ID only when there is a pause to end. After the
//   gesture core prepares the body for the open agent's `agentId`; node signs it only when it is
//   exactly `agent.resume` {agent} for that agent; core verifies it (owner, agent, nonce, 600 s) and
//   deletes the pause row in the transaction that records the nonce. The owner statement names the
//   agent by its verified label, else its folder name ("Resume {label}"). The operation input is
//   `{}` (the page sends no value); the generation is the page guard of every presence route.
//
// Refusals are fixed codes; nothing is logged here (I-7). No MCP tool or CLI command reaches these
// (I-4): a same-user process can still delete the pause row directly (G-1).
import type { JsonObject, JsonValue } from '@4thtech-io/crypto';
import type { LocalUiContext, LocalUiReadClient } from '../context.js';
import {
  AGENTS_PAUSE_PATH,
  AGENTS_RESUME_PATH,
  NOT_AVAILABLE,
  UI_NOT_SET_UP,
  UI_UNAVAILABLE,
  type LocalUiOwnerOperation,
  type LocalUiOwnerRoute,
  type LocalUiPauseRoute,
  type LocalUiRequest,
  type LocalUiResult,
  type LocalUiRoute,
} from '../route-types.js';

const fixed = (status: number, error: string): LocalUiResult =>
  Object.freeze({ status, body: Object.freeze({ error }) });

/** 409: the agent is not paused; nothing is signed (08 §1). */
const NOT_PAUSED = fixed(409, 'not_paused');
/** 400: the input is not `{}`. */
const INVALID = fixed(400, 'invalid');
/** Signed, but core did not apply it. */
const NOT_APPLIED = fixed(409, 'not_applied');

/** The operation input: absent or exactly `{}`. */
function emptyInput(input: JsonValue | undefined): boolean {
  if (input === undefined) return true;
  return (
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    Object.keys(input).length === 0
  );
}

type Agent = NonNullable<LocalUiReadClient['agent']>;

/** The open agent's pause reads, or a fixed refusal. */
function agentOf(context: LocalUiContext): Agent | LocalUiResult {
  const agent = context.client?.agent;
  if (context.client === undefined || agent === undefined) return UI_NOT_SET_UP;
  if (agent.pauseState === undefined || agent.prepareResume === undefined) return NOT_AVAILABLE;
  return agent;
}

const isResult = (value: unknown): value is LocalUiResult =>
  typeof value === 'object' && value !== null && 'status' in value && 'body' in value;

/** `not_paused` when the pause row is absent; an unreadable row counts as paused (fail closed). */
async function pausedRefusal(agent: Agent): Promise<LocalUiResult | undefined> {
  try {
    const reading = await (agent.pauseState as NonNullable<Agent['pauseState']>)();
    return reading.status === 'running' ? NOT_PAUSED : undefined;
  } catch {
    return UI_UNAVAILABLE;
  }
}

/** Before the presence gate: refuse when there is no pause to end (reads only). */
async function resumePrecheck(
  context: LocalUiContext,
  request: LocalUiRequest,
): Promise<LocalUiResult | undefined> {
  // An invalid input is answered by the handler (it signs nothing either).
  if (!emptyInput(request.input)) return undefined;
  const agent = agentOf(context);
  if (isResult(agent)) return agent;
  return pausedRefusal(agent);
}

/** Exactly an `agent.resume` for `agent` (what node signs; core checks it all again). */
function isResumeBody(body: unknown, agent: string): body is JsonObject {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const b = body as JsonObject;
  const params = b['params'];
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return false;
  const p = params as JsonObject;
  return (
    b['op'] === 'agent.resume' &&
    b['agent'] === agent &&
    Object.keys(p).length === 1 &&
    p['agent'] === agent
  );
}

/** POST /api/ui/agents/resume: ends the open agent's pause (signs `agent.resume`). */
async function resumeAgent(
  context: LocalUiContext,
  request: LocalUiRequest,
  owner: LocalUiOwnerOperation,
): Promise<LocalUiResult> {
  if (!emptyInput(request.input)) return INVALID;
  const agent = agentOf(context);
  if (isResult(agent)) return agent;
  const client = context.client as LocalUiReadClient;
  // Checked again after presence (the precheck ran before it): nothing is signed on a refusal.
  const refusal = await pausedRefusal(agent);
  if (refusal !== undefined) return refusal;
  let shown: string;
  let prepared: Awaited<ReturnType<NonNullable<Agent['prepareResume']>>>;
  try {
    const reading = await agent.label();
    // The statement names the verified label, else the folder name (never config.json's text).
    shown =
      reading.status === 'verified'
        ? reading.label
        : (context.agentsManage?.current() ?? 'this agent');
    prepared = await (agent.prepareResume as NonNullable<Agent['prepareResume']>)();
  } catch {
    return UI_UNAVAILABLE;
  }
  if (prepared.status !== 'prepared') {
    return prepared.reason === 'not_paused' ? NOT_PAUSED : NOT_APPLIED;
  }
  const body = prepared.body as unknown as JsonObject;
  if (!isResumeBody(body, client.agentId)) return NOT_APPLIED;
  const signatures = await owner.sign(
    { lines: [`Resume ${shown}`, 'Your AI apps can send and receive messages again.'] },
    [{ kind: 'owner-action', action: body }],
  );
  const first = signatures[0];
  if (signatures.length !== 1 || first === undefined || first.kind !== 'owner-action') {
    return NOT_APPLIED;
  }
  const outcome = await context.applyOwnerAction(first.signed);
  if (outcome.status !== 'applied') {
    return outcome.status === 'refused' && outcome.reason === 'not_paused'
      ? NOT_PAUSED
      : NOT_APPLIED;
  }
  return { status: 200, body: { status: 'resumed' } };
}

const pauseRoute: LocalUiPauseRoute = Object.freeze({
  method: 'POST',
  path: AGENTS_PAUSE_PATH,
  presence: 'pause',
});

const resumeRoute: LocalUiOwnerRoute = Object.freeze({
  method: 'POST',
  path: AGENTS_RESUME_PATH,
  presence: true,
  precheck: resumePrecheck,
  handler: resumeAgent,
});

export const agentsPauseRoutes: readonly LocalUiRoute[] = Object.freeze([pauseRoute, resumeRoute]);
