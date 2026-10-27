// MSG-FILES-IO-a: the read-only Messages and Files In/Out views of the local app (plan
// docs/process/proposals/MSG-FILES-IO.md §3, §4; 06 §2.2, §4; 07 §3, §3.1; 04 §4).
//
// What these tests hold the views to:
// - they never write: `read_at` and every other row of every table are unchanged after each call
//   (reading in the app never marks a message read for the AI; I-4);
// - every item is built from an allowlist: exact key sets, and no URL, file key, ciphertext hash,
//   `envelope_json` or sealed value in any result (zero access, I-7);
// - only the inbox selection is listed: user message types in state `ok` from a contact that is
//   not removed; never a request, a refused, held or protocol row;
// - the store only: they answer with the transport and file storage failing (no network).
// Rows are written straight into the store the way the pipelines store them (inbox-page.test.ts).
import { encodeBase64url, encodeHex, randomBytes, termsHash } from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { createLogger } from '@4thtech-io/log';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentLinkClient } from './client.js';
import { seal, type CoreContext } from './context.js';
import { CoreError } from './errors.js';
import type { FilesPlatform } from './files/platform.js';
import { SHREDDED_FILE_KEY } from './files/received.js';
import { MemoryStore } from './store/memory-store.js';
import { TABLE_NAMES, type Row } from './store/schema.js';
import { rowKeyOf } from './store/store.js';
import { pairWith, type TestAgent, type TestOwner } from './testing/envelopes.js';
import {
  FakeClock,
  RELAYS,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
} from './testing/fixtures.js';
import {
  FilesIoView,
  MessagesView,
  type Conversation,
  type MessageItem,
  type ReceivedFileItem,
  type SentFileItem,
} from './ui-messages.js';

const DROP_ORIGIN = 'https://drop.agentlink.example';
const CANARY_URL = `${DROP_ORIGIN}/o/CANARY-DROP-URL`;
const FILE_KEY = encodeBase64url(new Uint8Array(32).fill(7));
const CIPHER_SHA = 'cd'.repeat(32);
const ENVELOPE_JSON = '{"CANARY":"ENVELOPE-JSON-MUST-NOT-LEAK"}';

const clock = new FakeClock();
let lines: string[] = [];

/** Throws on every use: the views must never reach the network or file storage. */
const failing = (): never => {
  throw new Error('NETWORK-MUST-NOT-BE-USED');
};
const failingPlatform = new Proxy({} as FilesPlatform, {
  get: (_t, prop) => (prop === 'then' ? undefined : failing),
});

async function makeAgent(n: number, name: string, offline = false): Promise<TestAgent> {
  const keyStore = new MemoryKeyStore(seed(n));
  const owner = new MemoryOwnerKeyStore(seed(100 + n), passphrase()) as unknown as TestOwner;
  const store = new MemoryStore();
  const cipher = new TestStoreCipher();
  const client = await AgentLinkClient.create({
    keyStore,
    store,
    cipher,
    approvals: new RecordingApprovalChannel(),
    clock: clock.now,
    logger: createLogger({ name: 'core', level: 'debug', sink: (_l, line) => lines.push(line) }),
    dropOrigins: [DROP_ORIGIN],
    ...(offline ? { transport: failing, files: failingPlatform } : {}),
  });
  await client.identity.init({
    owner: await owner.unlock(passphrase()),
    ownerKeys: await owner.getPublicKeys(),
    name,
    relays: RELAYS,
  });
  return { client, store, cipher, keyStore, owner, id: client.agentId };
}

let a: TestAgent;
let b: TestAgent;
let c: TestAgent;

const T0 = 1_799_990_000;

beforeEach(async () => {
  clock.t = 1_800_000_000;
  lines = [];
  a = await makeAgent(1, 'Alice');
  b = await makeAgent(2, 'Bob');
  c = await makeAgent(3, 'Carol');
  await pairWith(clock, a, b);
  await pairWith(clock, a, c);
});

