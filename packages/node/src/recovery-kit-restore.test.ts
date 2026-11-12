// UX1113-R1 (D-147; 04 §2.3.3 "Restore in the app", "Restore", "Restore never overwrites", §2.5
// "Restore-only owner session"; threats T-1 to T-12): the restore engine behind the app's
// /api/ui/restore/* routes, against a temporary HOME, an in-memory keychain and kits sealed by the
// real KeyExportControl. Each describe names the threat rows it proves.
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  decodeBase64url,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  type JsonValue,
} from '@4thtech-io/crypto';
import { newWebauthnTestCredential } from '@4thtech-io/crypto/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keychainAccount } from './keychain.js';
import {
  OWNER_ACCOUNT,
  OWNER_NEXT_ACCOUNT,
  OWNER_PASSKEY_ACCOUNT,
  exportSeedOf,
  ownerItemPresent,
} from './owner-keystore.js';
import { unlockForRestore } from './key-controls.js';
import { VirtualPrfAuthenticator } from './passkey-authenticator.fixture.js';
import {
  FAST,
  MemoryKeychain,
  headerHashOf,
  makeAgent,
  makeKit,
  makeOwner,
  tempRoot,
  webauthnCreate,
  webauthnCreateThenGet,
  type TestOwner,
} from './recovery-kit-restore.fixture.js';
import {
  RESTORE_HANDLE_TTL_MS,
  createRestoreEngine,
  createTerminalRestore,
  runRestoreInTerminal,
  type RestoreAnswer,
  type RestoreEngine,
  type RestoreTerminal,
  type RestoreTerminalText,
} from './recovery-kit-restore.js';

const POSIX = process.platform !== 'win32';
const ORIGIN = 'http://localhost:47821';

let t: Awaited<ReturnType<typeof tempRoot>>;
let clock: number;
let keychain: MemoryKeychain;
let engine: RestoreEngine;
/** Every answer any engine gave in a test, for the log and error scan (T-3, T-11). */
let answers: RestoreAnswer[];

function newEngine(over: { knownOwner?: Uint8Array; maxUpload?: number } = {}): RestoreEngine {
  const made = createRestoreEngine({
    home: t.home,
    keychain: () => keychain,
    origin: ORIGIN,
    kdf: FAST,
    now: () => clock,
    knownOwnerNostr: () => Promise.resolve(over.knownOwner),
    ...(over.maxUpload === undefined ? {} : { maxUploadBytes: over.maxUpload }),
  });
  // Record every answer.
  const wrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(made)) {
    wrapped[key] = async (...args: unknown[]) => {
      const out = (await (value as (...a: unknown[]) => unknown)(...args)) as unknown;
      if (typeof out === 'object' && out !== null && 'status' in out) {
        answers.push(out as RestoreAnswer);
      }
      return out;
    };
  }
  return wrapped as unknown as RestoreEngine;
}

beforeEach(async () => {
  t = await tempRoot('al-r1-');
  clock = 1_800_000_000_000;
  keychain = new MemoryKeychain();
  answers = [];
  engine = newEngine();
});
afterEach(async () => {
  await engine.close();
  await t.cleanup();
});

const body = (a: RestoreAnswer): Record<string, unknown> => a.body as Record<string, unknown>;
const code = (s: string): Uint8Array => encodeUtf8(s);

async function foundHandle(session = 'S1', name?: string): Promise<string> {
  const found = await engine.found(session);
  expect(found.status).toBe(200);
  const kits = body(found)['kits'] as { handle: string; name: string }[];
  const row = name === undefined ? kits[0] : kits.find((k) => k.name === name);
  expect(row).toBeDefined();
  return (row as { handle: string }).handle;
}

/** A clean computer's kit of one or two agents, saved in Downloads. */
async function kitOnDisk(
  agents: { name: string; people?: number; lastAt?: number }[] = [{ name: 'helper' }],
  owner?: TestOwner,
  file = 'agentlink-recovery-kit-2026-11-12.alkk',
) {
  const o = owner ?? (await makeOwner());
  const made = [];
  for (const a of agents) made.push(await makeAgent(t.root, o, a.name, a));
  const kit = await makeKit(t.root, o, made, file, join(t.home, 'Downloads'));
  return { owner: o, agents: made, ...kit };
}

async function openKit(session: string, handle: string, text: string) {
  return engine.open(session, { handle }, code(text));
}

/** The keychain and the agents folder hold nothing (T-1, T-7). */
async function expectNothingWritten(): Promise<void> {
  expect([...keychain.items.keys()]).toEqual([]);
  await expect(lstat(join(t.home, '.agentlink', 'agents'))).rejects.toThrow();
}

/** Runs the clean-computer gesture through to `done` and returns the answer body. */
async function gestureAndFinish(
  session: string,
  kit: string,
  selection: string[],
  names: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const begun = await engine.applyBegin(session, { kit, selection, names });
  expect(begun.status).toBe(200);
  expect(body(begun)['status']).toBe('gesture');
  const authenticator = new VirtualPrfAuthenticator({ credential: newWebauthnTestCredential() });
  const pk = body(begun)['publicKey'] as { challenge: string; userId: string; prfSalt: string };
  const done = await engine.applyFinish(
    session,
    { nonce: body(begun)['nonce'] as JsonValue },
    webauthnCreate(authenticator, pk, ORIGIN),
  );
  expect(done.status).toBe(200);
  return body(done);
}

