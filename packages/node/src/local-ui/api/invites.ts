// UX2-d1: the local app's invite routes (08 §1; 04 §3.6, §3.6.1, §4; 06 §2.1; b11 §21; owner
// decision 1.1; I-1, I-4, I-5, I-7).
//
// Invite kind (`presence: 'invite'`; no owner presence, nothing signed; the server's invite gate
// checked the session, CSRF, Origin, fetch metadata and the octet-stream type, refused a query, an
// operation input and a presence header, rate-limited create and parsed the body):
// - `POST /api/ui/invites`, body `{}` or `{"label": "<name>"}`: core `createInvite`. Answers what
//   `agentlink_create_invite` answers: the link, the ready-to-send text, the owner's short
//   fingerprint and the expiry. The label is stored sealed as a suggested alias and stays one until
//   the owner confirms the contact (06 §2.1 rule 1); it is never echoed here.
// - `POST /api/ui/invites/check`, body `{"invite": "<link>"}`: core's accept step 1 only (the one D-69
//   codec, strict schema, expiry, both card signatures, name and relays against the card, the relay
//   URL rule of 04 §4). It stores nothing and answers who it is, so the page can ask "Is this who you
//   expected?" before Touch ID (b11 §21.4).
//
// Owner route (`presence: true`, behind the central presence gate):
// - `POST /api/ui/invites/accept`, input `{"invite": "<link>"}`: step 1 again, then
//   `contacts.acceptInvites`. A `deny` rule signs nothing. Otherwise the owner's presence signs one
//   `approval.decide` (approve) for the accept action, the same action the MCP tool and the CLI build,
//   under the open request for it or a new one; core verifies and applies it, uses it once, and only
//   then stages the pairing (04 §3.6 Accept steps 2 and 3; I-4). The pairing stays pending until the
//   inviter's agent answers; the safety code follows as on Contacts.
//
// Only the canonical link `https://agentlink.4thtech.io/i#<payload>` or the bare payload ever reaches
// core: any other host, scheme, path, percent-escape, whitespace or size is refused here first, and
// nothing in these routes fetches anything (04 §4). The link holds the invite secret: it is answered
// only by create, only to the page, and never put in an error, an event or a log line (I-7).
import {
  CoreError,
  INVITE_LINK_PREFIX,
  INVITE_MAX_PAYLOAD_CHARS,
  acceptInviteSummary,
  inviteShareText,
  type CreatedInvite,
  type PendingContact,
} from '@4thtech-io/core';
import {
  canonicalizeToBytes,
  encodeHex,
  sha256,
  type JsonObject,
  type JsonValue,
} from '@4thtech-io/crypto';
import { buildApprovalOperation } from '../../owner-approval.js';
import type { LocalUiContext } from '../context.js';
import { INVITE_ACCEPT_PATH, INVITE_CHECK_PATH, INVITE_CREATE_PATH } from '../invite-paths.js';
import {
  LOCAL_UI_MAX_INPUT_CHARS,
  UI_NOT_SET_UP,
  type LocalUiCheckedInvite,
  type LocalUiInviteDesk,
  type LocalUiInviteRoute,
  type LocalUiOwnerOperation,
  type LocalUiOwnerRoute,
  type LocalUiRequest,
  type LocalUiResult,
  type LocalUiRoute,
} from '../route-types.js';

/**
 * The longest invite check and accept take (IR UX2-d1 L): the longest link the accept route's
 * operation input can carry as `{"invite":"<link>"}` (LOCAL_UI_MAX_INPUT_CHARS of base64url, so at
 * most 3/4 of that in JSON bytes, less the 13 bytes around the link; a link is ASCII). Check uses
 * the same bound, so an invite check takes is never one accept cannot carry; both refuse a longer
 * one with `invalid_invite`. AgentLink's own invites are far smaller; a longer one is accepted
 * through the AI or `agentlink accept` (08 §1).
 */
