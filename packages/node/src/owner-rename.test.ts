// W4-RENAME-REACHES-CONTACTS (S2; D-141; 04 §2.5 "One entry", §2.5.1 `agent.label`, §2.6; 08 §1):
// the rename gesture's owner part, against the real Node pieces (one keychain double holding the
// agent and the owner items, the SQLite store, the keychain owner store and the core client).
//
// - One gesture: with one unlocked owner session, `signRename` signs exactly the agent's next card
//   (keyEpoch + 1, the new name, this agent and owner only; RenameCardSession) and then exactly the
//   `agent.label` core prepared for that label. The card commits first; the label is signed after.
// - The epoch advances through the agent's own key-epoch item (KeyEpochControl), and the control
//   takes only this gesture's card session.
// - Refused before anything is signed: the 4th rename in 24 h (`rename_limited`), an unfinished
//   rotation (`rotation_pending`), a label body that is not exactly the one for this agent and label.
// - A process that has the agent open (an AI app's `agentlink mcp`) is at the new epoch after it.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLinkClient, type ApprovalChannel } from '@4thtech-io/core';
import {
  encodeHex,
  encodeHex0x,
  agentCardNameHash,
  type JsonObject,
  type KeyStore,
  type OwnerPublicKeys,
  type OwnerSession,
} from '@4thtech-io/crypto';
import { generateSecretCode } from '@4thtech-io/crypto/keystore';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAgentStoreWith, type AgentStore } from './agent-store.js';
import { createKeyExportControl, createKeyImportControl } from './key-controls.js';
import { createRestoreQuarantine, installRestoredStore } from './restore-quarantine.js';
import { epochKeysOf } from './key-epoch.js';
import { createKeychainAgent, openRecordedKeyStore } from './keychain-keystore.js';
import { keychainAccount, type KeychainBackend } from './keychain.js';
import { KeychainOwnerKeyStore, newOwnerSeed, storeOwnerSeed } from './owner-keystore.js';
import { RenameCardSession, signRename } from './owner-rename.js';

const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const RELAYS = ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'];
const DAY = 86_400;

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
  readonly store: AgentStore;
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
  dir = await mkdtemp(join(tmpdir(), 'agentlink-rename-'));
  keychain = new MapKeychain();
  now = 1_800_000_000;
});
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

async function openClient(agentId: string, store: AgentStore) {
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
  return { keyStore, client };
}

async function world(): Promise<World> {
  const agentId = await createKeychainAgent(keychain);
  const store = await openAgentStoreWith('keychain', agentId, join(dir, 'agent.sqlite'), {
    keychain,
  });
  closers.push(() => store.close());
  const { keyStore, client } = await openClient(agentId, store);
  const { seed, keys } = newOwnerSeed();
  const code = generateSecretCode();
  await storeOwnerSeed(keychain, seed, { secret: code, secretKind: 1 }, { kdf: KDF });
  const owner = await KeychainOwnerKeyStore.open(keychain, keys);
  closers.push(() => owner.close());
  const session = await owner.unlock({ kind: 'passphrase', secret: code.slice() });
  await client.identity.init({ owner: session, ownerKeys: keys, name: 'My agent', relays: RELAYS });
  await session.close();
  return { agentId, client, store, keyStore, owner, ownerKeys: keys, code };
}

const unlock = (w: World): Promise<OwnerSession> =>
  w.owner.unlock({ kind: 'passphrase', secret: w.code.slice() });

async function labelBody(w: World, label: string): Promise<JsonObject> {
  const prepared = await w.client.ownerActions.prepareLabel(label);
  if (prepared.status !== 'prepared') throw new Error('test: label not prepared');
  return prepared.body as unknown as JsonObject;
}

const review = (label: string) => ({ lines: [`Rename My agent to ${label}`] });

async function rename(w: World, label: string) {
  const token = epochKeysOf(w.keyStore);
  if (token === undefined) throw new Error('test: no epoch keys');
  const session = await unlock(w);
  try {
    return await signRename(session, w.ownerKeys, {
      agent: w.agentId,
      client: w.client,
      epochKeys: token,
      review: review(label),
      label,
      labelBody: await labelBody(w, label),
    });
  } finally {
    await session.close();
  }
}

