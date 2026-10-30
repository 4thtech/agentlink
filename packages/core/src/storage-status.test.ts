// M1-11r-c (S2; D-48, D-115, D-118): the Storage page reads, drop usage and own-storage status.
//
// - `files.dropUsage()`: the drop bytes this agent reserved in the rolling 7 days (07 §5.4 Limits:
//   1 GiB of ciphertext per drop key, reserved when the upload is granted) against the quota,
//   counted from the agent's own sealed `files` rows. Read-only: no URL, locator, name or key.
// - `ownStorage.status()`: none, ready or broken, plus the last test result of this process. Never
//   the endpoint, bucket, region, id, credential or credentialDigest (I-7, 04 §4).
// - Every result is checked against its exact key set and a fixture grep (zero access).
import { encodeBase64url, encodeHex, randomBytes, type JsonObject } from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { createLogger } from '@4thtech-io/log';
import { alf1CiphertextSize } from '@4thtech-io/storage';
import { describe, expect, it } from 'vitest';
import { AgentLinkClient } from './client.js';
import { seal, type CoreContext } from './context.js';
import type { FilesPlatform } from './files/platform.js';
import {
  DROP_QUOTA_WINDOW_SECONDS,
  DROP_WEEKLY_QUOTA_BYTES,
  type DropUsage,
} from './files/usage.js';
import type { OwnStorageStatus } from './own-storage.js';
import { MemoryStore } from './store/memory-store.js';
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
  S3_CANARY,
  ownerHex,
  signWith,
} from './testing/owner.js';

const START = 1_800_000_000;
const DAY = 86_400;
const ENDPOINT = 'https://acct.r2.cloudflarestorage.com';
const BUCKET = 'agent-files-canary';
const DROP_URL = 'https://drop.example/v1/get/OBJECT-CANARY?e=1&m=MAC-CANARY';
const keysOf = (o: object): string[] => Object.keys(o).sort();

/** Anything that must never appear in a Storage page read (I-7). */
const FORBIDDEN_TEXT = [
  'https://',
  'http://',
  'CANARY',
  'canary',
  S3_CANARY,
  ENDPOINT,
  BUCKET,
  'AKIATESTKEY',
  'FILE-KEY',
  'secret',
];

function assertClean(value: unknown): void {
  const text = JSON.stringify(value);
  for (const needle of FORBIDDEN_TEXT) expect(text, needle).not.toContain(needle);
}

interface Agent {
  readonly client: AgentLinkClient;
  readonly store: MemoryStore;
  readonly ctx: CoreContext;
  readonly keys: MemoryOwnStorageKeys | undefined;
  readonly owner: MemoryOwnerKeyStore;
  readonly id: string;
  readonly clock: FakeClock;
  readonly lines: string[];
}

function dropPlatform(weeklyQuotaBytes?: number): FilesPlatform {
  return {
    allowedFolderRealpaths: () => Promise.resolve([]),
    download: () => {
      throw new Error('unused');
    },
    inbox: () => Promise.reject(new Error('unused')),
    drop: {
      fetch: () => Promise.reject(new Error('no network in this test')),
      ...(weeklyQuotaBytes === undefined ? {} : { weeklyQuotaBytes }),
    },
  };
}

async function agent(
  options: { n?: number; keys?: boolean; files?: FilesPlatform } = {},
): Promise<Agent> {
  const n = options.n ?? 1;
  const clock = new FakeClock(START);
  const owner = new MemoryOwnerKeyStore(seed(170 + n), passphrase());
  const keyStore = new MemoryKeyStore(seed(70 + n));
  const store = new MemoryStore();
  const cipher = new TestStoreCipher();
  const keys = options.keys === false ? undefined : new MemoryOwnStorageKeys();
  const lines: string[] = [];
  const client = await AgentLinkClient.create({
    keyStore,
    store,
    cipher,
    approvals: new RecordingApprovalChannel(),
    clock: clock.now,
    policyMark: new MemoryPolicyMark(),
    ...(keys === undefined ? {} : { ownStorageKeys: keys }),
    ...(options.files === undefined ? {} : { files: options.files }),
    logger: createLogger({ name: 'core', level: 'debug', sink: (_l, line) => lines.push(line) }),
  });
  await client.identity.init({
    owner: await owner.unlock(passphrase()),
    ownerKeys: await owner.getPublicKeys(),
    name: `agent-${String(n)}`,
    relays: RELAYS,
  });
  const ctx: CoreContext = { keyStore, store, cipher, now: clock.now, log: undefined as never };
  return { client, store, ctx, keys, owner, id: client.agentId, clock, lines };
}

