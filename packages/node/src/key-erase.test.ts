// U3-e (04 §2.5 "Removing an agent" step 6; D-138; I-2, I-7): the KeyStore erase API over the
// keychain backend (an in-memory keychain double here; the real macOS Keychain, Windows Credential
// Manager and Linux Secret Service in keychain-native.test.ts) and the file KeyStore. The erased list
// is exact, the owner's items and other agents' items survive, an erase without the agent's verifying
// `agent.revoke` deletes nothing, and a failure is the one fixed error.
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalize,
  encodeHex,
  encodeUtf8,
  randomBytes,
  type Argon2idParams,
  type JsonObject,
} from '@4thtech-io/crypto';
import { deriveAgentId } from '@4thtech-io/crypto/keystore';
import { MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { buildAgentRevokeBody, encodeStorageMark } from '@4thtech-io/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKeyEraseControl } from './key-controls.js';
import {
  OWNER_FILE,
  createFileAgent,
  defaultKeystoreDir,
  eraseFileAgent,
} from './file-keystore.js';
import { eraseKeychainAgent } from './keychain-keystore.js';
import { agentEraseAccounts, keychainAccount, type KeychainBackend } from './keychain.js';

const POSIX = process.platform !== 'win32';
const FAST: Argon2idParams = Object.freeze({ memoryKiB: 19456, iterations: 2, parallelism: 1 });
const OWNER_ACCOUNTS = ['owner', 'owner-passkey', 'owner-next'];
const ID_A = '0123456789abcdef';
const ID_B = 'fedcba9876543210';
const ID_MARK = 'aaaaaaaaaaaaaaaa';

class MemoryKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  readonly deleted: string[] = [];
  failDelete: string | undefined;
  keepAfterDelete: string | undefined;
  get(account: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.items.get(account)?.slice() ?? null);
  }
  set(account: string, value: Uint8Array): Promise<void> {
    this.items.set(account, value.slice());
    return Promise.resolve();
  }
  delete(account: string): Promise<boolean> {
    if (account === this.failDelete) return Promise.reject(new Error(`native ${account}`));
    this.deleted.push(account);
    if (account === this.keepAfterDelete) return Promise.resolve(true);
    return Promise.resolve(this.items.delete(account));
  }
}

const newAgentId = (): string => deriveAgentId(randomBytes(32));
const presence = () => ({ kind: 'passphrase' as const, secret: encodeUtf8('owner passphrase') });
const owner = new MemoryOwnerKeyStore(randomBytes(32), presence());

async function revokeFor(agentId: string): Promise<string> {
  const keys = await owner.getPublicKeys();
  const { body } = buildAgentRevokeBody({
    agent: agentId,
    owner: encodeHex(keys.ownerNostr),
    issuedAt: 1_760_000_000,
  });
  const session = await owner.unlock(presence());
  try {
    const sig = await session.signOwnerAction(body as unknown as JsonObject);
    return canonicalize({ body, sig } as never);
  } finally {
    await session.close();
  }
}

/** Every item an agent can have (04 §2.2), plus the owner's items and another agent's. */
async function populated(agentId: string, other: string): Promise<MemoryKeychain> {
  const keychain = new MemoryKeychain();
  for (const account of OWNER_ACCOUNTS) await keychain.set(account, encodeUtf8(`owner ${account}`));
  for (const id of [agentId, other]) {
    for (const item of ['seed', 'store-key', 'policy-version', 'receipts-kept'] as const) {
      await keychain.set(keychainAccount(id, item), encodeUtf8(item));
    }
    await keychain.set(keychainAccount(id, `s3:${ID_A}`), encodeUtf8('s3'));
  }
  await keychain.set(keychainAccount(agentId, 'storage-mark'), encodeStorageMark(ID_MARK));
  await keychain.set(keychainAccount(agentId, `s3:${ID_MARK}`), encodeUtf8('s3 mark'));
  await keychain.set(keychainAccount(agentId, `s3:${ID_B}`), encodeUtf8('s3 b'));
  return keychain;
}

