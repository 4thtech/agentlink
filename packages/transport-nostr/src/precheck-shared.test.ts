// RELAY-SHARED-CONN L4 (D-159 (9); 07 §4.2 "Check lane", §4.3 "The test"): with the shared link
// on, the server test's read-back of its throwaway event by id goes through the check lane (never
// the connection that wrote it); a lane that says the server does not keep it is `not_kept`; a lane
// that cannot answer leaves today's fresh read in charge. Mock relays only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRECHECK_SERVER_TIMEOUT_MS, precheckServers, type PrecheckResult } from './precheck.js';
import type { RelayConnector, RelaySocket, RelaySocketHandlers, RelayTarget } from './relay-io.js';
import type { SharedCheckOutcome } from './shared-relay-connector.js';
import { MockNetwork, relayUrls } from './testing/mock-network.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function test(
  net: MockNetwork,
  url: string,
  checkServed: (relay: string, eventId: string) => Promise<SharedCheckOutcome>,
): Promise<PrecheckResult> {
  const pending = precheckServers([url], {
    resolver: net,
    connector: net,
    nip11: net,
    checkServed,
  });
  await vi.advanceTimersByTimeAsync(PRECHECK_SERVER_TIMEOUT_MS + 1_000);
  return (await pending)[0] as PrecheckResult;
}

describe('precheckServers through the check lane', () => {
  it('asks the lane for the written event by its id, after the write', async () => {
    const net = new MockNetwork();
    const [url] = relayUrls('lane', 1) as [string];
    net.configure(url);
    const asked: [string, string][] = [];
    const result = await test(net, url, (relay, id) => {
      asked.push([relay, id]);
      return Promise.resolve('served');
    });
    expect(result.outcome).toBe('ready');
    const written = net.stored.map((s) => s.event.id);
    expect(asked).toEqual([[url, written[0]]]);
  });

  it('a lane answer of missing is not_kept, whatever a later read says', async () => {
    const net = new MockNetwork();
    const [url] = relayUrls('gone', 1) as [string];
    net.configure(url);
    const result = await test(net, url, () => Promise.resolve('missing'));
    expect(result).toMatchObject({ outcome: 'refused', reason: 'not_kept' });
  });

  it('an unusable lane (unavailable) leaves the fresh reads in charge', async () => {
    const net = new MockNetwork();
    const [url] = relayUrls('fallback', 1) as [string];
    net.configure(url);
    const result = await test(net, url, () => Promise.resolve('unavailable'));
    expect(result.outcome).toBe('ready');
  });
});

// RELAY-SHARED-CONN fix round (D-159 build decision 9): the read-back's "fresh connection" is a
// connection of the program's own, never a virtual one on the link that carried the write.
describe('the read-back never rides the connection that wrote', () => {
  function recording(net: MockNetwork): {
    connector: RelayConnector;
    reqsOn: (how: 'open' | 'openOwn') => number;
  } {
    const reqs = { open: 0, openOwn: 0 };
    const wrap =
      (how: 'open' | 'openOwn') =>
      (target: RelayTarget, handlers: RelaySocketHandlers): RelaySocket => {
        const socket = net.open(target, handlers);
        return {
          send: (text) => {
            if (text.startsWith('["REQ"')) reqs[how] += 1;
            socket.send(text);
          },
          close: () => socket.close(),
        };
      };
    return {
      connector: { open: wrap('open'), openOwn: wrap('openOwn') },
      reqsOn: (how) => reqs[how],
    };
  }

  for (const lane of ['unchecked', 'unavailable', 'served'] as const) {
    it(`reads on the program's own connection (lane ${lane})`, async () => {
      const net = new MockNetwork();
      const [url] = relayUrls(`own-${lane}`, 1) as [string];
      net.configure(url);
      const io = recording(net);
      const pending = precheckServers([url], {
        resolver: net,
        connector: io.connector,
        nip11: net,
        checkServed: () => Promise.resolve(lane),
      });
      await vi.advanceTimersByTimeAsync(PRECHECK_SERVER_TIMEOUT_MS + 1_000);
      const result = (await pending)[0] as PrecheckResult;
      expect(result.outcome).toBe('ready');
      expect(io.reqsOn('open')).toBe(0);
      expect(io.reqsOn('openOwn')).toBe(2);
    });
  }
});
