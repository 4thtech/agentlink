// MSG-FILES-IO-d: `client.filesIo` reads the sealed saved name (MSG-FILES-IO-b) for the local app's
// Files, Received tab (plan docs/process/proposals/MSG-FILES-IO.md §3, §4; 08 §1; I-7).
// - A fetched file reads `saved` with `savedName`, the single name fetchFile chose in the Inbox
//   folder; never the path it was saved to.
// - One row whose saved name cannot be opened (`store_unreadable`) never hides the list: that item
//   still shows, without "saved as", and every other item keeps its saved name.
// - A file not fetched yet reads `not_saved`, without `savedName`.
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { describe, expect, it } from 'vitest';
import { rowKeyOf } from '../store/store.js';
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
const ownerA = new MemoryOwnerKeyStore(seed(271), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(272), passphrase());

async function agents(): Promise<{ a: FileAgent; b: FileAgent }> {
  const clock = new FakeClock();
  const own = new MemoryOwnStorage();
  const a = await openFileAgent(clock, new MemoryKeyStore(seed(71)), ownerA, 'alice', {
    relays: RELAYS_A,
    own,
  });
  const b = await openFileAgent(clock, new MemoryKeyStore(seed(72)), ownerB, 'bob', {
    relays: RELAYS_B,
    own,
  });
  await pairForFiles(clock, a, b);
  return { a, b };
}

async function send(a: FileAgent, b: FileAgent, name: string, size: number): Promise<string> {
  const sent = await a.client.sendMessage({
    to: b.id,
    text: 'file',
    files: [outgoing(name, fileBytes(size))],
  });
  if (sent.status !== 'ok') throw new Error('not sent');
  await deliver(a, b);
  return sent.envelopeId;
}

describe('client.filesIo reads the saved name (MSG-FILES-IO-d)', () => {
  it('a fetched file reads saved with its single file name, never a path', async () => {
    const { a, b } = await agents();
    const fetched = await send(a, b, 'report.pdf', 50_000);
    const waiting = await send(a, b, 'notes.txt', 1_000);
    const out = await b.client.fetchFile({ envelopeId: fetched });
    expect(out).toMatchObject({ status: 'ok', name: 'report.pdf' });

    const page = await b.client.filesIo.received();
    const byId = new Map(page.items.map((i) => [i.id, i]));
    expect(byId.get(`${fetched}.00`)).toMatchObject({ state: 'saved', savedName: 'report.pdf' });
    expect(byId.get(`${waiting}.00`)?.state).toBe('not_saved');
    expect(byId.get(`${waiting}.00`)).not.toHaveProperty('savedName');
    const text = JSON.stringify(page);
    expect(text).not.toContain(INBOX);
    expect(text).not.toContain('/');
  });

  it('one saved name that does not open hides only that "saved as", never the list', async () => {
    const { a, b } = await agents();
    const broken = await send(a, b, 'first.pdf', 50_000);
    const fine = await send(a, b, 'second.pdf', 50_000);
    await b.client.fetchFile({ envelopeId: broken });
    await b.client.fetchFile({ envelopeId: fine });
    // Seal a value bound to another row: it no longer opens as this row's saved_name.
    const wrong = await b.cipher.seal(
      { table: 'files', column: 'saved_name', rowKey: rowKeyOf([fine, 0]) },
      'first.pdf',
    );
    await b.store.transaction((tx) =>
      tx.update('files', { envelope_id: broken, idx: 0 }, { saved_name: wrong }),
    );

    const page = await b.client.filesIo.received();
    const byId = new Map(page.items.map((i) => [i.id, i]));
    expect(page.items).toHaveLength(2);
    expect(byId.get(`${broken}.00`)).toMatchObject({ name: 'first.pdf', state: 'not_saved' });
    expect(byId.get(`${broken}.00`)).not.toHaveProperty('savedName');
    expect(byId.get(`${fine}.00`)).toMatchObject({ state: 'saved', savedName: 'second.pdf' });
    // The name never reaches a log line (I-7).
    expect(b.lines.join('\n')).not.toContain('second.pdf');
  });
});
