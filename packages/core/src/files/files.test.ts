// M1-7f: files end to end at the core layer, between two in-process agents (04 §3.4, §4; 06 §2.3;
// 07 §5.6; D-84, D-85). The drop round trip runs against the real drop Worker in
// files.worker.test.ts; here own storage is an in-memory S3 stand-in, so a download can be tampered
// with or truncated.
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { encodeHex, sha256 } from '@4thtech-io/crypto';

/** A payload or file entry, editable in a test. */
type JsonObject = Record<string, unknown>;
import { beforeEach, describe, expect, it } from 'vitest';
import { rowKeyOf } from '../store/store.js';
import type { Sealed } from '../store/schema.js';
import { FakeClock, passphrase, seed } from '../testing/fixtures.js';
import {
  INBOX,
  MemoryOwnStorage,
  deliver,
  fileBytes,
  openFileAgent,
  outgoing,
  pairForFiles,
  type FileAgent,
} from '../testing/files.js';

const RELAYS_A = Object.freeze(['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net']);
const RELAYS_B = Object.freeze(['wss://one.relay-beta.net', 'wss://two.relay-beta.net']);

const ownerA = new MemoryOwnerKeyStore(seed(211), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(212), passphrase());

let clock: FakeClock;
let own: MemoryOwnStorage;
let a: FileAgent;
let b: FileAgent;

beforeEach(async () => {
  clock = new FakeClock();
  own = new MemoryOwnStorage();
  a = await openFileAgent(clock, new MemoryKeyStore(seed(11)), ownerA, 'alice', {
    relays: RELAYS_A,
    own,
  });
  b = await openFileAgent(clock, new MemoryKeyStore(seed(12)), ownerB, 'bob', {
    relays: RELAYS_B,
    own,
  });
  await pairForFiles(clock, a, b);
});

const hex = (bytes: Uint8Array): string => encodeHex(sha256(bytes));

/** Every value the store holds, as one string (sealed columns stay sealed). */
async function dump(agent: FileAgent): Promise<string> {
  return agent.store.transaction((tx) =>
    JSON.stringify({
      envelopes: tx.select('envelopes'),
      files: tx.select('files'),
      outbox: tx.select('outbox'),
      idempotency: tx.select('idempotency'),
    }),
  );
}

/** Rewrites the stored payload of a received envelope, as a hostile sender's core would send it. */
async function editPayload(
  agent: FileAgent,
  envelopeId: string,
  edit: (payload: JsonObject) => void,
): Promise<void> {
  const context = {
    table: 'envelopes' as const,
    column: 'payload_json',
    rowKey: rowKeyOf([envelopeId]),
  };
  const row = await agent.store.transaction((tx) =>
    tx.get('envelopes', { envelope_id: envelopeId }),
  );
  const payload = JSON.parse(
    await agent.cipher.open(context, row?.payload_json as Sealed),
  ) as JsonObject;
  edit(payload);
  const sealed = await agent.cipher.seal(context, JSON.stringify(payload));
  await agent.store.transaction((tx) =>
    tx.update('envelopes', { envelope_id: envelopeId }, { payload_json: sealed }),
  );
}

const fileEntry = (payload: JsonObject, i = 0): JsonObject =>
  (payload.files as JsonObject[])[i] as JsonObject;

async function sendOne(bytes: Uint8Array, name = 'report.pdf'): Promise<string> {
  const sent = await a.client.sendMessage({
    to: b.id,
    text: 'the file',
    files: [outgoing(name, bytes, { mime: 'application/pdf' })],
  });
  expect(sent.status).toBe('ok');
  if (sent.status !== 'ok') throw new Error('not sent');
  await deliver(a, b);
  return sent.envelopeId;
}

