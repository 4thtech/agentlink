// M1-9i-a (S2; D-115): own storage and backup owner ops in the core.
//
// - `storage.set`, `storage.remove` and `backup.export` are applied only with the owner's signature
//   (I-4): another signer, another agent, a replay, an expired object or one outliving L(op) = 600 s
//   is refused and writes nothing.
// - `storage.set` applies only when the item `s3:<id>` exists and its credentialDigest matches; the
//   nonce row and the `own_storage` upsert are one store transaction, then `storage-mark` is set.
// - `storage.remove` applies only to the active id; the nonce row and the delete are one
//   transaction, then `storage-mark` is set to `active: null`.
// - `backup.export` writes only its nonce row (the audit record, 04 §2.3.3).
// - `ownStorage.load()` re-verifies the stored `storage.set` (never its expiry) and reads `none`,
//   `ready` or `broken`; `broken` is never repaired from the row (07 §3.4).
// - No credential ever reaches a row, a log line or a result (I-7).
import {
  decodeUtf8,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  randomBytes,
  type JsonObject,
  type StorageCredentialItemFields,
} from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { createLogger } from '@4thtech-io/log';
import { validateS3Endpoint } from '@4thtech-io/storage';
import { isCanonicalS3Endpoint } from '@4thtech-io/types';
import { describe, expect, it } from 'vitest';
import { AgentLinkClient } from './client.js';
import { decodeStorageMark, encodeStorageMark } from './own-storage.js';
import { MemoryStore } from './store/memory-store.js';
import type { Sealed } from './store/schema.js';
import { rowKeyOf } from './store/store.js';
import {
  FakeClock,
  RELAYS,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
} from './testing/fixtures.js';
import {
  MemoryOwnStorageKeys,
  MemoryPolicyMark,
  S3_SECRET_CANARY,
  ownerHex,
  signWith,
} from './testing/owner.js';

const START = 1_800_000_000;
const ENDPOINT = 'https://acct.r2.cloudflarestorage.com';
const BUCKET = 'agent-files-canary';

interface Agent {
  readonly client: AgentLinkClient;
  readonly store: MemoryStore;
  readonly cipher: TestStoreCipher;
  readonly keys: MemoryOwnStorageKeys | undefined;
  readonly owner: MemoryOwnerKeyStore;
  readonly id: string;
  readonly clock: FakeClock;
  readonly lines: string[];
}

async function agent(options: { keys?: boolean; n?: number } = {}): Promise<Agent> {
  const n = options.n ?? 1;
  const clock = new FakeClock(START);
  const owner = new MemoryOwnerKeyStore(seed(150 + n), passphrase());
  const store = new MemoryStore();
  const cipher = new TestStoreCipher();
  const keys = options.keys === false ? undefined : new MemoryOwnStorageKeys();
  const lines: string[] = [];
  const client = await AgentLinkClient.create({
    keyStore: new MemoryKeyStore(seed(50 + n)),
    store,
    cipher,
    approvals: new RecordingApprovalChannel(),
    clock: clock.now,
    policyMark: new MemoryPolicyMark(),
    ...(keys === undefined ? {} : { ownStorageKeys: keys }),
    logger: createLogger({ name: 'core', level: 'debug', sink: (_l, line) => lines.push(line) }),
  });
  await client.identity.init({
    owner: await owner.unlock(passphrase()),
    ownerKeys: await owner.getPublicKeys(),
    name: `agent-${String(n)}`,
    relays: RELAYS,
  });
  return { client, store, cipher, keys, owner, id: client.agentId, clock, lines };
}

const newId = (): string => encodeHex(randomBytes(8));
const newKitId = (): string => encodeBase64url(randomBytes(16));

interface SignOptions {
  readonly signer?: MemoryOwnerKeyStore;
  readonly agentId?: string;
  readonly issuedAt?: number;
  readonly life?: number;
  readonly nonce?: string;
}

async function sign(a: Agent, op: string, params: JsonObject, o: SignOptions = {}) {
  const issuedAt = o.issuedAt ?? a.clock.t;
  return signWith(o.signer ?? a.owner, {
    v: 1,
    agent: o.agentId ?? a.id,
    owner: await ownerHex(a.owner),
    op,
    params,
    nonce: o.nonce ?? encodeBase64url(randomBytes(16)),
    issuedAt,
    expiresAt: issuedAt + (o.life ?? 600),
  });
}

