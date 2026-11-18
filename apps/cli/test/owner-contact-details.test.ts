// RELAY-CARD-MIGRATION (S2; 04 §2.5, §2.6; I-4): `agentlink owner update-contact-details` † and the
// doctor hint.
// - An owner command: the dispatcher's owner guard first (interactive terminal, no AI-harness marker),
//   then the owner flow (@4thtech-io/node, presence at its own prompt) signs the next card with the
//   migrated list. Without presence nothing changes.
// - An ID already on the current list: nothing is asked, nothing is signed.
// - The copy never says "relay" (11 §5).
import { AgentLinkClient, MemoryStore, type ApprovalChannel, type Sealed } from '@4thtech-io/core';
import { encodeBase64url, encodeUtf8 } from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { createLogger } from '@4thtech-io/log';
import { LEGACY_READ_RELAYS } from '@4thtech-io/transport-nostr';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerCommandHandlers, type OwnerCommandDeps } from '../src/commands/owner/index.js';
import { CONTACT_DETAILS_TEXT } from '../src/commands/owner/contact-details.js';
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
let keyStore: MemoryKeyStore;
let owner: MemoryOwnerKeyStore;
let gestures: number;
let refusePresence: boolean;
let run: (terminal?: TerminalContext) => Promise<{ code: number; text: string }>;

async function setUp(relays: readonly string[]): Promise<void> {
  const store = new MemoryStore();
  owner = new MemoryOwnerKeyStore(seed(160), presence());
  keyStore = new MemoryKeyStore(seed(60));
  let mark = 0;
  client = await AgentLinkClient.create({
    keyStore,
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
    relays,
  });
  await session.close();
  gestures = 0;
  refusePresence = false;
  const deps = {
    listAgents: () => Promise.resolve(['alice']),
    open: () =>
      Promise.resolve({
        status: 'ok',
        agent: { name: 'alice', client, store, cipher, close: () => Promise.resolve() },
      }),
    backendOf: () => Promise.resolve('keychain'),
    // Stands in for @4thtech-io/node's owner flow: presence, then the rotation with the new list.
    updateContactDetails: async ({
      agent,
    }: Parameters<NonNullable<OwnerCommandDeps['updateContactDetails']>>[0]) => {
      gestures += 1;
      if (refusePresence) throw Object.assign(new Error('presence'), { code: 'presence_rejected' });
      const migration = await agent.client.identity.relayMigration();
      if (migration.status !== 'needed') return { status: 'refused', reason: 'current' };
      const s = await owner.unlock(presence());
      try {
        await agent.client.identity.rotate({
          owner: s,
          ownerKeys: await owner.getPublicKeys(),
          epochControl: (
            owner as unknown as { epochControl(k: MemoryKeyStore): never }
          ).epochControl(keyStore),
          relays: migration.relays,
        });
      } finally {
        await s.close();
      }
      return { status: 'migrated', contacts: 0 };
    },
    ask: () => Promise.resolve(''),
    now: () => NOW,
    cardRelays: () => [],
  } as unknown as OwnerCommandDeps;
  const dispatch = createDispatcher(ownerCommandHandlers(deps));
  run = async (terminal = OWNER_TTY) => {
    const out: string[] = [];
    const code = await dispatch(['owner', 'update-contact-details', '--id', 'alice'], {
      output: { print: (t) => out.push(t), printError: (t) => out.push(t) },
      terminal,
      version: '0.0.0',
    });
    return { code, text: out.join('\n') };
  };
}

describe('agentlink owner update-contact-details †', () => {
  beforeEach(() => setUp(['wss://nos.lol', 'wss://one.relay-alice.net']));

  it('with owner presence: the card moves to the new list and the ID no longer needs it', async () => {
    const r = await run();
    expect(r.code).toBe(0);
    expect(gestures).toBe(1);
    expect(r.text).toContain(CONTACT_DETAILS_TEXT.done);
    expect(r.text).not.toMatch(/relay/i);
    const card = await client.identity.signedCard();
    for (const legacy of LEGACY_READ_RELAYS) expect(card.relays).not.toContain(legacy);
    expect(await client.identity.relayMigration()).toEqual({ status: 'current' });
  });

  it('refuses piped stdin and an AI-harness terminal before anything is asked', async () => {
    const piped = await run({ stdinIsTTY: false, stdoutIsTTY: true, env: {} });
    expect(piped.code).not.toBe(0);
    expect(piped.text).toContain(DISPATCH_TEXT.notInteractive);
    const harness = await run({ stdinIsTTY: true, stdoutIsTTY: true, env: { CLAUDECODE: '1' } });
    expect(harness.code).not.toBe(0);
    expect(gestures).toBe(0);
    expect((await client.identity.relayMigration()).status).toBe('needed');
  });

  it('a refused presence changes nothing', async () => {
    refusePresence = true;
    const r = await run();
    expect(r.code).not.toBe(0);
    expect((await client.identity.relayMigration()).status).toBe('needed');
  });
});

describe('an ID already up to date', () => {
  beforeEach(() => setUp(['wss://relay.primal.net', 'wss://offchain.pub']));

  it('asks for nothing and says so', async () => {
    const r = await run();
    expect(r.code).toBe(0);
    expect(gestures).toBe(0);
    expect(r.text).toContain(CONTACT_DETAILS_TEXT.current);
  });
});

describe('doctor hint', () => {
  it('the hint names the owner command and never says "relay"', () => {
    expect(CONTACT_DETAILS_TEXT.doctorHint).toContain('owner update-contact-details');
    expect(CONTACT_DETAILS_TEXT.doctorHint).not.toMatch(/relay/i);
  });
});
