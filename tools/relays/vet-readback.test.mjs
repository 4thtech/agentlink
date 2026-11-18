// SEC-RELAY-READBACK (D-156 (7)): the vetting script's read-only availability check, against the
// transport's mock relays (no network). It samples kind-1059 ids without a login, then asks for one
// by id on a fresh connection without a login, retries once, and never publishes or signs in.
import { describe, expect, it } from 'vitest';
import {
  MockNetwork,
  makeWrapEvent,
  relayUrls,
} from '../../packages/transport-nostr/src/testing/mock-network.ts';
import { classifyIdRead, idReadbackCheck } from './vet.mjs';

/** `exchange` of vet.mjs over a mock relay: one new connection per call. */
function mockExchange(net, onCall = () => undefined) {
  let calls = 0;
  return (target, frames, until) =>
    new Promise((resolve) => {
      onCall(calls);
      calls += 1;
      const seen = [];
      let done = false;
      let socket;
      const finish = (note) => {
        if (done) return;
        done = true;
        socket?.close();
        resolve({ seen, note });
      };
      socket = net.open(
        { url: target.url, host: target.host, port: 443, address: '93.184.216.34' },
        {
          onOpen: () => frames.forEach((f) => socket.send(JSON.stringify(f))),
          onMessage: (data) => {
            const f = JSON.parse(data);
            seen.push(f);
            if (until(f)) finish('ok');
          },
          onClose: () => finish('closed'),
        },
      );
      setTimeout(() => finish('timeout'), 50);
    });
}

const target = (url) => ({ ok: true, url, host: url.slice(6), address: '93.184.216.34' });

function relayWithWraps(net, config = {}) {
  const [url] = relayUrls('vet', 1);
  net.configure(url, config);
  for (let i = 0; i < 3; i += 1) net.inject(url, makeWrapEvent({ createdAt: 1_700_000_000 + i }));
  return url;
}

const sentFrames = (net) => net.received.map((r) => JSON.parse(r.frame));

describe('idReadbackCheck (read-only)', () => {
  it('served: samples ids, then reads one by id on a new connection, without a login', async () => {
    const net = new MockNetwork();
    const url = relayWithWraps(net);
    const r = await idReadbackCheck(target(url), mockExchange(net));
    expect(r).toEqual({ sample: 'ok', sampled: 3, idRead: 'served', attempts: 1 });
    expect(net.opens).toHaveLength(2); // the sample and the id read: separate connections
    const reqs = net.reqs(url).map((q) => q.filter);
    expect(reqs[0]).toEqual({ kinds: [1059], limit: 3 });
    expect(Object.keys(reqs[1]).sort()).toEqual(['ids', 'limit']);
    expect(sentFrames(net).every((f) => f[0] === 'REQ')).toBe(true); // no EVENT, no AUTH
  });

  it('empty: a relay that lists wraps but answers an id read without it, after one retry', async () => {
    const net = new MockNetwork();
    const url = relayWithWraps(net, { serveInstead: makeWrapEvent() });
    const r = await idReadbackCheck(target(url), mockExchange(net));
    expect(r).toMatchObject({ sampled: 3, idRead: 'empty', attempts: 2 });
  });

  it('served on the retry', async () => {
    const net = new MockNetwork();
    const url = relayWithWraps(net, { serveInstead: makeWrapEvent() });
    const ex = mockExchange(net, (call) => {
      if (call === 2) net.configure(url, {}); // the second id read
    });
    expect(await idReadbackCheck(target(url), ex)).toMatchObject({
      idRead: 'served',
      attempts: 2,
    });
  });

  it('auth-required for the id read, and never answers the challenge', async () => {
    const net = new MockNetwork();
    const url = relayWithWraps(net);
    const ex = mockExchange(net, (call) => {
      if (call === 1) net.configure(url, { reqNeedsAuth: true });
    });
    expect(await idReadbackCheck(target(url), ex)).toMatchObject({
      idRead: 'auth-required',
      attempts: 2,
    });
    expect(sentFrames(net).some((f) => f[0] === 'AUTH' || f[0] === 'EVENT')).toBe(false);
  });

  it('no sample when even the listing wants a login, or never answers', async () => {
    const net = new MockNetwork();
    const gated = relayWithWraps(net, { reqNeedsAuth: true });
    expect(await idReadbackCheck(target(gated), mockExchange(net))).toEqual({
      sample: 'auth-required',
      sampled: 0,
      idRead: 'no-sample',
      attempts: 0,
    });
    const net2 = new MockNetwork();
    const mute = relayWithWraps(net2, { silentReq: true });
    expect(await idReadbackCheck(target(mute), mockExchange(net2))).toMatchObject({
      sample: 'timeout',
      idRead: 'no-sample',
    });
  });
});

describe('classifyIdRead', () => {
  const id = 'a'.repeat(64);
  it('reads each outcome from the frames', () => {
    expect(classifyIdRead([['EVENT', 's', { id }]], 's', id, 'ok')).toBe('served');
    expect(classifyIdRead([['EOSE', 's']], 's', id, 'ok')).toBe('empty');
    expect(classifyIdRead([['CLOSED', 's', 'auth-required: x']], 's', id, 'ok')).toBe(
      'auth-required',
    );
    expect(classifyIdRead([['CLOSED', 's', 'restricted: x']], 's', id, 'ok')).toBe('auth-required');
    expect(classifyIdRead([['CLOSED', 's', 'error: x']], 's', id, 'ok')).toBe('closed');
    expect(classifyIdRead([['AUTH', 'c']], 's', id, 'timeout')).toBe('auth-required');
    expect(classifyIdRead([], 's', id, 'timeout')).toBe('timeout');
    // Another event, or another subscription's answer, is not evidence.
    expect(
      classifyIdRead(
        [
          ['EVENT', 's', { id: 'b'.repeat(64) }],
          ['EOSE', 's'],
        ],
        's',
        id,
      ),
    ).toBe('empty');
    expect(
      classifyIdRead(
        [
          ['EVENT', 'other', { id }],
          ['EOSE', 's'],
        ],
        's',
        id,
      ),
    ).toBe('empty');
  });
});
