// REL051-A34 (D-149; 08 §1): `client.filesIo.previewSource(id)`, what the local app's preview route
// needs about one received file, by its item ID only: the sanitised name (for the kind), the size
// the sender stated, the plaintext hash (the route re-checks the saved bytes against it) and the
// saved name (null until the file is saved). Never a path, a link, a key or the file's bytes.
// The same selection as `savedName`: an inbound message from a listed contact; null otherwise.
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { describe, expect, it } from 'vitest';
import { FakeClock, passphrase, seed } from '../testing/fixtures.js';
import {
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
const ownerA = new MemoryOwnerKeyStore(seed(281), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(282), passphrase());

async function agents(): Promise<{ a: FileAgent; b: FileAgent }> {
  const clock = new FakeClock();
  const own = new MemoryOwnStorage();
  const a = await openFileAgent(clock, new MemoryKeyStore(seed(81)), ownerA, 'alice', {
    relays: RELAYS_A,
    own,
  });
  const b = await openFileAgent(clock, new MemoryKeyStore(seed(82)), ownerB, 'bob', {
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

describe('client.filesIo.previewSource(id) (REL051-A34)', () => {
  it('answers name, size, plaintext hash and saved name by item ID only', async () => {
    const { a, b } = await agents();
    const saved = await send(a, b, 'plan.md', 900);
    const waiting = await send(a, b, 'notes.txt', 300);
    await b.client.fetchFile({ envelopeId: saved });

    const source = await b.client.filesIo.previewSource(`${saved}.00`);
    expect(source).toMatchObject({ name: 'plan.md', size: 900, savedName: 'plan.md' });
    expect(source?.plaintextSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(source ?? {}).sort()).toEqual([
      'name',
      'plaintextSha256',
      'savedName',
      'size',
    ]);
    expect(await b.client.filesIo.previewSource(`${waiting}.00`)).toMatchObject({
      name: 'notes.txt',
      savedName: null,
    });
  });

  it('answers null for anything that is not one received file of this agent', async () => {
    const { a, b } = await agents();
    const id = await send(a, b, 'plan.md', 900);
    await b.client.fetchFile({ envelopeId: id });
    for (const bad of ['', id, `${id}.01`, `${id}.0`, `../${id}.00`, `${id}.00/x`, 'x'.repeat(70)]) {
      expect(await b.client.filesIo.previewSource(bad), bad).toBeNull();
    }
    // The sender's own copy is not a received file.
    expect(await a.client.filesIo.previewSource(`${id}.00`)).toBeNull();
  });
});