const ctxOf = (agent: TestAgent): CoreContext => ({
  keyStore: agent.keyStore,
  store: agent.store,
  cipher: agent.cipher,
  now: clock.now,
  log: createLogger({ name: 'core', level: 'debug', sink: (_l, line) => lines.push(line) }),
});

// ---- Row helpers ---------------------------------------------------------------------------------

const newId = (): string => encodeBase64url(randomBytes(16));

const nostrOf = async (agent: TestAgent, contactId: string): Promise<string> =>
  agent.store.transaction(
    (tx) => tx.get('contacts', { contact_id: contactId })?.agent_nostr ?? '',
  );

type Payload = Record<string, unknown>;
const textPayload = (body: unknown, type = 'text'): Payload => ({
  type,
  body,
  replyTo: null,
  files: [],
});

const fileEntry = (over: Record<string, unknown> = {}) => ({
  name: 'report.pdf',
  size: 10,
  mime: 'application/pdf',
  plaintextSha256: 'ab'.repeat(32),
  ciphertextSha256: CIPHER_SHA,
  inline: null,
  url: CANARY_URL,
  fileKey: FILE_KEY,
  expiresAt: T0 + 86_400,
  ...over,
});

interface Put {
  readonly agent?: TestAgent;
  readonly id?: string;
  readonly direction?: 'in' | 'out';
  readonly contact: string | null;
  readonly createdAt: number;
  readonly state?: Row<'envelopes'>['state'];
  readonly type?: string;
  readonly payload?: Payload;
  readonly readAt?: number | null;
  readonly delivery?: Row<'envelopes'>['delivery'];
}

async function put(p: Put): Promise<string> {
  const agent = p.agent ?? a;
  const id = p.id ?? newId();
  const payload = p.payload ?? textPayload(`message ${id}`, p.type ?? 'text');
  const type = p.type ?? (payload['type'] as string);
  const direction = p.direction ?? 'in';
  const fromKey =
    direction === 'out'
      ? encodeHex((await agent.keyStore.getPublicBundle()).agentNostr)
      : p.contact === null
        ? encodeHex(randomBytes(32))
        : await nostrOf(agent, p.contact);
  const sealed = await agent.cipher.seal(
    { table: 'envelopes', column: 'payload_json', rowKey: rowKeyOf([id]) },
    JSON.stringify(payload),
  );
  const state = p.state ?? (p.contact === null && direction === 'in' ? 'request' : 'ok');
  await agent.store.transaction((tx) =>
    tx.insert('envelopes', {
      envelope_id: id,
      envelope_hash: `0x${encodeHex(randomBytes(32))}`,
      thread_id: newId(),
      direction,
      contact_id: p.contact,
      from_key: fromKey,
      type,
      state,
      refused_reason: state === 'refused' ? 'policy' : null,
      created_at: p.createdAt,
      envelope_json: ENVELOPE_JSON,
      payload_json: state === 'refused' ? null : sealed,
      read_at: p.readAt ?? null,
      delivery: direction === 'out' ? (p.delivery ?? 'sent') : null,
      refused_at: state === 'refused' ? clock.t : null,
      request_accepted_at: null,
    }),
  );
  return id;
}

/** A `files` row as ingest (received.ts) or send (records.ts) stores it: name, URL, key sealed. */
async function putFileRow(
  envelopeId: string,
  idx: number,
  over: Partial<Row<'files'>> = {},
  agent: TestAgent = a,
): Promise<void> {
  const ctx = ctxOf(agent);
  const key = [envelopeId, idx];
  const row: Row<'files'> = {
    envelope_id: envelopeId,
    idx,
    name: await seal(ctx, 'files', 'name', key, 'report.pdf'),
    size: 10,
    sha256: CIPHER_SHA,
    locator: await seal(ctx, 'files', 'locator', key, '{"kind":"drop","locator":"CANARY-LOC"}'),
    url: await seal(ctx, 'files', 'url', key, CANARY_URL),
    file_key: await seal(ctx, 'files', 'file_key', key, FILE_KEY),
    expires_at: T0 + 86_400,
    deleted_at: null,
    delete_after: 'expiry',
    ...over,
  };
  await agent.store.transaction((tx) => tx.insert('files', row));
}

