// W4-AUTO-SAVE fix round 1 (IR-W4-AUTO-SAVE-1 L1, L2; IR-W4-AUTO-SAVE-SEC-1 L2, L3; 04 §4.1):
// - one save per file across processes: a second AgentLink process of the same agent (its own
//   in-memory locks) saving the same file at once still leaves one copy; the later save is answered
//   from the record;
// - the in-lock check right before the download also reads the pause and the rules in force again;
// - a name taken between the free-name pick and the move: the next free name, no second download.
import { type JsonObject } from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { defaultPolicy, type Policy } from '@4thtech-io/types';
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
  type FileAgentOptions,
} from '../testing/files.js';
import { newNonce, ownerHex, signWith } from '../testing/owner.js';
import type { AutoSavePause } from './auto-save.js';

const RELAYS_A = Object.freeze(['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net']);
const RELAYS_B = Object.freeze(['wss://one.relay-beta.net', 'wss://two.relay-beta.net']);
const ownerA = new MemoryOwnerKeyStore(seed(301), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(302), passphrase());

interface World {
  a: FileAgent;
  b: FileAgent;
  clock: FakeClock;
  own: MemoryOwnStorage;
}

async function world(receiver: Partial<FileAgentOptions> = {}, own = new MemoryOwnStorage()) {
  const clock = new FakeClock();
  const a = await openFileAgent(clock, new MemoryKeyStore(seed(101)), ownerA, 'alice', {
    relays: RELAYS_A,
    own,
  });
  const b = await openFileAgent(clock, new MemoryKeyStore(seed(102)), ownerB, 'bob', {
    relays: RELAYS_B,
    own,
    ...receiver,
  });
  await pairForFiles(clock, a, b);
  return { a, b, clock, own } satisfies World;
}

async function send(w: World, name: string, size = 64): Promise<string> {
  const sent = await w.a.client.sendMessage({
    to: w.b.id,
    text: 'file',
    files: [outgoing(name, fileBytes(size))],
  });
  if (sent.status !== 'ok') throw new Error('not sent');
  await deliver(w.a, w.b);
  return sent.envelopeId;
}

async function setPolicy(w: World, version: number, edit: (p: Policy) => void): Promise<void> {
  const policy = defaultPolicy();
  policy.files.allowedFolders = ['~/Work'];
  edit(policy);
  const signed = await signWith(w.b.owner, {
    v: 1,
    agent: w.b.id,
    owner: await ownerHex(w.b.owner),
    op: 'policy.set',
    params: { version, policy: policy as unknown as JsonObject },
    nonce: newNonce(),
    issuedAt: w.clock.t,
    expiresAt: w.clock.t + 600,
  });
  const applied = await w.b.client.ownerActions.apply(JSON.stringify(signed));
  if (applied.status !== 'applied') throw new Error('policy not applied');
}

describe('one save per file across processes (IR L1)', () => {
  it('auto-save here and a fetch in another process at once: one copy, the later from the record', async () => {
    // The first mark waits until the other process saved the same file.
    let release: (() => void) | undefined;
    const otherDone = new Promise<void>((resolve) => {
      release = resolve;
    });
    let marks = 0;
    const w = await world({
      inboxExtras: {
        mark: async () => {
          marks += 1;
          if (marks === 1) await otherDone;
          return 'marked';
        },
      },
    });
    const envelopeId = await send(w, 'shared.txt');
    const other = await w.b.secondProcess();
    const auto = w.b.client.autoSave.run();
    // Let the automatic save reach its mark, then save from the other process.
    for (let i = 0; i < 50 && marks === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    const fetched = await other.fetchFile({ envelopeId });
    expect(fetched).toMatchObject({ status: 'ok', name: 'shared.txt' });
    release?.();
    // The automatic save finds the other process's record at the move: it counts as saved (from the
    // record), with no second copy.
    expect((await auto).saved).toBe(1);
    const row = await w.b.store.transaction((tx) =>
      tx.get('files', { envelope_id: envelopeId, idx: 0 }),
    );
    expect(row?.auto_save).toBe('saved');
    expect([...w.b.inbox.files().keys()]).toEqual(['shared.txt']);
    expect([...w.b.inbox.entries.keys()].filter((n) => n.startsWith('.'))).toEqual([]);
    const again = await w.b.client.fetchFile({ envelopeId });
    expect(again).toMatchObject({ status: 'ok', name: 'shared.txt' });
  });
});

describe('the in-lock check reads the pause and the rules again (IR L2, SEC L3)', () => {
  it('paused after the run started: nothing is downloaded or written', async () => {
    let paused = false;
    const pause: AutoSavePause = { paused: () => paused };
    const w = await world({
      autoSavePause: pause,
      beforeInbox: () => {
        paused = true;
        return Promise.resolve();
      },
    });
    await send(w, 'pause.txt');
    expect((await w.b.client.autoSave.run()).saved).toBe(0);
    expect(w.b.inbox.created).toEqual([]);
  });

  it('"Ask before saving" signed after the run started: not saved', async () => {
    let edit: (() => Promise<void>) | undefined;
    const w = await world({ beforeInbox: async () => edit?.() });
    await send(w, 'ask.txt');
    edit = async () => {
      edit = undefined;
      await setPolicy(w, 2, (p) => {
        p.contactRules = [{ contact: w.a.id, files: { askBeforeSaving: true } }];
      });
    };
    expect((await w.b.client.autoSave.run()).saved).toBe(0);
    expect(w.b.inbox.created).toEqual([]);
  });

  it('auto-save turned off after the run started: not saved', async () => {
    let edit: (() => Promise<void>) | undefined;
    const w = await world({ beforeInbox: async () => edit?.() });
    await send(w, 'off.txt');
    edit = async () => {
      edit = undefined;
      await setPolicy(w, 2, (p) => {
        p.files.autoSave = {
          on: false,
          perContactFilesPerDay: 50,
          perContactMBPerDay: 500,
          totalFilesPerDay: 200,
          totalMBPerDay: 2048,
        };
      });
    };
    expect((await w.b.client.autoSave.run()).saved).toBe(0);
    expect(w.b.inbox.created).toEqual([]);
  });
});

describe('a name taken at the move (SEC L2)', () => {
  it('the next free name, without a second download', async () => {
    const own = new MemoryOwnStorage();
    let downloads = 0;
    let planted = false;
    const ref: { inbox?: FileAgent['inbox'] } = {};
    const w = await world(
      {
        download: (url) => {
          downloads += 1;
          return own.download(url);
        },
        inboxExtras: {
          mark: () => {
            if (!planted) {
              planted = true;
              ref.inbox?.plantFolder('race.bin');
            }
            return Promise.resolve('marked');
          },
        },
      },
      own,
    );
    ref.inbox = w.b.inbox;
    const envelopeId = await send(w, 'race.bin', 20_000);
    const result = await w.b.client.fetchFile({ envelopeId });
    expect(result).toMatchObject({ status: 'ok', name: 'race (2).bin' });
    expect(downloads).toBe(1);
    expect(w.b.inbox.entries.get('race.bin')?.kind).toBe('folder');
    expect([...w.b.inbox.files().keys()]).toEqual(['race (2).bin']);
  });
});
