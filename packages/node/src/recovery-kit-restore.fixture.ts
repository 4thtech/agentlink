// UX1113-R1 test seam (D-147; 04 §2.3.3 "Restore in the app"): a temporary HOME with an in-memory
// keychain, owners, keychain agents with real store snapshots, and kits sealed by the real
// KeyExportControl. Not part of the build (tsconfig.json excludes *.fixture.ts).
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  randomBytes,
  sha256,
  type Argon2idParams,
  type OwnerPublicKeys,
} from '@4thtech-io/crypto';
import { generateSecretCode } from '@4thtech-io/crypto/keystore';
import { AgentLinkClient } from '@4thtech-io/core';
import { createKeyExportControl } from './key-controls.js';
import { createKeychainAgent } from './keychain-keystore.js';
import { keychainAccount, type KeychainBackend } from './keychain.js';
import { KeychainOwnerKeyStore, newOwnerSeed, storeOwnerSeed } from './owner-keystore.js';
import { openAgentStoreWith } from './agent-store.js';
import { openRecordedKeyStore } from './keychain-keystore.js';
import { sampleRow } from './store-rows.fixture.js';
import { encodeSetupRegistration } from './owner-setup.js';
import { VirtualPrfAuthenticator } from './passkey-authenticator.fixture.js';

export const FAST: Argon2idParams = Object.freeze({
  memoryKiB: 19456,
  iterations: 2,
  parallelism: 1,
});

export class MemoryKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  failSetAfter = Infinity;
  /** A set() of this account fails (a crash or a keychain refusal at that write). */
  failAccount: string | undefined;
  get(account: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.items.get(account)?.slice() ?? null);
  }
  set(account: string, value: Uint8Array): Promise<void> {
    if (this.failSetAfter <= 0 || account === this.failAccount) {
      return Promise.reject(new Error('native failure'));
    }
    this.failSetAfter -= 1;
    this.items.set(account, value.slice());
    return Promise.resolve();
  }
  delete(account: string): Promise<boolean> {
    return Promise.resolve(this.items.delete(account));
  }
}

export interface TestOwner {
  readonly seed: Uint8Array;
  readonly keys: OwnerPublicKeys;
  readonly code: Uint8Array;
  readonly keychain: MemoryKeychain;
  readonly store: KeychainOwnerKeyStore;
}

/** An owner item under a generated code in `keychain`. */
export async function makeOwner(keychain = new MemoryKeychain()): Promise<TestOwner> {
  const { seed, keys } = newOwnerSeed();
  const code = generateSecretCode();
  await storeOwnerSeed(keychain, seed, { secret: code.slice(), secretKind: 1 }, { kdf: FAST });
  const store = await KeychainOwnerKeyStore.open(keychain, keys);
  return { seed, keys, code, keychain, store };
}

export interface TestAgent {
  readonly agentId: string;
  readonly name: string;
  readonly keychain: MemoryKeychain;
  readonly snapshot: Uint8Array;
  readonly storePath: string;
}

/**
 * A keychain agent (its items in its own keychain) with a store snapshot whose identity row is the
 * agent and whose card names `owner`, plus `people` active contacts and one message at `lastAt`.
 */
export async function makeAgent(
  root: string,
  owner: TestOwner,
  name: string,
  extra: { readonly people?: number; readonly lastAt?: number; readonly policyMark?: number } = {},
): Promise<TestAgent> {
  const keychain = new MemoryKeychain();
  const agentId = await createKeychainAgent(keychain);
  if (extra.policyMark !== undefined) {
    await keychain.set(
      keychainAccount(agentId, 'policy-version'),
      encodeUtf8(String(extra.policyMark)),
    );
  }
  const dir = await mkdtemp(join(root, 'snap-'));
  const path = join(dir, 'store.sqlite');
  // A card the real identity path issued (identity.init), signed by `owner`, so the restored ID
  // re-verifies at the read-back (04 §2.3.3 step 7) exactly as a real one.
  const opened = await openAgentStoreWith('keychain', agentId, path, { keychain });
  const keyStore = await openRecordedKeyStore('keychain', agentId, { keychain });
  const session = await owner.store.unlock({ kind: 'passphrase', secret: owner.code.slice() });
  try {
    const client = await AgentLinkClient.create({
      keyStore,
      store: opened.store,
      cipher: opened.cipher,
      approvals: {
        request: (request) => Promise.resolve({ approvalId: request.approvalId }),
        status: () => Promise.resolve({ state: 'pending' }),
      },
      policyMark: opened.policyMark,
    });
    await client.identity.init({
      owner: session,
      ownerKeys: owner.keys,
      name,
      relays: ['wss://relay.agentlink.dev', 'wss://nos.lol'],
    });
    const contacts = [];
    for (let i = 0; i < (extra.people ?? 0); i += 1) {
      contacts.push({
        ...(await sampleRow('contacts', i, opened.cipher as never)),
        status: 'active',
      });
    }
    const envelope =
      extra.lastAt === undefined
        ? undefined
        : {
            ...(await sampleRow('envelopes', 0, opened.cipher as never)),
            created_at: extra.lastAt,
          };
    await opened.store.transaction((tx) => {
      for (const contact of contacts) tx.insert('contacts', contact as never);
      if (envelope !== undefined) tx.insert('envelopes', envelope as never);
    });
  } finally {
    await session.close();
    await keyStore.close();
    await opened.close();
  }
  const db = new Database(path);
  const out = join(dir, 'snap.sqlite');
  db.prepare('VACUUM INTO ?').run(out);
  db.close();
  return {
    agentId,
    name,
    keychain,
    snapshot: new Uint8Array(await readFile(out)),
    storePath: path,
  };
}