describe('send and fetch between two agents (06 §2.3, 04 §4)', () => {
  it('an inline file: travels in the payload, verifies, and lands in the inbox', async () => {
    const bytes = fileBytes(1_000);
    const sent = await a.client.sendMessage({
      to: b.id,
      text: 'the file',
      files: [outgoing('report.pdf', bytes, { mime: 'application/pdf' })],
    });
    expect(sent).toMatchObject({
      status: 'ok',
      files: [{ index: 0, delivery: 'inline' }],
    });
    if (sent.status !== 'ok') return;
    expect(own.objects.size).toBe(0);
    await deliver(a, b);

    const fetched = await b.client.fetchFile({ envelopeId: sent.envelopeId });
    expect(fetched).toEqual({
      status: 'ok',
      savedTo: `${INBOX}/report.pdf`,
      name: 'report.pdf',
      size: 1_000,
      integrity: 'verified',
    });
    expect(hex(b.inbox.files().get('report.pdf') as Uint8Array)).toBe(hex(bytes));
    // The quarantine file was created first and renamed; nothing else is left.
    expect(b.inbox.created[0]).toMatch(/^\.agentlink-partial-[0-9a-f]{32}$/);
    expect([...b.inbox.entries.keys()]).toEqual(['report.pdf']);
  });

  it('a stored file: uploaded as ciphertext only, fetched through the URL, verified', async () => {
    const bytes = fileBytes(200_000);
    const envelopeId = await sendOne(bytes);
    expect(own.objects.size).toBe(1);
    const stored = [...own.objects.values()][0] as Uint8Array;
    expect(new TextDecoder().decode(stored)).not.toContain('PLAINTEXT-MARKER-7f');
    expect(stored.length).toBe(17 + 16 + 200_000);

    const fetched = await b.client.fetchFile({ envelopeId, fileIndex: 0 });
    expect(fetched).toMatchObject({ status: 'ok', name: 'report.pdf', size: 200_000 });
    expect(hex(b.inbox.files().get('report.pdf') as Uint8Array)).toBe(hex(bytes));
  });

  it('the sender keeps a files row with the file key and locator sealed (07 §3)', async () => {
    const envelopeId = await sendOne(fileBytes(50_000));
    const rows = await a.store.transaction((tx) => tx.select('files'));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({ envelope_id: envelopeId, idx: 0, size: 50_000, deleted_at: null });
    for (const column of ['name', 'locator', 'url', 'file_key'] as const) {
      expect(row?.[column]).toMatch(/^test-sealed:/);
    }
    const url = await a.cipher.open(
      { table: 'files', column: 'url', rowKey: rowKeyOf([envelopeId, 0]) },
      row?.url as Sealed,
    );
    expect(own.urls).toContain(url);
  });

  it('refuses a file outside the allowed folders without opening it (needs_setup)', async () => {
    let opened = false;
    const result = await a.client.sendMessage({
      to: b.id,
      text: 'x',
      files: [
        {
          realpath: '/home/u/Other/secret.txt',
          size: 10,
          open: () => {
            opened = true;
            return Promise.resolve(new Uint8Array(10));
          },
        },
      ],
    });
    expect(result).toEqual({ status: 'needs_setup', reason: 'outside_folder' });
    expect(opened).toBe(false);
    expect(a.spy.published).toHaveLength(0);
  });

  it.each(['/home/u/Work/.env', '/home/u/Work/.git/config'])(
    'refuses a hidden file below the allowed folder without opening it: %s',
    async (realpath) => {
      let opened = false;
      const result = await a.client.sendMessage({
        to: b.id,
        text: 'x',
        files: [
          {
            realpath,
            size: 10,
            open: () => {
              opened = true;
              return Promise.resolve(new Uint8Array(10));
            },
          },
        ],
      });
      expect(result).toEqual({ status: 'needs_setup', reason: 'outside_folder' });
      expect(opened).toBe(false);
    },
  );

  it('not_found for an unknown envelope or file index', async () => {
    const envelopeId = await sendOne(fileBytes(100));
    expect(await b.client.fetchFile({ envelopeId, fileIndex: 1 })).toEqual({ status: 'not_found' });
    expect(await b.client.fetchFile({ envelopeId: 'AAAAAAAAAAAAAAAAAAAAAA' })).toEqual({
      status: 'not_found',
    });
    // The sender's own outbound envelope is not a received file.
    expect(await a.client.fetchFile({ envelopeId })).toEqual({ status: 'not_found' });
  });
});

