// Identity (M1-7a): the agent card (04 §2.4) signed by the owner through an OwnerSession, with
// cardAgentSig by the agent key (04 §2.9); agentId derived from the seed with a random storagePrefix
// (04 §2.9, G-23); key rotation to keyEpoch + 1 with a new card (04 §2.6).
import {
  decodeBase64url,
  decodeHex0x,
  generateCek,
  randomBytes,
  verifyAgentCard,
  verifyCardOwnerSig,
  wrapCek,
} from '@agentlink/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@agentlink/crypto/testing';
import { describe, expect, it } from 'vitest';
import { AgentLinkClient } from './client.js';
import { STORAGE_PREFIX_BYTES } from './constants.js';
import { CoreError } from './errors.js';
import { MemoryStore } from './store/memory-store.js';
import {
  FakeClock,
  RELAYS,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
} from './testing/fixtures.js';

async function setup(options: { agentSeed?: number; keyEpoch?: number; store?: MemoryStore } = {}) {
  const keyStore = new MemoryKeyStore(seed(options.agentSeed ?? 1), {
    keyEpoch: options.keyEpoch ?? 0,
  });
  const owner = new MemoryOwnerKeyStore(seed(101), passphrase());
  const store = options.store ?? new MemoryStore();
  const cipher = new TestStoreCipher();
  const clock = new FakeClock();
  const client = await AgentLinkClient.create({
    keyStore,
    store,
    cipher,
    approvals: new RecordingApprovalChannel(),
    clock: clock.now,
  });
  return { keyStore, owner, store, cipher, clock, client };
}

