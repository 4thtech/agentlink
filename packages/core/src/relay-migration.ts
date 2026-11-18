// RELAY-CARD-MIGRATION (0.5.13; 04 §2.6; 07 §4.3; owner-approved 2026-11-18): moving an existing
// ID's card off the relays the default set dropped (LEGACY_READ_RELAYS).
//
// - Detection. An ID needs the migration when its stored card relay list holds any legacy relay.
// - The migrated list. Legacy entries are removed; every relay the user had otherwise is kept, in its
//   order; then the default relays not yet present are added, in order, while the list holds fewer
//   than MAX_RELAYS entries. The result always holds MIN_RELAYS to MAX_RELAYS distinct entries.
// - The change itself is a rotation to keyEpoch + 1 (identity.rotate({relays})), signed by the owner
//   with presence in an owner surface only. No MCP tool reaches it (I-4). Contacts learn the new card
//   through card-update, which during the transition is ALSO published to the legacy relays
//   (cardUpdateLegacyRelays), so a contact still listening there gets it. Without the owner's
//   gesture nothing breaks: legacy relays are still read.
//
// Pure functions; nothing here signs, stores or logs.
import { DEFAULT_RELAYS, LEGACY_READ_RELAYS } from '@4thtech-io/transport-nostr';
import { MAX_RELAYS, MIN_RELAYS } from '@4thtech-io/types';

/** Whether a relay list still names a relay the default set dropped. */
export function needsRelayMigration(
  relays: readonly string[],
  legacy: readonly string[] = LEGACY_READ_RELAYS,
): boolean {
  return relays.some((r) => legacy.includes(r));
}

/** The migrated list (see the header). A list without a legacy relay is returned unchanged. */
export function migratedRelays(
  relays: readonly string[],
  options: { readonly legacy?: readonly string[]; readonly defaults?: readonly string[] } = {},
): readonly string[] {
  const legacy = options.legacy ?? LEGACY_READ_RELAYS;
  const defaults = options.defaults ?? DEFAULT_RELAYS;
  if (!needsRelayMigration(relays, legacy)) return Object.freeze([...relays]);
  const out: string[] = [];
  for (const r of relays) if (!legacy.includes(r) && !out.includes(r)) out.push(r);
  for (const r of defaults) {
    if (out.length >= MAX_RELAYS) break;
    if (!out.includes(r) && !legacy.includes(r)) out.push(r);
  }
  if (out.length < MIN_RELAYS) {
    // Only reachable with a default set smaller than MIN_RELAYS; never a list the card refuses.
    throw new Error('relay migration: the default set is too small');
  }
  return Object.freeze(out.slice(0, MAX_RELAYS));
}

/** What an ID's relay migration is: nothing to do, or the list its next card would carry. */
export type RelayMigration =
  | { readonly status: 'current' }
  | { readonly status: 'needed'; readonly relays: readonly string[] };

/**
 * The extra relays a card-update to a contact is also published to during the transition: the
 * legacy relays, so contacts still listening there learn the new card. Only card-updates use it.
 */
export function cardUpdateLegacyRelays(): readonly string[] {
  return LEGACY_READ_RELAYS;
}
