// RET-2 (D-148; 07 §3.8; 04 §4.2): the saved-file index.
// - Every save into the Inbox folder (auto-save, Save, `agentlink_fetch_file`) writes one
//   `saved_files` row: the contact, the sealed single name, size, the payload's plaintextSha256, the
//   sealed device and inode after the move, and the time. No key and no URL.
// - The row survives the day-7 shred of the receiver's `files` row.
// - The backfill indexes files saved before RET-2 whose `files` row still records a saved name:
//   best effort, a missing file or a link (never followed) is skipped, an existing row is kept.
// - Nothing about a saved file reaches a log line: no name, no content, no plaintext (I-7).
import { encodeHex, sha256 } from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { describe, expect, it } from 'vitest';
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
import { openSavedFile } from './saved-files.js';

const RELAYS_A = Object.freeze(['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net']);
const RELAYS_B = Object.freeze(['wss://one.relay-beta.net', 'wss://two.relay-beta.net']);
const ownerA = new MemoryOwnerKeyStore(seed(351), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(352), passphrase());
const DAY = 86_400;
const MARKER = 'RET2-SECRET-CONTENT-41';

interface World {
  a: FileAgent;
  b: FileAgent;
  clock: FakeClock;
}

async function world(): Promise<World> {
  const clock = new FakeClock();
  const own = new MemoryOwnStorage();
  const a = await openFileAgent(clock, new MemoryKeyStore(seed(141)), ownerA, 'alice', {
    relays: RELAYS_A,
    own,
  });
  const b = await openFileAgent(clock, new MemoryKeyStore(seed(142)), ownerB, 'bob', {
    relays: RELAYS_B,
    own,
  });
  await pairForFiles(clock, a, b);
  return { a, b, clock };
}

async function send(w: World, name: string, size = 4_000): Promise<string> {
  const sent = await w.a.client.sendMessage({
    to: w.b.id,
    text: 'file',
    files: [outgoing(name, fileBytes(size, MARKER))],
  });
  if (sent.status !== 'ok') throw new Error('not sent');
  await deliver(w.a, w.b);
  return sent.envelopeId;
}

const plaintextHash = (size = 4_000): string => encodeHex(sha256(fileBytes(size, MARKER)));

describe('saved_files is written at every save (RET-2, 07 §3.8)', () => {
  it('a requested save writes one row: contact, sealed name, size, plaintext hash, dev and ino', async () => {
    const w = await world();
    const envelopeId = await send(w, 'plan.pdf');
    w.clock.t += 5;
    expect(await w.b.client.fetchFile({ envelopeId })).toMatchObject({ status: 'ok' });

    const rows = await w.b.store.transaction((tx) => tx.select('saved_files'));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      envelope_id: envelopeId,
      idx: 0,
      contact_id: w.a.id,
      size: 4_000,
      sha256: plaintextHash(),
      saved_at: w.clock.t,
      trashed_at: null,
    });
    // Sealed: the clear name is not in the row.
    expect(JSON.stringify(row)).not.toContain('plan.pdf');
    const view = await openSavedFile({ cipher: w.b.cipher }, row);
    expect(view).toMatchObject({
      envelopeId,
      index: 0,
      contactId: w.a.id,
      name: 'plan.pdf',
      size: 4_000,
      sha256: plaintextHash(),
      trashedAt: null,
    });
    const id = await w.b.inbox.identify('plan.pdf');
    expect(id).toBeDefined();
    expect(view.dev).toBe(id?.dev);
    expect(view.ino).toBe(id?.ino);
  });

  it('an automatic save writes the row too', async () => {
    const w = await world();
    const envelopeId = await send(w, 'auto.txt', 300);
    expect((await w.b.client.autoSave.run()).saved).toBe(1);
    const row = await w.b.store.transaction((tx) =>
      tx.get('saved_files', { envelope_id: envelopeId, idx: 0 }),
    );
    expect(row).toMatchObject({ contact_id: w.a.id, size: 300, sha256: plaintextHash(300) });
  });

  it('the index survives the day-7 shred of the files row', async () => {
    const w = await world();
    const envelopeId = await send(w, 'kept.pdf');
    await w.b.client.fetchFile({ envelopeId });
    w.clock.t += 7 * DAY;
    expect(await w.b.client.deleteExpiredFiles()).toMatchObject({ deleted: 1 });
    const left = await w.b.store.transaction((tx) => ({
      files: tx.select('files'),
      saved: tx.select('saved_files'),
    }));
    expect(left.files).toHaveLength(0);
    expect(left.saved).toHaveLength(1);
    const view = await openSavedFile({ cipher: w.b.cipher }, left.saved[0]!);
    expect(view.name).toBe('kept.pdf');
    expect(view.envelopeId).toBe(envelopeId);
  });

  it('holds no file key and no URL', async () => {
    const w = await world();
    const envelopeId = await send(w, 'big.bin', 200_000);
    await w.b.client.fetchFile({ envelopeId });
    const [row] = await w.b.store.transaction((tx) => tx.select('saved_files'));
    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        'contact_id',
        'dev',
        'envelope_id',
        'idx',
        'ino',
        'saved_at',
        'saved_name',
        'sha256',
        'size',
        'trashed_at',
      ].sort(),
    );
  });
});