/** A kit of `agents` sealed by the real export control into `dir`. */
export async function makeKit(
  root: string,
  owner: TestOwner,
  agents: readonly TestAgent[],
  file = `agentlink-recovery-kit-${encodeHex(randomBytes(3))}.alkk`,
  dir = root,
): Promise<{ readonly path: string; readonly code: string; readonly kitId: string }> {
  const session = await owner.store.unlockForExport({
    kind: 'passphrase',
    secret: owner.code.slice(),
  });
  const control = createKeyExportControl({
    owner: owner.store,
    itemsOf: (agentId) => agents.find((a) => a.agentId === agentId)?.keychain as MemoryKeychain,
    storePathOf: (agentId) => agents.find((a) => a.agentId === agentId)?.storePath as string,
    agentlinkDir: join(root, 'not-agentlink'),
    kdf: FAST,
  });
  await mkdir(dir, { recursive: true });
  const path = join(dir, file);
  const kitId = encodeBase64url(randomBytes(16));
  const code = await control.sealRecoveryKit(session, {
    kitId,
    createdAt: 1_760_000_000,
    contents: 'full',
    agents: agents.map((a) => ({ agentId: a.agentId, name: a.name })),
    snapshots: (agentId: string) => {
      const bytes = agents.find((a) => a.agentId === agentId)?.snapshot as Uint8Array;
      return Promise.resolve({ length: bytes.length, chunks: [bytes] });
    },
    path,
  });
  await session.close();
  return { path, code: String.fromCharCode(...code), kitId };
}

export async function tempRoot(prefix: string): Promise<{
  readonly root: string;
  readonly home: string;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const home = join(root, 'home');
  await mkdir(join(home, 'Downloads'), { recursive: true });
  await mkdir(join(home, 'Desktop'), { recursive: true });
  return { root, home, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** What the page does with `apply/begin`'s creation values: a create() on a virtual passkey. */
export function webauthnCreate(
  authenticator: VirtualPrfAuthenticator,
  publicKey: { readonly challenge: string; readonly userId: string; readonly prfSalt: string },
  origin: string,
  withPrf = true,
): Uint8Array {
  const made = authenticator.create(
    Buffer.from(publicKey.userId, 'base64url'),
    Buffer.from(publicKey.prfSalt, 'base64url'),
  );
  const clientDataJSON = encodeUtf8(
    JSON.stringify({ type: 'webauthn.create', challenge: publicKey.challenge, origin }),
  );
  return encodeSetupRegistration({
    credentialId: made.credentialId,
    authenticatorData: made.authenticatorData,
    clientDataJSON,
    prfOutput: withPrf ? made.prfOutput : new Uint8Array(0),
  });
}

/** The second gesture of `prf_needed`: the create response again plus a signed get(). */
export function webauthnCreateThenGet(
  authenticator: VirtualPrfAuthenticator,
  created: Uint8Array,
  publicKey: { readonly challenge: string; readonly prfSalt: string },
  origin: string,
): Uint8Array {
  const fields: Uint8Array[] = [];
  let at = 0;
  while (at < created.length) {
    const n = ((created[at] as number) << 8) | (created[at + 1] as number);
    fields.push(created.slice(at + 2, at + 2 + n));
    at += 2 + n;
  }
  const got = authenticator.get(Buffer.from(publicKey.prfSalt, 'base64url'));
  const clientDataJSON = encodeUtf8(
    JSON.stringify({ type: 'webauthn.get', challenge: publicKey.challenge, origin }),
  );
  const signature = authenticator.sign(got.authenticatorData, clientDataJSON);
  return encodeSetupRegistration({
    credentialId: fields[0] as Uint8Array,
    authenticatorData: fields[1] as Uint8Array,
    clientDataJSON: fields[2] as Uint8Array,
    prfOutput: got.prfOutput,
    assertion: {
      credentialId: got.credentialId,
      authenticatorData: got.authenticatorData,
      clientDataJSON,
      signature,
    },
  });
}

export const headerHashOf = (kit: Uint8Array): Uint8Array => sha256(kit.subarray(0, 74));
