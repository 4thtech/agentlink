// M1-8g acceptance against the real Node backends: the core's policy.set and policy load (M1-7d) over
// the SQLite store, the keychain KeyStore and the keychain policy-version mark that openAgentStore
// hands out (04 §2.5.1; 06 §3 G-6; 07 §3.4).
//
// Stated scope (G-1, D-67): the "script" below runs as the same OS user, with read and write access to
// the store file and the agent's keychain items, but without the owner code. It does not modify the
// installed package and does not read process memory. Within that scope, deleting the `policies` row,
// putting back an older signed row or deleting the mark item gives the fail-closed result, never the
// defaults. Outside it: a script that rewrites BOTH the store row and the keychain mark item to an
// older version rolls the policy back; that residual is accepted for M1 (04 §2.5.1) and shown in the
// last test so it is never mistaken for a guarantee.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLinkClient, POLICY_DEFAULTS_EFFECTIVE, type ApprovalChannel } from '@4thtech-io/core';
import {
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  randomBytes,
  type JsonObject,
  type KeyStore,
  type OwnerPublicKeys,
} from '@4thtech-io/crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAgentStoreWith, type AgentStore } from './agent-store.js';
import { createKeychainAgent, openRecordedKeyStore } from './keychain-keystore.js';
import type { KeychainBackend } from './keychain.js';
import { initOwnerWith } from './owner-init.js';
import { KeychainOwnerKeyStore } from './owner-keystore.js';
import type { OwnerTerminal } from './owner-terminal.js';

/** The 04 §2.8 floor, so each Argon2id run is fast in tests. */
const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const RELAYS = ['wss://relay.agentlink.dev', 'wss://nos.lol'];

/** The OS keychain stand-in. A same-user script can read and write every item, as in the OS. */
class MapKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  failSetFor: string | undefined;
  async get(account: string): Promise<Uint8Array | null> {
    await Promise.resolve();
    return this.items.get(account)?.slice() ?? null;
  }
  async set(account: string, value: Uint8Array): Promise<void> {
    await Promise.resolve();
    if (account === this.failSetFor) throw new Error('native: write failed');
    this.items.set(account, value.slice());
  }
  async delete(account: string): Promise<boolean> {
    await Promise.resolve();
    return this.items.delete(account);
  }
}

const approvals: ApprovalChannel = {
  request: (request) => Promise.resolve({ approvalId: request.approvalId }),
  status: () => Promise.resolve({ state: 'pending' }),
};

function codeTerminal() {
  const written: string[] = [];
  const shown = (): string =>
    (written.find((t) => t.startsWith('Your owner code: ')) ?? '').slice(
      'Your owner code: '.length,
    );
  const terminal: OwnerTerminal = {
    write: (text) => void written.push(text),
    readSecret: () => Promise.resolve(encodeUtf8(shown().slice(-4))),
    confirm: () => Promise.resolve(false),
    clearScreen: () => void written.push('<clear>'),
  };
  return { terminal, shown };
}

let dir: string;
let keychain: MapKeychain;
let agentId: string;
let owner: OwnerPublicKeys;
let ownerCode: string;
let path: string;
let t: number;
const open: { store: AgentStore; keyStore: KeyStore }[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-policy-mark-client-'));
  path = join(dir, 'agent.sqlite');
  keychain = new MapKeychain();
  agentId = await createKeychainAgent(keychain);
  const run = codeTerminal();
  ({ owner } = await initOwnerWith(
    keychain,
    run.terminal,
    { backend: 'keychain', env: {} },
    { kdf: KDF },
  ));
  ownerCode = run.shown();
  t = Math.floor(Date.now() / 1000);
});
afterEach(async () => {
  for (const { store, keyStore } of open.splice(0)) {
    await keyStore.close();
    await store.close();
  }
  await rm(dir, { recursive: true, force: true });
});

