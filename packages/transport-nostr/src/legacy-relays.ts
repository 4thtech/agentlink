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
