// W5-INVITE-FEEDBACK (08 §1; 04 §2.9 re-pair; I-5, I-7): what the invite answers add so both sides
// of an invite see what is happening and when it is done, with no reload. Typed samples, shared
// test data, not runtime logic: packages/node drives the real handlers with them, apps/local-ui reads
// them with its client.
//
// - `GET /api/ui/invites` also answers `connecting`: this agent's accepts that wait for the
//   inviter's answer (the invitee side), each with the contact's ref, the name as the name rule
//   shows it, the expiry, whether the handshake left this computer yet (`sent`) and whether the
//   agent is already a contact (`again`). Never a link, a card, a key or a pairing ID.
// - `POST /api/ui/invites/check` also answers `alreadyContact` `{ref, name}` when the invite comes
//   from an agent that is already an active, paired contact (the name the owner sees for it).
// - `POST /api/ui/invites/accept` also answers `again` (a re-pair: the safety code check starts
//   over) next to the existing `sent`.
// - `GET /api/ui/contacts` rows also carry `pairedAt` (unix seconds of the kept pairing), so a
//   re-pair is visible; the `contacts` event of `GET /api/ui/events` carries only `at`.
// The world's values are filler.

export interface ConnectingBody {
  readonly ref: string;
  readonly name: string;
  readonly expiresAt: string;
  readonly sent: boolean;
  readonly again: boolean;
}

export interface AlreadyContactBody {
  readonly ref: string;
  readonly name: string;
}

export const FEEDBACK_WORLD = {
  ref: `0x${'3d'.repeat(20)}`,
  name: 'Marko',
  ownerFingerprint: 'AB12·CD34',
  expiresAt: '2027-01-15T08:00:00Z',
} as const;

/** `GET /api/ui/invites` with an accept that waits (and none open of this agent's own). */
export const INVITES_CONNECTING = {
  answer: {
    status: 200,
    body: {
      invites: [],
      connecting: [
        {
          ref: FEEDBACK_WORLD.ref,
          name: FEEDBACK_WORLD.name,
          expiresAt: FEEDBACK_WORLD.expiresAt,
          sent: false,
          again: false,
        },
      ],
    },
  },
} as const;

/** `POST /api/ui/invites/check` for an invite from an agent that is already a contact. */
export const INVITE_CHECK_AGAIN = {
  answer: {
    status: 200,
    body: {
      status: 'ok',
      contact: {
        name: FEEDBACK_WORLD.name,
        label: 'self-declared',
        ownerFingerprint: FEEDBACK_WORLD.ownerFingerprint,
      },
      expiresAt: FEEDBACK_WORLD.expiresAt,
      alreadyContact: { ref: FEEDBACK_WORLD.ref, name: 'Marko (work)' },
    },
  },
} as const;

/** `POST /api/ui/invites/accept` for a re-pair whose handshake could not be sent yet. */
export const INVITE_ACCEPT_AGAIN_OFFLINE = {
  answer: {
    status: 200,
    body: {
      status: 'pending',
      contact: {
        name: FEEDBACK_WORLD.name,
        label: 'self-declared',
        ownerFingerprint: FEEDBACK_WORLD.ownerFingerprint,
      },
      sent: false,
      again: true,
    },
  },
} as const;
