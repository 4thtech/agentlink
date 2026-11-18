// SEC-INVITE-CAPS (S2; D-156; owner decision 18 Nov 2026): `agentlink invite` † needs the owner.
// - It is an owner command: an interactive terminal with no AI-harness marker (the dispatcher's
//   owner guard), then owner presence through the owner flow, which signs one `invite.create`
//   (04 §2.5.1) that core verifies before it makes the invite. Such an invite is the owner's: not
//   capped and not counted, and whoever pairs through it is a kept contact.
// - Piped stdin, a harness marker or a refused presence: nothing is made.
// - The AI's own path stays `agentlink_create_invite` (capped, its contacts wait for the owner).
import { AgentLinkClient, MemoryStore, type ApprovalChannel, type Sealed } from '@4thtech-io/core';
import { encodeBase64url, encodeUtf8, type JsonObject } from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { createLogger } from '@4thtech-io/log';
import { beforeEach, describe, expect, it } from 'vitest';
import { inviteOwnerHandler, type OwnerCommandDeps } from '../src/commands/owner/index.js';
import { DISPATCH_TEXT, createDispatcher } from '../src/dispatch.js';
import type { TerminalContext } from '../src/runtime/guards.js';

const NOW = 1_800_000_000;
const seed = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const presence = () => ({ kind: 'passphrase' as const, secret: encodeUtf8('correct horse') });
const silent = createLogger({ name: 'test', sink: () => undefined });
const approvals: ApprovalChannel = {
  request: (r) => Promise.resolve({ approvalId: r.approvalId }),
  status: () => Promise.resolve({ state: 'pending' }),
};

const cipher = {
  seal: (_c: unknown, plaintext: string) => Promise.resolve(`s:${plaintext}` as Sealed),
  open: (_c: unknown, sealed: Sealed) => Promise.resolve(String(sealed).slice(2)),
  indexDigest: (data: Uint8Array) => Promise.resolve(encodeBase64url(data)),
};

const OWNER_TTY: TerminalContext = { stdinIsTTY: true, stdoutIsTTY: true, env: {} };

let client: AgentLinkClient;
let store: MemoryStore;
let owner: MemoryOwnerKeyStore;
let ops: string[];
let refusePresence: boolean;
let run: (terminal?: TerminalContext) => Promise<{ code: number; text: string }>;

beforeEach(async () => {
  store = new MemoryStore();
  owner = new MemoryOwnerKeyStore(seed(150), presence());
  let mark = 0;
  client = await AgentLinkClient.create({
    keyStore: new MemoryKeyStore(seed(50)),
    store,
    cipher,
    approvals,
    clock: () => NOW,
    policyMark: {
      read: () => Promise.resolve(mark),
      raise: (v: number) => {
        mark = Math.max(mark, v);
        return Promise.resolve(mark);
      },
    },
    logger: silent,
  });
  const session = await owner.unlock(presence());
  await client.identity.init({
    owner: session,
    ownerKeys: await owner.getPublicKeys(),
    name: 'Alice',
    relays: ['wss://one.relay-alice.net', 'wss://two.relay-alice.net'],
  });
  await session.close();
  ops = [];
  refusePresence = false;
  const deps: OwnerCommandDeps = {
    listAgents: () => Promise.resolve(['alice']),
    open: () =>
      Promise.resolve({
        status: 'ok',
        agent: { name: 'alice', client, store, cipher, close: () => Promise.resolve() },
      }),
    backendOf: () => Promise.resolve('keychain'),
    initOwner: () => Promise.reject(new Error('not used')),
    addAgent: () => Promise.reject(new Error('not used')),
    changeOwnerCode: () => Promise.reject(new Error('not used')),
    decide: () => Promise.reject(new Error('not used')),
    // Stands in for @4thtech-io/node's owner flow: presence, then exactly this object is signed.
    signOwnerAction: async (_owner, item) => {
      if (item.kind !== 'owner-action') throw new Error('unexpected');
      ops.push(String(item.action['op']));
      if (refusePresence) throw Object.assign(new Error('presence'), { code: 'presence_rejected' });
      const s = await owner.unlock(presence());
      try {
        return {
          kind: 'owner-action',
          signed: { body: item.action, sig: await s.signOwnerAction(item.action as JsonObject) },
        };
      } finally {
        await s.close();
      }
    },
    ask: () => Promise.resolve(''),
    now: () => NOW,
    cardRelays: () => [],
  } as OwnerCommandDeps;
  const dispatch = createDispatcher({ invite: inviteOwnerHandler(deps) });
  run = async (terminal = OWNER_TTY) => {
    const out: string[] = [];
    const code = await dispatch(['invite', '--id', 'alice'], {
      output: { print: (t) => out.push(t), printError: (t) => out.push(t) },
      terminal,
      version: '0.0.0',
    });
    return { code, text: out.join('\n') };
  };
});

const invites = () => store.transaction((tx) => tx.select('invites'));

describe('agentlink invite † (SEC-INVITE-CAPS)', () => {
  it('with owner presence: one invite.create, then an owner invite (not capped, 7 days)', async () => {
    for (let i = 0; i < 5; i += 1) {
      const r = await run();
      expect(r.code).toBe(0);
    }
    expect(ops).toEqual(Array(5).fill('invite.create'));
    const rows = await invites();
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.created_by === 'owner')).toBe(true);
    expect(rows[0]?.expires_at).toBe(NOW + 7 * 86_400);
  });

  it('refuses piped stdin and an AI-harness terminal before anything is asked or made', async () => {
    const piped = await run({ stdinIsTTY: false, stdoutIsTTY: true, env: {} });
    expect(piped.code).not.toBe(0);
    expect(piped.text).toContain(DISPATCH_TEXT.notInteractive);
    const harness = await run({ stdinIsTTY: true, stdoutIsTTY: true, env: { CLAUDECODE: '1' } });
    expect(harness.code).not.toBe(0);
    expect(ops).toEqual([]);
    expect(await invites()).toEqual([]);
  });

  it('a refused presence makes nothing', async () => {
    refusePresence = true;
    const r = await run();
    expect(r.code).not.toBe(0);
    expect(await invites()).toEqual([]);
  });
});
