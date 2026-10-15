// M1-7k acceptance over the real Node store (M1-8b): two AgentLinkClient instances over one SQLite
// file, as the CLI and an MCP server share one agent store (06 §6). Each instance has its own SQLite
// connection, so the store sees two writers exactly as with two processes. The outbox's per-row
// claim (07 §3.2; M1-9 plan finding 4) lets only one of them republish a pending row; when that one
// stalls or dies mid-publish, the other takes the row over once the claim lapses, within one retry
// interval (07 §4.2: the first backoff is 30 s). A staged handshake (M1-7c) is wrapped once, stored
// as outbox rows and survives a restart.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentLinkClient,
  OUTBOX_CLAIM_SECONDS,
  type ApprovalChannel,
  type TransportFactory,
} from '@agentlink/core';
import {
  encodeUtf8,
  type KeyStore,
  type NostrEvent,
  type OwnerPublicKeys,
} from '@agentlink/crypto';
import { wrapEnvelope, type PublishOutcome } from '@agentlink/transport-nostr';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAgentStoreWith, type AgentStore } from './agent-store.js';
import { createKeychainAgent, openRecordedKeyStore } from './keychain-keystore.js';
import type { KeychainBackend } from './keychain.js';
import { initOwnerWith } from './owner-init.js';
import { KeychainOwnerKeyStore } from './owner-keystore.js';
import type { OwnerTerminal } from './owner-terminal.js';

const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const RELAYS_A = ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'];
const RELAYS_B = ['wss://one.relay-beta.net', 'wss://two.relay-beta.net'];

class MapKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  async get(account: string): Promise<Uint8Array | null> {
    await Promise.resolve();
    return this.items.get(account)?.slice() ?? null;
  }
  async set(account: string, value: Uint8Array): Promise<void> {
    await Promise.resolve();
    this.items.set(account, value.slice());
  }
  async delete(account: string): Promise<boolean> {
    await Promise.resolve();
    return this.items.delete(account);
  }
}

const approvals: ApprovalChannel = {
  request: (request) => Promise.resolve({ approvalId: request.approvalId }),
  status: () => Promise.resolve({ state: 'pending' }),
};

/** A relay spy: real gift wraps, a faked publish that acks, refuses or never answers. */
class RelaySpy {
  readonly published: NostrEvent[] = [];
  mode: 'ack' | 'none' | 'hang' = 'ack';
  readonly factory: TransportFactory = (deps) => ({
    wrap: (envelope, recipients, keys) =>
      wrapEnvelope(envelope, recipients, keys, { now: deps.now }),
    publish: (event, relays) => {
      this.published.push(event);
      if (this.mode === 'hang') return new Promise<PublishOutcome>(() => {});
      const acked = this.mode === 'ack' ? [...relays] : [];
      return Promise.resolve({ results: [], acked, sent: acked.length >= 2 });
    },
  });
}

interface Party {
  readonly keychain: MapKeychain;
  readonly agentId: string;
  readonly owner: OwnerPublicKeys;
  readonly ownerCode: string;
  readonly path: string;
}

let dir: string;
let t: number;
const opened: { store: AgentStore; keyStore: KeyStore }[] = [];

async function party(name: string): Promise<Party> {
  const keychain = new MapKeychain();
  const agentId = await createKeychainAgent(keychain);
  const written: string[] = [];
  const shown = (): string =>
    (written.find((w) => w.startsWith('Your owner code: ')) ?? '').slice(
      'Your owner code: '.length,
    );
  const terminal: OwnerTerminal = {
    write: (text) => void written.push(text),
    readSecret: () => Promise.resolve(encodeUtf8(shown().slice(-4))),
    confirm: () => Promise.resolve(false),
    clearScreen: () => void written.push('<clear>'),
  };
  const { owner } = await initOwnerWith(
    keychain,
    terminal,
    { backend: 'keychain', env: {} },
    { kdf: KDF },
  );
  return { keychain, agentId, owner, ownerCode: shown(), path: join(dir, `${name}.sqlite`) };
}

async function openClient(p: Party, spy: RelaySpy): Promise<AgentLinkClient> {
  const store = await openAgentStoreWith('keychain', p.agentId, p.path, { keychain: p.keychain });
  const keyStore = await openRecordedKeyStore('keychain', p.agentId, { keychain: p.keychain });
  opened.push({ store, keyStore });
  return AgentLinkClient.create({
    keyStore,
    store: store.store,
    cipher: store.cipher,
    approvals,
    clock: () => t,
    policyMark: store.policyMark,
    transport: spy.factory,
  });
}

async function initIdentity(p: Party, client: AgentLinkClient, relays: string[]): Promise<void> {
  const ownerStore = await KeychainOwnerKeyStore.open(p.keychain, p.owner);
  const session = await ownerStore.unlock({ kind: 'passphrase', secret: encodeUtf8(p.ownerCode) });
  try {
    await client.identity.init({ owner: session, ownerKeys: p.owner, name: 'Agent', relays });
  } finally {
    await session.close();
    await ownerStore.close();
  }
}

/**
 * Waits until `check` holds, by wall-clock time: the first pass waits on SQLite's lock timers and on
 * real crypto, so a count of event-loop turns is too short on a slow runner (CI, PR #99).
 */
async function until(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(check()).toBe(true);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-send-outbox-'));
  t = Math.floor(Date.now() / 1000);
});
afterEach(async () => {
  for (const { store, keyStore } of opened.splice(0)) {
    await keyStore.close();
    await store.close();
  }
  await rm(dir, { recursive: true, force: true });
});

describe('outbox over one SQLite store shared by two clients (M1-7k, 06 §6)', () => {
  it('publishes a staged handshake from one client only, hands over after the claim lapses, and survives a restart', async () => {
    const a = await party('a');
    const b = await party('b');
    const inviter = await openClient(a, new RelaySpy());
    await initIdentity(a, inviter, RELAYS_A);
    const spy1 = new RelaySpy();
    const one = await openClient(b, spy1);
    await initIdentity(b, one, RELAYS_B);
    const invite = await inviter.pairing.createInvite();
    const accepted = await one.pairing.acceptInvite({ link: invite.inviteUrl, allowed: true });
    expect(accepted.status).toBe('pending');

    // The second client (another process) over the same store file.
    const spy2 = new RelaySpy();
    const two = await openClient(b, spy2);

    spy1.mode = 'hang'; // the first process stalls (or dies) mid-publish
    // The stalled pass never settles; a rejection before it stalls must fail the test, not leak.
    let stalledError: unknown;
    void one.outbox.processDue().catch((error: unknown) => {
      stalledError = error ?? new Error('rejected');
    });
    await until(() => spy1.published.length === 4 || stalledError !== undefined);
    expect(stalledError).toBeUndefined();
    expect((await two.outbox.processDue()).sent).toBe(0);
    expect(spy2.published).toHaveLength(0);

    t += OUTBOX_CLAIM_SECONDS;
    expect((await two.outbox.processDue()).sent).toBe(4);
    expect(spy2.published.map((e) => e.id).sort()).toEqual(spy1.published.map((e) => e.id).sort());

    // Restart: a fresh client finds nothing left to publish and wraps nothing again.
    const spy3 = new RelaySpy();
    const three = await openClient(b, spy3);
    t += 3_600;
    await three.outbox.processDue();
    expect(spy3.published).toHaveLength(0);
  });
});
