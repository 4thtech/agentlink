// E2E-HOSTILE, your own servers (04 §4 "Servers the owner types"; 07 §4.2, §4.3 "The test" and
// "Leaving servers stay readable for 30 days"; 08 §1 `POST /api/ui/network/test`; I-5, I-7;
// D-158 (4), (5)).
//
// Part 1, the server Test: the real route (createNetworkTestRoute) over the real Node relay
// connector and NIP-11 fetcher, against local TLS stand-in servers on 127.0.0.1 with a throwaway
// certificate and a stub resolver. A misbehaving server or answer gets the fixed outcome of 07 §4.3,
// no server text reaches the answer, and the test never signs with an ID key or answers a login
// request (AUTH).
//
// Part 2, the 30-day overlap: real cores on the in-memory relay network. A server that leaves the
// own list stays readable for 30 days after the change that dropped it, each to its own end, and
// a change that would keep more than 16 of them is refused with the date it fits.
//
// No Docker, no keychain, no real server and no real DNS.
import { verifyNostrEvent, type JsonObject, type NostrEvent } from '@4thtech-io/crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createNetworkTestRoute,
  type NetworkTestIo,
} from '../../packages/node/dist/local-ui/api/network-test.js';
import {
  createNip11FetcherWith,
  createRelayConnectorWith,
} from '../../packages/node/dist/relay-io.js';
import {
  makeTestCertificate,
  startTestRelay,
  type TestCertificate,
  type TestRelay,
  type TestRelayOptions,
} from '../../packages/node/src/relay-io.fixture.js';
import { presence } from '../prompt-injection/harness.js';
import { scene, type Scene } from './support.js';

// ---- part 1: the server Test -------------------------------------------------------------------

const HOST = 'relay-a.nostr-test.dev';
const HOST_2 = 'relay-b.nostr-test.dev';
const PUBLIC_A = '93.184.215.21';
const PUBLIC_B = '93.184.215.22';
const BIG_DOC_BYTES = 200_000;

type Result = {
  host: string | null;
  outcome: string;
  reason: string | null;
  roundTripMs: number | null;
  signInRequired: boolean | null;
  paymentRequired: boolean | null;
};

let certificate: TestCertificate;
const relays: TestRelay[] = [];

beforeAll(() => {
  certificate = makeTestCertificate([HOST, HOST_2]);
}, 60_000);

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});

/** What a stand-in server was sent, by frame. */
interface Heard {
  readonly frames: unknown[][];
}

interface Behaviour {
  /** Sends a login request (AUTH) as soon as a client connects. */
  challenge?: boolean;
  /** Answers every EVENT with OK false and this text. */
  refuse?: string;
  /** Answers OK true to an EVENT but keeps nothing. */
  dropEvents?: boolean;
  /** Wants a login to read: answers REQ with CLOSED auth-required. */
  readNeedsLogin?: boolean;
  /** Delay of the OK, milliseconds. */
  okDelayMs?: number;
}

/** A minimal Nostr server that keeps events in memory, with the given misbehaviour. */
async function standIn(
  behaviour: Behaviour = {},
  extra: Pick<TestRelayOptions, 'http'> = {},
): Promise<{ relay: TestRelay; heard: Heard }> {
  const kept: NostrEvent[] = [];
  const heard: Heard = { frames: [] };
  const relay = await startTestRelay(certificate, {
    ...extra,
    onSocket: (ws) => {
      if (behaviour.challenge === true) ws.send(JSON.stringify(['AUTH', 'challenge-1']));
      ws.on('message', (data: Buffer) => {
        let frame: unknown;
        try {
          frame = JSON.parse(data.toString('utf8'));
        } catch {
          return;
        }
        if (!Array.isArray(frame)) return;
        heard.frames.push(frame);
        if (frame[0] === 'EVENT') {
          const event = frame[1] as NostrEvent;
          const answer = (ok: boolean, text: string): void => {
            const send = (): void => ws.send(JSON.stringify(['OK', event.id, ok, text]));
            if (behaviour.okDelayMs === undefined) send();
            else setTimeout(send, behaviour.okDelayMs);
          };
          if (behaviour.refuse !== undefined) return answer(false, behaviour.refuse);
          if (behaviour.dropEvents !== true) kept.push(event);
          answer(true, '');
        } else if (frame[0] === 'REQ') {
          const subId = frame[1] as string;
          if (behaviour.readNeedsLogin === true) {
            ws.send(JSON.stringify(['CLOSED', subId, 'auth-required: sign in to read']));
            return;
          }
          const filter = frame[2] as { ids?: string[]; kinds?: number[]; '#p'?: string[] };
          for (const e of kept) {
            const byId = filter.ids?.includes(e.id) === true;
            const bySync =
              filter.ids === undefined &&
              filter.kinds?.includes(e.kind) === true &&
              e.tags.some((t) => t[0] === 'p' && filter['#p']?.includes(t[1] as string) === true);
            if (byId || bySync) ws.send(JSON.stringify(['EVENT', subId, e]));
          }
          ws.send(JSON.stringify(['EOSE', subId]));
        }
      });
    },
  });
  relays.push(relay);
  return { relay, heard };
}

