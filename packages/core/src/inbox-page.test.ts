// M1-7h-c: the inbox page read (06 §2.2 "Order and paging", "Read state"; §2.1 accepted requests,
// D-72; 07 §3, §3.2). Rows are written straight into the store the way the envelope pipeline and the
// send pipeline store them (envelopes.ts #accept, send.ts outboundRow): the payload sealed in
// `payload_json`, the state and the read mark in their columns.
import {
  decodeHex,
  encodeBase64url,
  encodeHex,
  formatFingerprint,
  randomBytes,
  senderCode,
  termsHash,
} from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { createLogger } from '@4thtech-io/log';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentLinkClient } from './client.js';
import { CoreError } from './errors.js';
import { PAGE_TYPES, type InboxPage, type InboxPageItem, type InboxPageQuery } from './inbox.js';
import { MemoryStore } from './store/memory-store.js';
import type { Row } from './store/schema.js';
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
import { sleep } from './testing/platform.js';

const DROP_ORIGIN = 'https://drop.agentlink.example';

const clock = new FakeClock();
let lines: string[] = [];

async function makeAgent(n: number, name: string): Promise<TestAgent> {
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

beforeEach(async () => {
  clock.t = 1_800_000_000;
  lines = [];
  a = await makeAgent(1, 'Alice');
  b = await makeAgent(2, 'Bob');
  c = await makeAgent(3, 'Carol');
  await pairWith(clock, a, b);
  await pairWith(clock, a, c);
});

// ---- Row helpers ---------------------------------------------------------------------------------

const newId = (): string => encodeBase64url(randomBytes(16));
/** An envelope ID whose first byte is `first` (the rest random), for byte-order tests. */
const idStarting = (first: number): string => {
  const bytes = randomBytes(16);
  bytes[0] = first;
  return encodeBase64url(bytes);
};

const nostrOf = async (contactId: string): Promise<string> =>
  a.store.transaction((tx) => tx.get('contacts', { contact_id: contactId })?.agent_nostr ?? '');

type Payload = Record<string, unknown>;
const text = (body: string, type = 'text'): Payload => ({ type, body, replyTo: null, files: [] });

interface Put {
  readonly id?: string;
  readonly direction?: 'in' | 'out';
  /** A contact ID, or null for a request from an unknown key. */
  readonly contact: string | null;
  readonly fromKey?: string;
  readonly createdAt: number;
  readonly state?: Row<'envelopes'>['state'];
  readonly type?: string;
  readonly payload?: Payload;
  readonly readAt?: number | null;
  readonly delivery?: Row<'envelopes'>['delivery'];
  readonly acceptedAt?: number | null;
  /** A payload_json value that does not open. */
  readonly unreadable?: boolean;
}

async function put(p: Put): Promise<string> {
  const id = p.id ?? newId();
  const payload = p.payload ?? text(`message ${id}`, p.type ?? 'text');
  const type = p.type ?? (payload['type'] as string);
  const direction = p.direction ?? 'in';
  const fromKey =
    p.fromKey ??
    (direction === 'out'
      ? encodeHex((await a.keyStore.getPublicBundle()).agentNostr)
      : p.contact === null
        ? encodeHex(randomBytes(32))
        : await nostrOf(p.contact));
  const sealed = await a.cipher.seal(
    { table: 'envelopes', column: 'payload_json', rowKey: rowKeyOf([p.unreadable ? 'x' : id]) },
    JSON.stringify(payload),
  );
  const state = p.state ?? (p.contact === null && direction === 'in' ? 'request' : 'ok');
  await a.store.transaction((tx) =>
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
      envelope_json: null,
      payload_json: state === 'refused' ? null : sealed,
      read_at: p.readAt ?? null,
      delivery: direction === 'out' ? (p.delivery ?? 'sent') : null,
      refused_at: state === 'refused' ? clock.t : null,
      request_accepted_at: p.acceptedAt ?? null,
    }),
  );
  return id;
}

const readAtOf = (id: string) =>
  a.store.transaction((tx) => tx.get('envelopes', { envelope_id: id })?.read_at ?? null);

const T0 = 1_799_990_000;

function query(over: Partial<InboxPageQuery> = {}): InboxPageQuery {
  return {
    limit: 20,
    includeRead: false,
    includeSent: false,
    sizeOf: () => 1,
    maxBytes: 262_144,
    ...over,
  };
}

