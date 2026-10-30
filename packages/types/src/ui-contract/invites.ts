// The local app's invite wire contract for W4-SHORT-INVITE and W4-INVITES-LIST (D-139; 04 §3.6.2;
// 08 §1; b11 §21): create (short by default, the long link on request), the open-invites list and
// Cancel, and the refusals a short link adds to check and accept. Typed samples, shared test data,
// not runtime logic. Both sides test against it:
//
// - packages/node (src/local-ui/ui-contract-invites.test.ts) drives the REAL route handlers with each
//   request and asserts the real answer has the sample's shape;
// - apps/local-ui (src/pages/contacts/*.test.ts) asserts its client builds exactly each request and
//   reads each answer as the outcome word next to it.
//
// All three routes are the invite kind (no presence): an octet-stream body holding one JSON object,
// the page's CSRF token, no query, no X-AgentLink-Input. The list never carries a link, a secret or
// a lookup ID: a lost link cannot be shown again (04 §3.6.2); the owner cancels and creates a new one.
// The world's values are filler.

/** `POST /api/ui/invites`: `{}`, `{label}`, and `long: true` only from Advanced (D-139 (7)). */
export interface InviteCreateBody {
  readonly label?: string;
  readonly long?: true;
}

export interface InviteCreatedBody {
  readonly status: 'ok';
  /** `https://agentlink.4thtech.io/i#2.<43>` (short) or `…/i#<payload>` (long). */
  readonly inviteUrl: string;
  readonly shareText: string;
  readonly ownerFingerprint: string;
  readonly expiresAt: string;
  /** `long` when asked for, or the automatic fallback when the drop was unavailable. */
  readonly format: 'short' | 'long';
}

/** One open invite: who it is for (the label, or null) and when it expires. Never the link. */
export interface OpenInviteBody {
  readonly inviteId: string;
  readonly name: string | null;
  readonly expiresAt: string;
}

/** `GET /api/ui/invites`: the open invites, newest first. */
export interface InvitesListBody {
  readonly invites: readonly OpenInviteBody[];
}

/** `POST /api/ui/invites/cancel` body: exactly `{inviteId}`. */
export interface InviteCancelBody {
  readonly inviteId: string;
}

export interface InvitesAnswer<B = unknown> {
  readonly status: number;
  readonly body: B;
}

export const INVITES_PATH = '/api/ui/invites';
export const INVITE_CANCEL_PATH = '/api/ui/invites/cancel';
/** The short link form (04 §3.6.2): the canonical host, `2.` and 43 base64url characters. */
export const SHORT_INVITE_LINK = /^https:\/\/agentlink\.4thtech\.io\/i#2\.[A-Za-z0-9_-]{43}$/;

export const INVITES_WORLD = {
  inviteId: 'AQEBAQEBAQEBAQEBAQEBAQ',
  otherInviteId: 'BwcHBwcHBwcHBwcHBwcHBw',
  shortLink: 'https://agentlink.4thtech.io/i#2.AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  ownerFingerprint: '7F3A·19C2',
  expiresAt: '2027-01-15T08:00:00Z',
} as const;

/** `POST /api/ui/invites` answers. */
export const INVITE_CREATE = {
  short: {
    body: {} satisfies InviteCreateBody,
    answer: {
      status: 200,
      body: {
        status: 'ok',
        inviteUrl: INVITES_WORLD.shortLink,
        shareText: `Add my AI agent on AgentLink: ${INVITES_WORLD.shortLink}`,
        ownerFingerprint: INVITES_WORLD.ownerFingerprint,
        expiresAt: INVITES_WORLD.expiresAt,
        format: 'short',
      },
    } satisfies InvitesAnswer<InviteCreatedBody>,
    outcome: 'ok',
  },
  long: {
    body: { long: true } satisfies InviteCreateBody,
    outcome: 'ok',
  },
} as const;

/** `GET /api/ui/invites` answers. */
export const INVITES_LIST = {
  empty: {
    answer: { status: 200, body: { invites: [] } } satisfies InvitesAnswer<InvitesListBody>,
    outcome: 'ok',
  },
  two: {
    answer: {
      status: 200,
      body: {
        invites: [
          { inviteId: INVITES_WORLD.inviteId, name: 'Bo', expiresAt: INVITES_WORLD.expiresAt },
          { inviteId: INVITES_WORLD.otherInviteId, name: null, expiresAt: INVITES_WORLD.expiresAt },
        ],
      },
    } satisfies InvitesAnswer<InvitesListBody>,
    outcome: 'ok',
  },
} as const;

/** `POST /api/ui/invites/cancel` answers. */
export const INVITE_CANCEL = {
  cancelled: {
    body: { inviteId: INVITES_WORLD.inviteId } satisfies InviteCancelBody,
    answer: { status: 200, body: { status: 'cancelled' } } satisfies InvitesAnswer,
    outcome: 'cancelled',
  },
  gone: {
    body: { inviteId: INVITES_WORLD.otherInviteId } satisfies InviteCancelBody,
    answer: { status: 404, body: { error: 'not_found' } } satisfies InvitesAnswer,
    outcome: 'not_found',
  },
} as const;

/**
 * What check and accept answer for a short link the drop no longer has (expired, used, cancelled or
 * deleted: the drop does not say which), and when the drop could not be reached (retryable).
 */
export const SHORT_INVITE_REFUSALS = {
  unavailable: {
    answer: { status: 400, body: { error: 'unavailable_invite' } } satisfies InvitesAnswer,
    outcome: 'unavailable',
  },
  retry: {
    answer: { status: 503, body: { error: 'try_again' } } satisfies InvitesAnswer,
    outcome: 'try_again',
  },
} as const;