interface Stage {
  readonly io: NetworkTestIo;
  readonly resolves: string[];
  readonly dialed: string[];
}

/** A stub resolver (one answer set per call, the last one repeating) and local routing. */
function stage(
  dns: Record<string, readonly (readonly string[])[]>,
  ports: Record<string, number>,
): Stage {
  const resolves: string[] = [];
  const dialed: string[] = [];
  const route = (address: string, port: number) => {
    dialed.push(address);
    return { address: '127.0.0.1', port: ports[address] ?? (port === 443 ? 1 : port) };
  };
  return {
    io: {
      resolver: {
        resolve(host: string) {
          resolves.push(host);
          const answers = dns[host];
          if (answers === undefined) return Promise.reject(new Error('not found'));
          const count = resolves.filter((h) => h === host).length;
          return Promise.resolve(answers[Math.min(count, answers.length) - 1] ?? []);
        },
      },
      connector: createRelayConnectorWith({ ca: certificate.cert, route }),
      nip11: createNip11FetcherWith({ ca: certificate.cert, route }),
    },
    resolves,
    dialed,
  };
}

/** The route reads nothing from its context (no key, no store, no owner presence). */
const context = {} as never;

async function askServers(
  io: NetworkTestIo,
  servers: readonly string[],
): Promise<{ status: number; results: Result[]; text: string }> {
  const res = await createNetworkTestRoute(() => io).handler(context, {
    servers: [...servers],
  } as unknown as JsonObject);
  const body = res.body as { results?: Result[] };
  return { status: res.status, results: body.results ?? [], text: JSON.stringify(res.body) };
}

/** The test event(s) a stand-in server was sent: one tiny throwaway-signed kind 1059 wrap. */
function expectOnlyThrowawayEvents(heard: Heard): void {
  expect(heard.frames.filter((f) => f[0] === 'AUTH')).toHaveLength(0);
  const events = heard.frames.filter((f) => f[0] === 'EVENT').map((f) => f[1] as NostrEvent);
  expect(events.length).toBeLessThanOrEqual(1);
  for (const event of events) {
    expect(event.kind).toBe(1059);
    expect(verifyNostrEvent(event)).toBe(true);
    expect(event.content.length).toBeLessThanOrEqual(64);
  }
}