async function page(over: Partial<InboxPageQuery> = {}): Promise<readonly InboxPageItem[]> {
  const result: InboxPage = await a.client.inbox.page(query(over));
  if (result.status !== 'ok') throw new Error(`unexpected ${result.status}`);
  return result.items;
}

const ids = (items: readonly InboxPageItem[]): string[] => items.map((i) => i.envelopeId);

// ---- Paging bounds and order ---------------------------------------------------------------------

describe('inbox page: bounds and stable order (06 §2.2 "Order and paging")', () => {
  it('refuses a limit outside 1..100 and other malformed queries, reading and marking nothing', async () => {
    const id = await put({ contact: b.id, createdAt: T0 });
    for (const bad of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { limit: Number.NaN },
      { since: -1 },
      { since: 1.5 },
      { maxBytes: 0 },
    ]) {
      const error = await a.client.inbox.page(query(bad)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CoreError);
      expect((error as CoreError).code).toBe('inbox_query_invalid');
    }
    expect(await readAtOf(id)).toBeNull();
  });

  it('returns the newest `limit` items, oldest first, and leaves older ones unread', async () => {
    const all: string[] = [];
    for (let i = 0; i < 25; i += 1) all.push(await put({ contact: b.id, createdAt: T0 + i }));
    const items = await page({ limit: 10 });
    expect(ids(items)).toEqual(all.slice(15));
    expect(items.map((i) => i.createdAt)).toEqual(
      Array.from({ length: 10 }, (_, i) => T0 + 15 + i),
    );
    for (const id of all.slice(0, 15)) expect(await readAtOf(id)).toBeNull();
    for (const id of all.slice(15)) expect(await readAtOf(id)).toBe(clock.t);
    // Limit 100 takes everything left.
    expect(ids(await page({ limit: 100 }))).toEqual(all.slice(0, 15));
  });

  it('orders equal createdAt by envelopeId bytes, not by its base64url text', async () => {
    // Bytes 0x00 < 0x68 < 0xf8 < 0xfc; as base64url text their first letters are A, a, -, _,
    // and text order would be "-" < "A" < "_" < "a".
    const byBytes = [idStarting(0x00), idStarting(0x68), idStarting(0xf8), idStarting(0xfc)];
    for (const id of [...byBytes].reverse()) await put({ id, contact: b.id, createdAt: T0 });
    expect(ids(await page({ includeRead: true }))).toEqual(byBytes);
    // A limit inside the tie keeps the newest by bytes.
    expect(ids(await page({ includeRead: true, limit: 2 }))).toEqual(byBytes.slice(2));
  });

  it('pages a whole thread with before: no gaps, no repeats, the same order', async () => {
    const all: string[] = [];
    for (let i = 0; i < 23; i += 1) {
      // Pairs of equal times exercise the tie-break across page edges.
      all.push(await put({ contact: b.id, createdAt: T0 + Math.floor(i / 2) }));
    }
    const expected = [...(await page({ includeRead: true, limit: 100 }))].map((i) => i.envelopeId);
    expect(new Set(expected).size).toBe(23);
    const seen: string[] = [];
    let before: string | undefined;
    for (;;) {
      const items = await page({ includeRead: true, limit: 4, ...(before ? { before } : {}) });
      if (items.length === 0) break;
      seen.unshift(...ids(items));
      before = items[0]?.envelopeId;
    }
    expect(seen).toEqual(expected);
  });

  it('ends a page before the item that would pass maxBytes, keeping at least one', async () => {
    const all: string[] = [];
    for (let i = 0; i < 5; i += 1) all.push(await put({ contact: b.id, createdAt: T0 + i }));
    const items = await page({ sizeOf: () => 100, maxBytes: 250 });
    expect(ids(items)).toEqual(all.slice(3));
    for (const id of all.slice(0, 3)) expect(await readAtOf(id)).toBeNull();
    // An item bigger than maxBytes on its own still comes back alone.
    const one = await page({ sizeOf: () => 1_000, maxBytes: 250 });
    expect(ids(one)).toEqual([all[2]]);
  });
});

// ---- before and since ----------------------------------------------------------------------------

