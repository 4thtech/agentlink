// RELAY-SHARED-CONN L4 (D-159 (9); D-156 (7) as amended; 07 §4.2 "Check lane"): the RelayPool's
// availability check goes through the shared link's check lane when its connector offers one, and
// never through the publishing upstream; without a usable shared link it keeps today's fresh,
// login-free connection of its own. Mock relays and an in-memory channel only.
import { randomBytes } from '@4thtech-io/crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelayPool } from './relay-pool.js';
import { SharedLinkMux } from './shared-link-mux.js';
import { FallbackConnector, SharedRelayConnector } from './shared-relay-connector.js';
import { MockNetwork, makeWrapEvent, relayUrls } from './testing/mock-network.js';
import { memoryDialer } from './testing/shared-link-memory.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const CLI = '0.5.18';

function setup() {
  const net = new MockNetwork();
  const direct = new MockNetwork();
  const token = randomBytes(32);
  const mux = new SharedLinkMux({
    connector: net,
    addressCheck: { resolver: net },
    token,
    cliVersion: CLI,
  });
  const { dial } = memoryDialer(mux);
  const program = (t: Uint8Array = token): RelayPool =>
    new RelayPool({
      connector: new FallbackConnector(
        new SharedRelayConnector({ dial, token: t, cliVersion: CLI }),
        direct,
      ),
      addressCheck: { resolver: net },
    });
  return { net, direct, program };
}

/** The REQs a relay got that ask for event ids (availability checks), with their sub ids. */
const idReads = (net: MockNetwork, relay: string): { subId: string; ids: string[] }[] =>
  net
    .reqs(relay)
    .filter((r) => Array.isArray(r.filter.ids))
    .map((r) => ({ subId: r.subId, ids: [...(r.filter.ids ?? [])].sort() }));

describe('RelayPool.checkServed with the shared link on', () => {
  it('goes through the check lane, never the publishing upstream', async () => {
    const { net, direct, program } = setup();
    const [relay] = relayUrls('lane', 1) as [string];
    net.configure(relay);
    const pool = program();
    const event = makeWrapEvent();
    expect((await pool.publish(event, [relay])).acked).toEqual([relay]);
    expect(await pool.checkServed(relay, event.id)).toBe('served');
    const reads = idReads(net, relay);
    expect(reads).toHaveLength(1);
    // The check lane's own sub id (`k<n>`), never a virtual link's rewritten one (`c<n>:…`), so
    // the read did not ride the connection that published.
    expect(reads[0]?.subId.startsWith('k')).toBe(true);
    const publishing = net.sockets[0];
    expect([...(publishing?.subs.keys() ?? [])].some((s) => s.startsWith('c'))).toBe(false);
    // Nothing went out on the program's own connections.
    expect(direct.opens).toHaveLength(0);
    pool.close();
  });

  it("batches only one program's ids into one read", async () => {
    const { net, program } = setup();
    const [relay] = relayUrls('per-program', 1) as [string];
    net.configure(relay);
    const [e1, e2, e3] = [makeWrapEvent(), makeWrapEvent(), makeWrapEvent()];
    for (const e of [e1, e2, e3]) net.inject(relay, e);
    const a = program();
    const b = program();
    const outcomes = await Promise.all([
      a.checkServed(relay, e1.id),
      b.checkServed(relay, e3.id),
      a.checkServed(relay, e2.id),
    ]);
    expect(outcomes).toEqual(['served', 'served', 'served']);
    const reads = idReads(net, relay).map((r) => r.ids);
    expect(reads).toHaveLength(2);
    expect(reads).toContainEqual([e1.id, e2.id].sort());
    expect(reads).toContainEqual([e3.id]);
    a.close();
    b.close();
  });

  it('without a usable shared link: a fresh login-free connection of its own, as before', async () => {
    const { net, direct, program } = setup();
    const [relay] = relayUrls('own', 1) as [string];
    net.configure(relay);
    direct.configure(relay);
    const event = makeWrapEvent();
    direct.inject(relay, event);
    const pool = program(randomBytes(32)); // a wrong token: the shared link refuses it
    expect(await pool.checkServed(relay, event.id)).toBe('served');
    expect(direct.reqs(relay).map((r) => r.filter)).toEqual([{ ids: [event.id], limit: 1 }]);
    expect(idReads(net, relay)).toHaveLength(0);
    expect(direct.received.some((f) => f.frame.startsWith('["AUTH"'))).toBe(false);
    pool.close();
  });
});
