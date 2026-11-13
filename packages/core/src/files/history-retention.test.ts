// RET-6 (S2; D-148; 04 §4.2 "Retention policy"; 06 §3 `history`): the daily retention pass.
// - It deletes only under a verified, owner-signed policy, with only that policy's limits, through
//   RET-3's plan and apply: saved files older than `filesKeepDays` go to the (fake) Trash; message
//   bodies older than `messagesKeepDays` become tombstones; protected items stay.
// - 0 keeps forever. A policy signed before D-148 (no `history`) reads as 0/0: nothing is deleted.
// - Fail closed: an invalid stored policy, no signed policy (the defaults), a paused ID or a store
//   that cannot be read deletes nothing.
// - Daily: a second run within 24 hours does nothing.
// - The preview (the Storage editor, before the owner signs) counts and deletes nothing.
// - Logs carry counts only (I-7).
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { describe, expect, it } from 'vitest';
import { POLICY_DEFAULTS_EFFECTIVE, type EffectivePolicy } from '../policy-engine.js';
import { mergePolicyPatch } from '../owner-prepare.js';
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
import { HISTORY_RETENTION_INTERVAL_SECONDS, historyKeepOf } from './retention.js';
import { defaultPolicy, type Policy } from '@4thtech-io/types';

const DAY = 86_400;
const RELAYS_A = Object.freeze(['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net']);
const RELAYS_B = Object.freeze(['wss://one.relay-beta.net', 'wss://two.relay-beta.net']);
const ownerA = new MemoryOwnerKeyStore(seed(381), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(382), passphrase());
const NAME = 'RET6-SECRET-NAME.pdf';
const TEXT = 'RET6-SECRET-TEXT-31';

interface World {
  a: FileAgent;
  b: FileAgent;
  clock: FakeClock;
}

async function world(edit: (p: Policy) => void): Promise<World> {
  const clock = new FakeClock();
  const own = new MemoryOwnStorage();
  const a = await openFileAgent(clock, new MemoryKeyStore(seed(171)), ownerA, 'alice', {
    relays: RELAYS_A,
    own,
  });
  const b = await openFileAgent(clock, new MemoryKeyStore(seed(172)), ownerB, 'bob', {
    relays: RELAYS_B,
    own,
  });
  await pairForFiles(clock, a, b, edit);
  return { a, b, clock };
}

const keep =
  (messagesKeepDays: number, filesKeepDays: number) =>
  (p: Policy): void => {
    (p as { history?: unknown }).history = { messagesKeepDays, filesKeepDays };
  };

/** A sends B a message with a file; B saves it. */
async function savedFile(w: World, name = NAME): Promise<string> {
  w.clock.t += 1;
  const sent = await w.a.client.sendMessage({
    to: w.b.id,
    text: TEXT,
    files: [outgoing(name, fileBytes(3_000, TEXT))],
  });
  if (sent.status !== 'ok') throw new Error('not sent');
  await deliver(w.a, w.b);
  expect(await w.b.client.fetchFile({ envelopeId: sent.envelopeId })).toMatchObject({
    status: 'ok',
  });
  return sent.envelopeId;
}

async function message(w: World): Promise<string> {
  w.clock.t += 1;
  const sent = await w.a.client.sendMessage({ to: w.b.id, text: TEXT });
  if (sent.status !== 'ok') throw new Error('not sent');
  await deliver(w.a, w.b);
  return sent.envelopeId;
}

const body = (w: World, id: string) =>
  w.b.store.transaction((tx) => tx.get('envelopes', { envelope_id: id }));

