// W4-AUTO-SAVE (S2; D-142; 04 §4.1; 06 §2.3, §3; 08 §1; proposed, owner confirms at merge): files
// from contacts the owner keeps are saved into the Inbox folder by the core, with no tool call, within
// the limits and writing rules of 04 §4.1.
//
// - Only from a paired, active, allowed contact; never a blocked or removed contact's, never an
//   unknown sender's request, never with "Ask before saving" for that contact.
// - Rolling 24-hour limits per contact (`limit_contact`) and per agent (`limit_today`); the 1 GiB
//   free-space reserve (`disk_full`), and a write that runs out of space leaves no temporary file.
// - The quarantine mark is required for an automatic save: a failed mark removes the temporary file,
//   saves nothing (`folder_cannot_mark`) and pauses auto-save; Save still works there.
// - Not while paused; a file that arrived during a pause waits for Save after the resume.
// - Auto-save off, or a policy that is not valid: nothing saved automatically (`auto_save_off`). A
//   policy signed before D-142 (no `files.autoSave`) stays valid and reads as on.
// - One lock per file: auto-save and `agentlink_fetch_file` at once write one copy; a later fetch is
//   answered from the record.
// - Never overwrites; retries 3 times, then waits (`download_failed`).
// - Log lines carry counts and fixed codes only: never a name, folder, path or link.
// - The one-time notice: due after an update, until dismissed.
import { type JsonObject } from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import {
  AUTO_SAVE_DEFAULTS,
  defaultPolicy,
  policySchema,
  type AutoSavePolicy,
  type Policy,
} from '@4thtech-io/types';
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
  type FileAgentOptions,
} from '../testing/files.js';
import { newNonce, ownerHex, signWith } from '../testing/owner.js';
import {
  AUTO_SAVE_CONCURRENCY,
  AUTO_SAVE_RESERVE_BYTES,
  AUTO_SAVE_RETRY_DELAYS,
  type AutoSavePause,
} from './auto-save.js';

const RELAYS_A = Object.freeze(['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net']);
const RELAYS_B = Object.freeze(['wss://one.relay-beta.net', 'wss://two.relay-beta.net']);
const ownerA = new MemoryOwnerKeyStore(seed(291), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(292), passphrase());
const GiB = 1024 ** 3;

interface World {
  a: FileAgent;
  b: FileAgent;
  clock: FakeClock;
  own: MemoryOwnStorage;
}

async function world(
  receiver: Partial<FileAgentOptions> = {},
  edit: (p: Policy) => void = () => {},
): Promise<World> {
  const clock = new FakeClock();
  const own = new MemoryOwnStorage();
  const a = await openFileAgent(clock, new MemoryKeyStore(seed(91)), ownerA, 'alice', {
    relays: RELAYS_A,
    own,
  });
  const b = await openFileAgent(clock, new MemoryKeyStore(seed(92)), ownerB, 'bob', {
    relays: RELAYS_B,
    own,
    ...receiver,
  });
  await pairForFiles(clock, a, b, edit);
  return { a, b, clock, own };
}

async function send(
  from: FileAgent,
  to: FileAgent,
  name: string,
  size = 64,
  count = 1,
): Promise<string> {
  const files = Array.from({ length: count }, (_, i) =>
    outgoing(count === 1 ? name : `${String(i)}-${name}`, fileBytes(size)),
  );
  const sent = await from.client.sendMessage({ to: to.id, text: 'file', files });
  if (sent.status !== 'ok') throw new Error(`not sent: ${JSON.stringify(sent)}`);
  await deliver(from, to);
  return sent.envelopeId;
}

/** Applies a new signed policy on `agent` (version `version`). */
async function setPolicy(
  w: World,
  agent: FileAgent,
  version: number,
  edit: (p: Policy) => void,
): Promise<void> {
  const policy = defaultPolicy();
  policy.files.allowedFolders = ['~/Work'];
  edit(policy);
  const signed = await signWith(agent.owner, {
    v: 1,
    agent: agent.id,
    owner: await ownerHex(agent.owner),
    op: 'policy.set',
    params: { version, policy: policy as unknown as JsonObject },
    nonce: newNonce(),
    issuedAt: w.clock.t,
    expiresAt: w.clock.t + 600,
  });
  const applied = await agent.client.ownerActions.apply(JSON.stringify(signed));
  if (applied.status !== 'applied') throw new Error('policy not applied');
}

