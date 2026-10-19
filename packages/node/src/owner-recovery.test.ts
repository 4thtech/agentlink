// M1-9x (D-78; 04 §2.5, §2.8 "Adding an agent to the existing owner"): an owner item exists on this
// machine but no local agent has a card naming it (for example after every carded agent was
// removed). `owner init` refuses because an owner exists, and `owner add-agent` used to need another
// agent's card to learn the owner's public keys: a dead end.
//
// Now `owner add-agent` without a known owner takes the owner's public keys from the owner item
// itself, once the owner code has unlocked it, shows the owner fingerprint and asks the owner to
// confirm it, then signs exactly one first card. Against the real Node pieces (one keychain, the
// SQLite store per agent, the keychain owner store and the core client).
// - After every agent is removed, add-agent succeeds and the new card names the same owner.
// - With an AI-app marker set it is refused BEFORE the owner item is read.
// - No owner code appears in the output, an error or the result.
// - Declining the fingerprint, or three wrong entries, writes nothing; the owner item is never
//   written or removed.
// - A store-only check tells whether the owner item exists, without unlocking anything.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLinkClient, type ApprovalChannel } from '@4thtech-io/core';
import { encodeUtf8, equalBytes, verifyAgentCard, type KeyStore } from '@4thtech-io/crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openAgentStoreWith, type AgentStore } from './agent-store.js';
import { NodeKeyStoreError } from './errors.js';
import { addAgentToOwner } from './index.js';
import { createKeychainAgent, openRecordedKeyStore } from './keychain-keystore.js';
import type { KeychainBackend } from './keychain.js';
import { addAgentWith } from './owner-add-agent.js';
import type { FirstAgentCard } from './owner-first-card.js';
import { initOwnerWith } from './owner-init.js';
import { OWNER_ACCOUNT, ownerItemPresent } from './owner-keystore.js';
import type { OwnerTerminal } from './owner-terminal.js';

const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const RELAYS = ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'];

/** One OS user's keychain. Records every account read. */
class MapKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  readonly accountsRead: string[] = [];
  async get(account: string): Promise<Uint8Array | null> {
    await Promise.resolve();
    this.accountsRead.push(account);
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
const opened: Agent[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-owner-recovery-'));
  keychain = new MapKeychain();
});
afterEach(async () => {
  for (const agent of opened.splice(0)) {
    await agent.keyStore.close();
    await agent.store.close();
  }
  await rm(dir, { recursive: true, force: true });
});

