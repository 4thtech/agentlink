// RET-3 (S2; D-148; 04 §4.2; 07 §3.8): the owner's history delete.
// - plan → apply: a plan lists what goes (counts and sizes) and what is kept; apply refuses a plan
//   whose item set changed in between (the gesture binds the exact list).
// - Messages become tombstones (`deleted_at`, no body, no ciphertext unless protected) and every
//   read treats them as absent; a relay replay of a deleted envelope is dropped, it never comes back.
// - Protected classes are kept with a fixed reason: pairing and card-update, a pending approval or a
//   live commitment, the outbox, terms, unprocessed rows. Notarized messages keep their ciphertext.
// - The safety code still recomputes after a delete.
// - Saved files go to the (fake) OS Trash only when the platform confirms they are unchanged; a row
//   with no recorded device or inode, a link, a changed or missing file is never touched.
// - Nothing about a deleted item reaches a log line: no name, no path, no text (I-7).
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { unwrapGiftWrap } from '@4thtech-io/transport-nostr';
import { encodeHex, type EnvelopeKeys } from '@4thtech-io/crypto';
import { describe, expect, it } from 'vitest';
import { CoreError } from '../errors.js';
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
const ownerA = new MemoryOwnerKeyStore(seed(361), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(362), passphrase());
const MARKER = 'RET3-SECRET-CONTENT-77';
const TEXT = 'RET3-SECRET-TEXT-55';

interface World {
  a: FileAgent;
  b: FileAgent;
  clock: FakeClock;
}

async function world(): Promise<World> {
  const clock = new FakeClock();
  const own = new MemoryOwnStorage();
  const a = await openFileAgent(clock, new MemoryKeyStore(seed(151)), ownerA, 'alice', {
    relays: RELAYS_A,
    own,
  });
  const b = await openFileAgent(clock, new MemoryKeyStore(seed(152)), ownerB, 'bob', {
    relays: RELAYS_B,
    own,
  });
  await pairForFiles(clock, a, b);
  return { a, b, clock };
}

/** A sends B a message (with a file when named); B receives it. */
async function send(w: World, name?: string, size = 3_000): Promise<string> {
  w.clock.t += 1;
  const sent = await w.a.client.sendMessage({
    to: w.b.id,
    text: TEXT,
    ...(name === undefined ? {} : { files: [outgoing(name, fileBytes(size, MARKER))] }),
  });
  if (sent.status !== 'ok') throw new Error('not sent');
  await deliver(w.a, w.b);
  return sent.envelopeId;
}

async function saved(w: World, name: string, size = 3_000): Promise<string> {
  const envelopeId = await send(w, name, size);
  expect(await w.b.client.fetchFile({ envelopeId })).toMatchObject({ status: 'ok' });
  return envelopeId;
}

const row = (agent: FileAgent, envelopeId: string) =>
  agent.store.transaction((tx) => tx.get('envelopes', { envelope_id: envelopeId }));

const inboxIds = async (w: World): Promise<string[]> => {
  const page = await w.b.client.messages.list(w.a.id, 'in', { limit: 50 });
  return page.items.map((m) => m.id);
};

