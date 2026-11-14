// OWNER-START-OVER (D-153; 04 §2.5.4 "Start over on this computer"; I-4, I-7): the engine behind
// "Forgot your master code? Start over on this computer". Tests run on a temporary HOME and an
// in-memory keychain only (never the real ~/.agentlink or the OS keychain).
//
// - Begin needs the typed phrase `start over`; finish needs the begin's single-use nonce, the same
//   page session and a fresh OS presence gesture (native: Touch ID / Windows Hello through the
//   platform-neutral NativeHelper; browser: a user-verified WebAuthn creation).
// - The effect: ~/.agentlink is MOVED to ~/.agentlink.backup-YYYYMMDD-HHMMSS (never deleted), then
//   the keychain accounts of this owner and of every ID in the moved folder are erased by their
//   exact names; nothing else in the keychain is touched.
// - A partial failure is answered (never silent) and is safe to retry: a retry finishes the erase
//   from the record in the backup and never moves or erases twice.
import { chmod, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  NATIVE_PRESENCE_MACOS,
  NATIVE_PRESENCE_WINDOWS,
  encodeBase64url,
} from '@4thtech-io/crypto';
import { newWebauthnTestCredential } from '@4thtech-io/crypto/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryKeychain, tempRoot, webauthnCreate } from './recovery-kit-restore.fixture.js';
import { StandInHelper } from './owner-native.fixture.js';
import { VirtualPrfAuthenticator } from './passkey-authenticator.fixture.js';
import {
  START_OVER_PHRASE,
  START_OVER_RECORD,
  createStartOverEngine,
  type StartOverOptions,
} from './start-over.js';

const ORIGIN = 'http://localhost:4100';
const SESSION = 'session-a';
const AGENT_A = `0x${'a'.repeat(40)}`;
const AGENT_B = `0x${'b'.repeat(40)}`;
const OWNER_ITEMS = [
  'owner',
  'owner-passkey',
  'owner-passkey-key',
  'owner-next',
  'owner-native',
  'owner-native-revoked',
];
// 14 Nov 2026, 09:05:07 local time.
const NOW = new Date(2026, 10, 14, 9, 5, 7).getTime();
const BACKUP = '.agentlink.backup-20261114-090507';

let root: Awaited<ReturnType<typeof tempRoot>>;
let keychain: MemoryKeychain;

beforeEach(async () => {
  root = await tempRoot('agentlink-start-over-');
  keychain = new MemoryKeychain();
});
afterEach(async () => {
  await root.cleanup();
});

const bytes = (n: number): Uint8Array => new Uint8Array(32).fill(n);

/** A home with one owner and two IDs, and their keychain items (plus items that are not ours). */
async function seed(): Promise<void> {
  const dir = join(root.home, '.agentlink');
  for (const [name, agentId] of [
    ['default', AGENT_A],
    ['work', AGENT_B],
  ] as const) {
    await mkdir(join(dir, 'agents', name), { recursive: true });
    await writeFile(join(dir, 'agents', name, 'config.json'), JSON.stringify({ agentId }));
    await writeFile(join(dir, 'agents', name, 'store.sqlite'), 'history');
    for (const account of [
      agentId,
      `${agentId}:store-key`,
      `${agentId}:policy-version`,
      `${agentId}:receipts-kept`,
      `${agentId}:key-epoch`,
    ]) {
      keychain.items.set(account, bytes(1));
    }
  }
  for (const account of OWNER_ITEMS) keychain.items.set(account, bytes(2));
  // Not ours: a near-miss owner name and another agent's item that is not in this folder.
  keychain.items.set('owner-x', bytes(3));
  keychain.items.set(`0x${'c'.repeat(40)}`, bytes(3));
}

function engine(over: Partial<StartOverOptions> = {}) {
  return createStartOverEngine({
    home: root.home,
    keychain: () => keychain,
    origin: ORIGIN,
    now: () => NOW,
    native: new StandInHelper(NATIVE_PRESENCE_MACOS),
    ...over,
  });
}

type Engine = ReturnType<typeof engine>;