/** Every row of every table, as text: the views must leave it exactly as it was. */
const snapshot = (agent: TestAgent = a): Promise<string> =>
  agent.store.transaction((tx) =>
    JSON.stringify(TABLE_NAMES.map((t) => [t, tx.select(t)])),
  );

/** Every sealed value stored in `envelopes` and `files`, and the fixtures' secret values. */
async function secretsOf(agent: TestAgent = a): Promise<string[]> {
  const sealed = await agent.store.transaction((tx) => [
    ...tx.select('envelopes').flatMap((r) => (r.payload_json === null ? [] : [r.payload_json])),
    ...tx.select('files').flatMap((r) => [r.name, r.locator, r.file_key, ...(r.url ? [r.url] : [])]),
  ]);
  return [
    ...sealed.map((s) => (typeof s === 'string' ? s : JSON.stringify(s))),
    'CANARY',
    FILE_KEY,
    CIPHER_SHA,
    SHREDDED_FILE_KEY,
  ];
}

async function expectNoSecrets(value: unknown, agent: TestAgent = a): Promise<void> {
  const json = JSON.stringify(value);
  for (const secret of await secretsOf(agent)) expect(json).not.toContain(secret);
  expect(json).not.toMatch(/"(?:url|fileKey|file_key|locator|envelope_json|salt|\w*sha256\w*)"\s*:/i);
}

const keys = (o: object): string[] => Object.keys(o).sort();

const MESSAGE_IN_KEYS = ['at', 'files', 'id', 'proof', 'size', 'text', 'type'];
const MESSAGE_OUT_KEYS = [...MESSAGE_IN_KEYS, 'receipt', 'status'].sort();
const CONVERSATION_KEYS = ['contactId', 'display', 'lastAt', 'lastInAt'];
const RECEIVED_KEYS = ['at', 'from', 'id', 'name', 'proof', 'size', 'state'];
const SENT_KEYS = ['at', 'expiresAt', 'id', 'name', 'receipt', 'size', 'state', 'status', 'to'];

// ---- Messages: conversations ---------------------------------------------------------------------

describe('MessagesView.conversations (plan §4 GET /api/ui/messages)', () => {
  it('lists every contact that is not removed, with its last and last inbound time', async () => {
    await put({ contact: b.id, createdAt: T0 });
    await put({ contact: b.id, createdAt: T0 + 5, direction: 'out' });
    await put({ contact: c.id, createdAt: T0 + 2, direction: 'out' });
    // Not messages: a request, a refused row and a protocol type never move the times.
    await put({ contact: null, createdAt: T0 + 50 });
    await put({ contact: c.id, createdAt: T0 + 60, state: 'refused' });
    await put({
      contact: c.id,
      createdAt: T0 + 70,
      payload: textPayload({ kind: 'received', envelopeId: newId() }, 'ack'),
    });

    const list: readonly Conversation[] = await a.client.messages.conversations();
    expect(list.map((x) => x.contactId)).toEqual([b.id, c.id]);
    for (const item of list) {
      expect(keys(item)).toEqual(CONVERSATION_KEYS);
      expect(keys(item.display)).toEqual(['label', 'name', 'nameSource']);
    }
    expect(list[0]).toMatchObject({ lastAt: T0 + 5, lastInAt: T0 });
    expect(list[1]).toMatchObject({ lastAt: T0 + 2, lastInAt: null });
    await expectNoSecrets(list);
  });

  it('hides a removed contact and lists a contact without messages with null times', async () => {
    await put({ contact: c.id, createdAt: T0 });
    await a.store.transaction((tx) =>
      tx.update('contacts', { contact_id: c.id }, { status: 'removed' }),
    );
    const list = await a.client.messages.conversations();
    expect(list).toEqual([
      expect.objectContaining({ contactId: b.id, lastAt: null, lastInAt: null }),
    ]);
  });
});

