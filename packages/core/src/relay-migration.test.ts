// RELAY-CARD-MIGRATION (S2; 04 §2.6, 07 §4.3): detection and the migrated relay list.
import { DEFAULT_RELAYS, LEGACY_READ_RELAYS } from '@4thtech-io/transport-nostr';
import { describe, expect, it } from 'vitest';
import { MAX_OWN_RELAYS } from '@4thtech-io/types';
import { checkOwnRelays, checkRelays } from './card.js';
import { migratedRelays, needsRelayMigration } from './relay-migration.js';

const OLD = ['wss://nos.lol', 'wss://nostr.mom', 'wss://relay.primal.net'];

describe('relay migration detection', () => {
  it('needs the migration when the card lists a legacy relay', () => {
    expect(needsRelayMigration(OLD)).toBe(true);
    expect(needsRelayMigration([...DEFAULT_RELAYS])).toBe(false);
    for (const legacy of LEGACY_READ_RELAYS) {
      expect(needsRelayMigration([legacy, 'wss://relay.example.org'])).toBe(true);
    }
  });
});

describe('the migrated relay list', () => {
  it('replaces legacy relays with defaults not already present, keeps user extras', () => {
    const extra = 'wss://relay.example.org';
    const next = migratedRelays([...OLD, extra]);
    for (const legacy of LEGACY_READ_RELAYS) expect(next).not.toContain(legacy);
    expect(next).toContain(extra);
    expect(next).toContain('wss://relay.primal.net');
    expect(new Set(next).size).toBe(next.length);
    for (const r of DEFAULT_RELAYS) expect(next).toContain(r);
  });

  it('stays within the own-list bound of 2 to 8 entries (07 §4.3; owner D2, 19 Nov 2026)', () => {
    expect(MAX_OWN_RELAYS).toBe(8);
    const many = Array.from({ length: 15 }, (_, i) => `wss://r${i}.example.org`);
    const next = migratedRelays(['wss://nos.lol', ...many]);
    expect(next).toHaveLength(MAX_OWN_RELAYS);
    expect(next).not.toContain('wss://nos.lol');
    // The owner's own entries come first, in order.
    expect(next).toEqual(many.slice(0, MAX_OWN_RELAYS));
    const some = Array.from({ length: 6 }, (_, i) => `wss://s${i}.example.org`);
    const filled = migratedRelays(['wss://nos.lol', ...some]);
    expect(filled).toHaveLength(MAX_OWN_RELAYS);
    expect(filled.slice(0, 6)).toEqual(some);
    const small = migratedRelays(['wss://nos.lol', 'wss://nostr.mom']);
    expect(small.length).toBeGreaterThanOrEqual(2);
    expect(small.length).toBeLessThanOrEqual(MAX_OWN_RELAYS);
  });

  it('an own list outside 2 to 8 is refused; a contact list keeps the card bound of 16', () => {
    const list = (n: number): string[] =>
      Array.from({ length: n }, (_, i) => `wss://o${i}.example.org`);
    expect(checkOwnRelays(list(8))).toHaveLength(8);
    expect(() => checkOwnRelays(list(9))).toThrow(
      expect.objectContaining({ code: 'relays_invalid' }),
    );
    expect(() => checkOwnRelays(list(1))).toThrow(
      expect.objectContaining({ code: 'relays_invalid' }),
    );
    expect(checkRelays(list(16))).toHaveLength(16);
  });

  it('leaves a list without legacy relays unchanged', () => {
    expect(migratedRelays([...DEFAULT_RELAYS])).toEqual([...DEFAULT_RELAYS]);
  });
});