describe('D-85 packing inside a send (04 §3.4)', () => {
  it('moves the largest inline file to storage until the payload fits', async () => {
    const files = [6_000, 6_000, 6_000].map((n, i) => outgoing(`f${String(i)}.bin`, fileBytes(n)));
    const sent = await a.client.sendMessage({ to: b.id, text: 'three', files });
    expect(sent).toMatchObject({
      status: 'ok',
      files: [
        { index: 0, delivery: 'inline' },
        { index: 1, delivery: 'own' },
        { index: 2, delivery: 'own' },
      ],
    });
    expect(own.objects.size).toBe(2);
  });

  it('refuses PAYLOAD_TOO_LARGE before any upload when even all-stored cannot fit', async () => {
    let opened = 0;
    const long = `${'n'.repeat(240)}.bin`;
    const files = Array.from({ length: 16 }, (_, i) => ({
      ...outgoing(`${String(i)}${long}`, fileBytes(20_000)),
      open: () => {
        opened += 1;
        return Promise.resolve(fileBytes(20_000));
      },
    }));
    const result = await a.client.sendMessage({ to: b.id, text: 'too many', files });
    expect(result).toEqual({ status: 'rejected', code: 'PAYLOAD_TOO_LARGE' });
    expect(opened).toBe(0);
    expect(own.objects.size).toBe(0);
    expect(a.spy.published).toHaveLength(0);
    expect(await a.store.transaction((tx) => tx.select('files'))).toHaveLength(0);
  });
});

describe('quarantine (D-84): nothing is committed unless the whole file verifies', () => {
  it.each(['flip', 'truncate', 'extend'] as const)(
    'a %s download is refused and leaves no file behind',
    async (alter) => {
      const envelopeId = await sendOne(fileBytes(150_000));
      own.alter = alter;
      expect(await b.client.fetchFile({ envelopeId })).toEqual({
        status: 'rejected',
        code: 'INTEGRITY_FAILED',
      });
      expect(b.inbox.entries.size).toBe(0);
    },
  );

  it('a tampered inline ciphertext is refused before decryption, nothing written', async () => {
    const envelopeId = await sendOne(fileBytes(2_000));
    await editPayload(b, envelopeId, (p) => {
      const f = fileEntry(p);
      const inline = f.inline as string;
      f.inline = `${inline.slice(0, 100)}${inline[100] === 'A' ? 'B' : 'A'}${inline.slice(101)}`;
    });
    expect(await b.client.fetchFile({ envelopeId })).toEqual({
      status: 'rejected',
      code: 'INTEGRITY_FAILED',
    });
    expect(b.inbox.entries.size).toBe(0);
    expect(b.inbox.writes).toHaveLength(0);
  });

  it('a stated plaintext hash that does not match is refused, nothing committed', async () => {
    const envelopeId = await sendOne(fileBytes(30_000));
    await editPayload(b, envelopeId, (p) => {
      fileEntry(p).plaintextSha256 = 'c'.repeat(64);
    });
    expect(await b.client.fetchFile({ envelopeId })).toMatchObject({
      status: 'rejected',
      code: 'INTEGRITY_FAILED',
    });
    expect(b.inbox.entries.size).toBe(0);
  });

  it('a stated size above maxReceiveSizeMB is refused before anything is fetched', async () => {
    const envelopeId = await sendOne(fileBytes(30_000));
    await editPayload(b, envelopeId, (p) => {
      fileEntry(p).size = 300 * 1024 * 1024;
    });
    expect(await b.client.fetchFile({ envelopeId })).toEqual({
      status: 'rejected',
      code: 'FILE_TOO_LARGE',
    });
    expect(b.inbox.created).toHaveLength(0);
  });

  it('an expired link is refused without a download', async () => {
    const envelopeId = await sendOne(fileBytes(30_000));
    clock.t += 8 * 86_400;
    expect(await b.client.fetchFile({ envelopeId })).toEqual({
      status: 'rejected',
      code: 'LINK_EXPIRED',
    });
    expect(b.inbox.created).toHaveLength(0);
  });
});