describe('agentEraseAccounts: the exact erase list (04 §2.5 step 6)', () => {
  it('is the seed and the fixed items of this agent, then one s3 item per distinct id', () => {
    const agentId = newAgentId();
    expect(agentEraseAccounts(agentId, [ID_A, ID_A, ID_B])).toEqual([
      agentId,
      `${agentId}:store-key`,
      `${agentId}:policy-version`,
      `${agentId}:receipts-kept`,
      `${agentId}:storage-mark`,
      `${agentId}:s3:${ID_A}`,
      `${agentId}:s3:${ID_B}`,
    ]);
  });

  it('can never name an owner account or another name', () => {
    for (const bad of [
      'owner',
      'owner-passkey',
      'owner-next',
      '0xABC',
      '',
      `0x${'1'.repeat(41)}`,
    ]) {
      expect(() => agentEraseAccounts(bad, [])).toThrow();
    }
    const agentId = newAgentId();
    for (const id of ['', 'owner', '0123456789ABCDEF', '0123', `${ID_A}:x`, `../${ID_A}`]) {
      expect(() => agentEraseAccounts(agentId, [id])).toThrow();
    }
    expect(() =>
      agentEraseAccounts(
        agentId,
        Array.from({ length: 65 }, () => ID_A),
      ),
    ).toThrow();
  });
});

describe('eraseKeychainAgent (the OS keychain backend, in-memory double)', () => {
  it('erases exactly this agent: every item and the s3 items of the store and of its storage-mark', async () => {
    const agentId = newAgentId();
    const other = newAgentId();
    const keychain = await populated(agentId, other);
    const before = new Set(keychain.items.keys());
    await eraseKeychainAgent(keychain, agentId, [ID_A]);
    const erased = [...before].filter((a) => !keychain.items.has(a)).sort();
    expect(erased).toEqual(
      [
        agentId,
        `${agentId}:store-key`,
        `${agentId}:policy-version`,
        `${agentId}:receipts-kept`,
        `${agentId}:storage-mark`,
        `${agentId}:s3:${ID_A}`,
        `${agentId}:s3:${ID_MARK}`,
      ].sort(),
    );
    // The owner's items and the other agent's survive (they were never even named).
    for (const account of OWNER_ACCOUNTS) expect(keychain.items.has(account)).toBe(true);
    expect([...keychain.items.keys()].filter((a) => a.startsWith(other))).toHaveLength(5);
    expect(keychain.deleted.some((a) => OWNER_ACCOUNTS.includes(a) || a.startsWith(other))).toBe(
      false,
    );
    // An s3 id the store did not record and the mark does not name is a known residual (04 §2.5).
    expect(keychain.items.has(`${agentId}:s3:${ID_B}`)).toBe(true);
    // The seed goes last.
    expect(keychain.deleted.at(-1)).toBe(agentId);
  });

  it('is idempotent: items already gone are not an error (Try again after a stop)', async () => {
    const agentId = newAgentId();
    const keychain = await populated(agentId, newAgentId());
    await eraseKeychainAgent(keychain, agentId, [ID_A]);
    await expect(eraseKeychainAgent(keychain, agentId, [ID_A])).resolves.toBeUndefined();
  });

  it('a damaged storage-mark adds no id; the rest still goes', async () => {
    const agentId = newAgentId();
    const keychain = await populated(agentId, newAgentId());
    await keychain.set(keychainAccount(agentId, 'storage-mark'), encodeUtf8('{"v":1,"active":7}'));
    await eraseKeychainAgent(keychain, agentId, []);
    expect(keychain.items.has(agentId)).toBe(false);
    expect(keychain.items.has(`${agentId}:storage-mark`)).toBe(false);
  });

  it('a failing or ignored delete is the fixed keystore_erase_failed, with the seed still there', async () => {
    const agentId = newAgentId();
    const keychain = await populated(agentId, newAgentId());
    keychain.failDelete = `${agentId}:receipts-kept`;
    const failure = await eraseKeychainAgent(keychain, agentId, []).catch((e: unknown) => e);
    expect(failure).toMatchObject({ code: 'keystore_erase_failed' });
    expect(String((failure as Error).message)).not.toContain(agentId);
    expect(String((failure as Error).message)).not.toContain('native');
    expect(keychain.items.has(agentId)).toBe(true);

    const sticky = await populated(agentId, newAgentId());
    sticky.keepAfterDelete = `${agentId}:store-key`;
    await expect(eraseKeychainAgent(sticky, agentId, [])).rejects.toMatchObject({
      code: 'keystore_erase_failed',
    });
    expect(sticky.items.has(agentId)).toBe(true);
  });
});

let home: string;
let dir: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agentlink-erase-'));
  dir = defaultKeystoreDir(home);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function fileAgent(): Promise<string> {
  const { agentId } = await createFileAgent({
    probe: { ok: false, reason: 'unavailable', fix: 'x' },
    interactive: true,
    env: {},
    dir,
    kdf: FAST,
    passphrase: encodeUtf8('a long agent passphrase'),
  });
  return agentId;
}

const exists = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false,
  );