const setParams = (id: string, digest: string, over: JsonObject = {}): JsonObject => ({
  id,
  provider: 'r2',
  endpoint: ENDPOINT,
  bucket: BUCKET,
  region: 'auto',
  credentialDigest: digest,
  ...over,
});

/** Writes `s3:<id>`, signs and applies a storage.set for it. Returns the id. */
async function connect(a: Agent, id = newId()): Promise<string> {
  const digest = (a.keys as MemoryOwnStorageKeys).connect(id);
  const outcome = await a.client.ownerActions.apply(
    JSON.stringify(await sign(a, 'storage.set', setParams(id, digest))),
  );
  expect(outcome).toEqual({ status: 'applied', op: 'storage.set', storageMarkSet: true });
  return id;
}

const rows = (a: Agent) => a.store.transaction((tx) => tx.select('own_storage'));
const nonces = (a: Agent) => a.store.transaction((tx) => tx.select('owner_action_nonces'));

/** Everything the store holds for these tables, and every log line, as one string. */
async function dump(a: Agent): Promise<string> {
  const tables = await a.store.transaction((tx) =>
    JSON.stringify({ own: tx.select('own_storage'), nonces: tx.select('owner_action_nonces') }),
  );
  return tables + a.lines.join('\n');
}

describe('storage.set (04 §2.5.1; 07 §3.4)', () => {
  it('applies: one sealed row, the nonce row, then storage-mark; load reads ready', async () => {
    const a = await agent();
    const id = await connect(a);
    const stored = await rows(a);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe(id);
    expect(stored[0]?.applied_at).toBe(START);
    // signed_json is sealed: the endpoint and bucket identify the user's account.
    expect(String(stored[0]?.signed_json)).not.toContain(BUCKET);
    expect((await nonces(a)).map((r) => r.op)).toEqual(['storage.set']);
    expect(a.keys?.writes).toEqual([id]);
    expect(decodeStorageMark(a.keys?.mark as Uint8Array)).toEqual({ active: id });
    expect(await a.client.ownStorage.load()).toEqual({
      state: 'ready',
      id,
      provider: 'r2',
      endpoint: ENDPOINT,
      bucket: BUCKET,
      region: 'auto',
    });
  });

  it('a newer storage.set replaces the row (one own storage per agent in M1)', async () => {
    const a = await agent();
    await connect(a);
    const second = await connect(a);
    expect((await rows(a)).map((r) => r.id)).toEqual([second]);
    expect(await a.client.ownStorage.load()).toMatchObject({ state: 'ready', id: second });
  });

  it('is refused and writes nothing when s3:<id> is missing or its digest does not match', async () => {
    const a = await agent();
    const keys = a.keys as MemoryOwnStorageKeys;
    const missing = await a.client.ownerActions.apply(
      JSON.stringify(await sign(a, 'storage.set', setParams(newId(), 'ab'.repeat(32)))),
    );
    expect(missing).toMatchObject({ status: 'refused', reason: 'credential_missing' });
    const id = newId();
    keys.connect(id);
    const other = keys.connect(newId());
    const mismatch = await a.client.ownerActions.apply(
      JSON.stringify(await sign(a, 'storage.set', setParams(id, other))),
    );
    expect(mismatch).toMatchObject({ status: 'refused', reason: 'credential_mismatch' });
    expect(await rows(a)).toEqual([]);
    expect(await nonces(a)).toEqual([]);
    expect(keys.writes).toEqual([]);
    expect(await a.client.ownStorage.load()).toEqual({ state: 'none' });
  });

  it('refuses another signer, another agent, a lifetime above 600 s, expiry and a replay', async () => {
    const a = await agent();
    const keys = a.keys as MemoryOwnStorageKeys;
    const stranger = new MemoryOwnerKeyStore(seed(199), passphrase());
    const cases: [SignOptions, string][] = [
      [{ signer: stranger }, 'signature_invalid'],
      [{ agentId: `0x${'1a'.repeat(20)}` }, 'agent_mismatch'],
      [{ life: 601 }, 'lifetime_exceeded'],
      [{ issuedAt: START - 700 }, 'expired'],
    ];
    for (const [over, reason] of cases) {
      const id = newId();
      const signed = await sign(a, 'storage.set', setParams(id, keys.connect(id)), over);
      expect(await a.client.ownerActions.apply(JSON.stringify(signed))).toMatchObject({
        status: 'refused',
        reason,
      });
    }
    expect(await rows(a)).toEqual([]);
    const id = newId();
    const signed = JSON.stringify(await sign(a, 'storage.set', setParams(id, keys.connect(id))));
    expect((await a.client.ownerActions.apply(signed)).status).toBe('applied');
    expect(await a.client.ownerActions.apply(signed)).toMatchObject({
      status: 'refused',
      reason: 'nonce_used',
    });
    expect(await nonces(a)).toHaveLength(1);
  });

  it('refuses a params form the schema does not allow (malformed), writing nothing', async () => {
    const a = await agent();
    const id = newId();
    const digest = (a.keys as MemoryOwnStorageKeys).connect(id);
    for (const over of [
      { endpoint: `${ENDPOINT}/` },
      { id: id.toUpperCase() },
      { secretAccessKey: S3_SECRET_CANARY },
    ]) {
      const signed = await sign(a, 'storage.set', setParams(id, digest, over));
      expect(await a.client.ownerActions.apply(JSON.stringify(signed))).toMatchObject({
        status: 'refused',
        reason: 'malformed',
      });
    }
    expect(await rows(a)).toEqual([]);
    expect(await dump(a)).not.toContain(S3_SECRET_CANARY);
  });

  it('without the own-storage KeyStore items, nothing applies (fail closed)', async () => {
    const a = await agent({ keys: false });
    const signed = await sign(a, 'storage.set', setParams(newId(), 'ab'.repeat(32)));
    expect(await a.client.ownerActions.apply(JSON.stringify(signed))).toMatchObject({
      status: 'refused',
      reason: 'storage_keys_unavailable',
    });
    expect(await rows(a)).toEqual([]);
    expect(await a.client.ownStorage.load()).toMatchObject({ state: 'broken' });
  });

  it('a failed storage-mark write is reported, and the load reads broken until a new connect', async () => {
    const a = await agent();
    const keys = a.keys as MemoryOwnStorageKeys;
    keys.failWrite = true;
    const id = newId();
    const outcome = await a.client.ownerActions.apply(
      JSON.stringify(await sign(a, 'storage.set', setParams(id, keys.connect(id)))),
    );
    expect(outcome).toEqual({ status: 'applied', op: 'storage.set', storageMarkSet: false });
    expect(await a.client.ownStorage.load()).toMatchObject({ state: 'broken' });
    keys.failWrite = false;
    await connect(a);
    expect(await a.client.ownStorage.load()).toMatchObject({ state: 'ready' });
  });
});

