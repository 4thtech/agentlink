// DESK-D12c acceptance (S2; D-145 phase 2; 04 §2.3.4 "Registration", §2.5 "Desktop app owner
// presence"; D-68; I-1, I-4, I-7). Native presence in core:
//
// - Registration is its own owner operation: the master code (or the passkey) once, the helper's
//   `create`, on macOS `check` (the key must refuse without a gesture) and one `ecdh setup`, on
//   Windows the one signature `create` folds in; the record stays in memory from `create` to the
//   seal (nothing is written in between); the `owner-native` item holds only the `ALKH` blob, read
//   back and opened once. A second registration is refused, never a replacement.
// - Presence: the record is rebuilt from the stored header, the helper runs once with a fixed
//   reason, and the released secret opens the blob for exactly one owner operation (one gesture =
//   one op), then it is wiped.
// - M1-8c (same OS user): an AI process that can read the keychain item and run the helper gets no
//   usable secret without the owner's gesture (the helper refuses: a stand-in that refuses), and no
//   guess opens the blob.
// - Windows Hello machines need no master code after registration.
// - Cross-type: ALKP in `owner-native`, ALKH in `owner-passkey`, the other platform's kind and
//   another owner are refused before the helper runs.
// The helper is a stand-in (no Secure Enclave, no TPM, no Touch ID or Windows Hello prompt); its
// records are the alkh vectors' test records. No real keychain item is touched.
import {
  KeyStoreError,
  NATIVE_PRESENCE_MACOS,
  NATIVE_PRESENCE_WINDOWS,
  concatBytes,
  decodeHex,
  encodeUtf8,
  equalBytes,
  ownerPrfSalt,
  randomBytes,
  readNativeBlobHeader,
  sha256,
  type OwnerPublicKeys,
} from '@4thtech-io/crypto';
import { openNativeSeed, sealPasskeySeed } from '@4thtech-io/crypto/keystore';
import { beforeAll, describe, expect, it } from 'vitest';
import type { KeychainBackend } from './keychain.js';
import type { NativeHelper, NativeReason } from './owner-native-helper.js';
import { MAC_RECORD, StandInHelper, WIN_RECORD, secretFor } from './owner-native.fixture.js';
import {
  OWNER_NATIVE_ACCOUNT,
  nativePresence,
  nativePresenceStatus,
  readOwnerNativeHeader,
  registerOwnerNative,
  replaceOwnerNative,
  storeOwnerNativeSeed,
  turnOffOwnerNative,
} from './owner-native.js';
import {
  KeychainOwnerKeyStore,
  OWNER_NATIVE_REVOKED_ACCOUNT,
  OWNER_PASSKEY_ACCOUNT,
  newOwnerSeed,
  storeOwnerSeed,
} from './owner-keystore.js';

const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
/** A same-user keychain stand-in in memory, logging every write. */
class MemoryKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  readonly writes: string[] = [];
  get(account: string): Promise<Uint8Array | null> {
    const v = this.items.get(account);
    return Promise.resolve(v === undefined ? null : v.slice());
  }
  set(account: string, value: Uint8Array): Promise<void> {
    this.writes.push(account);
    this.items.set(account, value.slice());
    return Promise.resolve();
  }
  delete(account: string): Promise<boolean> {
    return Promise.resolve(this.items.delete(account));
  }
}

const CODE = 'ABCD EFGH IJKL MNOP QRST UVWX';
let seedForTests: Uint8Array;
let owner: OwnerPublicKeys;

/** A fresh keychain with a master code item (as after setup or `owner init`). */
async function withOwner(): Promise<MemoryKeychain> {
  const keychain = new MemoryKeychain();
  await storeOwnerSeed(
    keychain,
    seedForTests,
    { secret: encodeUtf8(CODE), secretKind: 1 },
    { kdf: KDF },
  );
  keychain.writes.length = 0;
  return keychain;
}

const code = (): { kind: 'passphrase'; secret: Uint8Array } => ({
  kind: 'passphrase',
  secret: encodeUtf8(CODE),
});

