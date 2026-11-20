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
// Part 3, saving your own list: the real server-list routes (createNetworkServersRoutes) over the same
// local stand-in servers and stub resolver, the real core rotation behind the owner part.
//
// Part 4, fully quiet: with the opt-out on, a full cycle on the in-memory relay network sends nothing
// to and reads nothing from any default or legacy server (the spy records every connection and frame
// of the victim), and a restore on a clean HOME keeps the list and the choice.
//
// No Docker, no keychain, no real server and no real DNS.
import { AgentLinkClient, CoreError, TooManyPreviousError } from '@4thtech-io/core';
import {
  encodeUtf8,
  verifyNostrEvent,
  type JsonObject,
  type JsonValue,
  type NostrEvent,
} from '@4thtech-io/crypto';
import { newWebauthnTestCredential } from '@4thtech-io/crypto/testing';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createNetworkServersRoutes } from '../../packages/node/dist/local-ui/api/network-servers.js';
import {
  createNetworkTestRoute,
  type NetworkTestIo,
} from '../../packages/node/dist/local-ui/api/network-test.js';
import { serverListPort } from '../../packages/node/dist/local-ui/context.js';
import { createNetworkReader } from '../../packages/node/dist/local-ui/network-view.js';
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
import { DEFAULT_RELAYS, LEGACY_READ_RELAYS } from '../../packages/transport-nostr/dist/index.js';
import { createRestoreEngine } from '../../packages/node/src/recovery-kit-restore.js';
import {
  FAST,
  MemoryKeychain,
  makeAgent as makeFixtureAgent,
  makeKit,
  makeOwner,
  tempRoot,
  webauthnCreate,
} from '../../packages/node/src/recovery-kit-restore.fixture.js';
import { VirtualPrfAuthenticator } from '../../packages/node/src/passkey-authenticator.fixture.js';
import { openAgentStoreWith } from '../../packages/node/dist/agent-store.js';
import { openRecordedKeyStore } from '../../packages/node/dist/keychain-keystore.js';
import {
  editPolicy,
  makeAgent,
  pair,
  presence,
  type PiAgent,
} from '../prompt-injection/harness.js';
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

type LocalUiOwnerRoute = Extract<
  ReturnType<typeof createNetworkServersRoutes>[number],
  { presence: true }
>;
type LocalUiResult = Awaited<ReturnType<LocalUiOwnerRoute['handler']>>;

/** Servers of the saved lists (part 3): eight hosts under each tag, all behind one stand-in. */
const TAGS = ['own', 'a', 'b', 'c', 'd', 'e', 'f'] as const;
const listHost = (tag: string, i: number): string => `n${String(i)}.${tag}.nostr-test.dev`;
const LIST_HOSTS = TAGS.flatMap((tag) => Array.from({ length: 8 }, (_, i) => listHost(tag, i + 1)));
const eight = (tag: string, n = 8): string[] =>
  Array.from({ length: n }, (_, i) => `wss://${listHost(tag, i + 1)}`);

let certificate: TestCertificate;
const relays: TestRelay[] = [];