async function initAgent(label: string): Promise<Agent> {
  const agentId = await createKeychainAgent(keychain);
  const store = await openAgentStoreWith('keychain', agentId, join(dir, `${label}.sqlite`), {
    keychain,
  });
  const keyStore = await openRecordedKeyStore('keychain', agentId, { keychain });
  const now = Math.floor(Date.now() / 1000);
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

const firstCard = (agent: Agent, name: string): FirstAgentCard => ({
  agent: agent.agentId,
  name,
  relays: RELAYS,
  identity: agent.client.identity,
});

/** `owner init` for `agent`; returns the owner card fields and the code it showed. */
async function ownerInit(agent: Agent): Promise<{ code: string; fingerprint: string }> {
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
  const { fingerprint } = await initOwnerWith(
    keychain,
    terminal,
    { backend: 'keychain', env: {}, firstCard: firstCard(agent, 'alice') },
    { kdf: KDF },
  );
  return { code: shown(), fingerprint };
}

/** Removes an agent the way `agentlink remove` does: its keychain items and its store are gone. */
async function removeAgent(agent: Agent): Promise<void> {
  const index = opened.indexOf(agent);
  if (index >= 0) opened.splice(index, 1);
  await agent.keyStore.close();
  await agent.store.close();
  for (const account of [...keychain.items.keys()]) {
    if (account === agent.agentId || account.startsWith(`${agent.agentId}:`)) {
      keychain.items.delete(account);
    }
  }
}

/** The owner at their own terminal: types `entries` in turn and answers `answer` to questions. */
function ownerTyping(entries: readonly string[], answer = true) {
  const written: string[] = [];
  const labels: string[] = [];
  const questions: string[] = [];
  const queue = [...entries];
  const terminal: OwnerTerminal = {
    write: (text) => void written.push(text),
    readSecret: (label) => {
      labels.push(label);
      return Promise.resolve(encodeUtf8(queue.shift() ?? ''));
    },
    confirm: (question) => {
      questions.push(question);
      return Promise.resolve(answer);
    },
    clearScreen: () => void written.push('<clear>'),
  };
  return { terminal, written, labels, questions };
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

describe('owner add-agent with no agent naming the owner (M1-9x; 04 §2.8)', () => {
  it('after every agent is removed, a new agent gets a card naming the same owner', async () => {
    const alice = await initAgent('alice');
    const { code, fingerprint } = await ownerInit(alice);
    const aliceCard = (await alice.client.identity.get())?.card;
    if (aliceCard === undefined) throw new Error('missing card');
    await removeAgent(alice);
    const ownerItem = keychain.items.get(OWNER_ACCOUNT)?.slice();

    const bob = await initAgent('bob');
    const run = ownerTyping([code], true);
    const result = await addAgentWith(keychain, run.terminal, {
      backend: 'keychain',
      env: {},
      card: firstCard(bob, 'bob'),
    });

    const b = await bob.client.identity.get();
    if (b === undefined) throw new Error('missing identity');
    expect(verifyAgentCard(b.card, b.cardSig, b.cardAgentSig)).toBe(true);
    expect(b.card.agentEvm).toBe(bob.agentId);
    for (const key of ['ownerEvm', 'ownerNostr', 'ownerEnc'] as const) {
      expect(b.card[key]).toBe(aliceCard[key]);
    }
    expect(result.fingerprint).toBe(fingerprint);
    // One entry of the owner code, then the fingerprint confirmed before anything was signed.
    expect(run.labels).toEqual(['Owner code:']);
    expect(run.questions).toHaveLength(1);
    expect(run.questions[0]).toContain(fingerprint);
    // The owner item is never written.
    const after = keychain.items.get(OWNER_ACCOUNT);
    expect(ownerItem !== undefined && after !== undefined && equalBytes(after, ownerItem)).toBe(
      true,
    );
    // No secret in the output or the result. (@4thtech-io/node has no log channel: ESLint refuses
    // console and process.stdout/stderr there, eslint.config.mjs CONSOLE_SYNTAX.)
    const output = [...run.written, ...run.questions, JSON.stringify(result)].join('\n');
    expect(output).toContain('bob');
    expect(output).not.toContain(code);
    expect(output).not.toContain(code.replaceAll(' ', ''));
  });

  it('warns against a code from the AI before the code is asked for (IR-M1-9x-1 L-1)', async () => {
    const alice = await initAgent('alice');
    const { code } = await ownerInit(alice);
    await removeAgent(alice);
    const bob = await initAgent('bob');
    const run = ownerTyping([code], true);
    let shownBeforePrompt = '';
    const terminal: OwnerTerminal = {
      ...run.terminal,
      readSecret: (label) => {
        shownBeforePrompt = run.written.join('\n');
        return run.terminal.readSecret(label);
      },
    };
    await addAgentWith(keychain, terminal, {
      backend: 'keychain',
      env: {},
      card: firstCard(bob, 'bob'),
    });
    expect(shownBeforePrompt).toContain('If your AI gave you a code');
  });

  it('the session lifetime starts after the fingerprint is confirmed (IR-M1-9x-1 L-2)', async () => {
    const alice = await initAgent('alice');
    const { code } = await ownerInit(alice);
    await removeAgent(alice);
    const bob = await initAgent('bob');
    const run = ownerTyping([code], true);
    // The session's clock (wall and monotonic) is frozen and moves only when the test moves it, so
    // the result never depends on how fast this machine is (a loaded CI runner once took longer
    // than a 50 ms lifetime just to sign and store the card). Timers stay real; the lifetime is
    // long enough that the session's own expiry timer never fires during the test.
    const ttlMs = 60_000;
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    try {
      // A slow owner: the answer comes after two whole session lifetimes have passed.
      const terminal: OwnerTerminal = {
        ...run.terminal,
        confirm: async (question) => {
          vi.advanceTimersByTime(2 * ttlMs);
          return run.terminal.confirm(question);
        },
      };
      // A slow machine: signing and storing the card takes real time, but no session time.
      const card = firstCard(bob, 'bob');
      const slowCard: FirstAgentCard = {
        ...card,
        identity: {
          get: () => card.identity.get(),
          init: async (input) => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            return card.identity.init(input);
          },
        },
      };
      await addAgentWith(
        keychain,
        terminal,
        { backend: 'keychain', env: {}, card: slowCard },
        { ttlMs },
      );
    } finally {
      vi.useRealTimers();
    }
    expect(run.questions).toHaveLength(1);
    expect(await bob.client.identity.get()).toBeDefined();
  });

  it('refuses with an AI-app marker set, before the owner item is read', async () => {
    const alice = await initAgent('alice');
    const { code } = await ownerInit(alice);
    await removeAgent(alice);
    const bob = await initAgent('bob');
    keychain.accountsRead.length = 0;
    const run = ownerTyping([code], true);
    const refused = await failure(() =>
      addAgentWith(keychain, run.terminal, {
        backend: 'keychain',
        env: { CLAUDECODE: '1' },
        card: firstCard(bob, 'bob'),
      }),
    );
    expect(refused.code).toBe('harness_detected');
    expect(keychain.accountsRead).not.toContain(OWNER_ACCOUNT);
    expect(run.labels).toEqual([]);
    expect(run.questions).toEqual([]);
    expect(await bob.client.identity.get()).toBeUndefined();
  });

  it('the public entry refuses with an AI-app marker set, before anything is read', async () => {
    const refused = await failure(() =>
      addAgentToOwner({
        backend: 'keychain',
        env: { GEMINI_CLI: '1' },
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

  it('declining the fingerprint signs nothing and leaves the owner item', async () => {
    const alice = await initAgent('alice');
    const { code } = await ownerInit(alice);
    await removeAgent(alice);
    const ownerItem = keychain.items.get(OWNER_ACCOUNT)?.slice();
    const bob = await initAgent('bob');
    const run = ownerTyping([code], false);
    const refused = await failure(() =>
      addAgentWith(keychain, run.terminal, {
        backend: 'keychain',
        env: {},
        card: firstCard(bob, 'bob'),
      }),
    );
    expect(refused.code).toBe('owner_prompt_cancelled');
    expect(refused.message).not.toContain(code);
    expect(run.questions).toHaveLength(1);
    expect(await bob.client.identity.get()).toBeUndefined();
    const after = keychain.items.get(OWNER_ACCOUNT);
    expect(ownerItem !== undefined && after !== undefined && equalBytes(after, ownerItem)).toBe(
      true,
    );
  });

  it('three wrong entries end the command and nothing is written', async () => {
    const alice = await initAgent('alice');
    await ownerInit(alice);
    await removeAgent(alice);
    const ownerItem = keychain.items.get(OWNER_ACCOUNT)?.slice();
    const bob = await initAgent('bob');
    const wrong = 'AAAA BBBB CCCC DDDD EEEE FFFF';
    const run = ownerTyping([wrong, wrong, wrong, wrong], true);
    const refused = await failure(() =>
      addAgentWith(keychain, run.terminal, {
        backend: 'keychain',
        env: {},
        card: firstCard(bob, 'bob'),
      }),
    );
    expect(refused.code).toBe('owner_secret_refused');
    expect(run.labels).toHaveLength(3);
    expect(run.questions).toEqual([]);
    expect(await bob.client.identity.get()).toBeUndefined();
    const after = keychain.items.get(OWNER_ACCOUNT);
    expect(ownerItem !== undefined && after !== undefined && equalBytes(after, ownerItem)).toBe(
      true,
    );
  });

  it('without an owner item, points to `owner init` before the owner code is asked for', async () => {
    const bob = await initAgent('bob');
    const run = ownerTyping(['AAAA'], true);
    const refused = await failure(() =>
      addAgentWith(keychain, run.terminal, {
        backend: 'keychain',
        env: {},
        card: firstCard(bob, 'bob'),
      }),
    );
    expect(refused.code).toBe('owner_missing');
    expect(refused.message).toContain('agentlink owner init');
    expect(run.labels).toEqual([]);
    expect(await bob.client.identity.get()).toBeUndefined();
  });
});

describe('ownerItemPresent: a store-only check (M1-9x)', () => {
  it('tells whether the owner item exists, reading only the owner account and asking for nothing', async () => {
    expect(await ownerItemPresent(keychain)).toBe(false);
    const alice = await initAgent('alice');
    await ownerInit(alice);
    await removeAgent(alice);
    keychain.accountsRead.length = 0;
    expect(await ownerItemPresent(keychain)).toBe(true);
    expect(keychain.accountsRead).toEqual([OWNER_ACCOUNT]);
  });
});
