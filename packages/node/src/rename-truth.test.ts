// WP-1 "Rename truth" (S2; D-141, Decision 46; 04 §2.5.1 `agent.label`, §2.6; 08 §1): the owner's
// case, end to end against the real Node pieces (one keychain double holding the agent and owner
// items, the SQLite store, the keychain owner store and the core client).
//
// An ID made in the terminal has a card named after its folder (`cc-test`). Before D-141 a rename
// in the app signed only `agent.label` ("macbook-agent-1"), so the app showed the new name while the
// card (what every invite and every contact sees) kept the old one. This file reproduces that state,
// shows the app's card-name read reports it, that an invite made in that state carries the old name
// and that the app's invite route now asks for the update first, and that the one repair gesture
// (the same rename with the current label, which rotates) puts the label in the card, so a new
// invite carries the new name.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLinkClient, checkInviteLink, type ApprovalChannel } from '@4thtech-io/core';
import {
  canonicalize,
  parseJson,
  type JsonObject,
  type KeyStore,
  type OwnerPublicKeys,
  type OwnerSession,
} from '@4thtech-io/crypto';
import { generateSecretCode } from '@4thtech-io/crypto/keystore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAgentStoreWith } from './agent-store.js';
import { epochKeysOf } from './key-epoch.js';
import { createKeychainAgent, openRecordedKeyStore } from './keychain-keystore.js';
import type { KeychainBackend } from './keychain.js';
import type { LocalUiContext } from './local-ui/context.js';
import { agentsManageRoutes } from './local-ui/api/agents-manage.js';
import { inviteCreateRoute } from './local-ui/api/invites.js';
import type { LocalUiReadRoute } from './local-ui/route-types.js';
import { KeychainOwnerKeyStore, newOwnerSeed, storeOwnerSeed } from './owner-keystore.js';
import { signRename } from './owner-rename.js';

const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const RELAYS = ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'];

class MapKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  get(account: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.items.get(account)?.slice() ?? null);
  }
  set(account: string, value: Uint8Array): Promise<void> {
    this.items.set(account, value.slice());
    return Promise.resolve();
  }
  delete(account: string): Promise<boolean> {
    return Promise.resolve(this.items.delete(account));
  }
}

const approvals: ApprovalChannel = {
  request: (request) => Promise.resolve({ approvalId: request.approvalId }),
  status: () => Promise.resolve({ state: 'pending' }),
};

interface World {
  readonly agentId: string;
  readonly client: AgentLinkClient;
  readonly keyStore: KeyStore;
  readonly owner: KeychainOwnerKeyStore;
  readonly ownerKeys: OwnerPublicKeys;
  readonly code: Uint8Array;
}

let dir: string;
let keychain: MapKeychain;
let now: number;
const closers: (() => Promise<void>)[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-rename-truth-'));
  keychain = new MapKeychain();
  now = Math.floor(Date.now() / 1000);
});
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

const unlock = (w: World): Promise<OwnerSession> =>
  w.owner.unlock({ kind: 'passphrase', secret: w.code.slice() });

/** `agentlink init` + `owner init` before WP-1: the card is named after the folder, `cc-test`. */
async function terminalId(): Promise<World> {
  const agentId = await createKeychainAgent(keychain);
  const store = await openAgentStoreWith('keychain', agentId, join(dir, 'agent.sqlite'), {
    keychain,
  });
  closers.push(() => store.close());
  const keyStore = await openRecordedKeyStore('keychain', agentId, { keychain });
  closers.push(() => keyStore.close());
  const client = await AgentLinkClient.create({
    keyStore,
    store: store.store,
    cipher: store.cipher,
    approvals,
    clock: () => now,
    policyMark: store.policyMark,
  });
  const { seed, keys } = newOwnerSeed();
  const code = generateSecretCode();
  await storeOwnerSeed(keychain, seed, { secret: code, secretKind: 1 }, { kdf: KDF });
  const owner = await KeychainOwnerKeyStore.open(keychain, keys);
  closers.push(() => owner.close());
  const session = await owner.unlock({ kind: 'passphrase', secret: code.slice() });
  await client.identity.init({ owner: session, ownerKeys: keys, name: 'cc-test', relays: RELAYS });
  await session.close();
  return { agentId, client, keyStore, owner, ownerKeys: keys, code };
}

async function labelBody(w: World, label: string): Promise<JsonObject> {
  const prepared = await w.client.ownerActions.prepareLabel(label);
  if (prepared.status !== 'prepared') throw new Error('test: label not prepared');
  return parseJson(canonicalize(prepared.body as unknown as JsonObject)) as JsonObject;
}

