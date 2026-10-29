// U3-d (S2; D-138, U3-spec-04; 04 §2.5 "One entry", §2.5.1 `agent.label`, §2.8 "From the local app";
// proposed, owner confirms at merge): the agent's first `agent.label`, signed in the same owner
// gesture as its first card and first policy, and "Add an agent" from the local app.
//
// - signFirstLabel signs only an `agent.label` for exactly this agent and this owner with exactly
//   the label the page showed, within 600 s; anything core prepared that is wider (another agent,
//   another label, another op, a longer life) is never signed.
// - signNewAgent: one unlocked owner session signs exactly the new agent's first card (through the
//   restricted FirstCardSession), its first policy (when the Send folder is ready) and its first
//   label. All or nothing: a bad label signs nothing at all; a label that cannot be applied is a
//   failure (the caller then discards the new agent).
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentLinkClient,
  checkInviteLink,
  decodeInviteLink,
  type ApprovalChannel,
  type OwnerActionOutcome,
  type PreparedOwnerAction,
} from '@4thtech-io/core';
import {
  encodeHex,
  type KeyStore,
  type OwnerPublicKeys,
  type OwnerSession,
} from '@4thtech-io/crypto';
import { MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAgentStoreWith, type AgentStore } from './agent-store.js';
import { createKeychainAgent, openRecordedKeyStore } from './keychain-keystore.js';
import type { KeychainBackend } from './keychain.js';
import { signNewAgent } from './owner-add-agent.js';
import type { FirstAgentCard } from './owner-first-card.js';
import { signFirstLabel, type FirstLabelActions } from './owner-first-label.js';
import { prepareSendFolder } from './owner-first-policy.js';

/** A mutable copy of a prepared body, for the tamper cases. */
type Mut = Record<string, unknown>;

const RELAYS = ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'];

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

interface Agent {
  readonly agentId: string;
  readonly client: AgentLinkClient;
  readonly store: AgentStore;
  readonly keyStore: KeyStore;
}

const PASS = { kind: 'passphrase', secret: new TextEncoder().encode('owner pass phrase') } as const;
const seedOf = (n: number): Uint8Array => new Uint8Array(32).fill(n);