describe('the retention pass deletes only under the signed policy (RET-6)', () => {
  it('files 30 days: older saved files go to the Trash; younger ones and messages stay', async () => {
    const w = await world(keep(0, 30));
    const old = await savedFile(w, 'old.pdf');
    w.clock.t += 20 * DAY;
    await savedFile(w, 'young.pdf');
    w.clock.t += 11 * DAY;
    const outcome = await w.b.client.historyRetention.run();
    expect(outcome).toMatchObject({ status: 'ran', files: 1, messages: 0 });
    expect(w.b.inbox.trashed).toEqual(['old.pdf']);
    expect(w.b.inbox.files().has('young.pdf')).toBe(true);
    // Files only: the message itself stays readable.
    expect((await body(w, old))?.deleted_at).toBeNull();
  });

  it('messages 90 days: older bodies become tombstones; pairing rows are kept', async () => {
    const w = await world(keep(90, 0));
    const old = await message(w);
    const withFile = await savedFile(w, 'kept.pdf');
    w.clock.t += 91 * DAY;
    const young = await message(w);
    const outcome = await w.b.client.historyRetention.run();
    expect(outcome).toMatchObject({ status: 'ran', files: 0 });
    expect(outcome.status === 'ran' && outcome.messages).toBe(2);
    expect(await body(w, old)).toMatchObject({ payload_json: null });
    expect((await body(w, old))?.deleted_at).not.toBeNull();
    expect((await body(w, withFile))?.deleted_at).not.toBeNull();
    expect((await body(w, young))?.deleted_at).toBeNull();
    // filesKeepDays 0: the saved file is not touched.
    expect(w.b.inbox.files().has('kept.pdf')).toBe(true);
    expect(w.b.inbox.trashCalls).toBe(0);
    // Pairing rows are protected (the safety code is recomputed from them).
    const pairing = await w.b.store.transaction((tx) =>
      tx.select('envelopes', { type: { in: ['handshake', 'handshake-ack'] } }),
    );
    expect(pairing.length).toBeGreaterThan(0);
    for (const r of pairing) expect(r.deleted_at).toBeNull();
  });

  it('0 and 0 keeps everything', async () => {
    const w = await world(keep(0, 0));
    const old = await savedFile(w);
    w.clock.t += 4_000 * DAY;
    expect(await w.b.client.historyRetention.run()).toMatchObject({
      status: 'skipped',
      reason: 'off',
    });
    expect((await body(w, old))?.deleted_at).toBeNull();
    expect(w.b.inbox.trashCalls).toBe(0);
  });

  it('a policy signed before D-148 (no history) reads as keep forever: nothing is deleted', async () => {
    const w = await world((p) => {
      delete (p as { history?: unknown }).history;
    });
    const old = await savedFile(w);
    w.clock.t += 4_000 * DAY;
    expect(await w.b.client.historyRetention.run()).toMatchObject({
      status: 'skipped',
      reason: 'off',
    });
    expect((await body(w, old))?.deleted_at).toBeNull();
    expect(w.b.inbox.trashCalls).toBe(0);
  });
});

describe('fail closed: nothing is deleted (RET-6, 04 §4.2)', () => {
  it('an invalid stored policy deletes nothing', async () => {
    const w = await world(keep(90, 30));
    const old = await savedFile(w);
    await w.b.store.transaction((tx) => {
      for (const row of tx.select('policies')) {
        tx.update('policies', { slot: row.slot }, { version: row.version + 7 });
      }
    });
    expect((await w.b.client.ownerActions.loadPolicy()).mode).toBe('fail_closed');
    w.clock.t += 400 * DAY;
    expect(await w.b.client.historyRetention.run()).toMatchObject({
      status: 'skipped',
      reason: 'policy_not_signed',
    });
    expect((await body(w, old))?.deleted_at).toBeNull();
    expect(w.b.inbox.trashCalls).toBe(0);
  });

  it('a paused ID deletes nothing', async () => {
    const w = await world(keep(90, 30));
    const old = await savedFile(w);
    await w.b.client.pause.pause();
    w.clock.t += 400 * DAY;
    expect(await w.b.client.historyRetention.run()).toMatchObject({
      status: 'skipped',
      reason: 'paused',
    });
    expect((await body(w, old))?.deleted_at).toBeNull();
    expect(w.b.inbox.trashCalls).toBe(0);
  });

  it('the defaults (no signed policy yet) and fail closed give no limits', () => {
    expect(historyKeepOf(POLICY_DEFAULTS_EFFECTIVE)).toBeUndefined();
    const closed: EffectivePolicy = { mode: 'fail_closed', problem: 'invalid' };
    expect(historyKeepOf(closed)).toBeUndefined();
    const signed: EffectivePolicy = { mode: 'signed', version: 3, policy: defaultPolicy() };
    expect(historyKeepOf(signed)).toEqual({ messagesKeepDays: 0, filesKeepDays: 90 });
    const old = defaultPolicy() as Partial<Policy>;
    delete old.history;
    expect(historyKeepOf({ mode: 'signed', version: 2, policy: old as Policy })).toEqual({
      messagesKeepDays: 0,
      filesKeepDays: 0,
    });
    // A value outside the 06 §3 list is never used (the stored policy would not verify anyway).
    const odd = { ...defaultPolicy(), history: { messagesKeepDays: 1, filesKeepDays: 1 } };
    expect(historyKeepOf({ mode: 'signed', version: 2, policy: odd as Policy })).toBeUndefined();
  });

  it('a store that cannot be read deletes nothing and does not throw', async () => {
    const w = await world(keep(90, 30));
    await savedFile(w);
    w.clock.t += 400 * DAY;
    const original = w.b.store.transaction.bind(w.b.store);
    (w.b.store as { transaction: unknown }).transaction = () =>
      Promise.reject(new Error('disk gone'));
    const outcome = await w.b.client.historyRetention.run();
    (w.b.store as { transaction: unknown }).transaction = original;
    // An unreadable pause row counts as paused; either way nothing ran.
    expect(outcome.status).toBe('skipped');
    expect(w.b.inbox.trashCalls).toBe(0);
  });
});

