// M1-8h (IR-M1-9b-1 M-3): `owner init` signs the agent's first card in the same owner operation
// (04 §2.5: "the card signature at owner setup"). Before this, nothing in production signed a card,
// so an agent set up with `init` + `owner init` had no identity: approvals ended at `noIdentity` and
// pairing failed with `identity_missing`.
//
// Here against the real Node pieces: the keychain agent KeyStore (what `init` creates), the SQLite
// store, the keychain owner store and the core client, with a NIP-01 relay double as the network.
// - One code entry: the owner re-types the last group of the generated code once and types nothing
//   else; the card is signed with the code still in memory, then everything is wiped.
// - The card is stored through core `identity.init`, so the agent is pairable: two agents set up this
//   way pair through invite and accept.
// - Never replaces: an agent that already has a card refuses before any code is shown.
// - All or nothing: if the card cannot be issued, the new owner item is removed again, so `owner init`
//   can simply be run again.
// - The session handed to core signs exactly one AgentCard, for this agent and this owner, and
//   nothing else.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentLinkClient,
  nostrTransport,
  type ApprovalChannel,
  type InitIdentityInput,
} from '@agentlink/core';
import {
  AGENT_CARD_DOMAIN,
  AGENT_CARD_TYPES,
  encodeHex,
  encodeHex0x,
  verifyAgentCard,
  type KeyStore,
  type NostrEvent,
  type OwnerSession,
  type TypedData,
} from '@agentlink/crypto';
import type {
  RelayConnector,
  RelaySocket,
  RelaySocketHandlers,
  RelayTarget,
} from '@agentlink/transport-nostr';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAgentStoreWith, type AgentStore } from './agent-store.js';
import { NodeKeyStoreError } from './errors.js';
import { initOwner } from './index.js';
import { createKeychainAgent, openRecordedKeyStore } from './keychain-keystore.js';
import type { KeychainBackend } from './keychain.js';
import { initOwnerWith, type FirstAgentCard } from './owner-init.js';
import { KeychainOwnerKeyStore, OWNER_ACCOUNT } from './owner-keystore.js';
import type { OwnerTerminal } from './owner-terminal.js';

const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const NOW = 1_800_000_000;
const REFUSED = "AgentLink doesn't sign this with your owner key. Nothing was signed.";

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

interface Filter {
  kinds?: number[];
  '#p'?: string[];
  since?: number;
  until?: number;
  limit?: number;
}

/** A NIP-01 relay double (EVENT/OK, REQ/EVENT/EOSE) shared by both agents. */
class RelayNetwork implements RelayConnector {
  readonly stored = new Map<string, NostrEvent[]>();
  open(target: RelayTarget, handlers: RelaySocketHandlers): RelaySocket {
    let closed = false;
    const push = (frame: unknown): void => {
      void Promise.resolve().then(() => {
        if (!closed) handlers.onMessage(JSON.stringify(frame));
      });
    };
    void Promise.resolve().then(() => handlers.onOpen());
    return {
      send: (text: string) => {
        const frame = JSON.parse(text) as unknown[];
        if (frame[0] === 'EVENT') {
          const event = frame[1] as NostrEvent;
          const list = this.stored.get(target.url) ?? [];
          if (!list.some((e) => e.id === event.id)) list.push(event);
          this.stored.set(target.url, list);
          push(['OK', event.id, true, '']);
        } else if (frame[0] === 'REQ') {
          const subId = frame[1] as string;
          const filter = frame[2] as Filter;
          const events = (this.stored.get(target.url) ?? []).filter((e) => matches(filter, e));
          for (const e of events.slice(0, filter.limit ?? events.length)) {
            push(['EVENT', subId, e]);
          }
          push(['EOSE', subId]);
        }
      },
      close: () => {
        closed = true;
      },
    };
  }
}

function matches(filter: Filter, event: NostrEvent): boolean {
  if (filter.kinds !== undefined && !filter.kinds.includes(event.kind)) return false;
  const wanted = filter['#p'];
  if (wanted !== undefined && !event.tags.some((t) => t[0] === 'p' && wanted.includes(t[1] ?? ''))) {
    return false;
  }
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  return filter.until === undefined || event.created_at <= filter.until;
}