describe('the server Test refuses a hostile name or address', () => {
  it('a name whose DNS answers include a private address is not allowed: nothing is dialed', async () => {
    const { relay } = await standIn();
    const w = stage(
      { [HOST]: [[PUBLIC_A, '10.1.2.3']], [HOST_2]: [['2606:4700::1111', '192.168.0.9']] },
      { [PUBLIC_A]: relay.port },
    );
    const { status, results, text } = await askServers(w.io, [`wss://${HOST}`, `wss://${HOST_2}`]);
    expect(status).toBe(200);
    expect(results.map((r) => [r.outcome, r.reason])).toEqual([
      ['refused', 'not_allowed'],
      ['refused', 'not_allowed'],
    ]);
    expect(text).not.toMatch(/10\.1\.2\.3|192\.168/);
    expect(w.dialed).toHaveLength(0);
    expect(relay.seen).toHaveLength(0);
  }, 30_000);

  it('DNS rebinding between the check and the connect: one lookup, every dial goes to the checked address', async () => {
    const { relay, heard } = await standIn();
    const w = stage({ [HOST]: [[PUBLIC_A], ['127.0.0.1']] }, { [PUBLIC_A]: relay.port });
    const { results } = await askServers(w.io, [`wss://${HOST}`]);
    expect(results[0]).toMatchObject({ outcome: 'ready', reason: null });
    expect(w.resolves).toEqual([HOST]);
    expect(w.dialed.length).toBeGreaterThanOrEqual(2);
    expect(w.dialed.every((a) => a === PUBLIC_A)).toBe(true);
    expectOnlyThrowawayEvents(heard);
  }, 30_000);

  it('a metadata address in the answer is not allowed, IPv4 or IPv6, and nothing is dialed', async () => {
    const w = stage(
      {
        [HOST]: [['169.254.169.254']],
        [HOST_2]: [['fd00:ec2::254']],
        'relay-c.nostr-test.dev': [['::ffff:169.254.169.254']],
      },
      {},
    );
    const { results, text } = await askServers(w.io, [
      `wss://${HOST}`,
      `wss://${HOST_2}`,
      'wss://relay-c.nostr-test.dev',
    ]);
    expect(results.map((r) => [r.outcome, r.reason])).toEqual([
      ['refused', 'not_allowed'],
      ['refused', 'not_allowed'],
      ['refused', 'not_allowed'],
    ]);
    expect(text).not.toMatch(/169\.254|fd00/);
    expect(w.dialed).toHaveLength(0);
  }, 30_000);

  it('an IP literal and ws:// are not allowed before any lookup, with no host shown', async () => {
    const w = stage({}, {});
    const { results } = await askServers(w.io, [
      'wss://93.184.216.34',
      'wss://[2606:4700::1111]',
      'wss://127.1',
      'ws://relay-a.nostr-test.dev',
      'ws://93.184.216.34',
    ]);
    expect(results.every((r) => r.outcome === 'refused' && r.reason === 'not_allowed')).toBe(true);
    expect(results.every((r) => r.host === null)).toBe(true);
    expect(w.resolves).toHaveLength(0);
    expect(w.dialed).toHaveLength(0);
  }, 30_000);
});

describe('the server Test bounds what a server sends back', () => {
  it('a server that redirects the NIP-11 document is not followed, and does not decide the outcome', async () => {
    const { relay, heard } = await standIn(
      {},
      {
        http: (_req, res) => {
          res.writeHead(302, { Location: 'https://169.254.169.254/latest/meta-data/' }).end();
        },
      },
    );
    const w = stage({ [HOST]: [[PUBLIC_A]] }, { [PUBLIC_A]: relay.port });
    const { results } = await askServers(w.io, [`wss://${HOST}`]);
    expect(results[0]).toMatchObject({ outcome: 'ready', reason: null });
    expect(relay.seen.filter((s) => s.kind === 'http')).toHaveLength(1);
    expect(w.dialed.every((a) => a === PUBLIC_A)).toBe(true);
    expectOnlyThrowawayEvents(heard);
  }, 30_000);

  it('a huge or a slow NIP-11 document is ignored: the test still ends ready, within its bound, and never echoes it', async () => {
    const huge = await standIn(
      {},
      {
        http: (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/nostr+json' }).end(
            JSON.stringify({
              name: 'x'.repeat(BIG_DOC_BYTES),
              limitation: { auth_required: true, max_message_length: 1 },
            }),
          );
        },
      },
    );
    const slow = await standIn(
      {},
      {
        http: (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/nostr+json' });
          res.write('{"name":"');
          // Never finished: the document only drips, and the test must not wait for it.
        },
      },
    );
    const w = stage(
      { [HOST]: [[PUBLIC_A]], [HOST_2]: [[PUBLIC_B]] },
      { [PUBLIC_A]: huge.relay.port, [PUBLIC_B]: slow.relay.port },
    );
    const started = Date.now();
    const { results, text } = await askServers(w.io, [`wss://${HOST}`, `wss://${HOST_2}`]);
    expect(results.map((r) => [r.outcome, r.reason])).toEqual([
      ['ready', null],
      ['ready', null],
    ]);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(text).not.toContain('xxxx');
    expectOnlyThrowawayEvents(huge.heard);
    expectOnlyThrowawayEvents(slow.heard);
  }, 30_000);
});