async function begin(e: Engine, phrase: string = START_OVER_PHRASE, session = SESSION) {
  return e.begin(session, { phrase });
}

async function nativeRun(e: Engine, session = SESSION) {
  const started = await begin(e, START_OVER_PHRASE, session);
  expect(started.status).toBe(200);
  const nonce = (started.body as { nonce: string }).nonce;
  return e.finish(session, { nonce }, 'native', new Uint8Array(0));
}

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

describe('start over: the typed phrase and the presence gesture (I-4)', () => {
  it('begin refuses anything but the phrase, and changes nothing', async () => {
    await seed();
    const e = engine();
    for (const phrase of ['', 'start', 'startover', 'delete everything', 'start over now']) {
      expect((await begin(e, phrase)).body).toEqual({ error: 'phrase' });
    }
    expect((await e.begin(SESSION, undefined)).body).toEqual({ error: 'phrase' });
    expect((await e.begin(SESSION, { phrase: 7 })).body).toEqual({ error: 'phrase' });
    expect(await exists(join(root.home, '.agentlink'))).toBe(true);
    expect(keychain.items.has('owner')).toBe(true);
    e.close();
  });

  it('accepts the phrase in any case and with outer spaces', async () => {
    const e = engine();
    expect((await begin(e, '  Start Over ')).status).toBe(200);
    e.close();
  });

  it('finish without a gesture, with another session or a spent nonce changes nothing', async () => {
    await seed();
    const e = engine();
    const started = await begin(e);
    const nonce = (started.body as { nonce: string }).nonce;
    // No presence mode at all.
    expect((await e.finish(SESSION, { nonce }, undefined, new Uint8Array(0))).status).toBe(400);
    // The nonce was spent by that refusal.
    expect((await e.finish(SESSION, { nonce }, 'native', new Uint8Array(0))).status).toBe(400);
    const again = (await begin(e)).body as { nonce: string };
    expect(
      (await e.finish('session-b', { nonce: again.nonce }, 'native', new Uint8Array(0))).status,
    ).toBe(400);
    expect(await exists(join(root.home, '.agentlink'))).toBe(true);
    expect(keychain.items.size).toBe(18);
    e.close();
  });

  it('a nonce older than its lifetime is refused', async () => {
    await seed();
    let at = NOW;
    const e = engine({ now: () => at });
    const nonce = ((await begin(e)).body as { nonce: string }).nonce;
    at += 121_000;
    expect((await e.finish(SESSION, { nonce }, 'native', new Uint8Array(0))).body).toEqual({
      error: 'expired',
    });
    expect(await exists(join(root.home, '.agentlink'))).toBe(true);
    e.close();
  });

  it('a cancelled Touch ID changes nothing', async () => {
    await seed();
    const helper = new StandInHelper(NATIVE_PRESENCE_MACOS);
    helper.gesture = 'cancelled';
    const e = engine({ native: helper });
    const answer = await nativeRun(e);
    expect(answer.status).toBe(403);
    expect(answer.body).toEqual({ error: 'presence_rejected', native: 'cancelled' });
    expect(await exists(join(root.home, '.agentlink'))).toBe(true);
    expect(keychain.items.size).toBe(18);
    e.close();
  });

  it('macOS: a throwaway key and one Touch ID sheet (reason `reset`); Windows: one Hello prompt', async () => {
    const mac = new StandInHelper(NATIVE_PRESENCE_MACOS);
    const e1 = engine({ native: mac });
    expect((await nativeRun(e1)).status).toBe(200);
    expect(mac.calls).toEqual(['create@0', 'release:reset@0']);
    e1.close();
    const win = new StandInHelper(NATIVE_PRESENCE_WINDOWS);
    const e2 = engine({ native: win });
    expect((await nativeRun(e2)).status).toBe(200);
    expect(win.calls).toEqual(['create@0', 'remove']);
    e2.close();
    const refused = new StandInHelper(NATIVE_PRESENCE_WINDOWS);
    refused.createState = 'failed';
    const e3 = engine({ native: refused });
    expect((await nativeRun(e3)).status).toBe(403);
    e3.close();
  });

  it('without native presence: a user-verified passkey creation for this challenge and origin', async () => {
    await seed();
    const e = engine({ native: undefined });
    expect((await e.state()).body).toMatchObject({ presence: 'passkey' });
    const started = (await begin(e)).body as {
      presence: string;
      nonce: string;
      publicKey: { challenge: string; userId: string; rpId: string };
    };
    expect(started.presence).toBe('passkey');
    expect(started.publicKey.rpId).toBe('localhost');
    // Not verified by the user (UV off): refused.
    const noUv = new VirtualPrfAuthenticator({
      uv: false,
      credential: newWebauthnTestCredential(),
    });
    const weak = webauthnCreate(
      noUv,
      { ...started.publicKey, prfSalt: encodeBase64url(new Uint8Array(32)) },
      ORIGIN,
      false,
    );
    expect((await e.finish(SESSION, { nonce: started.nonce }, 'passkey', weak)).status).toBe(403);
    expect(await exists(join(root.home, '.agentlink'))).toBe(true);
    // Another origin: refused.
    const next = (await begin(e)).body as typeof started;
    const other = webauthnCreate(
      new VirtualPrfAuthenticator({ credential: newWebauthnTestCredential() }),
      { ...next.publicKey, prfSalt: encodeBase64url(new Uint8Array(32)) },
      'http://localhost:9999',
      false,
    );
    expect((await e.finish(SESSION, { nonce: next.nonce }, 'passkey', other)).status).toBe(403);
    // The real thing.
    const last = (await begin(e)).body as typeof started;
    const good = webauthnCreate(
      new VirtualPrfAuthenticator({ credential: newWebauthnTestCredential() }),
      { ...last.publicKey, prfSalt: encodeBase64url(new Uint8Array(32)) },
      ORIGIN,
      false,
    );
    const done = await e.finish(SESSION, { nonce: last.nonce }, 'passkey', good);
    expect(done.body).toMatchObject({ status: 'done' });
    expect(await exists(join(root.home, '.agentlink'))).toBe(false);
    e.close();
  });

  it('too many refused gestures make the next begin wait', async () => {
    const helper = new StandInHelper(NATIVE_PRESENCE_MACOS);
    helper.gesture = 'failed';
    const e = engine({ native: helper });
    for (let i = 0; i < 3; i += 1) expect((await nativeRun(e)).status).toBe(403);
    const waiting = await begin(e);
    expect(waiting.status).toBe(429);
    expect(waiting.body).toMatchObject({ error: 'wait' });
    e.close();
  });
});

