// M1-9t (D-78; 04 §2.8 "Adding an agent to the existing owner"; 06 §8): `agentlink owner add-agent
// --agent <name>` †. Several agents under one OS user, the first with a card from the owner; the
// command finds the owner the machine's agents name and hands @agentlink/node exactly the agent
// being added. The owner step itself stands in for node's `addAgentToOwner` (whose TTY prompt these
// tests cannot drive; node's own tests run the real one against one shared keychain): it signs one
// card for the named agent with the existing owner, as node does.
import { AgentLinkClient, MemoryStore, type ApprovalChannel } from '@agentlink/core';
import {
  decodeBase64url,
  decodeUtf8,
  encodeBase64url,
  encodeHex,
  encodeHex0x,
  encodeUtf8,
  sha256,
  verifyAgentCard,
} from '@agentlink/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@agentlink/crypto/testing';
import type { Sealed, SealContext, StoreCipher } from '@agentlink/core';
import { createLogger } from '@agentlink/log';
import type { AddAgentOptions } from '@agentlink/node';
import { describe, expect, it } from 'vitest';
import {
  ownerCommandHandlers,
  type OwnerAgent,
  type OwnerCommandDeps,
} from '../src/commands/owner/index.js';
import { OWNER_TEXT } from '../src/commands/owner/strings.js';
import { createDispatcher, helpText } from '../src/dispatch.js';
import { createOutput } from '../src/output.js';
import type { TerminalContext } from '../src/runtime/guards.js';

const NOW = 1_800_000_000;
const RELAYS = ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'] as const;
const presence = () => ({ kind: 'passphrase' as const, secret: encodeUtf8('correct horse') });
const TTY: TerminalContext = { stdinIsTTY: true, stdoutIsTTY: true, env: {} };

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

const approvals: ApprovalChannel = {
  request: (r) => Promise.resolve({ approvalId: r.approvalId }),
  status: () => Promise.resolve({ state: 'pending' }),
};

async function newAgent(name: string, seedByte: number): Promise<OwnerAgent> {
  const store = new MemoryStore();
  const cipher = new TestCipher();
  const client = await AgentLinkClient.create({
    keyStore: new MemoryKeyStore(new Uint8Array(32).fill(seedByte)),
    store,
    cipher,
    approvals,
    clock: () => NOW,
    logger: createLogger({ name: 'test', sink: () => undefined }),
    policyMark: { read: () => Promise.resolve(0), raise: (v: number) => Promise.resolve(v) },
  });
  return { name, client, store, cipher, close: () => Promise.resolve() };
}

interface Machine {
  readonly agents: Map<string, OwnerAgent>;
  readonly owner: MemoryOwnerKeyStore;
  readonly calls: AddAgentOptions[];
  readonly out: string[];
  readonly err: string[];
  run(argv: string[], terminal?: TerminalContext): Promise<number>;
}

