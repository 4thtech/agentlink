// MSG-FILES-IO-b: where a fetched file was saved (07 §3 `files.saved_name`, store schema 6).
// - After the quarantine file is renamed, fetchFile records the single final name it chose inside
//   the Inbox folder, sealed like `name` (store key, AAD bound to table, column and row key). Never
//   a path, never the sender's raw name, never logged (I-5, I-7, 04 §4).
// - A refused or failed fetch records nothing; a row stored before version 6 reads null.
// - Retention still deletes the whole row, so no file key and no saved name stays readable.
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { createLogger } from '@4thtech-io/log';
import type { Policy } from '@4thtech-io/types';
import { describe, expect, it } from 'vitest';
import type { CoreContext } from '../context.js';
import type { JsonObject } from '@4thtech-io/types';
import { rowKeyOf } from '../store/store.js';
import type { Sealed } from '../store/schema.js';
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
import { savedNameOf } from './received.js';

const RELAYS_A = Object.freeze(['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net']);
const RELAYS_B = Object.freeze(['wss://one.relay-beta.net', 'wss://two.relay-beta.net']);
const ownerA = new MemoryOwnerKeyStore(seed(261), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(262), passphrase());
const DAY = 86_400;

let clock: FakeClock;
let own: MemoryOwnStorage;
let a: FileAgent;
let b: FileAgent;

async function agents(edit: (p: Policy) => void = () => {}): Promise<void> {
  clock = new FakeClock();
  own = new MemoryOwnStorage();
  a = await openFileAgent(clock, new MemoryKeyStore(seed(61)), ownerA, 'alice', {
    relays: RELAYS_A,
    own,
  });
  b = await openFileAgent(clock, new MemoryKeyStore(seed(62)), ownerB, 'bob', {
    relays: RELAYS_B,
    own,
  });
  await pairForFiles(clock, a, b, edit);
}

async function send(size: number, name = 'report.pdf'): Promise<string> {
  const sent = await a.client.sendMessage({
    to: b.id,
    text: 'file',
    files: [outgoing(name, fileBytes(size))],
  });
  expect(sent.status).toBe('ok');
  if (sent.status !== 'ok') throw new Error('not sent');
  await deliver(a, b);
  return sent.envelopeId;
}

const ctxOf = (agent: FileAgent): CoreContext => ({
  keyStore: agent.keyStore,
  store: agent.store,
  cipher: agent.cipher,
  now: clock.now,
  log: createLogger({ name: 'core', level: 'error', sink: () => undefined }),
});

const rowOf = (agent: FileAgent, envelopeId: string, idx = 0) =>
  agent.store.transaction((tx) => tx.get('files', { envelope_id: envelopeId, idx }));

/** The raw stored column, as the row holds it (sealed or null). */
async function rawSavedName(agent: FileAgent, envelopeId: string): Promise<unknown> {
  const row = (await rowOf(agent, envelopeId)) as Record<string, unknown> | undefined;
  return row?.['saved_name'];
}

