// REL051-SF3 (04 §2.3.3 "Restore in the app", "Restore never overwrites", T-2, T-4, T-6, T-7; §2.5
// shared presence backoff): restore hardening. Temporary HOME and an in-memory keychain only.
//
// - A lone `owner-passkey` item on a computer with no `owner` item: restore ends owned (the same
//   owner's item is replaced in the same apply) or refuses before anything is written (another
//   owner's item); first run is sent to "Finish restoring", never left refused for good.
// - The header and the kit come from one descriptor; bytes that change under it are refused.
// - A second restore engine never removes another live engine's files; an apply whose every
//   selected ID failed never creates the owner or answers `done`.
// - Stale files of dead runs go deterministically when the engine sweeps (server start, after an
//   apply), not lazily on a first request.
// - Restore presence counts wrong proofs on the shared presence backoff when one is given.
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { encodeUtf8, randomBytes, type JsonValue } from '@4thtech-io/crypto';
import { newWebauthnTestCredential } from '@4thtech-io/crypto/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OWNER_ACCOUNT, OWNER_PASSKEY_ACCOUNT, ownerItemPresent } from './owner-keystore.js';
import { storeOwnerPasskeySeed } from './owner-passkey.js';
import { kitFolder } from './recovery-kit-export.js';
import { VirtualPrfAuthenticator } from './passkey-authenticator.fixture.js';
import {
  FAST,
  MemoryKeychain,
  makeAgent,
  makeKit,
  makeOwner,
  tempRoot,
  webauthnCreate,
  type TestOwner,
} from './recovery-kit-restore.fixture.js';
import {
  createRestoreEngine,
  createTerminalRestore,
  type RestoreAnswer,
  type RestoreEngine,
} from './recovery-kit-restore.js';

const ORIGIN = 'http://localhost:47821';
const POSIX = process.platform !== 'win32';
let t: Awaited<ReturnType<typeof tempRoot>>;
let keychain: MemoryKeychain;
let engine: RestoreEngine;
const body = (a: RestoreAnswer): Record<string, unknown> => a.body as Record<string, unknown>;
const restoreDir = (): string => join(t.home, '.agentlink', 'restore');

beforeEach(async () => {
  t = await tempRoot('al-sf3-');
  keychain = new MemoryKeychain();
  engine = createRestoreEngine({
    home: t.home,
    keychain: () => keychain,
    origin: ORIGIN,
    kdf: FAST,
  });
});
afterEach(async () => {
  await engine.close();
  await t.cleanup();
});

async function handleOf(name: string, e: RestoreEngine = engine): Promise<string> {
  const kits = body(await e.found('S1'))['kits'] as { handle: string; name: string }[];
  return (kits.find((k) => k.name === name) as { handle: string }).handle;
}

/** A well-formed `owner-passkey` item of `owner` (a leftover of an earlier setup). */
async function plantPasskeyOf(owner: TestOwner): Promise<void> {
  await storeOwnerPasskeySeed(keychain, owner.seed, owner.keys, randomBytes(32), randomBytes(16));
}

/** Open, apply/begin, then the gesture: what the page does on an ownerless computer. */
async function applyNoOwner(
  kitName: string,
  code: string,
  selection: string[],
): Promise<{ header: RestoreAnswer; answer?: RestoreAnswer }> {
  const handle = await handleOf(kitName);
  const header = await engine.header('S1', { handle });
  if (body(header)['header'] !== 'ok') return { header };
  const opened = await engine.open('S1', { handle }, encodeUtf8(code));
  expect(opened.status).toBe(200);
  const begun = await engine.applyBegin('S1', {
    kit: body(opened)['kit'] as JsonValue,
    selection,
    names: {},
  });
  expect(body(begun)['status']).toBe('gesture');
  const auth = new VirtualPrfAuthenticator({ credential: newWebauthnTestCredential() });
  const pk = body(begun)['publicKey'] as { challenge: string; userId: string; prfSalt: string };
  const answer = await engine.applyFinish(
    'S1',
    { nonce: body(begun)['nonce'] as JsonValue },
    webauthnCreate(auth, pk, ORIGIN),
  );
  return { header, answer };
}

