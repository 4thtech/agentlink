// MemoryKeyStore and MemoryOwnerKeyStore (M1-1g): the KeyStore contract of 03 §3 with G-2's
// additions (signEnvelopeHash, decryption epochs), owner presence (04 §2.5) and wiping (04 §8.3).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bip340Verify } from './bip340.js';
import { decodeHex, encodeHex, encodeUtf8 } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { sha256, taggedHash, TAGS } from './hash.js';
import { canonicalizeToBytes, type JsonObject } from './jcs.js';
import {
  KeyStoreError,
  OWNER_SESSION_DEFAULT_TTL_MS,
  OWNER_SESSION_MAX_TTL_MS,
  type KeyStore,
  type OwnerPresence,
} from './keystore-api.js';
import { KEY_LABELS, derivePublicIdentity, derivePublicKey, deriveSecretKey } from './keys.js';
import { MemoryKeyStore, MemoryOwnerKeyStore } from './memory-keystore.js';
import { nip44ConversationKey, nip44DecryptWithKey, nip44EncryptWithKey } from './nip44.js';
import { verifyNostrEvent } from './nostr-event.js';

const SEED_A = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const SEED_B = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
const OWNER_SEED = Uint8Array.from({ length: 32 }, (_, i) => 77 ^ i);

const nostrHex = (seed: Uint8Array, epoch = 0): string =>
  encodeHex(derivePublicIdentity(seed, epoch).agentNostr);

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof KeyStoreError || error instanceof CryptoInputError) return error.code;
    throw error;
  }
  return 'accepted';
}

const passphrase = (text: string): OwnerPresence => ({
  kind: 'passphrase',
  secret: encodeUtf8(text),
});