describe('inbox page: before and since, edges included (06 §2.2)', () => {
  it('since keeps items at or after it', async () => {
    const early = await put({ contact: b.id, createdAt: T0 - 1 });
    const edge = await put({ contact: b.id, createdAt: T0 });
    const late = await put({ contact: b.id, createdAt: T0 + 1 });
    expect(ids(await page({ includeRead: true, since: T0 }))).toEqual([edge, late]);
    expect(ids(await page({ includeRead: true, since: T0 + 1 }))).toEqual([late]);
    expect(ids(await page({ includeRead: true, since: T0 + 2 }))).toEqual([]);
    expect(await readAtOf(early)).toBeNull();
  });

  it('before keeps items strictly older by (createdAt, envelopeId bytes)', async () => {
    const older = await put({ contact: b.id, createdAt: T0 - 1 });
    const tieLow = await put({ id: idStarting(0x10), contact: b.id, createdAt: T0 });
    const pivot = await put({ id: idStarting(0x80), contact: b.id, createdAt: T0 });
    await put({ id: idStarting(0xf0), contact: b.id, createdAt: T0 });
    await put({ contact: b.id, createdAt: T0 + 1 });
    expect(ids(await page({ includeRead: true, before: pivot }))).toEqual([older, tieLow]);
    // before and since together: since at the pivot's time keeps only the lower tie.
    expect(ids(await page({ includeRead: true, before: pivot, since: T0 }))).toEqual([tieLow]);
  });

  it('an unknown or malformed before is before_not_found and marks nothing read', async () => {
    const id = await put({ contact: b.id, createdAt: T0 });
    for (const before of [newId(), 'not an id', '', 'A'.repeat(200)]) {
      expect(await a.client.inbox.page(query({ before }))).toEqual({ status: 'before_not_found' });
    }
    expect(await readAtOf(id)).toBeNull();
  });

  it('before must name an item this query can see', async () => {
    const mine = await put({ contact: b.id, createdAt: T0 });
    const other = await put({ contact: c.id, createdAt: T0 + 5 });
    const sent = await put({ direction: 'out', contact: b.id, createdAt: T0 + 6 });
    const refused = await put({ contact: b.id, createdAt: T0 + 7, state: 'refused' });
    const queued = await put({ contact: null, createdAt: T0 + 8 });
    // Another contact's item, under a contact filter.
    expect(await a.client.inbox.page(query({ contactId: b.id, before: other }))).toEqual({
      status: 'before_not_found',
    });
    // An outbound item without includeSent; a refused row; a request that is not accepted.
    for (const before of [sent, refused, queued]) {
      expect(await a.client.inbox.page(query({ before }))).toEqual({ status: 'before_not_found' });
    }
    expect(await readAtOf(mine)).toBeNull();
    // With includeSent the outbound item is a valid cursor.
    expect(ids(await page({ includeSent: true, before: sent }))).toEqual([mine, other]);
  });

  it('a read item is a valid cursor for the default (unread) call', async () => {
    const old = await put({ contact: b.id, createdAt: T0 });
    const first = await put({ contact: b.id, createdAt: T0 + 1 });
    await put({ contact: b.id, createdAt: T0 + 2 });
    const p1 = await page({ limit: 2 });
    expect(p1[0]?.envelopeId).toBe(first);
    expect(ids(await page({ limit: 2, before: first }))).toEqual([old]);
  });
});

// ---- Read state ----------------------------------------------------------------------------------

