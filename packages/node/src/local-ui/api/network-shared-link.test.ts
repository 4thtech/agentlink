// RELAY-SHARED-CONN L4 (08 §1 "What the owner sees"; 11 §5.15; I-7): `GET /api/ui/network` and the
// server test answer add `sharedLink: {on, programs}`: a boolean and a count only, never a
// program's name, ID or path; anything else from the source is not passed on.
import type { JsonObject } from '@4thtech-io/crypto';
import type { HostResolver, RelayConnector } from '@4thtech-io/transport-nostr';
import { describe, expect, it } from 'vitest';
import type { LocalUiContext } from '../context.js';
import { NETWORK_NEEDS_SETUP, NETWORK_NOT_RUNNING, networkBody } from './network.js';
import { PrecheckBudget, createNetworkTestRoute } from './network-test.js';

const NOW = 1_800_000_000_000;
const base = { agent: 'running' as const, servers: [] };

describe('GET /api/ui/network: sharedLink', () => {
  it('answers on and the count', () => {
    const body = networkBody({ ...base, sharedLink: { on: true, programs: 3 } }, NOW, false);
    expect(body.sharedLink).toEqual({ on: true, programs: 3 });
  });

  it('answers off with 0 when the source says off, nothing or garbage', () => {
    expect(networkBody(base, NOW, false).sharedLink).toEqual({ on: false, programs: 0 });
    expect(
      networkBody({ ...base, sharedLink: { on: false, programs: 7 } }, NOW, false).sharedLink,
    ).toEqual({ on: false, programs: 0 });
    const odd = { on: 'yes', programs: '/home/someone', name: 'Claude' } as unknown;
    expect(
      networkBody({ ...base, sharedLink: odd as { on: boolean; programs: number } }, NOW, false)
        .sharedLink,
    ).toEqual({ on: false, programs: 0 });
    expect(NETWORK_NEEDS_SETUP.sharedLink).toEqual({ on: false, programs: 0 });
    expect(NETWORK_NOT_RUNNING.sharedLink).toEqual({ on: false, programs: 0 });
  });

  it('a count that is not a small whole number is answered as 0; only the two keys', () => {
    for (const programs of [-1, 1.5, Number.NaN, 1e12]) {
      const body = networkBody({ ...base, sharedLink: { on: true, programs } }, NOW, false);
      expect(body.sharedLink).toEqual({ on: true, programs: 0 });
    }
    const extra = { on: true, programs: 2, path: '/tmp/relay.sock' } as unknown;
    const body = networkBody(
      { ...base, sharedLink: extra as { on: boolean; programs: number } },
      NOW,
      false,
    );
    expect(Object.keys(body.sharedLink).sort()).toEqual(['on', 'programs']);
  });
});

describe('POST /api/ui/network/test: sharedLink beside the results', () => {
  const resolver: HostResolver = { resolve: () => Promise.resolve([]) };
  const connector: RelayConnector = {
    open: () => {
      throw new Error('no connection expected');
    },
  };
  const context = {} as LocalUiContext;

  it('reports the shared state the io gives, and off without one', async () => {
    const on = createNetworkTestRoute(
      () => ({
        resolver,
        connector,
        sharedLink: () => Promise.resolve({ on: true, programs: 2 }),
      }),
      new PrecheckBudget(),
    );
    const answer = await on.handler(context, { servers: ['wss://localhost'] } as JsonObject);
    expect(answer.status).toBe(200);
    expect((answer.body as { sharedLink: unknown }).sharedLink).toEqual({ on: true, programs: 2 });
    const off = createNetworkTestRoute(() => ({ resolver, connector }), new PrecheckBudget());
    const plain = await off.handler(context, { servers: ['wss://localhost'] } as JsonObject);
    expect((plain.body as { sharedLink: unknown }).sharedLink).toEqual({ on: false, programs: 0 });
  });
});