describe('R1-SEC-04: a lone owner-passkey item on a computer with no owner', () => {
  it("the same owner's leftover item is replaced: IDs and owner restored, first run free", async () => {
    const owner = await makeOwner();
    const a1 = await makeAgent(t.root, owner, 'alpha');
    const kit = await makeKit(
      t.root,
      owner,
      [a1],
      'agentlink-recovery-kit-a.alkk',
      join(t.home, 'Downloads'),
    );
    await plantPasskeyOf(owner);
    expect(await engine.firstRunHold()).toBe('finish_restore');
    const { answer } = await applyNoOwner('agentlink-recovery-kit-a.alkk', kit.code, [a1.agentId]);
    expect(answer?.status).toBe(200);
    expect(body(answer as RestoreAnswer)['status']).toBe('done');
    expect(await ownerItemPresent(keychain)).toBe(true);
    expect(
      (await lstat(join(t.home, '.agentlink', 'agents', 'alpha', 'config.json'))).isFile(),
    ).toBe(true);
    expect(await engine.firstRunHold()).toBeUndefined();
  });

  it('IDs already restored next to the leftover item: owner-only completion finishes', async () => {
    const owner = await makeOwner();
    const a1 = await makeAgent(t.root, owner, 'alpha');
    const kit = await makeKit(
      t.root,
      owner,
      [a1],
      'agentlink-recovery-kit-a.alkk',
      join(t.home, 'Downloads'),
    );
    // The state an earlier build left: the ID is here, the owner item never was.
    const first = await applyNoOwner('agentlink-recovery-kit-a.alkk', kit.code, [a1.agentId]);
    expect(body(first.answer as RestoreAnswer)['status']).toBe('done');
    await keychain.delete(OWNER_ACCOUNT);
    await keychain.delete(OWNER_PASSKEY_ACCOUNT);
    await plantPasskeyOf(owner);
    expect(await engine.firstRunHold()).toBe('finish_restore');
    const { answer } = await applyNoOwner('agentlink-recovery-kit-a.alkk', kit.code, []);
    expect(answer?.status).toBe(200);
    expect(body(answer as RestoreAnswer)['status']).toBe('done');
    expect(keychain.items.has(OWNER_ACCOUNT)).toBe(true);
    expect(await engine.firstRunHold()).toBeUndefined();
  });

  it("another owner's item is never replaced: refused before anything is written", async () => {
    const owner = await makeOwner();
    const other = await makeOwner();
    const a1 = await makeAgent(t.root, owner, 'alpha');
    const kit = await makeKit(
      t.root,
      owner,
      [a1],
      'agentlink-recovery-kit-a.alkk',
      join(t.home, 'Downloads'),
    );
    await plantPasskeyOf(other);
    const before = keychain.items.get(OWNER_PASSKEY_ACCOUNT)?.slice();
    const { header, answer } = await applyNoOwner('agentlink-recovery-kit-a.alkk', kit.code, [
      a1.agentId,
    ]);
    expect(answer).toBeUndefined();
    expect(body(header)['header']).toBe('other_owner');
    expect(keychain.items.has(OWNER_ACCOUNT)).toBe(false);
    expect(keychain.items.get(OWNER_PASSKEY_ACCOUNT)).toEqual(before);
    await expect(stat(join(t.home, '.agentlink', 'agents', 'alpha'))).rejects.toThrow();
  });

  it('a damaged leftover item (not an owner key) does not hold the restore', async () => {
    const owner = await makeOwner();
    const a1 = await makeAgent(t.root, owner, 'alpha');
    const kit = await makeKit(
      t.root,
      owner,
      [a1],
      'agentlink-recovery-kit-a.alkk',
      join(t.home, 'Downloads'),
    );
    keychain.items.set(OWNER_PASSKEY_ACCOUNT, new Uint8Array([1, 2, 3]));
    const { answer } = await applyNoOwner('agentlink-recovery-kit-a.alkk', kit.code, [a1.agentId]);
    expect(body(answer as RestoreAnswer)['status']).toBe('done');
    expect(await ownerItemPresent(keychain)).toBe(true);
  });
});