const approvals: ApprovalChannel = {
  request: (request) => Promise.resolve({ approvalId: request.approvalId }),
  status: () => Promise.resolve({ state: 'pending' }),
};

/** The owner's terminal for `owner init`: re-types the last group of the code it was shown. */
function ownerAtTerminal() {
  const written: string[] = [];
  const labels: string[] = [];
  const terminal: OwnerTerminal = {
    write: (text) => void written.push(text),
    readSecret: (label) => {
      labels.push(label);
      const line = written.find((t) => t.startsWith('Your owner code: ')) ?? '';
      return Promise.resolve(new TextEncoder().encode(line.slice(-4)));
    },
    confirm: () => Promise.resolve(false),
    clearScreen: () => void written.push('<clear>'),
  };
  return { terminal, written, labels };
}

interface Agent {
  readonly keychain: MapKeychain;
  readonly agentId: string;
  readonly client: AgentLinkClient;
  readonly store: AgentStore;
  readonly keyStore: KeyStore;
}

let dir: string;
let net: RelayNetwork;
const opened: Agent[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-first-card-'));
  net = new RelayNetwork();
});
afterEach(async () => {
  for (const agent of opened.splice(0)) {
    await agent.keyStore.close();
    await agent.store.close();
  }
  await rm(dir, { recursive: true, force: true });
});

/** What `agentlink init` leaves: the agent identity in the keychain, a store, no card yet. */
async function initAgent(label: string): Promise<Agent> {
  const keychain = new MapKeychain();
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
    clock: () => NOW,
    transport: nostrTransport({ connector: net, addressCheck: 'platform' }),
    policyMark: store.policyMark,
  });
  const agent = { keychain, agentId, client, store, keyStore };
  opened.push(agent);
  return agent;
}

const firstCard = (agent: Agent, name: string, relays: readonly string[]): FirstAgentCard => ({
  agent: agent.agentId,
  name,
  relays,
  identity: agent.client.identity,
});

const ALPHA = ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'];
const BETA = ['wss://one.relay-beta.net', 'wss://two.relay-beta.net'];

