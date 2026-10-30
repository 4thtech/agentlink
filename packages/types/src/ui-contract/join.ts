// The local app's join-screen wire contract (U3-invite; 08 §4 "One step from an invite link", b11
// §33.2): the requests the page sends and the answers the server gives, as typed samples. Shared test
// data, not runtime logic. Both sides test against it:
//
// - packages/node (src/local-ui/ui-contract-join.test.ts) drives the REAL app host, gates and route
//   handlers with each request and asserts the real answer is the sample answer;
// - apps/local-ui (src/pages/join/contract.test.ts) asserts its client builds exactly each request
//   and reads each answer as the outcome word next to it.
//
// The invite link never appears here: the page never has it. The world's values are filler.

/** `POST /api/ui/join/accept` input (X-AgentLink-Input): exactly `{inviteId}`. */
export interface JoinAcceptInput {
  readonly inviteId: string;
}

export interface JoinInviterBody {
  readonly name: string;
  readonly label: 'self-declared';
  readonly fingerprint: string;
}

/** `GET /api/ui/join`: never the link or any other invite field. */
export interface JoinReadBody {
  readonly state:
    | 'none'
    | 'waiting'
    | 'expired'
    | 'own'
    | 'already_accepted'
    | 'connecting'
    | 'waiting_for_them'
    | 'connected';
  readonly inviteId?: string;
  readonly inviter?: JoinInviterBody;
  readonly expiresAt?: string;
  /**
   * W4-PEOPLE-INVITE: only when `connected`, the new contact's ref (its ID, as the contacts routes
   * use it), so the screen reads that contact's safety code and no other.
   */
  readonly contactRef?: string;
}

export interface JoinAnswer<B = unknown> {
  readonly status: number;
  readonly body: B;
}

export const JOIN_PATH = '/api/ui/join';
export const JOIN_ACCEPT_PATH = '/api/ui/join/accept';
export const JOIN_DISMISS_PATH = '/api/ui/join/dismiss';
/** `agentlink join` only, never the page. */
export const JOIN_HANDOFF_PATH = '/api/ui/join/handoff';
/** The join screen's app page. */
export const JOIN_PAGE_PATH = '/settings/join';
/** Every owner operation and the invite kind send this type. */
export const OCTET_STREAM = 'application/octet-stream';

/**
 * The world the samples assume: one waiting invite from "Marko" (the checked values Accept step 1
 * answers), the clock before its expiry, the open agent `0x42…` with no contacts.
 */
export const JOIN_WORLD = {
  inviteId: 'AQEBAQEBAQEBAQEBAQEBAQ',
  otherInviteId: 'BwcHBwcHBwcHBwcHBwcHBw',
  contactId: '0x1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a',
  inviter: { name: 'Marko', label: 'self-declared', fingerprint: '7F3A·19C2' },
  expiresAtSeconds: 1_800_000_000,
  nowMs: 1_790_000_000_000,
  agentId: '0x4242424242424242424242424242424242424242',
  generation: 1,
} as const;

/** `GET /api/ui/join` before and with the waiting invite. */
export const JOIN_READ = {
  none: {
    answer: { status: 200, body: { state: 'none' } } satisfies JoinAnswer<JoinReadBody>,
    outcome: 'none',
  },
  waiting: {
    answer: {
      status: 200,
      body: {
        state: 'waiting',
        inviteId: JOIN_WORLD.inviteId,
        inviter: JOIN_WORLD.inviter,
        expiresAt: '2027-01-15T08:00:00Z',
      },
    } satisfies JoinAnswer<JoinReadBody>,
    outcome: 'waiting',
  },
  connected: {
    answer: {
      status: 200,
      body: {
        state: 'connected',
        inviteId: JOIN_WORLD.inviteId,
        inviter: JOIN_WORLD.inviter,
        expiresAt: '2027-01-15T08:00:00Z',
        contactRef: JOIN_WORLD.contactId,
      },
    } satisfies JoinAnswer<JoinReadBody>,
    outcome: 'connected',
  },
} as const;

/** `POST /api/ui/join/accept`: bound to the shown inviteId. */
export const JOIN_ACCEPT = {
  started: {
    input: { inviteId: JOIN_WORLD.inviteId } satisfies JoinAcceptInput,
    answer: {
      status: 200,
      body: {
        status: 'pending',
        contact: { name: 'Marko', label: 'self-declared', ownerFingerprint: '7F3A·19C2' },
        sent: true,
      },
    } satisfies JoinAnswer,
    outcome: 'pending',
  },
  changed: {
    input: { inviteId: JOIN_WORLD.otherInviteId } satisfies JoinAcceptInput,
    answer: { status: 409, body: { error: 'invite_changed' } } satisfies JoinAnswer,
    outcome: 'invite_changed',
  },
} as const;

/** `POST /api/ui/join/dismiss` ("Not now"): the invite kind, body `{}`. */
export const JOIN_DISMISS = {
  body: {},
  answer: { status: 200, body: { status: 'dismissed' } } satisfies JoinAnswer,
  outcome: 'dismissed',
} as const;
