// REL051-A12 (WP-A1, WP-A2, plan item 7): the type a sender labels a file with, the text of a small
// received text file returned by fetchFile, and where an inbox page's saved files are.
//
// - The sender's MIME type comes from the extension (fixed table, @4thtech-io/types file-kind.ts);
//   the receiver never trusts it: the kind is derived from the name, and the text is returned only
//   for a text kind, at most 64 KB, valid UTF-8 without NUL, after both hash checks.
// - A file already saved is answered from the saved copy, which is read back and must still hash to
//   the payload's plaintext hash and size; a changed copy gives no text.
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Sealed } from '../store/schema.js';
import { rowKeyOf } from '../store/store.js';
import { FakeClock, passphrase, seed } from '../testing/fixtures.js';
import {
  INBOX,
  MemoryOwnStorage,
  deliver,
  openFileAgent,
  outgoing,
  pairForFiles,
  type FileAgent,
} from '../testing/files.js';

const RELAYS_A = Object.freeze(['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net']);
const RELAYS_B = Object.freeze(['wss://one.relay-beta.net', 'wss://two.relay-beta.net']);
const ownerA = new MemoryOwnerKeyStore(seed(221), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(222), passphrase());

let clock: FakeClock;
let own: MemoryOwnStorage;
let a: FileAgent;
let b: FileAgent;