let dir: string;
let home: string;
let keychain: MapKeychain;
let now: number;
const opened: Agent[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-first-label-'));
  home = join(dir, 'home');
  await mkdir(home);
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

/** An owner and one unlocked session, with a log of everything it signed. */
async function ownerSession(n = 7): Promise<{
  readonly keys: OwnerPublicKeys;
  readonly session: OwnerSession;
  readonly signed: string[];
}> {
  const store = new MemoryOwnerKeyStore(seedOf(n), { ...PASS, secret: PASS.secret.slice() });
  const keys = await store.getPublicKeys();
  const inner = await store.unlock({ ...PASS, secret: PASS.secret.slice() });
  const signed: string[] = [];
  const session: OwnerSession = {
    get expiresAt() {
      return inner.expiresAt;
    },
    isActive: () => inner.isActive(),
    sign712: (typed) => {
      signed.push('card');
      return inner.sign712(typed);
    },
    signOwnerAction: (body) => {
      signed.push(String((body as { op?: unknown }).op));
      return inner.signOwnerAction(body);
    },
    signEnvelopeHash: (hash) => inner.signEnvelopeHash(hash),
    signNostr: (event) => inner.signNostr(event),
    nip44Encrypt: (...a) => inner.nip44Encrypt(...a),
    nip44Decrypt: (...a) => inner.nip44Decrypt(...a),
    unwrapCek: (...a) => inner.unwrapCek(...a),
    close: () => inner.close(),
  };
  return { keys, session, signed };
}

const newAgentCard = (
  agent: Agent,
  label: string,
  actions: FirstLabelActions = agent.client.ownerActions,
): FirstAgentCard => ({
  agent: agent.agentId,
  name: 'work-agent',
  relays: RELAYS,
  identity: agent.client.identity,
  firstPolicy: { actions: agent.client.ownerActions, home },
  firstLabel: { label, actions },
});

describe('signNewAgent (U3-d; 04 §2.8 "From the local app")', () => {
  it('one session signs exactly the card, the first policy and the first label', async () => {
    const agent = await initAgent('a');
    const { keys, session, signed } = await ownerSession();
    const plan = await prepareSendFolder(home);
    const outcome = await signNewAgent(session, keys, newAgentCard(agent, 'Work agent'), plan);
    expect(outcome.status).toBe('done');
    expect(signed).toEqual(['card', 'policy.set', 'agent.label']);
    const card = await agent.client.identity.get();
    expect(card?.card.ownerNostr).toBe(`0x${encodeHex(keys.ownerNostr)}`);
    expect(await agent.client.ownerActions.loadLabel()).toEqual({
      status: 'verified',
      label: 'Work agent',
    });
    expect((await agent.client.ownerActions.loadPolicy()).mode).toBe('signed');
  });

  it('with no ready Send folder it signs the card and the label, and the 06 §3 defaults stay', async () => {
    const agent = await initAgent('b');
    const { keys, session, signed } = await ownerSession();
    const outcome = await signNewAgent(session, keys, newAgentCard(agent, 'Second agent'), {
      status: 'refused',
      reason: 'not_empty',
    } as never);
    expect(outcome.status).toBe('done');
    expect(signed).toEqual(['card', 'agent.label']);
    expect((await agent.client.ownerActions.loadPolicy()).mode).toBe('defaults');
  });

  it('U3-d-b: contacts see the label the owner typed, never the folder name', async () => {
    const agent = await initAgent('ana');
    const { keys, session } = await ownerSession();
    // The folder is `work-agent` (newAgentCard); the owner typed "Ana".
    const outcome = await signNewAgent(
      session,
      keys,
      newAgentCard(agent, 'Ana'),
      await prepareSendFolder(home),
    );
    expect(outcome.status).toBe('done');
    // The signed card commits to the typed label (nameHash), and its signatures verify.
    expect((await agent.client.identity.signedCard()).name).toBe('Ana');
    const { inviteUrl } = await agent.client.pairing.createInvite();
    // The invite carries the card's name, and a peer's Accept step 1 (signatures and nameHash
    // checked) shows it under the contact-name rule.
    expect((await decodeInviteLink(inviteUrl)).name).toBe('Ana');
    const peer = await checkInviteLink(inviteUrl, now);
    expect(peer.contact.display).toEqual({
      name: 'Ana',
      label: 'self-declared',
      nameSource: 'counterparty',
    });
  });

  for (const label of ['', 'Work  agent', 'Work‮agent', '<b>Work</b>', 'a'.repeat(33)]) {
    it(`a label that is not its own restricted form signs nothing: ${JSON.stringify(label)}`, async () => {
      const agent = await initAgent('c');
      const { keys, session, signed } = await ownerSession();
      const outcome = await signNewAgent(
        session,
        keys,
        newAgentCard(agent, label),
        await prepareSendFolder(home),
      );
      expect(outcome).toEqual({ status: 'failed' });
      expect(signed).toEqual([]);
      expect(await agent.client.identity.get()).toBeUndefined();
    });
  }

  it('a label that cannot be applied is a failure (the caller discards the agent)', async () => {
    const agent = await initAgent('d');
    const { keys, session } = await ownerSession();
    const actions: FirstLabelActions = {
      prepareLabel: (label) => agent.client.ownerActions.prepareLabel(label),
      apply: () => Promise.reject(new Error('store gone')),
    };
    const outcome = await signNewAgent(
      session,
      keys,
      newAgentCard(agent, 'Work agent', actions),
      await prepareSendFolder(home),
    );
    expect(outcome).toEqual({ status: 'failed' });
  });
});

describe('signFirstLabel (U3-d): only exactly this agent, owner and label', () => {
  async function carded(): Promise<{
    agent: Agent;
    keys: OwnerPublicKeys;
    session: OwnerSession;
    signed: string[];
  }> {
    const agent = await initAgent('e');
    const owner = await ownerSession();
    const plan = { status: 'refused', reason: 'not_empty' } as never;
    // The card and a first label ("Start"); signFirstLabel then runs on its own.
    const done = await signNewAgent(owner.session, owner.keys, newAgentCard(agent, 'Start'), plan);
    expect(done.status).toBe('done');
    return { agent, ...owner };
  }

  it('refuses a prepared body that is wider than the label the page showed', async () => {
    const { agent, keys, session, signed } = await carded();
    const tamper = (edit: (body: Mut) => void): FirstLabelActions => ({
      prepareLabel: async (label) => {
        const prepared = await agent.client.ownerActions.prepareLabel(label);
        if (prepared.status !== 'prepared') return prepared;
        const body = JSON.parse(JSON.stringify(prepared.body)) as Mut;
        edit(body);
        return { ...prepared, body } as unknown as PreparedOwnerAction;
      },
      apply: (input) => agent.client.ownerActions.apply(input),
    });
    const other = '0x' + '77'.repeat(20);
    for (const edit of [
      (b: Mut) => void ((b['params'] as Mut)['label'] = 'Other'),
      (b: Mut) => void ((b['params'] as Mut)['agent'] = other),
      (b: Mut) => void (b['agent'] = other),
      (b: Mut) => void (b['op'] = 'contact.rename'),
      (b: Mut) => void (b['expiresAt'] = Number(b['issuedAt']) + 601),
      (b: Mut) => void (b['owner'] = 'ab'.repeat(32)),
      (b: Mut) => void (b['extra'] = 1),
    ]) {
      const before = signed.length;
      const result = await signFirstLabel(session, agent.agentId, keys, {
        label: 'Home',
        actions: tamper(edit),
      });
      expect(result).toBe('not_saved');
      expect(signed.length).toBe(before);
    }
    expect(await agent.client.ownerActions.loadLabel()).toEqual({
      status: 'verified',
      label: 'Start',
    });
  });

  it('signs and applies the exact body, and reports a refusal from core as not saved', async () => {
    const { agent, keys, session } = await carded();
    expect(
      await signFirstLabel(session, agent.agentId, keys, {
        label: 'Home',
        actions: agent.client.ownerActions,
      }),
    ).toBe('saved');
    expect(await agent.client.ownerActions.loadLabel()).toEqual({
      status: 'verified',
      label: 'Home',
    });
    const refusing: FirstLabelActions = {
      prepareLabel: (label) => agent.client.ownerActions.prepareLabel(label),
      apply: (): Promise<OwnerActionOutcome> =>
        Promise.resolve({ status: 'refused', op: 'agent.label', reason: 'nonce_used' } as never),
    };
    expect(
      await signFirstLabel(session, agent.agentId, keys, { label: 'Home', actions: refusing }),
    ).toBe('not_saved');
  });
});