/** One OS user: `alice` has a card from the owner (after `owner init`); the others have none. */
async function machine(names: readonly string[], aliceHasCard = true): Promise<Machine> {
  const agents = new Map<string, OwnerAgent>();
  let seed = 1;
  for (const name of names) agents.set(name, await newAgent(name, seed++));
  const owner = new MemoryOwnerKeyStore(new Uint8Array(32).fill(77), presence());
  const ownerKeys = await owner.getPublicKeys();
  const alice = agents.get('alice');
  if (aliceHasCard && alice !== undefined) {
    const session = await owner.unlock(presence());
    try {
      await alice.client.identity.init({
        owner: session,
        ownerKeys,
        name: 'alice',
        relays: [...RELAYS],
      });
    } finally {
      await session.close();
    }
  }
  const calls: AddAgentOptions[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: OwnerCommandDeps = {
    listAgents: () => Promise.resolve([...agents.keys()]),
    open: (name) => {
      const agent = agents.get(name ?? 'default');
      return Promise.resolve(
        agent === undefined
          ? { status: 'needs_setup' as const, message: 'not set up' }
          : { status: 'ok' as const, agent },
      );
    },
    backendOf: (name) => Promise.resolve(agents.has(name ?? 'default') ? 'keychain' : undefined),
    initOwner: () => Promise.reject(new Error('not used')),
    // Stands in for node's addAgentToOwner: one card for the named agent, with the existing owner.
    addAgent: async (options) => {
      calls.push(options);
      const session = await owner.unlock(presence());
      try {
        const view = await options.card.identity.init({
          owner: session,
          ownerKeys: options.owner,
          name: options.card.name,
          relays: options.card.relays,
        });
        return { card: view.card, fingerprint: 'test' };
      } finally {
        await session.close();
      }
    },
    decide: () => Promise.reject(new Error('not used')),
    signOwnerAction: () => Promise.reject(new Error('not used')),
    ask: () => Promise.resolve(''),
    now: () => NOW,
    cardRelays: () => RELAYS,
  };
  const dispatch = createDispatcher(ownerCommandHandlers(deps));
  return {
    agents,
    owner,
    calls,
    out,
    err,
    run: (argv, terminal = TTY) =>
      dispatch(argv, {
        output: createOutput({ log: (l) => out.push(l), error: (l) => err.push(l) }),
        terminal,
        version: '0.0.0',
      }),
  };
}

describe('agentlink owner add-agent (M1-9t, D-78)', () => {
  it('gives the named agent a card from the owner the other agents name', async () => {
    const m = await machine(['alice', 'bob']);
    expect(await m.run(['owner', 'add-agent', '--agent', 'bob'])).toBe(0);
    expect(m.calls).toHaveLength(1);
    const call = m.calls[0];
    const bob = m.agents.get('bob');
    const alice = m.agents.get('alice');
    if (call === undefined || bob === undefined || alice === undefined) throw new Error('setup');
    const ownerKeys = await m.owner.getPublicKeys();
    expect(call.owner.ownerNostr).toEqual(ownerKeys.ownerNostr);
    expect(call.owner.ownerEvm).toEqual(ownerKeys.ownerEvm);
    expect(call.card.agent).toBe(bob.client.agentId);
    expect(call.card.name).toBe('bob');
    expect(call.card.relays).toEqual(RELAYS);
    expect(call.backend).toBe('keychain');
    const view = await bob.client.identity.get();
    if (view === undefined) throw new Error('no card');
    expect(verifyAgentCard(view.card, view.cardSig, view.cardAgentSig)).toBe(true);
    expect(view.card.ownerNostr).toBe(encodeHex0x(ownerKeys.ownerNostr));
    expect(view.card.ownerNostr).toBe((await alice.client.identity.get())?.card.ownerNostr);
    expect(m.out.join('\n')).toContain(OWNER_TEXT.addAgentDone);
  });

  it('needs --agent: without it nothing runs', async () => {
    const m = await machine(['alice', 'bob']);
    expect(await m.run(['owner', 'add-agent'])).toBe(2);
    expect(m.calls).toHaveLength(0);
  });

  it('runs only at an interactive terminal with no AI-app marker (UX guard)', async () => {
    const m = await machine(['alice', 'bob']);
    const pipe: TerminalContext = { stdinIsTTY: false, stdoutIsTTY: false, env: {} };
    const marked: TerminalContext = {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      env: { CLAUDECODE: '1' },
    };
    expect(await m.run(['owner', 'add-agent', '--agent', 'bob'], pipe)).toBe(1);
    expect(await m.run(['owner', 'add-agent', '--agent', 'bob'], marked)).toBe(1);
    expect(m.calls).toHaveLength(0);
    expect(await m.agents.get('bob')?.client.identity.get()).toBeUndefined();
  });

  it('refuses when no agent on this computer names an owner yet, and points to owner init', async () => {
    const m = await machine(['alice', 'bob'], false);
    expect(await m.run(['owner', 'add-agent', '--agent', 'bob'])).toBe(1);
    expect(m.calls).toHaveLength(0);
    expect(m.err.join('\n')).toContain(OWNER_TEXT.addAgentNoOwner);
    expect(OWNER_TEXT.addAgentNoOwner).toContain('agentlink owner init');
  });

  it('refuses an agent that is not set up, and points to init --agent', async () => {
    const m = await machine(['alice']);
    expect(await m.run(['owner', 'add-agent', '--agent', 'carol'])).toBe(1);
    expect(m.calls).toHaveLength(0);
    expect(m.err.join('\n')).toContain(OWNER_TEXT.addAgentUnknown);
  });

  it('refuses an agent that already has a card, before the owner step', async () => {
    const m = await machine(['alice', 'bob']);
    expect(await m.run(['owner', 'add-agent', '--agent', 'alice'])).toBe(1);
    expect(m.calls).toHaveLength(0);
    expect(m.err.join('\n')).toContain(OWNER_TEXT.addAgentHasCard);
  });

  it('is listed in --help as an owner command (06 §8)', () => {
    expect(helpText()).toContain('agentlink owner add-agent --agent <name>');
    expect(helpText()).toMatch(/agentlink init .*--harness <id\|none>.*--config <path>/);
  });
});
