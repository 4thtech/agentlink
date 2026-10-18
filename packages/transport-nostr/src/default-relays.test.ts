// M1-18 (D-75): the default relay set is valid. The single-source scan is
// tools/relays/default-relays.test.mjs (a repository scan needs Node built-ins, which this package
// may not import).
import { MAX_RELAYS, MIN_RELAYS, isAllowedRelayUrl, relayListSchema } from '@4thtech-io/types';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RELAYS } from './default-relays.js';
import { DEFAULT_RELAYS as FROM_INDEX } from './index.js';
import { isGloballyRoutable } from './relay-address.js';

describe('DEFAULT_RELAYS (D-75)', () => {
  it('is the exported list and holds the four public relays of D-75', () => {
    expect(FROM_INDEX).toBe(DEFAULT_RELAYS);
    expect([...DEFAULT_RELAYS]).toEqual([
      'wss://nos.lol',
      'wss://relay.primal.net',
      'wss://relay.snort.social',
      'wss://nostr.mom',
    ]);
  });

  it('holds 2 to 16 unique entries and passes the card relay list schema', () => {
    expect(DEFAULT_RELAYS.length).toBeGreaterThanOrEqual(MIN_RELAYS);
    expect(DEFAULT_RELAYS.length).toBeLessThanOrEqual(MAX_RELAYS);
    expect(new Set(DEFAULT_RELAYS).size).toBe(DEFAULT_RELAYS.length);
    expect(relayListSchema.safeParse([...DEFAULT_RELAYS]).success).toBe(true);
  });

  it.each([...DEFAULT_RELAYS])('%s is wss only and passes the relay URL rule (04 §4)', (url) => {
    expect(url.startsWith('wss://')).toBe(true);
    expect(isAllowedRelayUrl(url)).toBe(true);
    // A literal address is never a default; the pool resolves names and checks every answer.
    expect(isGloballyRoutable(url.slice('wss://'.length))).toBe(false);
  });

  it('is frozen, so a caller cannot change the shared list', () => {
    expect(Object.isFrozen(DEFAULT_RELAYS)).toBe(true);
  });
});