describe('R1-SEC-06: the header and the kit come from one descriptor', () => {
  it.runIf(POSIX)('bytes changed under the open request are refused, never opened', async () => {
    const owner = await makeOwner(keychain);
    const a1 = await makeAgent(t.root, owner, 'alpha');
    const a2 = await makeAgent(t.root, owner, 'bravo');
    const A = await makeKit(
      t.root,
      owner,
      [a1],
      'agentlink-recovery-kit-a.alkk',
      join(t.home, 'Downloads'),
    );
    const B = await makeKit(
      t.root,
      owner,
      [a2],
      'agentlink-recovery-kit-b.alkk',
      join(t.root, 'x'),
    );
    const bytesB = await readFile(B.path);
    expect((await readFile(A.path)).length).toBe(bytesB.length);
    const when = new Date(1_800_000_000_000);
    await utimes(A.path, when, when);
    const handle = await handleOf('agentlink-recovery-kit-a.alkk');
    expect((await engine.presence('S1', { handle }, owner.code.slice(), 'passphrase')).status).toBe(
      200,
    );
    let armed = true;
    const get = keychain.get.bind(keychain);
    keychain.get = async (account: string) => {
      if (armed) {
        armed = false;
        await writeFile(A.path, bytesB, { flag: 'r+' });
        await utimes(A.path, when, when);
      }
      return get(account);
    };
    const opened = await engine.open('S1', { handle }, encodeUtf8(B.code));
    expect(opened.status).not.toBe(200);
    expect(JSON.stringify(opened.body)).not.toContain('bravo');
  });
});

describe('R1-SEC-07: a second restore engine and an apply that lost its kit', () => {
  it("another engine starting keeps this engine's quarantined kit", async () => {
    const owner = await makeOwner();
    const a1 = await makeAgent(t.root, owner, 'alpha');
    const A = await makeKit(
      t.root,
      owner,
      [a1],
      'agentlink-recovery-kit-a.alkk',
      join(t.home, 'Downloads'),
    );
    const handle = await handleOf('agentlink-recovery-kit-a.alkk');
    expect((await engine.open('S1', { handle }, encodeUtf8(A.code))).status).toBe(200);
    expect(await readdir(restoreDir())).toHaveLength(1);
    const other = createTerminalRestore({
      home: t.home,
      keychain: () => keychain,
      origin: 'terminal',
      kdf: FAST,
    });
    await other.found('terminal');
    await other.close();
    expect(await readdir(restoreDir())).toHaveLength(1);
  });

  it('every selected ID failing never creates the owner and never answers done', async () => {
    const owner = await makeOwner();
    const a1 = await makeAgent(t.root, owner, 'alpha');
    const A = await makeKit(
      t.root,
      owner,
      [a1],
      'agentlink-recovery-kit-a.alkk',
      join(t.home, 'Downloads'),
    );
    const handle = await handleOf('agentlink-recovery-kit-a.alkk');
    const opened = await engine.open('S1', { handle }, encodeUtf8(A.code));
    // The quarantined snapshot is gone (lost state).
    for (const name of await readdir(restoreDir())) await unlink(join(restoreDir(), name));
    const begun = await engine.applyBegin('S1', {
      kit: body(opened)['kit'] as JsonValue,
      selection: [a1.agentId],
      names: {},
    });
    const auth = new VirtualPrfAuthenticator({ credential: newWebauthnTestCredential() });
    const pk = body(begun)['publicKey'] as { challenge: string; userId: string; prfSalt: string };
    const done = await engine.applyFinish(
      'S1',
      { nonce: body(begun)['nonce'] as JsonValue },
      webauthnCreate(auth, pk, ORIGIN),
    );
    expect(done.status).not.toBe(200);
    expect(body(done)['status']).not.toBe('done');
    expect(body(done)['masterCode']).toBeUndefined();
    expect(await ownerItemPresent(keychain)).toBe(false);
  });
});