async function codeOf(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeDefined();
  return (error as { code?: unknown; state?: unknown }).state ?? (error as { code?: unknown }).code;
}

/** One owner operation with native presence: the helper runs, the store unlocks once. */
async function nativeOp(
  keychain: MemoryKeychain,
  helper: NativeHelper,
  reason: NativeReason = 'approve',
) {
  const presence = await nativePresence(keychain, helper, owner.ownerNostr, reason);
  const store = await KeychainOwnerKeyStore.open(keychain, owner);
  try {
    const session = await store.unlock(presence);
    await session.close();
    return presence;
  } finally {
    await store.close();
  }
}

beforeAll(() => {
  const made = newOwnerSeed();
  seedForTests = made.seed;
  owner = made.keys;
});

describe('registration is its own owner operation (04 §2.3.4 "Registration")', () => {
  it('macOS: master code once, create, check, one ecdh setup; nothing written before the seal', async () => {
    const keychain = await withOwner();
    const helper = new StandInHelper(NATIVE_PRESENCE_MACOS, MAC_RECORD, keychain);
    await registerOwnerNative(keychain, helper, owner, code());
    // create and the gesture both happen before any keychain write: the record stays in memory.
    expect(helper.calls).toEqual(['create@0', 'check', 'release:setup@0']);
    expect(keychain.writes).toEqual([OWNER_NATIVE_ACCOUNT]);
    // check and ecdh got exactly the record create printed.
    for (const record of helper.records) expect(equalBytes(record, MAC_RECORD)).toBe(true);
    const header = await readOwnerNativeHeader(keychain);
    expect(header?.kind).toBe(NATIVE_PRESENCE_MACOS);
    expect(equalBytes(header?.ownerNostr ?? new Uint8Array(0), owner.ownerNostr)).toBe(true);
  });

  it('Windows: one gesture (the signature create folds in); no separate sign at registration', async () => {
    const keychain = await withOwner();
    const helper = new StandInHelper(NATIVE_PRESENCE_WINDOWS, WIN_RECORD, keychain);
    await registerOwnerNative(keychain, helper, owner, code());
    expect(helper.calls).toEqual(['create@0']);
    expect(keychain.writes).toEqual([OWNER_NATIVE_ACCOUNT]);
    expect((await readOwnerNativeHeader(keychain))?.kind).toBe(NATIVE_PRESENCE_WINDOWS);
  });

  it('a second registration is refused before the helper runs, never a replacement', async () => {
    const keychain = await withOwner();
    await registerOwnerNative(keychain, new StandInHelper(NATIVE_PRESENCE_MACOS), owner, code());
    const before = keychain.items.get(OWNER_NATIVE_ACCOUNT)?.slice();
    const again = new StandInHelper(NATIVE_PRESENCE_MACOS);
    expect(await codeOf(registerOwnerNative(keychain, again, owner, code()))).toBe(
      'owner_native_exists',
    );
    expect(again.calls).toEqual([]);
    expect(
      equalBytes(
        keychain.items.get(OWNER_NATIVE_ACCOUNT) ?? new Uint8Array(0),
        before ?? new Uint8Array(1),
      ),
    ).toBe(true);
  });

  it('a wrong master code is refused before the helper runs', async () => {
    const keychain = await withOwner();
    const helper = new StandInHelper(NATIVE_PRESENCE_MACOS);
    const wrong = {
      kind: 'passphrase' as const,
      secret: encodeUtf8('AAAA BBBB CCCC DDDD EEEE FFFF'),
    };
    expect(await codeOf(registerOwnerNative(keychain, helper, owner, wrong))).toBe(
      'presence_rejected',
    );
    expect(helper.calls).toEqual([]);
    expect(keychain.items.has(OWNER_NATIVE_ACCOUNT)).toBe(false);
  });

  it('macOS: a key that works without a gesture (check refuses) is never registered', async () => {
    const keychain = await withOwner();
    const helper = new StandInHelper(NATIVE_PRESENCE_MACOS);
    helper.checkState = 'reregister';
    expect(await codeOf(registerOwnerNative(keychain, helper, owner, code()))).toBe('reregister');
    expect(helper.calls).toEqual(['create@0', 'check']);
    expect(keychain.items.has(OWNER_NATIVE_ACCOUNT)).toBe(false);
  });

  it('a cancelled gesture or a refused Windows key stores nothing; Windows deletes its credential', async () => {
    const keychain = await withOwner();
    const mac = new StandInHelper(NATIVE_PRESENCE_MACOS);
    mac.gesture = 'cancelled';
    expect(await codeOf(registerOwnerNative(keychain, mac, owner, code()))).toBe('cancelled');
    const win = new StandInHelper(NATIVE_PRESENCE_WINDOWS);
    win.createState = 'unavailable'; // exit 16: not TPM-backed
    expect(await codeOf(registerOwnerNative(keychain, win, owner, code()))).toBe('unavailable');
    expect(keychain.items.has(OWNER_NATIVE_ACCOUNT)).toBe(false);
  });

  it('a create output the record reader refuses stores nothing (a swapped or malformed record)', async () => {
    const keychain = await withOwner();
    const g = decodeHex(
      '046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5',
    );
    const swapped = concatBytes(MAC_RECORD.subarray(0, MAC_RECORD.length - 65), g);
    const helper = new StandInHelper(NATIVE_PRESENCE_MACOS, swapped);
    await expect(registerOwnerNative(keychain, helper, owner, code())).rejects.toBeDefined();
    expect(helper.calls).toEqual(['create@0']);
    expect(keychain.items.has(OWNER_NATIVE_ACCOUNT)).toBe(false);
  });
});