describe('plan, then apply (RET-3, 04 §4.2)', () => {
  it('plans by contact: counts, sizes, kept pairing rows; apply tombstones the messages', async () => {
    const w = await world();
    const one = await send(w);
    const two = await saved(w, 'plan.pdf');
    const plan = await w.b.client.history.plan({ contactId: w.a.id, include: 'messages' });
    expect(plan.include).toBe('messages');
    expect(plan.messages.count).toBe(2);
    expect(plan.messages.bytes).toBeGreaterThan(0);
    expect(plan.files.count).toBe(0);
    expect(plan.kept.count).toBeGreaterThan(0);
    expect(plan.kept.by.pairing).toBeGreaterThan(0);
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);

    const result = await w.b.client.history.apply(plan);
    expect(result.messages.deleted).toBe(2);
    for (const id of [one, two]) {
      const r = await row(w.b, id);
      expect(r).toMatchObject({ payload_json: null, envelope_json: null });
      expect(r?.deleted_at).toBe(w.clock.t);
    }
    // The receiver's files row (the file key) goes with the message.
    expect(await w.b.store.transaction((tx) => tx.count('files', { envelope_id: two }))).toBe(0);
    // Messages only: the saved file stays where it is.
    expect(w.b.inbox.files().has('plan.pdf')).toBe(true);
    expect(w.b.inbox.trashCalls).toBe(0);
  });

  it('plans by envelope IDs and by age; unknown and already deleted IDs are ignored', async () => {
    const w = await world();
    const old = await send(w);
    w.clock.t += 1_000;
    const cut = w.clock.t;
    const fresh = await send(w);
    const byAge = await w.b.client.history.plan({ before: cut, include: 'messages' });
    expect(byAge.envelopeIds).toEqual([old]);
    await w.b.client.history.apply(byAge);
    const byIds = await w.b.client.history.plan({
      envelopeIds: [old, fresh, 'ffffffffffffffffffffffffffffffff'],
      include: 'messages',
    });
    expect(byIds.envelopeIds).toEqual([fresh]);
  });

  it('RET-4: plans one person older than a time (contact and age together)', async () => {
    const w = await world();
    const old = await send(w);
    w.clock.t += 1_000;
    const cut = w.clock.t;
    await send(w);
    const plan = await w.b.client.history.plan({
      contactId: w.a.id,
      before: cut,
      include: 'messages',
    });
    expect(plan.envelopeIds).toEqual([old]);
    const nobody = await w.b.client.history.plan({
      contactId: `0x${'c'.repeat(40)}`,
      before: cut,
      include: 'messages',
    });
    expect(nobody.envelopeIds).toEqual([]);
    const result = await w.b.client.history.apply(plan);
    expect(result.messages.deleted).toBe(1);
  });

  it('refuses a plan whose item set changed in between', async () => {
    const w = await world();
    await send(w);
    const plan = await w.b.client.history.plan({ contactId: w.a.id, include: 'messages' });
    await send(w);
    await expect(w.b.client.history.apply(plan)).rejects.toMatchObject({
      code: 'history_plan_changed',
    });
    await expect(w.b.client.history.apply(plan)).rejects.toBeInstanceOf(CoreError);
  });

  it('refuses invalid input with a fixed code', async () => {
    const w = await world();
    for (const bad of [
      {},
      { contactId: w.a.id, include: 'all' },
      { before: -1, include: 'messages' },
      { envelopeIds: 'x', include: 'files' },
      { envelopeIds: ['x'], contactId: w.a.id, include: 'messages' },
      { envelopeIds: ['x'], before: 5, include: 'messages' },
      { contactId: w.a.id, before: -1, include: 'messages' },
    ]) {
      await expect(w.b.client.history.plan(bad as never)).rejects.toMatchObject({
        code: 'history_input_invalid',
      });
    }
  });
});

describe('reads skip tombstones (07 §3.8)', () => {
  it('Messages, inbox items, unread counts and Activity no longer show a deleted message', async () => {
    const w = await world();
    const gone = await send(w);
    const kept = await send(w);
    expect(await inboxIds(w)).toContain(gone);
    await w.b.client.history.delete({ envelopeIds: [gone], include: 'messages' });
    expect(await inboxIds(w)).toEqual([kept]);
    expect((await w.b.client.inbox.items([gone, kept])).map((i) => i.envelopeId)).toEqual([kept]);
    const counts = await w.b.client.inbox.counts();
    expect(counts.inbox.find((c) => c.contactId === w.a.id)?.unread).toBe(1);
    const activity = await w.b.client.activity.list({ limit: 100 });
    expect(JSON.stringify(activity)).not.toContain(gone);
    expect((await w.b.client.messages.conversations()).length).toBeGreaterThan(0);
  });
});