/** Opens the client as the Node runtime does: the store, its cipher and its mark from openAgentStore. */
async function openClient(): Promise<{ client: AgentLinkClient; store: AgentStore }> {
  const store = await openAgentStoreWith('keychain', agentId, path, { keychain });
  const keyStore = await openRecordedKeyStore('keychain', agentId, { keychain });
  open.push({ store, keyStore });
  const client = await AgentLinkClient.create({
    keyStore,
    store: store.store,
    cipher: store.cipher,
    approvals,
    clock: () => t,
    policyMark: store.policyMark,
  });
  return { client, store };
}

/** One owner operation: the owner code at the prompt, one signature, the session closed. */
async function ownerSign(body: JsonObject): Promise<string> {
  const ownerStore = await KeychainOwnerKeyStore.open(keychain, owner);
  try {
    const session = await ownerStore.unlock({ kind: 'passphrase', secret: encodeUtf8(ownerCode) });
    try {
      return JSON.stringify({ body, sig: await session.signOwnerAction(body) });
    } finally {
      await session.close();
    }
  } finally {
    await ownerStore.close();
  }
}

async function initIdentity(client: AgentLinkClient): Promise<void> {
  const ownerStore = await KeychainOwnerKeyStore.open(keychain, owner);
  const session = await ownerStore.unlock({ kind: 'passphrase', secret: encodeUtf8(ownerCode) });
  try {
    await client.identity.init({ owner: session, ownerKeys: owner, name: 'Agent', relays: RELAYS });
  } finally {
    await session.close();
    await ownerStore.close();
  }
}

function policySet(version: number): Promise<string> {
  const policy = structuredClone(
    (POLICY_DEFAULTS_EFFECTIVE as { policy: unknown }).policy,
  ) as JsonObject;
  return ownerSign({
    v: 1,
    agent: agentId,
    owner: encodeHex(owner.ownerNostr),
    op: 'policy.set',
    params: { version, policy },
    nonce: encodeBase64url(randomBytes(16)),
    issuedAt: t,
    expiresAt: t + 600,
  });
}

