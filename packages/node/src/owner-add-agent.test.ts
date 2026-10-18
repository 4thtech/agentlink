// M1-9t (D-78; 04 §2.2, §2.5, §2.8 "Adding an agent to the existing owner"): one owner key per OS
// user owns many local agents. `owner add-agent` signs exactly one first card for exactly the agent
// being added, with the owner key already on the machine, in one owner operation.
//
// Against the real Node pieces: ONE keychain (one OS user) shared by both agents and the owner, the
// SQLite store per agent, the keychain owner store and the core client.
// - Two agents each get a card naming the same owner, with separate keychain items, stores and Nostr
//   identities; the owner item is never written.
// - Presence: the harness marker refuses before the owner key is read; refusals (no owner key, an
//   agent that already has a card) come before the owner code is asked for; three wrong entries end
//   the command and nothing is written.
// - A card that cannot be stored never removes the owner item (unlike `owner init`, M1-8h).
// - An approval decided for one agent is refused by the other (04 §2.5.1 binding).
// - `owner init` with an owner already on the machine points to `owner add-agent`.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLinkClient, computeActionDigest, type ApprovalChannel } from '@4thtech-io/core';
import {
  encodeBase64url,
  encodeHex,
  encodeHex0x,
  encodeUtf8,
  equalBytes,
  randomBytes,
  verifyAgentCard,
  type JsonObject,
  type KeyStore,
  type OwnerPublicKeys,
} from '@4thtech-io/crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAgentStoreWith, type AgentStore } from './agent-store.js';
import { NodeKeyStoreError } from './errors.js';
import { addAgentToOwner } from './index.js';
import { createKeychainAgent, openRecordedKeyStore } from './keychain-keystore.js';
import type { KeychainBackend } from './keychain.js';
import { addAgentWith } from './owner-add-agent.js';
import type { FirstAgentCard } from './owner-first-card.js';
import { initOwnerWith } from './owner-init.js';
import { KeychainOwnerKeyStore, OWNER_ACCOUNT } from './owner-keystore.js';
import type { OwnerTerminal } from './owner-terminal.js';

const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const RELAYS = ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'];

/** One OS user's keychain: every agent and the owner item live in it. Counts reads. */
class MapKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  reads = 0;
  async get(account: string): Promise<Uint8Array | null> {
    await Promise.resolve();
    this.reads += 1;
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

interface Agent {
  readonly agentId: string;
  readonly client: AgentLinkClient;
  readonly store: AgentStore;
  readonly keyStore: KeyStore;
}

let dir: string;
let keychain: MapKeychain;
let now: number;
const opened: Agent[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-add-agent-'));
  keychain = new MapKeychain();
  now = Math.floor(Date.now() / 1000);
});
afterEach(async () => {
  for (const agent of opened.splice(0)) {
    await agent.keyStore.close();
    await agent.store.close();
  }
  await rm(dir, { recursive: true, force: true });
});

/** What `agentlink init --agent <label>` leaves: an identity in the shared keychain, no card. */
async function initAgent(label: string): Promise<Agent> {
  const agentId = await createKeychainAgent(keychain);
  const store = await openAgentStoreWith('keychain', agentId, join(dir, `${label}.sqlite`), {
    keychain,
  });
  const keyStore = await openRecordedKeyStore('keychain', agentId, { keychain });
  const client = await AgentLinkClient.create({
    keyStore,
    store: store.store,
    cipher: store.cipher,
    approvals,
    clock: () => now,
    policyMark: store.policyMark,
  });
  const agent = { agentId, client, store, keyStore };
  opened.push(agent);
  return agent;
}

const firstCard = (agent: Agent, name: string, relays = RELAYS): FirstAgentCard => ({
  agent: agent.agentId,
  name,
  relays,
  identity: agent.client.identity,
});