describe('signRename: one gesture signs the next card, then the label (D-141)', () => {
  it('rotates to the new name, moves the key-epoch item, and returns the signed label', async () => {
    const w = await world();
    const before = await w.client.identity.signedCard();
    const outcome = await rename(w, 'Home');
    expect(outcome.status).toBe('signed');
    if (outcome.status !== 'signed') return;
    const after = await w.client.identity.signedCard();
    expect(after.card.keyEpoch).toBe(1);
    expect(after.name).toBe('Home');
    expect(after.card.agentNostr).not.toBe(before.card.agentNostr);
    expect(after.card.ownerEvm).toBe(before.card.ownerEvm);
    expect(keychain.items.get(keychainAccount(w.agentId, 'key-epoch'))).toEqual(
      Uint8Array.from('1', (c) => c.charCodeAt(0)),
    );
    expect(await w.client.identity.sendState()).toBe('ready');
    // The label: exactly the prepared `agent.label`, owner-signed; core applies it.
    expect(outcome.label.body['op']).toBe('agent.label');
    expect((outcome.label.body['params'] as JsonObject)['label']).toBe('Home');
    const applied = await w.client.ownerActions.apply(outcome.label);
    expect(applied.status).toBe('applied');
    const reading = await w.client.ownerActions.loadLabel();
    expect(reading).toMatchObject({ status: 'verified', label: 'Home' });
  });

  it('refuses the 4th rename in 24 h before anything is signed (rename_limited)', async () => {
    const w = await world();
    for (const label of ['One', 'Two', 'Three']) {
      expect((await rename(w, label)).status).toBe('signed');
      now += 60;
    }
    const fourth = await rename(w, 'Four');
    expect(fourth).toMatchObject({ status: 'refused', reason: 'rename_limited' });
    if (fourth.status === 'refused') expect(fourth.retryAt).toBe(1_800_000_000 + DAY);
    expect((await w.client.identity.get())?.keyEpoch).toBe(3);
    expect(await w.client.identity.cardName()).toBe('Three');
  });

  it('refuses a label body that is not exactly the one for this agent and label', async () => {
    const w = await world();
    const token = epochKeysOf(w.keyStore);
    if (token === undefined) throw new Error('test: no epoch keys');
    const session = await unlock(w);
    const other = await labelBody(w, 'Work');
    const outcome = await signRename(session, w.ownerKeys, {
      agent: w.agentId,
      client: w.client,
      epochKeys: token,
      review: review('Home'),
      label: 'Home',
      labelBody: other,
    });
    await session.close();
    expect(outcome).toMatchObject({ status: 'refused', reason: 'not_applied' });
    expect((await w.client.identity.get())?.keyEpoch).toBe(0);
  });

  it('a process with the agent open is at the new epoch afterwards (never the old one)', async () => {
    const w = await world();
    // An AI app's `agentlink mcp`: its own KeyStore and client on the same store.
    const mcp = await openClient(w.agentId, w.store);
    expect(await mcp.client.identity.sendState()).toBe('ready');
    await rename(w, 'Home');
    expect(await mcp.client.identity.sendState()).toBe('ready');
    const seen = await mcp.client.identity.signedCard();
    expect(seen.card.keyEpoch).toBe(1);
    const bundle = await mcp.keyStore.getPublicBundle();
    expect(encodeHex0x(bundle.agentNostr)).toBe(seen.card.agentNostr);
  });
});

