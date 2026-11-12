// REL051-CF3 (R1-CLASS-04; 04 §2.3.3 "Restore in the app", T-7, T-12; D-147 (5)): the app is closed
// right after "Restore 1 ID", before the new master code reached the page. The next start must never
// leave a computer that asks for a master code nobody was shown. Temporary HOME and an in-memory
// keychain only.
//
// - The restore writes a marker (no secret: the kind, the stage, the owner key, the SHA-256 of the
//   owner item it wrote and its process) before the owner item, and marks it `shown` once the code
//   is in its answer. The marker goes when the owner says "I saved it" or replaces the code.
// - On the next start (`settle`), an owner item that is exactly the one a gone restore wrote, whose
//   code never left the server and that has no Touch ID, is removed again: the IDs stay and first run
//   says "Finish restoring" (owner-only completion with the same kit gives a new master code).
// - Anything else is kept: an owner with Touch ID (the page then offers a new master code), an owner
//   item that is not the restore's, a live run's marker.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeUtf8, type JsonValue } from '@4thtech-io/crypto';
import { newWebauthnTestCredential } from '@4thtech-io/crypto/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readUnsavedMarker, removeUnsavedMarker } from './master-code-unsaved.js';
import { OWNER_ACCOUNT, OWNER_PASSKEY_ACCOUNT } from './owner-keystore.js';
import { VirtualPrfAuthenticator } from './passkey-authenticator.fixture.js';
import {
  FAST,
  MemoryKeychain,
  makeAgent,
  makeKit,
  makeOwner,
  tempRoot,
  webauthnCreate,
} from './recovery-kit-restore.fixture.js';
import {
  createRestoreEngine,
  type RestoreAnswer,
  type RestoreEngine,
  type RestoreEngineOptions,
} from './recovery-kit-restore.js';

const ORIGIN = 'http://localhost:47821';
const KIT = 'agentlink-recovery-kit-a.alkk';
let t: Awaited<ReturnType<typeof tempRoot>>;
let keychain: HangingKeychain;
const engines: RestoreEngine[] = [];
const body = (a: RestoreAnswer): Record<string, unknown> => a.body as Record<string, unknown>;

/** A keychain whose set() of one account never answers (the process is closed at that write). */
class HangingKeychain extends MemoryKeychain {
  hangAccount: string | undefined;
  override set(account: string, value: Uint8Array): Promise<void> {
    if (account === this.hangAccount) return new Promise<void>(() => undefined);
    return super.set(account, value);
  }
}

function engineOf(over: Partial<RestoreEngineOptions> = {}): RestoreEngine {
  const e = createRestoreEngine({
    home: t.home,
    keychain: () => keychain,
    origin: ORIGIN,
    kdf: FAST,
    ...over,
  });
  engines.push(e);
  return e;
}

beforeEach(async () => {
  t = await tempRoot('al-cf3-');
  keychain = new HangingKeychain();
});
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.close().catch(() => undefined)));
  await t.cleanup();
});

/** Open, apply/begin, then the gesture: the page's "Restore 1 ID" on an ownerless computer. */
async function restoreClick(
  engine: RestoreEngine,
  code: string,
  selection: string[],
): Promise<Promise<RestoreAnswer>> {
  const kits = body(await engine.found('S1'))['kits'] as { handle: string; name: string }[];
  const handle = (kits.find((k) => k.name === KIT) as { handle: string }).handle;
  expect(body(await engine.header('S1', { handle }))['header']).toBe('ok');
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
  return engine.applyFinish(
    'S1',
    { nonce: body(begun)['nonce'] as JsonValue },
    webauthnCreate(auth, pk, ORIGIN),
  );
}