export const INVITE_LINK_MAX_CHARS =
  Math.floor((LOCAL_UI_MAX_INPUT_CHARS * 3) / 4) - JSON.stringify({ invite: '' }).length;
/** A payload's characters: strict base64url (the codec checks the rest). */
const PAYLOAD = /^[A-Za-z0-9_-]+$/;
/** The longest name typed for an invite; core checks the restricted form (06 §2.1). */
const MAX_LABEL_CHARS = 128;
const MAX_NAME_CHARS = 128;
/** The short owner fingerprint core shows (04 §2.9). */
const FINGERPRINT = /^[0-9A-F]{4}·[0-9A-F]{4}$/;

const fixed = (status: number, error: string): LocalUiResult =>
  Object.freeze({ status, body: Object.freeze({ error }) });

/** 400: the body or input is not the one shape this route takes; nothing is echoed. */
const INVALID = fixed(400, 'invalid');
const INVALID_INVITE = fixed(400, 'invalid_invite');
const INVALID_LABEL = fixed(400, 'invalid_label');
const EXPIRED = fixed(400, 'expired');
const OWN_INVITE = fixed(400, 'own_invite');
/** The agent cannot send now (revoked, or a key rotation in progress). */
const CANNOT_SEND = fixed(409, 'cannot_send');
/** Core refuses to pair with this card (revoked, conflicting or downgraded contact). */
const CANNOT_PAIR = fixed(409, 'cannot_pair');
/** The rules refuse invites (the gate answers 409 `refused`: nothing was signed). */
const POLICY_DENIED = fixed(409, 'policy_denied');
/** Signed, but core did not apply it. */
const NOT_APPLIED = fixed(409, 'not_applied');
/** Applied, but core would not use it (void, expired, or the rule changed in between). */
const NOT_USED = fixed(409, 'refused');
const UNAVAILABLE = fixed(503, 'unavailable');

const INVALID_INVITE_CODES: ReadonlySet<string> = new Set([
  'invite_invalid',
  'invite_too_large',
  'card_invalid',
  'card_owner_signature_invalid',
  'card_agent_signature_invalid',
  'card_expired',
  'name_invalid',
  'relays_invalid',
]);
const CANNOT_SEND_CODES: ReadonlySet<string> = new Set([
  'identity_revoked',
  'rotation_pending',
  'key_epoch_mismatch',
]);
const CANNOT_PAIR_CODES: ReadonlySet<string> = new Set([
  'contact_revoked',
  'contact_conflict',
  'repair_owner_changed',
  'repair_epoch_lower',
]);

/** A core refusal of a pasted invite as one fixed answer; undefined for anything else. */
function inviteRefusal(error: unknown): LocalUiResult | undefined {
  if (!(error instanceof CoreError)) return undefined;
  const code: string = error.code;
  if (code === 'invite_expired') return EXPIRED;
  if (code === 'contact_is_self') return OWN_INVITE;
  if (INVALID_INVITE_CODES.has(code)) return INVALID_INVITE;
  if (CANNOT_PAIR_CODES.has(code)) return CANNOT_PAIR;
  if (code === 'identity_missing') return UI_NOT_SET_UP;
  if (CANNOT_SEND_CODES.has(code)) return CANNOT_SEND;
  return undefined;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The invite from `{"invite": "<link>"}`: `'invalid'` for any other shape, `'not_a_link'` for a
 * string that is not the canonical link or a bare payload (04 §3.6 decoder step 1, 04 §4).
 */
function inviteOf(value: unknown): string | 'invalid' | 'not_a_link' {
  if (!isObject(value)) return 'invalid';
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'invite') return 'invalid';
  const link = value['invite'];
  if (typeof link !== 'string') return 'invalid';
  if (link.length === 0 || link.length > INVITE_LINK_MAX_CHARS) return 'not_a_link';
  const payload = link.startsWith(INVITE_LINK_PREFIX)
    ? link.slice(INVITE_LINK_PREFIX.length)
    : link;
  if (payload.length === 0 || payload.length > INVITE_MAX_PAYLOAD_CHARS) return 'not_a_link';
  return PAYLOAD.test(payload) ? link : 'not_a_link';
}