describe.runIf(POSIX)('found on this computer (T-6)', () => {
  it('lists only regular kit files directly in Downloads, Desktop and home, newest first, by handle', async () => {
    const { path } = await kitOnDisk();
    const bytes = await readFile(path);
    await writeFile(join(t.home, 'Desktop', 'agentlink-recovery-kit-b.alkk'), bytes);
    await writeFile(join(t.home, 'agentlink-recovery-kit-c.alkk'), bytes);
    // Refused: a link, a wrong magic, a wrong name, a deeper folder, ~/.agentlink.
    await symlink(path, join(t.home, 'Desktop', 'agentlink-recovery-kit-link.alkk'));
    await writeFile(join(t.home, 'Downloads', 'agentlink-recovery-kit-x.alkk'), 'NOPE....');
    await writeFile(join(t.home, 'Downloads', 'kit.alkk'), bytes);
    await mkdir(join(t.home, 'Downloads', 'deep'));
    await writeFile(join(t.home, 'Downloads', 'deep', 'agentlink-recovery-kit-d.alkk'), bytes);
    await mkdir(join(t.home, '.agentlink'), { recursive: true });
    await writeFile(join(t.home, '.agentlink', 'agentlink-recovery-kit-e.alkk'), bytes);
    const found = await engine.found('S1');
    const kits = body(found)['kits'] as Record<string, unknown>[];
    expect(kits.map((k) => k['name']).sort()).toEqual([
      'agentlink-recovery-kit-2026-11-12.alkk',
      'agentlink-recovery-kit-b.alkk',
      'agentlink-recovery-kit-c.alkk',
    ]);
    for (const k of kits) {
      expect(Object.keys(k).sort()).toEqual(['folder', 'handle', 'modifiedAt', 'name', 'size']);
      expect(k['handle']).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(JSON.stringify(k)).not.toContain(t.home);
    }
  });

  it('a handle is bound to its page session and to 10 minutes', async () => {
    await kitOnDisk();
    const handle = await foundHandle('S1');
    expect(body(await engine.header('S2', { handle }))['error']).toBe('expired');
    clock += RESTORE_HANDLE_TTL_MS + 1;
    expect(body(await engine.header('S1', { handle }))['error']).toBe('expired');
  });

  it('a listed file swapped for a link or another file is refused (O_NOFOLLOW, fstat)', async () => {
    const { path, code: c } = await kitOnDisk();
    const handle = await foundHandle('S1');
    const moved = join(t.root, 'moved.alkk');
    await rename(path, moved);
    await symlink(moved, path);
    expect((await openKit('S1', handle, c)).status).not.toBe(200);
    const again = await foundHandle('S1').catch(() => undefined);
    expect(again).toBeUndefined();
    await (await import('node:fs/promises')).unlink(path);
    await writeFile(path, await readFile(moved));
    // Same name, another inode: the old handle no longer opens anything.
    expect((await openKit('S1', handle, c)).status).not.toBe(200);
  });
});

