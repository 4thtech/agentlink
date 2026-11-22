// NET-ANNOUNCE-OPTOUT (S2; D-158 (7); 04 §2.5.1 `network.announce`; 08 §1
// `POST /api/ui/network/announce`; I-4): the opt-out on its own, through the real approval server as
// the app host, its CSRF/Origin gate and its presence gate, against the real Node pieces (a file
// keychain holding the agent and owner items, the SQLite store, the keychain owner store, the core
// client). No network.
//
// - Without the owner's gesture nothing is signed and the choice stays.
// - With the gesture it signs `network.announce` once; the list and the card do not change.
// - The opt-out is refused before the gesture while the list holds a default server.
import { join } from 'node:path';
import { AgentLinkClient, type ApprovalChannel } from '@4thtech-io/core';
import { canonicalize, encodeBase64url, encodeUtf8, type JsonValue } from '@4thtech-io/crypto';
import type {
  HostResolver,
  RelayConnector,
  RelaySocket,
  RelaySocketHandlers,
  RelayTarget,
} from '@4thtech-io/transport-nostr';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openAgentStoreWith } from './agent-store.js';
import { startApprovalServerWith, type ApprovalServer } from './approval-server.js';
import { fakeSource, ownerWorld, send, type OwnerWorld } from './approval-ui.fixture.js';
import { epochKeysOf } from './key-epoch.js';
import { openRecordedKeyStore } from './keychain-keystore.js';
import { TEST_APP } from './local-ui-app.fixture.js';
import type { AgentDirectory, AppHostAgent } from './local-ui/app-host.js';
import { NETWORK_ANNOUNCE_PATH, networkAnnounceRoute } from './local-ui/api/network-announce.js';
import { createNetworkServersRoutes } from './local-ui/api/network-servers.js';
import { LocalUiRouteRegistry } from './local-ui/routes.js';
import { KeychainOwnerKeyStore } from './owner-keystore.js';

const OWN = ['wss://one.example.org', 'wss://two.example.org', 'wss://three.example.org'];
/** The list the next world starts on (a default one for the mix_in_on case). */
let START: readonly string[] = OWN;
const approvals: ApprovalChannel = {
  request: (request) => Promise.resolve({ approvalId: request.approvalId }),
  status: () => Promise.resolve({ state: 'pending' }),
};

function memoryRelays(): RelayConnector {
  const stored: { id: string }[] = [];
  return {
    open(_target: RelayTarget, handlers: RelaySocketHandlers): RelaySocket {
      let closed = false;
      const push = (frame: unknown[]): void => {
        queueMicrotask(() => {
          if (!closed) handlers.onMessage(JSON.stringify(frame));
        });
      };
      queueMicrotask(() => {
        if (!closed) handlers.onOpen();
      });
      return {
        send(text: string) {
          const frame = JSON.parse(text) as unknown[];
          if (frame[0] === 'EVENT') {
            const event = frame[1] as { id: string };
            stored.push(event);
            push(['OK', event.id, true, '']);
          } else if (frame[0] === 'REQ') {
            const ids = (frame[2] as { ids?: string[] }).ids;
            for (const event of stored)
              if (ids === undefined || ids.includes(event.id)) push(['EVENT', frame[1], event]);
            push(['EOSE', frame[1]]);
          }
        },
        close() {
          closed = true;
        },
      };
    },
  };
}
const resolver: HostResolver = { resolve: () => Promise.resolve(['93.184.215.30']) };

let world: OwnerWorld;
const closers: (() => Promise<void>)[] = [];
let server: ApprovalServer;
let client: AgentLinkClient;
let pageOf: () => Promise<Record<string, string>>;