/** RFC 3339 in UTC, no fraction (as `agentlink_create_invite`), or undefined for a bad time. */
function rfc3339(unixSeconds: unknown): string | undefined {
  if (typeof unixSeconds !== 'number' || !Number.isSafeInteger(unixSeconds) || unixSeconds < 0) {
    return undefined;
  }
  const at = new Date(unixSeconds * 1000);
  if (Number.isNaN(at.getTime())) return undefined;
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Who a pasted invite names, as the page shows it (11 §5.2, §6.5): name-rule name, label, short fingerprint. */
function contactOut(contact: PendingContact): JsonObject | undefined {
  const name: unknown = contact.display.name;
  const short: unknown = contact.ownerFingerprint.short;
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_CHARS) {
    return undefined;
  }
  if (typeof short !== 'string' || !FINGERPRINT.test(short)) return undefined;
  // A pending contact is never safety-code checked (04 §3.6.1): its own name is self-declared.
  return { name, label: 'self-declared', ownerFingerprint: short };
}

// --- create -----------------------------------------------------------------------------------

async function createInvite(
  _context: LocalUiContext,
  body: JsonObject,
  invites: LocalUiInviteDesk | undefined,
): Promise<LocalUiResult> {
  if (invites === undefined) return UI_NOT_SET_UP;
  const keys = Object.keys(body);
  if (keys.some((k) => k !== 'label')) return INVALID;
  let label: string | undefined;
  if (keys.length === 1) {
    const value: JsonValue | undefined = body['label'];
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LABEL_CHARS) {
      return INVALID;
    }
    label = value;
  }
  let created: CreatedInvite;
  try {
    created = await invites.create(label === undefined ? {} : { label });
  } catch (error) {
    if (error instanceof CoreError) {
      if (error.code === 'name_invalid') return INVALID_LABEL;
      if (error.code === 'identity_missing') return UI_NOT_SET_UP;
      if (CANNOT_SEND_CODES.has(error.code)) return CANNOT_SEND;
    }
    return UNAVAILABLE;
  }
  const { inviteUrl, expiresAt } = created;
  const short: unknown = created.ownerFingerprint.short;
  const when = rfc3339(expiresAt);
  if (
    typeof inviteUrl !== 'string' ||
    !inviteUrl.startsWith(INVITE_LINK_PREFIX) ||
    typeof short !== 'string' ||
    !FINGERPRINT.test(short) ||
    when === undefined
  ) {
    return UNAVAILABLE;
  }
  return Object.freeze({
    status: 200,
    body: Object.freeze({
      status: 'ok',
      inviteUrl,
      shareText: inviteShareText(inviteUrl, expiresAt),
      ownerFingerprint: short,
      expiresAt: when,
    }),
  });
}

// --- check ------------------------------------------------------------------------------------

async function checkInvite(
  _context: LocalUiContext,
  body: JsonObject,
  invites: LocalUiInviteDesk | undefined,
): Promise<LocalUiResult> {
  if (invites === undefined) return UI_NOT_SET_UP;
  const link = inviteOf(body);
  if (link === 'invalid') return INVALID;
  if (link === 'not_a_link') return INVALID_INVITE;
  let checked: LocalUiCheckedInvite;
  try {
    checked = await invites.check(link);
  } catch (error) {
    return inviteRefusal(error) ?? UNAVAILABLE;
  }
  const contact = contactOut(checked.contact);
  const when = rfc3339(checked.expiresAt);
  if (contact === undefined || when === undefined) return UNAVAILABLE;
  return Object.freeze({
    status: 200,
    body: Object.freeze({ status: 'ok', contact, expiresAt: when }),
  });
}

