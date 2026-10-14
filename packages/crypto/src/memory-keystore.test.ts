// MemoryKeyStore and MemoryOwnerKeyStore (M1-1g): the KeyStore contract of 03 §3 and G-2 (04 §3.1.1:
// EnvelopeKeys on the KeyStore and the OwnerSession, epochs only on lookups and decryption), owner
// presence (04 §2.5) and wiping (04 §8.3).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bip340Verify } from './bip340.js';
import { decodeEcdsaSignature, recoverEvmAddress } from './ecdsa.js';
import { hashTypedData, type TypedData } from './eip712.js';
import { decodeHex, encodeHex, encodeUtf8 } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { createGiftWrap } from './gift-wrap.js';
import { wrapCek, type WrappedCek } from './hpke.js';
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
import { MemoryKeyStore, MemoryOwnerKeyStore } from './testing.js';
import { nip44ConversationKey, nip44DecryptWithKey, nip44EncryptWithKey } from './nip44.js';
import {
  NOSTR_KIND_AUTH,
  NOSTR_KIND_GIFT_WRAP,
  NOSTR_KIND_SEAL,
  verifyNostrEvent,
  type NostrEvent,
} from './nostr-event.js';

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

/** The EIP-712 example ("Ether Mail"), as any typed data a KeyStore may be asked to sign. */
const MAIL: TypedData = {
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ],
    Person: [
      { name: 'name', type: 'string' },
      { name: 'wallet', type: 'address' },
    ],
    Mail: [
      { name: 'from', type: 'Person' },
      { name: 'to', type: 'Person' },
      { name: 'contents', type: 'string' },
    ],
  },
  primaryType: 'Mail',
  domain: {
    name: 'Ether Mail',
    version: '1',
    chainId: 1,
    verifyingContract: '0xcccccccccccccccccccccccccccccccccccccccc',
  },
  message: {
    from: { name: 'Cow', wallet: '0xcd2a3d9f938e13cd947ec05abc7fe734df8dd826' },
    to: { name: 'Bob', wallet: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    contents: 'Hello, Bob!',
  },
};

/** The EVM address that produced a sign712 result. */
const signerOf = (typedData: TypedData, sig: string): Uint8Array =>
  recoverEvmAddress(hashTypedData(typedData).digest, decodeEcdsaSignature(sig));

const ENVELOPE_ID = Uint8Array.from({ length: 16 }, (_, i) => i);
const OTHER_ID = Uint8Array.from({ length: 16 }, (_, i) => 100 + i);
const CEK = Uint8Array.from({ length: 32 }, (_, i) => 0xc0 ^ i);
const WRAPPED = { enc: new Uint8Array(32).fill(1), wk: new Uint8Array(48).fill(2) };