describe('a relay replay of a deleted envelope is dropped (04 §3.1.1 step 9)', () => {
  it('the same wrap again, after the seen-set forgot it, does not bring the message back', async () => {
    const w = await world();
    const gone = await send(w);
    const key = encodeHex((await w.b.keyStore.getPublicBundle()).agentNostr);
    const wrap = [...w.a.spy.published]
      .reverse()
      .find((p) => p.event.tags.some((t) => t[0] === 'p' && t[1] === key));
    if (wrap === undefined) throw new Error('no wrap');
    await w.b.client.history.delete({ envelopeIds: [gone], include: 'messages' });
    // The seen-set saves work only; drop it, as its retention would after 30 days.
    await w.b.store.transaction((tx) => tx.delete('seen', {}));
    const opened = await unwrapGiftWrap(wrap.event, w.b.keyStore as EnvelopeKeys);
    const received = await w.b.client.envelopes.receive({
      envelope: opened.envelope,
      giftWrapId: opened.giftWrapId,
    });
    expect(received.report.outcome).toBe('duplicate');
    await w.b.client.envelopes.processReceived();
    const r = await row(w.b, gone);
    expect(r).toMatchObject({ payload_json: null, envelope_json: null, state: 'ok' });
    expect(r?.deleted_at).not.toBeNull();
    expect(await inboxIds(w)).not.toContain(gone);
  });
});

describe('the safety code still recomputes (04 §3.6.1)', () => {
  it('a delete of a whole conversation keeps the pairing messages and the same digest', async () => {
    const w = await world();
    await send(w);
    const before = await w.b.client.contacts.currentPairingDigest(w.a.id);
    expect(before).toMatchObject({ status: 'ok' });
    await w.b.client.history.delete({ contactId: w.a.id, include: 'both' });
    expect(await w.b.client.contacts.currentPairingDigest(w.a.id)).toEqual(before);
    const pairingRows = await w.b.store.transaction((tx) =>
      tx.select('envelopes', { type: { in: ['handshake', 'handshake-ack', 'card-update'] } }),
    );
    expect(pairingRows.length).toBeGreaterThan(0);
    for (const r of pairingRows) expect(r.deleted_at).toBeNull();
  });
});

describe('protected classes are kept with a fixed reason (04 §4.2)', () => {
  it('a pending approval, a live commitment part, the outbox and terms are refused', async () => {
    const w = await world();
    const approval = await send(w);
    const part = await send(w);
    const terms = await send(w);
    const free = await send(w);
    // B sends A a message that is still in B's outbox.
    w.clock.t += 1;
    const out = await w.b.client.sendMessage({ to: w.a.id, text: TEXT });
    if (out.status !== 'ok') throw new Error('not sent');
    const at = (column: string) =>
      w.b.cipher.seal({ table: 'approvals', column, rowKey: '["appr-ret3-1"]' }, '{}');
    const action = await at('action_json');
    const summary = await at('summary');
    await w.b.store.transaction((tx) => {
      tx.insert('approvals', {
        approval_id: 'appr-ret3-1',
        action_json: action,
        scope_json: null,
        answers_envelope_id: approval,
        scope_key: null,
        source: 'owner',
        policy_hash: null,
        signed_decision: null,
        signed_cancel: null,
        summary,
        status: 'pending',
        expires_at: w.clock.t + 600,
        created_at: w.clock.t,
        decided_at: null,
      });
      tx.insert('commitment_parts', {
        approval_id: 'appr-ret3-2',
        part: 'envelope',
        state: 'unclaimed',
        item_ref: part,
        item_json: null,
        ledger_entry_id: null,
        void_reason: null,
        replacements: 0,
        claimed_at: null,
        done_at: null,
        updated_at: w.clock.t,
      });
      tx.update('envelopes', { envelope_id: terms }, { type: 'offer' });
      tx.update('outbox', { envelope_id: out.envelopeId }, { state: 'pending' });
    });

    const plan = await w.b.client.history.plan({
      envelopeIds: [approval, part, terms, free, out.envelopeId],
      include: 'both',
    });
    expect(plan.envelopeIds).toEqual([free]);
    expect(plan.kept.count).toBe(4);
    expect(plan.kept.by).toMatchObject({ approval: 2, terms: 1, outbox: 1 });
    const result = await w.b.client.history.apply(plan);
    expect(result.messages.deleted).toBe(1);
    for (const id of [approval, part, terms, out.envelopeId]) {
      expect((await row(w.b, id))?.deleted_at).toBeNull();
      expect((await row(w.b, id))?.payload_json).not.toBeNull();
    }
  });

  it('a row that became protected between plan and apply is kept, never half deleted', async () => {
    const w = await world();
    const id = await send(w);
    const plan = await w.b.client.history.plan({ envelopeIds: [id], include: 'messages' });
    await w.b.store.transaction((tx) => {
      tx.insert('commitment_parts', {
        approval_id: 'appr-ret3-3',
        part: 'envelope',
        state: 'claimed',
        item_ref: id,
        item_json: null,
        ledger_entry_id: null,
        void_reason: null,
        replacements: 0,
        claimed_at: w.clock.t,
        done_at: null,
        updated_at: w.clock.t,
      });
    });
    // The item set is the same (the protection is re-checked inside the transaction).
    await expect(w.b.client.history.apply(plan)).rejects.toMatchObject({
      code: 'history_plan_changed',
    });
    expect((await row(w.b, id))?.deleted_at).toBeNull();
  });
});

