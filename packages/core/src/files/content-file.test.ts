// FILES-AI-1 (D-152; 06 §2.3 "Send by content"; 04 §4 "Written by the AI into the Send folder";
// I-4, I-5, I-7): `sendMessage` with `contentFile: {name, content}` at the core layer, between two
// in-process agents. The Send folder writer is the platform's (`writeSendFolderFile`); here it is an
// in-memory stand-in with the Node writer's contract (send-folder-file.ts, tested on disk there and
// in apps/cli/test/files-by-content.test.ts): the core calls it only after every refusal before the
// write, the writer calls `reserve` once the folder is held and before it creates anything.
//
// Order of checks (06 §2.3): paused → contact → clientRequestId → name → content → the contact
// policy → Send folder → budget reservation → write → the ordinary send of the in-memory bytes.
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { encodeHex, sha256 } from '@4thtech-io/crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { CoreError } from '../errors.js';
import {
  CONTENT_FILE_BUDGET,
  CONTENT_FILE_MAX_BYTES,
  contentFileBytes,
  contentFileName,
} from './content-file.js';
import type { SendFolderWriteInput, SendFolderWriteResult } from './platform.js';
import type { StoreTx } from '../store/store.js';
import { FakeClock, passphrase, seed } from '../testing/fixtures.js';
import {
  MemoryOwnStorage,
  WORK,
  deliver,
  fileBytes,
  openFileAgent,
  outgoing,
  pairForFiles,
  type FileAgent,
} from '../testing/files.js';

const RELAYS_A = Object.freeze(['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net']);
const RELAYS_B = Object.freeze(['wss://one.relay-beta.net', 'wss://two.relay-beta.net']);
const ownerA = new MemoryOwnerKeyStore(seed(231), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(232), passphrase());

const MARKER = 'CONTENT-MARKER-AI1';
const NAME_CANARY = 'CANARY-NAME-AI1';
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const hex = (bytes: Uint8Array): string => encodeHex(sha256(bytes));
const MiB = 1024 * 1024;

/** The Send folder in memory, with the Node writer's contract (see the header). */
class MemorySendFolder {
  readonly files = new Map<string, Uint8Array>();
  readonly calls: string[] = [];
  available = true;
  attempts = 100;
  /** Runs right after a write, before the core sends (a same-user process editing the copy). */
  afterWrite: ((name: string) => void) | undefined;

  readonly write = async (input: SendFolderWriteInput): Promise<SendFolderWriteResult> => {
    this.calls.push('write');
    if (!this.available) return { ok: false, reason: 'no_folder' };
    const reserved = await input.reserve();
    this.calls.push(`reserve:${reserved}`);
    if (reserved === 'over') return { ok: false, reason: 'budget' };
    if (reserved !== 'ok') return { ok: false, reason: 'budget_unavailable' };
    const dot = input.name.lastIndexOf('.');
    for (let n = 1; n <= this.attempts; n += 1) {
      const name =
        n < 2 ? input.name : `${input.name.slice(0, dot)} (${String(n)})${input.name.slice(dot)}`;
      if (this.files.has(name)) continue;
      this.files.set(name, input.bytes.slice());
      this.calls.push(`created:${name}`);
      this.afterWrite?.(name);
      return {
        ok: true,
        realpath: `${WORK}/${name}`,
        name,
        sendFolder: '~/AgentLink/Send',
        remove: () => {
          this.calls.push(`removed:${name}`);
          this.files.delete(name);
          return Promise.resolve();
        },
      };
    }
    return { ok: false, reason: 'name_taken' };
  };
}

let clock: FakeClock;
let own: MemoryOwnStorage;
let folder: MemorySendFolder;
let a: FileAgent;
let b: FileAgent;