describe('secrets at rest and in logs (I-7, IR-M1-6c-1)', () => {
  it('the download URL and the file key never reach a log line, and are stored sealed', async () => {
    const bytes = fileBytes(64_000);
    const envelopeId = await sendOne(bytes);
    await b.client.fetchFile({ envelopeId });
    const url = own.urls[0] as string;
    const signature = /X-Amz-Signature=([0-9a-f]+)/.exec(url)?.[1] as string;
    const objectKey = /\/o\/([0-9a-f]{32})/.exec(url)?.[1] as string;
    const payload = JSON.parse(
      await b.cipher.open(
        { table: 'envelopes', column: 'payload_json', rowKey: rowKeyOf([envelopeId]) },
        (await b.store.transaction((tx) => tx.get('envelopes', { envelope_id: envelopeId })))
          ?.payload_json as Sealed,
      ),
    ) as JsonObject;
    const fileKey = fileEntry(payload).fileKey as string;
    expect(a.lines.length + b.lines.length).toBeGreaterThan(0);
    const canaries = [url, signature, objectKey, fileKey, 'report.pdf', 'PLAINTEXT-MARKER-7f'];
    for (const line of [...a.lines, ...b.lines]) {
      for (const canary of canaries) expect(line).not.toContain(canary);
    }
    for (const agent of [a, b]) {
      const raw = await dump(agent);
      for (const canary of [url, signature, fileKey]) expect(raw).not.toContain(canary);
    }
  });
});

describe('saving: names and the inbox folder (04 §4 "Downloads", I-5)', () => {
  it.each([
    ['../../.ssh/authorized_keys', 'authorized_keys'],
    ['..\\..\\Windows\\system32\\evil.dll', 'evil.dll'],
    ['.bashrc', 'bashrc'],
    ['invoice‮fdp.exe', 'invoicefdp.exe'],
    ['a\u0000b\u0007c.txt', 'abc.txt'],
    ['CON.txt', '_CON.txt'],
  ])('a hostile name %j is saved as %j inside the inbox', async (hostile, saved) => {
    const envelopeId = await sendOne(fileBytes(500));
    await editPayload(b, envelopeId, (p) => {
      fileEntry(p).name = hostile;
    });
    const result = await b.client.fetchFile({ envelopeId });
    expect(result).toMatchObject({ status: 'ok', name: saved, savedTo: `${INBOX}/${saved}` });
    expect([...b.inbox.files().keys()]).toEqual([saved]);
  });

  it('never writes through a planted symbolic link: the file gets another name', async () => {
    b.inbox.plantSymlink('report.pdf');
    const envelopeId = await sendOne(fileBytes(500));
    const result = await b.client.fetchFile({ envelopeId });
    expect(result).toMatchObject({ status: 'ok', name: 'report (1).pdf' });
    expect(b.inbox.entries.get('report.pdf')?.kind).toBe('symlink');
    expect(b.inbox.entries.get('report.pdf')?.data.length).toBe(0);
    expect(b.inbox.writes.every((name) => name.startsWith('.agentlink-partial-'))).toBe(true);
  });

  it('never overwrites: a second fetch gets a suffix within the 255-byte name limit', async () => {
    const long = `${'é'.repeat(125)}.pdf`; // 254 bytes
    const envelopeId = await sendOne(fileBytes(500), long);
    const first = await b.client.fetchFile({ envelopeId });
    const second = await b.client.fetchFile({ envelopeId });
    expect(first).toMatchObject({ status: 'ok', name: long });
    expect(second.status).toBe('ok');
    if (second.status !== 'ok') return;
    expect(second.name).not.toBe(long);
    expect(second.name.endsWith(' (1).pdf')).toBe(true);
    expect(new TextEncoder().encode(second.name).length).toBeLessThanOrEqual(255);
    expect(b.inbox.files().size).toBe(2);
  });

  it('refuses an inbox the platform resolves to a relative or malformed path', async () => {
    const envelopeId = await sendOne(fileBytes(500));
    const platform = b.platform as { inbox: unknown };
    platform.inbox = () => Promise.resolve({ realpath: 'relative/inbox', ops: b.inbox });
    await expect(b.client.fetchFile({ envelopeId })).rejects.toMatchObject({
      code: 'inbox_unavailable',
    });
    expect(b.inbox.created).toHaveLength(0);
  });
});