async function ownerInit(agent: Agent, card: FirstAgentCard | undefined) {
  const run = ownerAtTerminal();
  const result = await initOwnerWith(
    agent.keychain,
    run.terminal,
    { backend: 'keychain', env: {}, ...(card === undefined ? {} : { firstCard: card }) },
    { kdf: KDF },
  );
  return { result, run };
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

describe('owner init signs the first agent card (M1-8h; 04 §2.5, §2.4)', () => {
  it('issues a verified card naming this agent and the new owner, in one code entry', async () => {
    const alice = await initAgent('alice');
    expect(await alice.client.identity.get()).toBeUndefined();
    const { result, run } = await ownerInit(alice, firstCard(alice, 'Alice', ALPHA));

    const view = await alice.client.identity.get();
    if (view === undefined) throw new Error('no identity after owner init');
    expect(verifyAgentCard(view.card, view.cardSig, view.cardAgentSig)).toBe(true);
    expect(view.card.agentEvm).toBe(alice.agentId);
    expect(view.card.ownerNostr).toBe(encodeHex0x(result.owner.ownerNostr));
    expect(view.card.ownerEvm).toBe(encodeHex0x(result.owner.ownerEvm));
    expect(view.card.ownerEnc).toBe(encodeHex0x(result.owner.ownerEnc));
    expect(result.card).toEqual(view.card);
    // One code entry: the re-type of the generated code, and no second prompt for the card.
    expect(run.labels).toHaveLength(1);
    // The owner is told only once the card is stored.
    expect(run.written.at(-1)).toContain('Owner set up.');
    // The stored owner unlocks with the code that was shown (it is the one the card names).
    expect(alice.keychain.items.has(OWNER_ACCOUNT)).toBe(true);
  });

  it('end to end: two agents set up with init + owner init pair through invite and accept', async () => {
    const alice = await initAgent('alice');
    const bob = await initAgent('bob');
    await ownerInit(alice, firstCard(alice, 'Alice', ALPHA));
    await ownerInit(bob, firstCard(bob, 'Bob', BETA));

    const invite = await alice.client.pairing.createInvite();
    // The CLI's `accept` passes `allowed` after the policy or the owner's approval allowed it.
    await bob.client.pairing.acceptInvite({ link: invite.inviteUrl, allowed: true });
    await bob.client.outbox.processDue();
    await alice.client.syncInbox();
    await alice.client.outbox.processDue();
    await bob.client.syncInbox();

    const atAlice = await alice.client.contacts.list();
    const atBob = await bob.client.contacts.list();
    expect(atAlice.map((c) => c.id)).toEqual([bob.agentId]);
    expect(atBob.map((c) => c.id)).toEqual([alice.agentId]);
  });

  it('never replaces a card: an agent that has one refuses before a code is shown', async () => {
    const alice = await initAgent('alice');
    await ownerInit(alice, firstCard(alice, 'Alice', ALPHA));
    const before = await alice.client.identity.get();
    // A second owner, on a keychain without the first owner's item (another device's keychain).
    alice.keychain.items.delete(OWNER_ACCOUNT);
    const run = ownerAtTerminal();
    const refused = await failure(() =>
      initOwnerWith(
        alice.keychain,
        run.terminal,
        { backend: 'keychain', env: {}, firstCard: firstCard(alice, 'Mallory', ALPHA) },
        { kdf: KDF },
      ),
    );
    expect(refused.code).toBe('owner_exists');
    expect(run.written.some((t) => t.startsWith('Your owner code: '))).toBe(false);
    expect(alice.keychain.items.has(OWNER_ACCOUNT)).toBe(false);
    expect(await alice.client.identity.get()).toEqual(before);
  });

  it('all or nothing: a card that cannot be issued leaves no owner item, and a re-run works', async () => {
    const alice = await initAgent('alice');
    const run = ownerAtTerminal();
    // Two identical relays: core refuses the list, after the code was shown and stored.
    const bad = firstCard(alice, 'Alice', ['wss://one.relay-alpha.net', 'wss://one.relay-alpha.net']);
    const refused = await failure(() =>
      initOwnerWith(
        alice.keychain,
        run.terminal,
        { backend: 'keychain', env: {}, firstCard: bad },
        { kdf: KDF },
      ),
    );
    expect(refused).toEqual({
      code: 'owner_card_failed',
      message:
        "Your agent's card couldn't be signed, so the owner wasn't saved. Run `agentlink owner init` again.",
    });
    expect(run.written.some((t) => t.startsWith('Owner set up.'))).toBe(false);
    expect(alice.keychain.items.has(OWNER_ACCOUNT)).toBe(false);
    expect(await alice.client.identity.get()).toBeUndefined();
    await ownerInit(alice, firstCard(alice, 'Alice', ALPHA));
    expect(await alice.client.identity.get()).toBeDefined();
  });

  it('refuses a card for another agent than the one being set up (no owner item kept)', async () => {
    const alice = await initAgent('alice');
    const bob = await initAgent('bob');
    // Alice's owner init, but the identity service is Bob's: the card would name Bob's keys.
    const crossed: FirstAgentCard = { ...firstCard(alice, 'Alice', ALPHA), identity: bob.client.identity };
    const refused = await failure(() => ownerInit(alice, crossed));
    expect(refused.code).toBe('owner_card_failed');
    expect(alice.keychain.items.has(OWNER_ACCOUNT)).toBe(false);
    expect(await bob.client.identity.get()).toBeUndefined();
  });

  it('the session handed to core signs one AgentCard for this agent and owner, and nothing else', async () => {
    const alice = await initAgent('alice');
    const seen: { refusals: string[]; signed: number } = { refusals: [], signed: 0 };
    const probe = async (owner: OwnerSession, input: InitIdentityInput) => {
      const card = {
        version: 1,
        agentEvm: alice.agentId,
        agentNostr: encodeHex0x(new Uint8Array(32).fill(7)),
        agentEnc: encodeHex0x(new Uint8Array(32).fill(8)),
        ownerEvm: encodeHex0x(input.ownerKeys.ownerEvm),
        ownerNostr: encodeHex0x(input.ownerKeys.ownerNostr),
        ownerEnc: encodeHex0x(input.ownerKeys.ownerEnc),
        nameHash: encodeHex0x(new Uint8Array(32)),
        relaysHash: encodeHex0x(new Uint8Array(32)),
        issuedAt: NOW,
        expiresAt: 0,
        keyEpoch: 0,
      };
      const typed = (message: Record<string, unknown>): TypedData => ({
        types: AGENT_CARD_TYPES,
        primaryType: 'AgentCard',
        domain: AGENT_CARD_DOMAIN,
        message,
      });
      const attempts: [string, () => Promise<unknown>][] = [
        ['owner action', () => owner.signOwnerAction({ v: 1, owner: encodeHex(input.ownerKeys.ownerNostr) })],
        ['envelope', () => owner.signEnvelopeHash(new Uint8Array(32))],
        ['nostr event', () => owner.signNostr({ kind: 13, created_at: NOW, tags: [], content: '' })],
        ['nip44', () => owner.nip44Encrypt('00'.repeat(32), 'x')],
        ['other agent', () => owner.sign712(typed({ ...card, agentEvm: `0x${'cd'.repeat(20)}` }))],
        ['other owner', () => owner.sign712(typed({ ...card, ownerNostr: encodeHex0x(new Uint8Array(32).fill(9)) }))],
        [
          'other typed data',
          () =>
            owner.sign712({
              types: { EIP712Domain: [{ name: 'name', type: 'string' }], Note: [{ name: 't', type: 'string' }] },
              primaryType: 'Note',
              domain: { name: 'x' },
              message: { t: 'x' },
            }),
        ],
      ];
      for (const [why, attempt] of attempts) {
        const refused = await failure(attempt);
        expect(refused, why).toEqual({ code: 'owner_operation_refused', message: REFUSED });
        seen.refusals.push(why);
      }
      await owner.sign712(typed(card));
      seen.signed += 1;
      // A second card in the same operation is refused.
      expect(await failure(() => owner.sign712(typed(card)))).toEqual({
        code: 'owner_operation_refused',
        message: REFUSED,
      });
      throw new Error('probe done');
    };
    const card: FirstAgentCard = {
      ...firstCard(alice, 'Alice', ALPHA),
      identity: {
        get: () => alice.client.identity.get(),
        init: (input) => probe(input.owner, input),
      },
    };
    const refused = await failure(() => ownerInit(alice, card));
    expect(refused.code).toBe('owner_card_failed');
    expect(seen).toEqual({ refusals: expect.any(Array) as unknown, signed: 1 });
    expect(seen.refusals).toHaveLength(7);
    expect(alice.keychain.items.has(OWNER_ACCOUNT)).toBe(false);
  });

  it('the public initOwner refuses to run without the first card to sign', async () => {
    const refused = await failure(() =>
      initOwner({ backend: 'keychain', env: {} } as unknown as Parameters<typeof initOwner>[0]),
    );
    expect(refused.code).toBe('owner_operation_invalid');
  });

  it('keeps the owner key and the card consistent: the stored owner unlocks to the card owner', async () => {
    const alice = await initAgent('alice');
    const { result, run } = await ownerInit(alice, firstCard(alice, 'Alice', ALPHA));
    const code = (run.written.find((t) => t.startsWith('Your owner code: ')) ?? '').slice(
      'Your owner code: '.length,
    );
    const ownerStore = await KeychainOwnerKeyStore.open(alice.keychain, result.owner);
    const session = await ownerStore.unlock({
      kind: 'passphrase',
      secret: new TextEncoder().encode(code),
    });
    await session.close();
    await ownerStore.close();
  });
});
