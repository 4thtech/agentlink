// W4-FILES-SAVE (S2; 04 §2.5.1 `file.save`, §4; 08 §1 "Save a received file"; 06 §2.3; I-1, I-4,
// I-5, I-7; proposed, owner confirms at merge): the owner saves one received file into the Inbox
// folder from the local app, with an owner-signed `file.save`.
//
// - prepareFileSave takes only the received item's ID (`<envelope ID>.<index>`); the body names this
//   agent, the envelope and the index, never a name, folder or path. A malformed ID is refused.
// - saveReceivedFile applies only a `file.save` (any other op is refused before anything is applied,
//   so no other owner action can ride on this path), verified against the own card (owner key,
//   agent, freshness, lifetime, nonce): a stranger's, replayed or expired object saves nothing.
// - Then it runs core's own fetch (fetchFile: the size cap, the SSRF-safe download, local decrypt,
//   both hashes, a sanitised name that never overwrites, only into the Inbox folder), with the
//   envelope and index from the signed body. The result carries the saved name only, never a path.
// - A file already saved is answered `already_saved` before anything is applied (no second copy, the
//   nonce stays unused).
import { encodeHex, type JsonObject } from '@4thtech-io/crypto';
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

const RELAYS_A = Object.freeze(['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net']);
const RELAYS_B = Object.freeze(['wss://one.relay-beta.net', 'wss://two.relay-beta.net']);
const ownerA = new MemoryOwnerKeyStore(seed(281), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(282), passphrase());
const stranger = new MemoryOwnerKeyStore(seed(283), passphrase());