async function open(edit: Parameters<typeof pairForFiles>[3] = () => {}): Promise<void> {
  clock = new FakeClock();
  own = new MemoryOwnStorage();
  folder = new MemorySendFolder();
  a = await openFileAgent(clock, new MemoryKeyStore(seed(41)), ownerA, 'alice', {
    relays: RELAYS_A,
    own,
    writeSendFolderFile: folder.write,
  });
  b = await openFileAgent(clock, new MemoryKeyStore(seed(42)), ownerB, 'bob', {
    relays: RELAYS_B,
    own,
  });
  await pairForFiles(clock, a, b, edit);
}

beforeEach(async () => {
  await open();
});

const send = (name: string, content: string, extra: Record<string, unknown> = {}) =>
  a.client.sendMessage({ to: b.id, text: 'from my AI', contentFile: { name, content }, ...extra });

const ledger = (agent: FileAgent = a) =>
  agent.store.transaction((tx) => tx.select('content_file_budget'));

/** Fills the ledger with `count` rows of `bytes` each, at `t`. */
async function fill(count: number, bytes: number, t = clock.t): Promise<void> {
  await a.store.transaction((tx) => {
    for (let i = 0; i < count; i += 1) {
      tx.insert('content_file_budget', {
        entry_id: `seed${String(i).padStart(4, '0')}${'0'.repeat(24)}`,
        t,
        bytes,
      });
    }
  });
}

/** What bob receives for envelope `id`: the saved bytes of file 0. */
async function received(envelopeId: string, savedName: string): Promise<Uint8Array> {
  await deliver(a, b);
  const fetched = await b.client.fetchFile({ envelopeId });
  expect(fetched).toMatchObject({ status: 'ok', name: savedName, integrity: 'verified' });
  return b.inbox.files().get(savedName) as Uint8Array;
}

describe('name (06 §2.3 "Name")', () => {
  it('a folder part is FILE_NAME, never shortened, also behind an invisible character', () => {
    for (const name of [
      '/',
      '\\',
      'a/b.md',
      '../x.md',
      'a\\b.md',
      '..​/x.md',
      'a⁦/⁩b.md',
      'notes­\\x.md',
    ]) {
      expect(contentFileName(name), JSON.stringify(name)).toEqual({ ok: false, code: 'FILE_NAME' });
    }
  });

  it('a type outside .md, .markdown, .txt, .json (on the last extension) is FILE_TYPE', () => {
    for (const name of ['notes.md.exe', 'notes', '..', '.md', 'notes.html', 'notes.svg', '.']) {
      expect(contentFileName(name), name).toEqual({ ok: false, code: 'FILE_TYPE' });
    }
  });

  it('accepts the allowlist in any case and removes bidi and control characters', () => {
    expect(contentFileName('NOTES.MD')).toEqual({ ok: true, name: 'NOTES.MD' });
    expect(contentFileName('plan.markdown')).toEqual({ ok: true, name: 'plan.markdown' });
    expect(contentFileName('a.txt')).toEqual({ ok: true, name: 'a.txt' });
    expect(contentFileName('d.JSON')).toEqual({ ok: true, name: 'd.JSON' });
    expect(contentFileName('no‮tes.md')).toEqual({ ok: true, name: 'notes.md' });
    expect(contentFileName('a\u0007b‏.md')).toEqual({ ok: true, name: 'ab.md' });
  });

  it('a 255-byte name stays; a 256-byte name is cut by sanitizeFileName, keeping .md', () => {
    const at = `${'n'.repeat(252)}.md`;
    expect(utf8(at).length).toBe(255);
    expect(contentFileName(at)).toEqual({ ok: true, name: at });
    const over = `${'n'.repeat(253)}.md`;
    const cut = contentFileName(over);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(utf8(cut.name).length).toBeLessThanOrEqual(255);
    expect(cut.name.endsWith('.md')).toBe(true);
  });

  it('refuses a non-string and an empty name', () => {
    expect(contentFileName(undefined)).toEqual({ ok: false, code: 'FILE_NAME' });
    expect(contentFileName('')).toEqual({ ok: false, code: 'FILE_NAME' });
    expect(contentFileName('x'.repeat(1025) + '.md')).toEqual({ ok: false, code: 'FILE_NAME' });
  });
});