describe('presence: one gesture = one owner operation (D-68)', () => {
  it('rebuilds the record from the header, runs the helper once with the fixed reason, unlocks once', async () => {
    const keychain = await withOwner();
    const helper = new StandInHelper(NATIVE_PRESENCE_MACOS);
    await registerOwnerNative(keychain, helper, owner, code());
    helper.calls.length = 0;
    helper.records.length = 0;
    const presence = await nativeOp(keychain, helper, 'approve');
    expect(helper.calls).toEqual(['release:approve@0']);
    expect(equalBytes(helper.records[0] ?? new Uint8Array(0), MAC_RECORD)).toBe(true);
    // The released secret is wiped by the unlock: the same presence cannot open a second operation.
    expect(presence.secret.every((b) => b === 0)).toBe(true);
    const store = await KeychainOwnerKeyStore.open(keychain, owner);
    expect(await codeOf(store.unlock(presence))).toBe('presence_rejected');
    await store.close();
    // A second operation is a second gesture.
    await nativeOp(keychain, helper, 'pay');
    expect(helper.calls).toEqual(['release:approve@0', 'release:pay@0']);
  });

  it('the reason is display-only: the same secret for setup, approve and pay', async () => {
    const helper = new StandInHelper(NATIVE_PRESENCE_MACOS);
    const keychain = await withOwner();
    await registerOwnerNative(keychain, helper, owner, code());
    for (const reason of ['setup', 'approve', 'pay', 'code'] as const)
      await nativeOp(keychain, helper, reason);
  });
});

describe('M1-8c: a same-user AI process gets no usable secret without the gesture', () => {
  it('the helper refuses without the owner (cancel, not interactive): no secret, no unlock', async () => {
    const keychain = await withOwner();
    const helper = new StandInHelper(NATIVE_PRESENCE_MACOS);
    await registerOwnerNative(keychain, helper, owner, code());
    for (const refusal of ['cancelled', 'failed', 'lockout'] as const) {
      helper.gesture = refusal;
      expect(await codeOf(nativePresence(keychain, helper, owner.ownerNostr, 'approve'))).toBe(
        refusal,
      );
    }
  });

  it('the blob it can read opens with no guess: random, zero, the public X coordinates, a passkey output', async () => {
    const keychain = await withOwner();
    await registerOwnerNative(keychain, new StandInHelper(NATIVE_PRESENCE_MACOS), owner, code());
    const blob = keychain.items.get(OWNER_NATIVE_ACCOUNT) ?? new Uint8Array(0);
    const header = readNativeBlobHeader(blob);
    const guesses = [
      randomBytes(32),
      new Uint8Array(32),
      header.credentialPublicKey.slice(1, 33),
      header.challenge.slice(1, 33),
      sha256(MAC_RECORD),
    ];
    for (const guess of guesses) {
      await expect(openNativeSeed(blob, guess)).rejects.toBeDefined();
      const store = await KeychainOwnerKeyStore.open(keychain, owner);
      const presence = {
        kind: 'native' as const,
        nativeKind: NATIVE_PRESENCE_MACOS as 1,
        secret: guess,
      };
      expect(await codeOf(store.unlock(presence))).toBe('presence_rejected');
      await store.close();
    }
  });
});