// --- accept -----------------------------------------------------------------------------------

async function acceptInvite(
  context: LocalUiContext,
  request: LocalUiRequest,
  owner: LocalUiOwnerOperation,
): Promise<LocalUiResult> {
  const port = context.invites;
  if (port === undefined) return UI_NOT_SET_UP;
  const link = inviteOf(request.input);
  if (link === 'invalid') return INVALID;
  if (link === 'not_a_link') return INVALID_INVITE;
  if ([...request.query.keys()].length > 0) return INVALID;
  const ownerContext = await context.ownerContext();
  if (ownerContext === undefined) return UI_NOT_SET_UP;

  // Step 1 (04 §3.6 Accept): the one codec, schema, expiry, signatures and relays. Nothing stored.
  let contact: PendingContact;
  try {
    contact = await port.check(link);
  } catch (error) {
    return inviteRefusal(error) ?? UNAVAILABLE;
  }
  const shown = contactOut(contact);
  if (shown === undefined) return UNAVAILABLE;
  // Step 2: `contacts.acceptInvites`. A deny signs nothing (the gate answers 409 `refused`).
  if ((await port.decision()) === 'deny') return POLICY_DENIED;

  const action = await port.action(link);
  // IR UX2-d1 M: core's one summary (name, label, owner fingerprint), as the MCP tool and the CLI.
  const summary = acceptInviteSummary(contact);
  const opened = await port.openRequest(action, summary);
  const operation = buildApprovalOperation(
    ownerContext,
    [
      {
        approvalId: opened.approvalId,
        action: action as unknown as JsonValue,
        storedDigest: encodeHex(sha256(canonicalizeToBytes(action))),
        decision: 'approve',
        commitment: false,
        summary,
        requestExpiresAt: opened.expiresAt,
      },
    ],
    { nowSeconds: () => Math.floor(context.now() / 1000) },
  );
  // The owner's presence on this request is the approval (04 §3.6 Accept step 2): one decide.
  const [signature] = await owner.sign({ lines: operation.lines }, [
    { kind: 'owner-action', action: operation.body },
  ]);
  if (signature?.kind !== 'owner-action') return NOT_APPLIED;
  const outcome = await context.applyOwnerAction(signature.signed);
  if (outcome.status !== 'applied') return NOT_APPLIED;

  // Step 3: core uses the applied approval once, then stages and sends the handshake.
  let done: Awaited<ReturnType<typeof port.acceptApproved>>;
  try {
    done = await port.acceptApproved(link, opened.approvalId, action);
  } catch (error) {
    const refusal = inviteRefusal(error);
    if (refusal !== undefined) return refusal;
    throw error;
  }
  if (done.status !== 'started') return NOT_USED;
  const out = contactOut(done.contact) ?? shown;
  return Object.freeze({
    status: 200,
    body: Object.freeze({ status: 'pending', contact: out, sent: done.sent }),
  });
}

// --- routes -----------------------------------------------------------------------------------

export const inviteCreateRoute: LocalUiInviteRoute = Object.freeze<LocalUiInviteRoute>({
  method: 'POST',
  path: INVITE_CREATE_PATH,
  presence: 'invite',
  step: 'create',
  handler: createInvite,
});

export const inviteCheckRoute: LocalUiInviteRoute = Object.freeze<LocalUiInviteRoute>({
  method: 'POST',
  path: INVITE_CHECK_PATH,
  presence: 'invite',
  step: 'check',
  handler: checkInvite,
});

export const inviteAcceptRoute: LocalUiOwnerRoute = Object.freeze<LocalUiOwnerRoute>({
  method: 'POST',
  path: INVITE_ACCEPT_PATH,
  presence: true,
  handler: acceptInvite,
});

export const invitesRoutes: readonly LocalUiRoute[] = Object.freeze([
  inviteCreateRoute,
  inviteCheckRoute,
  inviteAcceptRoute,
]);