const withAutoSave =
  (over: Partial<AutoSavePolicy>) =>
  (p: Policy): void => {
    p.files.autoSave = { ...AUTO_SAVE_DEFAULTS, ...over };
  };

async function receivedItems(b: FileAgent) {
  return (await b.client.filesIo.received({ limit: 100 })).items;
}

describe('W4-AUTO-SAVE: what is saved, and by whom (04 §4.1)', () => {
  it('a file from a paired contact is saved with no tool call; the item reads saved by auto', async () => {
    const w = await world();
    await send(w.a, w.b, 'report.pdf');
    expect(w.b.inbox.files().size).toBe(0); // nothing before the loop runs
    const run = await w.b.client.autoSave.run();
    expect(run.saved).toBe(1);
    expect([...w.b.inbox.files().keys()]).toEqual(['report.pdf']);
    const [item] = await receivedItems(w.b);
    expect(item).toMatchObject({ state: 'saved', savedName: 'report.pdf', savedBy: 'auto' });
  });

  it('a blocked contact, a removed contact and an "Ask before saving" contact: not saved', async () => {
    const w = await world();
    await send(w.a, w.b, 'one.txt');
    await w.b.client.contacts.block(w.a.id);
    expect((await w.b.client.autoSave.run()).saved).toBe(0);
    expect(w.b.inbox.files().size).toBe(0);

    const w2 = await world({}, (p) => {
      p.contactRules = [];
    });
    await setPolicy(w2, w2.b, 2, (p) => {
      p.contactRules = [{ contact: w2.a.id, files: { askBeforeSaving: true } }];
    });
    await send(w2.a, w2.b, 'two.txt');
    expect((await w2.b.client.autoSave.run()).saved).toBe(0);
    expect(w2.b.inbox.files().size).toBe(0);
    expect((await receivedItems(w2.b))[0]).toMatchObject({
      state: 'not_saved',
      reason: 'ask_before_saving',
    });

    const w3 = await world();
    await send(w3.a, w3.b, 'three.txt');
    await w3.b.client.contacts.remove(w3.a.id);
    expect((await w3.b.client.autoSave.run()).saved).toBe(0);
    expect(w3.b.inbox.files().size).toBe(0);
  });

  it("an unknown sender's file (a queued request) is never saved automatically", async () => {
    const w = await world();
    const envelopeId = await send(w.a, w.b, 'request.txt');
    // The stored row as a queued request from an unknown key (07 §3.2) with its file pending.
    await w.b.store.transaction((tx) => {
      tx.update('envelopes', { envelope_id: envelopeId }, { state: 'request', contact_id: null });
    });
    expect((await w.b.client.autoSave.run()).saved).toBe(0);
    expect(w.b.inbox.files().size).toBe(0);
  });

  it('the sender check runs again inside the lock, right before the download', async () => {
    let blockNow: (() => Promise<void>) | undefined;
    const w = await world({ beforeInbox: async () => blockNow?.() });
    await send(w.a, w.b, 'late.txt');
    blockNow = async () => {
      blockNow = undefined;
      await w.b.client.contacts.block(w.a.id);
    };
    expect((await w.b.client.autoSave.run()).saved).toBe(0);
    expect(w.b.inbox.files().size).toBe(0);
    expect(w.b.inbox.created).toEqual([]);
  });
});