beforeEach(async () => {
  clock = new FakeClock();
  own = new MemoryOwnStorage();
  a = await openFileAgent(clock, new MemoryKeyStore(seed(21)), ownerA, 'alice', {
    relays: RELAYS_A,
    own,
  });
  b = await openFileAgent(clock, new MemoryKeyStore(seed(22)), ownerB, 'bob', {
    relays: RELAYS_B,
    own,
  });
  await pairForFiles(clock, a, b);
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const PLAN = '# Build plan\n\n1. Write the tests\n2. Ship ✓\n';

async function sendFile(
  name: string,
  bytes: Uint8Array,
  extra: { mime?: string } = {},
): Promise<string> {
  const sent = await a.client.sendMessage({
    to: b.id,
    text: 'a file',
    files: [outgoing(name, bytes, extra)],
  });
  expect(sent.status).toBe('ok');
  if (sent.status !== 'ok') throw new Error('not sent');
  await deliver(a, b);
  return sent.envelopeId;
}

/** The sender's stated MIME type, as stored in the receiver's payload. */
async function storedMime(envelopeId: string): Promise<string> {
  const row = await b.store.transaction((tx) => tx.get('envelopes', { envelope_id: envelopeId }));
  const payload = JSON.parse(
    await b.cipher.open(
      { table: 'envelopes', column: 'payload_json', rowKey: rowKeyOf([envelopeId]) },
      row?.payload_json as Sealed,
    ),
  ) as { files: { mime: string }[] };
  return payload.files[0]!.mime;
}

describe('the sender labels the type from the extension (WP-A2)', () => {
  it.each([
    ['plan.md', 'text/markdown'],
    ['data.json', 'application/json'],
    ['fix.patch', 'text/x-diff'],
    ['main.ts', 'text/plain'],
    ['shot.png', 'image/png'],
    ['blob.bin', 'application/octet-stream'],
  ])('%s travels as %s', async (name, mime) => {
    const envelopeId = await sendFile(name, enc('x'));
    expect(await storedMime(envelopeId)).toBe(mime);
  });

  it('a MIME type the caller gives is kept (the payload schema is unchanged)', async () => {
    const envelopeId = await sendFile('plan.md', enc('x'), { mime: 'application/pdf' });
    expect(await storedMime(envelopeId)).toBe('application/pdf');
  });

  it("the receiver's inbox page derives the kind from the name, not the sender's MIME", async () => {
    await sendFile('plan.md', enc(PLAN), { mime: 'application/octet-stream' });
    await sendFile('evil.exe', enc('MZ'), { mime: 'text/markdown' });
    const page = await b.client.inbox.page({
      limit: 10,
      includeRead: true,
      includeSent: false,
      sizeOf: () => 1,
      maxBytes: 1_000_000,
    });
    if (page.status !== 'ok') throw new Error('no page');
    const kinds = new Map(page.items.flatMap((item) => item.files).map((f) => [f.name, f.kind]));
    expect(kinds).toEqual(
      new Map([
        ['plan.md', 'markdown'],
        ['evil.exe', 'other'],
      ]),
    );
  });
});

describe('fetchFile returns the text of a small text file (WP-A1)', () => {
  it('an inline Markdown file: saved, and its verified text returned', async () => {
    const envelopeId = await sendFile('plan.md', enc(PLAN));
    const fetched = await b.client.fetchFile({ envelopeId, readText: true });
    expect(fetched).toEqual({
      status: 'ok',
      savedTo: `${INBOX}/plan.md`,
      name: 'plan.md',
      size: enc(PLAN).length,
      integrity: 'verified',
      text: PLAN,
    });
    expect(new TextDecoder().decode(b.inbox.files().get('plan.md'))).toBe(PLAN);
  });

  it('without readText no text is returned (auto-save and Save in the app)', async () => {
    const envelopeId = await sendFile('plan.md', enc(PLAN));
    const fetched = await b.client.fetchFile({ envelopeId });
    expect(fetched).not.toHaveProperty('text');
  });

  it('the size boundary: 65 536 bytes (from storage) has text, 65 537 has none', async () => {
    const at = 'a'.repeat(65_536);
    const over = 'b'.repeat(65_537);
    const atId = await sendFile('at.txt', enc(at));
    const overId = await sendFile('over.txt', enc(over));
    expect(await b.client.fetchFile({ envelopeId: atId, readText: true })).toMatchObject({
      status: 'ok',
      text: at,
    });
    const big = await b.client.fetchFile({ envelopeId: overId, readText: true });
    expect(big).toMatchObject({ status: 'ok', size: 65_537 });
    expect(big).not.toHaveProperty('text');
  });

  it.each([
    ['a binary type', 'shot.png', enc('not really a png')],
    ['an unknown type', 'blob.bin', enc('plain words')],
    ['a text name with invalid UTF-8', 'notes.txt', new Uint8Array([0x61, 0xff, 0xfe, 0x62])],
    ['a text name with a NUL byte', 'notes.md', new Uint8Array([0x61, 0x00, 0x62])],
  ])('%s: saved, no text', async (_label, name, bytes) => {
    const envelopeId = await sendFile(name, bytes);
    const fetched = await b.client.fetchFile({ envelopeId, readText: true });
    expect(fetched).toMatchObject({ status: 'ok' });
    expect(fetched).not.toHaveProperty('text');
  });

  it('a spoofed sender type never decides: text/markdown on a .bin has no text; octet-stream on a .md has', async () => {
    const binId = await sendFile('payload.bin', enc('# looks like markdown'), {
      mime: 'text/markdown',
    });
    const mdId = await sendFile('plan.md', enc(PLAN), { mime: 'application/octet-stream' });
    expect(await b.client.fetchFile({ envelopeId: binId, readText: true })).not.toHaveProperty(
      'text',
    );
    expect(await b.client.fetchFile({ envelopeId: mdId, readText: true })).toMatchObject({
      text: PLAN,
    });
  });

  it('already saved: answered from the saved copy, read back and re-hashed', async () => {
    const envelopeId = await sendFile('plan.md', enc(PLAN));
    await b.client.fetchFile({ envelopeId });
    const writes = b.inbox.writes.length;
    const again = await b.client.fetchFile({ envelopeId, readText: true });
    expect(again).toMatchObject({ status: 'ok', name: 'plan.md', text: PLAN });
    expect(b.inbox.writes.length).toBe(writes); // no second download or copy
  });

  it('a saved copy changed since gives no text (never unverified bytes)', async () => {
    const envelopeId = await sendFile('plan.md', enc(PLAN));
    await b.client.fetchFile({ envelopeId });
    const entry = b.inbox.entries.get('plan.md');
    if (entry === undefined) throw new Error('not saved');
    entry.data = enc(PLAN.replace('tests', 'TESTS'));
    const again = await b.client.fetchFile({ envelopeId, readText: true });
    expect(again).toMatchObject({ status: 'ok' });
    expect(again).not.toHaveProperty('text');
  });
});

describe('savedFilePaths: where saved files are, for the inbox (plan item 7)', () => {
  it('a saved file has its path; an unsaved or missing one has none', async () => {
    const saved = await sendFile('plan.md', enc(PLAN));
    const unsaved = await sendFile('later.md', enc('later'));
    expect(await b.client.savedFilePaths([{ envelopeId: saved, fileIndex: 0 }])).toEqual(new Map());
    await b.client.fetchFile({ envelopeId: saved });
    const paths = await b.client.savedFilePaths([
      { envelopeId: saved, fileIndex: 0 },
      { envelopeId: unsaved, fileIndex: 0 },
      { envelopeId: saved, fileIndex: 3 },
    ]);
    expect(paths).toEqual(new Map([[`${saved}.0`, `${INBOX}/plan.md`]]));
    // Deleted from the folder since: no path.
    b.inbox.entries.delete('plan.md');
    expect(await b.client.savedFilePaths([{ envelopeId: saved, fileIndex: 0 }])).toEqual(new Map());
  });
});
