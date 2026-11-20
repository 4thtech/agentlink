// NET-PRECHECK (04 §4; 07 §4.3 "Use your own servers"): the server Test publishes one tiny kind 1059
// event signed by a throwaway key, created, used and wiped inside this package, never an ID key.
import { describe, expect, it } from 'vitest';
import * as main from './index.js';
import { createThrowawayEvent } from './throwaway-event.js';
import { NOSTR_KIND_AUTH, NOSTR_KIND_GIFT_WRAP, verifyNostrEvent } from './nostr-event.js';
import { CryptoInputError } from './errors.js';

describe('createThrowawayEvent (NET-PRECHECK)', () => {
  it('signs a kind 1059 event with a fresh key it hands to the builder as a public key only', () => {
    const seen: string[] = [];
    const event = createThrowawayEvent((pubkey) => {
      seen.push(pubkey);
      return { kind: NOSTR_KIND_GIFT_WRAP, created_at: 1_760_000_000, tags: [['p', pubkey]], content: 'x' };
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(event.pubkey).toBe(seen[0]);
    expect(event.tags).toEqual([['p', seen[0]]]);
    expect(verifyNostrEvent(event)).toBe(true);
    expect(Object.isFrozen(event)).toBe(true);
  });

  it('uses a new key every time', () => {
    const build = (pubkey: string) => ({
      kind: NOSTR_KIND_GIFT_WRAP,
      created_at: 1,
      tags: [['p', pubkey]],
      content: '',
    });
    const keys = new Set(Array.from({ length: 5 }, () => createThrowawayEvent(build).pubkey));
    expect(keys.size).toBe(5);
  });

  it('signs nothing but a kind 1059 event (never an AUTH, never a card or seal)', () => {
    for (const kind of [NOSTR_KIND_AUTH, 13, 14, 0, 1]) {
      expect(() =>
        createThrowawayEvent(() => ({ kind, created_at: 1, tags: [], content: '' })),
      ).toThrow(CryptoInputError);
    }
  });

  it('is in the main entry (it takes no secret)', () => {
    expect(Object.keys(main)).toContain('createThrowawayEvent');
  });
});
