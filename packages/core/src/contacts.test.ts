// Contacts (M1-7a): keyed by agentId, added from a verified card, re-pair rules and revoked agents
// (04 §2.9, §3.4.1), card updates (04 §2.6, §3.4.1), list, block and remove (02 F-14), names marked
// self-declared (04 §2.4, 06 §2.1), and the inbound sender screen that drops blocked contacts.
import { encodeHex0x, type OwnerKeyStore } from '@agentlink/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@agentlink/crypto/testing';
import { createLogger } from '@agentlink/log';
import { describe, expect, it } from 'vitest';
import { AgentLinkClient } from './client.js';
import type { SignedCard } from './identity.js';
import { MemoryStore } from './store/memory-store.js';
import {
  FakeClock,
  RELAYS,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
} from './testing/fixtures.js';

const clock = new FakeClock();

async function agent(agentSeed: number, keyEpoch = 0, store = new MemoryStore()) {
  const client = await AgentLinkClient.create({
    keyStore: new MemoryKeyStore(seed(agentSeed), { keyEpoch }),
    store,
    cipher: new TestStoreCipher(),
    approvals: new RecordingApprovalChannel(),
    clock: clock.now,
  });
  return { client, store };
}

/** A peer agent's signed card at an epoch: init at 0, then rotate up to `keyEpoch`. */
async function peerCard(
  agentSeed: number,
  owner: OwnerKeyStore,
  options: { keyEpoch?: number; name?: string } = {},
): Promise<SignedCard> {
  const store = new MemoryStore();
  const { client } = await agent(agentSeed, 0, store);
  await client.identity.init({
    owner: await owner.unlock(passphrase()),
    ownerKeys: await owner.getPublicKeys(),
    name: options.name ?? 'Denis agent',
    relays: RELAYS,
  });
  for (let epoch = 1; epoch <= (options.keyEpoch ?? 0); epoch += 1) {
    const next = await agent(agentSeed, epoch, store);
    await next.client.identity.rotate({
      owner: await owner.unlock(passphrase()),
      ownerKeys: await owner.getPublicKeys(),
    });
  }
  const { client: last } = await agent(agentSeed, options.keyEpoch ?? 0, store);
  return last.identity.signedCard();
}

const ownerA = new MemoryOwnerKeyStore(seed(201), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(202), passphrase());
const ownerC = new MemoryOwnerKeyStore(seed(203), passphrase());

async function self() {
  const s = await agent(1);
  await s.client.identity.init({
    owner: await ownerA.unlock(passphrase()),
    ownerKeys: await ownerA.getPublicKeys(),
    name: 'me',
    relays: RELAYS,
  });
  return s;
}

