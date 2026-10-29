// M1-9i-c (04 §2.2 `s3:<id>`, §2.3.3 export and restore, §2.8 `owner-next`; 07 §9.1; D-115; I-4,
// I-7, I-10): the Node backends of the three owner-flow controls of M1-9i-b2 (KeyExportControl,
// KeyImportControl, StorageCredentialControl), the restore quarantine and the own-storage items.
//
// The same control conformance suite runs against the keychain backend (an in-memory keychain
// double) and the file backend (a temporary `ALKS` directory), so both behave the same. Every Argon2id
// runs at the 04 §2.8 floor (19 MiB, t = 2) to keep the suite fast.
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  CryptoInputError,
  credentialDigest,
  encodeHex,
  encodeUtf8,
  equalBytes,
  type Argon2idParams,
  type KeyImportControl,
  type OwnerSession,
  type RecoveryKitExportRequest,
  type RecoveryKitImport,
  type StorageCredentialControl,
} from '@4thtech-io/crypto';
import {
  deriveAgentId,
  openKeystoreFile,
  openOwnerSeedWithoutCard,
  openRecoveryKit,
  parseStorageCredentialItem,
  sealRecoveryKit,
  type RecoveryKitStoreSink,
  type RecoveryKitStoreSource,
} from '@4thtech-io/crypto/keystore';
import { encodeStorageMark, rowKeyOf } from '@4thtech-io/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createKeyExportControl,
  createKeyImportControl,
  createStorageCredentialControl,
  ownStorageKeysOver,
} from './key-controls.js';
import { unlockFileAgent, fileKeychain, writeAgentFile, OWNER_FILE } from './file-keystore.js';
import { generateSecretCode, newKeystoreKek } from '@4thtech-io/crypto/keystore';
import { withInterProcessLock, type LockHold } from './inter-process-lock.js';
import { createKeychainAgent } from './keychain-keystore.js';
import { keychainAccount, type KeychainBackend } from './keychain.js';
import {
  KeychainOwnerKeyStore,
  OWNER_ACCOUNT,
  OWNER_NEXT_ACCOUNT,
  newOwnerSeed,
  storeOwnerSeed,
} from './owner-keystore.js';
import { createRestoreQuarantine, installRestoredStore } from './restore-quarantine.js';
import { SqliteStore } from './sqlite-store.js';
import { createAgentStoreCipher } from './store-cipher.js';
import { sampleRow } from './store-rows.fixture.js';

const POSIX = process.platform !== 'win32';
const FAST: Argon2idParams = Object.freeze({ memoryKiB: 19456, iterations: 2, parallelism: 1 });
/** The S3 secret canary: built at run time so no source literal looks like a secret. */
const S3_CANARY = ['canary', 's3', 'secret', '9c1d'].join('-');
const ascii = (bytes: Uint8Array): string => String.fromCharCode(...bytes);

class MemoryKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  failSetAfter = Infinity;
  get(account: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.items.get(account)?.slice() ?? null);
  }
  set(account: string, value: Uint8Array): Promise<void> {
    if (this.failSetAfter <= 0) return Promise.reject(new Error(`native ${account}`));
    this.failSetAfter -= 1;
    this.items.set(account, value.slice());
    return Promise.resolve();
  }
  delete(account: string): Promise<boolean> {
    return Promise.resolve(this.items.delete(account));
  }
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'al-9ic-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Owner {
  readonly seed: Uint8Array;
  readonly nostr: Uint8Array;
  readonly code: Uint8Array;
  readonly keychain: MemoryKeychain;
  readonly store: KeychainOwnerKeyStore;
}

/** An owner item under a generated-looking code in `keychain`, and its store. */
async function makeOwner(keychain = new MemoryKeychain()): Promise<Owner> {
  const { seed, keys } = newOwnerSeed();
  const code = generateSecretCode();
  await storeOwnerSeed(keychain, seed, { secret: code, secretKind: 1 }, { kdf: FAST });
  const store = await KeychainOwnerKeyStore.open(keychain, keys);
  return { seed, nostr: keys.ownerNostr, code, keychain, store };
}

const presence = (owner: Owner) => ({ kind: 'passphrase' as const, secret: owner.code.slice() });

/** A real store snapshot (`VACUUM INTO`) whose identity row is `agentId` and card names `ownerHex`. */
async function makeSnapshot(
  agentId: string,
  storeKey: Uint8Array,
  ownerHex: string,
  rowAgentId = agentId,
): Promise<Uint8Array> {
  const dir = await mkdtemp(join(root, 'snap-'));
  const path = join(dir, 'store.sqlite');
  const store = await SqliteStore.open(path);
  const cipher = await createAgentStoreCipher(storeKey);
  const row = await sampleRow('identity', 0, cipher);
  const card = JSON.stringify({ card: { ownerNostr: ownerHex }, cardSig: 'x', cardAgentSig: null });
  const sealedCard = await cipher.seal(
    { table: 'identity', column: 'agent_card_json', rowKey: rowKeyOf([rowAgentId]) },
    card,
  );
  await store.transaction((tx) =>
    tx.insert('identity', { ...row, agent_id: rowAgentId, agent_card_json: sealedCard }),
  );
  await store.close();
  cipher.close();
  const out = join(dir, 'snap.sqlite');
  const db = new Database(path);
  db.prepare('VACUUM INTO ?').run(out);
  db.close();
  return new Uint8Array(await readFile(out));
}