// ---- Messages: one contact's Inbox or Sent -------------------------------------------------------

describe('MessagesView.list (plan §4 GET /api/ui/messages/:contactId)', () => {
  it('returns Inbox items as plain text, newest first, with an exact key set', async () => {
    const plain = await put({ contact: b.id, createdAt: T0, payload: textPayload('Hello <b>x</b>') });
    const json = await put({
      contact: b.id,
      createdAt: T0 + 1,
      payload: textPayload({ order: 7, items: ['a'] }, 'note'),
    });
    const withFile = await put({
      contact: b.id,
      createdAt: T0 + 2,
      payload: { type: 'file', body: 'see attached', replyTo: null, files: [fileEntry()] },
    });

    const page = await a.client.messages.list(b.id, 'in');
    const items: readonly MessageItem[] = page.items;
    expect(items.map((i) => i.id)).toEqual([withFile, json, plain]);
    for (const item of items) expect(keys(item)).toEqual(MESSAGE_IN_KEYS);
    expect(items[2]).toMatchObject({ type: 'text', text: 'Hello <b>x</b>', at: T0, files: [] });
    expect(items[1]?.text).toBe(JSON.stringify({ order: 7, items: ['a'] }, null, 2));
    expect(items[0]?.files).toEqual([{ name: 'report.pdf', size: 10 }]);
    expect(items[0]?.proof).toBe(false);
    expect(items[0]?.size).toBeGreaterThan(0);
    expect(page.nextCursor).toBeUndefined();
    await expectNoSecrets(page);
  });

  it('shows a terms message as its note, and an accept (no note) as empty text', async () => {
    const [p0, p1] = [a.id, b.id].sort();
    const terms = {
      termsId: encodeBase64url(new Uint8Array(16).fill(0x54)),
      version: 1,
      parties: [p0, p1],
      subject: 'Logo design',
      deliverables: [{ id: 'd1', description: 'Three drafts', by: b.id, plaintextSha256: null }],
      price: { amount: '10', currency: 'USD', payer: a.id },
      deadlines: [],
      validUntil: T0 + 7 * 86_400,
      previousTermsHash: null,
    };
    const body = (note: string | null) => ({ terms, termsHash: termsHash(terms), note });
    await put({ contact: b.id, createdAt: T0, payload: textPayload(body('please'), 'offer') });
    await put({ contact: b.id, createdAt: T0 + 1, payload: textPayload(body(null), 'accept') });
    const { items } = await a.client.messages.list(b.id, 'in');
    expect(items.map((i) => [i.type, i.text])).toEqual([
      ['accept', ''],
      ['offer', 'please'],
    ]);
  });

  it('returns Sent items with their delivery status, receipt and proof flags', async () => {
    const queued = await put({ contact: b.id, createdAt: T0, direction: 'out', delivery: 'queued' });
    const acked = await put({ contact: b.id, createdAt: T0 + 1, direction: 'out' });
    const proved = await put({
      contact: b.id,
      createdAt: T0 + 2,
      direction: 'out',
      delivery: 'not_delivered',
    });
    // B's agent acknowledged `acked` (02 F-23): an `ack` from B naming it.
    await put({
      contact: b.id,
      createdAt: T0 + 3,
      payload: { type: 'ack', body: { kind: 'received', envelopeId: acked }, replyTo: acked, files: [] },
    });
    // An ack from another contact naming `queued` is not B's receipt.
    await put({
      contact: c.id,
      createdAt: T0 + 3,
      payload: { type: 'ack', body: { kind: 'received', envelopeId: queued }, replyTo: queued, files: [] },
    });
    await a.store.transaction((tx) =>
      tx.insert('proofs', {
        record_id: `0x${'11'.repeat(32)}`,
        envelope_id: proved,
        chain_id: 84532,
        record_json: '{"CANARY":"RECORD-JSON"}',
        tx_hash: `0x${'22'.repeat(32)}`,
        status: 'recorded',
        fee_token: null,
        fee_amount: null,
        salt: 'CANARY-SALT' as never,
        created_at: T0 + 2,
      }),
    );

    const { items } = await a.client.messages.list(b.id, 'out');
    expect(items.map((i) => i.id)).toEqual([proved, acked, queued]);
    for (const item of items) expect(keys(item)).toEqual(MESSAGE_OUT_KEYS);
    expect(items.map((i) => ('status' in i ? [i.status, i.receipt, i.proof] : null))).toEqual([
      ['not_delivered', false, true],
      ['sent', true, false],
      ['queued', false, false],
    ]);
    await expectNoSecrets(items);
  });

  it('never lists a request, a refused, held or protocol row, or another contact', async () => {
    const kept = await put({ contact: b.id, createdAt: T0 });
    await put({ contact: null, createdAt: T0 + 1 });
    await put({ contact: b.id, createdAt: T0 + 2, state: 'refused' });
    await put({ contact: b.id, createdAt: T0 + 3, state: 'received' });
    await put({
      contact: b.id,
      createdAt: T0 + 4,
      payload: { type: 'ack', body: { kind: 'received', envelopeId: kept }, replyTo: kept, files: [] },
    });
    await put({ contact: c.id, createdAt: T0 + 5 });
    await a.store.transaction((tx) =>
      tx.insert('held_envelopes', {
        envelope_id: newId(),
        envelope_hash: `0x${'33'.repeat(32)}`,
        from_key: encodeHex(randomBytes(32)),
        owner_kid: 'kid',
        envelope_json: ENVELOPE_JSON,
        payload_json: 'CANARY-HELD' as never,
        received_at: T0 + 6,
        release_at: T0 + 100,
      }),
    );
    expect((await a.client.messages.list(b.id, 'in')).items.map((i) => i.id)).toEqual([kept]);
    expect((await a.client.messages.list(b.id, 'out')).items).toEqual([]);
  });

  it('refuses a removed or unknown contact and a bad box, limit or cursor', async () => {
    await put({ contact: c.id, createdAt: T0 });
    await a.store.transaction((tx) =>
      tx.update('contacts', { contact_id: c.id }, { status: 'removed' }),
    );
    for (const id of [c.id, 'nobody', '']) {
      const error = await a.client.messages.list(id, 'in').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CoreError);
      expect((error as CoreError).code).toBe('contact_not_found');
    }
    for (const call of [
      () => a.client.messages.list(b.id, 'all' as never),
      () => a.client.messages.list(b.id, 'in', { limit: 0 }),
      () => a.client.messages.list(b.id, 'in', { limit: 101 }),
      () => a.client.messages.list(b.id, 'in', { cursor: 'not a cursor' }),
    ]) {
      const error = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CoreError);
      expect((error as CoreError).code).toBe('page_query_invalid');
    }
  });

  it('pages newest first with a cursor, every item once, ties at one second included', async () => {
    const all: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      all.push(await put({ contact: b.id, createdAt: T0 + Math.floor(i / 3) }));
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await a.client.messages.list(b.id, 'in', { limit: 10, cursor });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(25);
    expect([...seen].sort()).toEqual([...all].sort());
  });
});