describe('the server Test classifies a misbehaving server with a fixed outcome', () => {
  it('a server that demands a login to write is refused, and the login request is never answered', async () => {
    const { relay, heard } = await standIn({
      challenge: true,
      refuse: 'auth-required: sign in please',
    });
    const w = stage({ [HOST]: [[PUBLIC_A]] }, { [PUBLIC_A]: relay.port });
    const { results, text } = await askServers(w.io, [`wss://${HOST}`]);
    expect(results[0]).toMatchObject({ outcome: 'refused', reason: 'not_accepted' });
    expect(text).not.toContain('sign in please');
    expectOnlyThrowawayEvents(heard);
  }, 30_000);

  it('a server that demands a login only to read needs sign-in, and the login request is never answered', async () => {
    const { relay, heard } = await standIn({ challenge: true, readNeedsLogin: true });
    const w = stage({ [HOST]: [[PUBLIC_A]] }, { [PUBLIC_A]: relay.port });
    const { results, text } = await askServers(w.io, [`wss://${HOST}`]);
    expect(results[0]).toMatchObject({
      outcome: 'sign_in',
      reason: null,
      signInRequired: true,
    });
    expect(text).not.toContain('sign in to read');
    expectOnlyThrowawayEvents(heard);
  }, 30_000);

  it('a server that says OK and silently drops the event is refused: not kept', async () => {
    const { relay, heard } = await standIn({ dropEvents: true });
    const w = stage({ [HOST]: [[PUBLIC_A]] }, { [PUBLIC_A]: relay.port });
    const { results } = await askServers(w.io, [`wss://${HOST}`]);
    expect(results[0]).toMatchObject({ outcome: 'refused', reason: 'not_kept' });
    expectOnlyThrowawayEvents(heard);
  }, 30_000);

  it('a server that answers after one second is slow, and still usable', async () => {
    const { relay, heard } = await standIn({ okDelayMs: 1_300 });
    const w = stage({ [HOST]: [[PUBLIC_A]] }, { [PUBLIC_A]: relay.port });
    const { results } = await askServers(w.io, [`wss://${HOST}`]);
    expect(results[0]).toMatchObject({ outcome: 'slow', reason: null });
    expect(results[0]?.roundTripMs).toBeGreaterThanOrEqual(1_000);
    expectOnlyThrowawayEvents(heard);
  }, 30_000);

  it('after ten tests in a minute the next one is busy, and nothing is looked up for it', async () => {
    const w = stage({}, {});
    const route = createNetworkTestRoute(() => w.io);
    const body = { servers: ['ws://plain.nostr-test.dev'] } as unknown as JsonObject;
    for (let i = 0; i < 10; i += 1) {
      expect((await route.handler(context, body)).status).toBe(200);
    }
    const busy = await route.handler(context, body);
    expect(busy).toEqual({ status: 429, body: { error: 'busy' } });
    expect(w.resolves).toHaveLength(0);
    expect(w.dialed).toHaveLength(0);
  }, 30_000);
});

// ---- part 2: the 30-day overlap ----------------------------------------------------------------

const DAY = 86_400;
const LEAVING_DAYS = 30;
const list = (tag: string): string[] => [`wss://one.${tag}.net`, `wss://two.${tag}.net`];
const OLD = ['wss://one.relay-beta.net', 'wss://two.relay-beta.net'];

let current: Scene | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function changeList(s: Scene, relays: readonly string[]): Promise<void> {
  const session = await s.ana.memoryOwner.unlock(presence());
  try {
    await s.ana.client.identity.rotate({
      owner: session,
      ownerKeys: await s.ana.memoryOwner.getPublicKeys(),
      epochControl: s.ana.memoryOwner.epochControl(s.ana.keys),
      relays,
    });
  } finally {
    await session.close();
  }
}

/** The servers the victim's next read of the inbox asks: the own list, the leaving and the legacy ones. */
async function readSet(s: Scene): Promise<string[]> {
  s.net.reads.length = 0;
  await s.ana.client.syncInbox();
  return [...new Set(s.net.reads)];
}