const source = (bytes: Uint8Array) => ({ length: bytes.length, chunks: [bytes] });

/** A keychain agent with a store file and an exportable snapshot. */
async function makeKeychainAgent(owner: Owner, keychain = new MemoryKeychain()) {
  const agentId = await createKeychainAgent(keychain);
  const storeKey = (await keychain.get(keychainAccount(agentId, 'store-key'))) as Uint8Array;
  const snapshot = await makeSnapshot(agentId, storeKey, encodeHex(owner.nostr));
  const dir = await mkdtemp(join(root, 'agent-'));
  return { agentId, keychain, storeKey, snapshot, storePath: join(dir, 'store.sqlite') };
}

async function exportKit(owner: Owner, agent: Awaited<ReturnType<typeof makeKeychainAgent>>) {
  const session = await owner.store.unlockForExport(presence(owner));
  const control = createKeyExportControl({
    owner: owner.store,
    itemsOf: () => agent.keychain,
    storePathOf: () => agent.storePath,
    agentlinkDir: join(root, '.agentlink'),
    kdf: FAST,
  });
  const path = join(root, `kit-${encodeHex(crypto.getRandomValues(new Uint8Array(4)))}.alkk`);
  const code = await control.sealRecoveryKit(session, {
    kitId: 'AAAAAAAAAAAAAAAAAAAAAA',
    createdAt: 1_760_000_000,
    contents: 'full',
    agents: [{ agentId: agent.agentId, name: 'helper' }],
    snapshots: () => Promise.resolve(source(agent.snapshot)),
    path,
  });
  await session.close();
  return { path, code: code.slice(), kit: new Uint8Array(await readFile(path)) };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<unknown> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected ${code}`).toBeDefined();
  expect((error as { code?: unknown }).code).toBe(code);
  return error;
}

// --- KeyExportControl -----------------------------------------------------------------------------

describe.runIf(POSIX)('KeyExportControl (keychain and file items)', () => {
  it('seals an ALKK kit to a new 0600 file and returns the recovery code for display', async () => {
    const owner = await makeOwner();
    const agent = await makeKeychainAgent(owner);
    const { path, code, kit } = await exportKit(owner, agent);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(ascii(kit.subarray(0, 4))).toBe('ALKK');
    expect(code.length).toBe(29);
    const opened = await openRecoveryKit(
      kit,
      { secret: code, source: 'prompt' },
      { createStoreSink: () => memorySink() },
    );
    try {
      expect(equalBytes(opened.ownerSeed, owner.seed)).toBe(true);
      expect(opened.agents.map((a) => a.agentId)).toEqual([agent.agentId]);
      expect(opened.agents[0]?.items.map((i) => i.name)).toEqual(['seed', 'store-key']);
    } finally {
      opened.wipe();
    }
  });

  it('refuses a look-alike, a foreign, an ended and a non-export session (no file is left)', async () => {
    const owner = await makeOwner();
    const agent = await makeKeychainAgent(owner);
    const control = createKeyExportControl({
      owner: owner.store,
      itemsOf: () => agent.keychain,
      storePathOf: () => agent.storePath,
      agentlinkDir: join(root, '.agentlink'),
      kdf: FAST,
    });
    const request = (path: string) => ({
      kitId: 'AAAAAAAAAAAAAAAAAAAAAA',
      createdAt: 1,
      contents: 'full' as const,
      agents: [{ agentId: agent.agentId, name: 'helper' }],
      snapshots: () => Promise.resolve(source(agent.snapshot)),
      path,
    });
    const real = await owner.store.unlockForExport(presence(owner));
    const lookAlike = new Proxy(real, {}) as OwnerSession;
    await expectCode(
      control.sealRecoveryKit(lookAlike, request(join(root, 'a'))),
      'presence_required',
    );
    await expectCode(
      control.sealRecoveryKit({ ...real } as OwnerSession, request(join(root, 'b'))),
      'presence_required',
    );
    const other = await KeychainOwnerKeyStore.open(
      owner.keychain,
      await owner.store.getPublicKeys(),
    );
    const foreign = await other.unlockForExport(presence(owner));
    await expectCode(
      control.sealRecoveryKit(foreign, request(join(root, 'c'))),
      'presence_required',
    );
    const plain = await owner.store.unlock(presence(owner));
    await expectCode(
      control.sealRecoveryKit(plain, request(join(root, 'd'))),
      'operation_not_allowed',
    );
    await real.close();
    await expectCode(control.sealRecoveryKit(real, request(join(root, 'e'))), 'owner_locked');
    const names = await readdir(root);
    for (const name of ['a', 'b', 'c', 'd', 'e']) expect(names).not.toContain(name);
  });

  it('never overwrites a file, refuses ~/.agentlink and deletes the kit on failure', async () => {
    const owner = await makeOwner();
    const agent = await makeKeychainAgent(owner);
    const agentlinkDir = join(root, '.agentlink');
    await import('node:fs/promises').then((fs) => fs.mkdir(agentlinkDir, { mode: 0o700 }));
    const control = createKeyExportControl({
      owner: owner.store,
      itemsOf: () => agent.keychain,
      storePathOf: () => agent.storePath,
      agentlinkDir,
      kdf: FAST,
    });
    const session = await owner.store.unlockForExport(presence(owner));
    const base = {
      kitId: 'AAAAAAAAAAAAAAAAAAAAAA',
      createdAt: 1,
      contents: 'full' as const,
      agents: [{ agentId: agent.agentId, name: 'helper' }],
      snapshots: () => Promise.resolve(source(agent.snapshot)),
    };
    const existing = join(root, 'existing.alkk');
    await writeFile(existing, 'keep me');
    await expect(control.sealRecoveryKit(session, { ...base, path: existing })).rejects.toThrow();
    expect(await readFile(existing, 'utf8')).toBe('keep me');
    await expect(
      control.sealRecoveryKit(session, { ...base, path: join(agentlinkDir, 'kit.alkk') }),
    ).rejects.toThrow();
    expect(await readdir(agentlinkDir)).toEqual([]);
    const failing = join(root, 'failing.alkk');
    await expect(
      control.sealRecoveryKit(session, {
        ...base,
        path: failing,
        snapshots: () => Promise.reject(new Error('snapshot failed')),
      }),
    ).rejects.toThrow();
    expect(await readdir(root)).not.toContain('failing.alkk');
  });

  it('a snapshots callback that takes the agent lock is refused at once and cannot deadlock', async () => {
    const owner = await makeOwner();
    const agent = await makeKeychainAgent(owner);
    const control = createKeyExportControl({
      owner: owner.store,
      itemsOf: () => agent.keychain,
      storePathOf: () => agent.storePath,
      agentlinkDir: join(root, '.agentlink'),
      kdf: FAST,
    });
    const session = await owner.store.unlockForExport(presence(owner));
    const started = Date.now();
    const path = join(root, 'lock.alkk');
    await expectCode(
      control.sealRecoveryKit(session, {
        kitId: 'AAAAAAAAAAAAAAAAAAAAAA',
        createdAt: 1,
        contents: 'full',
        agents: [{ agentId: agent.agentId, name: 'helper' }],
        // The Node backend also passes its LockHold, beyond the public one-argument contract.
        snapshots: ((_agentId: string, hold: LockHold): Promise<RecoveryKitStoreSource> =>
          withInterProcessLock(`${agent.storePath}.lock`, () => source(agent.snapshot), {
            within: hold,
          })) as RecoveryKitExportRequest['snapshots'],
        path,
      }),
      'store_busy',
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await readdir(root)).not.toContain('lock.alkk');
  });

  it('reads policy-version and receipts-kept and takes the snapshot under one lock hold', async () => {
    const owner = await makeOwner();
    const agent = await makeKeychainAgent(owner);
    const mark = keychainAccount(agent.agentId, 'policy-version');
    await agent.keychain.set(mark, encodeUtf8('3'));
    await agent.keychain.set(keychainAccount(agent.agentId, 'receipts-kept'), encodeUtf8('3'));
    const control = createKeyExportControl({
      owner: owner.store,
      itemsOf: () => agent.keychain,
      storePathOf: () => agent.storePath,
      agentlinkDir: join(root, '.agentlink'),
      kdf: FAST,
    });
    const session = await owner.store.unlockForExport(presence(owner));
    let raise: Promise<void> | undefined;
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    // A concurrent raise outside the callback's context waits for the export's lock hold.
    void inside.then(() => {
      raise = withInterProcessLock(`${agent.storePath}.lock`, async () => {
        await agent.keychain.set(mark, encodeUtf8('4'));
      });
    });
    const path = join(root, 'cut.alkk');
    const code = await control.sealRecoveryKit(session, {
      kitId: 'AAAAAAAAAAAAAAAAAAAAAA',
      createdAt: 1,
      contents: 'full',
      agents: [{ agentId: agent.agentId, name: 'helper' }],
      snapshots: async () => {
        entered();
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(ascii((await agent.keychain.get(mark)) as Uint8Array)).toBe('3');
        return source(agent.snapshot);
      },
      path,
    });
    await raise;
    expect(ascii((await agent.keychain.get(mark)) as Uint8Array)).toBe('4');
    const opened = await openRecoveryKit(
      new Uint8Array(await readFile(path)),
      { secret: code.slice(), source: 'prompt' },
      { createStoreSink: () => memorySink() },
    );
    try {
      const items = opened.agents[0]?.items ?? [];
      expect(items.map((i) => i.name)).toEqual([
        'seed',
        'store-key',
        'policy-version',
        'receipts-kept',
      ]);
      expect(ascii(items[2]?.value as Uint8Array)).toBe('3');
    } finally {
      opened.wipe();
    }
  });

  it('never exports an s3:<id> item (D-115 D); the S3 secret is not in the kit', async () => {
    const owner = await makeOwner();
    const agent = await makeKeychainAgent(owner);
    const storage = createStorageCredentialControl({
      owner: owner.store,
      items: agent.keychain,
      agentId: agent.agentId,
      storePath: agent.storePath,
    });
    const session = await owner.store.unlock(presence(owner));
    await storage.writeCredential(session, '0123456789abcdef', {
      accessKeyId: encodeUtf8('AKIATEST'),
      secretAccessKey: encodeUtf8(S3_CANARY),
    });
    await session.close();
    const { kit, code } = await exportKit(owner, agent);
    const opened = await openRecoveryKit(
      kit,
      { secret: code, source: 'prompt' },
      { createStoreSink: () => memorySink() },
    );
    try {
      for (const item of opened.agents[0]?.items ?? []) {
        expect(item.name.startsWith('s3')).toBe(false);
        expect(ascii(item.value)).not.toContain(S3_CANARY);
      }
    } finally {
      opened.wipe();
    }
  });
});

/** An in-memory sink for kits opened directly in tests. */
function memorySink(): RecoveryKitStoreSink {
  const parts: Uint8Array[] = [];
  return {
    write: (b) => void parts.push(b.slice()),
    commit: () => undefined,
    discard: () => undefined,
  };
}

// --- KeyImportControl: the conformance suite for both backends -------------------------------------

interface ImportBackend {
  readonly name: string;
  /** A fresh import control; `ownerKeychain` holds the target machine's owner item, if any. */
  control(opts: { ownerKeychain: MemoryKeychain; ownerStore?: KeychainOwnerKeyStore }): {
    readonly control: KeyImportControl;
    /** Whether any item or file of `agentId` exists on the target. */
    has(agentId: string): Promise<boolean>;
    /** Plants one existing item of `agentId` on the target. */
    plant(agentId: string): Promise<void>;
    /** The restored items, by name. */
    items(agentId: string, unlockCode: Uint8Array | undefined): Promise<Map<string, Uint8Array>>;
  };
}

function keychainImportBackend(): ImportBackend {
  return {
    name: 'keychain',
    control({ ownerKeychain, ownerStore }) {
      const target = new MemoryKeychain();
      return {
        control: createKeyImportControl({
          backend: 'keychain',
          keychain: target,
          ownerKeychain,
          ...(ownerStore === undefined ? {} : { ownerStore }),
          kdf: FAST,
          revokedDir: join(root, 'revoked'),
        }),
        has: (agentId) =>
          Promise.resolve([...target.items.keys()].some((a) => a.startsWith(agentId))),
        plant: (agentId) => target.set(keychainAccount(agentId, 'receipts-kept'), encodeUtf8('1')),
        items: (agentId) => {
          const out = new Map<string, Uint8Array>();
          for (const [account, value] of target.items) {
            if (account === agentId) out.set('seed', value);
            else if (account.startsWith(`${agentId}:`)) out.set(account.slice(43), value);
          }
          return Promise.resolve(out);
        },
      };
    },
  };
}

function fileImportBackend(): ImportBackend {
  return {
    name: 'file',
    control({ ownerKeychain, ownerStore }) {
      const dir = join(root, 'keystore');
      const file = (agentId: string) => join(dir, `${agentId}.alks`);
      return {
        control: createKeyImportControl({
          backend: 'file',
          keystoreDir: dir,
          ownerKeychain,
          ...(ownerStore === undefined ? {} : { ownerStore }),
          kdf: FAST,
          revokedDir: join(root, 'revoked'),
        }),
        has: (agentId) =>
          stat(file(agentId)).then(
            () => true,
            () => false,
          ),
        plant: async (agentId) => {
          const seed = crypto.getRandomValues(new Uint8Array(32));
          const kek = await newKeystoreKek(
            'ALKS',
            { secret: encodeUtf8('another passphrase here'), secretKind: 2, source: 'prompt' },
            FAST,
          );
          // A file under the kit agent's name, as an earlier agent would leave it.
          const id = await writeAgentFile(dir, seed, kek);
          await import('node:fs/promises').then((fs) => fs.rename(file(id), file(agentId)));
        },
        items: async (agentId, unlockCode) => {
          const bytes = new Uint8Array(await readFile(file(agentId)));
          const opened = await openKeystoreFile(
            bytes,
            { secret: unlockCode as Uint8Array, source: 'prompt' },
            agentId,
          );
          return new Map(opened.entries.map((e) => [e.name, e.value]));
        },
      };
    },
  };
}

async function openKit(control: KeyImportControl, kit: Uint8Array, code: Uint8Array) {
  const quarantine = createRestoreQuarantine(join(root, 'q'));
  return control.openRecoveryKit(
    kit,
    { secret: code.slice(), source: 'prompt' },
    {
      createStoreSink: quarantine.createStoreSink,
    },
  );
}

for (const backend of [keychainImportBackend(), fileImportBackend()]) {
  describe.runIf(POSIX)(`KeyImportControl conformance: ${backend.name}`, () => {
    it('restores every item at once on a clean machine, with storage-mark active null', async () => {
      const owner = await makeOwner();
      const agent = await makeKeychainAgent(owner);
      await agent.keychain.set(
        keychainAccount(agent.agentId, 'storage-mark'),
        encodeStorageMark('0123456789abcdef'),
      );
      const { kit, code } = await exportKit(owner, agent);
      const target = backend.control({ ownerKeychain: new MemoryKeychain() });
      const handle = await openKit(target.control, kit, code);
      expect(equalBytes(handle.ownerNostr, owner.nostr)).toBe(true);
      expect(handle.agents.map((a) => a.agentId)).toEqual([agent.agentId]);
      const { unlockCode } = await target.control.importAgent(handle, agent.agentId);
      if (backend.name === 'file') expect(unlockCode?.length).toBe(24);
      else expect(unlockCode).toBeUndefined();
      const items = await target.items(agent.agentId, unlockCode);
      expect(
        equalBytes(
          items.get('seed') as Uint8Array,
          (await agent.keychain.get(agent.agentId)) as Uint8Array,
        ),
      ).toBe(true);
      expect(equalBytes(items.get('store-key') as Uint8Array, agent.storeKey)).toBe(true);
      expect(equalBytes(items.get('storage-mark') as Uint8Array, encodeStorageMark(null))).toBe(
        true,
      );
      handle.wipe();
    });

    it('U3-e: refuses an agent in the revoked list (verifying, other owner or damaged) and writes nothing', async () => {
      const owner = await makeOwner();
      const agent = await makeKeychainAgent(owner);
      const { kit, code } = await exportKit(owner, agent);
      const revoked = join(root, 'revoked');
      await mkdir(revoked, { recursive: true, mode: 0o700 });
      for (const entry of ['{"body":{},"sig":"00"}', 'not json at all', '']) {
        await writeFile(join(revoked, `${agent.agentId}.json`), entry, { mode: 0o600 });
        const target = backend.control({ ownerKeychain: new MemoryKeychain() });
        const handle = await openKit(target.control, kit, code);
        await expectCode(
          target.control.importAgent(handle, agent.agentId),
          'operation_not_allowed',
        );
        expect(await target.has(agent.agentId)).toBe(false);
        handle.wipe();
      }
      // A link or a folder at that name refuses too (fail closed).
      await rm(join(revoked, `${agent.agentId}.json`));
      await mkdir(join(revoked, `${agent.agentId}.json`));
      const target = backend.control({ ownerKeychain: new MemoryKeychain() });
      const handle = await openKit(target.control, kit, code);
      await expectCode(target.control.importAgent(handle, agent.agentId), 'operation_not_allowed');
      expect(await target.has(agent.agentId)).toBe(false);
      handle.wipe();
    });

    it('import over an existing agent is item_exists and writes nothing', async () => {
      const owner = await makeOwner();
      const agent = await makeKeychainAgent(owner);
      const { kit, code } = await exportKit(owner, agent);
      const target = backend.control({ ownerKeychain: new MemoryKeychain() });
      await target.plant(agent.agentId);
      const before = await target.items(agent.agentId, undefined).catch(() => null);
      const handle = await openKit(target.control, kit, code);
      await expectCode(target.control.importAgent(handle, agent.agentId), 'item_exists');
      if (backend.name === 'keychain') {
        expect([
          ...((await target.items(agent.agentId, undefined)) as Map<string, Uint8Array>).keys(),
        ]).toEqual([...(before as Map<string, Uint8Array>).keys()]);
      }
      handle.wipe();
    });

    it('checks the local name before it names anything', async () => {
      const owner = await makeOwner();
      const agent = await makeKeychainAgent(owner);
      const { kit, code } = await exportKit(owner, agent);
      const target = backend.control({ ownerKeychain: new MemoryKeychain() });
      const handle = await openKit(target.control, kit, code);
      for (const name of ['../x', 'Helper', '', 'a'.repeat(33), 'x/y', '-a']) {
        await expect(target.control.importAgent(handle, agent.agentId, { name })).rejects.toThrow(
          CryptoInputError,
        );
      }
      expect(await target.has(agent.agentId)).toBe(false);
      handle.wipe();
    });

    it('with an owner item: no session, a look-alike or another owner writes nothing', async () => {
      const owner = await makeOwner();
      const agent = await makeKeychainAgent(owner);
      const { kit, code } = await exportKit(owner, agent);
      // The target machine has an owner item of ANOTHER owner, plus a planted store that expects the
      // kit's owner (as a planted card naming it would): its own code never opens it to that owner.
      const otherKeychain = new MemoryKeychain();
      const other = await makeOwner(otherKeychain);
      const planted = await KeychainOwnerKeyStore.open(
        otherKeychain,
        await owner.store.getPublicKeys(),
      );
      await expectCode(planted.unlock(presence(other)), 'presence_rejected');
      const target = backend.control({ ownerKeychain: otherKeychain, ownerStore: other.store });
      const handle = await openKit(target.control, kit, code).catch((e: unknown) => e);
      // With the other owner paired, the kit of a different owner is refused before anything.
      expect((handle as { code?: unknown }).code).toBe('open_failed');
      // Unpaired control: the kit opens, but no import without the right owner session.
      const unpaired = backend.control({ ownerKeychain: otherKeychain });
      const h2 = await openKit(unpaired.control, kit, code);
      await expectCode(unpaired.control.importAgent(h2, agent.agentId), 'presence_required');
      const session = await other.store.unlock(presence(other));
      await expectCode(
        unpaired.control.importAgent(h2, agent.agentId, { owner: new Proxy(session, {}) }),
        'presence_required',
      );
      await expectCode(
        unpaired.control.importAgent(h2, agent.agentId, { owner: session }),
        'presence_required',
      );
      expect(await unpaired.has(agent.agentId)).toBe(false);
      h2.wipe();
    });

    it('with the same owner item: only a session its own code opened, to the kit owner, imports', async () => {
      const owner = await makeOwner();
      const agent = await makeKeychainAgent(owner);
      const { kit, code } = await exportKit(owner, agent);
      const target = backend.control({ ownerKeychain: owner.keychain, ownerStore: owner.store });
      const handle = await openKit(target.control, kit, code);
      await expectCode(target.control.importAgent(handle, agent.agentId), 'presence_required');
      const session = await owner.store.unlock(presence(owner));
      await session.close();
      await expectCode(
        target.control.importAgent(handle, agent.agentId, { owner: session }),
        'owner_locked',
      );
      expect(await target.has(agent.agentId)).toBe(false);
      const live = await owner.store.unlock(presence(owner));
      await target.control.importAgent(handle, agent.agentId, { owner: live, name: 'renamed' });
      expect(await target.has(agent.agentId)).toBe(true);
      await live.close();
      handle.wipe();
    });

    it('refuses a look-alike or wiped handle', async () => {
      const owner = await makeOwner();
      const agent = await makeKeychainAgent(owner);
      const { kit, code } = await exportKit(owner, agent);
      const target = backend.control({ ownerKeychain: new MemoryKeychain() });
      const handle = await openKit(target.control, kit, code);
      await expect(
        target.control.importAgent({ ...handle } as RecoveryKitImport, agent.agentId),
      ).rejects.toThrow();
      handle.wipe();
      await expectCode(target.control.importAgent(handle, agent.agentId), 'keystore_closed');
      await expectCode(target.control.importOwner(handle), 'keystore_closed');
      expect(await target.has(agent.agentId)).toBe(false);
    });
  });
}

describe.runIf(POSIX)('KeyImportControl: owner and snapshot checks', () => {
  it('importOwner writes ALKO under a new generated owner code via owner-next (never the recovery code)', async () => {
    const owner = await makeOwner();
    const agent = await makeKeychainAgent(owner);
    const { kit, code } = await exportKit(owner, agent);
    const ownerKeychain = new MemoryKeychain();
    const { control } = keychainImportBackend().control({ ownerKeychain });
    const handle = await openKit(control, kit, code);
    const ownerCode = await control.importOwner(handle);
    expect(ownerCode.length).toBe(24);
    expect(ascii(ownerCode)).not.toBe(ascii(code));
    expect(ownerKeychain.items.has(OWNER_NEXT_ACCOUNT)).toBe(false);
    const blob = ownerKeychain.items.get(OWNER_ACCOUNT) as Uint8Array;
    expect(blob.length).toBe(90);
    const seed = await openOwnerSeedWithoutCard(
      blob,
      { secret: ownerCode.slice(), source: 'prompt' },
      { fileKeystoreMachine: false },
    );
    expect(equalBytes(seed, owner.seed)).toBe(true);
    await expect(
      openOwnerSeedWithoutCard(
        blob,
        { secret: code.slice(), source: 'prompt' },
        { fileKeystoreMachine: false },
      ),
    ).rejects.toThrow();
    await expectCode(control.importOwner(handle), 'item_exists');
    handle.wipe();
  });

  it('importOwner never replaces an existing owner item and keeps a failed staging write clean', async () => {
    const owner = await makeOwner();
    const agent = await makeKeychainAgent(owner);
    const { kit, code } = await exportKit(owner, agent);
    const existing = await makeOwner();
    const before = existing.keychain.items.get(OWNER_ACCOUNT)?.slice();
    const { control } = keychainImportBackend().control({ ownerKeychain: existing.keychain });
    const handle = await openKit(control, kit, code);
    await expectCode(control.importOwner(handle), 'item_exists');
    expect(
      equalBytes(existing.keychain.items.get(OWNER_ACCOUNT) as Uint8Array, before as Uint8Array),
    ).toBe(true);
    const failing = new MemoryKeychain();
    failing.failSetAfter = 0;
    const c2 = keychainImportBackend().control({ ownerKeychain: failing }).control;
    const h2 = await openKit(c2, kit, code);
    await expect(c2.importOwner(h2)).rejects.toThrow();
    expect(failing.items.size).toBe(0);
    handle.wipe();
    h2.wipe();
  });

  it('the file backend fails closed for importOwner (no file-machine owner yet)', async () => {
    const owner = await makeOwner();
    const agent = await makeKeychainAgent(owner);
    const { kit, code } = await exportKit(owner, agent);
    const { control } = fileImportBackend().control({ ownerKeychain: new MemoryKeychain() });
    const handle = await openKit(control, kit, code);
    await expectCode(control.importOwner(handle), 'unsupported_operation');
    handle.wipe();
  });

  it('a file machine with owner.alko needs the owner session for importAgent', async () => {
    const owner = await makeOwner();
    const agent = await makeKeychainAgent(owner);
    const { kit, code } = await exportKit(owner, agent);
    const backend = fileImportBackend().control({ ownerKeychain: new MemoryKeychain() });
    await import('node:fs/promises').then(async (fs) => {
      await fs.mkdir(join(root, 'keystore'), { mode: 0o700, recursive: true });
      await fs.writeFile(join(root, 'keystore', OWNER_FILE), new Uint8Array(90), { mode: 0o600 });
    });
    const handle = await openKit(backend.control, kit, code);
    await expectCode(backend.control.importAgent(handle, agent.agentId), 'presence_required');
    expect(await backend.has(agent.agentId)).toBe(false);
    handle.wipe();
  });

  /** A kit sealed directly, with a snapshot whose identity or card does not match. */
  async function mismatchKit(kind: 'agent_id' | 'owner') {
    const owner = await makeOwner();
    const keychain = new MemoryKeychain();
    const agentId = await createKeychainAgent(keychain);
    const seed = (await keychain.get(agentId)) as Uint8Array;
    const storeKey = (await keychain.get(keychainAccount(agentId, 'store-key'))) as Uint8Array;
    const otherId = deriveAgentId(crypto.getRandomValues(new Uint8Array(32)));
    const otherOwner = encodeHex(crypto.getRandomValues(new Uint8Array(32)));
    const snapshot =
      kind === 'agent_id'
        ? await makeSnapshot(agentId, storeKey, encodeHex(owner.nostr), otherId)
        : await makeSnapshot(agentId, storeKey, otherOwner);
    const parts: Uint8Array[] = [];
    const code = await sealRecoveryKit(
      {
        ownerSeed: owner.seed,
        kitId: 'AAAAAAAAAAAAAAAAAAAAAA',
        createdAt: 1,
        contents: 'full',
        agents: [
          {
            agentId,
            name: 'helper',
            items: [
              { name: 'seed', value: seed },
              { name: 'store-key', value: storeKey },
            ],
            store: source(snapshot),
          },
        ],
      },
      (b) => void parts.push(b.slice()),
      FAST,
    );
    const kit = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      kit.set(p, o);
      o += p.length;
    }
    return { kit, code };
  }

  for (const kind of ['agent_id', 'owner'] as const) {
    it(`snapshot mismatch (${kind}): one generic error, quarantine emptied, nothing written`, async () => {
      const { kit, code } = await mismatchKit(kind);
      for (const backend of [keychainImportBackend(), fileImportBackend()]) {
        const target = backend.control({ ownerKeychain: new MemoryKeychain() });
        await expectCode(openKit(target.control, kit, code), 'open_failed');
        expect(await readdir(join(root, 'q')).catch(() => [])).toEqual([]);
      }
    });
  }

  it('refuses a sink that is not a restore quarantine sink', async () => {
    const owner = await makeOwner();
    const agent = await makeKeychainAgent(owner);
    const { kit, code } = await exportKit(owner, agent);
    const { control } = keychainImportBackend().control({ ownerKeychain: new MemoryKeychain() });
    await expect(
      control.openRecoveryKit(
        kit,
        { secret: code, source: 'prompt' },
        { createStoreSink: () => memorySink() },
      ),
    ).rejects.toThrow();
  });

  it('installs the checked store without overwriting, mode 0600; quarantine files are removed', async () => {
    const owner = await makeOwner();
    const agent = await makeKeychainAgent(owner);
    const { kit, code } = await exportKit(owner, agent);
    const { control } = keychainImportBackend().control({ ownerKeychain: new MemoryKeychain() });
    const handle = await openKit(control, kit, code);
    const dest = join(root, 'restored.sqlite');
    await writeFile(dest, 'keep');
    await expect(installRestoredStore(handle, agent.agentId, dest)).rejects.toThrow();
    expect(await readFile(dest, 'utf8')).toBe('keep');
    const dest2 = join(root, 'restored2.sqlite');
    await installRestoredStore(handle, agent.agentId, dest2);
    const installed = await open(dest2, 'r');
    try {
      expect((await installed.stat()).mode & 0o777).toBe(0o600);
      expect(equalBytes(new Uint8Array(await installed.readFile()), agent.snapshot)).toBe(true);
    } finally {
      await installed.close();
    }
    handle.wipe();
    expect(await readdir(join(root, 'q'))).toEqual([]);
  });
});

// --- StorageCredentialControl and the own-storage items -------------------------------------------

interface CredentialBackend {
  readonly name: string;
  make(owner: Owner): Promise<{
    readonly control: StorageCredentialControl;
    readonly items: KeychainBackend;
    readonly agentId: string;
    readonly storePath: string;
  }>;
}

const credentialBackends: CredentialBackend[] = [
  {
    name: 'keychain',
    async make(owner) {
      const agent = await makeKeychainAgent(owner);
      return {
        control: createStorageCredentialControl({
          owner: owner.store,
          items: agent.keychain,
          agentId: agent.agentId,
          storePath: agent.storePath,
        }),
        items: agent.keychain,
        agentId: agent.agentId,
        storePath: agent.storePath,
      };
    },
  },
  {
    name: 'file',
    async make(owner) {
      const dir = join(root, 'keystore');
      const kek = await newKeystoreKek(
        'ALKS',
        { secret: encodeUtf8('a file passphrase for tests'), secretKind: 2, source: 'prompt' },
        FAST,
      );
      const agentId = await writeAgentFile(dir, crypto.getRandomValues(new Uint8Array(32)), kek);
      const unlocked = await unlockFileAgent(agentId, {
        dir,
        env: { AGENTLINK_KEYSTORE_PASSPHRASE: 'a file passphrase for tests' },
      });
      const items = fileKeychain(unlocked);
      const storePath = join(await mkdtemp(join(root, 'agent-')), 'store.sqlite');
      return {
        control: createStorageCredentialControl({ owner: owner.store, items, agentId, storePath }),
        items,
        agentId,
        storePath,
      };
    },
  },
];

for (const backend of credentialBackends) {
  describe.runIf(POSIX)(`StorageCredentialControl conformance: ${backend.name}`, () => {
    it('writes s3:<id> once, returns its credentialDigest, never overwrites, removes', async () => {
      const owner = await makeOwner();
      const { control, items, agentId } = await backend.make(owner);
      const session = await owner.store.unlock(presence(owner));
      const id = '0123456789abcdef';
      const credential = {
        accessKeyId: encodeUtf8('AKIATEST'),
        secretAccessKey: encodeUtf8(S3_CANARY),
      };
      const digest = await control.writeCredential(session, id, credential);
      const account = `${agentId}:s3:${id}`;
      const item = (await items.get(account)) as Uint8Array;
      const fields = parseStorageCredentialItem(item);
      expect(digest).toBe(credentialDigest(fields));
      expect(ascii(fields.secretAccessKey)).toBe(S3_CANARY);
      const error = await expectCode(
        control.writeCredential(session, id, {
          accessKeyId: encodeUtf8('AKIAOTHER'),
          secretAccessKey: encodeUtf8('other'),
        }),
        'item_exists',
      );
      expect(String((error as Error).message)).not.toContain(S3_CANARY);
      expect(equalBytes((await items.get(account)) as Uint8Array, item)).toBe(true);
      await control.removeCredential(session, id);
      expect(await items.get(account)).toBeNull();
      await control.removeCredential(session, id);
      await session.close();
    });

    it('refuses a look-alike or ended session and a malformed id before any write', async () => {
      const owner = await makeOwner();
      const { control, items, agentId } = await backend.make(owner);
      const credential = () => ({
        accessKeyId: encodeUtf8('AKIATEST'),
        secretAccessKey: encodeUtf8(S3_CANARY),
      });
      const session = await owner.store.unlock(presence(owner));
      await expectCode(
        control.writeCredential(new Proxy(session, {}), '0123456789abcdef', credential()),
        'presence_required',
      );
      await expectCode(
        control.removeCredential({} as OwnerSession, '0123456789abcdef'),
        'presence_required',
      );
      for (const id of ['0123456789ABCDEF', '0123', '../../x', '0123456789abcdef0']) {
        const error = await control
          .writeCredential(session, id, credential())
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(CryptoInputError);
      }
      await session.close();
      await expectCode(
        control.writeCredential(session, 'fedcba9876543210', credential()),
        'owner_locked',
      );
      expect(await items.get(`${agentId}:s3:fedcba9876543210`)).toBeNull();
    });

    it('own-storage items: storage-mark under the lock with read-back, and the credentialDigest', async () => {
      const owner = await makeOwner();
      const { control, items, agentId, storePath } = await backend.make(owner);
      const keys = ownStorageKeysOver(items, agentId, (fn) =>
        withInterProcessLock(`${storePath}.lock`, fn),
      );
      expect(await keys.readMark()).toBeNull();
      await keys.writeMark('0123456789abcdef');
      expect(
        equalBytes((await keys.readMark()) as Uint8Array, encodeStorageMark('0123456789abcdef')),
      ).toBe(true);
      await keys.writeMark(null);
      expect(equalBytes((await keys.readMark()) as Uint8Array, encodeStorageMark(null))).toBe(true);
      expect(await keys.credentialDigest('0123456789abcdef')).toBeNull();
      const session = await owner.store.unlock(presence(owner));
      const digest = await control.writeCredential(session, '0123456789abcdef', {
        accessKeyId: encodeUtf8('AKIATEST'),
        secretAccessKey: encodeUtf8(S3_CANARY),
      });
      await session.close();
      expect(await keys.credentialDigest('0123456789abcdef')).toBe(digest);
      await expect(keys.credentialDigest('../x')).rejects.toThrow();
    });
  });
}

describe('inter-process lock re-entrance', () => {
  it('a nested acquire of the same lock in the same flow is store_busy at once', async () => {
    const path = join(root, 'x.lock');
    const started = Date.now();
    await expectCode(
      withInterProcessLock(path, (hold) => withInterProcessLock(path, () => 1, { within: hold })),
      'store_busy',
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    // Outside that flow the lock still serialises: a second holder waits, then runs.
    const order: number[] = [];
    await Promise.all([
      withInterProcessLock(path, async () => {
        await new Promise((r) => setTimeout(r, 50));
        order.push(1);
      }),
      withInterProcessLock(path, () => void order.push(2)),
    ]);
    expect(order).toEqual([1, 2]);
  });
});
