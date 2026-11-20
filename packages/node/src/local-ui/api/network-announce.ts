// NET-ANNOUNCE-OPTOUT (S2; D-158 (7); 08 §1 `POST /api/ui/network/announce`; 04 §2.5.1
// `network.announce`; 07 §4.3 "Privacy"; I-4, I-5, I-7): "Don't also announce on the default
// servers", turned on or off without changing the list, in Advanced › Message network only.
//
// - An owner route (`presence: true`): behind the page session, the CSRF header, exact Host, Origin
//   and fetch metadata like every /api/ui/ write, then the presence gate. The input travels in
//   `X-AgentLink-Input` and is exactly `{announce: true | false}` (400 `invalid` otherwise).
// - Before the gesture (the precheck; nothing opened or signed): `false` is refused with 409
//   `mix_in_on` while the list holds a default or an old default server; 409 `same_choice` when the
//   choice is already the asked one; the agent's state: `agent_paused`, `rotation_pending`,
//   `not_applied`.
// - After the gesture the handler checks again, has core prepare the unsigned `network.announce` for
//   the open agent, signs it only when it is exactly {agent, announceDefault} for that agent and the
//   asked choice, and hands the signed object to core, which verifies it all again (owner, agent,
//   nonce, 600 s, the list) and writes the choice. Then core's clean-up runs: pending retries to the
//   default servers end (announce-optout.ts in core). Answer `{status: 'done', announceDefault}`.
// - The OS sheet names the action (`sheetDetail`, IR NET-OWNER-SET L6).
//
// No MCP tool, tool argument, description or `nextStep` reaches it (I-4). Nothing is logged; no answer
// carries a list, a host or a key (I-7).
import type { JsonObject, JsonValue } from '@4thtech-io/crypto';
import { holdsDefaultServer } from '@4thtech-io/core';
import type { LocalUiContext, LocalUiServerListState } from '../context.js';
import {
  UI_NOT_SET_UP,
  UI_UNAVAILABLE,
  type LocalUiOwnerOperation,
  type LocalUiOwnerRoute,
  type LocalUiRequest,
  type LocalUiResult,
} from '../route-types.js';

export const NETWORK_ANNOUNCE_PATH = '/api/ui/network/announce';

const fixed = (status: number, error: string): LocalUiResult =>
  Object.freeze({ status, body: Object.freeze({ error }) });
const INVALID = fixed(400, 'invalid');
const refusal = (code: string): LocalUiResult => fixed(409, code);

/** The OS sheet's line for each choice (11 §5.14 words: "server", never "relay"). */
const SHEET_OFF = "Don't also announce on the default servers";
const SHEET_ON = 'Announce on the default servers again';

/** `{announce: boolean}` exactly, else undefined. */
function askOf(input: JsonValue | undefined): boolean | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const keys = Object.keys(input);
  const announce = (input as JsonObject)['announce'];
  return keys.length === 1 && typeof announce === 'boolean' ? announce : undefined;
}

/** The agent's state refusals, else undefined (the same codes as the servers route). */
function stateRefusal(state: LocalUiServerListState): LocalUiResult | undefined {
  if (state.paused) return refusal('agent_paused');
  if (state.sendState === 'rotation_pending' || state.sendState === 'key_epoch_mismatch') {
    return refusal('rotation_pending');
  }
  if (state.sendState !== 'ready') return refusal('not_applied');
  return undefined;
}

/** Every check before (and again after) the gesture; undefined lets it on. */
async function checked(
  context: LocalUiContext,
  announce: boolean,
): Promise<LocalUiResult | undefined> {
  const port = context.serverList;
  if (port === undefined || context.client === undefined) return UI_NOT_SET_UP;
  let state: LocalUiServerListState;
  try {
    state = await port.state();
  } catch {
    return UI_UNAVAILABLE;
  }
  const refused = stateRefusal(state);
  if (refused !== undefined) return refused;
  if (!announce && holdsDefaultServer(state.relays)) return refusal('mix_in_on');
  if (state.announceDefault === announce) return refusal('same_choice');
  return undefined;
}

/** Exactly the `network.announce` of `agent` for `announce` (what node signs; core checks again). */
function isAnnounceBody(body: unknown, agent: string, announce: boolean): body is JsonObject {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const b = body as JsonObject;
  const params = b['params'];
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return false;
  const p = params as JsonObject;
  return (
    b['op'] === 'network.announce' &&
    b['agent'] === agent &&
    Object.keys(p).length === 2 &&
    p['agent'] === agent &&
    p['announceDefault'] === announce
  );
}

async function precheck(
  context: LocalUiContext,
  request: LocalUiRequest,
): Promise<LocalUiResult | undefined> {
  const announce = askOf(request.input);
  if (announce === undefined) return INVALID;
  return checked(context, announce);
}

async function handler(
  context: LocalUiContext,
  request: LocalUiRequest,
  owner: LocalUiOwnerOperation,
): Promise<LocalUiResult> {
  const announce = askOf(request.input);
  if (announce === undefined) return INVALID;
  // Checked again after presence (the precheck ran before it): nothing is signed on a refusal.
  const again = await checked(context, announce);
  if (again !== undefined) return again;
  const port = context.serverList;
  const agent = context.client?.agentId;
  if (port?.prepareAnnounce === undefined || agent === undefined) return UI_NOT_SET_UP;
  let prepared: Awaited<ReturnType<NonNullable<typeof port.prepareAnnounce>>>;
  try {
    prepared = await port.prepareAnnounce(announce);
  } catch {
    return UI_UNAVAILABLE;
  }
  if (prepared.status !== 'prepared') {
    return prepared.reason === 'mix_in_on' ? refusal('mix_in_on') : refusal('not_applied');
  }
  const body = prepared.body as unknown as JsonObject;
  if (!isAnnounceBody(body, agent, announce)) return refusal('not_applied');
  const signatures = await owner.sign(
    {
      lines: announce
        ? [SHEET_ON, 'AgentLink will also announce this ID on the default servers.']
        : [
            SHEET_OFF,
            'Only your servers will know this ID. Another computer can find it only with your owner link or a backup.',
          ],
    },
    [{ kind: 'owner-action', action: body }],
  );
  const first = signatures[0];
  if (signatures.length !== 1 || first === undefined || first.kind !== 'owner-action') {
    return refusal('not_applied');
  }
  let outcome: Awaited<ReturnType<LocalUiContext['applyOwnerAction']>>;
  try {
    outcome = await context.applyOwnerAction(first.signed);
  } catch {
    // A store error after the gesture (its text could carry a path, I-7): a fixed answer.
    return UI_UNAVAILABLE;
  }
  if (outcome.status !== 'applied') {
    const reason = outcome.status === 'refused' ? outcome.reason : undefined;
    return reason === 'mix_in_on' || reason === 'rotation_pending'
      ? refusal(reason)
      : refusal('not_applied');
  }
  // Best effort: the sync pass runs the same clean-up again.
  await port.afterAnnounce?.().catch(() => undefined);
  return { status: 200, body: { status: 'done', announceDefault: announce } };
}

/** POST /api/ui/network/announce (presence; signs `network.announce`). */
export const networkAnnounceRoute: LocalUiOwnerRoute = Object.freeze<LocalUiOwnerRoute>({
  method: 'POST',
  path: NETWORK_ANNOUNCE_PATH,
  presence: true,
  precheck,
  sheetDetail: (_context, request) => {
    const announce = askOf(request.input);
    return announce === undefined ? undefined : announce ? SHEET_ON : SHEET_OFF;
  },
  handler,
});