describe('a server that left the own list stays readable for 30 days', () => {
  it('a contact that still publishes to an old server on day 29 is received', async () => {
    const s = (current = await scene());
    await changeList(s, list('relay-gamma'));
    // The contact has not seen the new card: it still publishes to the old servers.
    s.advance(29 * DAY);
    const sent = await s.mallory.call('agentlink_send', {
      to: 'Ana',
      text: 'still on the old server, day 29',
    });
    expect(sent.structured['status']).toBe('ok');
    expect(OLD.some((url) => (s.net.stored.get(url) ?? []).length > 0)).toBe(true);
    await s.ana.client.syncInbox();
    const inbox = await s.ana.call('agentlink_inbox', {});
    expect(inbox.text).toContain('still on the old server, day 29');
  });

  it('after the end the old server is not read any more: a message still published there is not received', async () => {
    const s = (current = await scene());
    await changeList(s, list('relay-gamma'));
    s.advance((LEAVING_DAYS + 1) * DAY);
    await s.mallory.call('agentlink_send', { to: 'Ana', text: 'too late, day 31' });
    expect(OLD.some((url) => (s.net.stored.get(url) ?? []).length > 0)).toBe(true);
    const read = await readSet(s);
    for (const url of OLD) expect(read).not.toContain(url);
    for (const url of list('relay-gamma')) expect(read).toContain(url);
    const inbox = await s.ana.call('agentlink_inbox', {});
    expect(inbox.text).not.toContain('too late, day 31');
  });

  it('three changes within 30 days keep each leaving server readable until its own end', async () => {
    const s = (current = await scene());
    const [one, two, three] = [list('relay-one'), list('relay-two'), list('relay-three')];
    const t0 = s.world.clock();
    await changeList(s, one);
    s.advance(10 * DAY);
    await changeList(s, two);
    s.advance(10 * DAY);
    await changeList(s, three);
    // Each server has the end of the change that dropped it.
    const ends = new Map(
      (await s.ana.client.identity.leavingServers()).map((e) => [e.url, e.until - t0]),
    );
    for (const url of OLD) expect(ends.get(url)).toBeLessThanOrEqual(LEAVING_DAYS * DAY + 5);
    for (const url of one) {
      expect(ends.get(url)).toBeGreaterThanOrEqual(40 * DAY);
      expect(ends.get(url)).toBeLessThanOrEqual(40 * DAY + 5);
    }
    for (const url of two) {
      expect(ends.get(url)).toBeGreaterThanOrEqual(50 * DAY);
      expect(ends.get(url)).toBeLessThanOrEqual(50 * DAY + 5);
    }
    // Day 20 to 30: all of them are read. Day 35: the first ones have ended, the others have not.
    s.advance(5 * DAY);
    const day25 = await readSet(s);
    for (const url of [...OLD, ...one, ...two, ...three]) expect(day25).toContain(url);
    s.advance(10 * DAY);
    const day35 = await readSet(s);
    for (const url of OLD) expect(day35).not.toContain(url);
    for (const url of [...one, ...two, ...three]) expect(day35).toContain(url);
    s.advance(10 * DAY);
    const day45 = await readSet(s);
    for (const url of [...OLD, ...one]) expect(day45).not.toContain(url);
    for (const url of [...two, ...three]) expect(day45).toContain(url);
  });

  it('a change that would keep more than 16 leaving servers is refused with the date it fits', async () => {
    const s = (current = await scene());
    const eight = (tag: string): string[] =>
      Array.from({ length: 8 }, (_, i) => `wss://r${i + 1}.${tag}.net`);
    const t0 = s.world.clock();
    await changeList(s, eight('relay-delta'));
    s.advance(5 * DAY);
    await changeList(s, eight('relay-epsilon'));
    s.advance(DAY);
    const before = await s.ana.client.identity.leavingServers();
    expect(before).toHaveLength(10);
    // Two old servers (from the first change) plus eight, and eight more would make 18.
    const outcome = await changeList(s, eight('relay-zeta')).then(
      () => undefined,
      (error: unknown) => error as { code?: string; fitsAt?: number },
    );
    expect(outcome?.code).toBe('too_many_previous');
    expect(Math.abs((outcome?.fitsAt ?? 0) - (t0 + LEAVING_DAYS * DAY))).toBeLessThanOrEqual(5);
    // Refused before anything was signed: the list and the leaving servers are as they were.
    expect(await s.ana.client.identity.relays()).toEqual(eight('relay-epsilon'));
    expect(await s.ana.client.identity.leavingServers()).toEqual(before);
    // From the date it fits, the same change goes through.
    s.advance(25 * DAY);
    await changeList(s, eight('relay-zeta'));
    expect(await s.ana.client.identity.relays()).toEqual(eight('relay-zeta'));
  });
});
