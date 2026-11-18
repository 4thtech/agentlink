// RELAY-CARD-MIGRATION (S2; 0.5.13; 04 §2.5, §2.6; 07 §4.3; 08 §1; 11 §5; I-4, I-7;
// owner-approved 2026-11-18): the app's "Update your contact details".
//
// - `GET /api/ui/contact-details` (read): `{status: 'needed'}` while the open ID's card still lists
//   a server the release no longer uses (core identity.relayMigration), else `{status: 'current'}`.
//   Signs and writes nothing; the list itself is never sent to the page.
// - `POST /api/ui/contact-details` `{}` (presence): the gate's one-use `updateContactDetails` signs
//   the open agent's next card with the migrated list (owner-relay-migration.ts), then core's
//   card-update tells the contacts. The answer is `{status: 'done', contacts}`.
// - Before the gesture (`precheck`): `current` when there is nothing to update, `rotation_pending`
//   while an earlier change is unfinished. Nothing is signed on a refusal.
//
// No MCP tool reaches these (I-4). Nothing is logged here (I-7). User copy never says "relay" (11 §5).
import type { JsonValue } from '@4thtech-io/crypto';
import type { LocalUiContext } from '../context.js';
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
import { CONTACT_DETAILS_REVIEW } from '../../owner-relay-migration.js';

export const CONTACT_DETAILS_PATH = '/api/ui/contact-details';

const fixed = (status: number, error: string): LocalUiResult =>
  Object.freeze({ status, body: Object.freeze({ error }) });
const CURRENT = fixed(409, 'current');
const ROTATION_PENDING = fixed(409, 'rotation_pending');
const NOT_APPLIED = fixed(409, 'not_applied');
const INVALID = fixed(400, 'invalid');

/** The owner statement: one source, shared with the terminal (owner-relay-migration.ts). */
const REVIEW = CONTACT_DETAILS_REVIEW;

const isEmptyObject = (input: JsonValue | undefined): boolean =>
  input === undefined ||
  (typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    Object.keys(input).length === 0);

/** `needed`, `current`, or a result to answer instead (not set up, unavailable). */
async function stateOf(context: LocalUiContext): Promise<'needed' | 'current' | LocalUiResult> {
  const agent = context.client?.agent;
  if (agent === undefined) return UI_NOT_SET_UP;
  if (agent.relayMigration === undefined) return NOT_AVAILABLE;
  try {
    return (await agent.relayMigration()).status === 'needed' ? 'needed' : 'current';
  } catch {
    return UI_UNAVAILABLE;
  }
}

/** The refusals before the gesture, else undefined. Reads only. */
async function refusal(context: LocalUiContext): Promise<LocalUiResult | undefined> {
  const state = await stateOf(context);
  if (typeof state !== 'string') return state;
  if (state === 'current') return CURRENT;
  const sendState = context.client?.agent?.sendState;
  if (sendState === undefined) return UI_UNAVAILABLE;
  try {
    const s = await sendState();
    if (s === 'rotation_pending' || s === 'key_epoch_mismatch') return ROTATION_PENDING;
  } catch {
    return UI_UNAVAILABLE;
  }
  return undefined;
}

/** GET /api/ui/contact-details */
async function read(context: LocalUiContext, request: LocalUiRequest): Promise<LocalUiResult> {
  if ([...request.query.keys()].length > 0) return UI_INVALID_QUERY;
  const state = await stateOf(context);
  if (typeof state !== 'string') return state;
  return { status: 200, body: { status: state } };
}

/** POST /api/ui/contact-details `{}` */
async function update(
  context: LocalUiContext,
  request: LocalUiRequest,
  owner: LocalUiOwnerOperation,
): Promise<LocalUiResult> {
  if (!isEmptyObject(request.input)) return INVALID;
  // Checked again after presence (the precheck ran before it).
  const refused = await refusal(context);
  if (refused !== undefined) return refused;
  if (owner.updateContactDetails === undefined) return NOT_AVAILABLE;
  const outcome = await owner.updateContactDetails(REVIEW);
  if (outcome.status !== 'migrated') {
    if (outcome.reason === 'current') return CURRENT;
    if (outcome.reason === 'rotation_pending') return ROTATION_PENDING;
    return NOT_APPLIED;
  }
  return { status: 200, body: { status: 'done', contacts: outcome.contacts } };
}

const readRoute: LocalUiReadRoute = Object.freeze({
  method: 'GET',
  path: CONTACT_DETAILS_PATH,
  presence: false,
  handler: read,
});

const updateRoute: LocalUiOwnerRoute = Object.freeze({
  method: 'POST',
  path: CONTACT_DETAILS_PATH,
  presence: true,
  precheck: refusal,
  handler: update,
});

export const contactDetailsRoutes: readonly LocalUiRoute[] = Object.freeze([
  readRoute,
  updateRoute,
]);