describe('the saved_files backfill (RET-2 migration, 07 §3.8)', () => {
  /** Saves three files, then forgets their index rows, as a store migrated from version 14 has. */
  async function savedBeforeRet2(w: World): Promise<string[]> {
    const ids = [await send(w, 'one.pdf'), await send(w, 'two.pdf'), await send(w, 'three.pdf')];
    for (const envelopeId of ids) await w.b.client.fetchFile({ envelopeId });
    await w.b.store.transaction((tx) => tx.delete('saved_files', {}));
    return ids;
  }

  it('indexes regular files, skips a missing file and a link, and keeps existing rows', async () => {
    const w = await world();
    const [one, two, three] = await savedBeforeRet2(w);
    // two.pdf was deleted by the person; three.pdf was replaced by a link (never followed).
    await w.b.inbox.remove('two.pdf');
    await w.b.inbox.remove('three.pdf');
    w.b.inbox.plantSymlink('three.pdf');

    expect(await w.b.client.backfillSavedFiles()).toEqual({ indexed: 1, skipped: 2 });
    const rows = await w.b.store.transaction((tx) => tx.select('saved_files'));
    expect(rows.map((r) => r.envelope_id)).toEqual([one]);
    const view = await openSavedFile({ cipher: w.b.cipher }, rows[0]!);
    expect(view).toMatchObject({ name: 'one.pdf', sha256: plaintextHash(), contactId: w.a.id });
    expect(view.dev).not.toBeNull();
    expect(two).toBeDefined();
    expect(three).toBeDefined();

    // Idempotent: the indexed row is kept as it is; the skipped ones are skipped again.
    const before = rows[0];
    expect(await w.b.client.backfillSavedFiles()).toEqual({ indexed: 0, skipped: 2 });
    const again = await w.b.store.transaction((tx) => tx.select('saved_files'));
    expect(again).toEqual([before]);
  });

  it('runs once with the first auto-save run of a process', async () => {
    const w = await world();
    await savedBeforeRet2(w);
    await w.b.client.autoSave.run();
    expect(await w.b.store.transaction((tx) => tx.count('saved_files'))).toBe(3);
  });

  it('indexes nothing while the files row is gone (older than 7 days: unassigned)', async () => {
    const w = await world();
    await savedBeforeRet2(w);
    w.clock.t += 7 * DAY;
    await w.b.client.deleteExpiredFiles();
    expect(await w.b.client.backfillSavedFiles()).toEqual({ indexed: 0, skipped: 0 });
  });
});

describe('no file content and no plaintext in logs (RET-2, I-7)', () => {
  it('save, shred and backfill log no name, folder, hash or content', async () => {
    const w = await world();
    const ids = [await send(w, 'secret-name.md', 600), await send(w, 'gone-name.md', 600)];
    for (const envelopeId of ids) await w.b.client.fetchFile({ envelopeId });
    await w.b.client.autoSave.run();
    await w.b.store.transaction((tx) => tx.delete('saved_files', {}));
    await w.b.inbox.remove('gone-name.md');
    await w.b.client.backfillSavedFiles();
    w.clock.t += 7 * DAY;
    await w.b.client.deleteExpiredFiles();

    const log = w.b.lines.join('\n');
    expect(log).not.toContain('secret-name');
    expect(log).not.toContain('gone-name');
    expect(log).not.toContain(INBOX);
    expect(log).not.toContain(MARKER);
    expect(log).not.toContain(plaintextHash(600));
    // The backfill says what it did in counts only.
    expect(log).toMatch(/saved files indexed/);
  });
});