describe('inbox page: read marks in the page transaction (06 §2.2 "Read state", 07 §3)', () => {
  it('returns unread items as read:false, then never again by default, then read:true', async () => {
    const x = await put({ contact: b.id, createdAt: T0 });
    const y = await put({ contact: c.id, createdAt: T0 + 1 });
    const first = await page();
    expect(ids(first)).toEqual([x, y]);
    expect(first.map((i) => i.direction === 'in' && i.read)).toEqual([false, false]);
    expect(await readAtOf(x)).toBe(clock.t);
    expect(await page()).toEqual([]);
    const again = await page({ includeRead: true });
    expect(again.map((i) => i.direction === 'in' && i.read)).toEqual([true, true]);
  });

  it('keeps an earlier read time', async () => {
    const x = await put({ contact: b.id, createdAt: T0, readAt: T0 + 10 });
    await page({ includeRead: true });
    expect(await readAtOf(x)).toBe(T0 + 10);
  });

  it('two concurrent reads never return the same unread item', async () => {
    const all: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      all.push(await put({ contact: i % 2 ? b.id : c.id, createdAt: T0 + i }));
    }
    const [one, two] = await Promise.all([page(), page()]);
    const got = [...ids(one), ...ids(two)];
    expect(new Set(got).size).toBe(got.length);
    expect(new Set(got)).toEqual(new Set(all));
  });

  it('a read whose page lost a race to another read starts again and skips what that read took', async () => {
    const all: string[] = [];
    for (let i = 0; i < 4; i += 1) all.push(await put({ contact: b.id, createdAt: T0 + i }));
    // The first read stops while it opens payloads (outside any transaction); the second read
    // runs to the end meanwhile.
    const realOpen = a.cipher.open.bind(a.cipher);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = true;
    a.cipher.open = async (context, sealed) => {
      if (gated) {
        gated = false;
        await gate;
      }
      return realOpen(context, sealed);
    };
    const slow = page();
    await sleep(0);
    const fast = await page();
    release();
    expect(ids(fast)).toEqual(all);
    expect(await slow).toEqual([]);
    // The slow read's commit found the marks changed, wrote nothing and read again.
    expect(lines.join('\n')).toContain('inbox page changed while read');
  });

  it('marks nothing when building the page fails', async () => {
    const x = await put({ contact: b.id, createdAt: T0 });
    const error = await a.client.inbox
      .page(
        query({
          sizeOf: () => {
            throw new Error('size failed');
          },
        }),
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(await readAtOf(x)).toBeNull();
  });

  it('skips a row whose payload does not open, marks it nothing and logs a count only', async () => {
    const bad = await put({ contact: b.id, createdAt: T0 + 1, unreadable: true });
    const good = await put({
      contact: b.id,
      createdAt: T0,
      payload: text('CANARY-BODY-7f3a'),
    });
    expect(ids(await page())).toEqual([good]);
    expect(await readAtOf(bad)).toBeNull();
    const log = lines.join('\n');
    expect(log).toContain('inbox rows unreadable');
    expect(log).not.toContain('CANARY-BODY-7f3a');
    expect(log).not.toContain(bad);
  });
});

// ---- What appears --------------------------------------------------------------------------------