describe('storage.remove (04 §2.5.1)', () => {
  it('applies only to the active id: deletes the row, then storage-mark is active: null', async () => {
    const a = await agent();
    const id = await connect(a);
    const wrong = await a.client.ownerActions.apply(
      JSON.stringify(await sign(a, 'storage.remove', { id: newId() })),
    );
    expect(wrong).toMatchObject({ status: 'refused', reason: 'storage_not_active' });
    expect(await rows(a)).toHaveLength(1);
    expect(await nonces(a)).toHaveLength(1);

    const removed = await a.client.ownerActions.apply(
      JSON.stringify(await sign(a, 'storage.remove', { id })),
    );
    expect(removed).toEqual({ status: 'applied', op: 'storage.remove', storageMarkSet: true });
    expect(await rows(a)).toEqual([]);
    expect((await nonces(a)).map((r) => r.op).sort()).toEqual(['storage.remove', 'storage.set']);
    expect(decodeStorageMark(a.keys?.mark as Uint8Array)).toEqual({ active: null });
    expect(await a.client.ownStorage.load()).toEqual({ state: 'none' });
  });

  it('with no own storage, is refused and writes nothing', async () => {
    const a = await agent();
    expect(
      await a.client.ownerActions.apply(
        JSON.stringify(await sign(a, 'storage.remove', { id: newId() })),
      ),
    ).toMatchObject({ status: 'refused', reason: 'storage_not_active' });
    expect(await nonces(a)).toEqual([]);
  });

  it('refuses a lifetime above 600 s and another signer', async () => {
    const a = await agent();
    const id = await connect(a);
    const stranger = new MemoryOwnerKeyStore(seed(198), passphrase());
    for (const [over, reason] of [
      [{ life: 601 }, 'lifetime_exceeded'],
      [{ signer: stranger }, 'signature_invalid'],
    ] as const) {
      expect(
        await a.client.ownerActions.apply(
          JSON.stringify(await sign(a, 'storage.remove', { id }, over)),
        ),
      ).toMatchObject({ status: 'refused', reason });
    }
    expect(await rows(a)).toHaveLength(1);
  });
});