describe('W4-AUTO-SAVE: limits (04 §4.1, Decision 51)', () => {
  it('defaults: 50 files and 500 MB per contact, 200 files and 2 048 MB per agent, 1 GiB reserve', () => {
    expect(AUTO_SAVE_DEFAULTS).toEqual({
      on: true,
      perContactFilesPerDay: 50,
      perContactMBPerDay: 500,
      totalFilesPerDay: 200,
      totalMBPerDay: 2048,
    });
    expect(AUTO_SAVE_RESERVE_BYTES).toBe(GiB);
    expect(AUTO_SAVE_CONCURRENCY).toBe(2);
    expect(AUTO_SAVE_RETRY_DELAYS).toEqual([60, 600, 3600]);
  });

  it('the 51st file from one contact in 24 h waits with limit_contact; after 24 h it is room again', async () => {
    const w = await world();
    for (let i = 0; i < 9; i += 1) await send(w.a, w.b, `f${String(i)}.bin`, 20_000, 6);
    await w.b.client.autoSave.run();
    await w.b.client.autoSave.run();
    expect(w.b.inbox.files().size).toBe(50);
    const waiting = (await receivedItems(w.b)).filter((i) => i.state === 'not_saved');
    expect(waiting).toHaveLength(4);
    expect(waiting.every((i) => i.reason === 'limit_contact')).toBe(true);
    w.clock.t += 86_400;
    await send(w.a, w.b, 'next.bin');
    await w.b.client.autoSave.run();
    expect(w.b.inbox.files().has('next.bin')).toBe(true);
  });

  it('the MB limit per contact and the per-agent limit (limit_today)', async () => {
    const w = await world({}, withAutoSave({ perContactMBPerDay: 1 }));
    await send(w.a, w.b, 'big.bin', 600 * 1024);
    await send(w.a, w.b, 'big2.bin', 600 * 1024);
    await w.b.client.autoSave.run();
    expect(w.b.inbox.files().size).toBe(1);
    expect((await receivedItems(w.b)).find((i) => i.state === 'not_saved')).toMatchObject({
      reason: 'limit_contact',
    });

    const w2 = await world({}, withAutoSave({ totalFilesPerDay: 1 }));
    await send(w2.a, w2.b, 'a.txt');
    await send(w2.a, w2.b, 'b.txt');
    await w2.b.client.autoSave.run();
    expect(w2.b.inbox.files().size).toBe(1);
    expect((await receivedItems(w2.b)).find((i) => i.state === 'not_saved')).toMatchObject({
      reason: 'limit_today',
    });
  });

  it('free space below 1 GiB after the file: waits with disk_full and auto-save pauses', async () => {
    const w = await world({ inboxExtras: { freeBytes: () => Promise.resolve(GiB + 10) } });
    await send(w.a, w.b, 'full.txt');
    await w.b.client.autoSave.run();
    expect(w.b.inbox.files().size).toBe(0);
    expect((await receivedItems(w.b))[0]).toMatchObject({ reason: 'disk_full' });
    // A file arriving within 10 minutes waits too, without a check.
    await send(w.a, w.b, 'next.txt');
    await w.b.client.autoSave.run();
    expect(w.b.inbox.files().size).toBe(0);
  });

  it('a write that runs out of space leaves no temporary file and waits with disk_full', async () => {
    const w = await world();
    await send(w.a, w.b, 'nospace.txt');
    w.b.inbox.failNextWriteWithNoSpace = true;
    await w.b.client.autoSave.run();
    expect([...w.b.inbox.entries.keys()]).toEqual([]);
    expect((await receivedItems(w.b))[0]).toMatchObject({ reason: 'disk_full' });
  });
});

describe('W4-AUTO-SAVE: the quarantine mark (04 §4.1)', () => {
  it('the temporary file is marked before its move, and a mark that fails saves nothing', async () => {
    const marked: string[] = [];
    const w = await world({
      inboxExtras: {
        mark: (name) => {
          marked.push(name);
          return Promise.resolve('marked');
        },
      },
    });
    await send(w.a, w.b, 'ok.txt');
    await w.b.client.autoSave.run();
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatch(/^\.agentlink-partial-/);

    const w2 = await world({ inboxExtras: { mark: () => Promise.resolve('failed') } });
    await send(w2.a, w2.b, 'nomark.txt');
    await w2.b.client.autoSave.run();
    // The temporary file is unlinked; nothing is saved; the reason is fixed.
    expect([...w2.b.inbox.entries.keys()]).toEqual([]);
    expect((await receivedItems(w2.b))[0]).toMatchObject({ reason: 'folder_cannot_mark' });
    // The AI's fetch still saves there (with the mark where possible).
    const [item] = await receivedItems(w2.b);
    const [envelopeId] = (item?.id ?? '').split('.');
    const fetched = await w2.b.client.fetchFile({ envelopeId: envelopeId ?? '' });
    expect(fetched.status).toBe('ok');
  });
});