describe('RenameCardSession: exactly one card, for this agent, epoch and name', () => {
  it('signs one matching card and refuses another agent, epoch, name or a second card', async () => {
    const w = await world();
    const inner = await unlock(w);
    const signed = await w.client.identity.signedCard();
    const card = signed.card;
    const wrapper = new RenameCardSession(inner, w.agentId, w.ownerKeys, {
      keyEpoch: 1,
      name: 'Home',
    });
    const typed = (over: Record<string, unknown>) =>
      ({
        domain: { name: 'AgentLink', version: '1' },
        types: {},
        primaryType: 'AgentCard',
        message: {
          ...card,
          keyEpoch: 1,
          nameHash: encodeHex0x(agentCardNameHash('Home')),
          ...over,
        },
      }) as never;
    await expect(wrapper.sign712(typed({ nameHash: card.nameHash }))).rejects.toThrow();
    await expect(wrapper.sign712(typed({ keyEpoch: 2 }))).rejects.toThrow();
    await expect(
      wrapper.sign712(typed({ agentEvm: `0x${encodeHex(new Uint8Array(20).fill(9))}` })),
    ).rejects.toThrow();
    await expect(wrapper.signOwnerAction()).rejects.toThrow();
    expect(wrapper.signed).toBe(0);
    await wrapper.close();
  });
});

describe('a renamed agent restored from a recovery kit (D-141; 04 §2.3.3; Fable M1)', () => {
  it('rename → export kit → restore on a clean machine → opens at its epoch and can send', async () => {
    const w = await world();
    expect((await rename(w, 'Home')).status).toBe('signed');
    const storePath = join(dir, 'agent.sqlite');
    // Export: the owner's export session, the agent's items and a snapshot of its store.
    const exportSession = await w.owner.unlockForExport({
      kind: 'passphrase',
      secret: w.code.slice(),
    });
    const exporter = createKeyExportControl({
      owner: w.owner,
      itemsOf: () => keychain,
      storePathOf: () => storePath,
      agentlinkDir: join(dir, '.agentlink'),
      kdf: KDF,
    });
    const kitPath = join(dir, 'backup.alkk');
    const snapPath = join(dir, 'snap.sqlite');
    const code = await exporter.sealRecoveryKit(exportSession, {
      kitId: 'AAAAAAAAAAAAAAAAAAAAAA',
      createdAt: now,
      contents: 'full',
      agents: [{ agentId: w.agentId, name: 'helper' }],
      snapshots: async () => {
        const db = new Database(storePath);
        db.prepare('VACUUM INTO ?').run(snapPath);
        db.close();
        const bytes = new Uint8Array(await readFile(snapPath));
        return { length: bytes.length, chunks: [bytes] };
      },
      path: kitPath,
    });
    await exportSession.close();

    // Restore on a clean machine: a new keychain, the kit's items, the checked store.
    const target = new MapKeychain();
    const importer = createKeyImportControl({
      backend: 'keychain',
      keychain: target,
      ownerKeychain: new MapKeychain(),
      kdf: KDF,
      revokedDir: join(dir, 'revoked'),
    });
    const quarantine = createRestoreQuarantine(join(dir, 'q'));
    const handle = await importer.openRecoveryKit(
      new Uint8Array(await readFile(kitPath)),
      { secret: code.slice(), source: 'prompt' },
      { createStoreSink: quarantine.createStoreSink },
    );
    await importer.importAgent(handle, w.agentId);
    const restoredPath = join(dir, 'restored.sqlite');
    await installRestoredStore(handle, w.agentId, restoredPath);
    handle.wipe();
    expect(target.items.get(keychainAccount(w.agentId, 'key-epoch'))).toEqual(
      Uint8Array.from('1', (c) => c.charCodeAt(0)),
    );

    const store = await openAgentStoreWith('keychain', w.agentId, restoredPath, {
      keychain: target,
    });
    closers.push(() => store.close());
    const keyStore = await openRecordedKeyStore('keychain', w.agentId, { keychain: target });
    closers.push(() => keyStore.close());
    // Without the kit's key-epoch the KeyStore would open at 0 and the client refuse to open.
    const client = await AgentLinkClient.create({
      keyStore,
      store: store.store,
      cipher: store.cipher,
      approvals,
      clock: () => now,
      policyMark: store.policyMark,
    });
    expect((await keyStore.getPublicBundle()).keyEpoch).toBe(1);
    const card = await client.identity.signedCard();
    expect(card.card.keyEpoch).toBe(1);
    expect(card.name).toBe('Home');
    expect(await client.identity.sendState()).toBe('ready');
    await expect(client.identity.assertCanSend()).resolves.toBeUndefined();
  });
});