describe('Windows Hello machines need no master code after registration', () => {
  it('first-time setup (the held seed): one gesture, then every approval with Windows Hello only', async () => {
    const keychain = new MemoryKeychain();
    const made = newOwnerSeed();
    await storeOwnerSeed(
      keychain,
      made.seed,
      { secret: encodeUtf8(CODE), secretKind: 1 },
      { kdf: KDF },
    );
    const helper = new StandInHelper(NATIVE_PRESENCE_WINDOWS);
    await storeOwnerNativeSeed(keychain, helper, made.seed, made.keys);
    expect(helper.calls).toEqual(['create@0']);
    for (let i = 0; i < 3; i += 1) {
      const presence = await nativePresence(keychain, helper, made.keys.ownerNostr, 'approve');
      const store = await KeychainOwnerKeyStore.open(keychain, made.keys);
      await (await store.unlock(presence)).close();
      await store.close();
    }
    expect(helper.calls.filter((c) => c.startsWith('release'))).toHaveLength(3);
  });

  it('status says registered for this owner, and why not otherwise', async () => {
    const keychain = await withOwner();
    const helper = new StandInHelper(NATIVE_PRESENCE_WINDOWS);
    expect(await nativePresenceStatus(keychain, helper, owner.ownerNostr)).toEqual({
      available: true,
      registered: false,
    });
    await registerOwnerNative(keychain, helper, owner, code());
    expect(await nativePresenceStatus(keychain, helper, owner.ownerNostr)).toEqual({
      available: true,
      registered: true,
    });
    expect(await nativePresenceStatus(keychain, helper, new Uint8Array(32).fill(7))).toEqual({
      available: true,
      registered: false,
      reason: 'other_owner',
    });
    expect(await nativePresenceStatus(keychain, undefined, owner.ownerNostr)).toEqual({
      available: false,
      registered: false,
    });
  });
});

describe('unavailable, with a reason (WIN-HELLO-NATIVE)', () => {
  it('status carries the helper reason when Windows Hello is not set up, and never prompts', async () => {
    const keychain = await withOwner();
    const helper = new StandInHelper(NATIVE_PRESENCE_WINDOWS);
    helper.unavailable = 'not_set_up';
    expect(await nativePresenceStatus(keychain, helper, owner.ownerNostr)).toEqual({
      available: false,
      registered: false,
      unavailable: 'not_set_up',
    });
    helper.unavailable = 'no_secure_hardware';
    expect(await nativePresenceStatus(keychain, helper, owner.ownerNostr)).toEqual({
      available: false,
      registered: false,
      unavailable: 'no_secure_hardware',
    });
    expect(helper.availabilityCalls).toBeGreaterThan(0);
    expect(helper.calls).toEqual([]);
  });
});