describe('start over: the backup move and the keychain erase by exact name', () => {
  it('moves ~/.agentlink to a dated backup and erases only our items', async () => {
    await seed();
    const order: string[] = [];
    const e = engine({
      closeOpen: () => {
        order.push('close');
        return Promise.resolve();
      },
      reopen: () => {
        order.push('reopen');
        return Promise.resolve();
      },
    });
    const answer = await nativeRun(e);
    expect(answer).toEqual({
      status: 200,
      body: { status: 'done', backup: join('~', BACKUP) },
    });
    expect(order).toEqual(['close', 'reopen']);
    expect(await exists(join(root.home, '.agentlink'))).toBe(false);
    // Nothing deleted: the folder is there, whole, under its new name.
    const backup = join(root.home, BACKUP);
    expect(await readFile(join(backup, 'agents', 'work', 'store.sqlite'), 'utf8')).toBe('history');
    const record = JSON.parse(await readFile(join(backup, START_OVER_RECORD), 'utf8')) as {
      done: boolean;
      agents: string[];
    };
    expect(record.done).toBe(true);
    expect([...record.agents].sort()).toEqual([AGENT_A, AGENT_B]);
    // Only the items that are not ours are left.
    expect([...keychain.items.keys()].sort()).toEqual([`0x${'c'.repeat(40)}`, 'owner-x']);
    e.close();
  });

  it('a second start over the same second gets its own folder', async () => {
    await seed();
    const e = engine();
    expect((await nativeRun(e)).status).toBe(200);
    await mkdir(join(root.home, '.agentlink', 'agents'), { recursive: true });
    const second = await nativeRun(e);
    expect(second.body).toEqual({ status: 'done', backup: join('~', `${BACKUP}-2`) });
    e.close();
  });

  it('refuses a ~/.agentlink that is a link (04 §4)', async () => {
    const { symlink } = await import('node:fs/promises');
    await mkdir(join(root.root, 'elsewhere'), { recursive: true });
    await symlink(join(root.root, 'elsewhere'), join(root.home, '.agentlink'));
    keychain.items.set('owner', bytes(2));
    const e = engine();
    const answer = await nativeRun(e);
    expect(answer.body).toMatchObject({ status: 'partial', failed: 'move' });
    expect(keychain.items.has('owner')).toBe(true);
    e.close();
  });

  // CodeQL js/file-system-race: an ID's config.json is read through the handle that was checked, so
  // a link (here to another ID's config outside the folder) is never followed and names no ID.
  it.skipIf(process.platform === 'win32')(
    "never follows a linked config.json: the link's ID is not erased",
    async () => {
      const { symlink } = await import('node:fs/promises');
      await seed();
      const other = `0x${'c'.repeat(40)}`;
      const outside = join(root.root, 'other-config.json');
      await writeFile(outside, JSON.stringify({ agentId: other }));
      await mkdir(join(root.home, '.agentlink', 'agents', 'linked'), { recursive: true });
      await symlink(outside, join(root.home, '.agentlink', 'agents', 'linked', 'config.json'));
      const e = engine();
      expect((await nativeRun(e)).body).toEqual({ status: 'done', backup: join('~', BACKUP) });
      const record = JSON.parse(
        await readFile(join(root.home, BACKUP, START_OVER_RECORD), 'utf8'),
      ) as { agents: string[] };
      expect([...record.agents].sort()).toEqual([AGENT_A, AGENT_B]);
      expect(keychain.items.has(other)).toBe(true);
      e.close();
    },
  );
});