beforeAll(() => {
  certificate = makeTestCertificate([HOST, HOST_2, ...LIST_HOSTS]);
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

async function changeList(
  s: Scene,
  relays: readonly string[],
  announceDefault?: boolean,
  who: PiAgent = s.ana,
): Promise<void> {
  const session = await who.memoryOwner.unlock(presence());
  try {
    await who.client.identity.rotate({
      owner: session,
      ownerKeys: await who.memoryOwner.getPublicKeys(),
      epochControl: who.memoryOwner.epochControl(who.keys),
      relays,
      ...(announceDefault === undefined ? {} : { announceDefault }),
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

// ---- part 3: saving your own list ----------------------------------------------------------------

const MINUTE = 60;
const NOT_THE_OWNER = { kind: 'passphrase' as const, secret: encodeUtf8('not the owner') };
const START_LIST = ['wss://one.relay-beta.net', 'wss://two.relay-beta.net'];

interface Body {
  error?: string;
  status?: string;
  fitsFrom?: number;
  servers?: { outcome: string; role: string }[];
}

/** The real server-list routes over local stand-in servers, for one scene's victim. */
async function desk(s: Scene, behaviour: Behaviour = {}) {
  const { relay } = await standIn(behaviour);
  const dns: Record<string, string[][]> = {};
  for (const host of LIST_HOSTS) dns[host] = [[PUBLIC_A]];
  const w = stage(dns, { [PUBLIC_A]: relay.port });
  const [servers, reset] = createNetworkServersRoutes(() => w.io) as readonly LocalUiOwnerRoute[];
  if (servers === undefined || reset === undefined) throw new Error('test: no routes');
  const context = {
    client: s.ana.client,
    serverList: serverListPort(s.ana.client),
    now: () => s.world.clock() * 1000,
  } as never;
  const request = (input: JsonValue) => ({ params: {}, query: new URLSearchParams(), input });
  const asBody = (r: LocalUiResult): Body => r.body as Body;
  const input = (servers: readonly string[], announce = true): JsonObject => ({
    servers: [...servers],
    automatic: false,
    announce,
  });

  /** What the gate's one-use owner part does: unlock with the presence, rotate, tell the contacts. */
  const owner = (secret = presence()) =>
    ({
      changeServers: async (plan: { relays: readonly string[]; announceDefault: boolean }) => {
        const session = await s.ana.memoryOwner.unlock(secret);
        try {
          await s.ana.client.identity.rotate({
            owner: session,
            ownerKeys: await s.ana.memoryOwner.getPublicKeys(),
            epochControl: s.ana.memoryOwner.epochControl(s.ana.keys),
            relays: plan.relays,
            announceDefault: plan.announceDefault,
          });
        } catch (error) {
          if (error instanceof TooManyPreviousError) {
            return { status: 'refused', reason: 'too_many_previous', fitsAt: error.fitsAt };
          }
          if ((error as { code?: string }).code === 'epoch_conflict') {
            return { status: 'refused', reason: 'rotation_pending' };
          }
          if (
            error instanceof CoreError &&
            ['concurrent_rotation', 'key_epoch_mismatch', 'rotation_pending'].includes(error.code)
          ) {
            return { status: 'refused', reason: 'rotation_pending' };
          }
          throw error;
        } finally {
          await session.close();
        }
        await s.ana.client.sendCardUpdates().catch(() => undefined);
        const leaving = await s.ana.client.identity.leavingServers();
        return {
          status: 'changed',
          contacts: 0,
          leavingUntil: leaving.length === 0 ? null : Math.max(...leaving.map((e) => e.until)),
        };
      },
    }) as never;

  const review = async (route: LocalUiOwnerRoute, body: JsonObject): Promise<LocalUiResult> => {
    const answer = await route.precheck?.(context, request({ ...body, review: true }));
    if (answer === undefined) throw new Error('test: a review answers');
    return answer;
  };
  /** The confirm's precheck (before the gate): a refusal, or undefined to let it on to presence. */
  const precheck = (route: LocalUiOwnerRoute, body: JsonObject) =>
    route.precheck?.(context, request(body));
  const run = (route: LocalUiOwnerRoute, body: JsonObject, op = owner()) =>
    route.handler(context, request(body), op);
  /** Precheck, then the gate: a refusal stops it; the owner part runs only with a presence. */
  const save = async (
    route: LocalUiOwnerRoute,
    body: JsonObject,
    op = owner(),
  ): Promise<LocalUiResult> => (await precheck(route, body)) ?? (await run(route, body, op));
  return { servers, reset, review, precheck, run, save, input, asBody, owner };
}

describe('saving your own list needs the owner, a fresh test and the reviewed list', () => {
  it('a change without owner presence is refused: nothing is signed or changed', async () => {
    const s = (current = await scene());
    const d = await desk(s);
    // Both owner routes sit behind the presence gate; the review is only a precheck.
    expect(d.servers.presence).toBe(true);
    expect(d.reset.presence).toBe(true);
    const list = eight('own', 2);
    expect((await d.review(d.servers, d.input(list))).status).toBe(200);
    const before = [
      await s.ana.client.identity.relays(),
      (await s.ana.client.identity.get())?.keyEpoch,
    ];
    // A wrong presence signs nothing; no owner part at all is not available.
    await expect(d.save(d.servers, d.input(list), d.owner(NOT_THE_OWNER))).rejects.toThrow();
    await d.review(d.servers, d.input(list));
    expect(await d.precheck(d.servers, d.input(list))).toBeUndefined();
    expect((await d.run(d.servers, d.input(list), {} as never)).status).not.toBe(200);
    expect([
      await s.ana.client.identity.relays(),
      (await s.ana.client.identity.get())?.keyEpoch,
    ]).toEqual(before);
    // Control: with the presence, the same list is saved.
    await d.review(d.servers, d.input(list));
    const done = await d.save(d.servers, d.input(list));
    expect(done.status).toBe(200);
    expect(await s.ana.client.identity.relays()).toEqual(list);
  }, 60_000);

  it('a change whose servers fail the server-side test is refused, whatever the client claims', async () => {
    const s = (current = await scene());
    const behaviour: Behaviour = {};
    const d = await desk(s, behaviour);
    const list = eight('own', 3);
    const reviewed = await d.review(d.servers, d.input(list));
    expect(d.asBody(reviewed).servers?.map((x) => x.outcome)).toEqual(['ready', 'ready', 'ready']);
    // The servers went bad after the review; the page still says ready.
    behaviour.dropEvents = true;
    const claimed = { ...d.input(list), results: [{ outcome: 'ready' }], ready: true };
    expect((await d.save(d.servers, claimed as JsonObject)).status).toBe(400);
    const refused = await d.save(d.servers, d.input(list));
    expect([refused.status, d.asBody(refused).error]).toEqual([409, 'not_ready']);
    expect(d.asBody(await d.review(d.servers, d.input(list))).error).toBe('not_ready');
    expect(await s.ana.client.identity.relays()).toEqual(START_LIST);
  }, 60_000);

  it('the confirm must match the review: another list, none, or an old one is refused', async () => {
    const s = (current = await scene());
    const d = await desk(s);
    const [a, b] = [d.input(eight('a', 2)), d.input(eight('b', 2))];
    const err = (r: LocalUiResult): [number, string | undefined] => [r.status, d.asBody(r).error];
    expect(err(await d.save(d.servers, a))).toEqual([409, 'changed']);
    await d.review(d.servers, a);
    expect(err(await d.save(d.servers, b))).toEqual([409, 'changed']);
    await d.review(d.servers, a);
    s.advance(11 * MINUTE);
    expect(err(await d.save(d.servers, a))).toEqual([409, 'changed']);
    expect(await s.ana.client.identity.relays()).toEqual(START_LIST);
    await d.review(d.servers, a);
    expect((await d.save(d.servers, a)).status).toBe(200);
    expect(await s.ana.client.identity.relays()).toEqual(eight('a', 2));
  }, 60_000);

  it('two changes at once: one wins, the other gets a clear error', async () => {
    const s = (current = await scene());
    const d = await desk(s);
    const [x, y] = [d.input(eight('a', 2)), d.input(eight('b', 2))];
    await d.review(d.servers, x);
    await d.review(d.servers, y);
    expect(await d.precheck(d.servers, x)).toBeUndefined();
    expect(await d.precheck(d.servers, y)).toBeUndefined();
    const [rx, ry] = await Promise.all([d.run(d.servers, x), d.run(d.servers, y)]);
    expect([rx.status, ry.status].sort()).toEqual([200, 409]);
    const loser = rx.status === 409 ? rx : ry;
    expect(d.asBody(loser).error).toBe('rotation_pending');
    expect((await s.ana.client.identity.get())?.keyEpoch).toBe(1);
    expect(await s.ana.client.identity.relays()).toEqual(
      rx.status === 200 ? eight('a', 2) : eight('b', 2),
    );
    expect(await s.ana.client.identity.sendState()).toBe('ready');
  }, 60_000);

  it('the 17th previous server is refused with the date it fits, nothing signed', async () => {
    const s = (current = await scene());
    const d = await desk(s);
    const t0 = s.world.clock();
    for (const tag of ['a', 'b']) {
      await d.review(d.servers, d.input(eight(tag)));
      expect((await d.save(d.servers, d.input(eight(tag)))).status).toBe(200);
      s.advance(5 * DAY);
    }
    const third = d.input(eight('c'));
    const refused = await d.review(d.servers, third);
    expect([refused.status, d.asBody(refused).error]).toEqual([409, 'too_many_previous']);
    expect(Math.abs((d.asBody(refused).fitsFrom ?? 0) - (t0 + LEAVING_DAYS * DAY))).toBeLessThan(
      15,
    );
    expect(await s.ana.client.identity.relays()).toEqual(eight('b'));
    expect((await s.ana.client.identity.get())?.keyEpoch).toBe(2);
    // From that date the same list fits.
    s.advance(21 * DAY);
    expect((await d.review(d.servers, third)).status).toBe(200);
    expect((await d.save(d.servers, third)).status).toBe(200);
    expect(await s.ana.client.identity.relays()).toEqual(eight('c'));
  }, 90_000);

  it('reset to automatic restores the default servers and clears the opt-out', async () => {
    const s = (current = await scene());
    const d = await desk(s);
    const list = eight('own', 2);
    await d.review(d.servers, d.input(list, false));
    expect((await d.save(d.servers, d.input(list, false))).status).toBe(200);
    expect(await s.ana.client.identity.announceDefault()).toBe(false);
    expect((await d.review(d.reset, {})).status).toBe(200);
    expect((await d.save(d.reset, {})).status).toBe(200);
    expect(await s.ana.client.identity.relays()).toEqual(DEFAULT_RELAYS);
    expect(await s.ana.client.identity.announceDefault()).toBe(true);
    // Already automatic with the choice on: nothing to do.
    const again = await d.review(d.reset, {});
    expect([again.status, d.asBody(again).error]).toEqual([409, 'same_list']);
  }, 60_000);

  it('no MCP tool can change servers: none names it, and calling every one with the change changes nothing', async () => {
    const s = (current = await scene());
    const tools = (await s.ana.mcp.listTools()).tools;
    expect(tools.length).toBeGreaterThan(5);
    const named =
      /\/api\/ui\/network|changeServers|signServerChange|serverList|network\.announce|prepareAnnounce|use your own servers|automatic servers/i;
    for (const tool of tools) {
      const text = `${tool.name} ${tool.description ?? ''} ${JSON.stringify(tool.inputSchema)}`;
      expect(text, tool.name).not.toMatch(named);
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toMatch(
        /announce|automatic|servers/i,
      );
    }
    const state = async () => [
      await s.ana.client.identity.relays(),
      (await s.ana.client.identity.get())?.keyEpoch,
      await s.ana.client.identity.announceDefault(),
    ];
    const before = await state();
    const bodies = [
      { servers: eight('own', 2), automatic: false, announce: true },
      { relays: eight('own', 2) },
      { automatic: true },
      { announce: false },
      { announceDefault: false },
    ];
    for (const tool of tools) {
      for (const args of bodies) {
        // Refused or ignored: either way no tool acts on it.
        await s.ana.mcp.callTool({ name: tool.name, arguments: args }).catch(() => undefined);
      }
    }
    expect(await state()).toEqual(before);
  }, 60_000);
});

// ---- part 4: fully quiet -------------------------------------------------------------------------

const OFF_LIMITS: ReadonlySet<string> = new Set([...DEFAULT_RELAYS, ...LEGACY_READ_RELAYS]);

interface Seen {
  readonly url: string;
  readonly kind: string;
  readonly frame?: readonly unknown[] | undefined;
}

/** Records every connection and frame while the victim acts, and can make every publish fail. */
function spyOn(s: Scene) {
  const net = s.net;
  return {
    spy: {
      set refuse(on: boolean) {
        net.refuseEvents = on;
      },
    },
    /** Only what the victim does inside `fn` is recorded (the contact's own traffic is not). */
    during: async <T>(fn: () => Promise<T>): Promise<T> => {
      net.recording = true;
      try {
        return await fn();
      } finally {
        net.recording = false;
      }
    },
    /** Every connection or frame to a default or legacy server, less what `allow` lets through. */
    leaks: (allow: (seen: Seen) => boolean = () => false): Seen[] =>
      net.traffic.filter((f) => OFF_LIMITS.has(f.url) && !allow(f)),
    kinds: (kind: string): Seen[] => net.traffic.filter((f) => f.kind === kind),
  };
}

/** The owner's `network.announce`, prepared by core, signed and applied (what the app does). */
async function setOptOut(s: Scene, announceDefault: boolean) {
  const prepared = await s.ana.client.ownerActions.prepareAnnounce(announceDefault);
  if (prepared.status !== 'prepared') return prepared;
  const session = await s.ana.memoryOwner.unlock(presence());
  try {
    const body = JSON.parse(JSON.stringify(prepared.body)) as Parameters<
      typeof session.signOwnerAction
    >[0];
    return await s.ana.client.ownerActions.apply({
      body,
      sig: await session.signOwnerAction(body),
    });
  } finally {
    await session.close();
  }
}

/** Puts a copy of every stored message on each default and legacy server (what a tempted read would find). */
function seedOffLimits(s: Scene): void {
  const all = [...s.net.stored.values()].flat();
  for (const url of OFF_LIMITS) s.net.stored.set(url, [...all]);
}

/** One pass of everything that reads or probes: sync, live subscription, probe, due retries. */
async function quietPass(s: Scene): Promise<void> {
  await s.ana.client.syncInbox();
  const sub = await s.ana.client.subscribeInbox();
  await sub.close();
  await s.ana.client.network.probe();
  await s.ana.client.outbox.processDue();
}

const keysOf = async (agent: PiAgent): Promise<Set<string>> => {
  const { card } = await agent.client.identity.signedCard();
  return new Set([card.ownerNostr.slice(2), card.agentNostr.slice(2)]);
};
const recipientOf = (seen: Seen): string | undefined =>
  ((seen.frame?.[1] as NostrEvent | undefined)?.tags ?? []).find((t) => t[0] === 'p')?.[1];
const isLookup = (seen: Seen): boolean =>
  seen.kind === 'REQ' && (seen.frame?.[2] as { ids?: string[] }).ids !== undefined;

describe('with the opt-out on, a full cycle touches no default or legacy server', () => {
  it('send, receive and a card-update: nothing sent to and nothing read from any of them', async () => {
    const s = (current = await scene());
    const w = spyOn(s);
    expect(await setOptOut(s, false)).toMatchObject({ status: 'applied' });
    // Receive: a message sits on every default and legacy server too, and is also on the own ones.
    await s.mallory.call('agentlink_send', { to: 'Ana', text: 'in, one' });
    seedOffLimits(s);
    await w.during(() => s.ana.client.syncInbox());
    expect((await s.ana.call('agentlink_inbox', {})).text).toContain('in, one');
    // Send.
    const sent = await w.during(() => s.ana.call('agentlink_send', { to: 'Mallory', text: 'out' }));
    expect(sent.structured['status']).toBe('ok');
    // Card-update, after a change of the own list.
    await w.during(async () => {
      await changeList(s, list('relay-gamma'), false);
      await s.ana.client.sendCardUpdates();
      await s.ana.client.syncInbox();
    });
    expect(w.kinds('EVENT').length).toBeGreaterThan(2);
    expect(w.kinds('REQ').length).toBeGreaterThan(0);
    expect(w.leaks()).toEqual([]);
  }, 60_000);

  it('control: without the opt-out the same reads reach the default servers', async () => {
    const s = (current = await scene());
    const w = spyOn(s);
    await changeList(s, DEFAULT_RELAYS.slice(0, 3));
    await w.during(() => quietPass(s));
    expect(w.leaks().length).toBeGreaterThan(0);
  }, 60_000);

  it('the owner card-update, the retries and the network view probe touch none of them either', async () => {
    const s = (current = await scene());
    const w = spyOn(s);
    expect(await setOptOut(s, false)).toMatchObject({ status: 'applied' });
    w.spy.refuse = true;
    await w.during(async () => {
      await s.ana.client.cardUpdates.announceToOwner();
      await s.ana.call('agentlink_send', { to: 'Mallory', text: 'waits for a retry' });
      await changeList(s, list('relay-gamma'), false);
      await s.ana.client.sendCardUpdates();
    });
    expect(w.kinds('EVENT').length).toBeGreaterThan(0);
    w.spy.refuse = false;
    s.advance(2 * 3_600);
    await w.during(async () => {
      await s.ana.client.outbox.processDue();
      const view = createNetworkReader(s.ana.client, { now: () => s.world.clock() * 1000 });
      await view.read({ contactHosts: false });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await view.read({ contactHosts: false });
      await s.ana.client.network.probe();
    });
    // The retries went out (to the contact and to the own servers) and the probe ran.
    expect(w.kinds('open').length).toBeGreaterThan(0);
    expect(w.leaks()).toEqual([]);
  }, 60_000);

  it('a contact whose card lists a default server is reached there, but your own copies are not', async () => {
    const s = (current = await scene());
    const w = spyOn(s);
    const carolList = DEFAULT_RELAYS.slice(0, 2);
    const carol = await makeAgent(s.world, {
      n: 20,
      label: 'carol',
      name: 'Carol',
      relays: carolList,
    });
    await editPolicy(s.ana, (p) => {
      p.contacts.acceptInvites = 'auto';
    });
    await pair(carol, s.ana);
    await editPolicy(s.ana, (p) => {
      p.contacts.acceptInvites = 'approval';
    });
    expect(await setOptOut(s, false)).toMatchObject({ status: 'applied' });
    const theirs = await keysOf(carol);
    const sent = await w.during(async () => {
      const result = await s.ana.call('agentlink_send', { to: 'Carol', text: 'hello Carol' });
      await quietPass(s);
      return result;
    });
    expect(sent.structured['status']).toBe('ok');
    // Reached on her list: messages for her only.
    const toCarol = w.kinds('EVENT').filter((f) => carolList.includes(f.url));
    expect(toCarol.length).toBeGreaterThan(0);
    expect(toCarol.every((f) => theirs.has(recipientOf(f) ?? ''))).toBe(true);
    // Nothing else there: no copy for the owner or the agent itself, no read of the inbox, no probe.
    const allowed = (f: Seen): boolean =>
      carolList.includes(f.url) &&
      (f.kind === 'open' ||
        f.kind === 'CLOSE' ||
        isLookup(f) ||
        (f.kind === 'EVENT' && theirs.has(recipientOf(f) ?? '')));
    expect(w.leaks(allowed)).toEqual([]);
  }, 60_000);

  it('a change from the default servers to its own, with the opt-out, sends nothing to the old ones during the overlap', async () => {
    const s = (current = await scene());
    const w = spyOn(s);
    await changeList(s, DEFAULT_RELAYS.slice(0, 3));
    await s.ana.client.cardUpdates.announceToOwner();
    // A message still waiting, built while the own list was the default one.
    w.spy.refuse = true;
    await s.ana.call('agentlink_send', { to: 'Mallory', text: 'pending across the change' });
    s.advance(MINUTE);
    await w.during(async () => {
      await changeList(s, list('relay-gamma'), false);
      expect(await s.ana.client.identity.announceDefault()).toBe(false);
      await s.ana.client.cardUpdates.withdrawFromDefaultServers();
      await s.ana.client.sendCardUpdates();
    });
    w.spy.refuse = false;
    for (const days of [0, 2, 20]) {
      s.advance(days * DAY + 3_600);
      await w.during(async () => {
        await quietPass(s);
        await s.ana.client.cardUpdates.announceToOwner();
      });
    }
    // The retries went out, to the contact's servers and the own ones, and to no old default one.
    expect(w.kinds('EVENT').length).toBeGreaterThan(0);
    expect(w.leaks()).toEqual([]);
  }, 60_000);

  it('your own non-default previous server is still read for 30 days, and no default one is', async () => {
    const s = (current = await scene());
    const w = spyOn(s);
    expect(await setOptOut(s, false)).toMatchObject({ status: 'applied' });
    await changeList(s, list('relay-gamma'), false);
    s.advance(29 * DAY);
    // The contact has not seen the new card and still publishes to the old own servers.
    await s.mallory.call('agentlink_send', { to: 'Ana', text: 'late but in time' });
    seedOffLimits(s);
    await w.during(() => s.ana.client.syncInbox());
    const read = w.kinds('REQ').map((f) => f.url);
    for (const url of OLD) expect(read).toContain(url);
    expect((await s.ana.call('agentlink_inbox', {})).text).toContain('late but in time');
    expect(w.leaks()).toEqual([]);
    // Day 31: the old servers have ended.
    s.advance(2 * DAY);
    s.net.traffic.length = 0;
    await w.during(() => s.ana.client.syncInbox());
    for (const url of OLD) expect(w.kinds('REQ').map((f) => f.url)).not.toContain(url);
    expect(w.leaks()).toEqual([]);
  }, 60_000);

  it('a restore on a clean HOME keeps the own list and the opt-out', async () => {
    const t = await tempRoot('al-hostile-optout-');
    try {
      const own = ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'];
      const owner = await makeOwner();
      const made = await makeFixtureAgent(t.root, owner, 'helper', { announceDefault: false });
      const kit = await makeKit(t.root, owner, [made], undefined, join(t.home, 'Downloads'));
      const keychain = new MemoryKeychain();
      const origin = 'http://localhost:47821';
      const engine = createRestoreEngine({
        home: t.home,
        keychain: () => keychain,
        origin,
        kdf: FAST,
        now: () => 1_800_000_000_000,
        knownOwnerNostr: () => Promise.resolve(undefined),
      });
      const body = (a: { body: unknown }): Record<string, unknown> =>
        a.body as Record<string, unknown>;
      try {
        const found = await engine.found('S1');
        const handle = (body(found)['kits'] as { handle: string }[])[0]?.handle as string;
        const opened = await engine.open('S1', { handle }, encodeUtf8(kit.code));
        const begun = await engine.applyBegin('S1', {
          kit: body(opened)['kit'] as string,
          selection: [made.agentId],
          names: {},
        });
        expect(body(begun)['status']).toBe('gesture');
        const authenticator = new VirtualPrfAuthenticator({
          credential: newWebauthnTestCredential(),
        });
        const pk = body(begun)['publicKey'] as {
          challenge: string;
          userId: string;
          prfSalt: string;
        };
        const done = await engine.applyFinish(
          'S1',
          { nonce: body(begun)['nonce'] as JsonValue },
          webauthnCreate(authenticator, pk, origin),
        );
        expect(done.status).toBe(200);
        expect(body(done)['ids']).toMatchObject([{ agentId: made.agentId, outcome: 'restored' }]);
      } finally {
        await engine.close();
      }
      // The ID as the app opens it on the new computer.
      const path = join(t.home, '.agentlink', 'agents', 'helper', 'store.sqlite');
      const store = await openAgentStoreWith('keychain', made.agentId, path, { keychain });
      const keyStore = await openRecordedKeyStore('keychain', made.agentId, { keychain });
      try {
        const client = await AgentLinkClient.create({
          keyStore,
          store: store.store,
          cipher: store.cipher,
          approvals: {
            request: (request) => Promise.resolve({ approvalId: request.approvalId }),
            status: () => Promise.resolve({ state: 'pending' }),
          },
          policyMark: store.policyMark,
        });
        expect(await client.identity.relays()).toEqual(own);
        expect(await client.identity.announceDefault()).toBe(false);
      } finally {
        await keyStore.close();
        await store.close();
      }
    } finally {
      await t.cleanup();
    }
  }, 120_000);

  it('the opt-out with the mix-in on is refused, in the route and in the owner action', async () => {
    const s = (current = await scene());
    const d = await desk(s);
    const refusal = async (body: JsonObject): Promise<[number, string | undefined]> => {
      const r = await d.review(d.servers, body);
      return [r.status, d.asBody(r).error];
    };
    // The automatic servers (the mix-in) with the opt-out; an own list that holds a default server.
    expect(await refusal({ servers: eight('own', 1), automatic: true, announce: false })).toEqual([
      409,
      'mix_in_on',
    ]);
    expect(
      await refusal({
        servers: [...eight('own', 2), DEFAULT_RELAYS[0] as string],
        automatic: false,
        announce: false,
      }),
    ).toEqual([409, 'mix_in_on']);
    expect(
      await refusal({
        servers: [...eight('own', 2), LEGACY_READ_RELAYS[0] as string],
        automatic: false,
        announce: false,
      }),
    ).toEqual([409, 'mix_in_on']);
    // The owner action itself, on an ID that holds a default server.
    await changeList(s, DEFAULT_RELAYS.slice(0, 2));
    expect(await setOptOut(s, false)).toMatchObject({ status: 'refused', reason: 'mix_in_on' });
    expect(await s.ana.client.identity.announceDefault()).toBe(true);
  }, 60_000);
});
