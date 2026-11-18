// RELAY-DEFAULTS-SWAP (0.5.13): the two relays the default set dropped. Existing agents, contacts and
// invites may still list them, and messages or acks may still be waiting there. For a transition
// period AgentLink only READS from them (a catch-up pass and the live subscription). It never
// publishes to them on its own: a send goes to the own list and to the contact's own list from their
// card or invite, so a contact that still lists a legacy relay is reached there, and nowhere else.
// They are not the agent's own relays, so no login (AUTH) is ever signed for them (04 §3.5).
// Added 2026-11-18; removal planned for a later release (not before 0.6.0). Each entry passes the
// relay URL rule (04 §4). Not part of the default set: `tools/relays/vet.mjs` never reads this file.

/** Relays read, never published to, during the 0.5.13 transition (dated 2026-11-18). */
export const LEGACY_READ_RELAYS: readonly string[] = Object.freeze([
  'wss://nos.lol',
  'wss://nostr.mom',
]);

/**
 * RELAY-CARD-MIGRATION, the one exception to "never published to": until this time (unix seconds,
 * 2027-01-31T00:00:00Z, more than 30 days after the 0.5.13 release) a card-update to a contact is
 * ALSO published to the legacy relays, so contacts still listening there learn a moved relay list.
 * From then on it never is.
 *
 * Removal rule: the legacy READS must outlive the last migration by at least 30 days, so
 * LEGACY_READ_RELAYS is not removed before LEGACY_CARD_UPDATE_UNTIL + 30 days (2027-03-02). Moving
 * this date moves that removal with it.
 */
export const LEGACY_CARD_UPDATE_UNTIL = 1_801_353_600;