describe('daily, preview and logs (RET-6)', () => {
  it('runs at most once per day', async () => {
    const w = await world(keep(0, 30));
    await savedFile(w, 'first.pdf');
    w.clock.t += 31 * DAY;
    expect((await w.b.client.historyRetention.run()).status).toBe('ran');
    expect(HISTORY_RETENTION_INTERVAL_SECONDS).toBe(DAY);
    await savedFile(w, 'second.pdf');
    // Less than a day after the last run.
    w.clock.t += DAY - 100;
    expect(await w.b.client.historyRetention.run()).toMatchObject({
      status: 'skipped',
      reason: 'not_due',
    });
    w.clock.t += 31 * DAY;
    expect((await w.b.client.historyRetention.run()).status).toBe('ran');
    expect(w.b.inbox.trashed).toEqual(['first.pdf', 'second.pdf']);
  });

  it('the preview counts what a setting would remove now and deletes nothing', async () => {
    const w = await world(keep(0, 0));
    const old = await savedFile(w);
    w.clock.t += 100 * DAY;
    const preview = await w.b.client.historyRetention.preview({
      messagesKeepDays: 90,
      filesKeepDays: 30,
    });
    expect(preview.files.count).toBe(1);
    expect(preview.files.bytes).toBe(3_000);
    expect(preview.messages.count).toBe(1);
    expect(preview.messages.bytes).toBeGreaterThan(0);
    const none = await w.b.client.historyRetention.preview({
      messagesKeepDays: 0,
      filesKeepDays: 0,
    });
    expect(none).toMatchObject({ messages: { count: 0 }, files: { count: 0 } });
    expect((await body(w, old))?.deleted_at).toBeNull();
    expect(w.b.inbox.trashCalls).toBe(0);
    await expect(
      w.b.client.historyRetention.preview({ messagesKeepDays: 1, filesKeepDays: 0 }),
    ).rejects.toMatchObject({ code: 'history_input_invalid' });
  });

  it('logs counts only: no name, text or ID', async () => {
    const w = await world(keep(90, 30));
    const id = await savedFile(w);
    w.clock.t += 100 * DAY;
    w.b.lines.length = 0;
    await w.b.client.historyRetention.run();
    const all = w.b.lines.join('\n');
    expect(all).toContain('history retention');
    for (const secret of [NAME, TEXT, id, w.a.id]) expect(all).not.toContain(secret);
  });
});

describe('a policy edit carries history (06 §3: every new policy.set has it)', () => {
  it('a base signed before D-148 gets 0/0, so an unrelated edit never starts deleting', () => {
    const base = defaultPolicy() as Partial<Policy>;
    delete base.history;
    const merged = mergePolicyPatch(base as Policy, { receipts: { autoOpened: true } });
    expect(merged.history).toEqual({ messagesKeepDays: 0, filesKeepDays: 0 });
  });

  it('a history patch on such a base sets only the named field', () => {
    const base = defaultPolicy() as Partial<Policy>;
    delete base.history;
    const merged = mergePolicyPatch(base as Policy, { history: { filesKeepDays: 90 } });
    expect(merged.history).toEqual({ messagesKeepDays: 0, filesKeepDays: 90 });
  });
});
