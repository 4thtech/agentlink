// M1-1g-d (IR-M1-7a-1 Q1): the owner-only key-epoch advance and the epoch + 1 preview on the
// KeyStore backend's management surface (KeyEpochControl), checked on MemoryKeyStore as the
// reference for the real backends. 04 §2.6 (rotation), §3.1.1 (epochs), I-1, I-4.
import { describe, expect, it } from 'vitest';
import { bip340Verify } from './bip340.js';
import { decodeHex, encodeHex, encodeUtf8 } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { TAGS, taggedHash } from './hash.js';
import { wrapCek } from './hpke.js';
import {
  KeyStoreError,
  type KeyEpochControl,
  type KeyStore,
  type OwnerPresence,
  type OwnerSession,
} from './keystore-api.js';
import { KEY_LABELS, MAX_KEY_EPOCH, derivePublicIdentity, deriveSecretKey } from './keys.js';
import { nip44ConversationKey, nip44EncryptWithKey } from './nip44.js';
import { verifyNostrEvent } from './nostr-event.js';
import { MemoryKeyStore, MemoryOwnerKeyStore } from './testing.js';

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const PEER_SEED = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
const OWNER_SEED = Uint8Array.from({ length: 32 }, (_, i) => 77 ^ i);
const ENVELOPE_ID = Uint8Array.from({ length: 16 }, (_, i) => i);
const CEK = Uint8Array.from({ length: 32 }, (_, i) => 0xc0 ^ i);

const presence = (): OwnerPresence => ({ kind: 'passphrase', secret: encodeUtf8('owner code') });

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof KeyStoreError || error instanceof CryptoInputError) return error.code;
    throw error;
  }
  return 'accepted';
}

async function setup(keyEpoch = 0) {
  const keys = new MemoryKeyStore(SEED, { keyEpoch });
  const owner = new MemoryOwnerKeyStore(OWNER_SEED, presence());
  const session = await owner.unlock(presence());
  return { keys, owner, session };
}

/** NIP-44 payload from the peer to the agent's Nostr key at `epoch`. */
function payloadTo(epoch: number, plaintext: string): string {
  const peerSecret = deriveSecretKey(PEER_SEED, KEY_LABELS.nostr, 0);
  const key = nip44ConversationKey(peerSecret, derivePublicIdentity(SEED, epoch).agentNostr);
  return nip44EncryptWithKey(key, plaintext);
}
const peerHex = encodeHex(derivePublicIdentity(PEER_SEED, 0).agentNostr);