describe('start over: partial failure is reported and safe to retry', () => {
  it('a move that fails erases nothing and reopens the ID; the retry finishes', async () => {
    await seed();
    let fail = true;
    const reopened: number[] = [];
    const e = engine({
      rename: (from, to) => {
        if (fail) {
          const error = new Error('busy') as Error & { code: string };
          error.code = 'EBUSY';
          return Promise.reject(error);
        }
        return rename(from, to);
      },
      reopen: () => {
        reopened.push(1);
        return Promise.resolve();
      },
    });
    const first = await nativeRun(e);
    expect(first.body).toEqual({ status: 'partial', backup: null, failed: 'move' });
    expect(reopened).toHaveLength(1);
    expect(await exists(join(root.home, '.agentlink', 'agents', 'work'))).toBe(true);
    expect(keychain.items.size).toBe(18);
    fail = false;
    const second = await nativeRun(e);
    expect(second.body).toEqual({ status: 'done', backup: join('~', BACKUP) });
    expect([...keychain.items.keys()].sort()).toEqual([`0x${'c'.repeat(40)}`, 'owner-x']);
    e.close();
  });

  it('an erase that fails part-way is reported; the retry erases the rest, moves nothing again', async () => {
    await seed();
    const real = keychain.delete.bind(keychain);
    let failing = true;
    keychain.delete = (account: string) =>
      failing && account === 'owner' ? Promise.reject(new Error('refused')) : real(account);
    const e = engine();
    const first = await nativeRun(e);
    expect(first.body).toEqual({
      status: 'partial',
      backup: join('~', BACKUP),
      failed: 'keychain',
    });
    expect(keychain.items.has('owner')).toBe(true);
    expect(await exists(join(root.home, '.agentlink'))).toBe(false);
    expect((await e.state()).body).toMatchObject({ unfinished: true });
    failing = false;
    const second = await nativeRun(e);
    expect(second.body).toEqual({ status: 'done', backup: join('~', BACKUP) });
    expect([...keychain.items.keys()].sort()).toEqual([`0x${'c'.repeat(40)}`, 'owner-x']);
    // One backup only.
    expect((await readdir(root.home)).filter((n) => n.startsWith('.agentlink'))).toEqual([BACKUP]);
    expect((await e.state()).body).toMatchObject({ unfinished: false });
    e.close();
  });

  it('a retry while a new folder exists moves that one too and finishes the earlier erase', async () => {
    await seed();
    const real = keychain.delete.bind(keychain);
    let failing = true;
    keychain.delete = (account: string) =>
      failing && account === AGENT_B ? Promise.reject(new Error('refused')) : real(account);
    let at = NOW;
    const e = engine({ now: () => at });
    expect((await nativeRun(e)).body).toMatchObject({ status: 'partial', failed: 'keychain' });
    expect(keychain.items.has(AGENT_B)).toBe(true);
    // Something made a new folder meanwhile.
    await mkdir(join(root.home, '.agentlink', 'agents'), { recursive: true });
    failing = false;
    at += 60_000;
    const retry = await nativeRun(e);
    expect(retry.body).toEqual({
      status: 'done',
      backup: join('~', '.agentlink.backup-20261114-090607'),
    });
    expect(keychain.items.has(AGENT_B)).toBe(false);
    const first = JSON.parse(
      await readFile(join(root.home, BACKUP, START_OVER_RECORD), 'utf8'),
    ) as {
      done: boolean;
    };
    expect(first.done).toBe(true);
    e.close();
  });
});