describe('content (06 §2.3 "Content")', () => {
  it('NUL and lone surrogates are FILE_NOT_TEXT', () => {
    for (const content of ['a\u0000b', '\ud800', 'x\udc00', 'ab\ud83d']) {
      expect(contentFileBytes(content), JSON.stringify(content)).toEqual({
        ok: false,
        code: 'FILE_NOT_TEXT',
      });
    }
  });

  it('exactly 8 MiB of UTF-8 passes; 8 MiB + 1 byte is FILE_TOO_LARGE', () => {
    expect(CONTENT_FILE_MAX_BYTES).toBe(8 * MiB);
    const at = contentFileBytes('é'.repeat(4 * MiB));
    expect(at.ok && at.bytes.length).toBe(8 * MiB);
    expect(contentFileBytes(`${'é'.repeat(4 * MiB)}a`)).toEqual({
      ok: false,
      code: 'FILE_TOO_LARGE',
    });
    expect(contentFileBytes('a'.repeat(8 * MiB + 1))).toEqual({
      ok: false,
      code: 'FILE_TOO_LARGE',
    });
  });

  it('the bytes are the UTF-8 of the content, a pair of surrogates included', () => {
    const text = `# Plan\n\nčšž 😀 ${MARKER}`;
    const out = contentFileBytes(text);
    expect(out.ok && hex(out.bytes)).toBe(hex(utf8(text)));
  });
});

describe('the send (06 §2.3 "Then the ordinary send, from the bytes in memory")', () => {
  it('writes once into the Send folder, sends it as a file, and bob gets exactly the bytes', async () => {
    const content = `# Notes\n\nčšž ${MARKER}`;
    const sent = await send('notes.md', content);
    expect(sent).toMatchObject({
      status: 'ok',
      files: [{ index: 0, delivery: 'inline' }],
      contentFile: {
        name: 'notes.md',
        size: utf8(content).length,
        plaintextSha256: hex(utf8(content)),
        sendFolder: '~/AgentLink/Send',
      },
    });
    if (sent.status !== 'ok') return;
    expect([...folder.files.keys()]).toEqual(['notes.md']);
    const got = await received(sent.envelopeId, 'notes.md');
    expect(hex(got)).toBe(hex(utf8(content)));
  });

  it('the copy changed between the write and the send: the sent bytes still equal the input', async () => {
    folder.afterWrite = (name) => folder.files.set(name, utf8('EDITED BY ANOTHER PROCESS'));
    const content = `original ${MARKER}`;
    const sent = await send('notes.md', content);
    expect(sent.status).toBe('ok');
    if (sent.status !== 'ok') return;
    expect(hex(await received(sent.envelopeId, 'notes.md'))).toBe(hex(utf8(content)));
  });

  it('a stored file: own storage sees ALF1 ciphertext only; nothing in a relay event or a log', async () => {
    const content = `${MARKER} ${'x'.repeat(40_000)}`;
    const sent = await send(`${NAME_CANARY}.md`, content);
    expect(sent).toMatchObject({ status: 'ok', files: [{ index: 0, delivery: 'own' }] });
    if (sent.status !== 'ok') return;
    expect(own.objects.size).toBe(1);
    const stored = new TextDecoder().decode([...own.objects.values()][0] as Uint8Array);
    expect(stored.startsWith('ALF1')).toBe(true);
    expect(stored).not.toContain(MARKER);
    for (const p of a.spy.published) {
      expect(JSON.stringify(p.event)).not.toContain(MARKER);
      expect(JSON.stringify(p.event)).not.toContain(NAME_CANARY);
    }
    const lines = a.lines.join('\n');
    expect(lines).not.toContain(MARKER);
    expect(lines).not.toContain(NAME_CANARY);
    expect(hex(await received(sent.envelopeId, `${NAME_CANARY}.md`))).toBe(hex(utf8(content)));
  });

  it('exactly 8 MiB is sent; 8 MiB + 1 byte is FILE_TOO_LARGE and nothing is written', async () => {
    const content = 'é'.repeat(4 * MiB);
    const sent = await send('big.md', content);
    expect(sent).toMatchObject({ status: 'ok', contentFile: { size: 8 * MiB } });
    const over = await send('over.md', `${content}a`);
    expect(over).toEqual({ status: 'rejected', code: 'FILE_TOO_LARGE' });
    expect([...folder.files.keys()]).toEqual(['big.md']);
  });

  it('a clash takes notes (2).md, nothing is overwritten, and the contact sees the saved name', async () => {
    folder.files.set('notes.md', utf8('the owner own file'));
    const sent = await send('notes.md', `second ${MARKER}`);
    expect(sent).toMatchObject({ status: 'ok', contentFile: { name: 'notes (2).md' } });
    expect(new TextDecoder().decode(folder.files.get('notes.md'))).toBe('the owner own file');
    if (sent.status !== 'ok') return;
    await received(sent.envelopeId, 'notes (2).md');
  });

  it('the writer attempt limit is FILE_NAME_TAKEN, nothing sent', async () => {
    folder.attempts = 0;
    expect(await send('notes.md', 'x')).toEqual({ status: 'rejected', code: 'FILE_NAME_TAKEN' });
    expect(a.spy.published).toHaveLength(0);
  });
});