describe('contacts.addFromCard (04 §2.9)', () => {
  it('adds a contact keyed by agentId with a self-declared name and the owner fingerprint', async () => {
    const { client, store } = await self();
    const card = await peerCard(2, ownerB);
    const contact = await client.contacts.addFromCard(card);
    expect(contact.id).toBe(card.card.agentEvm);
    expect(contact.name).toEqual({
      value: 'Denis agent',
      source: 'counterparty',
      selfDeclared: true,
    });
    expect(contact.status).toBe('active');
    expect(contact.pairing).toBe('pending');
    expect(contact.safetyCodeChecked).toBe(false);
    expect(contact.ownerFingerprint.short).toMatch(/^[0-9A-F]{4}·[0-9A-F]{4}$/);
    expect(contact.ownerFingerprint.long).toMatch(/^[0-9a-f]{64}$/);
    expect(await client.contacts.list()).toEqual([contact]);
    // The name is sealed at rest (07 §3).
    const row = await store.transaction((tx) => tx.get('contacts', { contact_id: contact.id }));
    expect(row?.name).not.toContain('Denis');
    expect(row?.relays).not.toContain('relay');
  });

  it('rejects a card whose cardSig is not from ownerEvm', async () => {
    const { client } = await self();
    const card = await peerCard(2, ownerB);
    const forged = await peerCard(3, ownerC);
    await expect(
      client.contacts.addFromCard({ ...card, cardSig: forged.cardSig }),
    ).rejects.toMatchObject({ code: 'card_owner_signature_invalid' });
    expect(await client.contacts.list()).toEqual([]);
  });

  it('rejects a card without a valid cardAgentSig (the agent key must endorse the binding)', async () => {
    const { client } = await self();
    const card = await peerCard(2, ownerB);
    const other = await peerCard(3, ownerB);
    await expect(
      client.contacts.addFromCard({ ...card, cardAgentSig: other.cardAgentSig }),
    ).rejects.toMatchObject({ code: 'card_agent_signature_invalid' });
    await expect(
      client.contacts.addFromCard({ ...card, cardAgentSig: undefined }),
    ).rejects.toMatchObject({ code: 'card_agent_signature_invalid' });
  });

  it('rejects a name or relays that do not match the card hashes, and a malformed card', async () => {
    const { client } = await self();
    const card = await peerCard(2, ownerB);
    await expect(
      client.contacts.addFromCard({ ...card, name: 'Someone else' }),
    ).rejects.toMatchObject({
      code: 'name_invalid',
    });
    await expect(
      client.contacts.addFromCard({ ...card, relays: ['wss://relay.other.dev'] }),
    ).rejects.toMatchObject({ code: 'relays_invalid' });
    await expect(
      client.contacts.addFromCard({ ...card, card: { ...card.card, extra: 1 } }),
    ).rejects.toMatchObject({ code: 'card_invalid' });
  });

  it('rejects an expired card', async () => {
    const { client } = await self();
    const owner = new MemoryOwnerKeyStore(seed(204), passphrase());
    const store = new MemoryStore();
    const { client: peer } = await agent(5, 0, store);
    await peer.identity.init({
      owner: await owner.unlock(passphrase()),
      ownerKeys: await owner.getPublicKeys(),
      name: 'n',
      relays: RELAYS,
      expiresAt: clock.t + 10,
    });
    const card = await peer.identity.signedCard();
    clock.t += 10;
    try {
      await expect(client.contacts.addFromCard(card)).rejects.toMatchObject({
        code: 'card_expired',
      });
    } finally {
      clock.t -= 10;
    }
  });

  it('never adds the own agentId as a contact', async () => {
    const { client } = await self();
    const own = await client.identity.signedCard();
    await expect(client.contacts.addFromCard(own)).rejects.toMatchObject({
      code: 'contact_is_self',
    });
  });

  it('keeps at most one contact per agentId: a re-pair with unchanged owner keys and epoch replaces it', async () => {
    const { client } = await self();
    const v0 = await peerCard(2, ownerB);
    await client.contacts.addFromCard(v0);
    const v1 = await peerCard(2, ownerB, { keyEpoch: 1 });
    const repaired = await client.contacts.addFromCard(v1);
    expect(repaired.keyEpoch).toBe(1);
    expect(repaired.card).toEqual(v1.card);
    // Same epoch again is allowed (not lower).
    await client.contacts.addFromCard(v1);
    expect(await client.contacts.list()).toHaveLength(1);
  });

  it('refuses a re-pair with a lower keyEpoch or changed owner keys', async () => {
    const { client } = await self();
    await client.contacts.addFromCard(await peerCard(2, ownerB, { keyEpoch: 1 }));
    await expect(client.contacts.addFromCard(await peerCard(2, ownerB))).rejects.toMatchObject({
      code: 'repair_epoch_lower',
    });
    await expect(
      client.contacts.addFromCard(await peerCard(2, ownerC, { keyEpoch: 1 })),
    ).rejects.toMatchObject({
      code: 'repair_owner_changed',
    });
    const [contact] = await client.contacts.list();
    expect(contact?.keyEpoch).toBe(1);
  });

  it('refuses a pairing for a revoked agentId, also after the contact was removed', async () => {
    const { client, store } = await self();
    const card = await peerCard(2, ownerB);
    await client.contacts.addFromCard(card);
    await store.transaction((tx) => {
      tx.insert('revoked_agents', {
        agent_evm: card.card.agentEvm,
        nostr_keys: JSON.stringify([card.card.agentNostr.slice(2)]),
        signed_json: null,
        reason: null,
        source: 'registry',
        chain_id: '8453',
        registry_ref: 'r',
        applied_at: clock.t,
      });
      tx.update('contacts', { contact_id: card.card.agentEvm }, { status: 'revoked' });
    });
    await expect(client.contacts.addFromCard(card)).rejects.toMatchObject({
      code: 'contact_revoked',
    });
    await client.contacts.remove(card.card.agentEvm);
    await expect(client.contacts.addFromCard(card)).rejects.toMatchObject({
      code: 'contact_revoked',
    });
  });

  it('refuses a card that reuses another contact`s Nostr key', async () => {
    const { client } = await self();
    const a = await peerCard(2, ownerB);
    await client.contacts.addFromCard(a);
    // A card for another agentId cannot carry a's agentNostr without a's agent key endorsing it; the
    // check runs on the store's unique constraint too, so a direct insert would be refused as well.
    const b = await peerCard(3, ownerB);
    await expect(
      client.contacts.addFromCard({ ...b, card: { ...b.card, agentNostr: a.card.agentNostr } }),
    ).rejects.toMatchObject({ code: 'card_owner_signature_invalid' });
  });
});