describe('start over: review round 1 (IR M1, M2, lows)', () => {
  it('M1: a folder that comes back between the move and the erase keeps the owner and the records undone', async () => {
    await seed();
    const e = engine({
      rename: async (from, to) => {
        await rename(from, to);
        // A running AI app recreates its folder at once.
        await mkdir(join(from, 'agents', 'default'), { recursive: true });
      },
    });
    const answer = await nativeRun(e);
    expect(answer.body).toEqual({
      status: 'partial',
      backup: join('~', BACKUP),
      failed: 'keychain',
    });
    expect(keychain.items.has('owner')).toBe(true);
    const record = JSON.parse(
      await readFile(join(root.home, BACKUP, START_OVER_RECORD), 'utf8'),
    ) as {
      done: boolean;
    };
    expect(record.done).toBe(false);
    expect((await e.state()).body).toMatchObject({ unfinished: true });
    e.close();
  });

  it('M2: the owner items stay while any ID erase failed', async () => {
    await seed();
    const real = keychain.delete.bind(keychain);
    keychain.delete = (account: string) =>
      account === AGENT_A ? Promise.reject(new Error('refused')) : real(account);
    const e = engine();
    expect((await nativeRun(e)).body).toMatchObject({ status: 'partial', failed: 'keychain' });
    for (const account of OWNER_ITEMS) expect(keychain.items.has(account)).toBe(true);
    e.close();
  });

  // A folder made read-only with chmod still takes new files on Windows, so the failing record write
  // is simulated on POSIX only (macOS and Linux CI run it).
  it.skipIf(process.platform === 'win32')(
    'M2: a record write that fails is a partial answer, never done',
    async () => {
      await seed();
      let backupDir = '';
      const e = engine({
        rename: async (from, to) => {
          await rename(from, to);
          backupDir = to;
          await chmod(to, 0o500);
        },
      });
      const first = await nativeRun(e);
      await chmod(backupDir, 0o700);
      expect(first.body).toMatchObject({ status: 'partial', failed: 'keychain' });
      expect((await e.state()).body).toMatchObject({ unfinished: true });
      const second = await nativeRun(e);
      expect(second.body).toEqual({ status: 'done', backup: join('~', BACKUP) });
      e.close();
    },
  );

  it("M2: an unfinished record and a NEW owner: the new owner's folder and items are untouched", async () => {
    await seed();
    const real = keychain.delete.bind(keychain);
    let failing = true;
    keychain.delete = (account: string) =>
      failing && account === AGENT_B ? Promise.reject(new Error('refused')) : real(account);
    const e = engine();
    expect((await nativeRun(e)).body).toMatchObject({ status: 'partial', failed: 'keychain' });
    // The case M2 guards: the old owner went (e.g. erased by hand), then first run made a new owner.
    for (const account of OWNER_ITEMS) keychain.items.delete(account);
    await mkdir(join(root.home, '.agentlink', 'agents', 'default'), { recursive: true });
    await writeFile(join(root.home, '.agentlink', 'agents', 'default', 'config.json'), '{}');
    keychain.items.set('owner', bytes(9));
    keychain.items.set('owner-passkey', bytes(9));
    failing = false;
    const retry = await nativeRun(e);
    expect(retry.body).toEqual({ status: 'done', backup: join('~', BACKUP), earlierOnly: true });
    expect(await exists(join(root.home, '.agentlink', 'agents', 'default', 'config.json'))).toBe(
      true,
    );
    expect(keychain.items.get('owner')).toEqual(bytes(9));
    expect(keychain.items.get('owner-passkey')).toEqual(bytes(9));
    expect(keychain.items.has(AGENT_B)).toBe(false);
    expect((await readdir(root.home)).filter((n) => n.startsWith('.agentlink.'))).toEqual([BACKUP]);
    expect((await e.state()).body).toMatchObject({ unfinished: false });
    e.close();
  });

  it('only gestures that were made and not recognised count toward the wait', async () => {
    for (const state of ['cancelled', 'unavailable', 'timeout'] as const) {
      const helper = new StandInHelper(NATIVE_PRESENCE_MACOS);
      helper.gesture = state;
      const e = engine({ native: helper });
      for (let i = 0; i < 5; i += 1) expect((await nativeRun(e)).status).toBe(403);
      expect((await begin(e)).status).toBe(200);
      e.close();
    }
  });
});