beforeEach(async () => {
  world = await ownerWorld('agentlink-srvgate-');
  const store = await openAgentStoreWith(
    'keychain',
    world.agentId,
    join(world.root, 'agent.sqlite'),
    { keychain: world.keychain },
  );
  closers.push(() => store.close());
  const keyStore = await openRecordedKeyStore('keychain', world.agentId, {
    keychain: world.keychain,
  });
  closers.push(() => keyStore.close());
  client = await AgentLinkClient.create({
    keyStore,
    store: store.store,
    cipher: store.cipher,
    approvals,
    clock: () => Math.floor(Date.now() / 1000),
    policyMark: store.policyMark,
  });
  const owner = await KeychainOwnerKeyStore.open(world.keychain, world.owner);
  const session = await owner.unlock({ kind: 'passphrase', secret: encodeUtf8(world.code) });
  await client.identity.init({
    owner: session,
    ownerKeys: world.owner,
    name: 'Personal',
    relays: START,
  });
  await session.close();
  await owner.close();

  // The app's source applies owner actions through core (apps/cli/src/approval/ui-source.ts
  // `apply`); the fixture's own apply knows approvals only, so `network.announce` goes to this
  // client's core.
  const fake = fakeSource(world);
  const source: typeof fake = {
    ...fake,
    apply: (signed) =>
      signed.body['op'] === 'network.announce'
        ? client.ownerActions.apply(signed)
        : fake.apply(signed),
  };
  const epochKeys = epochKeysOf(keyStore);
  if (epochKeys === undefined) throw new Error('test: no epoch keys');
  const initial: AppHostAgent = {
    name: 'default',
    label: 'Personal',
    source,
    localUi: { client, epochKeys },
    close: () => Promise.resolve(),
  };
  const entry = { name: 'default', label: 'Personal', available: true, removing: false };
  const directory: AgentDirectory = {
    list: () => Promise.resolve([entry]),
    read: (name) => Promise.resolve(name === 'default' ? entry : undefined),
    stats: () => Promise.resolve({ contacts: 0, running: false, sessions: [], lastSeen: [] }),
    writeLabel: () => Promise.reject(new Error('not here')),
    markRemoving: () => Promise.reject(new Error('not here')),
    removeFolder: () => Promise.reject(new Error('not here')),
    readCurrent: () => Promise.resolve(undefined),
    writeCurrent: () => Promise.resolve(),
  };
  const routes = new LocalUiRouteRegistry();
  for (const route of createNetworkServersRoutes(() => ({ resolver, connector: memoryRelays() }))) {
    routes.register(route);
  }
  routes.register(networkAnnounceRoute);
  const opened: string[] = [];
  server = await startApprovalServerWith(
    {
      source,
      localUi: { assets: TEST_APP },
      host: { directory, initial, open: () => Promise.resolve(initial) },
    },
    {
      keychain: world.keychain,
      openOwnerStore: (expected) => KeychainOwnerKeyStore.open(world.keychain, expected),
      opener: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      notifier: () => Promise.resolve(true),
      routes,
    },
  );
  closers.push(() => server.close());
  pageOf = async () => {
    const at = opened.length;
    await server.open();
    const token = new URL(opened[at] ?? '').searchParams.get('t') ?? '';
    const first = await send(server.port, `/?t=${token}`);
    const cookie = (first.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
    const shell = await send(server.port, '/', { headers: { Cookie: cookie } });
    const csrf = /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(shell.body)?.[1];
    const generation = String(shell.headers['x-agentlink-generation'] ?? '');
    return {
      Cookie: cookie,
      Origin: server.origin,
      'Content-Type': 'application/octet-stream',
      'X-AgentLink-CSRF': csrf ?? '',
      'X-AgentLink-Generation': generation,
      'Sec-Fetch-Site': 'same-origin',
    };
  };
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
  world.cleanup();
});

const input = (value: JsonValue): string => encodeBase64url(encodeUtf8(canonicalize(value)));

const post = (page: Record<string, string>, value: JsonValue, body: Uint8Array) =>
  send(server.port, NETWORK_ANNOUNCE_PATH, {
    method: 'POST',
    headers: { ...page, 'X-AgentLink-Input': input(value) },
    body,
  });

describe('POST /api/ui/network/announce through the real gates', () => {
  it('without the gesture nothing is signed and the choice stays', async () => {
    const page = await pageOf();
    const none = await post(page, { announce: false }, new Uint8Array(0));
    expect(none.status).toBeGreaterThanOrEqual(400);
    const wrong = await post(page, { announce: false }, encodeUtf8('WRONG-CODE'));
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(await client.identity.announceDefault()).toBe(true);
  });

  it('with the gesture it signs network.announce once; the list and the card stay', async () => {
    const page = await pageOf();
    const res = await post(page, { announce: false }, encodeUtf8(world.code));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'done', announceDefault: false });
    expect(await client.identity.announceDefault()).toBe(false);
    expect(await client.identity.relays()).toEqual(OWN);
    expect((await client.identity.get())?.keyEpoch).toBe(0);
    const again = await post(page, { announce: false }, encodeUtf8(world.code));
    expect(again.status).toBe(409);
    expect(JSON.parse(again.body)).toMatchObject({ error: 'same_choice' });
    const back = await post(page, { announce: true }, encodeUtf8(world.code));
    expect(back.status).toBe(200);
    expect(await client.identity.announceDefault()).toBe(true);
  });

  it('without the CSRF header nothing runs', async () => {
    const page = await pageOf();
    const { ['X-AgentLink-CSRF']: _csrf, ...noCsrf } = page;
    void _csrf;
    const res = await post(noCsrf, { announce: false }, encodeUtf8(world.code));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await client.identity.announceDefault()).toBe(true);
  });
});

describe('POST /api/ui/network/announce on a list with default servers', () => {
  beforeAll(() => {
    START = ['wss://relay.primal.net', 'wss://nostr.data.haus'];
  });
  afterAll(() => {
    START = OWN;
  });

  it('refuses the opt-out with mix_in_on before the gesture; nothing is signed', async () => {
    const page = await pageOf();
    const res = await post(page, { announce: false }, encodeUtf8(world.code));
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'mix_in_on' });
    expect(await client.identity.announceDefault()).toBe(true);
  });
});