/** `owner init` for the first agent; returns the owner keys and the code it showed. */
async function ownerInit(agent: Agent): Promise<{ owner: OwnerPublicKeys; code: string }> {
  const written: string[] = [];
  const shown = (): string =>
    (written.find((t) => t.startsWith('Your owner code: ')) ?? '').slice(
      'Your owner code: '.length,
    );
  const terminal: OwnerTerminal = {
    write: (text) => void written.push(text),
    readSecret: () => Promise.resolve(encodeUtf8(shown().slice(-4))),
    confirm: () => Promise.resolve(false),
    clearScreen: () => undefined,
  };
  const { owner } = await initOwnerWith(
    keychain,
    terminal,
    { backend: 'keychain', env: {}, firstCard: firstCard(agent, 'alice') },
    { kdf: KDF },
  );
  return { owner, code: shown() };
}

/** The owner at their own terminal for `owner add-agent`: types `entries` in turn. */
function ownerTyping(entries: readonly string[]) {
  const written: string[] = [];
  const labels: string[] = [];
  const queue = [...entries];
  const terminal: OwnerTerminal = {
    write: (text) => void written.push(text),
    readSecret: (label) => {
      labels.push(label);
      return Promise.resolve(encodeUtf8(queue.shift() ?? ''));
    },
    confirm: () => Promise.resolve(false),
    clearScreen: () => void written.push('<clear>'),
  };
  return { terminal, written, labels };
}

