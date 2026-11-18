// W4-PAUSE x W4-AUTO-SAVE (D-143 (5), D-142; 06 §6 "Paused agents", 08 §1 "What stops": saving
// received files automatically waits until resume). Every client's auto-save reads the agent's own
// pause row by default (no runtime wiring can forget it), fail closed: an unreadable row counts as
// paused. A runtime that passes its own `autoSavePause` replaces it (K3's tests do).
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
} from '../testing/files.js';
import { newNonce, ownerHex, signWith } from '../testing/owner.js';

const ownerA = new MemoryOwnerKeyStore(seed(311), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(312), passphrase());

async function world() {
  const clock = new FakeClock();
  const own = new MemoryOwnStorage();
  const a = await openFileAgent(clock, new MemoryKeyStore(seed(111)), ownerA, 'alice', {
    relays: ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'],
    own,
  });
  const b = await openFileAgent(clock, new MemoryKeyStore(seed(112)), ownerB, 'bob', {
    relays: ['wss://one.relay-beta.net', 'wss://two.relay-beta.net'],
    own,
  });
  await pairForFiles(clock, a, b);
  const sent = await a.client.sendMessage({
    to: b.id,
    text: 'file',
    files: [outgoing('brief.txt', fileBytes(64))],
  });
  if (sent.status !== 'ok') throw new Error('not sent');
  await deliver(a, b);
  return { a, b, clock };
}

describe('auto-save follows the agent pause by default (W4-PAUSE)', () => {
  it('paused: nothing is downloaded or written; after a verified resume the file is saved', async () => {
    const w = await world();
    expect(await w.b.client.pause.pause()).toBe('paused');
    expect((await w.b.client.autoSave.run()).saved).toBe(0);
    expect(w.b.inbox.created).toEqual([]);

    const resume = await signWith(ownerB, {
      v: 1,
      agent: w.b.id,
      owner: await ownerHex(ownerB),
      op: 'agent.resume',
      params: { agent: w.b.id },
      nonce: newNonce(),
      issuedAt: w.clock.t,
      expiresAt: w.clock.t + 600,
    });
    expect((await w.b.client.ownerActions.apply(resume)).status).toBe('applied');
    expect((await w.b.client.autoSave.run()).saved).toBe(1);
    expect([...w.b.inbox.files().keys()]).toEqual(['brief.txt']);
  });

  it('fails closed: a pause row that cannot be read saves nothing', async () => {
    const w = await world();
    // The pause row cannot be read (a damaged or busy store): AgentPause reads `unreadable`.
    (w.b.client.pause as unknown as { read: () => Promise<unknown> }).read = () =>
      Promise.resolve({ status: 'unreadable' });
    expect((await w.b.client.autoSave.run()).saved).toBe(0);
    expect(w.b.inbox.created).toEqual([]);
  });
});

describe('SEC-RESTORE-GUARD: a file sent before a restore is not saved automatically', () => {
  it('it waits for Save; a file sent after the restore is saved', async () => {
    const clock = new FakeClock();
    const own = new MemoryOwnStorage();
    const restoredAt = { value: 0 };
    const a = await openFileAgent(clock, new MemoryKeyStore(seed(121)), ownerA, 'alice', {
      relays: ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'],
      own,
    });
    const b = await openFileAgent(clock, new MemoryKeyStore(seed(122)), ownerB, 'bob', {
      relays: ['wss://one.relay-beta.net', 'wss://two.relay-beta.net'],
      own,
      restoreMark: { read: () => Promise.resolve(restoredAt.value) },
    });
    await pairForFiles(clock, a, b);
    const early = await a.client.sendMessage({
      to: b.id,
      text: 'before',
      files: [outgoing('before.txt', fileBytes(64))],
    });
    if (early.status !== 'ok') throw new Error('not sent');
    clock.t += 3_600;
    restoredAt.value = clock.t;
    await deliver(a, b);
    expect((await b.client.autoSave.run()).saved).toBe(0);
    expect(b.inbox.created).toEqual([]);
    clock.t += 3_600;
    const late = await a.client.sendMessage({
      to: b.id,
      text: 'after',
      files: [outgoing('after.txt', fileBytes(64))],
    });
    if (late.status !== 'ok') throw new Error('not sent');
    await deliver(a, b);
    expect((await b.client.autoSave.run()).saved).toBe(1);
    expect([...b.inbox.files().keys()]).toEqual(['after.txt']);
  });
});