describe('cross-type and cross-platform refusal, before the helper runs', () => {
  it('ALKP in owner-native, the other platform, another owner: presence_rejected, no prompt', async () => {
    const keychain = await withOwner();
    const prf = randomBytes(32);
    await keychain.set(
      OWNER_NATIVE_ACCOUNT,
      await sealPasskeySeed(prf, seedForTests, randomBytes(16)),
    );
    const helper = new StandInHelper(NATIVE_PRESENCE_MACOS);
    expect(await codeOf(nativePresence(keychain, helper, owner.ownerNostr, 'approve'))).toBe(
      'presence_rejected',
    );
    await keychain.delete(OWNER_NATIVE_ACCOUNT);
    await registerOwnerNative(keychain, helper, owner, code());
    helper.calls.length = 0;
    const win = new StandInHelper(NATIVE_PRESENCE_WINDOWS);
    expect(await codeOf(nativePresence(keychain, win, owner.ownerNostr, 'approve'))).toBe(
      'presence_rejected',
    );
    expect(
      await codeOf(nativePresence(keychain, helper, new Uint8Array(32).fill(9), 'approve')),
    ).toBe('presence_rejected');
    expect(win.calls).toEqual([]);
    expect(helper.calls).toEqual([]);
  });

  it('ALKH in owner-passkey does not open with the passkey path', async () => {
    const keychain = await withOwner();
    const helper = new StandInHelper(NATIVE_PRESENCE_MACOS);
    await registerOwnerNative(keychain, helper, owner, code());
    await keychain.set(
      OWNER_PASSKEY_ACCOUNT,
      keychain.items.get(OWNER_NATIVE_ACCOUNT) ?? new Uint8Array(0),
    );
    const store = await KeychainOwnerKeyStore.open(keychain, owner);
    const secret = secretFor(NATIVE_PRESENCE_MACOS, MAC_RECORD);
    expect(await codeOf(store.unlock({ kind: 'passkey-prf', prfOutput: secret }))).toBe(
      'presence_rejected',
    );
    // A native presence whose kind is not the blob's is refused too.
    const wrongKind = {
      kind: 'native' as const,
      nativeKind: NATIVE_PRESENCE_WINDOWS as 2,
      secret: secretFor(NATIVE_PRESENCE_MACOS, MAC_RECORD),
    };
    expect(await codeOf(store.unlock(wrongKind))).toBe('presence_rejected');
    await store.close();
    expect(ownerPrfSalt().length).toBe(32);
  });

  it('a native presence never registers another native credential', async () => {
    const keychain = await withOwner();
    const helper = new StandInHelper(NATIVE_PRESENCE_MACOS);
    const native = {
      kind: 'native' as const,
      nativeKind: NATIVE_PRESENCE_MACOS as 1,
      secret: randomBytes(32),
    };
    expect(await codeOf(registerOwnerNative(keychain, helper, owner, native))).toBe(
      'presence_required',
    );
    expect(helper.calls).toEqual([]);
    expect(KeyStoreError).toBeDefined();
  });
});