// ---- Files: Received and Sent --------------------------------------------------------------------

describe('FilesIoView.received (plan §4 GET /api/ui/files/received)', () => {
  it('lists each received file with its state; an expired or shredded file reads expired', async () => {
    // Kept: the row is there and the link has not expired.
    const live = await put({
      contact: b.id,
      createdAt: T0,
      payload: {
        type: 'file',
        body: 'two',
        replyTo: null,
        files: [fileEntry({ name: 'a.pdf' }), fileEntry({ name: 'b.pdf', size: 20 })],
      },
    });
    await putFileRow(live, 0);
    await putFileRow(live, 1, { size: 20 });
    // Shredded: retention deleted the row and the stored payload holds no key.
    const shredded = await put({
      contact: c.id,
      createdAt: T0 + 1,
      payload: {
        type: 'file',
        body: 'old',
        replyTo: null,
        files: [fileEntry({ name: 'old.zip', fileKey: SHREDDED_FILE_KEY })],
      },
    });
    // A message without files and one from a request are not files of a contact.
    await put({ contact: b.id, createdAt: T0 + 2 });
    await put({
      contact: null,
      createdAt: T0 + 3,
      payload: { type: 'file', body: 'x', replyTo: null, files: [fileEntry({ name: 'req.pdf' })] },
    });

    const page = await a.client.filesIo.received();
    const items: readonly ReceivedFileItem[] = page.items;
    expect(items.map((i) => [i.id, i.name, i.state])).toEqual([
      [`${shredded}.00`, 'old.zip', 'expired'],
      [`${live}.01`, 'b.pdf', 'not_saved'],
      [`${live}.00`, 'a.pdf', 'not_saved'],
    ]);
    for (const item of items) {
      expect(keys(item)).toEqual(RECEIVED_KEYS);
      expect(keys(item.from)).toEqual(['label', 'name', 'nameSource']);
    }
    expect(items[1]).toMatchObject({ at: T0, size: 20, proof: false });

    // Past its expiry the link is gone, even before retention deletes the row.
    clock.t = T0 + 86_400;
    expect((await a.client.filesIo.received()).items.map((i) => i.state)).toEqual([
      'expired',
      'expired',
      'expired',
    ]);
    await expectNoSecrets(page);
  });

  it('shows where a saved file went when the saved name is known (MSG-FILES-IO-b)', async () => {
    const id = await put({
      contact: b.id,
      createdAt: T0,
      payload: { type: 'file', body: 'x', replyTo: null, files: [fileEntry()] },
    });
    await putFileRow(id, 0);
    const view = new FilesIoView(ctxOf(a), a.client.contacts, {
      savedName: async (row) => (row.envelope_id === id ? 'report (2).pdf' : null),
    });
    const { items } = await view.received();
    expect(items).toHaveLength(1);
    expect(keys(items[0] as object)).toEqual([...RECEIVED_KEYS, 'savedName'].sort());
    expect(items[0]).toMatchObject({ state: 'saved', savedName: 'report (2).pdf' });
  });

  it('pages files across messages with a cursor, every file once', async () => {
    const expected: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const files = Array.from({ length: (i % 3) + 1 }, (_, k) => fileEntry({ name: `f${k}.txt` }));
      const id = await put({
        contact: b.id,
        createdAt: T0 + Math.floor(i / 2),
        payload: { type: 'file', body: 'x', replyTo: null, files },
      });
      files.forEach((_, k) => expected.push(`${id}.${String(k).padStart(2, '0')}`));
      await put({ contact: b.id, createdAt: T0 + i });
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await a.client.filesIo.received({ limit: 4, cursor });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined && pages < 20);
    expect(seen).toHaveLength(expected.length);
    expect([...seen].sort()).toEqual([...expected].sort());
  });
});