describe('start over without a user-verifying sensor: the phrase typed twice (owner decision)', () => {
  const noSensor = (
    kind: typeof NATIVE_PRESENCE_MACOS | typeof NATIVE_PRESENCE_WINDOWS,
  ): StandInHelper => {
    const helper = new StandInHelper(kind);
    helper.unavailable = 'not_set_up';
    return helper;
  };

  async function typedRun(e: Engine, second: unknown, input: Record<string, unknown> = {}) {
    const started = await e.begin(SESSION, { phrase: START_OVER_PHRASE, ...input } as never);
    expect(started.body).toMatchObject({ status: 'presence', presence: 'typed' });
    const nonce = (started.body as { nonce: string }).nonce;
    const finishInput = second === undefined ? { nonce } : { nonce, phrase: second };
    return e.finish(SESSION, finishInput as never, 'typed', new Uint8Array(0));
  }

  it('a browser without a platform authenticator, a Mac without Touch ID, a PC without Hello', async () => {
    const cases = [
      { native: undefined, input: { sensor: 'none' } },
      { native: noSensor(NATIVE_PRESENCE_MACOS), input: {} },
      { native: noSensor(NATIVE_PRESENCE_WINDOWS), input: {} },
    ];
    for (const [i, c] of cases.entries()) {
      await seed();
      const e = engine({ native: c.native, now: () => NOW + i * 1000 });
      if (c.native !== undefined) {
        expect((await e.state()).body).toMatchObject({ presence: 'typed' });
      }
      const done = await typedRun(e, ' Start Over ', c.input);
      expect(done.body).toMatchObject({ status: 'done' });
      expect(await exists(join(root.home, '.agentlink'))).toBe(false);
      expect(keychain.items.has('owner')).toBe(false);
      e.close();
    }
  });

  it('a wrong or missing second phrase changes nothing, and the nonce is spent', async () => {
    await seed();
    const e = engine({ native: undefined });
    for (const second of [undefined, '', 'start', 'yes', 7]) {
      const answer = await typedRun(e, second, { sensor: 'none' });
      expect(answer).toEqual({ status: 400, body: { error: 'phrase' } });
    }
    expect(await exists(join(root.home, '.agentlink'))).toBe(true);
    expect(keychain.items.has('owner')).toBe(true);
    e.close();
  });

  it('where a gesture is available, typing alone is refused (no downgrade)', async () => {
    await seed();
    // Desktop app with Touch ID: the page asks for less, the server still wants the sheet.
    const e = engine();
    const started = await e.begin(SESSION, { phrase: START_OVER_PHRASE, sensor: 'none' });
    expect(started.body).toMatchObject({ presence: 'native' });
    const nonce = (started.body as { nonce: string }).nonce;
    const typed = await e.finish(
      SESSION,
      { nonce, phrase: START_OVER_PHRASE },
      'typed',
      new Uint8Array(0),
    );
    expect(typed).toEqual({ status: 400, body: { error: 'presence_required' } });
    // A browser without the claim: a passkey is required, typing is refused.
    const b = engine({ native: undefined });
    const web = await b.begin(SESSION, { phrase: START_OVER_PHRASE });
    expect(web.body).toMatchObject({ presence: 'passkey' });
    const webNonce = (web.body as { nonce: string }).nonce;
    const webTyped = await b.finish(
      SESSION,
      { nonce: webNonce, phrase: START_OVER_PHRASE },
      'typed',
      new Uint8Array(0),
    );
    expect(webTyped.status).toBe(400);
    expect(await exists(join(root.home, '.agentlink'))).toBe(true);
    e.close();
    b.close();
  });

  it('begin refuses an unknown sensor value or extra fields', async () => {
    const e = engine({ native: undefined });
    expect((await e.begin(SESSION, { phrase: START_OVER_PHRASE, sensor: 'yes' })).status).toBe(400);
    expect((await e.begin(SESSION, { phrase: START_OVER_PHRASE, other: 1 })).status).toBe(400);
    e.close();
  });

  it('a lockout, a timeout or a helper error is "try again", never a drop to typing (Fable r2)', async () => {
    await seed();
    const locked = new StandInHelper(NATIVE_PRESENCE_MACOS);
    locked.transient = true;
    const e = engine({ native: locked });
    expect(await e.begin(SESSION, { phrase: START_OVER_PHRASE, sensor: 'none' })).toEqual({
      status: 503,
      body: { error: 'try_again' },
    });
    expect((await e.state()).body).toMatchObject({ presence: 'native' });
    e.close();
    const broken = new StandInHelper(NATIVE_PRESENCE_WINDOWS);
    broken.availability = () => Promise.reject(new Error('helper gone'));
    const e2 = engine({ native: broken });
    expect((await e2.begin(SESSION, { phrase: START_OVER_PHRASE })).body).toEqual({
      error: 'try_again',
    });
    expect(await exists(join(root.home, '.agentlink'))).toBe(true);
    expect(keychain.items.has('owner')).toBe(true);
    e2.close();
  });
});