let envelopeSeq = 0;

/** One envelope with one file row, sealed like the send writes it (files/records.ts). */
async function insertFile(
  a: Agent,
  file: {
    kind: 'drop' | 's3' | 'inline' | 'received';
    size: number;
    createdAt: number;
    direction?: 'in' | 'out';
    deleted?: boolean;
    locator?: string;
  },
): Promise<void> {
  envelopeSeq += 1;
  const envelopeId = `env-${String(envelopeSeq)}`;
  const key = [envelopeId, 0];
  const locatorText =
    file.locator ??
    JSON.stringify({
      kind: file.kind,
      locator: file.kind === 'inline' ? null : DROP_URL,
      ...(file.kind === 'drop' ? { keyEpoch: 0 } : {}),
    });
  const locator =
    file.locator === undefined
      ? await seal(a.ctx, 'files', 'locator', key, locatorText)
      : (file.locator as never);
  const row = {
    envelope_id: envelopeId,
    idx: 0,
    name: await seal(a.ctx, 'files', 'name', key, 'report-canary.pdf'),
    size: file.size,
    sha256: 'ab'.repeat(32),
    locator,
    url: file.kind === 'inline' ? null : await seal(a.ctx, 'files', 'url', key, DROP_URL),
    file_key: await seal(a.ctx, 'files', 'file_key', key, 'FILE-KEY-CANARY'),
    expires_at: file.createdAt + 7 * DAY,
    deleted_at: file.deleted === true ? file.createdAt + DAY : null,
    delete_after: 'expiry' as const,
    saved_name: null,
    auto_save: null,
    auto_reason: null,
    auto_tries: null,
    auto_next_at: null,
  };
  await a.store.transaction((tx) => {
    tx.insert('envelopes', {
      envelope_id: envelopeId,
      envelope_hash: `hash-${envelopeId}`,
      thread_id: `thread-${envelopeId}`,
      direction: file.direction ?? 'out',
      contact_id: null,
      from_key: 'from',
      type: 'message',
      state: 'ok',
      refused_reason: null,
      created_at: file.createdAt,
      envelope_json: null,
      payload_json: null,
      read_at: null,
      delivery: 'sent',
      refused_at: null,
      request_accepted_at: null,
    });
    tx.insert('files', row);
  });
}

const USAGE_KEYS = ['available', 'level', 'quotaBytes', 'remainingBytes', 'resetsAt', 'usedBytes'];