describe('FilesIoView.sent (plan §4 GET /api/ui/files/sent)', () => {
  it('lists each sent file: available, deleted on receipt, or expired', async () => {
    const file = (name: string) => fileEntry({ name });
    const available = await put({
      contact: b.id,
      createdAt: T0,
      direction: 'out',
      payload: { type: 'file', body: 'a', replyTo: null, files: [file('kept.pdf')] },
    });
    await putFileRow(available, 0);
    // Deleted on receipt: retention removed the row before the link expired.
    const onReceipt = await put({
      contact: b.id,
      createdAt: T0 + 1,
      direction: 'out',
      delivery: 'queued',
      payload: { type: 'file', body: 'b', replyTo: null, files: [file('gone.pdf')] },
    });
    // Expired: the row is gone and the link's expiry has passed.
    const expired = await put({
      contact: c.id,
      createdAt: T0 + 2,
      direction: 'out',
      payload: {
        type: 'file',
        body: 'c',
        replyTo: null,
        files: [file('old.pdf'), { ...file('older.pdf'), expiresAt: T0 - 1 }],
      },
    });
    await putFileRow(expired, 0, { expires_at: T0 - 1 });

    const page = await a.client.filesIo.sent();
    const items: readonly SentFileItem[] = page.items;
    expect(items.map((i) => [i.id, i.name, i.state, i.status])).toEqual([
      [`${expired}.01`, 'older.pdf', 'expired', 'sent'],
      [`${expired}.00`, 'old.pdf', 'expired', 'sent'],
      [`${onReceipt}.00`, 'gone.pdf', 'deleted', 'queued'],
      [`${available}.00`, 'kept.pdf', 'available', 'sent'],
    ]);
    for (const item of items) {
      expect(keys(item)).toEqual(SENT_KEYS);
      expect(keys(item.to)).toEqual(['label', 'name', 'nameSource']);
      expect(item.receipt).toBe(false);
    }
    expect(items[3]?.expiresAt).toBe(T0 + 86_400);
    await expectNoSecrets(page);
  });
});