describe.runIf(POSIX)('header first (T-2, T-5)', () => {
  it('answers ok, not_a_kit, newer_version and other_owner before any code', async () => {
    const { path, owner } = await kitOnDisk();
    const handle = await foundHandle();
    expect(body(await engine.header('S1', { handle }))).toEqual({
      header: 'ok',
      ownerPresent: false,
    });
    const bytes = new Uint8Array(await readFile(path));
    const newer = bytes.slice();
    newer[4] = 2;
    const up = await engine.upload('S1', [newer], newer.length);
    expect(body(await engine.header('S1', { handle: body(up)['handle'] as string }))).toEqual({
      header: 'newer_version',
      ownerPresent: false,
    });
    const junk = await engine.upload('S2', [encodeUtf8('hello world')], 11);
    expect(body(await engine.header('S2', { handle: body(junk)['handle'] as string }))).toEqual({
      header: 'not_a_kit',
      ownerPresent: false,
    });
    // An owner of another key on this computer: refused before the code (T-2).
    const other = await makeOwner(keychain);
    await engine.close();
    engine = newEngine({ knownOwner: other.keys.ownerNostr });
    const h2 = await foundHandle();
    expect(body(await engine.header('S1', { handle: h2 }))).toEqual({
      header: 'other_owner',
      ownerPresent: true,
    });
    const refused = await openKit('S1', h2, 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA');
    expect(body(refused)['error']).toBe('other_owner');
    expect(owner.keys.ownerNostr).not.toEqual(other.keys.ownerNostr);
  });

  it('the recovery-kit vectors pass through the route engine (header and open outcomes)', async () => {
    const vectors = JSON.parse(
      await readFile(
        new URL('../../../test-vectors/recovery-kit/vectors.json', import.meta.url),
        'utf8',
      ),
    ) as { cases: { input: Record<string, string>; expected: Record<string, string> }[] };
    let n = 0;
    for (const c of vectors.cases) {
      if (c.input['op'] !== 'header' && c.input['op'] !== 'open') continue;
      const kit = Uint8Array.from(Buffer.from(c.input['kit'] as string, 'hex'));
      const session = `V${String((n += 1))}`;
      const up = await engine.upload(session, [kit], kit.length);
      const handle = body(up)['handle'] as string;
      const header = body(await engine.header(session, { handle }))['header'];
      const rejected = c.expected['outcome'] === 'reject';
      if (c.input['op'] === 'header') {
        expect(header === 'ok', c.input['kit']?.slice(0, 16)).toBe(!rejected);
        continue;
      }
      if (header !== 'ok') {
        expect(rejected).toBe(true);
        continue;
      }
      const opened = await engine.open(session, { handle }, code(c.input['code'] as string));
      // The vector stores are not AgentLink stores: an authentic kit answers `damaged` (never
      // opened for a write), a refused one a fixed error; neither ever answers 200.
      expect(opened.status).not.toBe(200);
      if (!rejected) expect(body(opened)['error']).toBe('damaged');
      else expect(['wrong_code', 'damaged', 'wait']).toContain(body(opened)['error']);
      await engine.cancel(session, { kit: 'none' });
      clock += 16 * 60_000;
    }
    expect(n).toBeGreaterThan(40);
  }, 120_000);
});

describe.runIf(POSIX)('wrong code (T-4)', () => {
  it('three wrong codes, then a doubling wait shared by open and check; one generic answer', async () => {
    const { code: right } = await kitOnDisk();
    const handle = await foundHandle();
    const wrong = 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA';
    for (let i = 0; i < 3; i += 1) {
      const a = await openKit('S1', handle, wrong);
      expect(a.status).toBe(422);
      expect(a.body).toEqual({ error: 'wrong_code' });
    }
    const waited = await engine.check('S1', { handle }, code(right));
    expect(waited.status).toBe(429);
    expect(body(waited)).toEqual({ error: 'wait', retryAfter: 30 });
    clock += 30_000;
    expect((await openKit('S1', handle, wrong)).status).toBe(422);
    expect(body(await openKit('S1', handle, right))).toEqual({ error: 'wait', retryAfter: 60 });
    clock += 60_000;
    expect((await openKit('S1', handle, right)).status).toBe(200);
  });
});

describe.runIf(POSIX)('a computer without an owner (T-1, T-10, T-12)', () => {
  it('opens to a public summary with counts and dates only, and writes nothing without the gesture', async () => {
    const { code: c, agents } = await kitOnDisk([
      { name: 'helper', people: 2, lastAt: 1_761_000_000 },
    ]);
    const handle = await foundHandle();
    const opened = await openKit('S1', handle, c);
    expect(opened.status).toBe(200);
    const summary = body(opened)['summary'] as Record<string, unknown>;
    expect(summary['ids']).toEqual([
      {
        agentId: agents[0]?.agentId,
        name: 'helper',
        people: 2,
        lastMessageAt: 1_761_000_000,
        state: 'new',
      },
    ]);
    const kit = body(opened)['kit'] as string;
    const begun = await engine.applyBegin('S1', {
      kit,
      selection: [agents[0]?.agentId as string],
      names: {},
    });
    expect(body(begun)['status']).toBe('gesture');
    await expectNothingWritten();
    // A creation for another challenge, or without user verification, writes nothing.
    const pk = body(begun)['publicKey'] as { challenge: string; userId: string; prfSalt: string };
    const auth = new VirtualPrfAuthenticator({ credential: newWebauthnTestCredential() });
    const forged = webauthnCreate(
      auth,
      { ...pk, challenge: encodeBase64url(new Uint8Array(32)) },
      ORIGIN,
    );
    expect(
      body(await engine.applyFinish('S1', { nonce: body(begun)['nonce'] as string }, forged))[
        'error'
      ],
    ).toBe('presence_rejected');
    const noUv = webauthnCreate(new VirtualPrfAuthenticator({ uv: false }), pk, ORIGIN);
    expect(
      body(await engine.applyFinish('S1', { nonce: body(begun)['nonce'] as string }, noUv))[
        'error'
      ],
    ).toBe('presence_rejected');
    // Another page session cannot finish it.
    expect(
      body(
        await engine.applyFinish(
          'S2',
          { nonce: body(begun)['nonce'] as string },
          webauthnCreate(auth, pk, ORIGIN),
        ),
      )['error'],
    ).toBe('expired');
    await expectNothingWritten();
  });

  it('with the gesture restores the ID, the owner under a new master code and Touch ID; the code is shown once', async () => {
    const { code: c, agents, owner } = await kitOnDisk();
    const handle = await foundHandle();
    const kit = body(await openKit('S1', handle, c))['kit'] as string;
    const done = await gestureAndFinish('S1', kit, [agents[0]?.agentId as string]);
    expect(done['ids']).toEqual([
      { agentId: agents[0]?.agentId, name: 'helper', outcome: 'restored' },
    ]);
    expect(done['touchId']).toBe(true);
    const master = done['masterCode'] as string;
    expect(master).toMatch(/^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){5}$/);
    expect(master.replace(/-/g, '')).not.toBe(c.replace(/-/g, ''));
    expect(await ownerItemPresent(keychain)).toBe(true);
    expect(keychain.items.has(OWNER_PASSKEY_ACCOUNT)).toBe(true);
    expect(keychain.items.has(keychainAccount(agents[0]?.agentId as string, 'seed'))).toBe(true);
    const config = JSON.parse(
      await readFile(join(t.home, '.agentlink', 'agents', 'helper', 'config.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(config).toEqual({
      v: 1,
      name: 'helper',
      agentId: agents[0]?.agentId,
      keyStore: 'keychain',
    });
    expect(
      (await stat(join(t.home, '.agentlink', 'agents', 'helper', 'store.sqlite'))).mode & 0o777,
    ).toBe(0o600);
    // Single use: the kit is consumed and the code is in no later answer.
    expect(body(await engine.applyBegin('S1', { kit, selection: [], names: {} }))['error']).toBe(
      'expired',
    );
    const later = JSON.stringify(
      answers.slice(
        answers.indexOf(answers.find((a) => body(a)['masterCode'] !== undefined) as RestoreAnswer) +
          1,
      ),
    );
    expect(later).not.toContain(master);
    expect(owner.keys.ownerNostr.length).toBe(32);
    expect(await engine.restorePending()).toBe(false);
  });

  it('PRF only on get(): prf_needed with a second bound challenge; nothing is written before it', async () => {
    const { code: c, agents } = await kitOnDisk();
    const handle = await foundHandle();
    const kit = body(await openKit('S1', handle, c))['kit'] as string;
    const begun = await engine.applyBegin('S1', {
      kit,
      selection: [agents[0]?.agentId as string],
      names: {},
    });
    const pk = body(begun)['publicKey'] as { challenge: string; userId: string; prfSalt: string };
    const auth = new VirtualPrfAuthenticator({ credential: newWebauthnTestCredential() });
    const created = webauthnCreate(auth, pk, ORIGIN, false);
    const need = await engine.applyFinish(
      'S1',
      { nonce: body(begun)['nonce'] as string },
      created.slice(),
    );
    expect(body(need)['status']).toBe('prf_needed');
    await expectNothingWritten();
    const pk2 = body(need)['publicKey'] as {
      challenge: string;
      prfSalt: string;
      credentialId: string;
    };
    expect(pk2.challenge).not.toBe(pk.challenge);
    // A get() for the first challenge is refused.
    const stale = webauthnCreateThenGet(auth, created, { ...pk2, challenge: pk.challenge }, ORIGIN);
    expect(
      body(await engine.applyFinish('S1', { nonce: body(need)['nonce'] as string }, stale))[
        'error'
      ],
    ).toBe('presence_rejected');
    await expectNothingWritten();
    const good = webauthnCreateThenGet(auth, created, pk2, ORIGIN);
    const done = await engine.applyFinish('S1', { nonce: body(need)['nonce'] as string }, good);
    expect(body(done)['status']).toBe('done');
    expect(keychain.items.has(OWNER_PASSKEY_ACCOUNT)).toBe(true);
  });
});

describe.runIf(POSIX)('never overwrites (04 §2.3.3 table; T-8)', () => {
  it('already here, name taken (rename map), removed earlier; the whole map is checked before a write', async () => {
    const owner = await makeOwner();
    const { code: c, agents } = await kitOnDisk(
      [{ name: 'helper' }, { name: 'work' }, { name: 'old' }],
      owner,
    );
    const [a, b, gone] = agents as [(typeof agents)[0], (typeof agents)[0], (typeof agents)[0]];
    // `helper` is already here (same agentId); a different `work` folder exists; `old` was removed.
    for (const [name, id] of [
      ['helper', a.agentId],
      ['work', '0x' + '1'.repeat(40)],
    ] as const) {
      const dir = join(t.home, '.agentlink', 'agents', name);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(
        join(dir, 'config.json'),
        JSON.stringify({ v: 1, name, agentId: id, keyStore: 'keychain' }),
        { mode: 0o600 },
      );
    }
    await mkdir(join(t.home, '.agentlink', 'revoked'), { recursive: true, mode: 0o700 });
    await writeFile(join(t.home, '.agentlink', 'revoked', `${gone.agentId}.json`), '{}');
    const handle = await foundHandle();
    const opened = await openKit('S1', handle, c);
    const ids = (body(opened)['summary'] as { ids: Record<string, unknown>[] }).ids;
    const byId = (id: string) => ids.find((r) => r['agentId'] === id) as Record<string, unknown>;
    expect(byId(a.agentId)['state']).toBe('already_here');
    expect(byId(b.agentId)['state']).toBe('name_taken');
    expect(byId(b.agentId)['suggestedName']).toBe('work-2');
    expect(byId(gone.agentId)['state']).toBe('removed_earlier');
    const kit = body(opened)['kit'] as string;
    for (const bad of [
      { selection: [a.agentId], names: {} },
      { selection: [gone.agentId], names: {} },
      { selection: [b.agentId], names: {} },
      { selection: [b.agentId], names: { [b.agentId]: 'work' } },
      { selection: [b.agentId], names: { [b.agentId]: 'helper' } },
      { selection: [b.agentId], names: { [b.agentId]: 'Bad Name' } },
      { selection: [b.agentId, b.agentId], names: { [b.agentId]: 'work-2' } },
    ]) {
      const refused = await engine.applyBegin('S1', { kit, ...bad });
      expect(refused.status, JSON.stringify(bad)).toBe(400);
      expect(body(refused)['error']).toBe('invalid');
    }
    expect([...keychain.items.keys()]).toEqual([]);
    const done = await gestureAndFinish('S1', kit, [b.agentId], { [b.agentId]: 'work-2' });
    expect(done['ids']).toEqual([{ agentId: b.agentId, name: 'work-2', outcome: 'restored' }]);
    expect(keychain.items.has(keychainAccount(gone.agentId, 'seed'))).toBe(false);
    expect(keychain.items.has(keychainAccount(a.agentId, 'seed'))).toBe(false);
  });
});

describe.runIf(POSIX)('a computer with an owner (T-2; restore-only session)', () => {
  it('the restore session holds no seed, signs nothing and is bound to the header hash', async () => {
    const owner = await makeOwner(keychain);
    const { path } = await kitOnDisk(undefined, owner);
    const kitBytes = new Uint8Array(await readFile(path));
    const restore = await unlockForRestore(keychain, owner.keys.ownerNostr, {
      presence: { kind: 'passphrase', secret: owner.code.slice() },
      headerHash: headerHashOf(kitBytes),
    });
    expect(exportSeedOf(restore.session, restore.store).status).toBe('foreign');
    await expect(restore.session.signOwnerAction({ v: 1 })).rejects.toThrow();
    expect(restore.boundTo(headerHashOf(kitBytes))).toBe(true);
    expect(restore.boundTo(new Uint8Array(32))).toBe(false);
    restore.end();
    expect(restore.session.isActive()).toBe(false);
  });

  it('needs presence before open, refuses another header, then restores without a second gesture', async () => {
    const owner = await makeOwner(keychain);
    await engine.close();
    engine = newEngine({ knownOwner: owner.keys.ownerNostr });
    const { code: c, agents } = await kitOnDisk(undefined, owner);
    const handle = await foundHandle('S1', 'agentlink-recovery-kit-2026-11-12.alkk');
    expect(body(await engine.header('S1', { handle }))).toEqual({
      header: 'ok',
      ownerPresent: true,
    });
    expect(body(await openKit('S1', handle, c))['error']).toBe('presence_required');
    const wrong = await engine.presence(
      'S1',
      { handle },
      code('not-the-code-at-all'),
      'passphrase',
    );
    expect(body(wrong)['error']).toBe('presence_rejected');
    // Presence for another kit file (another header) does not open this one.
    await kitOnDisk([{ name: 'other' }], owner, 'agentlink-recovery-kit-other.alkk');
    const otherHandle = await foundHandle('S1', 'agentlink-recovery-kit-other.alkk');
    expect(
      (await engine.presence('S1', { handle: otherHandle }, owner.code.slice(), 'passphrase'))
        .status,
    ).toBe(200);
    expect(body(await openKit('S1', handle, c))['error']).toBe('presence_required');
    expect((await engine.presence('S1', { handle }, owner.code.slice(), 'passphrase')).status).toBe(
      200,
    );
    // Bound to its page session.
    expect(body(await openKit('S2', handle, c))['error']).toBe('expired');
    const opened = await openKit('S1', handle, c);
    expect(opened.status).toBe(200);
    const done = await engine.applyBegin('S1', {
      kit: body(opened)['kit'] as string,
      selection: [agents[0]?.agentId as string],
      names: {},
    });
    expect(body(done)['status']).toBe('done');
    expect(body(done)['masterCode']).toBeUndefined();
    expect(body(done)['touchId']).toBe('unchanged');
    expect(keychain.items.has(keychainAccount(agents[0]?.agentId as string, 'seed'))).toBe(true);
    // The owner item is kept as it was.
    expect(keychain.items.has(OWNER_ACCOUNT)).toBe(true);
  });
});

describe.runIf(POSIX)('the opened-kit hold (T-7)', () => {
  it('cancel wipes the kit and its quarantine; one opened kit per server; same session replaces', async () => {
    const { code: c, agents } = await kitOnDisk();
    const handle = await foundHandle('S1');
    const kit = body(await openKit('S1', handle, c))['kit'] as string;
    const h2 = await foundHandle('S2');
    expect(body(await openKit('S2', h2, c))['error']).toBe('busy');
    expect(body(await engine.check('S2', { handle: h2 }, code(c)))['error']).toBe('busy');
    const again = await openKit('S1', handle, c);
    expect(again.status).toBe(200);
    expect(body(await engine.applyBegin('S1', { kit, selection: [], names: {} }))['error']).toBe(
      'expired',
    );
    const kit2 = body(again)['kit'] as string;
    expect((await engine.cancel('S1', { kit: kit2 })).status).toBe(200);
    expect(
      body(
        await engine.applyBegin('S1', {
          kit: kit2,
          selection: [agents[0]?.agentId as string],
          names: {},
        }),
      )['error'],
    ).toBe('expired');
    const q = join(t.home, '.agentlink', 'restore');
    const left = await readdir(q).catch(() => [] as string[]);
    expect(left.filter((n) => n.startsWith('.restore-'))).toEqual([]);
    // After 10 minutes the hold ends by itself.
    await engine.cancel('S1', { kit: kit2 });
    const third = body(await openKit('S2', h2, c))['kit'] as string;
    clock += RESTORE_HANDLE_TTL_MS + 1;
    expect(
      body(
        await engine.applyBegin('S2', {
          kit: third,
          selection: [agents[0]?.agentId as string],
          names: {},
        }),
      )['error'],
    ).toBe('expired');
  });

  it('Check that my kit opens writes nothing and returns no kit handle', async () => {
    const { code: c } = await kitOnDisk([{ name: 'helper', people: 1 }]);
    const handle = await foundHandle();
    const checked = await engine.check('S1', { handle }, code(c));
    expect(checked.status).toBe(200);
    expect(body(checked)['kit']).toBeUndefined();
    expect((body(checked)['summary'] as { ids: unknown[] }).ids).toHaveLength(1);
    await expectNothingWritten();
    const q = join(t.home, '.agentlink', 'restore');
    expect(
      (await readdir(q).catch(() => [] as string[])).filter((n) => n.startsWith('.restore-')),
    ).toEqual([]);
  });
});

describe.runIf(POSIX)('a crash or failure part way (T-7)', () => {
  it('a failure between IDs keeps whole IDs only', async () => {
    const { code: c, agents } = await kitOnDisk([{ name: 'alpha' }, { name: 'beta' }]);
    const handle = await foundHandle();
    const kit = body(await openKit('S1', handle, c))['kit'] as string;
    const begun = await engine.applyBegin('S1', {
      kit,
      selection: agents.map((a) => a.agentId),
      names: {},
    });
    const pk = body(begun)['publicKey'] as { challenge: string; userId: string; prfSalt: string };
    const auth = new VirtualPrfAuthenticator({ credential: newWebauthnTestCredential() });
    // The first ID (kit order) writes its items; the second fails part way through its items.
    const first = [...agents].sort((x, y) => (x.agentId < y.agentId ? -1 : 1))[0]!;
    keychain.failAccount = keychainAccount(
      agents.find((a) => a.agentId !== first.agentId)!.agentId,
      'store-key',
    );
    const done = await engine.applyFinish(
      'S1',
      { nonce: body(begun)['nonce'] as string },
      webauthnCreate(auth, pk, ORIGIN),
    );
    const ids = body(done)['ids'] as { agentId: string; outcome: string }[];
    const second = agents.find((a) => a.agentId !== first.agentId)!;
    expect(ids.find((r) => r.agentId === first.agentId)?.outcome).toBe('restored');
    expect(ids.find((r) => r.agentId === second.agentId)?.outcome).toBe('failed');
    for (const item of ['seed', 'store-key', 'policy-version', 'receipts-kept', 'storage-mark']) {
      expect(keychain.items.has(keychainAccount(second.agentId, item))).toBe(false);
    }
    await expect(lstat(join(t.home, '.agentlink', 'agents', second.name))).rejects.toThrow();
    expect(
      await readFile(join(t.home, '.agentlink', 'agents', first.name, 'config.json'), 'utf8'),
    ).toContain(first.agentId);
  });

  it('a crash between the agents and the owner: first run is held; owner-only completion with the same kit', async () => {
    const { code: c, agents, owner } = await kitOnDisk();
    const handle = await foundHandle();
    const kit = body(await openKit('S1', handle, c))['kit'] as string;
    const begun = await engine.applyBegin('S1', {
      kit,
      selection: [agents[0]?.agentId as string],
      names: {},
    });
    const pk = body(begun)['publicKey'] as { challenge: string; userId: string; prfSalt: string };
    const auth = new VirtualPrfAuthenticator({ credential: newWebauthnTestCredential() });
    // Six agent items, then the owner write fails.
    keychain.failAccount = OWNER_NEXT_ACCOUNT;
    const done = await engine.applyFinish(
      'S1',
      { nonce: body(begun)['nonce'] as string },
      webauthnCreate(auth, pk, ORIGIN),
    );
    expect(done.status).toBe(500);
    expect(body(done)['masterCode']).toBeUndefined();
    expect(await ownerItemPresent(keychain)).toBe(false);
    expect(await engine.restorePending()).toBe(true);
    keychain.failAccount = undefined;
    // A kit of another owner cannot complete it.
    const stranger = await kitOnDisk([{ name: 'x' }], undefined, 'agentlink-recovery-kit-x.alkk');
    expect(stranger.owner.keys.ownerNostr).not.toEqual(owner.keys.ownerNostr);
    const sh = await foundHandle('S1', 'agentlink-recovery-kit-x.alkk');
    const strangerOpen = await openKit('S1', sh, stranger.code);
    expect(body(strangerOpen)['error']).toBe('other_owner');
    // The same kit: every ID is already here; an empty selection completes the owner only.
    const again = await makeKit(
      t.root,
      owner,
      agents,
      'agentlink-recovery-kit-again.alkk',
      join(t.home, 'Desktop'),
    );
    const h3 = await foundHandle('S1', 'agentlink-recovery-kit-again.alkk');
    const reopened = await openKit('S1', h3, again.code);
    expect(
      (body(reopened)['summary'] as { ids: { state: string }[] }).ids.map((r) => r.state),
    ).toEqual(['already_here']);
    const completed = await gestureAndFinish('S1', body(reopened)['kit'] as string, []);
    expect(completed['ids']).toEqual([]);
    expect(completed['masterCode']).toMatch(/^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){5}$/);
    expect(await ownerItemPresent(keychain)).toBe(true);
    expect(await engine.restorePending()).toBe(false);
  });
});