describe('W4-AUTO-SAVE: paused, off and invalid rules', () => {
  it('while paused nothing starts; a file sent during a pause waits after the resume', async () => {
    let paused = false;
    const pauses: { pausedAt: number; resumedAt: number }[] = [];
    const pause: AutoSavePause = { paused: () => paused, lastPause: () => pauses.at(-1) };
    const w = await world({ autoSavePause: pause });
    await send(w.a, w.b, 'before.txt'); // arrived before the pause
    w.clock.t += 5;
    paused = true;
    const pausedAt = w.clock.t;
    w.clock.t += 10;
    await send(w.a, w.b, 'during.txt'); // sent during the pause, stored by the catch-up
    expect((await w.b.client.autoSave.run()).saved).toBe(0);
    expect(w.b.inbox.files().size).toBe(0);
    w.clock.t += 10;
    paused = false;
    pauses.push({ pausedAt, resumedAt: w.clock.t });
    await w.b.client.autoSave.run();
    // The one waiting from before the pause is saved; the one sent during it waits for Save.
    expect([...w.b.inbox.files().keys()]).toEqual(['before.txt']);
    w.clock.t += 10;
    await send(w.a, w.b, 'after.txt');
    await w.b.client.autoSave.run();
    expect([...w.b.inbox.files().keys()].sort()).toEqual(['after.txt', 'before.txt']);
  });

  it('auto-save off: nothing saved automatically, reason auto_save_off; Save still works', async () => {
    const w = await world({}, withAutoSave({ on: false }));
    await send(w.a, w.b, 'off.txt');
    await w.b.client.autoSave.run();
    expect(w.b.inbox.files().size).toBe(0);
    expect((await receivedItems(w.b))[0]).toMatchObject({ reason: 'auto_save_off' });
  });

  it('a policy without files.autoSave (signed before D-142) stays valid and reads as on', async () => {
    const legacy = defaultPolicy();
    expect('autoSave' in legacy.files).toBe(false);
    expect(policySchema.safeParse(legacy).success).toBe(true);
    const w = await world();
    expect((await w.b.client.ownerActions.loadPolicy()).mode).toBe('signed');
    await send(w.a, w.b, 'legacy.txt');
    expect((await w.b.client.autoSave.run()).saved).toBe(1);
  });

  it('an invalid stored policy (fail closed) saves nothing automatically', async () => {
    const w = await world();
    await send(w.a, w.b, 'closed.txt');
    // Tamper with the stored policy row: the core reads it as fail closed (G-6).
    await w.b.store.transaction((tx) => {
      for (const row of tx.select('policies')) {
        tx.update('policies', { slot: row.slot }, { version: row.version + 7 });
      }
    });
    expect((await w.b.client.ownerActions.loadPolicy()).mode).toBe('fail_closed');
    await w.b.client.autoSave.run();
    expect(w.b.inbox.files().size).toBe(0);
  });
});