describe('backup.export (04 §2.5.1, §2.3.3)', () => {
  it('records only its nonce row (the audit record)', async () => {
    const a = await agent();
    const before = await a.store.transaction((tx) => JSON.stringify(tx.select('own_storage')));
    const outcome = await a.client.ownerActions.apply(
      JSON.stringify(await sign(a, 'backup.export', { kitId: newKitId(), contents: 'full' })),
    );
    expect(outcome).toEqual({ status: 'applied', op: 'backup.export' });
    const recorded = await nonces(a);
    expect(recorded.map((r) => r.op)).toEqual(['backup.export']);
    expect(recorded[0]?.applied_at).toBe(START);
    expect(await a.store.transaction((tx) => JSON.stringify(tx.select('own_storage')))).toBe(
      before,
    );
    expect(a.keys?.writes).toEqual([]);
  });

  it('refuses a replay, a lifetime above 600 s and another signer', async () => {
    const a = await agent();
    const signed = JSON.stringify(
      await sign(a, 'backup.export', { kitId: newKitId(), contents: 'identity' }),
    );
    expect((await a.client.ownerActions.apply(signed)).status).toBe('applied');
    expect(await a.client.ownerActions.apply(signed)).toMatchObject({ reason: 'nonce_used' });
    const stranger = new MemoryOwnerKeyStore(seed(197), passphrase());
    for (const [over, reason] of [
      [{ life: 601 }, 'lifetime_exceeded'],
      [{ signer: stranger }, 'signature_invalid'],
    ] as const) {
      expect(
        await a.client.ownerActions.apply(
          JSON.stringify(
            await sign(a, 'backup.export', { kitId: newKitId(), contents: 'full' }, over),
          ),
        ),
      ).toMatchObject({ status: 'refused', reason });
    }
    expect(await nonces(a)).toHaveLength(1);
  });

  it('works without the own-storage KeyStore items (it touches none)', async () => {
    const a = await agent({ keys: false });
    expect(
      await a.client.ownerActions.apply(
        JSON.stringify(await sign(a, 'backup.export', { kitId: newKitId(), contents: 'full' })),
      ),
    ).toEqual({ status: 'applied', op: 'backup.export' });
  });
});