describe('contacts.applyCardUpdate (04 §2.6, §3.4.1)', () => {
  it('takes a higher epoch signed by the same owner and keeps the old key as superseded', async () => {
    const { client } = await self();
    const v0 = await peerCard(2, ownerB);
    await client.contacts.addFromCard(v0);
    const v1 = await peerCard(2, ownerB, { keyEpoch: 1, name: 'Denis agent v2' });
    const updated = await client.contacts.applyCardUpdate({
      card: v1.card,
      cardSig: v1.cardSig,
      name: v1.name,
      relays: v1.relays,
    });
    expect(updated.keyEpoch).toBe(1);
    expect(updated.name.value).toBe('Denis agent v2');
    expect(updated.name.selfDeclared).toBe(true);
    const old = await client.contacts.screenInbound(v0.card.agentNostr.slice(2));
    expect(old).toEqual({
      action: 'continue',
      sender: { kind: 'superseded', contactId: v0.card.agentEvm },
    });
    const now = await client.contacts.screenInbound(v1.card.agentNostr.slice(2));
    expect(now).toEqual({
      action: 'continue',
      sender: { kind: 'contact', contactId: v0.card.agentEvm },
    });
  });

  it('refuses an update that is not newer, changes the owner, or names an unknown agent', async () => {
    const { client } = await self();
    const v1 = await peerCard(2, ownerB, { keyEpoch: 1 });
    await client.contacts.addFromCard(v1);
    await expect(client.contacts.applyCardUpdate(v1)).rejects.toMatchObject({
      code: 'card_update_not_newer',
    });
    await expect(
      client.contacts.applyCardUpdate(await peerCard(2, ownerC, { keyEpoch: 2 })),
    ).rejects.toMatchObject({ code: 'owner_keys_changed' });
    await expect(
      client.contacts.applyCardUpdate(await peerCard(3, ownerB, { keyEpoch: 2 })),
    ).rejects.toMatchObject({ code: 'contact_not_found' });
    const v2 = await peerCard(2, ownerB, { keyEpoch: 2 });
    await expect(
      client.contacts.applyCardUpdate({ ...v2, cardSig: (await peerCard(3, ownerC)).cardSig }),
    ).rejects.toMatchObject({ code: 'card_owner_signature_invalid' });
  });
});