describe('saved files go to the Trash only when unchanged (OD-1, 04 §4.2)', () => {
  it('an unchanged saved file goes to the Trash and its row is marked trashed', async () => {
    const w = await world();
    const id = await saved(w, 'report.pdf');
    const plan = await w.b.client.history.plan({ envelopeIds: [id], include: 'files' });
    expect(plan.files).toEqual({ count: 1, bytes: 3_000 });
    expect(plan.messages.count).toBe(0);
    const result = await w.b.client.history.apply(plan);
    expect(result.files).toMatchObject({ trashed: 1, changed: 0, refused: 0 });
    expect(w.b.inbox.trashed).toEqual(['report.pdf']);
    expect(w.b.inbox.files().has('report.pdf')).toBe(false);
    const index = await w.b.store.transaction((tx) =>
      tx.get('saved_files', { envelope_id: id, idx: 0 }),
    );
    expect(index?.trashed_at).toBe(w.clock.t);
    // Files only: the message stays.
    expect((await row(w.b, id))?.deleted_at).toBeNull();
    // A trashed file is not planned again.
    const again = await w.b.client.history.plan({ envelopeIds: [id], include: 'files' });
    expect(again.files.count).toBe(0);
  });

  it('a changed file is untouched (same size, other bytes)', async () => {
    const w = await world();
    const id = await saved(w, 'edited.txt', 500);
    const entry = w.b.inbox.entries.get('edited.txt')!;
    entry.data = entry.data.slice();
    entry.data[0] = (entry.data[0]! + 1) % 256;
    const result = await w.b.client.history.delete({ envelopeIds: [id], include: 'both' });
    expect(result.files).toMatchObject({ trashed: 0, changed: 1 });
    expect(w.b.inbox.files().has('edited.txt')).toBe(true);
    expect(w.b.inbox.trashed).toEqual([]);
    const index = await w.b.store.transaction((tx) =>
      tx.get('saved_files', { envelope_id: id, idx: 0 }),
    );
    expect(index?.trashed_at).toBeNull();
  });

  it('a file replaced by another file (another inode) is untouched, without asking the platform', async () => {
    const w = await world();
    const id = await saved(w, 'swap.txt', 500);
    const entry = w.b.inbox.entries.get('swap.txt')!;
    w.b.inbox.entries.set('swap.txt', { ...entry, ino: 999_999 });
    const result = await w.b.client.history.delete({ envelopeIds: [id], include: 'files' });
    expect(result.files).toMatchObject({ trashed: 0, changed: 1 });
    expect(w.b.inbox.trashCalls).toBe(0);
    expect(w.b.inbox.files().has('swap.txt')).toBe(true);
  });

  it('a symlink at the saved name is refused and left alone', async () => {
    const w = await world();
    const id = await saved(w, 'link.pdf');
    await w.b.inbox.remove('link.pdf');
    w.b.inbox.plantSymlink('link.pdf');
    const result = await w.b.client.history.delete({ envelopeIds: [id], include: 'files' });
    expect(result.files.trashed).toBe(0);
    expect(result.files.changed + result.files.missing).toBe(1);
    expect(w.b.inbox.entries.get('link.pdf')?.kind).toBe('symlink');
    expect(w.b.inbox.trashCalls).toBe(0);
  });

  it('a row with no recorded device or inode is refused (IR-RET-2-1 Low 1)', async () => {
    const w = await world();
    const id = await saved(w, 'unknown.pdf');
    await w.b.store.transaction((tx) =>
      tx.update('saved_files', { envelope_id: id, idx: 0 }, { dev: null, ino: null }),
    );
    const result = await w.b.client.history.delete({ envelopeIds: [id], include: 'files' });
    expect(result.files).toMatchObject({ trashed: 0, refused: 1 });
    expect(w.b.inbox.trashCalls).toBe(0);
    expect(w.b.inbox.files().has('unknown.pdf')).toBe(true);
  });

  it('a missing file and a platform with no Trash leave the row unmarked', async () => {
    const w = await world();
    const gone = await saved(w, 'gone.pdf');
    const stay = await saved(w, 'stay.pdf');
    await w.b.inbox.remove('gone.pdf');
    const first = await w.b.client.history.delete({ envelopeIds: [gone], include: 'files' });
    expect(first.files).toMatchObject({ trashed: 0, missing: 1 });
    w.b.inbox.nextTrashOutcome = 'no_trash';
    const second = await w.b.client.history.delete({ envelopeIds: [stay], include: 'files' });
    expect(second.files).toMatchObject({ trashed: 0, noTrash: 1 });
    expect(w.b.inbox.files().has('stay.pdf')).toBe(true);
    const rows = await w.b.store.transaction((tx) => tx.select('saved_files'));
    for (const r of rows) expect(r.trashed_at).toBeNull();
  });
});