// ---- No writes, no network, no plaintext in logs -------------------------------------------------

describe('read-only: no read mark, no store change, no network (I-4, I-7)', () => {
  it('leaves read_at and every row unchanged after every call', async () => {
    const unread = await put({ contact: b.id, createdAt: T0, readAt: null });
    const file = await put({
      contact: b.id,
      createdAt: T0 + 1,
      payload: { type: 'file', body: 'BODY-PLAINTEXT', replyTo: null, files: [fileEntry()] },
    });
    await putFileRow(file, 0);
    const sent = await put({
      contact: b.id,
      createdAt: T0 + 2,
      direction: 'out',
      payload: { type: 'file', body: 'x', replyTo: null, files: [fileEntry()] },
    });
    await putFileRow(sent, 0);
    const before = await snapshot();
    const calls: (() => Promise<unknown>)[] = [
      () => a.client.messages.conversations(),
      () => a.client.messages.list(b.id, 'in'),
      () => a.client.messages.list(b.id, 'out'),
      () => a.client.messages.list(b.id, 'in', { limit: 1 }),
      () => a.client.filesIo.received(),
      () => a.client.filesIo.sent(),
    ];
    for (const call of calls) {
      await call();
      expect(await snapshot()).toBe(before);
    }
    const readAt = await a.store.transaction(
      (tx) => tx.get('envelopes', { envelope_id: unread })?.read_at,
    );
    expect(readAt).toBeNull();
    // Logs carry counts only: never a body or a file name.
    expect(lines.join('\n')).not.toMatch(/BODY-PLAINTEXT|report\.pdf|CANARY/);
  });

  it('answers with the transport and file storage failing', async () => {
    const offline = await makeAgent(4, 'Dora', true);
    await pairWith(clock, offline, b);
    await put({ agent: offline, contact: b.id, createdAt: T0 });
    const sent = await put({
      agent: offline,
      contact: b.id,
      createdAt: T0 + 1,
      direction: 'out',
      payload: { type: 'file', body: 'x', replyTo: null, files: [fileEntry()] },
    });
    await putFileRow(sent, 0, {}, offline);
    expect(await offline.client.messages.conversations()).toHaveLength(1);
    expect((await offline.client.messages.list(b.id, 'in')).items).toHaveLength(1);
    expect((await offline.client.messages.list(b.id, 'out')).items).toHaveLength(1);
    expect((await offline.client.filesIo.received()).items).toEqual([]);
    expect((await offline.client.filesIo.sent()).items).toHaveLength(1);
  });

  it('can be built directly from a context and a contact book', () => {
    expect(new MessagesView(ctxOf(a), a.client.contacts)).toBeInstanceOf(MessagesView);
  });
});