describe('Fable review M1: turning it off, and on again after a biometry change', () => {
  it('off with the master code: the item goes, and a captured secret with its old blob is refused', async () => {
    const keychain = await withOwner();
    const helper = new StandInHelper(NATIVE_PRESENCE_WINDOWS);
    await registerOwnerNative(keychain, helper, owner, code());
    const oldBlob = keychain.items.get(OWNER_NATIVE_ACCOUNT)?.slice() ?? new Uint8Array(0);
    // A same-user process captured one released secret.
    const captured = (
      await nativePresence(keychain, helper, owner.ownerNostr, 'approve')
    ).secret.slice();
    await turnOffOwnerNative(keychain, helper, owner, code());
    expect(keychain.items.has(OWNER_NATIVE_ACCOUNT)).toBe(false);
    expect(keychain.items.get(OWNER_NATIVE_REVOKED_ACCOUNT)?.length).toBe(32);
    expect(helper.calls).toContain('remove');
    expect(await nativePresenceStatus(keychain, helper, owner.ownerNostr)).toEqual({
      available: true,
      registered: false,
    });
    // It writes the old blob back: core never opens it again, with or without the helper.
    await keychain.set(OWNER_NATIVE_ACCOUNT, oldBlob);
    helper.calls.length = 0;
    expect(await codeOf(nativePresence(keychain, helper, owner.ownerNostr, 'approve'))).toBe(
      'presence_rejected',
    );
    expect(helper.calls).toEqual([]);
    const store = await KeychainOwnerKeyStore.open(keychain, owner);
    const replay = {
      kind: 'native' as const,
      nativeKind: NATIVE_PRESENCE_WINDOWS as 2,
      secret: captured,
    };
    expect(await codeOf(store.unlock(replay))).toBe('presence_rejected');
    await store.close();
    expect((await nativePresenceStatus(keychain, helper, owner.ownerNostr)).reason).toBe('damaged');
  });

  it('off and replace are never approved with native presence itself, nor with a wrong code', async () => {
    const keychain = await withOwner();
    const helper = new StandInHelper(NATIVE_PRESENCE_MACOS);
    await registerOwnerNative(keychain, helper, owner, code());
    const native = await nativePresence(keychain, helper, owner.ownerNostr, 'approve');
    expect(await codeOf(turnOffOwnerNative(keychain, helper, owner, native))).toBe(
      'presence_required',
    );
    expect(
      await codeOf(
        replaceOwnerNative(keychain, helper, owner, { ...native, secret: native.secret.slice() }),
      ),
    ).toBe('presence_required');
    const wrong = {
      kind: 'passphrase' as const,
      secret: encodeUtf8('AAAA BBBB CCCC DDDD EEEE FFFF'),
    };
    expect(await codeOf(turnOffOwnerNative(keychain, helper, owner, wrong))).toBe(
      'presence_rejected',
    );
    expect(keychain.items.has(OWNER_NATIVE_ACCOUNT)).toBe(true);
    const empty = await withOwner();
    expect(await codeOf(turnOffOwnerNative(empty, helper, owner, code()))).toBe(
      'owner_native_missing',
    );
  });

  it('a changed fingerprint shows reregister; turning it on again replaces the credential and works', async () => {
    const keychain = await withOwner();
    const helper = new StandInHelper(NATIVE_PRESENCE_MACOS);
    await registerOwnerNative(keychain, helper, owner, code());
    const before = keychain.items.get(OWNER_NATIVE_ACCOUNT)?.slice() ?? new Uint8Array(0);
    helper.checkState = 'reregister';
    expect(await nativePresenceStatus(keychain, helper, owner.ownerNostr)).toEqual({
      available: true,
      registered: true,
      reason: 'reregister',
    });
    // The new Secure Enclave key: another record from create.
    const fresh = new StandInHelper(NATIVE_PRESENCE_MACOS, recordWithOtherHandle());
    await replaceOwnerNative(keychain, fresh, owner, code());
    const after = keychain.items.get(OWNER_NATIVE_ACCOUNT) ?? new Uint8Array(0);
    expect(equalBytes(after, before)).toBe(false);
    expect(keychain.items.get(OWNER_NATIVE_REVOKED_ACCOUNT)?.length).toBe(32);
    await nativeOp(keychain, fresh, 'approve');
    // The replaced blob is revoked.
    await keychain.set(OWNER_NATIVE_ACCOUNT, before);
    expect(await codeOf(nativePresence(keychain, helper, owner.ownerNostr, 'approve'))).toBe(
      'presence_rejected',
    );
  });
});

describe('Fable review L1 and L5', () => {
  it('an abandoned operation: a late touch approves nothing', async () => {
    const keychain = await withOwner();
    const helper = new StandInHelper(NATIVE_PRESENCE_MACOS);
    await registerOwnerNative(keychain, helper, owner, code());
    helper.calls.length = 0;
    let touch: () => void = () => undefined;
    helper.touch = new Promise((resolve) => (touch = resolve));
    const abandoned = new AbortController();
    const pending = nativePresence(keychain, helper, owner.ownerNostr, 'approve', {
      signal: abandoned.signal,
    });
    // The prompt is up (the helper is waiting for the touch) when the page goes away.
    while (!helper.calls.some((c) => c.startsWith('release')))
      await new Promise((r) => setTimeout(r, 1));
    abandoned.abort();
    touch();
    expect(await codeOf(pending)).toBe('cancelled');
    expect(helper.aborted).toBe(1);
  });

  it('a keychain that cannot be read is not "not turned on"', async () => {
    const keychain = await withOwner();
    const failing: KeychainBackend = {
      get: () => Promise.reject(new Error('keychain locked')),
      set: () => Promise.reject(new Error('keychain locked')),
      delete: () => Promise.reject(new Error('keychain locked')),
    };
    const error = await nativePresence(
      failing,
      new StandInHelper(NATIVE_PRESENCE_MACOS),
      owner.ownerNostr,
      'approve',
    ).catch((e: unknown) => e);
    expect((error as { code?: unknown }).code).not.toBe('presence_rejected');
    expect(keychain).toBeDefined();
  });
});