describe.runIf(POSIX)('uploads (T-5, T-6, T-7)', () => {
  it('streams into a 0600 file under ~/.agentlink with the cap enforced while reading; limits per session and in all', async () => {
    await engine.close();
    engine = newEngine({ maxUpload: 1000 });
    async function* chunks(n: number) {
      for (let i = 0; i < n; i += 1) yield new Uint8Array(100);
    }
    expect(body(await engine.upload('S1', chunks(11), undefined))['error']).toBe('too_large');
    expect(body(await engine.upload('S1', chunks(1), 5000))['error']).toBe('too_large');
    const a = await engine.upload('S1', chunks(5), 500);
    expect(a.status).toBe(200);
    const dir = join(t.home, '.agentlink', 'restore');
    const files = (await readdir(dir)).filter((n) => n.startsWith('.upload-'));
    expect(files).toHaveLength(1);
    expect((await stat(join(dir, files[0] as string))).mode & 0o777).toBe(0o600);
    // A new upload of the same session replaces the old one.
    expect((await engine.upload('S1', chunks(4), 400)).status).toBe(200);
    expect((await readdir(dir)).filter((n) => n.startsWith('.upload-'))).toHaveLength(1);
    expect(body(await engine.header('S1', { handle: body(a)['handle'] as string }))['error']).toBe(
      'expired',
    );
    // Two in all, and together within the cap.
    expect((await engine.upload('S2', chunks(5), 500)).status).toBe(200);
    expect(body(await engine.upload('S3', chunks(1), 100))['error']).toBe('busy');
    expect(body(await engine.upload('S2', chunks(7), 700))['error']).toBe('too_large');
  });

  it('removes stale uploads and quarantine files at start-up', async () => {
    const dir = join(t.home, '.agentlink', 'restore');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, '.upload-0123456789abcdef.alkk'), 'x');
    await writeFile(join(dir, '.restore-0123456789abcdef.sqlite'), 'x');
    await engine.close();
    engine = newEngine();
    await engine.found('S1');
    expect(await readdir(dir)).toEqual([]);
  });
});

