// U3-invite: the join screen's routes (08 §4 "One step from an invite link"; 04 §3.6, §3.6.1; 06
// §7.1; b11 §33.2; I-2, I-4, I-5, I-7). The waiting invite is the app host's (local-ui/join-desk.ts);
// these routes never see the link except to hand it to the one accept path of api/invites.ts.
//
// - `GET /api/ui/join` (read; also before an owner exists, like the other reads): the state, the
//   public `inviteId`, the name-rule name with its Self-declared label, the short owner fingerprint
//   and the expiry. Never the link, the payload or any other invite field.
// - `POST /api/ui/join/accept`, input `{"inviteId": "<id>"}` (an ordinary owner route behind the
//   presence gate; refused before an owner exists). The input carries no invite: only the ID of the
//   invite the screen shows. A different ID is `invite_changed` before the presence gate
//   (`precheck`) and again after it (`take`), and nothing is signed. Then Accept step 1 again and
//   `contacts.acceptInvites`: the owner's presence signs one `approval.decide` for the same approval
//   action as `POST /api/ui/invites/accept`, the MCP tool and the CLI build, used once
//   (acceptInviteLink). A `deny` rule or a failed check signs nothing. Only a started pairing drops
//   the link from memory.
// - `POST /api/ui/join/dismiss`, body `{}` ("Not now"): the invite route kind, no owner presence, no
//   signing; it forgets the waiting invite.
//
// The handoff (`POST /api/ui/join/handoff`) has no handler: the server's handoff gate runs it
// (approval-server.ts), so no page file ever sees the handoff token.
import type { JsonObject } from '@4thtech-io/crypto';
import type { LocalUiContext } from '../context.js';
import {
  JOIN_ACCEPT_PATH,
  JOIN_DISMISS_PATH,
  JOIN_HANDOFF_PATH,
  JOIN_PATH,
} from '../invite-paths.js';
import {
  NOT_AVAILABLE,
  type LocalUiHandoffRoute,
  type LocalUiInviteRoute,
  type LocalUiOwnerOperation,
  type LocalUiOwnerRoute,
  type LocalUiReadRoute,
  type LocalUiRequest,
  type LocalUiResult,
  type LocalUiRoute,
} from '../route-types.js';
import { acceptInviteLink } from './invites.js';

const fixed = (status: number, error: string): LocalUiResult =>
  Object.freeze({ status, body: Object.freeze({ error }) });

const INVALID = fixed(400, 'invalid');
/** The screen showed another invite (or none is waiting): nothing is signed. */
export const INVITE_CHANGED = fixed(409, 'invite_changed');
const EXPIRED = fixed(400, 'expired');
const BUSY = fixed(409, 'busy');
/** The public invite ID: 16 bytes in base64url. */
const INVITE_ID = /^[A-Za-z0-9_-]{22}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The `inviteId` of exactly `{"inviteId": "<id>"}`, else undefined. */
function inviteIdOf(input: unknown): string | undefined {
  if (!isObject(input)) return undefined;
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== 'inviteId') return undefined;
  const id = input['inviteId'];
  return typeof id === 'string' && INVITE_ID.test(id) ? id : undefined;
}

async function readJoin(context: LocalUiContext, request: LocalUiRequest): Promise<LocalUiResult> {
  if (context.join === undefined) return NOT_AVAILABLE;
  if ([...request.query.keys()].length > 0) return INVALID;
  const view = await context.join.view(context.client);
  return Object.freeze({ status: 200, body: view as unknown as JsonObject });
}

/** Before the presence gate: the shape, and the ID against the shown invite (read only). */
function precheckAccept(
  context: LocalUiContext,
  request: LocalUiRequest,
): Promise<LocalUiResult | undefined> {
  if (context.join === undefined) return Promise.resolve(NOT_AVAILABLE);
  if ([...request.query.keys()].length > 0) return Promise.resolve(INVALID);
  const inviteId = inviteIdOf(request.input);
  if (inviteId === undefined) return Promise.resolve(INVALID);
  return context.join
    .view(context.client)
    .then((view) => (view.inviteId === inviteId ? undefined : INVITE_CHANGED));
}

async function acceptJoin(
  context: LocalUiContext,
  request: LocalUiRequest,
  owner: LocalUiOwnerOperation,
): Promise<LocalUiResult> {
  const desk = context.join;
  if (desk === undefined) return NOT_AVAILABLE;
  if ([...request.query.keys()].length > 0) return INVALID;
  const inviteId = inviteIdOf(request.input);
  if (inviteId === undefined) return INVALID;
  // Bound to the invite the screen showed: anything else signs nothing.
  const taken = desk.take(inviteId);
  if (taken === 'invite_changed') return INVITE_CHANGED;
  if (taken === 'expired') return EXPIRED;
  if (taken === 'busy') return BUSY;
  let started = false;
  try {
    const result = await acceptInviteLink(context, taken.link, owner);
    const body = result.body as Record<string, unknown> | null;
    started = result.status === 200 && isObject(body) && body['status'] === 'pending';
    return result;
  } finally {
    desk.settle(inviteId, started);
  }
}

async function dismissJoin(context: LocalUiContext, body: JsonObject): Promise<LocalUiResult> {
  if (context.join === undefined) return NOT_AVAILABLE;
  if (Object.keys(body).length > 0) return INVALID;
  context.join.dismiss();
  return Object.freeze({ status: 200, body: Object.freeze({ status: 'dismissed' }) });
}

export const joinReadRoute: LocalUiReadRoute = Object.freeze<LocalUiReadRoute>({
  method: 'GET',
  path: JOIN_PATH,
  presence: false,
  handler: readJoin,
});

export const joinAcceptRoute: LocalUiOwnerRoute = Object.freeze<LocalUiOwnerRoute>({
  method: 'POST',
  path: JOIN_ACCEPT_PATH,
  presence: true,
  precheck: precheckAccept,
  handler: acceptJoin,
});

export const joinDismissRoute: LocalUiInviteRoute = Object.freeze<LocalUiInviteRoute>({
  method: 'POST',
  path: JOIN_DISMISS_PATH,
  presence: 'invite',
  step: 'dismiss',
  handler: dismissJoin,
});

export const joinHandoffRoute: LocalUiHandoffRoute = Object.freeze<LocalUiHandoffRoute>({
  method: 'POST',
  path: JOIN_HANDOFF_PATH,
  presence: 'handoff',
});

export const joinRoutes: readonly LocalUiRoute[] = Object.freeze([
  joinReadRoute,
  joinAcceptRoute,
  joinDismissRoute,
  joinHandoffRoute,
]);
