// Contacts (M1-7a): keyed by agentId; a pairing is staged from a verified card and committed only when
// the handshake completes (04 §2.9); re-pair rules and revoked agents (04 §2.9, §3.4.1); card updates
// (04 §2.6, §3.4.1); list, block and remove with a tombstone (02 F-14); names marked self-declared
// (04 §2.4, 06 §2.1); the inbound sender screen.
import { encodeHex0x, type AgentCard, type OwnerKeyStore } from '@agentlink/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@agentlink/crypto/testing';
import { createLogger } from '@agentlink/log';
import { describe, expect, it } from 'vitest';
import { cardTypedData } from './card.js';
import { AgentLinkClient } from './client.js';
import type { SignedCard } from './identity.js';
import { MemoryStore } from './store/memory-store.js';
import type { Sealed } from './store/schema.js';
import { rowKeyOf } from './store/store.js';
import {
  FakeClock,
  RELAYS,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
  storePairingEnvelope,
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

/** A card-update signed by `owner` for an arbitrary card body (no agent signature needed). */
async function ownerSignedUpdate(owner: OwnerKeyStore, base: SignedCard, over: Partial<AgentCard>) {
  const card = { ...base.card, ...over };
  const session = await owner.unlock(passphrase());
  const cardSig = await session.sign712(cardTypedData(card));
  return { card, cardSig, name: base.name, relays: base.relays };
}

const ownerA = new MemoryOwnerKeyStore(seed(201), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(202), passphrase());
const ownerC = new MemoryOwnerKeyStore(seed(203), passphrase());

type Self = Awaited<ReturnType<typeof agent>>;

async function self(): Promise<Self> {
  const s = await agent(1);
  await s.client.identity.init({
    owner: await ownerA.unlock(passphrase()),
    ownerKeys: await ownerA.getPublicKeys(),
    name: 'me',
    relays: RELAYS,
  });
  return s;
}

const nostrOf = (card: SignedCard) => card.card.agentNostr.slice(2);

/** Stores the two pairing envelopes for `card` (the counterparty's one inbound, ours outbound). */
async function evidence(s: Self, card: SignedCard, role: 'inviter' | 'invitee') {
  const own = (await s.client.identity.signedCard()).card.agentNostr.slice(2);
  const handshakeEnvelopeId = await storePairingEnvelope(s.store, {
    type: 'handshake',
    direction: role === 'inviter' ? 'in' : 'out',
    from: role === 'inviter' ? nostrOf(card) : own,
  });
  const handshakeAckEnvelopeId = await storePairingEnvelope(s.store, {
    type: 'handshake-ack',
    direction: role === 'inviter' ? 'out' : 'in',
    from: role === 'inviter' ? own : nostrOf(card),
  });
  return { handshakeEnvelopeId, handshakeAckEnvelopeId };
}

async function pair(s: Self, card: SignedCard, role: 'inviter' | 'invitee' = 'invitee') {
  const { pairingId } = await s.client.contacts.stagePairing({
    ...card,
    role,
    expiresAt: clock.t + 3_600,
  });
  return s.client.contacts.completePairing({ pairingId, ...(await evidence(s, card, role)) });
}

const contactRow = (s: Self, id: string) =>
  s.store.transaction((tx) => tx.get('contacts', { contact_id: id }));

describe('pairing: stage, then commit on completion (04 §2.9)', () => {
  it('adds a contact keyed by agentId, complete, with a self-declared name and the owner fingerprint', async () => {
    const s = await self();
    const card = await peerCard(2, ownerB);
    const contact = await pair(s, card, 'inviter');
    expect(contact.id).toBe(card.card.agentEvm);
    expect(contact.name).toEqual({
      value: 'Denis agent',
      source: 'counterparty',
      selfDeclared: true,
    });
    expect(contact.status).toBe('active');
    expect(contact.pairing).toBe('complete');
    expect(contact.safetyCodeChecked).toBe(false);
    expect(contact.card).toEqual(card.card);
    expect(contact.ownerFingerprint.short).toMatch(/^[0-9A-F]{4}·[0-9A-F]{4}$/);
    expect(contact.ownerFingerprint.long).toMatch(/^[0-9a-f]{64}$/);
    expect(await s.client.contacts.list()).toEqual([contact]);
    expect(await s.store.transaction((tx) => tx.count('pairings'))).toBe(0);
  });

  it('seals the card, name and relays at rest: no nameHash, relaysHash or owner key in clear (M-3)', async () => {
    const s = await self();
    const card = await peerCard(2, ownerB);
    await pair(s, card);
    const row = await contactRow(s, card.card.agentEvm);
    const clear = JSON.stringify(row);
    for (const value of [
      card.card.nameHash.slice(2),
      card.card.relaysHash.slice(2),
      card.card.ownerNostr.slice(2),
      card.card.ownerEnc.slice(2),
      card.card.agentEnc.slice(2),
      'Denis',
      'relay.agentlink.dev',
    ]) {
      expect(clear).not.toContain(value);
    }
    // While staged, too.
    await s.client.contacts.stagePairing({
      ...(await peerCard(3, ownerB)),
      role: 'invitee',
      expiresAt: clock.t + 60,
    });
    const staged = JSON.stringify(await s.store.transaction((tx) => tx.select('pairings')));
    expect(staged).not.toContain('Denis');
    expect(staged).not.toContain(card.card.nameHash.slice(2, 20));
  });

  it('rejects a card whose cardSig is not from ownerEvm, and stages nothing', async () => {
    const s = await self();
    const card = await peerCard(2, ownerB);
    const forged = await peerCard(3, ownerC);
    await expect(
      s.client.contacts.stagePairing({
        ...card,
        cardSig: forged.cardSig,
        role: 'invitee',
        expiresAt: clock.t + 60,
      }),
    ).rejects.toMatchObject({ code: 'card_owner_signature_invalid' });
    expect(await s.store.transaction((tx) => tx.count('pairings'))).toBe(0);
  });

  it('rejects a card without a valid cardAgentSig (the agent key must endorse the binding)', async () => {
    const s = await self();
    const card = await peerCard(2, ownerB);
    const other = await peerCard(3, ownerB);
    const stage = (cardAgentSig: unknown) =>
      s.client.contacts.stagePairing({
        ...card,
        cardAgentSig,
        role: 'invitee',
        expiresAt: clock.t + 60,
      });
    await expect(stage(other.cardAgentSig)).rejects.toMatchObject({
      code: 'card_agent_signature_invalid',
    });
    await expect(stage(undefined)).rejects.toMatchObject({ code: 'card_agent_signature_invalid' });
  });

  it('rejects a name or relays that do not match the card, a malformed card and an expired card', async () => {
    const s = await self();
    const card = await peerCard(2, ownerB);
    const stage = (input: Partial<SignedCard> & Record<string, unknown>) =>
      s.client.contacts.stagePairing({
        ...card,
        ...input,
        role: 'invitee',
        expiresAt: clock.t + 60,
      });
    await expect(stage({ name: 'Someone else' })).rejects.toMatchObject({ code: 'name_invalid' });
    await expect(stage({ relays: ['wss://relay.other.dev'] })).rejects.toMatchObject({
      code: 'relays_invalid',
    });
    await expect(stage({ card: { ...card.card, extra: 1 } as AgentCard })).rejects.toMatchObject({
      code: 'card_invalid',
    });

    const owner = new MemoryOwnerKeyStore(seed(204), passphrase());
    const { client: peer } = await agent(5);
    await peer.identity.init({
      owner: await owner.unlock(passphrase()),
      ownerKeys: await owner.getPublicKeys(),
      name: 'n',
      relays: RELAYS,
      expiresAt: clock.t + 10,
    });
    const expiring = await peer.identity.signedCard();
    clock.t += 10;
    try {
      await expect(
        s.client.contacts.stagePairing({ ...expiring, role: 'invitee', expiresAt: clock.t + 60 }),
      ).rejects.toMatchObject({ code: 'card_expired' });
    } finally {
      clock.t -= 10;
    }
  });

  it('never pairs with the own agentId', async () => {
    const s = await self();
    const own = await s.client.identity.signedCard();
    await expect(
      s.client.contacts.stagePairing({ ...own, role: 'invitee', expiresAt: clock.t + 60 }),
    ).rejects.toMatchObject({ code: 'contact_is_self' });
  });

  it('completes only with the counterparty envelope from the card key stored: a replayed card completes nothing', async () => {
    const s = await self();
    const card = await peerCard(2, ownerB);
    const { pairingId } = await s.client.contacts.stagePairing({
      ...card,
      role: 'inviter',
      expiresAt: clock.t + 60,
    });
    // No envelopes at all.
    await expect(
      s.client.contacts.completePairing({
        pairingId,
        handshakeEnvelopeId: 'nope',
        handshakeAckEnvelopeId: 'nope2',
      }),
    ).rejects.toMatchObject({ code: 'pairing_evidence_missing' });
    // A handshake from another key (someone replaying the card) does not count.
    const replayed = await storePairingEnvelope(s.store, {
      type: 'handshake',
      direction: 'in',
      from: 'ab'.repeat(32),
    });
    const ack = await storePairingEnvelope(s.store, {
      type: 'handshake-ack',
      direction: 'out',
      from: 'cd'.repeat(32),
    });
    await expect(
      s.client.contacts.completePairing({
        pairingId,
        handshakeEnvelopeId: replayed,
        handshakeAckEnvelopeId: ack,
      }),
    ).rejects.toMatchObject({ code: 'pairing_evidence_missing' });
    // Swapped types or directions do not count either.
    await expect(
      s.client.contacts.completePairing({
        pairingId,
        handshakeEnvelopeId: ack,
        handshakeAckEnvelopeId: replayed,
      }),
    ).rejects.toMatchObject({ code: 'pairing_evidence_missing' });
    expect(await s.client.contacts.list()).toEqual([]);
  });

  it('a replayed old card cannot re-pair an existing contact, and changes nothing', async () => {
    const s = await self();
    const v0 = await peerCard(2, ownerB);
    const v1 = await peerCard(2, ownerB, { keyEpoch: 1 });
    await pair(s, v1);
    const before = await contactRow(s, v1.card.agentEvm);
    await expect(
      s.client.contacts.stagePairing({ ...v0, role: 'invitee', expiresAt: clock.t + 60 }),
    ).rejects.toMatchObject({ code: 'repair_epoch_lower' });
    // Replaying the current card stages a pairing but, without a completed handshake, changes nothing.
    await s.client.contacts.stagePairing({ ...v1, role: 'invitee', expiresAt: clock.t + 60 });
    expect(await contactRow(s, v1.card.agentEvm)).toEqual(before);
  });

  it('a re-pair in progress leaves the contact, its pairing and its safety check unchanged until completion', async () => {
    const s = await self();
    const v0 = await peerCard(2, ownerB);
    await pair(s, v0);
    const id = v0.card.agentEvm;
    await s.store.transaction((tx) =>
      tx.update(
        'contacts',
        { contact_id: id },
        { safety_check: '{"signed":"x"}', safety_code_checked: 1 },
      ),
    );
    const before = await contactRow(s, id);

    const v1 = await peerCard(2, ownerB, { keyEpoch: 1 });
    const { pairingId } = await s.client.contacts.stagePairing({
      ...v1,
      role: 'invitee',
      expiresAt: clock.t + 60,
    });
    expect(await contactRow(s, id)).toEqual(before);
    const mid = await s.client.contacts.get(id);
    expect(mid.keyEpoch).toBe(0);
    expect(mid.safetyCodeChecked).toBe(true);
    expect(mid.pairing).toBe('complete');
    // The new key is not the contact's until completion.
    expect(await s.client.contacts.screenInbound(nostrOf(v1))).toEqual({
      action: 'continue',
      sender: { kind: 'unknown' },
    });

    const done = await s.client.contacts.completePairing({
      pairingId,
      ...(await evidence(s, v1, 'invitee')),
    });
    expect(done.keyEpoch).toBe(1);
    expect(done.pairing).toBe('complete');
    expect(done.safetyCodeChecked).toBe(false);
    const after = await contactRow(s, id);
    expect(after?.safety_check).toBeNull();
    expect(after?.handshake_ack_envelope_id).not.toBe(before?.handshake_ack_envelope_id);
    expect(await s.client.contacts.list()).toHaveLength(1);
  });

  it('an aborted handshake leaves the store as it was', async () => {
    const s = await self();
    const v0 = await peerCard(2, ownerB);
    await pair(s, v0);
    const before = await s.store.transaction((tx) => tx.select('contacts'));
    const { pairingId } = await s.client.contacts.stagePairing({
      ...(await peerCard(2, ownerB, { keyEpoch: 1 })),
      role: 'invitee',
      expiresAt: clock.t + 60,
    });
    await s.client.contacts.abortPairing(pairingId);
    expect(await s.store.transaction((tx) => tx.select('contacts'))).toEqual(before);
    expect(await s.store.transaction((tx) => tx.count('pairings'))).toBe(0);
    await expect(
      s.client.contacts.completePairing({
        pairingId,
        handshakeEnvelopeId: 'a',
        handshakeAckEnvelopeId: 'b',
      }),
    ).rejects.toMatchObject({ code: 'pairing_not_found' });
  });

  it('refuses a staged pairing after its expiry', async () => {
    const s = await self();
    const card = await peerCard(2, ownerB);
    const { pairingId } = await s.client.contacts.stagePairing({
      ...card,
      role: 'invitee',
      expiresAt: clock.t + 60,
    });
    const proof = await evidence(s, card, 'invitee');
    clock.t += 60;
    try {
      await expect(
        s.client.contacts.completePairing({ pairingId, ...proof }),
      ).rejects.toMatchObject({ code: 'pairing_expired' });
    } finally {
      clock.t -= 60;
    }
    expect(await s.client.contacts.list()).toEqual([]);
  });

  it('refuses a re-pair with changed owner keys, at staging and again at completion', async () => {
    const s = await self();
    const v0 = await peerCard(2, ownerB);
    // Stage a pairing for agent 2 under owner C before agent 2 is a contact under owner B.
    const { pairingId } = await s.client.contacts.stagePairing({
      ...(await peerCard(2, ownerC, { keyEpoch: 1 })),
      role: 'invitee',
      expiresAt: clock.t + 60,
    });
    await pair(s, v0);
    await expect(
      s.client.contacts.stagePairing({
        ...(await peerCard(2, ownerC, { keyEpoch: 1 })),
        role: 'invitee',
        expiresAt: clock.t + 60,
      }),
    ).rejects.toMatchObject({ code: 'repair_owner_changed' });
    await expect(
      s.client.contacts.completePairing({
        pairingId,
        ...(await evidence(s, await peerCard(2, ownerC, { keyEpoch: 1 }), 'invitee')),
      }),
    ).rejects.toMatchObject({ code: 'repair_owner_changed' });
    expect((await s.client.contacts.get(v0.card.agentEvm)).keyEpoch).toBe(0);
  });

  it('refuses a pairing for a revoked agentId, also after the contact was removed', async () => {
    const s = await self();
    const card = await peerCard(2, ownerB);
    await pair(s, card);
    await s.store.transaction((tx) => {
      tx.insert('revoked_agents', {
        agent_evm: card.card.agentEvm,
        nostr_keys: JSON.stringify([nostrOf(card)]),
        signed_json: null,
        reason: null,
        source: 'registry',
        chain_id: '8453',
        registry_ref: 'r',
        applied_at: clock.t,
      });
      tx.update('contacts', { contact_id: card.card.agentEvm }, { status: 'revoked' });
    });
    const stage = () =>
      s.client.contacts.stagePairing({ ...card, role: 'invitee', expiresAt: clock.t + 60 });
    await expect(stage()).rejects.toMatchObject({ code: 'contact_revoked' });
    await s.client.contacts.remove(card.card.agentEvm);
    await expect(stage()).rejects.toMatchObject({ code: 'contact_revoked' });
  });
});

describe('contacts.applyCardUpdate (04 §2.6, §3.4.1)', () => {
  it('takes a higher epoch signed by the same owner and keeps the old key as superseded', async () => {
    const s = await self();
    const v0 = await peerCard(2, ownerB);
    await pair(s, v0);
    const v1 = await peerCard(2, ownerB, { keyEpoch: 1, name: 'Denis agent v2' });
    const updated = await s.client.contacts.applyCardUpdate({
      card: v1.card,
      cardSig: v1.cardSig,
      name: v1.name,
      relays: v1.relays,
    });
    expect(updated.keyEpoch).toBe(1);
    expect(updated.name.value).toBe('Denis agent v2');
    expect(updated.name.selfDeclared).toBe(true);
    expect(await s.client.contacts.screenInbound(nostrOf(v0))).toEqual({
      action: 'continue',
      sender: { kind: 'superseded', contactId: v0.card.agentEvm },
    });
    expect(await s.client.contacts.screenInbound(nostrOf(v1))).toEqual({
      action: 'continue',
      sender: { kind: 'contact', contactId: v0.card.agentEvm },
    });
  });

  it('keeps a name the owner chose (L-4)', async () => {
    const s = await self();
    const v0 = await peerCard(2, ownerB);
    await pair(s, v0);
    const id = v0.card.agentEvm;
    const alias = await new TestStoreCipher().seal(
      { table: 'contacts', column: 'name', rowKey: rowKeyOf([id]) },
      'Denis (work)',
    );
    await s.store.transaction((tx) =>
      tx.update('contacts', { contact_id: id }, { name: alias, name_source: 'owner' }),
    );
    const v1 = await peerCard(2, ownerB, { keyEpoch: 1, name: 'Totally Legit Bank' });
    const updated = await s.client.contacts.applyCardUpdate(v1);
    expect(updated.name).toEqual({ value: 'Denis (work)', source: 'owner', selfDeclared: false });
  });

  it('refuses an update that is not newer, changes the owner, names an unknown or removed agent, or is forged', async () => {
    const s = await self();
    const v1 = await peerCard(2, ownerB, { keyEpoch: 1 });
    await pair(s, v1);
    await expect(s.client.contacts.applyCardUpdate(v1)).rejects.toMatchObject({
      code: 'card_update_not_newer',
    });
    await expect(
      s.client.contacts.applyCardUpdate(await peerCard(2, ownerC, { keyEpoch: 2 })),
    ).rejects.toMatchObject({ code: 'owner_keys_changed' });
    await expect(
      s.client.contacts.applyCardUpdate(await peerCard(3, ownerB, { keyEpoch: 2 })),
    ).rejects.toMatchObject({ code: 'contact_not_found' });
    const v2 = await peerCard(2, ownerB, { keyEpoch: 2 });
    await expect(
      s.client.contacts.applyCardUpdate({ ...v2, cardSig: (await peerCard(3, ownerC)).cardSig }),
    ).rejects.toMatchObject({ code: 'card_owner_signature_invalid' });
    await s.client.contacts.remove(v1.card.agentEvm);
    await expect(s.client.contacts.applyCardUpdate(v2)).rejects.toMatchObject({
      code: 'contact_not_found',
    });
  });

  it('refuses a key that belongs to another contact, the own agent or a revoked agent (L-2)', async () => {
    const s = await self();
    const x0 = await peerCard(2, ownerB);
    await pair(s, x0);
    await s.client.contacts.applyCardUpdate(await peerCard(2, ownerB, { keyEpoch: 1 }));
    const y = await peerCard(3, ownerB);
    await pair(s, y);
    const own = await s.client.identity.signedCard();
    const r = await peerCard(4, ownerC);
    await s.store.transaction((tx) =>
      tx.insert('revoked_agents', {
        agent_evm: r.card.agentEvm,
        nostr_keys: JSON.stringify([nostrOf(r)]),
        signed_json: null,
        reason: 'compromised',
        source: 'registry',
        chain_id: '8453',
        registry_ref: 'r',
        applied_at: clock.t,
      }),
    );
    for (const agentNostr of [x0.card.agentNostr, own.card.agentNostr, r.card.agentNostr]) {
      const update = await ownerSignedUpdate(ownerB, y, { keyEpoch: 1, agentNostr });
      await expect(s.client.contacts.applyCardUpdate(update)).rejects.toMatchObject({
        code: 'contact_conflict',
      });
    }
    expect((await s.client.contacts.get(y.card.agentEvm)).keyEpoch).toBe(0);
  });
});

describe('block and remove (02 F-14) and the inbound screen', () => {
  it('drops envelopes from a blocked contact', async () => {
    const s = await self();
    const card = await peerCard(2, ownerB);
    const contact = await pair(s, card);
    expect(await s.client.contacts.screenInbound(nostrOf(card))).toEqual({
      action: 'continue',
      sender: { kind: 'contact', contactId: contact.id },
    });
    const blocked = await s.client.contacts.block(contact.id);
    expect(blocked.status).toBe('blocked');
    expect(await s.client.contacts.screenInbound(nostrOf(card))).toEqual({
      action: 'drop',
      reason: 'blocked',
    });
    const v1 = await peerCard(2, ownerB, { keyEpoch: 1 });
    await s.client.contacts.applyCardUpdate(v1);
    for (const key of [nostrOf(card), nostrOf(v1)]) {
      expect(await s.client.contacts.screenInbound(key)).toEqual({
        action: 'drop',
        reason: 'blocked',
      });
    }
  });

  it('remove keeps a tombstone: later envelopes from any of its keys are dropped, never a request (M-1)', async () => {
    const s = await self();
    const v0 = await peerCard(2, ownerB);
    const contact = await pair(s, v0);
    const v1 = await peerCard(2, ownerB, { keyEpoch: 1 });
    await s.client.contacts.applyCardUpdate(v1);
    await s.client.contacts.remove(contact.id);
    expect(await s.client.contacts.list()).toEqual([]);
    await expect(s.client.contacts.get(contact.id)).rejects.toMatchObject({
      code: 'contact_not_found',
    });
    await expect(s.client.contacts.block(contact.id)).rejects.toMatchObject({
      code: 'contact_not_found',
    });
    expect((await contactRow(s, contact.id))?.status).toBe('removed');
    for (const key of [nostrOf(v0), nostrOf(v1)]) {
      expect(await s.client.contacts.screenInbound(key)).toEqual({
        action: 'drop',
        reason: 'removed',
      });
    }
  });

  it('a removed contact comes back only through a fresh completed pairing (re-pair rules apply)', async () => {
    const s = await self();
    const v0 = await peerCard(2, ownerB);
    await pair(s, v0);
    await s.client.contacts.remove(v0.card.agentEvm);
    const back = await pair(s, await peerCard(2, ownerB, { keyEpoch: 1 }));
    expect(back.status).toBe('active');
    expect(back.keyEpoch).toBe(1);
    await s.client.contacts.remove(v0.card.agentEvm);
    await expect(
      s.client.contacts.stagePairing({
        ...(await peerCard(2, ownerC, { keyEpoch: 1 })),
        role: 'invitee',
        expiresAt: clock.t + 60,
      }),
    ).rejects.toMatchObject({ code: 'repair_owner_changed' });
  });

  // IR-M1-7a-1 R2-M1, owned by M1-7b (backlog acceptance item): a blocked or removed contact that
  // rotates keys has its card-update dropped, so its new key stays unknown. An envelope from an
  // unknown key whose recipients include the ownerEnc kid of a blocked or removed contact's owner
  // must be dropped: never held, never queued as a request, also after 48 h.
  it.todo(
    'M1-7b: drops (never holds or queues) an envelope from an unknown key carrying the owner kid of a blocked or removed contact',
  );

  it('a blocked contact stays blocked across a re-pair', async () => {
    const s = await self();
    const v0 = await peerCard(2, ownerB);
    await pair(s, v0);
    await s.client.contacts.block(v0.card.agentEvm);
    const again = await pair(s, await peerCard(2, ownerB, { keyEpoch: 1 }));
    expect(again.status).toBe('blocked');
  });

  it('drops envelopes from any key of a revoked agent, also after removal', async () => {
    const s = await self();
    const card = await peerCard(2, ownerB);
    await pair(s, card);
    await s.store.transaction((tx) =>
      tx.insert('revoked_agents', {
        agent_evm: card.card.agentEvm,
        nostr_keys: JSON.stringify([nostrOf(card)]),
        signed_json: null,
        reason: 'compromised',
        source: 'registry',
        chain_id: '8453',
        registry_ref: 'r',
        applied_at: clock.t,
      }),
    );
    expect(await s.client.contacts.screenInbound(nostrOf(card))).toEqual({
      action: 'drop',
      reason: 'revoked',
    });
    await s.client.contacts.remove(card.card.agentEvm);
    expect(await s.client.contacts.screenInbound(nostrOf(card))).toEqual({
      action: 'drop',
      reason: 'revoked',
    });
  });

  it('cannot unrevoke by blocking or removing; reports unknown contacts and malformed keys', async () => {
    const s = await self();
    const card = await peerCard(2, ownerB);
    await pair(s, card);
    await s.store.transaction((tx) =>
      tx.update('contacts', { contact_id: card.card.agentEvm }, { status: 'revoked' }),
    );
    expect((await s.client.contacts.block(card.card.agentEvm)).status).toBe('revoked');
    await s.client.contacts.remove(card.card.agentEvm);
    expect((await contactRow(s, card.card.agentEvm))?.status).toBe('revoked');
    await expect(
      s.client.contacts.block(encodeHex0x(new Uint8Array(20).fill(9))),
    ).rejects.toMatchObject({ code: 'contact_not_found' });
    expect(await s.client.contacts.screenInbound('AB'.repeat(32))).toEqual({
      action: 'drop',
      reason: 'malformed',
    });
  });

  it('fails closed: a sealed value copied from another row or column is unreadable', async () => {
    const s = await self();
    const card = await peerCard(2, ownerB);
    const contact = await pair(s, card);
    const ownName = await s.store.transaction((tx) => tx.select('identity')[0]?.name);
    await s.store.transaction((tx) =>
      tx.update('contacts', { contact_id: contact.id }, { name: ownName as Sealed }),
    );
    await expect(s.client.contacts.list()).rejects.toMatchObject({ code: 'store_unreadable' });
    const row = await contactRow(s, contact.id);
    await s.store.transaction((tx) =>
      tx.update('contacts', { contact_id: contact.id }, { agent_card_json: row?.relays as Sealed }),
    );
    await expect(s.client.contacts.get(contact.id)).rejects.toMatchObject({
      code: 'store_unreadable',
    });
  });
});

describe('logging (I-7)', () => {
  it('never logs a name, a relay, a key or a signature', async () => {
    const lines: string[] = [];
    const logger = createLogger({ name: 'core', sink: (_level, line) => lines.push(line) });
    const store = new MemoryStore();
    const client = await AgentLinkClient.create({
      keyStore: new MemoryKeyStore(seed(1)),
      store,
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
    await pair({ client, store }, card);
    await client.contacts.applyCardUpdate(
      await peerCard(2, ownerB, { keyEpoch: 1, name: 'Peer-name-canary' }),
    );
    await client.contacts.block(card.card.agentEvm);
    await client.contacts.remove(card.card.agentEvm);
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