describe('order of checks: nothing written before the write step (06 §2.3)', () => {
  it('name, type and content refusals call no writer and reserve nothing', async () => {
    expect(await send('a/b.md', 'x')).toEqual({ status: 'rejected', code: 'FILE_NAME' });
    expect(await send('x.exe', 'x')).toEqual({ status: 'rejected', code: 'FILE_TYPE' });
    expect(await send('x.md', 'a\u0000')).toEqual({ status: 'rejected', code: 'FILE_NOT_TEXT' });
    expect(folder.calls).toEqual([]);
    expect(await ledger()).toEqual([]);
  });

  it('the contact policy refuses before the write (POLICY_DENIED, nothing written)', async () => {
    await open((p) => {
      p.contacts.allowed = [];
    });
    expect(await send('notes.md', 'x')).toEqual({ status: 'rejected', code: 'POLICY_DENIED' });
    expect(folder.calls).toEqual([]);
    expect(await ledger()).toEqual([]);
  });

  it('no folder allowed: needs_setup no_folder, the writer never called', async () => {
    await open((p) => {
      p.files.allowedFolders = [];
    });
    expect(await send('notes.md', 'x')).toEqual({ status: 'needs_setup', reason: 'no_folder' });
    expect(folder.calls).toEqual([]);
  });

  it('Send folder not available while another is allowed: SEND_FOLDER_UNAVAILABLE, no budget', async () => {
    folder.available = false;
    expect(await send('notes.md', 'x')).toEqual({
      status: 'rejected',
      code: 'SEND_FOLDER_UNAVAILABLE',
    });
    expect(folder.files.size).toBe(0);
    expect(await ledger()).toEqual([]);
  });

  it('paused: agent_paused before any write', async () => {
    await a.client.pause.pause();
    await expect(send('notes.md', 'x')).rejects.toMatchObject({ code: 'agent_paused' });
    expect(folder.calls).toEqual([]);
  });
});

