// M1-8h (IR-M1-9b-1 M-3): `agentlink owner init` uses node's result. In the same owner operation it
// hands @agentlink/node the agent's first card to sign (04 §2.5: "the card signature at owner setup"),
// stored through core `identity.init`, so an agent is pairable after `init` + `owner init`.
//
// Two agents over a NIP-01 relay double, each with a real core and no identity yet (what `init`
// leaves). `owner init` runs through the real dispatcher and the M1-9b handler. The owner step itself
// stands in for @agentlink/node's `initOwner` (whose TTY prompt these tests cannot drive; node's own
// tests run the real one against the keychain): it creates a test owner (MemoryOwnerKeyStore) and
// does what node does with `firstCard`, one `identity.init` with the owner session. Then the agents
// pair through invite and accept (core pairing; the `invite` and `accept` commands are M1-9l).
import {
  AgentLinkClient,
  MemoryStore,
  nostrTransport,
  type ApprovalChannel,
  type Sealed,
  type SealContext,
  type StoreCipher,
} from '@agentlink/core';
import {
  decodeBase64url,
  decodeUtf8,
  encodeBase64url,
  encodeHex,
  encodeHex0x,
  encodeUtf8,
  sha256,
  verifyAgentCard,
  type NostrEvent,
} from '@agentlink/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@agentlink/crypto/testing';
import { createLogger } from '@agentlink/log';
import { NodeKeyStoreError, type OwnerSetupOptions } from '@agentlink/node';
import type {
  RelayConnector,
  RelaySocket,
  RelaySocketHandlers,
  RelayTarget,
} from '@agentlink/transport-nostr';
import { describe, expect, it } from 'vitest';
import {
  ownerCommandHandlers,
  PROVISIONAL_CARD_RELAYS,
  type OwnerAgent,
  type OwnerCommandDeps,
} from '../src/commands/owner/index.js';
import { createDispatcher } from '../src/dispatch.js';
import { createOutput } from '../src/output.js';

const NOW = 1_800_000_000;
const presence = () => ({ kind: 'passphrase' as const, secret: encodeUtf8('correct horse') });

/** NOT encryption: binds a value to its table, column and row key so tests see sealing (07 §3.1). */
class TestCipher implements StoreCipher {
  seal(context: SealContext, plaintext: string): Promise<Sealed> {
    const body = JSON.stringify([context.table, context.column, context.rowKey, plaintext]);
    return Promise.resolve(`t:${encodeBase64url(encodeUtf8(body))}` as Sealed);
  }
  open(context: SealContext, sealed: Sealed): Promise<string> {
    return Promise.resolve().then(() => {
      const parsed = JSON.parse(decodeUtf8(decodeBase64url(sealed.slice(2)))) as unknown[];
      if (
        parsed[0] !== context.table ||
        parsed[1] !== context.column ||
        parsed[2] !== context.rowKey
      )
        throw new Error('test cipher: wrong context');
      return parsed[3] as string;
    });
  }
  indexDigest(data: Uint8Array): Promise<string> {
    return Promise.resolve(encodeHex(sha256(data)));
  }
}

interface Filter {
  kinds?: number[];
  '#p'?: string[];
  since?: number;
  until?: number;
  limit?: number;
}

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
          const events = (this.stored.get(target.url) ?? []).filter((e) => {
            if (filter.kinds !== undefined && !filter.kinds.includes(e.kind)) return false;
            const wanted = filter['#p'];
            if (
              wanted !== undefined &&
              !e.tags.some((t) => t[0] === 'p' && wanted.includes(t[1] ?? ''))
            )
              return false;
            if (filter.since !== undefined && e.created_at < filter.since) return false;
            return filter.until === undefined || e.created_at <= filter.until;
          });
          for (const e of events.slice(0, filter.limit ?? events.length)) push(['EVENT', subId, e]);
          push(['EOSE', subId]);
        }
      },
      close: () => {
        closed = true;
      },
    };
  }
}

const approvals: ApprovalChannel = {
  request: (r) => Promise.resolve({ approvalId: r.approvalId }),
  status: () => Promise.resolve({ state: 'pending' }),
};

interface Agent {
  readonly name: string;
  readonly client: AgentLinkClient;
  owner?: MemoryOwnerKeyStore;
  readonly setups: OwnerSetupOptions[];
  readonly out: string[];
  readonly err: string[];
  run(argv: string[]): Promise<number>;
}

const RELAYS = ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'] as const;

