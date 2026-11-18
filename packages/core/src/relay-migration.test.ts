// RELAY-CARD-MIGRATION (S2; 04 §2.6, 07 §4.3): detection and the migrated relay list.
import { DEFAULT_RELAYS, LEGACY_READ_RELAYS } from '@4thtech-io/transport-nostr';
import { describe, expect, it } from 'vitest';
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

  it('stays within 2 to 16 entries', () => {
    const many = Array.from({ length: 15 }, (_, i) => `wss://r${i}.example.org`);
    const next = migratedRelays(['wss://nos.lol', ...many]);
    expect(next.length).toBeLessThanOrEqual(16);
    expect(next).not.toContain('wss://nos.lol');
    for (const r of many) expect(next).toContain(r);
    const small = migratedRelays(['wss://nos.lol', 'wss://nostr.mom']);
    expect(small.length).toBeGreaterThanOrEqual(2);
  });

  it('leaves a list without legacy relays unchanged', () => {
    expect(migratedRelays([...DEFAULT_RELAYS])).toEqual([...DEFAULT_RELAYS]);
  });
});