/** The macOS test record with another (still valid) Secure Enclave handle: a new key after re-register. */
function recordWithOtherHandle(): Uint8Array {
  const out = MAC_RECORD.slice();
  out[3] = (out[3] as number) ^ 0xff;
  return out;
}

// DESK-NATIVE-DEBUG: each step of turning it on is named as it begins (for the one diagnostic line);
// a helper output core cannot use is the helper's fault, never "wrong master code"; and a write
// whose read-back fails leaves no `owner-native` item behind (the next try would say "already on").
describe('steps and failures of turning it on (DESK-NATIVE-DEBUG)', () => {
  it('names every step in order, on macOS', async () => {
    const keychain = await withOwner();
    const helper = new StandInHelper(NATIVE_PRESENCE_MACOS);
    const steps: string[] = [];
    await registerOwnerNative(keychain, helper, owner, code(), {
      onStep: (step) => steps.push(step),
    });
    expect(steps).toEqual([
      'already_on_check',
      'master_code',
      'already_on_check',
      'helper_create',
      'create_output',
      'helper_check',
      'helper_ecdh',
      'seal',
      'keychain_write',
      'keychain_read_back',
      'open_once',
    ]);
  });

  it('a wrong master code stops at master_code; a cancelled sheet at helper_ecdh', async () => {
    const keychain = await withOwner();
    const steps: string[] = [];
    const onStep = (step: string): number => steps.push(step);
    const wrong = {
      kind: 'passphrase' as const,
      secret: encodeUtf8('AAAA BBBB CCCC DDDD EEEE FFFF'),
    };
    await registerOwnerNative(keychain, new StandInHelper(1), owner, wrong, { onStep }).catch(
      () => undefined,
    );
    expect(steps.at(-1)).toBe('master_code');
    steps.length = 0;
    const helper = new StandInHelper(NATIVE_PRESENCE_MACOS);
    helper.gesture = 'cancelled';
    await registerOwnerNative(keychain, helper, owner, code(), { onStep }).catch(() => undefined);
    expect(steps.at(-1)).toBe('helper_ecdh');
  });

  it('a create output the record reader refuses is a helper error, not a wrong master code', async () => {
    const keychain = await withOwner();
    const helper = new StandInHelper(NATIVE_PRESENCE_MACOS, MAC_RECORD.subarray(0, 10));
    expect(await codeOf(registerOwnerNative(keychain, helper, owner, code()))).toBe('error');
  });

  it('a read-back that differs from the write removes the item again (no stale "already on")', async () => {
    const keychain = await withOwner();
    const real = keychain.get.bind(keychain);
    let reads = 0;
    keychain.get = (account: string) => {
      if (account !== OWNER_NATIVE_ACCOUNT) return real(account);
      reads += 1;
      // Two "already on" checks, then the read-back right after the write.
      return reads === 3 ? Promise.resolve(new Uint8Array([1, 2, 3])) : real(account);
    };
    const steps: string[] = [];
    expect(
      await codeOf(
        registerOwnerNative(keychain, new StandInHelper(1), owner, code(), {
          onStep: (step) => steps.push(step),
        }),
      ),
    ).toBe('keychain_failed');
    expect(steps.at(-1)).toBe('keychain_read_back');
    expect(keychain.items.has(OWNER_NATIVE_ACCOUNT)).toBe(false);
  });

  it('a keychain write that fails is named and leaves nothing behind', async () => {
    const keychain = await withOwner();
    keychain.set = () => Promise.reject(new Error('the native keychain message'));
    const steps: string[] = [];
    const error = await registerOwnerNative(keychain, new StandInHelper(1), owner, code(), {
      onStep: (step) => steps.push(step),
    }).catch((e: unknown) => e as { code?: string; detail?: string; message?: string });
    expect([error?.code, error?.detail]).toEqual(['keychain_failed', 'refused']);
    expect(error?.message).not.toContain('native keychain message');
    expect(steps.at(-1)).toBe('keychain_write');
  });
});