describe('inbox page: what is returned (06 §2.2 "What is returned"; D-72)', () => {
  it('returns an accepted request without a sender name, with its sender code', async () => {
    const fromKey = encodeHex(randomBytes(32));
    const pending = await put({ contact: null, fromKey, createdAt: T0 + 1 });
    const accepted = await put({
      contact: null,
      fromKey,
      createdAt: T0,
      acceptedAt: clock.t,
      payload: text('hello from a stranger'),
    });
    const result = await a.client.inbox.page(query());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.requests).toBe(2);
    expect(ids(result.items)).toEqual([accepted]);
    const item = result.items[0];
    expect(item?.direction).toBe('in');
    if (item?.direction !== 'in') return;
    expect(item.from).toBeNull();
    expect(item.senderCode).toBe(formatFingerprint(senderCode(decodeHex(fromKey)), 'short'));
    expect(item.read).toBe(false);
    expect(item.body).toBe('hello from a stranger');
    expect(await readAtOf(accepted)).toBe(clock.t);
    expect(await readAtOf(pending)).toBeNull();
    // A contact filter never shows a request.
    expect(await page({ includeRead: true, contactId: b.id })).toEqual([]);
  });

  it('shows colliding sender codes of two accepted requests in the extended form (04 §2.9)', async () => {
    const seen = new Map<string, string>();
    let pair: readonly [string, string] | undefined;
    for (let i = 0; pair === undefined; i += 1) {
      const bytes = new Uint8Array(32);
      new DataView(bytes.buffer).setUint32(0, i);
      const code = formatFingerprint(senderCode(bytes), 'short');
      const prior = seen.get(code);
      if (prior !== undefined) pair = [prior, encodeHex(bytes)];
      else seen.set(code, encodeHex(bytes));
    }
    const [x, y] = pair;
    const other = encodeHex(randomBytes(32));
    for (const [n, key] of [x, y, other].entries()) {
      await put({ contact: null, fromKey: key, createdAt: T0 + n, acceptedAt: clock.t });
    }
    const result = await a.client.inbox.page(query());
    if (result.status !== 'ok') throw new Error('expected a page');
    const codes = new Map<string, string | undefined>();
    for (const item of result.items) {
      if (item.direction === 'in') codes.set(item.createdAt.toString(), item.senderCode);
    }
    const extended = (key: string) => formatFingerprint(senderCode(decodeHex(key)), 'extended');
    const short = (key: string) => formatFingerprint(senderCode(decodeHex(key)), 'short');
    expect(codes.get(String(T0))).toBe(extended(x));
    expect(codes.get(String(T0 + 1))).toBe(extended(y));
    expect(codes.get(String(T0 + 2))).toBe(short(other));
  });

  it('names a contact item by the 06 §2.1 rule, with the declared name only as data', async () => {
    await put({ contact: b.id, createdAt: T0 });
    const [item] = await page();
    expect(item?.direction).toBe('in');
    if (item?.direction !== 'in' || item.from === null) throw new Error('expected a contact item');
    const view = await a.client.contacts.get(b.id);
    expect(item.from.contactId).toBe(b.id);
    expect(item.from.display).toEqual(view.display);
    expect(item.from.ownerFingerprint).toBe(view.ownerFingerprint.short);
    expect(item.from.declaredName).toBe('Bob');
    expect(item.senderCode).toBeUndefined();
  });

  it('includes our own sent messages only with includeSent', async () => {
    const inbound = await put({ contact: b.id, createdAt: T0 });
    const sent = await put({
      direction: 'out',
      contact: b.id,
      createdAt: T0 + 1,
      delivery: 'queued',
      payload: text('our reply'),
    });
    const sentToC = await put({ direction: 'out', contact: c.id, createdAt: T0 + 2 });
    expect(ids(await page({ includeRead: true }))).toEqual([inbound]);
    const all = await page({ includeRead: true, includeSent: true });
    expect(ids(all)).toEqual([inbound, sent, sentToC]);
    const out = all[1];
    expect(out?.direction).toBe('out');
    if (out?.direction !== 'out') return;
    expect(out.to.contactId).toBe(b.id);
    expect(out.delivery).toBe('queued');
    expect(out.body).toBe('our reply');
    expect('read' in out).toBe(false);
    // The thread view: one contact, both directions.
    expect(ids(await page({ includeRead: true, includeSent: true, contactId: b.id }))).toEqual([
      inbound,
      sent,
    ]);
    // includeSent with includeRead false: unread inbound plus sent.
    const unreadAndSent = await page({ includeSent: true });
    expect(ids(unreadAndSent)).toEqual([sent, sentToC]);
  });

  it('never returns refused rows, queued requests, unprocessed or protocol envelopes', async () => {
    const shown = await put({ contact: b.id, createdAt: T0 });
    await put({ contact: b.id, createdAt: T0 + 1, state: 'refused' });
    await put({ contact: null, createdAt: T0 + 2, state: 'refused' });
    await put({ contact: null, createdAt: T0 + 3 }); // queued, not accepted
    await put({ contact: b.id, createdAt: T0 + 4, state: 'received' });
    // An accepted request of a protocol type, and a refused accepted-looking row.
    await put({ contact: null, createdAt: T0 + 5, type: 'ack', acceptedAt: clock.t });
    for (const type of ['ack', 'proof', 'card-update', 'handshake', 'approval', 'revoke']) {
      await put({ contact: b.id, createdAt: T0 + 6, type, payload: text('x', type) });
      await put({
        direction: 'out',
        contact: b.id,
        createdAt: T0 + 6,
        type,
        payload: text('x', type),
      });
    }
    expect(ids(await page({ includeRead: true, includeSent: true, limit: 100 }))).toEqual([shown]);
  });

  it('leaves out a removed contact', async () => {
    await put({ contact: c.id, createdAt: T0 });
    const kept = await put({ contact: b.id, createdAt: T0 + 1 });
    await a.store.transaction((tx) =>
      tx.update('contacts', { contact_id: c.id }, { status: 'removed' }),
    );
    expect(ids(await page({ includeRead: true }))).toEqual([kept]);
    expect(await page({ contactId: c.id, includeRead: true })).toEqual([]);
  });

  it('carries files without any URL, key or inline bytes, and classifies their storage', async () => {
    const sha = 'ab'.repeat(32);
    const fileKey = encodeBase64url(new Uint8Array(32).fill(7));
    const file = (over: Record<string, unknown>) => ({
      name: 'report.pdf',
      size: 10,
      mime: 'application/pdf',
      plaintextSha256: sha,
      ciphertextSha256: 'cd'.repeat(32),
      inline: null,
      url: null,
      fileKey,
      expiresAt: T0 + 86_400,
      ...over,
    });
    const id = await put({
      contact: b.id,
      createdAt: T0,
      payload: {
        type: 'file',
        body: 'three files',
        replyTo: null,
        files: [
          file({ inline: encodeBase64url(new Uint8Array(40).fill(1)) }),
          file({ url: `${DROP_ORIGIN}/o/CANARY-DROP-URL` }),
          file({ url: 'https://storage.example.net/CANARY-OWN-URL', name: 'x.bin' }),
        ],
      },
    });
    const [item] = await page();
    expect(item?.envelopeId).toBe(id);
    expect(item?.files).toEqual([
      {
        index: 0,
        size: 10,
        plaintextSha256: sha,
        delivery: 'inline',
        expiresAt: null,
        name: 'report.pdf',
        mime: 'application/pdf',
      },
      {
        index: 1,
        size: 10,
        plaintextSha256: sha,
        delivery: 'drop',
        expiresAt: T0 + 86_400,
        name: 'report.pdf',
        mime: 'application/pdf',
      },
      {
        index: 2,
        size: 10,
        plaintextSha256: sha,
        delivery: 'own',
        expiresAt: T0 + 86_400,
        name: 'x.bin',
        mime: 'application/pdf',
      },
    ]);
    const json = JSON.stringify(item);
    expect(json).not.toContain('CANARY');
    expect(json).not.toContain(fileKey);
    expect(json).not.toContain('cd'.repeat(32));
  });

  it('returns terms with a checked termsRef, and none when the hash does not match', async () => {
    const SELF = a.id;
    const [p0, p1] = [SELF, b.id].sort();
    const terms = {
      termsId: encodeBase64url(new Uint8Array(16).fill(0x54)),
      version: 1,
      parties: [p0, p1],
      subject: 'Logo design',
      deliverables: [{ id: 'd1', description: 'Three drafts', by: b.id, plaintextSha256: null }],
      price: { amount: '10', currency: 'USD', payer: SELF },
      deadlines: [],
      validUntil: T0 + 7 * 86_400,
      previousTermsHash: null,
    };
    const offer = await put({
      contact: b.id,
      createdAt: T0,
      payload: {
        type: 'offer',
        body: { terms, termsHash: termsHash(terms), note: 'please' },
        replyTo: null,
        files: [],
      },
    });
    const forged = await put({
      contact: b.id,
      createdAt: T0 + 1,
      payload: {
        type: 'reject',
        body: { terms, termsHash: 'ee'.repeat(32), note: null },
        replyTo: offer,
        files: [],
      },
    });
    const items = await page();
    expect(ids(items)).toEqual([offer, forged]);
    const [o, r] = items;
    expect(o?.body).toBeNull();
    expect(o?.terms).toEqual(terms);
    expect(o?.note).toBe('please');
    expect(o?.termsRef).toEqual({
      termsId: terms.termsId,
      version: 1,
      termsHash: termsHash(terms),
      validUntil: terms.validUntil,
    });
    expect(r?.replyTo).toBe(offer);
    expect(r?.termsRef).toBeUndefined();
    expect(r?.note).toBeNull();
  });

  it('logs counts only', async () => {
    await put({ contact: b.id, createdAt: T0, payload: text('CANARY-LOG-BODY') });
    await page();
    const log = lines.join('\n');
    expect(log).not.toContain('CANARY-LOG-BODY');
    expect(log).not.toContain(b.id);
  });
});