describe('identity.init (04 §2.4, §2.9)', () => {
  it('issues a card signed by ownerEvm and endorsed by agentEvm, and records the identity', async () => {
    const { keyStore, owner, client, clock, store } = await setup();
    const session = await owner.unlock(passphrase());
    const ownerKeys = await owner.getPublicKeys();
    const view = await client.identity.init({
      owner: session,
      ownerKeys,
      name: 'Tali laptop',
      relays: RELAYS,
    });
    const bundle = await keyStore.getPublicBundle();

    expect(view.agentId).toBe(bundle.agentId);
    expect(view.agentId).toMatch(/^0x[0-9a-f]{40}$/);
    expect(view.card.agentEvm).toBe(bundle.agentId);
    expect(decodeHex0x(view.card.ownerEvm, { length: 20 })).toEqual(ownerKeys.ownerEvm);
    expect(view.card.keyEpoch).toBe(0);
    expect(view.card.issuedAt).toBe(clock.t);
    expect(view.card.expiresAt).toBe(0);
    expect(verifyAgentCard(view.card, view.cardSig, view.cardAgentSig)).toBe(true);

    // storagePrefix: 16 random bytes, base64url, not derived from any key.
    expect(decodeBase64url(view.storagePrefix)).toHaveLength(STORAGE_PREFIX_BYTES);

    // Stored: the identity row (name and relays sealed) and the budget_state row created with it.
    const rows = await store.transaction((tx) => ({
      identity: tx.select('identity'),
      budget: tx.select('budget_state'),
    }));
    expect(rows.identity).toHaveLength(1);
    expect(rows.identity[0]?.name).not.toContain('Tali');
    expect(rows.budget).toEqual([
      {
        slot: 'current',
        ledger_epoch: 0,
        status: 'ok',
        newest_t: clock.t,
        since: clock.t,
        broken_at: null,
      },
    ]);

    const signed = await client.identity.signedCard();
    expect(signed.name).toBe('Tali laptop');
    expect(signed.relays).toEqual(RELAYS);
    expect(signed.card).toEqual(view.card);
  });

  it('draws a fresh storagePrefix per agent, so two agents never share one', async () => {
    const a = await setup({ agentSeed: 1 });
    const b = await setup({ agentSeed: 2 });
    const init = async (s: Awaited<ReturnType<typeof setup>>) =>
      s.client.identity.init({
        owner: await s.owner.unlock(passphrase()),
        ownerKeys: await s.owner.getPublicKeys(),
        name: 'n',
        relays: RELAYS,
      });
    const [va, vb] = [await init(a), await init(b)];
    expect(va.storagePrefix).not.toBe(vb.storagePrefix);
    expect(va.agentId).not.toBe(vb.agentId);
  });

  it('rejects a card whose signature is not from ownerEvm, and stores nothing', async () => {
    const { owner, client, store } = await setup();
    const otherOwner = new MemoryOwnerKeyStore(seed(102), passphrase());
    await expect(
      client.identity.init({
        owner: await otherOwner.unlock(passphrase()),
        ownerKeys: await owner.getPublicKeys(),
        name: 'n',
        relays: RELAYS,
      }),
    ).rejects.toMatchObject({ code: 'card_owner_signature_invalid' });
    expect(await store.transaction((tx) => tx.count('identity') + tx.count('budget_state'))).toBe(
      0,
    );
  });

  it('refuses a name or relay list outside the card rules (04 §2.4, §4)', async () => {
    const { owner, client } = await setup();
    const ownerKeys = await owner.getPublicKeys();
    await expect(
      client.identity.init({
        owner: await owner.unlock(passphrase()),
        ownerKeys,
        name: 'n',
        relays: ['ws://localhost:7000'],
      }),
    ).rejects.toMatchObject({ code: 'relays_invalid' });
    await expect(
      client.identity.init({
        owner: await owner.unlock(passphrase()),
        ownerKeys,
        name: 'x'.repeat(300),
        relays: RELAYS,
      }),
    ).rejects.toMatchObject({ code: 'name_invalid' });
  });

  it('refuses a second init: an identity is never replaced', async () => {
    const { owner, client } = await setup();
    const input = async () => ({
      owner: await owner.unlock(passphrase()),
      ownerKeys: await owner.getPublicKeys(),
      name: 'n',
      relays: RELAYS,
    });
    await client.identity.init(await input());
    await expect(client.identity.init(await input())).rejects.toMatchObject({
      code: 'identity_exists',
    });
  });

  it('error messages never echo the name or relays given', async () => {
    const { owner, client } = await setup();
    const canary = 'CANARY-NAME-7c1e'.repeat(20);
    const error = await client.identity
      .init({
        owner: await owner.unlock(passphrase()),
        ownerKeys: await owner.getPublicKeys(),
        name: canary,
        relays: ['wss://CANARY-RELAY.example'],
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoreError);
    expect(String((error as Error).message)).not.toMatch(/CANARY/);
  });
});

describe('opening a store (04 §2.9: a mismatch is an error, never a new identity)', () => {
  it('refuses a store whose identity belongs to another agent seed', async () => {
    const first = await setup({ agentSeed: 1 });
    await first.client.identity.init({
      owner: await first.owner.unlock(passphrase()),
      ownerKeys: await first.owner.getPublicKeys(),
      name: 'n',
      relays: RELAYS,
    });
    await expect(setup({ agentSeed: 2, store: first.store })).rejects.toMatchObject({
      code: 'identity_mismatch',
    });
  });
});

describe('identity.rotate (04 §2.6)', () => {
  it('issues a card at keyEpoch + 1, and old-epoch keys still open old envelopes', async () => {
    const first = await setup({ keyEpoch: 0 });
    const v0 = await first.client.identity.init({
      owner: await first.owner.unlock(passphrase()),
      ownerKeys: await first.owner.getPublicKeys(),
      name: 'n',
      relays: RELAYS,
    });

    // An envelope's CEK wrapped to the epoch-0 enc key, before the rotation.
    const envelopeId = randomBytes(16);
    const cek = generateCek();
    const wrapped = await wrapCek(decodeHex0x(v0.card.agentEnc, { length: 32 }), envelopeId, cek);

    // The KeyStore backend advances its epoch (M1-8a); the core then issues the new card.
    const rotatedKeys = new MemoryKeyStore(seed(1), { keyEpoch: 1 });
    first.clock.t += 60;
    const rotated = await AgentLinkClient.create({
      keyStore: rotatedKeys,
      store: first.store,
      cipher: first.cipher,
      approvals: new RecordingApprovalChannel(),
      clock: first.clock.now,
    });
    const v1 = await rotated.identity.rotate({
      owner: await first.owner.unlock(passphrase()),
      ownerKeys: await first.owner.getPublicKeys(),
    });

    expect(v1.keyEpoch).toBe(1);
    expect(v1.card.keyEpoch).toBe(1);
    expect(v1.agentId).toBe(v0.agentId);
    expect(v1.card.agentEvm).toBe(v0.card.agentEvm);
    expect(v1.card.agentNostr).not.toBe(v0.card.agentNostr);
    expect(v1.card.agentEnc).not.toBe(v0.card.agentEnc);
    expect(v1.card.nameHash).toBe(v0.card.nameHash);
    expect(v1.card.relaysHash).toBe(v0.card.relaysHash);
    expect(v1.card.issuedAt).toBe(first.clock.t);
    expect(v1.storagePrefix).toBe(v0.storagePrefix);
    expect(verifyAgentCard(v1.card, v1.cardSig, v1.cardAgentSig)).toBe(true);

    // History stays readable: the epoch-0 key opens the old entry; the current key does not.
    expect(await rotatedKeys.unwrapCek(wrapped, envelopeId, { epoch: 0 })).toEqual(cek);
    await expect(rotatedKeys.unwrapCek(wrapped, envelopeId)).rejects.toThrow();
  });

  it('refuses a rotation when the KeyStore is not exactly one epoch ahead', async () => {
    const { client, owner } = await setup({ keyEpoch: 0 });
    await client.identity.init({
      owner: await owner.unlock(passphrase()),
      ownerKeys: await owner.getPublicKeys(),
      name: 'n',
      relays: RELAYS,
    });
    await expect(
      client.identity.rotate({
        owner: await owner.unlock(passphrase()),
        ownerKeys: await owner.getPublicKeys(),
      }),
    ).rejects.toMatchObject({ code: 'key_epoch_mismatch' });
  });

  it('refuses a rotation signed by another owner, and leaves the stored card unchanged', async () => {
    const first = await setup({ keyEpoch: 0 });
    const v0 = await first.client.identity.init({
      owner: await first.owner.unlock(passphrase()),
      ownerKeys: await first.owner.getPublicKeys(),
      name: 'n',
      relays: RELAYS,
    });
    const rotated = await AgentLinkClient.create({
      keyStore: new MemoryKeyStore(seed(1), { keyEpoch: 1 }),
      store: first.store,
      cipher: first.cipher,
      approvals: new RecordingApprovalChannel(),
      clock: first.clock.now,
    });
    const other = new MemoryOwnerKeyStore(seed(103), passphrase());
    // Other owner keys entirely: owner-key rotation is P2.
    await expect(
      rotated.identity.rotate({
        owner: await other.unlock(passphrase()),
        ownerKeys: await other.getPublicKeys(),
      }),
    ).rejects.toMatchObject({ code: 'owner_keys_changed' });
    // The right keys but another owner's session: the signature does not recover to ownerEvm.
    await expect(
      rotated.identity.rotate({
        owner: await other.unlock(passphrase()),
        ownerKeys: await first.owner.getPublicKeys(),
      }),
    ).rejects.toMatchObject({ code: 'card_owner_signature_invalid' });
    const now = await rotated.identity.get();
    expect(now?.card).toEqual(v0.card);
    expect(verifyCardOwnerSig(now?.card, now?.cardSig)).toBe(true);
  });

  it('refuses to rotate a revoked agent (04 §3.4.1: the core stops signing)', async () => {
    const first = await setup({ keyEpoch: 0 });
    await first.client.identity.init({
      owner: await first.owner.unlock(passphrase()),
      ownerKeys: await first.owner.getPublicKeys(),
      name: 'n',
      relays: RELAYS,
    });
    await first.store.transaction((tx) => tx.update('identity', {}, { revoked_at: first.clock.t }));
    const rotated = await AgentLinkClient.create({
      keyStore: new MemoryKeyStore(seed(1), { keyEpoch: 1 }),
      store: first.store,
      cipher: first.cipher,
      approvals: new RecordingApprovalChannel(),
      clock: first.clock.now,
    });
    await expect(
      rotated.identity.rotate({
        owner: await first.owner.unlock(passphrase()),
        ownerKeys: await first.owner.getPublicKeys(),
      }),
    ).rejects.toMatchObject({ code: 'identity_revoked' });
  });
});