/** An agent after `agentlink init`: its KeyStore and store exist; it has no card yet. */
async function initAgent(name: string, seedByte: number, net: RelayNetwork): Promise<Agent> {
  const store = new MemoryStore();
  const cipher = new TestCipher();
  const client = await AgentLinkClient.create({
    keyStore: new MemoryKeyStore(new Uint8Array(32).fill(seedByte)),
    store,
    cipher,
    approvals,
    clock: () => NOW,
    transport: nostrTransport({ connector: net, addressCheck: 'platform' }),
    logger: createLogger({ name: 'test', sink: () => undefined }),
    policyMark: { read: () => Promise.resolve(0), raise: (v: number) => Promise.resolve(v) },
  });
  const agent = { name, client, setups: [], out: [], err: [] } as unknown as Agent;
  const opened: OwnerAgent = { name, client, store, cipher, close: () => Promise.resolve() };
  const deps: OwnerCommandDeps = {
    listAgents: () => Promise.resolve([name]),
    open: () => Promise.resolve({ status: 'ok', agent: opened }),
    backendOf: () => Promise.resolve('keychain'),
    // Stands in for @agentlink/node's initOwner: a new owner, then the first card in the same
    // operation (one code entry), as node does with `firstCard`.
    initOwner: async (options) => {
      agent.setups.push(options);
      if (options.cardOwner !== undefined) {
        throw new NodeKeyStoreError(
          'owner_exists',
          "This agent already has an owner. AgentLink won't replace it.",
        );
      }
      const owner = new MemoryOwnerKeyStore(new Uint8Array(32).fill(100 + seedByte), presence());
      const ownerKeys = await owner.getPublicKeys();
      const session = await owner.unlock(presence());
      try {
        const view = await options.firstCard.identity.init({
          owner: session,
          ownerKeys,
          name: options.firstCard.name,
          relays: options.firstCard.relays,
        });
        agent.owner = owner;
        return { owner: ownerKeys, fingerprint: 'test', secretKind: 1, card: view.card };
      } finally {
        await session.close();
      }
    },
    addAgent: () => Promise.reject(new Error('not used')),
    changeOwnerCode: () => Promise.reject(new Error('not used')),
    decide: () => Promise.reject(new Error('not used')),
    signOwnerAction: () => Promise.reject(new Error('not used')),
    ask: () => Promise.resolve(''),
    now: () => NOW,
    cardRelays: () => RELAYS,
  };
  const dispatch = createDispatcher(ownerCommandHandlers(deps));
  agent.run = (argv) =>
    dispatch(argv, {
      output: createOutput({ log: (l) => agent.out.push(l), error: (l) => agent.err.push(l) }),
      terminal: { stdinIsTTY: true, stdoutIsTTY: true, env: {} },
      version: '0.0.0',
    });
  return agent;
}

describe('owner init issues the first agent card (M1-8h; 04 §2.5)', () => {
  it('hands node this agent, its name, the card relays and the identity service', async () => {
    const alice = await initAgent('alice', 1, new RelayNetwork());
    expect(await alice.run(['owner', 'init'])).toBe(0);
    expect(alice.setups).toHaveLength(1);
    const setup = alice.setups[0];
    expect(setup?.backend).toBe('keychain');
    expect(setup?.cardOwner).toBeUndefined();
    expect(setup?.firstCard.agent).toBe(alice.client.agentId);
    expect(setup?.firstCard.name).toBe('alice');
    expect(setup?.firstCard.relays).toEqual(RELAYS);
    expect(alice.err).toEqual([]);
  });

  it('after owner init the agent has a verified card naming the new owner', async () => {
    const alice = await initAgent('alice', 1, new RelayNetwork());
    expect(await alice.client.identity.get()).toBeUndefined();
    expect(await alice.run(['owner', 'init'])).toBe(0);
    const view = await alice.client.identity.get();
    if (view === undefined || alice.owner === undefined)
      throw new Error('no card after owner init');
    expect(verifyAgentCard(view.card, view.cardSig, view.cardAgentSig)).toBe(true);
    expect(view.card.agentEvm).toBe(alice.client.agentId);
    expect(view.card.ownerNostr).toBe(encodeHex0x((await alice.owner.getPublicKeys()).ownerNostr));
  });

  it('a second owner init refuses and keeps the card', async () => {
    const alice = await initAgent('alice', 1, new RelayNetwork());
    expect(await alice.run(['owner', 'init'])).toBe(0);
    const before = await alice.client.identity.get();
    expect(await alice.run(['owner', 'init'])).toBe(1);
    expect(alice.setups[1]?.cardOwner?.ownerNostr).toEqual(
      (await alice.owner?.getPublicKeys())?.ownerNostr,
    );
    expect(await alice.client.identity.get()).toEqual(before);
  });

  it('end to end: init, owner init, then invite and accept pair the two agents', async () => {
    const net = new RelayNetwork();
    const alice = await initAgent('alice', 1, net);
    const bob = await initAgent('bob', 2, net);
    // Before owner init, an agent cannot invite: it has no card.
    await expect(alice.client.pairing.createInvite()).rejects.toMatchObject({
      code: 'identity_missing',
    });

    expect(await alice.run(['owner', 'init'])).toBe(0);
    expect(await bob.run(['owner', 'init'])).toBe(0);

    const invite = await alice.client.pairing.createInvite();
    await bob.client.pairing.acceptInvite({ link: invite.inviteUrl, allowed: true });
    await bob.client.outbox.processDue();
    await alice.client.syncInbox();
    await alice.client.outbox.processDue();
    await bob.client.syncInbox();

    expect((await alice.client.contacts.list()).map((c) => c.id)).toEqual([bob.client.agentId]);
    expect((await bob.client.contacts.list()).map((c) => c.id)).toEqual([alice.client.agentId]);
  });

  it('the production card relays are a valid own list (2 to 8 unique wss URLs)', () => {
    expect(PROVISIONAL_CARD_RELAYS.length).toBeGreaterThanOrEqual(2);
    expect(PROVISIONAL_CARD_RELAYS.length).toBeLessThanOrEqual(8);
    expect(new Set(PROVISIONAL_CARD_RELAYS).size).toBe(PROVISIONAL_CARD_RELAYS.length);
    for (const url of PROVISIONAL_CARD_RELAYS) expect(url).toMatch(/^wss:\/\/[a-z0-9.-]+$/);
  });
});