describe('start over: a new owner on the file KeyStore (Fable r2)', () => {
  it('no owner item although the record had one, and a folder with a key file: earlier IDs only', async () => {
    await seed();
    const real = keychain.delete.bind(keychain);
    let failing = true;
    keychain.delete = (account: string) =>
      failing && account === AGENT_B ? Promise.reject(new Error('refused')) : real(account);
    const e = engine();
    expect((await nativeRun(e)).body).toMatchObject({ status: 'partial', failed: 'keychain' });
    // The old owner went; first run made a new owner on the file KeyStore (no keychain item).
    for (const account of OWNER_ITEMS) keychain.items.delete(account);
    await mkdir(join(root.home, '.agentlink', 'keystore'), { recursive: true });
    await writeFile(join(root.home, '.agentlink', 'keystore', 'owner.alko'), 'new owner');
    failing = false;
    const retry = await nativeRun(e);
    expect(retry.body).toEqual({ status: 'done', backup: join('~', BACKUP), earlierOnly: true });
    expect(await readFile(join(root.home, '.agentlink', 'keystore', 'owner.alko'), 'utf8')).toBe(
      'new owner',
    );
    expect(keychain.items.has(AGENT_B)).toBe(false);
    expect((await readdir(root.home)).filter((n) => n.startsWith('.agentlink.'))).toEqual([BACKUP]);
    e.close();
  });
});