describe('R1-SEC-08: stale restore files are swept deterministically', () => {
  it('sweep() removes files of dead runs and keeps nothing else', async () => {
    await mkdir(restoreDir(), { recursive: true });
    await writeFile(join(restoreDir(), '.upload-0123456789abcdef.alkk'), 'x');
    await writeFile(join(restoreDir(), '.restore-0123456789abcdef.sqlite'), 'x');
    // A pid that cannot be alive (above every OS's pid range).
    await writeFile(join(restoreDir(), '.upload-4194999-0123456789abcdef.alkk'), 'x');
    await engine.sweep();
    expect(await readdir(restoreDir())).toEqual([]);
  });

  it('an apply leaves no file of its own behind', async () => {
    const owner = await makeOwner();
    const a1 = await makeAgent(t.root, owner, 'alpha');
    const A = await makeKit(
      t.root,
      owner,
      [a1],
      'agentlink-recovery-kit-a.alkk',
      join(t.home, 'Downloads'),
    );
    const { answer } = await applyNoOwner('agentlink-recovery-kit-a.alkk', A.code, [a1.agentId]);
    expect(body(answer as RestoreAnswer)['status']).toBe('done');
    expect(await readdir(restoreDir())).toEqual([]);
  });
});

describe('R1-SEC-17: restore presence shares the presence backoff', () => {
  it('wrong proofs count on the shared counter, and its wait holds restore presence', async () => {
    const owner = await makeOwner(keychain);
    const a1 = await makeAgent(t.root, owner, 'alpha');
    await makeKit(t.root, owner, [a1], 'agentlink-recovery-kit-a.alkk', join(t.home, 'Downloads'));
    let failures = 0;
    let wait = 0;
    let successes = 0;
    const shared = createRestoreEngine({
      home: t.home,
      keychain: () => keychain,
      origin: ORIGIN,
      kdf: FAST,
      presenceBackoff: {
        waitSeconds: () => wait,
        failed: () => {
          failures += 1;
        },
        succeeded: () => {
          successes += 1;
        },
      },
    });
    try {
      const handle = await handleOf('agentlink-recovery-kit-a.alkk', shared);
      const wrong = await shared.presence('S1', { handle }, encodeUtf8('WRONG-CODE'), 'passphrase');
      expect(body(wrong)['error']).toBe('presence_rejected');
      expect(failures).toBe(1);
      wait = 30;
      const held = await shared.presence('S1', { handle }, owner.code.slice(), 'passphrase');
      expect(body(held)['error']).toBe('wait');
      wait = 0;
      expect(
        (await shared.presence('S1', { handle }, owner.code.slice(), 'passphrase')).status,
      ).toBe(200);
      expect(successes).toBe(1);
    } finally {
      await shared.close();
    }
  });
});

describe('R1-SEC-09: the kit is saved into a real Downloads folder only', () => {
  it.runIf(POSIX)(
    'a Downloads that is a link is not followed: the home folder is used',
    async () => {
      const elsewhere = join(t.root, 'synced');
      await mkdir(elsewhere);
      const home = join(t.root, 'home2');
      await mkdir(home);
      await symlink(elsewhere, join(home, 'Downloads'));
      expect(await kitFolder(home)).toEqual({ path: home, shown: 'Home' });
    },
  );

  it('a real Downloads folder is used', async () => {
    expect(await kitFolder(t.home)).toEqual({
      path: join(t.home, 'Downloads'),
      shown: 'Downloads',
    });
  });
});