describe('W4-AUTO-SAVE: one save per file, never overwrite', () => {
  it('auto-save and agentlink_fetch_file at once write one copy; the later fetch answers from the record', async () => {
    const w = await world();
    const envelopeId = await send(w.a, w.b, 'once.txt');
    const [run, fetched] = await Promise.all([
      w.b.client.autoSave.run(),
      w.b.client.fetchFile({ envelopeId }),
    ]);
    expect(run.saved + (fetched.status === 'ok' ? 1 : 0)).toBeGreaterThanOrEqual(1);
    expect([...w.b.inbox.files().keys()]).toEqual(['once.txt']);
    const writesBefore = w.b.inbox.writes.length;
    const again = await w.b.client.fetchFile({ envelopeId });
    expect(again).toMatchObject({ status: 'ok', name: 'once.txt', integrity: 'verified' });
    expect(w.b.inbox.writes.length).toBe(writesBefore);
    expect(w.b.inbox.created.filter((n) => !n.startsWith('.'))).toEqual([]);
  });

  it('a file, folder or link at the name is never replaced or followed: the next free name', async () => {
    const w = await world();
    w.b.inbox.plantSymlink('link.txt');
    w.b.inbox.plantFolder('dir.txt');
    await send(w.a, w.b, 'link.txt');
    await send(w.a, w.b, 'dir.txt');
    await w.b.client.autoSave.run();
    expect([...w.b.inbox.files().keys()].sort()).toEqual(['dir (2).txt', 'link (2).txt']);
    expect(w.b.inbox.entries.get('link.txt')?.kind).toBe('symlink');
    expect(w.b.inbox.entries.get('dir.txt')?.kind).toBe('folder');
  });

  it('a risky name is saved with .download (evil.lnk → evil.lnk.download)', async () => {
    const w = await world();
    await send(w.a, w.b, 'evil.lnk');
    await w.b.client.autoSave.run();
    expect([...w.b.inbox.files().keys()]).toEqual(['evil.lnk.download']);
  });

  it('a failed download is retried after 1 min, 10 min and 1 h, then waits with download_failed', async () => {
    let failing = true;
    const own = new MemoryOwnStorage();
    const w = await world({
      own,
      download: (url) =>
        failing
          ? async () => {
              throw new Error(`down ${url}`);
            }
          : own.download(url),
    });
    await send(w.a, w.b, 'retry.bin', 20_000);
    for (const delay of [0, 60, 600, 3600]) {
      w.clock.t += delay;
      await w.b.client.autoSave.run();
    }
    expect(w.b.inbox.files().size).toBe(0);
    expect((await receivedItems(w.b))[0]).toMatchObject({ reason: 'download_failed' });
    failing = false;
    w.clock.t += 7200;
    expect((await w.b.client.autoSave.run()).saved).toBe(0); // waits for Save now
  });
});

describe('W4-AUTO-SAVE: logs and the notice', () => {
  it('no log line carries a name, the folder, a path or a link', async () => {
    const w = await world({ inboxExtras: { mark: () => Promise.resolve('failed') } });
    await send(w.a, w.b, 'secret-name-7f.txt');
    await w.b.client.autoSave.run();
    const w2 = await world();
    await send(w2.a, w2.b, 'secret-name-7f.txt');
    await w2.b.client.autoSave.run();
    for (const line of [...w.b.lines, ...w2.b.lines]) {
      expect(line).not.toContain('secret-name-7f');
      expect(line).not.toContain(INBOX);
      expect(line).not.toContain('AgentLink/Inbox');
      expect(line).not.toMatch(/https?:\/\//);
    }
    expect(w2.b.lines.some((l) => l.includes('auto-save'))).toBe(true);
  });

  it('the notice is due only after an update, and stays until dismissed', async () => {
    const w = await world();
    expect(await w.b.client.autoSave.noticeDue()).toBe(false); // a new agent
    await w.b.store.transaction((tx) => {
      tx.insert('auto_save_state', {
        slot: 'current',
        notice: 'show',
        paused_reason: null,
        paused_at: null,
      });
    });
    expect(await w.b.client.autoSave.noticeDue()).toBe(true);
    expect(await w.b.client.autoSave.noticeDue()).toBe(true);
    await w.b.client.autoSave.dismissNotice();
    expect(await w.b.client.autoSave.noticeDue()).toBe(false);
  });

  it('files that arrived before automatic saving read before_auto_save and are never saved by it', async () => {
    const w = await world();
    await send(w.a, w.b, 'old.txt');
    await w.b.store.transaction((tx) => {
      for (const f of tx.select('files')) {
        tx.update(
          'files',
          { envelope_id: f.envelope_id, idx: f.idx },
          { auto_save: null, auto_reason: null, auto_tries: null, auto_next_at: null },
        );
      }
    });
    await w.b.client.autoSave.run();
    expect(w.b.inbox.files().size).toBe(0);
    expect((await receivedItems(w.b))[0]).toMatchObject({ reason: 'before_auto_save' });
  });
});