describe('MemoryKeyStore as KeyEpochControl (M1-1g-d)', () => {
  it('implements the management surface next to the KeyStore', async () => {
    const { keys } = await setup();
    const control: KeyEpochControl = keys;
    const agent: KeyStore = keys;
    expect(typeof control.advanceEpoch).toBe('function');
    expect(typeof control.previewEpoch).toBe('function');
    expect(typeof agent.getPublicBundle).toBe('function');
  });

  describe('previewEpoch (the epoch + 1 public preview)', () => {
    it('returns the public keys of current + 1 without advancing', async () => {
      const { keys } = await setup(3);
      expect(await keys.previewEpoch(4)).toEqual(derivePublicIdentity(SEED, 4));
      expect((await keys.getPublicBundle()).keyEpoch).toBe(3);
      // A second preview is the same and still changes nothing.
      expect(await keys.previewEpoch(4)).toEqual(derivePublicIdentity(SEED, 4));
      expect((await keys.getPublicBundle()).keyEpoch).toBe(3);
    });

    it('is public keys only: the lookup, signing and decryption at that epoch stay unavailable', async () => {
      const { keys } = await setup(0);
      const next = await keys.previewEpoch(1);
      expect(Object.keys(next).sort()).toEqual(
        ['agentEnc', 'agentEvm', 'agentId', 'agentNostr', 'keyEpoch', 'kid'].sort(),
      );
      expect(await codeOf(() => keys.getPublicBundle({ epoch: 1 }))).toBe('epoch_unavailable');
      const wrapped = await wrapCek(next.agentEnc, ENVELOPE_ID, CEK);
      expect(await codeOf(() => keys.unwrapCek(wrapped, ENVELOPE_ID, { epoch: 1 }))).toBe(
        'epoch_unavailable',
      );
      expect(await codeOf(() => keys.nip44Decrypt(peerHex, payloadTo(1, 'x'), { epoch: 1 }))).toBe(
        'epoch_unavailable',
      );
      // Signing still uses the current epoch, never the previewed one.
      const event = await keys.signNostr({ kind: 13, created_at: 1, tags: [], content: '' });
      expect(event.pubkey).toBe(encodeHex(derivePublicIdentity(SEED, 0).agentNostr));
    });

    it('refuses any epoch but current + 1', async () => {
      const { keys } = await setup(2);
      expect(await codeOf(() => keys.previewEpoch(2))).toBe('epoch_conflict');
      expect(await codeOf(() => keys.previewEpoch(0))).toBe('epoch_conflict');
      expect(await codeOf(() => keys.previewEpoch(4))).toBe('epoch_unavailable');
      for (const epoch of [-1, 1.5, 2 ** 32, '3', undefined]) {
        expect(await codeOf(() => keys.previewEpoch(epoch as never))).toBe('invalid_argument');
      }
    });

    it('has no epoch after the last one', async () => {
      const keys = new MemoryKeyStore(SEED, { keyEpoch: MAX_KEY_EPOCH });
      expect(await codeOf(() => keys.previewEpoch(MAX_KEY_EPOCH + 1))).toBe('invalid_argument');
    });

    it('refuses after close', async () => {
      const { keys } = await setup();
      await keys.close();
      expect(await codeOf(() => keys.previewEpoch(1))).toBe('keystore_closed');
    });
  });

  describe('advanceEpoch (owner only, compare-and-set)', () => {
    it('advances from expected to expected + 1 and returns the new public bundle', async () => {
      const { keys, session } = await setup(0);
      const preview = await keys.previewEpoch(1);
      const advanced = await keys.advanceEpoch(0, session);
      expect(advanced).toEqual(preview);
      expect(await keys.getPublicBundle()).toEqual(derivePublicIdentity(SEED, 1));
    });

    it('signs and encrypts with the new epoch; older epochs decrypt only (04 §2.6)', async () => {
      const { keys, session } = await setup(0);
      const old = derivePublicIdentity(SEED, 0);
      const oldEntry = await wrapCek(old.agentEnc, ENVELOPE_ID, CEK);
      const oldPayload = payloadTo(0, 'history');
      await keys.advanceEpoch(0, session);
      const next = derivePublicIdentity(SEED, 1);

      const event = await keys.signNostr({ kind: 13, created_at: 1, tags: [], content: '' });
      expect(event.pubkey).toBe(encodeHex(next.agentNostr));
      expect(verifyNostrEvent(event)).toBe(true);
      const hash = new Uint8Array(32).fill(9);
      const sig = await keys.signEnvelopeHash(hash);
      expect(bip340Verify(next.agentNostr, taggedHash(TAGS.envelope, hash), decodeHex(sig))).toBe(
        true,
      );
      expect(bip340Verify(old.agentNostr, taggedHash(TAGS.envelope, hash), decodeHex(sig))).toBe(
        false,
      );

      // History stays readable with the older epoch on request; the default is the new one.
      expect(await keys.unwrapCek(oldEntry, ENVELOPE_ID, { epoch: 0 })).toEqual(CEK);
      expect(await codeOf(() => keys.unwrapCek(oldEntry, ENVELOPE_ID))).toBe('open_failed');
      expect(await keys.nip44Decrypt(peerHex, oldPayload, { epoch: 0 })).toBe('history');
      expect(await keys.getPublicBundle({ epoch: 0 })).toEqual(old);

      // The entry wrapped to the previewed key opens now, at the current epoch.
      const newEntry = await wrapCek(next.agentEnc, ENVELOPE_ID, CEK);
      expect(await keys.unwrapCek(newEntry, ENVELOPE_ID)).toEqual(CEK);
    });

    it('fails a stale expected value and changes nothing', async () => {
      const { keys, session } = await setup(2);
      for (const expected of [0, 1, 3, 4]) {
        expect(await codeOf(() => keys.advanceEpoch(expected, session))).toBe('epoch_conflict');
      }
      expect((await keys.getPublicBundle()).keyEpoch).toBe(2);
    });

    it('a concurrent double advance: exactly one wins, the other fails the compare-and-set', async () => {
      const { keys, session } = await setup(5);
      const results = await Promise.allSettled([
        keys.advanceEpoch(5, session),
        keys.advanceEpoch(5, session),
        keys.advanceEpoch(5, session),
      ]);
      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r) => r.status === 'rejected');
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(2);
      for (const r of lost) {
        expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'epoch_conflict' });
      }
      expect((await keys.getPublicBundle()).keyEpoch).toBe(6);
    });

    it('a replayed advance with the same expected value fails and changes nothing', async () => {
      const { keys, session } = await setup(0);
      await keys.advanceEpoch(0, session);
      expect(await codeOf(() => keys.advanceEpoch(0, session))).toBe('epoch_conflict');
      expect((await keys.getPublicBundle()).keyEpoch).toBe(1);
      // A deliberate next rotation names the epoch it starts from.
      await keys.advanceEpoch(1, session);
      expect((await keys.getPublicBundle()).keyEpoch).toBe(2);
    });

    it('needs a live owner session: an ended or locked one is owner_locked (I-4)', async () => {
      const { keys, owner, session } = await setup(0);
      await session.close();
      expect(await codeOf(() => keys.advanceEpoch(0, session))).toBe('owner_locked');
      const second = await owner.unlock(presence());
      await owner.lock();
      expect(await codeOf(() => keys.advanceEpoch(0, second))).toBe('owner_locked');
      expect((await keys.getPublicBundle()).keyEpoch).toBe(0);
    });

    it('refuses a call without an owner session (presence_required), and changes nothing', async () => {
      const { keys } = await setup(0);
      for (const owner of [undefined, null, {}, { isActive: true }, 'session']) {
        expect(await codeOf(() => keys.advanceEpoch(0, owner as never))).toBe('presence_required');
      }
      expect((await keys.getPublicBundle()).keyEpoch).toBe(0);
    });

    it('checks the session before the epoch: an ended session never learns the epoch', async () => {
      const { keys, session } = await setup(4);
      await session.close();
      expect(await codeOf(() => keys.advanceEpoch(1, session))).toBe('owner_locked');
    });

    it('refuses a malformed expected value', async () => {
      const { keys, session } = await setup(0);
      for (const expected of [-1, 0.5, 2 ** 32, '0', undefined]) {
        expect(await codeOf(() => keys.advanceEpoch(expected as never, session))).toBe(
          'invalid_argument',
        );
      }
      expect((await keys.getPublicBundle()).keyEpoch).toBe(0);
    });

    it('has no epoch after the last one', async () => {
      const keys = new MemoryKeyStore(SEED, { keyEpoch: MAX_KEY_EPOCH });
      const owner = new MemoryOwnerKeyStore(OWNER_SEED, presence());
      const session: OwnerSession = await owner.unlock(presence());
      expect(await codeOf(() => keys.advanceEpoch(MAX_KEY_EPOCH, session))).toBe(
        'epoch_unavailable',
      );
      expect((await keys.getPublicBundle()).keyEpoch).toBe(MAX_KEY_EPOCH);
    });

    it('refuses after close', async () => {
      const { keys, session } = await setup(0);
      await keys.close();
      expect(await codeOf(() => keys.advanceEpoch(0, session))).toBe('keystore_closed');
    });
  });
});