describe('block and remove (02 F-14) and the inbound screen', () => {
  it('drops envelopes from a blocked contact', async () => {
    const { client } = await self();
    const card = await peerCard(2, ownerB);
    const contact = await client.contacts.addFromCard(card);
    const from = card.card.agentNostr.slice(2);
    expect(await client.contacts.screenInbound(from)).toEqual({
      action: 'continue',
      sender: { kind: 'contact', contactId: contact.id },
    });
    const blocked = await client.contacts.block(contact.id);
    expect(blocked.status).toBe('blocked');
    expect(await client.contacts.screenInbound(from)).toEqual({
      action: 'drop',
      reason: 'blocked',
    });
    // An old epoch key of a blocked contact is dropped as well.
    const v1 = await peerCard(2, ownerB, { keyEpoch: 1 });
    await client.contacts.applyCardUpdate(v1);
    expect(await client.contacts.screenInbound(from)).toEqual({
      action: 'drop',
      reason: 'blocked',
    });
    expect(await client.contacts.screenInbound(v1.card.agentNostr.slice(2))).toEqual({
      action: 'drop',
      reason: 'blocked',
    });
  });

  it('drops envelopes from any key of a revoked agent, also after removal', async () => {
    const { client, store } = await self();
    const card = await peerCard(2, ownerB);
    await client.contacts.addFromCard(card);
    const from = card.card.agentNostr.slice(2);
    await store.transaction((tx) =>
      tx.insert('revoked_agents', {
        agent_evm: card.card.agentEvm,
        nostr_keys: JSON.stringify([from]),
        signed_json: null,
        reason: 'compromised',
        source: 'registry',
        chain_id: '8453',
        registry_ref: 'r',
        applied_at: clock.t,
      }),
    );
    expect(await client.contacts.screenInbound(from)).toEqual({
      action: 'drop',
      reason: 'revoked',
    });
    await client.contacts.remove(card.card.agentEvm);
    expect(await client.contacts.screenInbound(from)).toEqual({
      action: 'drop',
      reason: 'revoked',
    });
  });

  it('remove deletes the contact; its key is then an unknown sender (requests queue, F-13)', async () => {
    const { client } = await self();
    const card = await peerCard(2, ownerB);
    const contact = await client.contacts.addFromCard(card);
    await client.contacts.remove(contact.id);
    expect(await client.contacts.list()).toEqual([]);
    expect(await client.contacts.screenInbound(card.card.agentNostr.slice(2))).toEqual({
      action: 'continue',
      sender: { kind: 'unknown' },
    });
  });

  it('cannot unrevoke by blocking, and reports unknown contacts', async () => {
    const { client, store } = await self();
    const card = await peerCard(2, ownerB);
    await client.contacts.addFromCard(card);
    await store.transaction((tx) =>
      tx.update('contacts', { contact_id: card.card.agentEvm }, { status: 'revoked' }),
    );
    const after = await client.contacts.block(card.card.agentEvm);
    expect(after.status).toBe('revoked');
    await expect(
      client.contacts.block(encodeHex0x(new Uint8Array(20).fill(9))),
    ).rejects.toMatchObject({
      code: 'contact_not_found',
    });
  });

  it('fails closed: an unreadable contact name is an error, never an empty name', async () => {
    const { client, store } = await self();
    const card = await peerCard(2, ownerB);
    const contact = await client.contacts.addFromCard(card);
    const other = await store.transaction((tx) => tx.select('identity')[0]?.name);
    // A sealed value copied from another row and column does not open (07 §3.1).
    await store.transaction((tx) =>
      tx.update(
        'contacts',
        { contact_id: contact.id },
        { name: other as NonNullable<typeof other> },
      ),
    );
    await expect(client.contacts.list()).rejects.toMatchObject({ code: 'store_unreadable' });
  });
});

describe('logging (I-7)', () => {
  it('never logs a name, a relay, a key or a signature', async () => {
    const lines: string[] = [];
    const logger = createLogger({ name: 'core', sink: (_level, line) => lines.push(line) });
    const client = await AgentLinkClient.create({
      keyStore: new MemoryKeyStore(seed(1)),
      store: new MemoryStore(),
      cipher: new TestStoreCipher(),
      approvals: new RecordingApprovalChannel(),
      clock: clock.now,
      logger,
    });
    await client.identity.init({
      owner: await ownerA.unlock(passphrase()),
      ownerKeys: await ownerA.getPublicKeys(),
      name: 'Own-name-canary',
      relays: RELAYS,
    });
    const card = await peerCard(2, ownerB, { name: 'Peer-name-canary' });
    await client.contacts.addFromCard(card);
    await client.contacts.applyCardUpdate(
      await peerCard(2, ownerB, { keyEpoch: 1, name: 'Peer-name-canary' }),
    );
    await client.contacts.block(card.card.agentEvm);
    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join('\n');
    for (const value of [
      'Own-name-canary',
      'Peer-name-canary',
      'relay.agentlink.dev',
      card.cardSig.slice(2, 40),
      card.cardAgentSig.slice(2, 40),
      card.card.agentNostr.slice(2, 40),
      card.card.agentEvm.slice(2),
    ]) {
      expect(all).not.toContain(value);
    }
  });
});