describe('MemoryKeyStore', () => {
  let a: MemoryKeyStore;
  let b: MemoryKeyStore;
  beforeEach(() => {
    a = new MemoryKeyStore(SEED_A);
    b = new MemoryKeyStore(SEED_B, { keyEpoch: 2 });
  });

  it('is a KeyStore', () => {
    const asInterface: KeyStore = a;
    expect(typeof asInterface.nip44Encrypt).toBe('function');
  });

  it('copies the seed: wiping the caller buffer does not change the store', async () => {
    const seed = SEED_A.slice();
    const store = new MemoryKeyStore(seed);
    seed.fill(0);
    expect(await store.getPublicBundle()).toEqual(derivePublicIdentity(SEED_A, 0));
  });

  it('refuses a seed that is not 32 bytes and an invalid epoch', () => {
    expect(() => new MemoryKeyStore(new Uint8Array(31))).toThrow(CryptoInputError);
    expect(() => new MemoryKeyStore(SEED_A, { keyEpoch: -1 })).toThrow(CryptoInputError);
    expect(() => new MemoryKeyStore(SEED_A, { keyEpoch: 2 ** 32 })).toThrow(CryptoInputError);
  });

  it('getPublicBundle is the public identity at the current epoch', async () => {
    expect(await a.getPublicBundle()).toEqual(derivePublicIdentity(SEED_A, 0));
    expect(await b.getPublicBundle()).toEqual(derivePublicIdentity(SEED_B, 2));
  });

  it('keeps the seed in a private field, unreachable by enumeration or JSON', () => {
    const json = JSON.stringify(a);
    expect(json).not.toContain(encodeHex(SEED_A));
    for (const name of Object.getOwnPropertyNames(a)) {
      expect((a as unknown as Record<string, unknown>)[name]).not.toBeInstanceOf(Uint8Array);
    }
  });

  describe('signNostr', () => {
    it('signs with the Nostr key of the current epoch', async () => {
      const event = await b.signNostr({ kind: 13, created_at: 1760000000, tags: [], content: 'x' });
      expect(event.pubkey).toBe(nostrHex(SEED_B, 2));
      expect(verifyNostrEvent(event)).toBe(true);
    });

    it('refuses a malformed event', async () => {
      const bad = { kind: 'x', created_at: 0, tags: [], content: '' } as never;
      expect(await codeOf(() => a.signNostr(bad))).toBe('invalid_argument');
    });
  });

  describe('signEnvelopeHash (G-2)', () => {
    it('is BIP-340 by the Nostr key over taggedHash("agentlink/envelope/v1", envelopeHash)', async () => {
      const envelopeHash = sha256(encodeUtf8('envelope'));
      const sig = await b.signEnvelopeHash(envelopeHash);
      expect(sig).toMatch(/^[0-9a-f]{128}$/);
      const pub = decodeHex(nostrHex(SEED_B, 2));
      expect(bip340Verify(pub, taggedHash(TAGS.envelope, envelopeHash), decodeHex(sig))).toBe(true);
      // Domain separation: not a signature over the bare hash or under the owner-action tag.
      expect(bip340Verify(pub, envelopeHash, decodeHex(sig))).toBe(false);
      expect(bip340Verify(pub, taggedHash(TAGS.ownerAction, envelopeHash), decodeHex(sig))).toBe(
        false,
      );
    });

    it('refuses anything but 32 bytes', async () => {
      expect(await codeOf(() => a.signEnvelopeHash(new Uint8Array(31)))).toBe('invalid_length');
      expect(await codeOf(() => a.signEnvelopeHash('00' as never))).toBe('invalid_argument');
    });
  });

  describe('nip44Encrypt / nip44Decrypt', () => {
    it('round-trips between two stores, the conversation key derived inside', async () => {
      const payload = await a.nip44Encrypt(nostrHex(SEED_B, 2), 'hello b');
      expect(await b.nip44Decrypt(nostrHex(SEED_A), payload)).toBe('hello b');
    });

    it('matches the low-level NIP-44 functions on the derived keys', async () => {
      const payload = await a.nip44Encrypt(nostrHex(SEED_B, 2), 'interop');
      const skB = deriveSecretKey(SEED_B, KEY_LABELS.nostr, 2);
      const ck = nip44ConversationKey(skB, decodeHex(nostrHex(SEED_A)));
      expect(nip44DecryptWithKey(ck, payload)).toBe('interop');
      const back = nip44EncryptWithKey(ck, 'reply');
      expect(await a.nip44Decrypt(nostrHex(SEED_B, 2), back)).toBe('reply');
    });

    it('decrypts with an older epoch on request, never a later one', async () => {
      const b0 = new MemoryKeyStore(SEED_B, { keyEpoch: 0 });
      const toOld = await a.nip44Encrypt(nostrHex(SEED_B, 0), 'old');
      expect(await b0.nip44Decrypt(nostrHex(SEED_A), toOld)).toBe('old');
      expect(await b.nip44Decrypt(nostrHex(SEED_A), toOld, { epoch: 0 })).toBe('old');
      expect(await codeOf(() => b.nip44Decrypt(nostrHex(SEED_A), toOld))).toBe('decrypt_failed');
      expect(await codeOf(() => b.nip44Decrypt(nostrHex(SEED_A), toOld, { epoch: 3 }))).toBe(
        'epoch_unavailable',
      );
      expect(await codeOf(() => b.nip44Decrypt(nostrHex(SEED_A), toOld, { epoch: -1 }))).toBe(
        'invalid_argument',
      );
    });

    it('refuses a peer key that is not 64 lowercase hex or not on the curve', async () => {
      const upper = nostrHex(SEED_B).toUpperCase();
      expect(await codeOf(() => a.nip44Encrypt(upper, 'x'))).toBe('invalid_hex');
      expect(await codeOf(() => a.nip44Encrypt('0x' + nostrHex(SEED_B), 'x'))).toBe('invalid_hex');
      expect(await codeOf(() => a.nip44Encrypt('00'.repeat(31), 'x'))).toBe('invalid_length');
      expect(await codeOf(() => a.nip44Encrypt('00'.repeat(32), 'x'))).toBe('invalid_public_key');
    });

    it('refuses a tampered payload', async () => {
      const payload = await a.nip44Encrypt(nostrHex(SEED_B, 2), 'hello b');
      const flipped = payload.slice(0, 60) + (payload[60] === 'A' ? 'B' : 'A') + payload.slice(61);
      expect(await codeOf(() => b.nip44Decrypt(nostrHex(SEED_A), flipped))).toBe('decrypt_failed');
    });
  });

  it('sign712 and hpkeOpen fail closed until their cards land (M1-1e, M1-1c)', async () => {
    const typed = { domain: {}, types: {}, primaryType: 'X', message: {} };
    expect(await codeOf(() => a.sign712(typed))).toBe('unsupported_operation');
    const wrapped = { enc: new Uint8Array(32), wk: new Uint8Array(48) };
    expect(await codeOf(() => a.hpkeOpen(wrapped, new Uint8Array(0)))).toBe(
      'unsupported_operation',
    );
  });

  describe('close', () => {
    it('refuses every operation afterwards, and is idempotent', async () => {
      const peer = nostrHex(SEED_B, 2);
      const payload = await a.nip44Encrypt(peer, 'x');
      await a.close();
      await a.close();
      const event = { kind: 1, created_at: 0, tags: [], content: '' };
      for (const op of [
        () => a.getPublicBundle(),
        () => a.signNostr(event),
        () => a.signEnvelopeHash(new Uint8Array(32)),
        () => a.nip44Encrypt(peer, 'x'),
        () => a.nip44Decrypt(peer, payload),
      ]) {
        expect(await codeOf(op)).toBe('keystore_closed');
      }
    });

    it('wipes the seed copy it holds', async () => {
      const filled: Uint8Array[] = [];
      const original = Uint8Array.prototype.fill;
      const spy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
        this: Uint8Array,
        ...args: Parameters<Uint8Array['fill']>
      ) {
        filled.push(this);
        return original.apply(this, args);
      });
      try {
        const store = new MemoryKeyStore(SEED_A);
        await store.close();
      } finally {
        spy.mockRestore();
      }
      const wipedSeeds = filled.filter(
        (buffer) => buffer.length === 32 && buffer.every((x) => x === 0),
      );
      expect(wipedSeeds.length).toBeGreaterThan(0);
    });
  });
});