describe('ownStorage.load() (07 §3.4; 04 §2.5.1 "Stored objects are re-verified")', () => {
  it('none without a row and with storage-mark missing (an agent from before M1-9i)', async () => {
    const a = await agent();
    expect(a.keys?.mark).toBeNull();
    expect(await a.client.ownStorage.load()).toEqual({ state: 'none' });
    (a.keys as MemoryOwnStorageKeys).mark = encodeStorageMark(null);
    expect(await a.client.ownStorage.load()).toEqual({ state: 'none' });
  });

  it('a row older than 600 s still reads ready (expiry is never checked again)', async () => {
    const a = await agent();
    const id = await connect(a);
    a.clock.t = START + 30 * 86_400;
    expect(await a.client.ownStorage.load()).toMatchObject({ state: 'ready', id });
  });

  it('a tampered row reads broken, and is not repaired', async () => {
    const a = await agent();
    const id = await connect(a);
    const context = { table: 'own_storage' as const, column: 'signed_json', rowKey: rowKeyOf([id]) };
    const row = (await rows(a))[0];
    const text = await a.cipher.open(context, row?.signed_json as Sealed);
    const edited = text.replace(BUCKET, 'attacker-bucket');
    expect(edited).not.toBe(text);
    const sealed = await a.cipher.seal(context, edited);
    await a.store.transaction((tx) => tx.update('own_storage', { id }, { signed_json: sealed }));
    expect(await a.client.ownStorage.load()).toMatchObject({ state: 'broken' });
    expect((await rows(a))[0]?.signed_json).toBe(sealed);
  });

  it('a row sealed for another key, or not opening at all, reads broken', async () => {
    const a = await agent();
    const id = await connect(a);
    await a.store.transaction((tx) =>
      tx.update('own_storage', { id }, { signed_json: 'garbage' as Sealed }),
    );
    expect(await a.client.ownStorage.load()).toMatchObject({ state: 'broken' });
  });

  it('a credential digest mismatch or a missing item reads broken', async () => {
    const a = await agent();
    const keys = a.keys as MemoryOwnStorageKeys;
    const id = await connect(a);
    // Another credential put in the item (a same-user script swapping keys).
    const saved = keys.items.get(id) as StorageCredentialItemFields;
    keys.connect(id, 'AKIAOTHER', 'other-secret');
    expect(await a.client.ownStorage.load()).toMatchObject({ state: 'broken' });
    keys.items.delete(id);
    expect(await a.client.ownStorage.load()).toMatchObject({ state: 'broken' });
    keys.items.set(id, saved);
    expect(await a.client.ownStorage.load()).toMatchObject({ state: 'ready' });
    keys.failDigest = true;
    expect(await a.client.ownStorage.load()).toMatchObject({ state: 'broken' });
  });

  it('an old row and credential put back after storage.remove read broken', async () => {
    const a = await agent();
    const keys = a.keys as MemoryOwnStorageKeys;
    const id = await connect(a);
    const oldRow = (await rows(a))[0];
    const oldItem = keys.items.get(id) as StorageCredentialItemFields;
    await a.client.ownerActions.apply(JSON.stringify(await sign(a, 'storage.remove', { id })));
    keys.items.delete(id); // the CLI deletes s3:<id> after the commit (04 §2.5.1)
    expect(await a.client.ownStorage.load()).toEqual({ state: 'none' });
    // Roll back the store row and the credential item, but not storage-mark.
    await a.store.transaction((tx) => tx.insert('own_storage', oldRow as never));
    keys.items.set(id, oldItem);
    expect(await a.client.ownStorage.load()).toMatchObject({ state: 'broken' });
  });

  it('an older connect put back after a newer one reads broken (anti-rollback by id)', async () => {
    const a = await agent();
    const keys = a.keys as MemoryOwnStorageKeys;
    const first = await connect(a);
    const firstRow = (await rows(a))[0];
    await connect(a);
    await a.store.transaction((tx) => {
      tx.delete('own_storage', {});
      tx.insert('own_storage', firstRow as never);
    });
    expect(keys.items.has(first)).toBe(true);
    expect(await a.client.ownStorage.load()).toMatchObject({ state: 'broken' });
  });

  it('no row while storage-mark names an id reads broken (never none)', async () => {
    const a = await agent();
    await connect(a);
    await a.store.transaction((tx) => tx.delete('own_storage', {}));
    expect(await a.client.ownStorage.load()).toMatchObject({ state: 'broken' });
  });

  it('a malformed or unreadable storage-mark reads broken, with or without a row', async () => {
    const a = await agent();
    const keys = a.keys as MemoryOwnStorageKeys;
    for (const bad of [
      '',
      '{"active":null}',
      '{"v":1}',
      '{"v":2,"active":null}',
      '{"v":1,"active":null} ',
      '{"active":null,"v":1,"x":1}',
      '{ "active":null,"v":1}',
      '{"v":1,"active":null}',
      '{"active":"0123456789ABCDEF","v":1}',
      '{"active":"0123456789abcde","v":1}',
      '{"active":7,"v":1}',
    ]) {
      keys.mark = encodeUtf8(bad);
      expect(await a.client.ownStorage.load(), bad).toMatchObject({ state: 'broken' });
    }
    keys.mark = null;
    keys.failRead = true;
    expect(await a.client.ownStorage.load()).toMatchObject({ state: 'broken' });
    keys.failRead = false;
    await connect(a);
    keys.mark = encodeUtf8('{"active":null,"v":1');
    expect(await a.client.ownStorage.load()).toMatchObject({ state: 'broken' });
  });

  it('a row with storage-mark active: null reads broken', async () => {
    const a = await agent();
    const keys = a.keys as MemoryOwnStorageKeys;
    await connect(a);
    keys.mark = encodeStorageMark(null);
    expect(await a.client.ownStorage.load()).toMatchObject({ state: 'broken' });
  });

  it('a row whose id column disagrees with its signed id reads broken', async () => {
    const a = await agent();
    const keys = a.keys as MemoryOwnStorageKeys;
    const id = await connect(a);
    const other = newId();
    const row = (await rows(a))[0];
    const context = { table: 'own_storage' as const, column: 'signed_json' };
    const text = await a.cipher.open({ ...context, rowKey: rowKeyOf([id]) }, row?.signed_json as Sealed);
    const resealed = await a.cipher.seal({ ...context, rowKey: rowKeyOf([other]) }, text);
    await a.store.transaction((tx) => {
      tx.delete('own_storage', {});
      tx.insert('own_storage', { id: other, signed_json: resealed, applied_at: START });
    });
    keys.mark = encodeStorageMark(other);
    keys.items.set(other, keys.items.get(id) as StorageCredentialItemFields);
    expect(await a.client.ownStorage.load()).toMatchObject({ state: 'broken' });
  });

  it('a storage.set signed by another owner reads broken', async () => {
    const a = await agent({ n: 1 });
    const b = await agent({ n: 2 });
    // b's storage.set, moved into a's store with a's own mark and item.
    const id = await connect(b);
    const row = (await rows(b))[0];
    const context = { table: 'own_storage' as const, column: 'signed_json', rowKey: rowKeyOf([id]) };
    const text = await b.cipher.open(context, row?.signed_json as Sealed);
    const sealed = await a.cipher.seal(context, text);
    await a.store.transaction((tx) =>
      tx.insert('own_storage', { id, signed_json: sealed, applied_at: START }),
    );
    (a.keys as MemoryOwnStorageKeys).mark = encodeStorageMark(id);
    (a.keys as MemoryOwnStorageKeys).items.set(id, b.keys?.items.get(id) as StorageCredentialItemFields);
    expect(await a.client.ownStorage.load()).toMatchObject({ state: 'broken' });
  });

  it('never puts the credential, endpoint or bucket into a log line', async () => {
    const a = await agent();
    const keys = a.keys as MemoryOwnStorageKeys;
    await connect(a);
    keys.mark = encodeUtf8('{}');
    await a.client.ownStorage.load();
    const logs = a.lines.join('\n');
    for (const secret of [S3_SECRET_CANARY, BUCKET, 'acct.r2']) {
      expect(logs).not.toContain(secret);
    }
    expect(await dump(a)).not.toContain(S3_SECRET_CANARY);
  });
});