describe('files.dropUsage (M1-11r-c; 07 §5.4 Limits)', () => {
  it('empty: nothing used, the full 1 GiB weekly quota, within, no reset time', async () => {
    const a = await agent({ files: dropPlatform() });
    const got: DropUsage = await a.client.files.dropUsage();
    expect(keysOf(got)).toEqual(USAGE_KEYS);
    expect(got).toEqual({
      available: true,
      usedBytes: 0,
      quotaBytes: DROP_WEEKLY_QUOTA_BYTES,
      remainingBytes: DROP_WEEKLY_QUOTA_BYTES,
      level: 'within',
      resetsAt: null,
    });
    expect(DROP_WEEKLY_QUOTA_BYTES).toBe(1024 * 1024 * 1024);
    expect(DROP_QUOTA_WINDOW_SECONDS).toBe(7 * DAY);
  });

  it('without a drop in this runtime: available is false, usage still read', async () => {
    const a = await agent();
    expect(await a.client.files.dropUsage()).toEqual({
      available: false,
      usedBytes: 0,
      quotaBytes: DROP_WEEKLY_QUOTA_BYTES,
      remainingBytes: DROP_WEEKLY_QUOTA_BYTES,
      level: 'within',
      resetsAt: null,
    });
  });

  it('partly used: only drop uploads sent in the last 7 days, as ciphertext bytes', async () => {
    const a = await agent({ files: dropPlatform() });
    const now = a.clock.t;
    await insertFile(a, { kind: 'drop', size: 5_000_000, createdAt: now - 2 * DAY });
    await insertFile(a, { kind: 'drop', size: 1_000_000, createdAt: now - DAY, deleted: true });
    // Outside the window, not on the drop, or not this agent's upload: never counted.
    await insertFile(a, { kind: 'drop', size: 9_000_000, createdAt: now - 7 * DAY });
    await insertFile(a, { kind: 's3', size: 9_000_000, createdAt: now - DAY });
    await insertFile(a, { kind: 'inline', size: 9_000, createdAt: now - DAY });
    await insertFile(a, { kind: 'received', size: 9_000_000, createdAt: now - DAY });
    await insertFile(a, { kind: 'drop', size: 9_000_000, createdAt: now - DAY, direction: 'in' });
    const used = alf1CiphertextSize(5_000_000) + alf1CiphertextSize(1_000_000);
    const got = await a.client.files.dropUsage();
    expect(got).toEqual({
      available: true,
      usedBytes: used,
      quotaBytes: DROP_WEEKLY_QUOTA_BYTES,
      remainingBytes: DROP_WEEKLY_QUOTA_BYTES - used,
      level: 'within',
      resetsAt: now - 2 * DAY + 7 * DAY,
    });
    assertClean(got);
    assertClean(a.lines);
  });

  it('near: at 80 % of the quota or more', async () => {
    const quota = 10_000_000;
    const a = await agent({ files: dropPlatform(quota) });
    await insertFile(a, { kind: 'drop', size: 8_000_000, createdAt: a.clock.t - 60 });
    const got = await a.client.files.dropUsage();
    expect(got.quotaBytes).toBe(quota);
    expect(got.usedBytes).toBe(alf1CiphertextSize(8_000_000));
    expect(got.usedBytes / quota).toBeGreaterThanOrEqual(0.8);
    expect(got.level).toBe('near');
  });

  it('over quota: remaining is 0 and the level is reached', async () => {
    const quota = 10_000_000;
    const a = await agent({ files: dropPlatform(quota) });
    await insertFile(a, { kind: 'drop', size: 6_000_000, createdAt: a.clock.t - 3 * DAY });
    await insertFile(a, { kind: 'drop', size: 6_000_000, createdAt: a.clock.t - DAY });
    const got = await a.client.files.dropUsage();
    expect(got.usedBytes).toBe(2 * alf1CiphertextSize(6_000_000));
    expect(got.remainingBytes).toBe(0);
    expect(got.level).toBe('reached');
    expect(got.resetsAt).toBe(a.clock.t - 3 * DAY + 7 * DAY);
  });

  it('exactly at the quota is reached', async () => {
    const size = 1_000_000;
    const a = await agent({ files: dropPlatform(alf1CiphertextSize(size)) });
    await insertFile(a, { kind: 'drop', size, createdAt: a.clock.t });
    const got = await a.client.files.dropUsage();
    expect(got).toMatchObject({ remainingBytes: 0, level: 'reached' });
  });

  it('an invalid quota override is refused, never read as unlimited', async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const a = await agent({ files: dropPlatform(bad) });
      await expect(a.client.files.dropUsage()).rejects.toThrow();
    }
  });

  it('a row whose locator does not open is skipped with a fixed log line, never thrown', async () => {
    const a = await agent({ files: dropPlatform() });
    await insertFile(a, { kind: 'drop', size: 1000, createdAt: a.clock.t, locator: 'garbage' });
    await insertFile(a, { kind: 'drop', size: 2000, createdAt: a.clock.t });
    const got = await a.client.files.dropUsage();
    expect(got.usedBytes).toBe(alf1CiphertextSize(2000));
    assertClean(a.lines);
  });

  it("cross-agent: another agent's uploads never count", async () => {
    const a = await agent({ n: 1, files: dropPlatform() });
    const b = await agent({ n: 2, files: dropPlatform() });
    await insertFile(a, { kind: 'drop', size: 3_000_000, createdAt: a.clock.t });
    expect((await b.client.files.dropUsage()).usedBytes).toBe(0);
    expect((await a.client.files.dropUsage()).usedBytes).toBe(alf1CiphertextSize(3_000_000));
  });
});

// ---- own storage -------------------------------------------------------------------------------

const newId = (): string => encodeHex(randomBytes(8));