describe('what stays (06 §2.3 "What stays")', () => {
  it('a sent message keeps the file', async () => {
    expect((await send('notes.md', 'x')).status).toBe('ok');
    expect(folder.files.has('notes.md')).toBe(true);
    expect(folder.calls.some((c) => c.startsWith('removed:'))).toBe(false);
  });

  it('a refusal after the write removes it at once; the reservation still counts', async () => {
    await open((p) => {
      p.files.maxSendSizeMB = 1;
    });
    expect(await send('big.md', 'a'.repeat(2 * MiB))).toEqual({
      status: 'rejected',
      code: 'FILE_TOO_LARGE',
    });
    expect(folder.files.size).toBe(0);
    expect(folder.calls).toContain('removed:big.md');
    expect(await ledger()).toHaveLength(1);
  });

  it('needs_setup after the write removes it; the same clientRequestId writes again', async () => {
    await open((p) => {
      p.files.storage = 'own';
    });
    // No own storage for this agent: a stored file needs setup.
    const lone = await openFileAgent(clock, new MemoryKeyStore(seed(43)), ownerA, 'carol', {
      relays: RELAYS_A,
      writeSendFolderFile: folder.write,
    });
    await pairForFiles(clock, lone, b, (p) => {
      p.files.storage = 'own';
    });
    const big = 'b'.repeat(40_000);
    const args = { to: b.id, contentFile: { name: 'big.md', content: big }, clientRequestId: 'r1' };
    expect(await lone.client.sendMessage(args)).toEqual({
      status: 'needs_setup',
      reason: 'no_own_storage',
    });
    expect(folder.files.size).toBe(0);
    expect(await lone.client.sendMessage(args)).toEqual({
      status: 'needs_setup',
      reason: 'no_own_storage',
    });
    expect(folder.calls.filter((c) => c.startsWith('created:'))).toHaveLength(2);
    expect(await ledger(lone)).toHaveLength(2);
  });

  it('an error during the send removes the file and rethrows a fixed CoreError', async () => {
    own.put = () => Promise.reject(new Error('the storage refused'));
    await expect(send('big.md', 'c'.repeat(40_000))).rejects.toBeInstanceOf(CoreError);
    expect(folder.files.size).toBe(0);
  });
});

