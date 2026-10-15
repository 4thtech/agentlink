// M1-8h: the relay list an agent's first card commits to (04 §2.4 `relaysHash`; 07 §4.2, §4.3: an
// own list holds 2 to 8 relays, 3 to 5 by default).
//
// PROVISIONAL. The release's default relay set is M1-18 (evaluation of public relays: kind 1059,
// NIP-42 AUTH for reads, NIP-11 limits, retention). Until it lands, `owner init` commits the card to
// this list so an agent is pairable for the J9 dogfood. Changing an agent's list later is a relay
// change (M1-7j, M1b), so M1-18 replaces this constant with its chosen set, owner-confirmed.
export const PROVISIONAL_CARD_RELAYS: readonly string[] = Object.freeze([
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
]);