describe('no name, path or text in logs (I-7)', () => {
  it('plan, apply and the file moves log counts and fixed codes only', async () => {
    const w = await world();
    const a = await saved(w, 'secret-name.md', 600);
    const b = await saved(w, 'changed-name.md', 600);
    w.b.inbox.entries.get('changed-name.md')!.data = new Uint8Array(600);
    w.b.lines.length = 0;
    await w.b.client.history.delete({ envelopeIds: [a, b], include: 'both' });
    const log = w.b.lines.join('\n');
    expect(log).toMatch(/history deleted/);
    for (const secret of ['secret-name', 'changed-name', INBOX, MARKER, TEXT, a, b]) {
      expect(log).not.toContain(secret);
    }
  });
});

// --- fix round 1 (IR-RET-3-1) ---------------------------------------------------------------------

/** Stores an `ack` (or a `proof`) row naming `target`, as the receive path would. */
async function plantLinked(
  w: World,
  target: string,
  n: number,
  type: 'ack' | 'proof' = 'ack',
  direction: 'in' | 'out' = 'in',
): Promise<string> {
  const base = (await row(w.b, target))!;
  const id = `ret3-${type}-${String(n)}`;
  const payload = await w.b.cipher.seal(
    { table: 'envelopes', column: 'payload_json', rowKey: JSON.stringify([id]) },
    JSON.stringify({
      type,
      body: { kind: 'received', envelopeId: target },
      replyTo: target,
      files: [],
    }),
  );
  w.clock.t += 1;
  await w.b.store.transaction((tx) =>
    tx.insert('envelopes', {
      ...base,
      envelope_id: id,
      envelope_hash: `0x${String(n).padStart(64, '0')}`,
      direction,
      type,
      created_at: w.clock.t,
      payload_json: payload,
      read_at: null,
      delivery: direction === 'out' ? 'sent' : null,
      deleted_at: null,
    }),
  );
  return id;
}