/** A copy of `wrapped` with one byte of `field` flipped. */
const tamper = (wrapped: WrappedCek, field: 'enc' | 'wk'): WrappedCek => {
  const bytes = wrapped[field].slice();
  bytes[5] = (bytes[5] as number) ^ 1;
  return { ...wrapped, [field]: bytes };
};

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

  it('getPublicBundle({epoch}) gives an older epoch, never a later one (G-2, 04 §3.1.1 step 5)', async () => {
    expect(await b.getPublicBundle({ epoch: 0 })).toEqual(derivePublicIdentity(SEED_B, 0));
    expect(await b.getPublicBundle({ epoch: 1 })).toEqual(derivePublicIdentity(SEED_B, 1));
    expect(await b.getPublicBundle({ epoch: 2 })).toEqual(derivePublicIdentity(SEED_B, 2));
    expect(await codeOf(() => b.getPublicBundle({ epoch: 3 }))).toBe('epoch_unavailable');
    for (const epoch of [-1, 1.5, 2 ** 32, '0']) {
      expect(await codeOf(() => b.getPublicBundle({ epoch } as never))).toBe('invalid_argument');
    }
  });

  it('has no hpkeOpen: a KeyStore is never a general HPKE-open oracle (G-2, IR-M1-1c-1 F5)', () => {
    expect('hpkeOpen' in a).toBe(false);
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
      // A subclass that lies about its length is measured by its real bytes (M-1 pattern).
      class Lying extends Uint8Array {
        override get length(): number {
          return 32;
        }
      }
      expect(await codeOf(() => a.signEnvelopeHash(new Lying(31)))).toBe('invalid_length');
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

  describe('sign712', () => {
    it('signs with the agent EVM key, which is always epoch 0 (04 §2.1)', async () => {
      const sig = await b.sign712(MAIL);
      expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
      expect(signerOf(MAIL, sig)).toEqual(derivePublicIdentity(SEED_B, 2).agentEvm);
      expect(signerOf(MAIL, sig)).toEqual(derivePublicIdentity(SEED_B, 0).agentEvm);
    });

    it('refuses typed data that does not hash', async () => {
      const typed = { domain: {}, types: {}, primaryType: 'X', message: {} };
      expect(await codeOf(() => a.sign712(typed))).toBe('invalid_typed_data');
    });
  });

  describe('unwrapCek (G-2, M1-1c)', () => {
    it('opens its own entry at the current epoch and at an older one on request', async () => {
      const current = await wrapCek(derivePublicIdentity(SEED_B, 2).agentEnc, ENVELOPE_ID, CEK);
      expect(await b.unwrapCek(current, ENVELOPE_ID)).toEqual(CEK);
      const older = await wrapCek(derivePublicIdentity(SEED_B, 1).agentEnc, ENVELOPE_ID, CEK);
      expect(await b.unwrapCek(older, ENVELOPE_ID, { epoch: 1 })).toEqual(CEK);
    });

    it('fails closed with open_failed: wrong epoch, wrong envelope id, tampered wrap', async () => {
      const older = await wrapCek(derivePublicIdentity(SEED_B, 1).agentEnc, ENVELOPE_ID, CEK);
      expect(await codeOf(() => b.unwrapCek(older, ENVELOPE_ID))).toBe('open_failed');
      expect(await codeOf(() => b.unwrapCek(older, ENVELOPE_ID, { epoch: 0 }))).toBe('open_failed');
      expect(await codeOf(() => b.unwrapCek(older, OTHER_ID, { epoch: 1 }))).toBe('open_failed');
      for (const field of ['enc', 'wk'] as const) {
        expect(
          await codeOf(() => b.unwrapCek(tamper(older, field), ENVELOPE_ID, { epoch: 1 })),
        ).toBe('open_failed');
      }
      // Another agent's entry does not open either.
      expect(await codeOf(() => a.unwrapCek(older, ENVELOPE_ID))).toBe('open_failed');
    });

    it('never opens an owner entry (04 §3.1.1: an agent KeyStore holds no owner key)', async () => {
      const ownerEnc = (derivePublicKey(OWNER_SEED, KEY_LABELS.enc, 0) as { publicKey: Uint8Array })
        .publicKey;
      const ownerEntry = await wrapCek(ownerEnc, ENVELOPE_ID, CEK);
      expect(await codeOf(() => a.unwrapCek(ownerEntry, ENVELOPE_ID))).toBe('open_failed');
      expect(await codeOf(() => b.unwrapCek(ownerEntry, ENVELOPE_ID))).toBe('open_failed');
    });

    it('refuses an epoch above the current one or a malformed epoch, and malformed input', async () => {
      expect(await codeOf(() => b.unwrapCek(WRAPPED, ENVELOPE_ID, { epoch: 3 }))).toBe(
        'epoch_unavailable',
      );
      expect(await codeOf(() => b.unwrapCek(WRAPPED, ENVELOPE_ID, { epoch: -1 }))).toBe(
        'invalid_argument',
      );
      expect(await codeOf(() => b.unwrapCek(WRAPPED, new Uint8Array(15)))).toBe('invalid_length');
      expect(await codeOf(() => b.unwrapCek(null as never, ENVELOPE_ID))).toBe('invalid_argument');
    });
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
        () => a.sign712(MAIL),
        () => a.unwrapCek(WRAPPED, ENVELOPE_ID),
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

  it('checks owner and v on the bytes it signs: a getter cannot swap them (IR-M1-1g-G2-1 I-3)', async () => {
    const session = await owner.unlock(passphrase(CODE));
    const plain = action() as unknown as Record<string, unknown>;
    let reads = 0;
    const flipping: Record<string, unknown> = { ...plain };
    Object.defineProperty(flipping, 'owner', {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? ownerNostr : 'ab'.repeat(32);
      },
    });
    const sig = await session.signOwnerAction(flipping as unknown as JsonObject);
    expect(reads).toBe(1);
    // The signature covers exactly the body that passed the check.
    const digest = taggedHash(TAGS.ownerAction, sha256(canonicalizeToBytes(plain as JsonObject)));
    expect(bip340Verify(decodeHex(ownerNostr), digest, decodeHex(sig))).toBe(true);

    const proxy = new Proxy(plain, {
      get(object, key, receiver) {
        if (key === 'v') {
          reads += 1;
          return reads % 2 === 0 ? 1 : 2;
        }
        return Reflect.get(object, key, receiver) as unknown;
      },
    });
    // Whatever one read of v gives is what is checked and signed: here 2, so it is refused.
    reads = 0;
    expect(await codeOf(() => session.signOwnerAction(proxy as unknown as JsonObject))).toBe(
      'invalid_argument',
    );
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

  it('expiry wipes every session key (Nostr, EVM and enc) even if the handle is never used again', async () => {
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
    const wiped = new Set(
      filled.filter((buffer) => buffer.length === 32 && buffer.every((x) => x === 0)),
    );
    // The owner Nostr, EVM and enc keys the session held, each its own buffer.
    expect(wiped.size).toBe(3);
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

  it('lock ends every session even if a wipe fails, and reports the failure (IR-M1-1g-G2-1 I-2)', async () => {
    const one = await owner.unlock(passphrase(CODE));
    const two = await owner.unlock(passphrase(CODE));
    const original = Uint8Array.prototype.fill;
    let calls = 0;
    const spy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
      this: Uint8Array,
      ...args: Parameters<Uint8Array['fill']>
    ) {
      calls += 1;
      if (calls === 1) throw new TypeError('detached');
      return original.apply(this, args);
    });
    try {
      expect(await codeOf(() => owner.lock())).toBe('wipe_failed');
    } finally {
      spy.mockRestore();
    }
    expect(one.isActive()).toBe(false);
    expect(two.isActive()).toBe(false);
    expect(await codeOf(() => two.signOwnerAction(action()))).toBe('owner_locked');
  });

  it('closing a session ends only that session', async () => {
    const one = await owner.unlock(passphrase(CODE));
    const two = await owner.unlock(passphrase(CODE));
    await one.close();
    expect(await codeOf(() => one.signOwnerAction(action()))).toBe('owner_locked');
    expect(await two.signOwnerAction(action())).toMatch(/^[0-9a-f]{128}$/);
  });

  describe('owner channel (G-2, 04 §3.1.1)', () => {
    const agent = new MemoryKeyStore(SEED_A);
    const agentNostr = nostrHex(SEED_A);

    it('signs an envelope hash under the envelope tag, with the owner Nostr key', async () => {
      const session = await owner.unlock(passphrase(CODE));
      const envelopeHash = sha256(encodeUtf8('owner envelope'));
      const sig = await session.signEnvelopeHash(envelopeHash);
      expect(sig).toMatch(/^[0-9a-f]{128}$/);
      const pub = decodeHex(ownerNostr);
      expect(bip340Verify(pub, taggedHash(TAGS.envelope, envelopeHash), decodeHex(sig))).toBe(true);
      // Never valid as an owner action or as an untagged digest over the same 32 bytes.
      expect(bip340Verify(pub, taggedHash(TAGS.ownerAction, envelopeHash), decodeHex(sig))).toBe(
        false,
      );
      expect(bip340Verify(pub, envelopeHash, decodeHex(sig))).toBe(false);
      expect(await codeOf(() => session.signEnvelopeHash(new Uint8Array(31)))).toBe(
        'invalid_length',
      );
    });

    it('signs a seal (kind 13) and a NIP-42 AUTH event (kind 22242) only', async () => {
      const session = await owner.unlock(passphrase(CODE));
      for (const kind of [NOSTR_KIND_SEAL, NOSTR_KIND_AUTH]) {
        const event = await session.signNostr({
          kind,
          created_at: 1760000000,
          tags: [],
          content: '',
        });
        expect(event.kind).toBe(kind);
        expect(event.pubkey).toBe(ownerNostr);
        expect(verifyNostrEvent(event)).toBe(true);
      }
      // Any other kind is refused: a session is a bearer handle, not a general owner signer.
      for (const kind of [0, 1, 3, 4, 14, NOSTR_KIND_GIFT_WRAP, 10002, 22241, 22243, 30078]) {
        expect(
          await codeOf(() => session.signNostr({ kind, created_at: 0, tags: [], content: '' })),
        ).toBe('operation_not_allowed');
      }
      // A malformed event is still an input error, checked before the kind.
      expect(await codeOf(() => session.signNostr(null as never))).toBe('invalid_argument');
      expect(
        await codeOf(() => session.signNostr({ kind: 1, created_at: -1, tags: [], content: '' })),
      ).toBe('invalid_argument');
    });

    it('checks the kind on a snapshot and signs that snapshot: a getter cannot swap it (IR-M1-1g-G2-1 M-1)', async () => {
      const session = await owner.unlock(passphrase(CODE));
      let reads = 0;
      const flipping = {
        get kind() {
          reads += 1;
          return reads === 1 ? NOSTR_KIND_SEAL : 1;
        },
        created_at: 1760000000,
        tags: [],
        content: '',
      };
      const signed = await session.signNostr(flipping);
      expect(reads).toBe(1);
      expect(signed.kind).toBe(NOSTR_KIND_SEAL);
      expect(verifyNostrEvent(signed)).toBe(true);
      expect(Object.isFrozen(signed)).toBe(true);

      // The other order: an allowed kind on a later read never gets the disallowed one signed.
      let laterReads = 0;
      const late = {
        get kind() {
          laterReads += 1;
          return laterReads === 1 ? 1 : NOSTR_KIND_SEAL;
        },
        created_at: 1760000000,
        tags: [],
        content: '',
      };
      expect(await codeOf(() => session.signNostr(late))).toBe('operation_not_allowed');
    });

    it('a Proxy that answers differently on each read cannot swap the kind either (M-1)', async () => {
      const session = await owner.unlock(passphrase(CODE));
      let kindReads = 0;
      const target = { kind: 0, created_at: 1760000000, tags: [], content: 'x' };
      const proxy = new Proxy(target, {
        get(object, key, receiver) {
          if (key === 'kind') {
            kindReads += 1;
            return kindReads === 1 ? NOSTR_KIND_AUTH : 30078;
          }
          return Reflect.get(object, key, receiver) as unknown;
        },
      });
      const signed = await session.signNostr(proxy);
      expect(signed.kind).toBe(NOSTR_KIND_AUTH);
      expect(verifyNostrEvent(signed)).toBe(true);
      expect(kindReads).toBe(1);
    });

    it('the owner seal and the envelope both verify under the owner key (acceptance)', async () => {
      const session = await owner.unlock(passphrase(CODE));
      const envelopeHash = sha256(encodeUtf8('approval envelope'));
      const sig = await session.signEnvelopeHash(envelopeHash);
      // The seal carries the rumor NIP-44-encrypted to the agent; seal key = envelope `from`.
      const seal = await session.signNostr({
        kind: NOSTR_KIND_SEAL,
        created_at: 1760000000,
        tags: [],
        content: await session.nip44Encrypt(agentNostr, '{"rumor":true}'),
      });
      expect(verifyNostrEvent(seal)).toBe(true);
      expect(seal.pubkey).toBe(ownerNostr);
      expect(
        bip340Verify(
          decodeHex(seal.pubkey),
          taggedHash(TAGS.envelope, envelopeHash),
          decodeHex(sig),
        ),
      ).toBe(true);
      expect(await agent.nip44Decrypt(seal.pubkey, seal.content)).toBe('{"rumor":true}');
    });

    it('opens a gift wrap addressed to the owner: wrap, then seal, then rumor (04 §3.1.1)', async () => {
      const rumor = '{"envelope":"copy"}';
      const seal = await agent.signNostr({
        kind: NOSTR_KIND_SEAL,
        created_at: 1760000000,
        tags: [],
        content: await agent.nip44Encrypt(ownerNostr, rumor),
      });
      const wrap = createGiftWrap(seal, ownerNostr, 1760000000);
      const session = await owner.unlock(passphrase(CODE));
      const opened = JSON.parse(
        await session.nip44Decrypt(wrap.pubkey, wrap.content),
      ) as NostrEvent;
      expect(verifyNostrEvent(opened)).toBe(true);
      expect(opened.pubkey).toBe(agentNostr);
      expect(await session.nip44Decrypt(opened.pubkey, opened.content)).toBe(rumor);
    });

    it('has epoch 0 only: a later epoch is unavailable, a malformed one refused', async () => {
      const session = await owner.unlock(passphrase(CODE));
      const payload = await agent.nip44Encrypt(ownerNostr, 'x');
      expect(await session.nip44Decrypt(agentNostr, payload, { epoch: 0 })).toBe('x');
      expect(await codeOf(() => session.nip44Decrypt(agentNostr, payload, { epoch: 1 }))).toBe(
        'epoch_unavailable',
      );
      expect(await codeOf(() => session.nip44Decrypt(agentNostr, payload, { epoch: -1 }))).toBe(
        'invalid_argument',
      );
      expect(await codeOf(() => session.unwrapCek(WRAPPED, ENVELOPE_ID, { epoch: 1 }))).toBe(
        'epoch_unavailable',
      );
    });

    it('opens an owner entry (acceptance; 04 §3.1.1 owner reads, step 4)', async () => {
      const session = await owner.unlock(passphrase(CODE));
      const { ownerEnc } = await owner.getPublicKeys();
      const ownerEntry = await wrapCek(ownerEnc, ENVELOPE_ID, CEK);
      expect(await session.unwrapCek(ownerEntry, ENVELOPE_ID)).toEqual(CEK);
      expect(await session.unwrapCek(ownerEntry, ENVELOPE_ID, { epoch: 0 })).toEqual(CEK);
    });

    it('fails closed on an owner entry: wrong envelope id, tampered wrap, an agent entry', async () => {
      const session = await owner.unlock(passphrase(CODE));
      const { ownerEnc } = await owner.getPublicKeys();
      const ownerEntry = await wrapCek(ownerEnc, ENVELOPE_ID, CEK);
      expect(await codeOf(() => session.unwrapCek(ownerEntry, OTHER_ID))).toBe('open_failed');
      for (const field of ['enc', 'wk'] as const) {
        expect(await codeOf(() => session.unwrapCek(tamper(ownerEntry, field), ENVELOPE_ID))).toBe(
          'open_failed',
        );
      }
      const agentEntry = await wrapCek(derivePublicIdentity(SEED_A, 0).agentEnc, ENVELOPE_ID, CEK);
      expect(await codeOf(() => session.unwrapCek(agentEntry, ENVELOPE_ID))).toBe('open_failed');
    });

    it('has no hpkeOpen (IR-M1-1c-1 F5)', async () => {
      const session = await owner.unlock(passphrase(CODE));
      expect('hpkeOpen' in session).toBe(false);
    });

    it('every session operation fails closed once the session ends', async () => {
      const session = await owner.unlock(passphrase(CODE));
      const ownerEntry = await wrapCek((await owner.getPublicKeys()).ownerEnc, ENVELOPE_ID, CEK);
      const payload = await agent.nip44Encrypt(ownerNostr, 'x');
      const ops = [
        () => session.signOwnerAction(action()),
        () => session.sign712(MAIL),
        () => session.signEnvelopeHash(new Uint8Array(32)),
        () => session.signNostr({ kind: NOSTR_KIND_SEAL, created_at: 0, tags: [], content: '' }),
        () => session.nip44Encrypt(agentNostr, 'x'),
        () => session.nip44Decrypt(agentNostr, payload),
        () => session.unwrapCek(ownerEntry, ENVELOPE_ID),
      ];
      expect(await codeOf(ops[5] as () => Promise<unknown>)).toBe('accepted');
      expect(await codeOf(ops[6] as () => Promise<unknown>)).toBe('accepted');
      await session.close();
      for (const op of ops) expect(await codeOf(op)).toBe('owner_locked');
    });
  });

  it('expiry is enforced on the monotonic clock too: a wall clock set back does not extend it (IR-M1-1g-1 L-1)', async () => {
    const session = await owner.unlock(passphrase(CODE), { ttlMs: 1000 });
    const perf = (globalThis as unknown as { performance: { now(): number } }).performance;
    const start = perf.now();
    vi.setSystemTime(Date.now() - 10_000_000);
    const spy = vi.spyOn(perf, 'now').mockReturnValue(start + 1000);
    try {
      expect(session.isActive()).toBe(false);
      expect(await codeOf(() => session.signOwnerAction(action()))).toBe('owner_locked');
    } finally {
      spy.mockRestore();
    }
  });

  it('lock cancels an unlock that is still in flight (IR-M1-1g-1 L-2)', async () => {
    const presence = passphrase(CODE);
    const pending = owner.unlock(presence);
    await owner.lock();
    expect(await codeOf(() => pending)).toBe('owner_locked');
    expect(presence.kind === 'passphrase' && presence.secret.every((x) => x === 0)).toBe(true);
    const after = await owner.unlock(passphrase(CODE));
    expect(after.isActive()).toBe(true);
  });

  it('wipes the bytes of a malformed presence proof too (IR-M1-1g-1 I-1)', async () => {
    const short = new Uint8Array(31).fill(9);
    const wrongKind = new Uint8Array(32).fill(9);
    expect(
      await codeOf(() => owner.unlock({ kind: 'passkey-prf', prfOutput: short } as never)),
    ).toBe('presence_required');
    expect(
      await codeOf(() => owner.unlock({ kind: 'environment', secret: wrongKind } as never)),
    ).toBe('presence_required');
    expect(short.every((x) => x === 0)).toBe(true);
    expect(wrongKind.every((x) => x === 0)).toBe(true);
  });

  it('owner sign712 signs with the owner EVM key (cardSig, Registration)', async () => {
    const session = await owner.unlock(passphrase(CODE));
    const sig = await session.sign712(MAIL);
    expect(signerOf(MAIL, sig)).toEqual((await owner.getPublicKeys()).ownerEvm);
    const typed = { domain: {}, types: {}, primaryType: 'AgentCard', message: {} };
    expect(await codeOf(() => session.sign712(typed))).toBe('invalid_typed_data');
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