async function failure(fn: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof NodeKeyStoreError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('owner add-agent: one owner, many local agents (D-78; 04 §2.8)', () => {
  it('two agents under one OS user each get a card naming the same owner, in one code entry', async () => {
    const alice = await initAgent('alice');
    const bob = await initAgent('bob');
    const { owner, code } = await ownerInit(alice);
    const ownerItem = keychain.items.get(OWNER_ACCOUNT)?.slice();

    const run = ownerTyping([code]);
    const result = await addAgentWith(keychain, run.terminal, {
      backend: 'keychain',
      env: {},
      owner,
      card: firstCard(bob, 'bob'),
    });

    const a = await alice.client.identity.get();
    const b = await bob.client.identity.get();
    if (a === undefined || b === undefined) throw new Error('missing identity');
    expect(verifyAgentCard(b.card, b.cardSig, b.cardAgentSig)).toBe(true);
    expect(b.card.agentEvm).toBe(bob.agentId);
    expect(result.card).toEqual(b.card);
    // The same owner on both cards.
    for (const key of ['ownerEvm', 'ownerNostr', 'ownerEnc'] as const) {
      expect(b.card[key]).toBe(a.card[key]);
    }
    expect(b.card.ownerNostr).toBe(encodeHex0x(owner.ownerNostr));
    // Separate agents: separate agent IDs, Nostr identities, encryption keys and keychain items.
    expect(bob.agentId).not.toBe(alice.agentId);
    expect(b.card.agentNostr).not.toBe(a.card.agentNostr);
    expect(b.card.agentEnc).not.toBe(a.card.agentEnc);
    expect(keychain.items.has(alice.agentId)).toBe(true);
    expect(keychain.items.has(bob.agentId)).toBe(true);
    // One entry of the owner code; the owner item is never written.
    expect(run.labels).toEqual(['Owner code:']);
    const after = keychain.items.get(OWNER_ACCOUNT);
    expect(ownerItem !== undefined && after !== undefined && equalBytes(after, ownerItem)).toBe(
      true,
    );
    // The owner saw the owner fingerprint and which agent before the prompt; never a code.
    expect(run.written.join('\n')).toContain(result.fingerprint);
    expect(run.written.join('\n')).toContain('bob');
    expect(run.written.join('\n')).not.toContain(code);
  });

  it('refuses with an AI-app marker set, before the owner key is read', async () => {
    const alice = await initAgent('alice');
    const bob = await initAgent('bob');
    const { owner, code } = await ownerInit(alice);
    const reads = keychain.reads;
    const run = ownerTyping([code]);
    const refused = await failure(() =>
      addAgentWith(keychain, run.terminal, {
        backend: 'keychain',
        env: { CLAUDECODE: '1' },
        owner,
        card: firstCard(bob, 'bob'),
      }),
    );
    expect(refused.code).toBe('harness_detected');
    expect(keychain.reads).toBe(reads);
    expect(run.labels).toEqual([]);
    expect(await bob.client.identity.get()).toBeUndefined();
  });

  it('the public entry refuses with an AI-app marker set, before anything is read', async () => {
    const refused = await failure(() =>
      addAgentToOwner({
        backend: 'keychain',
        env: { CLAUDECODE: '1' },
        owner: {
          ownerEvm: new Uint8Array(20),
          ownerNostr: new Uint8Array(32),
          ownerEnc: new Uint8Array(32),
        },
        card: {
          agent: `0x${'ab'.repeat(20)}`,
          name: 'bob',
          relays: RELAYS,
          identity: {
            get: () => Promise.reject(new Error('not reached')),
            init: () => Promise.reject(new Error('not reached')),
          },
        },
      }),
    );
    expect(refused.code).toBe('harness_detected');
  });

  it('refuses an agent that already has a card, before the owner code is asked for', async () => {
    const alice = await initAgent('alice');
    const { owner, code } = await ownerInit(alice);
    const before = await alice.client.identity.get();
    const run = ownerTyping([code]);
    const refused = await failure(() =>
      addAgentWith(keychain, run.terminal, {
        backend: 'keychain',
        env: {},
        owner,
        card: firstCard(alice, 'alice'),
      }),
    );
    expect(refused.code).toBe('owner_exists');
    expect(run.labels).toEqual([]);
    expect(await alice.client.identity.get()).toEqual(before);
  });

  it('refuses without an owner key on the machine, before the owner code is asked for', async () => {
    const alice = await initAgent('alice');
    const bob = await initAgent('bob');
    const { owner, code } = await ownerInit(alice);
    keychain.items.delete(OWNER_ACCOUNT);
    const run = ownerTyping([code]);
    const refused = await failure(() =>
      addAgentWith(keychain, run.terminal, {
        backend: 'keychain',
        env: {},
        owner,
        card: firstCard(bob, 'bob'),
      }),
    );
    expect(refused.code).toBe('owner_missing');
    expect(refused.message).toContain('agentlink owner init');
    expect(run.labels).toEqual([]);
    expect(await bob.client.identity.get()).toBeUndefined();
  });

  it('three wrong entries end the command and nothing is written', async () => {
    const alice = await initAgent('alice');
    const bob = await initAgent('bob');
    const { owner } = await ownerInit(alice);
    const ownerItem = keychain.items.get(OWNER_ACCOUNT)?.slice();
    const wrong = 'AAAA BBBB CCCC DDDD EEEE FFFF';
    const run = ownerTyping([wrong, wrong, wrong, wrong]);
    const refused = await failure(() =>
      addAgentWith(keychain, run.terminal, {
        backend: 'keychain',
        env: {},
        owner,
        card: firstCard(bob, 'bob'),
      }),
    );
    expect(refused.code).toBe('owner_secret_refused');
    expect(run.labels).toHaveLength(3);
    expect(await bob.client.identity.get()).toBeUndefined();
    const after = keychain.items.get(OWNER_ACCOUNT);
    expect(ownerItem !== undefined && after !== undefined && equalBytes(after, ownerItem)).toBe(
      true,
    );
  });

  it('a card that cannot be stored never removes the owner item (no M1-8h rollback)', async () => {
    const alice = await initAgent('alice');
    const bob = await initAgent('bob');
    const { owner, code } = await ownerInit(alice);
    const run = ownerTyping([code]);
    // Two identical relays: core refuses the list after the owner code was accepted.
    const refused = await failure(() =>
      addAgentWith(keychain, run.terminal, {
        backend: 'keychain',
        env: {},
        owner,
        card: firstCard(bob, 'bob', ['wss://one.relay-alpha.net', 'wss://one.relay-alpha.net']),
      }),
    );
    expect(refused.code).toBe('owner_card_failed');
    expect(keychain.items.has(OWNER_ACCOUNT)).toBe(true);
    expect(await bob.client.identity.get()).toBeUndefined();
    expect(await alice.client.identity.get()).toBeDefined();
    // The owner can simply run it again.
    await addAgentWith(keychain, ownerTyping([code]).terminal, {
      backend: 'keychain',
      env: {},
      owner,
      card: firstCard(bob, 'bob'),
    });
    expect(await bob.client.identity.get()).toBeDefined();
  });

  it('refuses a card for another agent than the one named (the session signs only that card)', async () => {
    const alice = await initAgent('alice');
    const bob = await initAgent('bob');
    const carol = await initAgent('carol');
    const { owner, code } = await ownerInit(alice);
    // Bob is named, but the identity service is Carol's: the card would name Carol's keys.
    const crossed: FirstAgentCard = { ...firstCard(bob, 'bob'), identity: carol.client.identity };
    const refused = await failure(() =>
      addAgentWith(keychain, ownerTyping([code]).terminal, {
        backend: 'keychain',
        env: {},
        owner,
        card: crossed,
      }),
    );
    expect(refused.code).toBe('owner_card_failed');
    expect(await carol.client.identity.get()).toBeUndefined();
    expect(keychain.items.has(OWNER_ACCOUNT)).toBe(true);
  });

  it('an approval decided for one agent is refused by the other agent of the same owner', async () => {
    const alice = await initAgent('alice');
    const bob = await initAgent('bob');
    const { owner, code } = await ownerInit(alice);
    await addAgentWith(keychain, ownerTyping([code]).terminal, {
      backend: 'keychain',
      env: {},
      owner,
      card: firstCard(bob, 'bob'),
    });
    const sign = async (body: JsonObject): Promise<string> => {
      const ownerStore = await KeychainOwnerKeyStore.open(keychain, owner);
      try {
        const session = await ownerStore.unlock({ kind: 'passphrase', secret: encodeUtf8(code) });
        try {
          return JSON.stringify({ body, sig: await session.signOwnerAction(body) });
        } finally {
          await session.close();
        }
      } finally {
        await ownerStore.close();
      }
    };
    // A real pending request at Alice, decided by the owner for Alice.
    const action: JsonObject = {
      tool: 'agentlink_export_proof_pack',
      args: { recordId: '0x01', includeKey: true, note: 'x' },
      context: {
        triggers: ['proofs.allowKeyDisclosure'],
        recordId: `0x${'ab'.repeat(32)}`,
        envelopeHash: `0x${'cd'.repeat(32)}`,
      },
    };
    const pending = await alice.client.approvalService.request({
      action,
      summary: 'Include the document key in an export',
    });
    const forAlice = await sign({
      v: 1,
      agent: alice.agentId,
      owner: encodeHex(owner.ownerNostr),
      op: 'approval.decide',
      params: {
        approvalId: pending.approvalId,
        actionDigest: computeActionDigest(action),
        decision: 'approve',
      },
      nonce: encodeBase64url(randomBytes(16)),
      issuedAt: now,
      expiresAt: now + 600,
    });
    // Agent B refuses it: it names agent A.
    expect(await bob.client.ownerActions.apply(forAlice)).toMatchObject({
      status: 'refused',
      reason: 'agent_mismatch',
    });
    // Positive control (IR-M1-9t-1 Info): agent A applies its own approval.
    expect(await alice.client.ownerActions.apply(forAlice)).toMatchObject({
      status: 'applied',
      op: 'approval.decide',
    });
  });
});

describe('owner init with an owner already on the machine (D-78)', () => {
  it('creates no second owner and points to `owner add-agent`', async () => {
    const alice = await initAgent('alice');
    const bob = await initAgent('bob');
    await ownerInit(alice);
    const ownerItem = keychain.items.get(OWNER_ACCOUNT)?.slice();
    const run = ownerTyping([]);
    const refused = await failure(() =>
      initOwnerWith(
        keychain,
        run.terminal,
        { backend: 'keychain', env: {}, firstCard: firstCard(bob, 'bob') },
        { kdf: KDF },
      ),
    );
    expect(refused.code).toBe('owner_exists');
    expect(refused.message).toContain('agentlink owner add-agent --agent');
    expect(run.written.some((t) => t.startsWith('Your owner code: '))).toBe(false);
    const after = keychain.items.get(OWNER_ACCOUNT);
    expect(ownerItem !== undefined && after !== undefined && equalBytes(after, ownerItem)).toBe(
      true,
    );
  });
});