/** Rewrites the stored payload of a received envelope, as a hostile sender's core would send it. */
async function editPayload(
  agent: FileAgent,
  envelopeId: string,
  edit: (payload: JsonObject) => void,
): Promise<void> {
  const context = { table: 'envelopes' as const, column: 'payload_json', rowKey: rowKeyOf([envelopeId]) };
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

describe('files.saved_name: the name fetchFile chose, sealed (MSG-FILES-IO-b)', () => {
  it.each([
    ['stored', 50_000],
    ['inline', 1_000],
  ])('a %s file: the final name is recorded sealed, never in plain text', async (_kind, size) => {
    await agents();
    const envelopeId = await send(size);
    // Ingest alone saves nothing: "not saved yet".
    expect(await rawSavedName(b, envelopeId)).toBeNull();
    const row0 = await rowOf(b, envelopeId);
    expect(await savedNameOf(ctxOf(b), row0!)).toBeNull();

    const fetched = await b.client.fetchFile({ envelopeId });
    expect(fetched).toMatchObject({ status: 'ok', name: 'report.pdf' });

    const raw = await rawSavedName(b, envelopeId);
    expect(typeof raw).toBe('string');
    expect(raw).toMatch(/^test-sealed:/);
    expect(raw).not.toContain('report.pdf');
    // Bound to its own column and row: it opens as `saved_name` of (envelope, 0) only.
    expect(
      await b.cipher.open(
        { table: 'files', column: 'saved_name', rowKey: rowKeyOf([envelopeId, 0]) },
        raw as Sealed,
      ),
    ).toBe('report.pdf');
    await expect(
      b.cipher.open(
        { table: 'files', column: 'name', rowKey: rowKeyOf([envelopeId, 0]) },
        raw as Sealed,
      ),
    ).rejects.toThrow();
    expect(await savedNameOf(ctxOf(b), (await rowOf(b, envelopeId))!)).toBe('report.pdf');
  });

  it('records the single name the core chose (sanitised, suffixed), never the path or the sender name', async () => {
    await agents();
    const envelopeId = await send(500);
    await editPayload(b, envelopeId, (p) => {
      ((p.files as JsonObject[])[0] as JsonObject).name = '../../.ssh/authorized_keys';
    });
    b.inbox.plantSymlink('authorized_keys');
    const fetched = await b.client.fetchFile({ envelopeId });
    expect(fetched).toMatchObject({ status: 'ok', name: 'authorized_keys (1)' });
    if (fetched.status !== 'ok') return;
    const saved = await savedNameOf(ctxOf(b), (await rowOf(b, envelopeId))!);
    expect(saved).toBe(fetched.name);
    expect(saved).not.toContain('/');
    expect(saved).not.toContain('\\');
    expect(saved).not.toBe(fetched.savedTo);
    expect([...b.inbox.files().keys()]).toContain(saved);
  });

  it('a second fetch records the newest saved name', async () => {
    await agents();
    const envelopeId = await send(500);
    await b.client.fetchFile({ envelopeId });
    const second = await b.client.fetchFile({ envelopeId });
    expect(second).toMatchObject({ status: 'ok', name: 'report (1).pdf' });
    expect(await savedNameOf(ctxOf(b), (await rowOf(b, envelopeId))!)).toBe('report (1).pdf');
  });

  it('a failed download records nothing', async () => {
    await agents();
    const envelopeId = await send(150_000);
    own.alter = 'flip';
    expect(await b.client.fetchFile({ envelopeId })).toEqual({
      status: 'rejected',
      code: 'INTEGRITY_FAILED',
    });
    expect(await rawSavedName(b, envelopeId)).toBeNull();
  });

  it('a refused fetch (size above the policy cap, expired link) records nothing', async () => {
    await agents();
    const big = await send(30_000);
    await editPayload(b, big, (p) => {
      ((p.files as JsonObject[])[0] as JsonObject).size = 300 * 1024 * 1024;
    });
    expect(await b.client.fetchFile({ envelopeId: big })).toEqual({
      status: 'rejected',
      code: 'FILE_TOO_LARGE',
    });
    expect(await rawSavedName(b, big)).toBeNull();

    const late = await send(30_000);
    clock.t += 8 * DAY;
    expect(await b.client.fetchFile({ envelopeId: late })).toEqual({
      status: 'rejected',
      code: 'LINK_EXPIRED',
    });
    // Retention may have removed the row already; either way nothing was recorded.
    expect([null, undefined]).toContain(await rawSavedName(b, late));
  });

  it('never reaches a log line', async () => {
    await agents();
    const envelopeId = await send(500, 'SAVED-NAME-CANARY.pdf');
    await b.client.fetchFile({ envelopeId });
    expect(await savedNameOf(ctxOf(b), (await rowOf(b, envelopeId))!)).toBe(
      'SAVED-NAME-CANARY.pdf',
    );
    for (const line of [...a.lines, ...b.lines]) expect(line).not.toContain('SAVED-NAME-CANARY');
  });

  it('retention at expiry deletes the row with its file key and saved name; fetch then finds nothing to open', async () => {
    await agents();
    const envelopeId = await send(50_000);
    await b.client.fetchFile({ envelopeId });
    expect(await rawSavedName(b, envelopeId)).toMatch(/^test-sealed:/);
    clock.t += 7 * DAY;
    expect(await b.client.deleteExpiredFiles()).toEqual({ deleted: 1, failed: 0 });
    expect(await rowOf(b, envelopeId)).toBeUndefined();
    expect(await b.client.fetchFile({ envelopeId })).toEqual({
      status: 'rejected',
      code: 'LINK_EXPIRED',
    });
    // The next pass keeps working.
    expect(await b.client.deleteExpiredFiles()).toEqual({ deleted: 0, failed: 0 });
  });
});