describe('storage-mark item codec (04 §2.2)', () => {
  it('is exactly JCS {"active","v":1}', () => {
    expect(decodeUtf8(encodeStorageMark(null))).toBe('{"active":null,"v":1}');
    expect(decodeUtf8(encodeStorageMark('0123456789abcdef'))).toBe(
      '{"active":"0123456789abcdef","v":1}',
    );
    expect(decodeStorageMark(encodeStorageMark('0123456789abcdef'))).toEqual({
      active: '0123456789abcdef',
    });
    expect(() => encodeStorageMark('0123456789ABCDEF')).toThrow();
    expect(() => decodeStorageMark(encodeUtf8('{"active":null,"v":1}\n'))).toThrow();
  });
});

describe('isCanonicalS3Endpoint agrees with the S3 adapter (no drift from validateS3Endpoint)', () => {
  const inputs = [
    'https://acct.r2.cloudflarestorage.com',
    'https://acct.r2.cloudflarestorage.com/',
    'https://s3.eu-central-1.amazonaws.com:443',
    'https://s3.example.com:65535',
    'https://s3.example.com:65536',
    'https://s3.example.com:0',
    'https://xn--bcher-kva.example',
    'https://xn--.example',
    'https://a.b',
    'https://a.b1',
    'https://a.co',
    'https://localhost',
    'https://foo.home.arpa',
    'https://10.1.2.3',
    'https://0x10.example.com',
    'https://123.example.com',
    'https://-a.example.com',
    'https://a-.example.com',
    'https://a_b.example.com',
    'http://s3.example.com',
    'https://S3.example.com',
    'https://s3.example.com/x',
    `https://${'a'.repeat(63)}.example.com`,
    `https://${'a'.repeat(64)}.example.com`,
    `https://${'abcdefgh.'.repeat(28)}com`,
    `https://${'abcdefgh.'.repeat(27)}com`,
  ];
  it('accepts exactly the adapter output, and nothing that the adapter would rewrite', () => {
    for (const input of inputs) {
      let canonical: string | undefined;
      try {
        canonical = validateS3Endpoint(input);
      } catch {
        canonical = undefined;
      }
      expect(isCanonicalS3Endpoint(input), input).toBe(canonical === input);
    }
  });
});