async function until(what: string, check: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function oneIdKit() {
  const owner = await makeOwner();
  const a1 = await makeAgent(t.root, owner, 'alpha');
  const kit = await makeKit(t.root, owner, [a1], KIT, join(t.home, 'Downloads'));
  return { owner, a1, kit };
}

/** The app closed while the Touch ID wrap was being written: the owner item is there, no passkey. */
async function closedAfterOwnerItem(code: string, agentId: string): Promise<void> {
  keychain.hangAccount = OWNER_PASSKEY_ACCOUNT;
  const first = engineOf();
  void restoreClick(first, code, [agentId]).then((p) => void p.catch(() => undefined));
  await until('the owner item is written', () => keychain.items.has(OWNER_ACCOUNT));
  keychain.hangAccount = undefined;
}

describe('R1-CLASS-04: the app closed right after "Restore 1 ID"', () => {
  it('the restore marks the owner it is writing before the owner item exists (no secret in it)', async () => {
    const { a1, kit } = await oneIdKit();
    keychain.hangAccount = OWNER_ACCOUNT;
    const first = engineOf();
    void restoreClick(first, kit.code, [a1.agentId]).then((p) => void p.catch(() => undefined));
    await until(
      'the marker is written',
      async () => (await readUnsavedMarker(t.home)) !== undefined,
    );
    const marker = await readUnsavedMarker(t.home);
    expect(marker?.kind).toBe('restore');
    expect(marker?.stage).toBe('writing');
    const text = await readFile(join(t.home, '.agentlink', 'master-code-unsaved.json'), 'utf8');
    expect(text).not.toContain(kit.code);
    expect(text).not.toMatch(/[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}/);
  });

  it('next start: the owner item the code was never shown for goes; first run says Finish restoring', async () => {
    const { a1, kit } = await oneIdKit();
    await closedAfterOwnerItem(kit.code, a1.agentId);
    expect(keychain.items.has(OWNER_PASSKEY_ACCOUNT)).toBe(false);
    // Opened again (another process): the earlier run is gone.
    const next = engineOf({ runAlive: () => false });
    await next.settle();
    expect(keychain.items.has(OWNER_ACCOUNT)).toBe(false);
    expect(await readUnsavedMarker(t.home)).toBeUndefined();
    expect(await next.firstRunHold()).toBe('finish_restore');
    expect(await next.masterCodeState()).toEqual({ status: 'finish_restore' });
    // Finish restoring with the same kit: owner-only completion, a new master code shown once.
    const done = await await restoreClick(next, kit.code, []);
    expect(done.status).toBe(200);
    expect(body(done)['status']).toBe('done');
    expect(body(done)['masterCode']).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){5}$/);
    expect(keychain.items.has(OWNER_ACCOUNT)).toBe(true);
    expect(keychain.items.has(OWNER_PASSKEY_ACCOUNT)).toBe(true);
    expect(await next.firstRunHold()).toBeUndefined();
  });

  it('a Touch ID wrap was written too: the owner is kept and the page is told the code was never saved', async () => {
    const { a1, kit } = await oneIdKit();
    const first = engineOf();
    const done = await await restoreClick(first, kit.code, [a1.agentId]);
    expect(body(done)['status']).toBe('done');
    expect((await readUnsavedMarker(t.home))?.stage).toBe('shown');
    const next = engineOf({ runAlive: () => false });
    await next.settle();
    expect(keychain.items.has(OWNER_ACCOUNT)).toBe(true);
    expect(await next.masterCodeState()).toEqual({
      status: 'lost',
      kind: 'restore',
      touchId: true,
    });
    // "I saved it" (or a new master code) ends it.
    await removeUnsavedMarker(t.home);
    expect(await next.masterCodeState()).toEqual({ status: 'none' });
  });

  it('an owner item that is not the one the restore wrote is never removed', async () => {
    const { a1, kit } = await oneIdKit();
    await closedAfterOwnerItem(kit.code, a1.agentId);
    // Something replaced the owner item since (another setup): its bytes differ.
    const other = await makeOwner();
    keychain.items.set(OWNER_ACCOUNT, other.keychain.items.get(OWNER_ACCOUNT) as Uint8Array);
    const next = engineOf({ runAlive: () => false });
    await next.settle();
    expect(keychain.items.has(OWNER_ACCOUNT)).toBe(true);
  });

  it("a live run's marker is left alone (another process is still writing)", async () => {
    const { a1, kit } = await oneIdKit();
    await closedAfterOwnerItem(kit.code, a1.agentId);
    const next = engineOf({ runAlive: () => true });
    await next.settle();
    expect(keychain.items.has(OWNER_ACCOUNT)).toBe(true);
    expect((await readUnsavedMarker(t.home))?.stage).toBe('writing');
  });

  it('a damaged or linked marker is ignored and never removes anything', async () => {
    const { a1, kit } = await oneIdKit();
    await closedAfterOwnerItem(kit.code, a1.agentId);
    await writeFile(join(t.home, '.agentlink', 'master-code-unsaved.json'), '{"v":1}');
    const next = engineOf({ runAlive: () => false });
    await next.settle();
    expect(keychain.items.has(OWNER_ACCOUNT)).toBe(true);
  });
});