/** The same-user script's direct edits of the store file (a separate SQLite connection). */
function script<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(path, { fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

type PolicyRow = Record<string, unknown>;
const readRow = (): PolicyRow | undefined =>
  script((db) => db.prepare('SELECT * FROM "policies"').get() as PolicyRow | undefined);
const putRow = (row: PolicyRow): void =>
  script((db) => {
    db.prepare('DELETE FROM "policies"').run();
    const cols = Object.keys(row);
    db.prepare(
      `INSERT INTO "policies" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols
        .map((c) => `@${c}`)
        .join(', ')})`,
    ).run(row);
  });
/** 04 §2.2: the mark's keychain account, spelled out so this test does not trust the code's name. */
const markAccount = (): string => `${agentId}:policy-version`;

describe('openAgentStore hands the core its policy-version mark (M1-8g)', () => {
  it('the store comes with a mark; a policy.set applies, raises the mark and loads as signed', async () => {
    const { client, store } = await openClient();
    expect(Object.keys(store.policyMark).sort()).toEqual(['raise', 'read']);
    await initIdentity(client);
    expect(await client.ownerActions.loadPolicy()).toEqual(POLICY_DEFAULTS_EFFECTIVE);
    expect(await client.ownerActions.apply(await policySet(1))).toMatchObject({
      status: 'applied',
      op: 'policy.set',
      policyVersion: 1,
      markRaised: true,
    });
    expect(keychain.items.get(markAccount())).toEqual(encodeUtf8('1'));
    expect(await client.ownerActions.loadPolicy()).toMatchObject({ mode: 'signed', version: 1 });
  });

  it('survives a restart: a reopened client loads the signed policy and refuses an older version', async () => {
    const first = await openClient();
    await initIdentity(first.client);
    await first.client.ownerActions.apply(await policySet(3));
    const { client } = await openClient();
    expect(await client.ownerActions.loadPolicy()).toMatchObject({ mode: 'signed', version: 3 });
    expect(await client.ownerActions.apply(await policySet(2))).toMatchObject({
      status: 'refused',
      reason: 'version_not_newer',
    });
    expect(await first.store.policyMark.read()).toBe(3);
  });

  it('a mark that could not be raised leaves the row ahead, and the next load fails closed', async () => {
    const { client } = await openClient();
    await initIdentity(client);
    keychain.failSetFor = markAccount();
    expect(await client.ownerActions.apply(await policySet(1))).toMatchObject({
      status: 'applied',
      markRaised: false,
    });
    expect(readRow()?.['version']).toBe(1);
    expect(await client.ownerActions.loadPolicy()).toEqual({
      mode: 'fail_closed',
      problem: 'mark_mismatch',
    });
  });

  it('a malformed or unreadable mark item fails closed, never as 0 (no defaults, no policy.set)', async () => {
    const { client } = await openClient();
    await initIdentity(client);
    keychain.items.set(markAccount(), encodeUtf8('01'));
    expect(await client.ownerActions.loadPolicy()).toEqual({
      mode: 'fail_closed',
      problem: 'mark_unavailable',
    });
    expect(await client.ownerActions.apply(await policySet(1))).toMatchObject({
      status: 'refused',
      reason: 'policy_mark_unavailable',
    });
    expect(keychain.items.get(markAccount())).toEqual(encodeUtf8('01'));
    expect(readRow()).toBeUndefined();
  });
});

describe('a same-user script without the owner code (G-1, D-67 scope)', () => {
  it('deleting the policies row gives the fail-closed result, never the defaults', async () => {
    const { client } = await openClient();
    await initIdentity(client);
    await client.ownerActions.apply(await policySet(2));
    script((db) => db.prepare('DELETE FROM "policies"').run());
    const loaded = await client.ownerActions.loadPolicy();
    expect(loaded).toEqual({ mode: 'fail_closed', problem: 'missing' });
    expect(loaded).not.toEqual(POLICY_DEFAULTS_EFFECTIVE);
  });

  it('putting back an older signed row is detected against the mark (rolled back)', async () => {
    const { client } = await openClient();
    await initIdentity(client);
    await client.ownerActions.apply(await policySet(1));
    const older = readRow();
    expect(older).toBeDefined();
    await client.ownerActions.apply(await policySet(2));
    putRow(older as PolicyRow);
    expect(await client.ownerActions.loadPolicy()).toEqual({
      mode: 'fail_closed',
      problem: 'rolled_back',
    });
  });

  it('deleting the mark item with the row in place fails closed (a stored policy with mark 0)', async () => {
    const { client } = await openClient();
    await initIdentity(client);
    await client.ownerActions.apply(await policySet(2));
    keychain.items.delete(markAccount());
    const loaded = await client.ownerActions.loadPolicy();
    expect(loaded).toMatchObject({ mode: 'fail_closed' });
    expect(loaded).not.toEqual(POLICY_DEFAULTS_EFFECTIVE);
  });

  it('the mark it can reach through the store offers no lower: raise(0) changes nothing', async () => {
    const { client, store } = await openClient();
    await initIdentity(client);
    await client.ownerActions.apply(await policySet(4));
    expect(await store.policyMark.raise(0)).toBe(4);
    expect(await store.policyMark.raise(1)).toBe(4);
    expect(await client.ownerActions.loadPolicy()).toMatchObject({ mode: 'signed', version: 4 });
  });

  it('residual, outside the claim: rewriting BOTH the row and the mark item rolls back (G-1)', async () => {
    const { client } = await openClient();
    await initIdentity(client);
    await client.ownerActions.apply(await policySet(1));
    const older = readRow();
    await client.ownerActions.apply(await policySet(2));
    putRow(older as PolicyRow);
    keychain.items.set(markAccount(), encodeUtf8('1'));
    expect(await client.ownerActions.loadPolicy()).toMatchObject({ mode: 'signed', version: 1 });
  });
});