async function connect(a: Agent, id = newId()): Promise<string> {
  const digest = (a.keys as MemoryOwnStorageKeys).connect(id);
  const params: JsonObject = {
    id,
    provider: 'r2',
    endpoint: ENDPOINT,
    bucket: BUCKET,
    region: 'auto',
    credentialDigest: digest,
  };
  const signed = await signWith(a.owner, {
    v: 1,
    agent: a.id,
    owner: await ownerHex(a.owner),
    op: 'storage.set',
    params,
    nonce: encodeBase64url(randomBytes(16)),
    issuedAt: a.clock.t,
    expiresAt: a.clock.t + 600,
  });
  const outcome = await a.client.ownerActions.apply(JSON.stringify(signed));
  expect(outcome).toMatchObject({ status: 'applied', op: 'storage.set' });
  return id;
}

describe('ownStorage.status (M1-11r-c; 07 §3.4)', () => {
  it('not connected: none, not configured, no test', async () => {
    const a = await agent();
    const got: OwnStorageStatus = await a.client.ownStorage.status();
    expect(got).toEqual({ state: 'none', configured: false, working: false, lastTest: null });
  });

  it('connected: ready with the provider only, never the endpoint, bucket, id or credential', async () => {
    const a = await agent();
    const id = await connect(a);
    const got = await a.client.ownStorage.status();
    expect(keysOf(got)).toEqual(['configured', 'lastTest', 'provider', 'state', 'working']);
    expect(got).toEqual({
      state: 'ready',
      configured: true,
      working: true,
      provider: 'r2',
      lastTest: null,
    });
    expect(JSON.stringify(got)).not.toContain(id);
    assertClean(got);
    assertClean(a.lines);
  });

  it('broken: configured but not working, with a fixed problem code', async () => {
    const a = await agent();
    const id = await connect(a);
    (a.keys as MemoryOwnStorageKeys).items.delete(id);
    const got = await a.client.ownStorage.status();
    expect(got).toEqual({
      state: 'broken',
      configured: true,
      working: false,
      problem: 'credential_missing',
      lastTest: null,
    });
    assertClean(got);
  });

  it('without the KeyStore items: broken (fail closed), never none', async () => {
    const a = await agent({ keys: false });
    expect(await a.client.ownStorage.status()).toMatchObject({
      state: 'broken',
      configured: true,
      problem: 'keys_unavailable',
    });
  });

  it('the last test result is shown with its time, for the storage it tested', async () => {
    const a = await agent();
    await connect(a);
    a.clock.t += 30;
    await a.client.ownStorage.recordTest({ ok: false, code: 'upload_failed' });
    expect((await a.client.ownStorage.status()).lastTest).toEqual({
      ok: false,
      code: 'upload_failed',
      at: START + 30,
    });
    a.clock.t += 30;
    await a.client.ownStorage.recordTest({ ok: true, code: 'ok' });
    expect((await a.client.ownStorage.status()).lastTest).toEqual({
      ok: true,
      code: 'ok',
      at: START + 60,
    });
    // A new connection is another storage: the old result is not shown for it.
    await connect(a);
    expect((await a.client.ownStorage.status()).lastTest).toBeNull();
  });

  it('a test recorded while nothing is connected is never shown', async () => {
    const a = await agent();
    await a.client.ownStorage.recordTest({ ok: true, code: 'ok' });
    expect((await a.client.ownStorage.status()).lastTest).toBeNull();
  });

  it('refuses a malformed test result (free text could carry a URL or credential)', async () => {
    const a = await agent();
    await connect(a);
    const bad: unknown[] = [
      { ok: true, code: 'upload_failed' },
      { ok: false, code: 'ok' },
      { ok: false, code: ENDPOINT },
      { ok: 'yes', code: 'ok' },
      { ok: true, code: 'ok', detail: S3_CANARY },
      null,
    ];
    for (const result of bad) {
      await expect(
        a.client.ownStorage.recordTest(result as { ok: boolean; code: 'ok' }),
      ).rejects.toThrow();
    }
    expect((await a.client.ownStorage.status()).lastTest).toBeNull();
  });

  it("cross-agent: one agent's test result never shows on another", async () => {
    const a = await agent({ n: 3 });
    const b = await agent({ n: 4 });
    await connect(a);
    await connect(b);
    await a.client.ownStorage.recordTest({ ok: false, code: 'unreachable' });
    expect((await b.client.ownStorage.status()).lastTest).toBeNull();
  });
});