// DESK-TOUCHID-FIX review (Fable L-1): a keychain write that timed out may still land. Core waits for
// it to settle (bounded) before rolling back, so nothing is left behind; if it never settles, the
// error says so (`unsure`: it may have been turned on) instead of "nothing changed".
describe('a keychain write that times out (DESK-TOUCHID-FIX review L-1)', () => {
  it('lands after the timeout: core waits for it, then removes it again', async () => {
    const keychain = await withOwner();
    const real = keychain.set.bind(keychain);
    keychain.set = (account: string, value: Uint8Array) =>
      account === OWNER_NATIVE_ACCOUNT
        ? new Promise<void>((resolve) =>
            setTimeout(() => void real(account, value).then(resolve), 150),
          )
        : real(account, value);
    const error = await registerOwnerNative(keychain, new StandInHelper(1), owner, code(), {
      timeoutMs: 100,
    }).catch((e: unknown) => e as { code?: string; detail?: string });
    expect([error?.code, error?.detail]).toEqual(['keychain_failed', 'timeout']);
    // Long after the late write landed: still nothing behind.
    await new Promise((r) => setTimeout(r, 200));
    expect(keychain.items.has(OWNER_NATIVE_ACCOUNT)).toBe(false);
  });

  it('never settles: the error is `unsure` (it may have been turned on)', async () => {
    const keychain = await withOwner();
    const real = keychain.set.bind(keychain);
    keychain.set = (account: string, value: Uint8Array) =>
      account === OWNER_NATIVE_ACCOUNT ? new Promise<void>(() => undefined) : real(account, value);
    const error = await registerOwnerNative(keychain, new StandInHelper(1), owner, code(), {
      timeoutMs: 100,
    }).catch((e: unknown) => e as { code?: string; detail?: string });
    expect([error?.code, error?.detail]).toEqual(['keychain_failed', 'unsure']);
  });
});

// DESK-TOUCHID-FIX review (Fable M-1): the abort signal reaches every helper call of turning it on
// (create, check, the setup gesture); an aborted registration stores nothing.
describe('an aborted registration (DESK-TOUCHID-FIX review M-1)', () => {
  it('passes the signal to the helper and stores nothing after an abort', async () => {
    const keychain = await withOwner();
    const helper = new StandInHelper(1);
    helper.touch = new Promise(() => undefined);
    helper.stopOnAbort = true;
    const stop = new AbortController();
    const pending = registerOwnerNative(keychain, helper, owner, code(), { signal: stop.signal });
    while (!helper.calls.some((c) => c.startsWith('release')))
      await new Promise((r) => setTimeout(r, 2));
    stop.abort();
    expect(await codeOf(pending)).toBe('cancelled');
    expect(helper.aborted).toBe(1);
    expect(helper.signals.every((s) => s === stop.signal)).toBe(true);
    expect(helper.signals.length).toBe(3);
    expect(keychain.items.has(OWNER_NATIVE_ACCOUNT)).toBe(false);
  });

  it('a touch that lands after the abort stores nothing', async () => {
    const keychain = await withOwner();
    const helper = new StandInHelper(1);
    let touch: () => void = () => undefined;
    helper.touch = new Promise((r) => (touch = r));
    const stop = new AbortController();
    const pending = registerOwnerNative(keychain, helper, owner, code(), { signal: stop.signal });
    while (!helper.calls.some((c) => c.startsWith('release')))
      await new Promise((r) => setTimeout(r, 2));
    stop.abort();
    touch();
    expect(await codeOf(pending)).toBe('cancelled');
    expect(keychain.items.has(OWNER_NATIVE_ACCOUNT)).toBe(false);
  });
});