async function plantProofRow(w: World, envelopeId: string): Promise<void> {
  const salt = await w.b.cipher.seal(
    { table: 'proofs', column: 'salt', rowKey: JSON.stringify(['0xrec-ret3']) },
    '00',
  );
  await w.b.store.transaction((tx) =>
    tx.insert('proofs', {
      record_id: '0xrec-ret3',
      envelope_id: envelopeId,
      chain_id: 84532,
      record_json: '{}' as never,
      tx_hash: null,
      status: 'received',
      fee_token: null,
      fee_amount: null,
      salt,
      created_at: w.clock.t,
    }),
  );
}

describe('acks follow their message; acks and proofs of a notarized message stay (IR-RET-3-1 Low 7)', () => {
  it('deleting a message by ID also deletes the acks that name it', async () => {
    const w = await world();
    const m = await send(w);
    const ack = await plantLinked(w, m, 1, 'ack', 'out');
    const plan = await w.b.client.history.plan({ envelopeIds: [m], include: 'messages' });
    expect([...plan.envelopeIds].sort()).toEqual([m, ack].sort());
    await w.b.client.history.apply(plan);
    expect((await row(w.b, ack))?.deleted_at).not.toBeNull();
  });

  it('an ack selected on its own while its message stays is kept', async () => {
    const w = await world();
    const m = await send(w);
    const ack = await plantLinked(w, m, 2);
    const plan = await w.b.client.history.plan({ envelopeIds: [ack], include: 'messages' });
    expect(plan.envelopeIds).toEqual([]);
    expect(plan.kept.by.receipt).toBe(1);
  });

  it('by contact: the acks and proof envelopes of a notarized message are kept', async () => {
    const w = await world();
    const m = await send(w);
    const plain = await send(w);
    await plantProofRow(w, m);
    const ack = await plantLinked(w, m, 3);
    const proof = await plantLinked(w, m, 4, 'proof');
    const plainAck = await plantLinked(w, plain, 5);
    const plan = await w.b.client.history.plan({ contactId: w.a.id, include: 'messages' });
    expect(plan.envelopeIds).toEqual(expect.arrayContaining([m, plain, plainAck]));
    expect(plan.envelopeIds).not.toContain(ack);
    expect(plan.envelopeIds).not.toContain(proof);
    expect(plan.kept.by.receipt).toBe(2);
    await w.b.client.history.apply(plan);
    for (const id of [ack, proof]) expect((await row(w.b, id))?.deleted_at).toBeNull();
    expect((await row(w.b, plainAck))?.deleted_at).not.toBeNull();
  });
});

describe('a partial apply leaves no orphans (IR-RET-3-1 Low 6)', () => {
  it('files of an already deleted message can be planned and trashed later', async () => {
    const w = await world();
    const id = await saved(w, 'later.pdf');
    w.b.inbox.nextTrashOutcome = 'no_trash';
    const first = await w.b.client.history.delete({ envelopeIds: [id], include: 'both' });
    expect(first.messages.deleted).toBe(1);
    expect(first.files.noTrash).toBe(1);
    for (const input of [
      { envelopeIds: [id], include: 'files' as const },
      { contactId: w.a.id, include: 'files' as const },
      { before: w.clock.t + 1, include: 'both' as const },
    ]) {
      const plan = await w.b.client.history.plan(input);
      expect(plan.files.count).toBe(1);
      expect(plan.messages.count).toBe(0);
    }
    const second = await w.b.client.history.delete({ contactId: w.a.id, include: 'files' });
    expect(second.files.trashed).toBe(1);
    expect(w.b.inbox.trashed).toEqual(['later.pdf']);
  });
});