// ---- `before` and `since` (06 §2.2 sentence added by M1-9p-b) -------------------------------------

describe('before names an item in scope regardless of read state and since (M1-9p-b)', () => {
  it('a read cursor older than since is a valid, empty page, not before_not_found', async () => {
    const old = await put({ contact: b.id, createdAt: T0, readAt: T0 + 1 });
    await put({ contact: b.id, createdAt: T0 + 10 });
    const result = await a.client.inbox.page(query({ before: old, since: T0 + 5 }));
    expect(result).toEqual({ status: 'ok', items: [], requests: 0 });
  });
});

// ---- Status counts match the page (M1-9p-b; IR-M1-7h-c-1) -----------------------------------------

describe('unread counts count exactly what the page can return (M1-9p-b; IR-M1-7h-c-1)', () => {
  const PROTOCOL = [
    'proof',
    'ack',
    'handshake',
    'handshake-ack',
    'approval',
    'card-update',
    'revoke',
  ];
  const unreadOf = async (contactId: string): Promise<number> =>
    (await a.client.inbox.counts()).inbox.find((e) => e.contactId === contactId)?.unread ?? 0;

  it('a processed proof or other type the page never returns is not counted unread', async () => {
    for (const type of PROTOCOL) {
      await put({ contact: b.id, createdAt: T0, type, payload: text('x', type) });
    }
    expect(await unreadOf(b.id)).toBe(0);
  });

  it('a contact cannot create an unread count the default page never clears', async () => {
    const shown = await put({ contact: b.id, createdAt: T0 });
    let t = T0;
    for (const type of PROTOCOL) {
      t += 1;
      await put({ contact: b.id, createdAt: t, type, payload: text('x', type) });
    }
    expect(await unreadOf(b.id)).toBe(1);
    expect(ids(await page({ limit: 100 }))).toEqual([shown]);
    expect(await unreadOf(b.id)).toBe(0);
    expect(await page({ limit: 100 })).toEqual([]);
  });

  it('counts every type the page returns', async () => {
    let t = T0;
    for (const type of PAGE_TYPES) {
      t += 1;
      await put({ contact: b.id, createdAt: t, type, payload: text('x', type) });
    }
    expect(await unreadOf(b.id)).toBe(PAGE_TYPES.length);
  });
});