/** A rename in the app before D-141: only `agent.label` was signed, the card stayed. */
async function labelOnlyRename(w: World, label: string): Promise<void> {
  const body = await labelBody(w, label);
  const session = await unlock(w);
  try {
    const sig = await session.signOwnerAction(body);
    const applied = await w.client.ownerActions.apply({ body, sig });
    expect(applied.status).toBe('applied');
  } finally {
    await session.close();
  }
}

/** "Update contacts": the app's rename gesture with the current label (rotates, D-141). */
async function updateContacts(w: World, label: string): Promise<void> {
  const token = epochKeysOf(w.keyStore);
  if (token === undefined) throw new Error('test: no epoch keys');
  const session = await unlock(w);
  try {
    const outcome = await signRename(session, w.ownerKeys, {
      agent: w.agentId,
      client: w.client,
      epochKeys: token,
      review: { lines: [`Rename cc-test to ${label}`] },
      label,
      labelBody: await labelBody(w, label),
    });
    expect(outcome.status).toBe('signed');
    if (outcome.status !== 'signed') return;
    expect((await w.client.ownerActions.apply(outcome.label)).status).toBe('applied');
  } finally {
    await session.close();
  }
}

/** The name a new contact sees in an invite made now. */
async function inviteName(w: World): Promise<string> {
  const created = await w.client.pairing.createInvite({ long: true });
  const checked = await checkInviteLink(created.inviteUrl, now);
  return checked.contact.display.name;
}

/** The app host's context for the open agent, over the real core client. */
function contextOf(w: World): LocalUiContext {
  const client = w.client;
  return {
    client: {
      agentId: w.agentId,
      agent: {
        label: () => client.ownerActions.loadLabel(),
        cardName: () => client.identity.cardName(),
        prepareLabel: (label: string) => client.ownerActions.prepareLabel(label),
        renameAllowance: () => client.identity.renameAllowance(),
        sendState: () => client.identity.sendState(),
      },
    },
    agentsManage: { current: () => 'cc-test', labelSaved: () => Promise.resolve() },
  } as unknown as LocalUiContext;
}

async function cardNameRead(w: World): Promise<unknown> {
  const r = agentsManageRoutes.find(
    (x) => x.path === '/api/ui/agents/card-name',
  ) as LocalUiReadRoute;
  const out = await r.handler(contextOf(w), {
    query: new URLSearchParams(),
  } as never);
  return out.body;
}

async function createInviteInApp(w: World, body: JsonObject): Promise<unknown> {
  const desk = {
    create: (input: { label?: string; long?: true }) => w.client.pairing.createInvite(input),
  };
  const out = await inviteCreateRoute.handler(contextOf(w), body, desk as never);
  // Only the fields compared: a made link never reaches a test report.
  const { error, cardName, label, status } = out.body as Record<string, unknown>;
  return { error, cardName, label, status };
}

describe('WP-1: a terminal-made ID renamed in the app before D-141 (the owner case)', () => {
  it('reproduces it: the app shows the new name, the card and every invite keep the old one', async () => {
    const w = await terminalId();
    await labelOnlyRename(w, 'macbook-agent-1');
    expect(await w.client.ownerActions.loadLabel()).toMatchObject({
      status: 'verified',
      label: 'macbook-agent-1',
    });
    expect(await w.client.identity.cardName()).toBe('cc-test');
    // What a new contact sees: the card's name, not the label.
    expect(await inviteName(w)).toBe('cc-test');
    // The app knows: "Contacts still see cc-test".
    expect(await cardNameRead(w)).toMatchObject({ status: 'differs', cardName: 'cc-test' });
  });

  it('the app asks for the update before it makes an invite while the names differ', async () => {
    const w = await terminalId();
    await labelOnlyRename(w, 'macbook-agent-1');
    expect(await createInviteInApp(w, {})).toEqual({
      error: 'name_update_needed',
      cardName: 'cc-test',
      label: 'macbook-agent-1',
      status: undefined,
    });
    // The owner may still choose to invite under the old name (nothing is signed either way).
    expect(await createInviteInApp(w, { oldName: true })).toMatchObject({ status: 'ok' });
  });

  it('one repair gesture puts the label in the card: a new invite shows the new name', async () => {
    const w = await terminalId();
    await labelOnlyRename(w, 'macbook-agent-1');
    await updateContacts(w, 'macbook-agent-1');
    expect(await w.client.identity.cardName()).toBe('macbook-agent-1');
    expect(await inviteName(w)).toBe('macbook-agent-1');
    expect(await cardNameRead(w)).toEqual({ status: 'same' });
    expect(await createInviteInApp(w, {})).toMatchObject({ status: 'ok' });
  });
});
