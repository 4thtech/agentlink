// RELAY-CARD-MIGRATION (S2; 04 §2.5, §2.6; 08 §1; I-4): "Update your contact details" through the
// real approval server as the app host, its presence gate and the gate's one-use
// `updateContactDetails` (approval-server.ts), against the real Node pieces (a file keychain holding
// the agent and owner items, the SQLite store, the keychain owner store, the core client).
//
// - Without the owner's gesture (no master code in the body) the route refuses; nothing is signed.
// - With the gesture it signs once: the card moves to keyEpoch + 1 with the migrated list.
// - The gesture is one owner operation: posting it again signs nothing more (the epoch stays).
import { join } from 'node:path';
import { AgentLinkClient, type ApprovalChannel } from '@4thtech-io/core';
import { canonicalize, encodeBase64url, encodeUtf8, type JsonValue } from '@4thtech-io/crypto';
import { LEGACY_READ_RELAYS } from '@4thtech-io/transport-nostr';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAgentStoreWith } from './agent-store.js';
import { startApprovalServerWith, type ApprovalServer } from './approval-server.js';
import { fakeSource, ownerWorld, send, type OwnerWorld } from './approval-ui.fixture.js';
import { epochKeysOf } from './key-epoch.js';
import { openRecordedKeyStore } from './keychain-keystore.js';
import { TEST_APP } from './local-ui-app.fixture.js';
import type { AgentDirectory, AppHostAgent } from './local-ui/app-host.js';
import { KeychainOwnerKeyStore } from './owner-keystore.js';

const PATH = '/api/ui/contact-details';
const approvals: ApprovalChannel = {
  request: (request) => Promise.resolve({ approvalId: request.approvalId }),
  status: () => Promise.resolve({ state: 'pending' }),
};

let world: OwnerWorld;
const closers: (() => Promise<void>)[] = [];
let server: ApprovalServer;
let client: AgentLinkClient;

beforeEach(async () => {
  world = await ownerWorld('agentlink-cdgate-');
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
  // An install from before 0.5.13: a legacy relay and one the user added.
  await client.identity.init({
    owner: session,
    ownerKeys: world.owner,
    name: 'Personal',
    relays: ['wss://nos.lol', 'wss://one.relay-alpha.net'],
  });
  await session.close();
  await owner.close();

  const source = fakeSource(world);
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

let pageOf: () => Promise<Record<string, string>>;
const input = (value: JsonValue): string => encodeBase64url(encodeUtf8(canonicalize(value)));

const post = (page: Record<string, string>, body: Uint8Array) =>
  send(server.port, PATH, {
    method: 'POST',
    headers: { ...page, 'X-AgentLink-Input': input({}) },
    body,
  });

describe('POST /api/ui/contact-details through the presence gate', () => {
  it('the read says needed before anything is signed', async () => {
    const page = await pageOf();
    const res = await send(server.port, PATH, { headers: page });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'needed' });
  });

  it('without the gesture the route refuses and nothing is signed', async () => {
    const page = await pageOf();
    const res = await post(page, new Uint8Array(0));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await client.identity.get())?.keyEpoch).toBe(0);
    const wrong = await post(page, encodeUtf8('WRONG-CODE'));
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect((await client.identity.get())?.keyEpoch).toBe(0);
    expect((await client.identity.relayMigration()).status).toBe('needed');
  });

  it('with the gesture it signs once; the same gesture again signs nothing more', async () => {
    const page = await pageOf();
    const res = await post(page, encodeUtf8(world.code));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: 'done' });
    const card = await client.identity.signedCard();
    expect(card.card.keyEpoch).toBe(1);
    for (const legacy of LEGACY_READ_RELAYS) expect(card.relays).not.toContain(legacy);
    expect(card.relays).toContain('wss://one.relay-alpha.net');
    // The gesture is spent: posting it again is refused before anything is signed.
    const again = await post(page, encodeUtf8(world.code));
    expect(again.status).toBe(409);
    expect((await client.identity.get())?.keyEpoch).toBe(1);
    const read = await send(server.port, PATH, { headers: page });
    expect(JSON.parse(read.body)).toEqual({ status: 'current' });
  });
});