describe('MemoryOwnerKeyStore', () => {
  const CODE = 'test-owner-code';
  let owner: MemoryOwnerKeyStore;
  const ownerNostr = encodeHex(
    (derivePublicKey(OWNER_SEED, KEY_LABELS.nostr, 0) as { publicKey: Uint8Array }).publicKey,
  );
  const action = (overrides: Record<string, unknown> = {}): JsonObject =>
    ({
      v: 1,
      agent: '0x' + '11'.repeat(20),
      owner: ownerNostr,
      op: 'approval.decide',
      params: {
        approvalId: 'AAAAAAAAAAAAAAAAAAAAAA',
        actionDigest: 'ab'.repeat(32),
        decision: 'approve',
      },
      nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
      issuedAt: 1760000000,
      expiresAt: 1760000600,
      ...overrides,
    }) as unknown as JsonObject;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
    owner = new MemoryOwnerKeyStore(OWNER_SEED, passphrase(CODE));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives the owner public keys without presence; they are public only', async () => {
    const keys = await owner.getPublicKeys();
    expect(Object.keys(keys).sort()).toEqual(['ownerEnc', 'ownerEvm', 'ownerNostr']);
    expect(encodeHex(keys.ownerNostr)).toBe(ownerNostr);
  });

  it('has no signing method of its own: signing needs a session from unlock(presence)', () => {
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(owner)).filter(
      (name) => name !== 'constructor',
    );
    expect(methods.sort()).toEqual(['close', 'getPublicKeys', 'lock', 'unlock']);
  });

  it('refuses unlock without a presence proof', async () => {
    for (const presence of [
      undefined,
      null,
      {},
      { kind: 'passphrase' },
      { kind: 'passphrase', secret: 'text' },
      { kind: 'passphrase', secret: new Uint8Array(0) },
      { kind: 'passkey-prf', prfOutput: new Uint8Array(16) },
      { kind: 'environment', secret: new Uint8Array(8) },
    ]) {
      expect(await codeOf(() => owner.unlock(presence as never))).toBe('presence_required');
    }
  });

  it('refuses a wrong proof and a proof of the other kind', async () => {
    expect(await codeOf(() => owner.unlock(passphrase('wrong')))).toBe('presence_rejected');
    const prf: OwnerPresence = { kind: 'passkey-prf', prfOutput: new Uint8Array(32).fill(1) };
    expect(await codeOf(() => owner.unlock(prf))).toBe('presence_rejected');
  });

  it('wipes the presence secret it was given, accepted or not', async () => {
    const good = passphrase(CODE);
    const bad = passphrase('wrong');
    await owner.unlock(good);
    await codeOf(() => owner.unlock(bad));
    expect(good.kind === 'passphrase' && good.secret.every((x) => x === 0)).toBe(true);
    expect(bad.kind === 'passphrase' && bad.secret.every((x) => x === 0)).toBe(true);
  });

  it('signs an owner action per 04 §2.5.1 inside an unlocked session', async () => {
    const session = await owner.unlock(passphrase(CODE));
    const body = action();
    const sig = await session.signOwnerAction(body);
    expect(sig).toMatch(/^[0-9a-f]{128}$/);
    const digest = taggedHash(TAGS.ownerAction, sha256(canonicalizeToBytes(body)));
    expect(bip340Verify(decodeHex(ownerNostr), digest, decodeHex(sig))).toBe(true);
  });

  it('refuses to sign an action that names another owner or another version', async () => {
    const session = await owner.unlock(passphrase(CODE));
    expect(await codeOf(() => session.signOwnerAction(action({ owner: 'ab'.repeat(32) })))).toBe(
      'invalid_argument',
    );
    expect(await codeOf(() => session.signOwnerAction(action({ v: 2 })))).toBe('invalid_argument');
    expect(await codeOf(() => session.signOwnerAction([] as never))).toBe('invalid_argument');
  });

  it('session handles expire (default TTL) and then fail closed', async () => {
    const session = await owner.unlock(passphrase(CODE));
    expect(session.expiresAt).toBe(Date.now() + OWNER_SESSION_DEFAULT_TTL_MS);
    vi.advanceTimersByTime(OWNER_SESSION_DEFAULT_TTL_MS - 1);
    expect(session.isActive()).toBe(true);
    await session.signOwnerAction(action());
    vi.advanceTimersByTime(1);
    expect(session.isActive()).toBe(false);
    expect(await codeOf(() => session.signOwnerAction(action()))).toBe('owner_locked');
  });

  it('accepts a shorter TTL and refuses one above the maximum', async () => {
    const session = await owner.unlock(passphrase(CODE), { ttlMs: 1000 });
    vi.advanceTimersByTime(1000);
    expect(await codeOf(() => session.signOwnerAction(action()))).toBe('owner_locked');
    for (const ttlMs of [0, -1, 1.5, OWNER_SESSION_MAX_TTL_MS + 1]) {
      expect(await codeOf(() => owner.unlock(passphrase(CODE), { ttlMs }))).toBe(
        'invalid_argument',
      );
    }
  });

  it('expiry wipes the session key even if the handle is never used again', async () => {
    const filled: Uint8Array[] = [];
    const original = Uint8Array.prototype.fill;
    await owner.unlock(passphrase(CODE), { ttlMs: 1000 });
    const spy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
      this: Uint8Array,
      ...args: Parameters<Uint8Array['fill']>
    ) {
      filled.push(this);
      return original.apply(this, args);
    });
    try {
      vi.advanceTimersByTime(1000);
    } finally {
      spy.mockRestore();
    }
    expect(filled.some((buffer) => buffer.length === 32 && buffer.every((x) => x === 0))).toBe(
      true,
    );
  });

  it('lock ends every session at once', async () => {
    const one = await owner.unlock(passphrase(CODE));
    const two = await owner.unlock(passphrase(CODE));
    await owner.lock();
    expect(await codeOf(() => one.signOwnerAction(action()))).toBe('owner_locked');
    expect(await codeOf(() => two.signOwnerAction(action()))).toBe('owner_locked');
    const three = await owner.unlock(passphrase(CODE));
    expect(await three.signOwnerAction(action())).toMatch(/^[0-9a-f]{128}$/);
  });

  it('closing a session ends only that session', async () => {
    const one = await owner.unlock(passphrase(CODE));
    const two = await owner.unlock(passphrase(CODE));
    await one.close();
    expect(await codeOf(() => one.signOwnerAction(action()))).toBe('owner_locked');
    expect(await two.signOwnerAction(action())).toMatch(/^[0-9a-f]{128}$/);
  });

  it('owner sign712 fails closed until M1-1e', async () => {
    const session = await owner.unlock(passphrase(CODE));
    const typed = { domain: {}, types: {}, primaryType: 'AgentCard', message: {} };
    expect(await codeOf(() => session.sign712(typed))).toBe('unsupported_operation');
  });

  it('close locks and refuses any further unlock', async () => {
    const session = await owner.unlock(passphrase(CODE));
    await owner.close();
    expect(await codeOf(() => session.signOwnerAction(action()))).toBe('owner_locked');
    expect(await codeOf(() => owner.unlock(passphrase(CODE)))).toBe('keystore_closed');
    expect(await codeOf(() => owner.getPublicKeys())).toBe('keystore_closed');
  });

  it('a passkey-PRF presence unlocks a store configured for it', async () => {
    const prf = new Uint8Array(32).fill(5);
    const store = new MemoryOwnerKeyStore(OWNER_SEED, { kind: 'passkey-prf', prfOutput: prf });
    const session = await store.unlock({ kind: 'passkey-prf', prfOutput: prf.slice() });
    expect(await session.signOwnerAction(action())).toMatch(/^[0-9a-f]{128}$/);
  });
});