describe.runIf(POSIX)('eraseFileAgent (the file KeyStore)', () => {
  it("erases the agent's .alks file and its temporary files, and nothing else", async () => {
    const agentId = await fileAgent();
    const other = await fileAgent();
    await writeFile(join(dir, OWNER_FILE), 'owner', { mode: 0o600 });
    await writeFile(join(dir, 'owner.alkp'), 'owner passkey', { mode: 0o600 });
    await writeFile(join(dir, `.${agentId}.alks.tmp-0123456789abcdef`), 'temp', { mode: 0o600 });
    await eraseFileAgent(dir, agentId);
    expect(await exists(join(dir, `${agentId}.alks`))).toBe(false);
    expect(await exists(join(dir, `.${agentId}.alks.tmp-0123456789abcdef`))).toBe(false);
    expect(await exists(join(dir, OWNER_FILE))).toBe(true);
    expect(await exists(join(dir, 'owner.alkp'))).toBe(true);
    expect(await exists(join(dir, `${other}.alks`))).toBe(true);
    // Idempotent.
    await expect(eraseFileAgent(dir, agentId)).resolves.toBeUndefined();
  });

  it('is a no-op without a keystore folder, and refuses a link in place of the file', async () => {
    await expect(eraseFileAgent(dir, newAgentId())).resolves.toBeUndefined();
    const agentId = await fileAgent();
    const target = join(home, 'elsewhere');
    await writeFile(target, 'keep me', { mode: 0o600 });
    await rm(join(dir, `${agentId}.alks`));
    await symlink(target, join(dir, `${agentId}.alks`));
    await expect(eraseFileAgent(dir, agentId)).rejects.toMatchObject({
      code: 'keystore_erase_failed',
    });
    expect(await exists(target)).toBe(true);
  });

  it('refuses any name but an agent ID (never owner.alko)', async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, OWNER_FILE), 'owner', { mode: 0o600 });
    for (const bad of ['owner', 'owner.alko', '../x', `0x${'A'.repeat(40)}`]) {
      await expect(eraseFileAgent(dir, bad)).rejects.toMatchObject({
        code: 'keystore_erase_failed',
      });
    }
    expect(await readdir(dir)).toContain(OWNER_FILE);
  });
});

describe('createKeyEraseControl (the KeyStore erase API)', () => {
  it('erases only with the verifying agent.revoke of the same agent', async () => {
    const agentId = newAgentId();
    const keychain = await populated(agentId, newAgentId());
    const control = createKeyEraseControl({ backend: 'keychain', keychain });
    const before = keychain.items.size;
    for (const revoke of [
      '',
      await revokeFor(newAgentId()),
      JSON.stringify({ agentId, revokedAt: 1 }),
    ]) {
      await expect(
        control.eraseAgentKeys({ agentId, storageIds: [], revoke }),
      ).rejects.toMatchObject({ code: 'keystore_erase_failed' });
    }
    expect(keychain.deleted).toEqual([]);
    expect(keychain.items.size).toBe(before);
    await control.eraseAgentKeys({ agentId, storageIds: [ID_A], revoke: await revokeFor(agentId) });
    expect(keychain.items.has(agentId)).toBe(false);
    for (const account of OWNER_ACCOUNTS) expect(keychain.items.has(account)).toBe(true);
  });

  it('refuses a malformed request before anything is deleted', async () => {
    const agentId = newAgentId();
    const keychain = await populated(agentId, newAgentId());
    const control = createKeyEraseControl({ backend: 'keychain', keychain });
    const revoke = await revokeFor(agentId);
    for (const request of [
      null,
      { agentId: 'owner', storageIds: [], revoke },
      { agentId, storageIds: 'x', revoke },
      { agentId, storageIds: [1], revoke },
      { agentId, storageIds: ['owner'], revoke },
    ]) {
      await expect(control.eraseAgentKeys(request as never)).rejects.toMatchObject({
        code: 'keystore_erase_failed',
      });
    }
    expect(keychain.deleted).toEqual([]);
  });

  it.runIf(POSIX)('the file backend erases the .alks file with the same rule', async () => {
    const agentId = await fileAgent();
    await writeFile(join(dir, OWNER_FILE), 'owner', { mode: 0o600 });
    const control = createKeyEraseControl({ backend: 'file', keystoreDir: dir });
    await expect(
      control.eraseAgentKeys({ agentId, storageIds: [], revoke: await revokeFor(newAgentId()) }),
    ).rejects.toMatchObject({ code: 'keystore_erase_failed' });
    expect(await exists(join(dir, `${agentId}.alks`))).toBe(true);
    await control.eraseAgentKeys({ agentId, storageIds: [], revoke: await revokeFor(agentId) });
    expect(await exists(join(dir, `${agentId}.alks`))).toBe(false);
    expect(await exists(join(dir, OWNER_FILE))).toBe(true);
  });
});
