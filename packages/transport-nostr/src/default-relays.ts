// M1-18 (D-75): the default relay set, the single source for every surface that needs a starting
// list (the CLI's owner init, the agent card, the bootstrap set). Public Nostr relays for the
// J9 dogfood and early production; 4thTech adds its own relay once there are first concrete users.
// A change to this list is a reviewed edit here, never a copy elsewhere. Each entry passes the
// relay URL rule (04 §4) and the list holds 2 to 16 entries (04 §3.4, 07 §4.3).

/** The default public relays (D-75). Vetted with `tools/relays/vet.mjs`; see `docs/runbooks/relay-vetting.md`. */
export const DEFAULT_RELAYS: readonly string[] = Object.freeze([
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
]);