async function agents(): Promise<{ a: FileAgent; b: FileAgent; clock: FakeClock }> {
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
  return { a, b, clock };
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

/** Signs a prepared body with `owner` (the owner surface's one-use signature, as the gate does). */
async function signBody(
  body: JsonObject,
  owner = ownerB,
): Promise<{ body: JsonObject; sig: string }> {
  const session = await owner.unlock(passphrase());
  try {
    return { body, sig: await session.signOwnerAction(body) };
  } finally {
    await session.close();
  }
}

async function prepared(b: FileAgent, itemId: string): Promise<JsonObject> {
  const p = await b.client.ownerActions.prepareFileSave(itemId);
  if (p.status !== 'prepared') throw new Error(`not prepared: ${p.reason}`);
  return p.body as unknown as JsonObject;
}

/** The nonce rows of this path's op (the agents' setup records others, such as their first policy). */
const nonceRows = async (agent: FileAgent) =>
  (await agent.store.transaction((tx) => tx.select('owner_action_nonces'))).filter(
    (r) => r.op === 'file.save',
  );

describe('file.save: prepare (W4-FILES-SAVE)', () => {
  it('builds the body from the item ID alone: this agent, the envelope and the index', async () => {
    const { a, b } = await agents();
    const envelopeId = await send(a, b, 'brief.txt', 50_000);
    const body = await prepared(b, `${envelopeId}.00`);
    expect(body['op']).toBe('file.save');
    expect(body['agent']).toBe(b.id);
    expect(body['params']).toEqual({ agent: b.id, envelopeId, fileIndex: 0 });
    expect(Number(body['expiresAt']) - Number(body['issuedAt'])).toBeLessThanOrEqual(600);
    expect(JSON.stringify(body)).not.toContain('brief.txt');
    expect(JSON.stringify(body)).not.toContain(INBOX);
  });

  it('refuses a malformed item ID (traversal, a name, a path, an index past the last file)', async () => {
    const { a, b } = await agents();
    const envelopeId = await send(a, b, 'brief.txt', 1_000);
    for (const id of [
      '',
      envelopeId,
      `${envelopeId}.0`,
      `${envelopeId}.16`,
      `${envelopeId}.00/../x`,
      `../${envelopeId}.00`,
      `${envelopeId}.00 `,
      'brief.txt',
      '/etc/passwd',
      `${'a'.repeat(65)}.00`,
    ]) {
      const p = await b.client.ownerActions.prepareFileSave(id);
      expect(p, id).toMatchObject({ status: 'refused', op: 'file.save', reason: 'item_invalid' });
    }
  });
});

describe('file.save: saveReceivedFile (W4-FILES-SAVE)', () => {
  it('applies the owner-signed save, decrypts locally into the Inbox folder, answers the name only', async () => {
    const { a, b } = await agents();
    const bytes = fileBytes(50_000);
    const sent = await a.client.sendMessage({
      to: b.id,
      text: 'file',
      files: [outgoing('brief.txt', bytes)],
    });
    if (sent.status !== 'ok') throw new Error('not sent');
    await deliver(a, b);
    const itemId = `${sent.envelopeId}.00`;

    const out = await b.client.saveReceivedFile(await signBody(await prepared(b, itemId)));
    expect(out).toEqual({ status: 'saved', name: 'brief.txt' });
    expect(JSON.stringify(out)).not.toContain(INBOX);
    expect(b.inbox.files().get('brief.txt')).toEqual(bytes);
    expect(await b.client.filesIo.savedName(itemId)).toBe('brief.txt');
    expect((await nonceRows(b)).map((r) => r.op)).toEqual(['file.save']);
    // Nothing names the file or the folder in a log line (I-7).
    expect(b.lines.join('\n')).not.toContain('brief.txt');
    expect(b.lines.join('\n')).not.toContain(INBOX);
  });

  it('a replayed save is refused and writes no second copy', async () => {
    const { a, b } = await agents();
    const envelopeId = await send(a, b, 'brief.txt', 1_000);
    const signedSave = await signBody(await prepared(b, `${envelopeId}.00`));
    expect((await b.client.saveReceivedFile(signedSave)).status).toBe('saved');
    // Saved: the second call is answered before anything is applied.
    expect(await b.client.saveReceivedFile(signedSave)).toEqual({ status: 'already_saved' });
    expect([...b.inbox.files().keys()]).toEqual(['brief.txt']);
  });

  it("refuses a stranger's signature, another agent's body and an expired object; nothing is saved", async () => {
    const { a, b, clock } = await agents();
    const envelopeId = await send(a, b, 'brief.txt', 1_000);
    const body = await prepared(b, `${envelopeId}.00`);

    const byStranger = await b.client.saveReceivedFile(
      await signBody(
        { ...body, owner: encodeHex((await stranger.getPublicKeys()).ownerNostr) },
        stranger,
      ),
    );
    expect(byStranger).toMatchObject({ status: 'refused' });

    // A forgery: the body names the real owner, the signature is a stranger's key over that body.
    const strangerSigned = await signBody(
      { ...body, owner: encodeHex((await stranger.getPublicKeys()).ownerNostr) },
      stranger,
    );
    const forged = await b.client.saveReceivedFile({ body, sig: strangerSigned.sig });
    expect(forged).toMatchObject({ status: 'refused' });

    const forA = {
      ...body,
      agent: a.id,
      params: { ...(body['params'] as JsonObject), agent: a.id },
    };
    expect(await b.client.saveReceivedFile(await signBody(forA))).toMatchObject({
      status: 'refused',
    });

    const later = await signBody(body);
    clock.t += 601;
    expect(await b.client.saveReceivedFile(later)).toMatchObject({ status: 'refused' });

    expect(b.inbox.files().size).toBe(0);
    expect(await nonceRows(b)).toEqual([]);
  });

  it('applies nothing but file.save: another owner action on this path is refused, unapplied', async () => {
    const { a, b } = await agents();
    await send(a, b, 'brief.txt', 1_000);
    const label = await b.client.ownerActions.prepareLabel('Other name');
    if (label.status !== 'prepared') throw new Error('not prepared');
    const out = await b.client.saveReceivedFile(
      await signBody(label.body as unknown as JsonObject),
    );
    expect(out).toEqual({ status: 'refused', reason: 'malformed' });
    expect(await b.client.ownerActions.loadLabel()).toEqual({ status: 'none' });
    expect(await nonceRows(b)).toEqual([]);
    for (const junk of [null, 'x', 42, {}, { body: {}, sig: 'x' }]) {
      expect(await b.client.saveReceivedFile(junk)).toEqual({
        status: 'refused',
        reason: 'malformed',
      });
    }
  });

  it('answers not_found for a file this agent never received (its own sent file included)', async () => {
    const { a, b } = await agents();
    const envelopeId = await send(a, b, 'brief.txt', 1_000);
    // A's own sent file: A prepares, but it is not a received file of A.
    const p = await a.client.ownerActions.prepareFileSave(`${envelopeId}.00`);
    if (p.status !== 'prepared') throw new Error('not prepared');
    const out = await a.client.saveReceivedFile(
      await signBody(p.body as unknown as JsonObject, ownerA),
    );
    expect(out).toEqual({ status: 'not_found' });
    // And another index of B's message.
    const other = await b.client.saveReceivedFile(
      await signBody(await prepared(b, `${envelopeId}.03`)),
    );
    expect(other).toEqual({ status: 'not_found' });
    expect(b.inbox.files().size).toBe(0);
  });

  it('never follows or overwrites a link planted at the name: the file gets a suffix', async () => {
    const { a, b } = await agents();
    b.inbox.plantSymlink('brief.txt');
    const envelopeId = await send(a, b, 'brief.txt', 1_000);
    const out = await b.client.saveReceivedFile(
      await signBody(await prepared(b, `${envelopeId}.00`)),
    );
    expect(out).toEqual({ status: 'saved', name: 'brief (2).txt' });
    expect(b.inbox.entries.get('brief.txt')?.kind).toBe('symlink');
    expect(b.inbox.writes).not.toContain('brief.txt');
  });

  // IR (Fable) L1: the nonce is recorded when the save is applied, before the fetch. A fetch that then
  // fails leaves the nonce used: the same signed object is refused on a retry (the owner signs again).
  it('a fetch that fails after apply burns the nonce: retrying the same object is refused', async () => {
    const { a, b } = await agents();
    const envelopeId = await send(a, b, 'brief.txt', 1_000);
    const signedSave = await signBody(await prepared(b, `${envelopeId}.00`));
    const platform = b.platform as { inbox: (folder: string) => Promise<unknown> };
    const inbox = platform.inbox;
    platform.inbox = () => Promise.reject(new Error('inbox gone'));
    expect(await b.client.saveReceivedFile(signedSave)).toEqual({
      status: 'failed',
      code: 'inbox_unavailable',
    });
    platform.inbox = inbox;
    expect((await nonceRows(b)).length).toBe(1);
    expect(await b.client.saveReceivedFile(signedSave)).toEqual({
      status: 'refused',
      reason: 'nonce_used',
    });
    expect(b.inbox.files().size).toBe(0);
    // A fresh signature saves it.
    const again = await b.client.saveReceivedFile(
      await signBody(await prepared(b, `${envelopeId}.00`)),
    );
    expect(again).toEqual({ status: 'saved', name: 'brief.txt' });
  });

  // IR (Fable): a replayed owner signature never saves twice. The same signed object sent twice at
  // once: one copy, one nonce row; the loser is answered already_saved (serialised) and never applied.
  it('the same signed save sent twice at once writes one copy and burns one nonce', async () => {
    const { a, b } = await agents();
    const envelopeId = await send(a, b, 'brief.txt', 50_000);
    const signedSave = await signBody(await prepared(b, `${envelopeId}.00`));
    const outs = await Promise.all([
      b.client.saveReceivedFile(signedSave),
      b.client.saveReceivedFile(signedSave),
    ]);
    expect(outs).toEqual([{ status: 'saved', name: 'brief.txt' }, { status: 'already_saved' }]);
    expect([...b.inbox.files().keys()]).toEqual(['brief.txt']);
    expect((await nonceRows(b)).length).toBe(1);
  });

  // IR (Fable) L2: saves of one item are serialised: two at once yield one copy; the second waits
  // and is answered already_saved.
  it('two concurrent saves of the same file write one copy; the second is already_saved', async () => {
    const { a, b } = await agents();
    const envelopeId = await send(a, b, 'brief.txt', 50_000);
    const first = await signBody(await prepared(b, `${envelopeId}.00`));
    const second = await signBody(await prepared(b, `${envelopeId}.00`));
    const outs = await Promise.all([
      b.client.saveReceivedFile(first),
      b.client.saveReceivedFile(second),
    ]);
    expect(outs).toEqual([{ status: 'saved', name: 'brief.txt' }, { status: 'already_saved' }]);
    expect([...b.inbox.files().keys()]).toEqual(['brief.txt']);
    expect((await nonceRows(b)).length).toBe(1);
  });
});