describe('idempotency before the write (06 §2.3)', () => {
  it('a repeat returns the kept result and writes nothing; other arguments are IDEMPOTENCY_KEY_REUSED', async () => {
    const first = await send('notes.md', 'one', { clientRequestId: 'req-1' });
    expect(first.status).toBe('ok');
    const again = await send('notes.md', 'one', { clientRequestId: 'req-1' });
    expect(again).toMatchObject({ status: 'ok', contentFile: { name: 'notes.md' } });
    if (first.status === 'ok' && again.status === 'ok') {
      expect(again.envelopeId).toBe(first.envelopeId);
    }
    expect(await send('notes.md', 'two', { clientRequestId: 'req-1' })).toEqual({
      status: 'rejected',
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(await send('other.md', 'one', { clientRequestId: 'req-1' })).toEqual({
      status: 'rejected',
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(folder.calls.filter((c) => c === 'write')).toHaveLength(1);
    expect([...folder.files.keys()]).toEqual(['notes.md']);
    expect(await ledger()).toHaveLength(1);
  });

  it('the idempotency row holds no content (a keyed digest of the hash only)', async () => {
    await send('notes.md', `${MARKER}`, { clientRequestId: 'req-2' });
    const rows = await a.store.transaction((tx) => tx.select('idempotency'));
    expect(JSON.stringify(rows)).not.toContain(MARKER);
  });

  it('a refusal of the content path is never kept: the same call works once the cause is gone', async () => {
    folder.available = false;
    const args = { clientRequestId: 'req-3' };
    expect(await send('notes.md', 'x', args)).toMatchObject({ code: 'SEND_FOLDER_UNAVAILABLE' });
    folder.available = true;
    expect((await send('notes.md', 'x', args)).status).toBe('ok');
  });

  it('the approved retry (a repeat) never counts and never returns FILE_BUDGET', async () => {
    const first = await send('notes.md', 'x', { clientRequestId: 'req-4' });
    expect(first.status).toBe('ok');
    await fill(CONTENT_FILE_BUDGET.files, 1);
    const before = (await ledger()).length;
    expect((await send('notes.md', 'x', { clientRequestId: 'req-4' })).status).toBe('ok');
    expect(await ledger()).toHaveLength(before);
    expect(folder.calls.filter((c) => c === 'write')).toHaveLength(1);
  });
});

describe('daily budget (06 §2.3 "Daily budget", owner decision (d))', () => {
  it('is 50 files and 64 MiB in a rolling 24 h', () => {
    expect(CONTENT_FILE_BUDGET).toEqual({
      files: 50,
      bytes: 64 * MiB,
      windowSeconds: 24 * 60 * 60,
    });
  });

  it('the 51st file is FILE_BUDGET, nothing written or sent', async () => {
    await fill(49, 10);
    expect((await send('fiftieth.md', 'x')).status).toBe('ok');
    const published = a.spy.published.length;
    expect(await send('fifty-first.md', 'x')).toEqual({ status: 'rejected', code: 'FILE_BUDGET' });
    expect(folder.files.has('fifty-first.md')).toBe(false);
    expect(a.spy.published).toHaveLength(published);
    expect(await ledger()).toHaveLength(50);
  });

  it('the file that crosses 64 MiB is FILE_BUDGET; one that fits passes', async () => {
    await fill(8, 8 * MiB - 1);
    // 8 bytes left: 9 crosses, 8 fits.
    expect(await send('nine.md', '123456789')).toEqual({ status: 'rejected', code: 'FILE_BUDGET' });
    expect((await send('eight.md', '12345678')).status).toBe('ok');
  });

  it('rows older than 24 h no longer count', async () => {
    await fill(50, 1, clock.t - CONTENT_FILE_BUDGET.windowSeconds);
    expect((await send('notes.md', 'x')).status).toBe('ok');
  });

  it('a removed file still counts', async () => {
    await open((p) => {
      p.files.maxSendSizeMB = 1;
    });
    await fill(49, 1);
    expect(await send('big.md', 'a'.repeat(2 * MiB))).toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(await send('small.md', 'x')).toEqual({ status: 'rejected', code: 'FILE_BUDGET' });
  });

  it('parallel calls for the last place: exactly one passes', async () => {
    await fill(49, 1);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        send(`race-${String(i)}.md`, `race ${String(i)}`, { clientRequestId: `race-${String(i)}` }),
      ),
    );
    expect(results.filter((r) => r.status === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected' && r.code === 'FILE_BUDGET')).toHaveLength(
      5,
    );
    expect(folder.files.size).toBe(1);
    expect(await ledger()).toHaveLength(50);
  });

  it('Attach and path sends count nothing', async () => {
    const sent = await a.client.sendMessage({
      to: b.id,
      text: 'by path',
      files: [outgoing('report.md', fileBytes(100), { mime: 'text/markdown' })],
    });
    expect(sent.status).toBe('ok');
    expect(await ledger()).toEqual([]);
  });

  it('the ledger holds time and byte count only', async () => {
    await send(`${NAME_CANARY}.md`, MARKER);
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['bytes', 'entry_id', 't']);
    expect(rows[0]).toMatchObject({ t: clock.t, bytes: utf8(MARKER).length });
    expect(JSON.stringify(rows)).not.toContain(NAME_CANARY);
  });

  it('an unreadable ledger fails closed with files_unavailable, nothing written', async () => {
    const store = a.store as unknown as {
      transaction: <R>(body: (tx: StoreTx) => R) => Promise<R>;
    };
    const original = store.transaction.bind(a.store);
    store.transaction = <R>(body: (tx: StoreTx) => R): Promise<R> =>
      original((tx) =>
        body(
          new Proxy(tx, {
            get(target, prop: keyof StoreTx) {
              const value = target[prop];
              if (typeof value !== 'function') return value;
              return (table: string, ...rest: unknown[]) => {
                if (table === 'content_file_budget') throw new Error('unreadable');
                return (value as (...args: unknown[]) => unknown).call(target, table, ...rest);
              };
            },
          }),
        ),
      );
    await expect(send('notes.md', 'x')).rejects.toMatchObject({ code: 'files_unavailable' });
    expect(folder.files.size).toBe(0);
  });
});