describe.runIf(POSIX)('the exact log and error surface (T-3, T-11)', () => {
  it('no answer carries the code, a path, a seed or a library message', async () => {
    const { code: c, agents, owner } = await kitOnDisk();
    const handle = await foundHandle();
    await openKit('S1', handle, 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA');
    const kit = body(await openKit('S1', handle, c))['kit'] as string;
    await gestureAndFinish('S1', kit, [agents[0]?.agentId as string]);
    await engine.header('S1', { handle: 'x'.repeat(22) });
    await engine.applyBegin('S1', { kit: 'nope', selection: 'all', names: [] } as never);
    const text = JSON.stringify(answers);
    expect(text).not.toContain(c);
    expect(text).not.toContain(c.replace(/-/g, ''));
    expect(text).not.toContain(t.home);
    expect(text).not.toContain(t.root);
    expect(text).not.toContain(encodeHex(owner.seed));
    expect(text).not.toContain(encodeBase64url(owner.seed));
    for (const a of answers) {
      const error = body(a)['error'];
      if (error !== undefined) {
        expect([
          'not_a_kit',
          'newer_version',
          'other_owner',
          'wrong_code',
          'damaged',
          'wait',
          'busy',
          'presence_required',
          'presence_rejected',
          'needs_terminal',
          'expired',
          'too_large',
          'invalid',
          'failed',
        ]).toContain(error);
      }
    }
    expect(decodeBase64url(kit).length).toBe(16);
  });
});

describe.runIf(POSIX)('the export handle for Check after a save (WP-R2 hook, T-6)', () => {
  it('opens only the file just sealed, and only for the kit ID it sealed', async () => {
    const { path, code: c, kitId } = await kitOnDisk();
    const handle = await engine.registerExportedKit('S1', { path, kitId });
    expect(handle).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const checked = await engine.check('S1', { handle: handle as string }, code(c));
    expect(checked.status).toBe(200);
    // Single use.
    expect(body(await engine.check('S1', { handle: handle as string }, code(c)))['error']).toBe(
      'expired',
    );
    const wrongId = await engine.registerExportedKit('S1', {
      path,
      kitId: encodeBase64url(new Uint8Array(16)),
    });
    expect(body(await engine.check('S1', { handle: wrongId as string }, code(c)))['error']).toBe(
      'damaged',
    );
    // Never opened by `open` (it is for Check only).
    const h3 = await engine.registerExportedKit('S1', { path, kitId });
    expect(body(await openKit('S1', h3 as string, c))['error']).toBe('expired');
  });
});

// --- The terminal (06 §8 `agentlink restore`) -----------------------------------------------------

const TEXT: RestoreTerminalText = {
  noKit: 'no kit',
  pickKit: 'which',
  kitLine: (n, name) => `${String(n)} ${name}`,
  errors: Object.fromEntries(
    [
      'not_a_kit',
      'newer_version',
      'other_owner',
      'wrong_code',
      'damaged',
      'wait',
      'busy',
      'presence_required',
      'presence_rejected',
      'needs_terminal',
      'expired',
      'too_large',
      'invalid',
      'failed',
    ].map((k) => [k, `error ${k}`]),
  ) as RestoreTerminalText['errors'],
  masterCodePrompt: 'master code',
  recoveryCodePrompt: 'recovery code',
  checkOpens: 'This kit opens.',
  idLine: (name, state, people) => `${name} ${state} ${String(people)}`,
  newName: (name, suggested) => `rename ${name} ${suggested}`,
  confirm: (n) => `restore ${String(n)}?`,
  nothingToRestore: 'nothing',
  outcomeLine: (name, outcome) => `${name} ${outcome}`,
  masterCodeShown: 'new master code:',
  savedIt: 'saved?',
  nextSteps: 'next',
};

/** A scripted owner terminal: answers in order; records everything written. */
function scripted(answers: string[]) {
  const written: string[] = [];
  const terminal: RestoreTerminal = {
    write: (text) => void written.push(text),
    readSecret: () => Promise.resolve(encodeUtf8(answers.shift() ?? '')),
    confirm: () => Promise.resolve(/^y/i.test(answers.shift() ?? '')),
    readText: () => Promise.resolve(answers.shift() ?? ''),
    clearScreen: () => void written.push('<clear>'),
  };
  return { terminal, written };
}

const terminalEngine = () =>
  createTerminalRestore({ home: t.home, keychain: () => keychain, origin: 'terminal', kdf: FAST });

describe.runIf(POSIX)('the terminal: agentlink restore (06 §8)', () => {
  it('restores a kit on a clean computer and shows the new master code once, then clears', async () => {
    const { code: c, agents, path } = await kitOnDisk([{ name: 'helper', people: 1 }]);
    const { terminal, written } = scripted([c, 'yes', 'yes']);
    expect(
      await runRestoreInTerminal(terminalEngine(), terminal, { file: path, check: false }, TEXT),
    ).toBe('restored');
    const config = await readFile(
      join(t.home, '.agentlink', 'agents', 'helper', 'config.json'),
      'utf8',
    );
    expect(config).toContain(agents[0]?.agentId);
    const shown = written.join('\n');
    expect(shown).toMatch(/[A-Z2-7]{4}(?:-[A-Z2-7]{4}){5}/);
    expect(shown).not.toContain(c);
    expect(written).toContain('<clear>');
    expect(await ownerItemPresent(keychain)).toBe(true);
  });

  it('--check without a file offers the kit found, opens it and writes nothing', async () => {
    const { code: c } = await kitOnDisk();
    const { terminal, written } = scripted([c]);
    expect(await runRestoreInTerminal(terminalEngine(), terminal, { check: true }, TEXT)).toBe(
      'checked',
    );
    expect(written).toContain('This kit opens.');
    await expectNothingWritten();
  });

  it('three wrong codes end with nothing written and no code echoed; No at the confirm writes nothing', async () => {
    const { path, code: c } = await kitOnDisk();
    const wrong = 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA';
    const first = scripted([wrong, wrong, wrong]);
    expect(
      await runRestoreInTerminal(
        terminalEngine(),
        first.terminal,
        { file: path, check: false },
        TEXT,
      ),
    ).toBe('refused');
    expect(first.written.join('\n')).not.toContain(wrong);
    await expectNothingWritten();
    clock += 30 * 60_000;
    const second = scripted([c, 'no']);
    expect(
      await runRestoreInTerminal(
        terminalEngine(),
        second.terminal,
        { file: path, check: false },
        TEXT,
      ),
    ).toBe('cancelled');
    await expectNothingWritten();
  });

  it('a file argument that is a link is refused', async () => {
    const { path } = await kitOnDisk();
    const link = join(t.root, 'agentlink-recovery-kit-link.alkk');
    await symlink(path, link);
    const { terminal, written } = scripted([]);
    expect(
      await runRestoreInTerminal(terminalEngine(), terminal, { file: link, check: false }, TEXT),
    ).toBe('refused');
    expect(written).toEqual(['error not_a_kit']);
  });
});

describe('the route engine has no path to an owner without the gesture (T-1)', () => {
  it('createRestoreEngine offers neither the terminal apply nor a path handle', () => {
    const routeEngine = createRestoreEngine({
      home: t.home,
      keychain: () => keychain,
      origin: ORIGIN,
    });
    expect(Object.keys(routeEngine)).not.toContain('applyInTerminal');
    expect(Object.keys(routeEngine)).not.toContain('fileHandle');
    expect(Object.isFrozen(routeEngine)).toBe(true);
    void routeEngine.close();
  });
});