// ---- M1-33d-b: one read per page for the receipt-request flag (IR-M1-33d-1) ----------------------

/** A received, checked proof row for `envelopeId`, optionally asking for a delivery receipt. */
async function putReceivedProof(envelopeId: string, asks: boolean): Promise<string> {
  const recordId = `0x${encodeHex(randomBytes(32))}`;
  const salt = await a.cipher.seal(
    { table: 'proofs', column: 'salt', rowKey: rowKeyOf([recordId]) },
    '',
  );
  await a.store.transaction((tx) =>
    tx.insert('proofs', {
      record_id: recordId,
      envelope_id: envelopeId,
      chain_id: 10200,
      record_json: JSON.stringify({ recordId, ...(asks ? { receiptRequest: 'delivered' } : {}) }),
      tx_hash: null,
      status: 'received',
      fee_token: null,
      fee_amount: null,
      salt,
      created_at: T0,
    }),
  );
  return recordId;
}

describe('inbox page: the receipt-request flag costs no transaction per item (M1-33d-b)', () => {
  async function transactionsFor(items: number): Promise<number> {
    a = await makeAgent(1, 'Alice');
    b = await makeAgent(2, 'Bob');
    c = await makeAgent(3, 'Carol');
    await pairWith(clock, a, b);
    await pairWith(clock, a, c);
    for (let i = 0; i < items; i += 1) {
      const id = await put({ contact: i % 2 ? b.id : c.id, createdAt: T0 + i });
      await putReceivedProof(id, i % 3 === 0);
    }
    const spy = vi.spyOn(a.store, 'transaction');
    try {
      expect(await page({ limit: 100 })).toHaveLength(items);
      return spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
  }

  it('a page of 12 inbound items opens as many transactions as a page of 2', async () => {
    const small = await transactionsFor(2);
    const large = await transactionsFor(12);
    expect(large).toBe(small);
  });

  it('the flag is still exact per item: asked and unsigned only', async () => {
    const asked = await put({ contact: b.id, createdAt: T0 });
    const signed = await put({ contact: b.id, createdAt: T0 + 1 });
    const plain = await put({ contact: c.id, createdAt: T0 + 2 });
    const none = await put({ contact: c.id, createdAt: T0 + 3 });
    await putReceivedProof(asked, true);
    const signedRecord = await putReceivedProof(signed, true);
    await putReceivedProof(plain, false);
    await a.store.transaction((tx) =>
      tx.insert('receipts', {
        record_id: signedRecord,
        type: 1,
        signer: a.id,
        tx_hash: null,
        at: T0,
      }),
    );
    const items = await page();
    const flag = (id: string) =>
      (items.find((i) => i.envelopeId === id) as { receiptRequested?: true } | undefined)
        ?.receiptRequested;
    expect(items).toHaveLength(4);
    expect(flag(asked)).toBe(true);
    expect(flag(signed)).toBeUndefined();
    expect(flag(plain)).toBeUndefined();
    expect(flag(none)).toBeUndefined();
  });
});
