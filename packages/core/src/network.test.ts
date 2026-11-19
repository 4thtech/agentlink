// NET-ROUTE / NET-PROBE (07 §4.3; 08 §1 Message network): the core side of the Message network
// view. Pure parts: which servers the view lists and in which role, whether the own list is the
// automatic set, and how many of a contact's servers we share (by origin, never by path).
import { DEFAULT_RELAYS, LEGACY_READ_RELAYS } from '@4thtech-io/transport-nostr';
import { describe, expect, it } from 'vitest';
import { NetworkService, networkMode, networkServerList, sharedServerCount } from './network.js';

describe('the Message network server list', () => {
  it('lists the own servers, then the legacy read-only ones not already own, once each', () => {
    const own = ['wss://relay.primal.net', 'wss://a.example.org/path'];
    const list = networkServerList(own, LEGACY_READ_RELAYS);
    expect(list.map((s) => s.kind)).toEqual(['own', 'own', 'legacy', 'legacy']);
    expect(list.map((s) => s.relay)).toEqual([...own, ...LEGACY_READ_RELAYS]);
    const overlap = networkServerList(
      [LEGACY_READ_RELAYS[0] as string, own[0] as string],
      LEGACY_READ_RELAYS,
    );
    expect(overlap.filter((s) => s.relay === LEGACY_READ_RELAYS[0])).toHaveLength(1);
    expect(overlap[0]?.kind).toBe('own');
  });

  it('is automatic while every own server is a default one', () => {
    expect(networkMode([...DEFAULT_RELAYS])).toBe('automatic');
    expect(networkMode([DEFAULT_RELAYS[0] as string, DEFAULT_RELAYS[1] as string])).toBe(
      'automatic',
    );
    expect(networkMode([DEFAULT_RELAYS[0] as string, 'wss://mine.example.org'])).toBe('custom');
  });

  it('counts shared servers by origin', () => {
    const own = ['wss://relay.primal.net', 'wss://a.example.org/x'];
    expect(sharedServerCount(own, ['wss://relay.primal.net/', 'wss://a.example.org/y'])).toBe(2);
    expect(sharedServerCount(own, ['wss://b.example.org'])).toBe(0);
    expect(sharedServerCount(own, ['wss://relay.primal.net', 'wss://relay.primal.net/z'])).toBe(1);
  });
});

describe('contactReach (one pass: reach and per-server counts)', () => {
  it('counts contacts per own and legacy server origin, each contact once, and nothing else', async () => {
    const own = ['wss://relay.primal.net', 'wss://a.example.org/x'];
    const lists: Record<string, string[]> = {
      c1: ['wss://relay.primal.net', 'wss://relay.primal.net/z', 'wss://other.example.net'],
      c2: ['wss://a.example.org', LEGACY_READ_RELAYS[0] as string],
      c3: ['wss://other.example.net'],
      c4: ['wss://relay.primal.net'],
    };
    let reads = 0;
    const service = new NetworkService(
      {} as never,
      { relays: () => Promise.resolve(own) } as never,
      {
        list: () =>
          Promise.resolve(
            [...Object.keys(lists), 'gone'].map((id) => ({
              id,
              status: id === 'c4' ? 'blocked' : 'active',
            })),
          ),
      } as never,
      {
        contactPeer: (id: string) => {
          reads += 1;
          const relays = lists[id];
          return relays === undefined
            ? Promise.reject(new Error('unreadable'))
            : Promise.resolve({ relays });
        },
      } as never,
    );
    const reach = await service.contactReach({ lists: false });
    expect(reach.total).toBe(4); // c1, c2, c3 and the unreadable one are active
    expect(reach.sharing).toBe(2);
    expect(reach.perServer).toEqual({
      'wss://relay.primal.net': 1,
      'wss://a.example.org': 1,
      [LEGACY_READ_RELAYS[0] as string]: 1,
      [LEGACY_READ_RELAYS[1] as string]: 0,
    });
    expect(Object.keys(reach.perServer)).not.toContain('wss://other.example.net');
    expect(reads).toBe(4); // one list read per active contact
    expect(reach).not.toHaveProperty('lists');
  });
});
