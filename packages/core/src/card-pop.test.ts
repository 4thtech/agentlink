// M1-4d-d (D-102; 04 §2.9, §3.4.1, §3.6; 07 §3, §8): the producer side of the agent card's proof of
// possession. The core makes `cardAgentSig` and `cardPop` with every own card (init, owner add-agent,
// which runs init, and rotation, whose card a `card-update` carries), sends `cardPop` in `handshake`
// and `handshake-ack` and both in `card-update`, verifies and stores a contact's, and hands the pair to
// the proof pack's `signer` so a pack verifies (`verified`, not `record_only`). A present pair that
// does not verify drops the whole body; an absent one (a peer that predates M1-4d-d) is accepted and
// its packs stay `record_only`.
import {
  canonicalize,
  agentCardJcsHash,
  decodeHex0x,
  encodeBase64url,
  encodeHex,
  encodeHex0x,
  envelopeHash,
  generateCek,
  hashRecord,
  occV2Domain,
  recipientCommitment,
  recordTypedData,
  verifyCardPop,
  verifyCardPossession,
  type Envelope,
  type JsonValue,
  type OccRecord,
} from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import {
  computeRecordId,
  getChainConfig,
  verifyProofPack,
  type ChainConfig,
  type ReadClient,
  type VerifyChain,
} from '@4thtech-io/chain';
import { createLogger } from '@4thtech-io/log';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SignedCard } from './card.js';
import type { InboundReport } from './envelopes.js';
import { rowKeyOf } from './store/store.js';
import { FakeClock, passphrase, seed } from './testing/fixtures.js';
import {
  agentEnc,
  agentSigner,
  cardUpdatePayload,
  craft,
  giftWrapId,
  makeAgent,
  ownerEnc,
  pairWith,
  rotate,
  type TestAgent,
} from './testing/envelopes.js';

const clock = new FakeClock();
const ownerA = new MemoryOwnerKeyStore(seed(141), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(142), passphrase());

interface Agent extends TestAgent {
  readonly lines: string[];
}

async function agent(n: number, owner: MemoryOwnerKeyStore, name: string): Promise<Agent> {
  const lines: string[] = [];
  const logger = createLogger({
    name: 'core',
    level: 'debug',
    sink: (_l, line) => lines.push(line),
  });
  const made = await makeAgent(
    clock,
    new MemoryKeyStore(seed(n)),
    owner as unknown as TestAgent['owner'],
    name,
    logger,
  );
  return { ...made, lines };
}

async function deliver(to: TestAgent, envelope: unknown): Promise<InboundReport[]> {
  const received = await to.client.envelopes.receive({ envelope, giftWrapId: giftWrapId() });
  if (received.status !== 'verified') return [received.report];
  return to.client.envelopes.processReceived();
}

/** The newest stored outbound pairing envelope (what the send flow would publish). */
async function lastSent(from: TestAgent, type: 'handshake' | 'handshake-ack'): Promise<Envelope> {
  const rows = await from.store.transaction((tx) =>
    tx.select('envelopes', { direction: 'out', type }, { orderBy: [['created_at', 'desc']] }),
  );
  const json = rows[0]?.envelope_json;
  if (json == null) throw new Error('test: nothing sent');
  return JSON.parse(json) as Envelope;
}

/** The stored (sealed) payload body of an envelope. */
async function bodyOf(x: TestAgent, id: string): Promise<Record<string, JsonValue>> {
  const row = await x.store.transaction((tx) => tx.get('envelopes', { envelope_id: id }));
  if (row?.payload_json == null) throw new Error('test: no payload');
  const text = await x.cipher.open(
    { table: 'envelopes', column: 'payload_json', rowKey: JSON.stringify([id]) },
    row.payload_json,
  );
  return (JSON.parse(text) as { body: Record<string, JsonValue> }).body;
}

const fromOf = (card: SignedCard): string => card.card.agentNostr.slice(2);

/** The 04 §3.2 entries of an envelope from `from` to `to`. */
async function entries(to: TestAgent, from: TestAgent) {
  return [
    { pk: await agentEnc(to) },
    { pk: await ownerEnc(to.owner) },
    { pk: await ownerEnc(from.owner) },
    { pk: await agentEnc(from) },
  ];
}

let a: Agent;
let b: Agent;

beforeEach(async () => {
  a = await agent(41, ownerA, 'alice');
  b = await agent(42, ownerB, 'bob');
});

describe('own card: both signatures at init and at every new card (04 §2.9)', () => {
  it('init makes cardAgentSig and cardPop over the card and keeps them with it', async () => {
    const own = await a.client.identity.signedCard();
    expect(verifyCardPossession(own.card, own.cardAgentSig, own.cardPop)).toBe(true);
    const view = await a.client.identity.get();
    expect(view?.cardPop).toBe(own.cardPop);
  });

  it('rotation re-signs: the new card has its own pair, and the old cardPop fails it', async () => {
    const before = await a.client.identity.signedCard();
    await rotate(a);
    const after = await a.client.identity.signedCard();
    expect(after.card.keyEpoch).toBe(1);
    expect(verifyCardPossession(after.card, after.cardAgentSig, after.cardPop)).toBe(true);
    expect(verifyCardPop(after.card, before.cardPop)).toBe(false);
  });

  it('the card-update the core sends carries both signatures for the new card', async () => {
    await rotate(a);
    const payload = (await cardUpdatePayload(a)) as { body: Record<string, JsonValue> };
    const card = payload.body.card as unknown as SignedCard['card'];
    expect(verifyCardPossession(card, payload.body.cardAgentSig, payload.body.cardPop)).toBe(true);
  });

  it('a card stored before M1-4d-d gets its cardPop on first use, and keeps it', async () => {
    const own = await a.client.identity.signedCard();
    // The pre-M1-4d-d stored form: {card, cardSig, cardAgentSig}, no cardPop key.
    const legacy = canonicalize({
      card: own.card as unknown as JsonValue,
      cardSig: own.cardSig,
      cardAgentSig: own.cardAgentSig,
    });
    const sealed = await a.cipher.seal(
      { table: 'identity', column: 'agent_card_json', rowKey: rowKeyOf([a.id]) },
      legacy,
    );
    await a.store.transaction((tx) =>
      tx.update('identity', { agent_id: a.id }, { agent_card_json: sealed }),
    );
    expect((await a.client.identity.get())?.cardPop).toBeNull();
    expect(await a.client.proofSigner(fromOf(own))).toEqual({
      evm: a.id,
      agentCard: own.card,
      cardSig: own.cardSig,
    });
    const used = await a.client.identity.signedCard();
    expect(verifyCardPossession(used.card, used.cardAgentSig, used.cardPop)).toBe(true);
    expect((await a.client.identity.get())?.cardPop).toBe(used.cardPop);
  });
});

describe('pairing carries cardPop (04 §3.6, §3.4.1)', () => {
  async function pairFully() {
    const invite = await a.client.pairing.createInvite();
    const accepted = await b.client.pairing.acceptInvite({ link: invite.inviteUrl, allowed: true });
    if (accepted.status !== 'pending') throw new Error('test: not accepted');
    const atA = await deliver(a, accepted.handshake.envelope);
    const ack = await lastSent(a, 'handshake-ack');
    const atB = await deliver(b, ack);
    return { invite, accepted, atA, atB, ack };
  }

  it('handshake and handshake-ack carry the sender cardPop; both sides store the verified pair', async () => {
    const { accepted, atA, atB, ack } = await pairFully();
    expect(atA).toMatchObject([{ outcome: 'ok', contactId: b.id }]);
    expect(atB).toMatchObject([{ outcome: 'ok', contactId: a.id }]);
    const aCard = await a.client.identity.signedCard();
    const bCard = await b.client.identity.signedCard();
    expect((await bodyOf(b, accepted.handshake.envelope.id)).cardPop).toBe(bCard.cardPop);
    expect((await bodyOf(a, ack.id)).cardPop).toBe(aCard.cardPop);
    // A stored B's pair from the handshake; B stored A's cardAgentSig (invite) and cardPop (ack).
    expect(await a.client.proofSigner(fromOf(bCard))).toEqual({
      evm: b.id,
      agentCard: bCard.card,
      cardSig: bCard.cardSig,
      cardAgentSig: bCard.cardAgentSig,
      cardPop: bCard.cardPop,
    });
    expect(await b.client.proofSigner(fromOf(aCard))).toEqual({
      evm: a.id,
      agentCard: aCard.card,
      cardSig: aCard.cardSig,
      cardAgentSig: aCard.cardAgentSig,
      cardPop: aCard.cardPop,
    });
  });

  /** B's real handshake, re-signed by B with its body `change`d (a peer that sends other values). */
  async function reSignedHandshake(change: (body: Record<string, JsonValue>) => void) {
    const invite = await a.client.pairing.createInvite();
    const accepted = await b.client.pairing.acceptInvite({ link: invite.inviteUrl, allowed: true });
    if (accepted.status !== 'pending') throw new Error('test');
    const body = { ...(await bodyOf(b, accepted.handshake.envelope.id)) };
    change(body);
    return craft({
      signer: await agentSigner(b.keyStore),
      entries: await entries(a, b),
      payload: { type: 'handshake', body, replyTo: null, files: [] },
      createdAt: clock.t,
      id: accepted.handshake.envelope.id,
      thread: accepted.handshake.envelope.thread,
    });
  }

  it('A drops a whole handshake whose cardPop is present but invalid (tampered or replayed)', async () => {
    const aPop = (await a.client.identity.signedCard()).cardPop;
    const bOwn = await b.client.identity.signedCard();
    const flipped = `${bOwn.cardPop.slice(0, -2)}${bOwn.cardPop.endsWith('00') ? '01' : '00'}`;
    for (const cardPop of [flipped, aPop]) {
      const env = await reSignedHandshake((body) => {
        body.cardPop = cardPop;
      });
      expect(await deliver(a, env)).toMatchObject([{ outcome: 'dropped' }]);
    }
    expect(await a.client.contacts.list()).toEqual([]);
    expect(await a.store.transaction((tx) => tx.count('pairings'))).toBe(0);
    for (const line of a.lines) expect(line).not.toContain(flipped.slice(0, 16));
  });

  it('A accepts a handshake without cardPop (older peer); its card then has no pair', async () => {
    const env = await reSignedHandshake((body) => {
      delete body.cardPop;
    });
    expect(await deliver(a, env)).toMatchObject([{ outcome: 'ok', contactId: b.id }]);
    const bCard = await b.client.identity.signedCard();
    expect(await a.client.proofSigner(fromOf(bCard))).toEqual({
      evm: b.id,
      agentCard: bCard.card,
      cardSig: bCard.cardSig,
    });
  });

  it('B drops a whole ack whose cardPop is invalid and stays pending; the real ack completes', async () => {
    const invite = await a.client.pairing.createInvite();
    const accepted = await b.client.pairing.acceptInvite({ link: invite.inviteUrl, allowed: true });
    if (accepted.status !== 'pending') throw new Error('test');
    await deliver(a, accepted.handshake.envelope);
    const real = await lastSent(a, 'handshake-ack');
    const realBody = await bodyOf(a, real.id);
    const bPop = (await b.client.identity.signedCard()).cardPop;
    for (const cardPop of [bPop, `${'ab'.repeat(64)}`]) {
      const bad = await craft({
        signer: await agentSigner(a.keyStore),
        entries: await entries(b, a),
        payload: {
          type: 'handshake-ack',
          body: { ...realBody, cardPop },
          replyTo: accepted.handshake.envelope.id,
          files: [],
        },
        createdAt: clock.t,
        thread: real.thread,
      });
      expect(await deliver(b, bad)).toMatchObject([{ outcome: 'dropped' }]);
    }
    expect(await b.client.contacts.list()).toEqual([]);
    expect(await deliver(b, real)).toMatchObject([{ outcome: 'ok', contactId: a.id }]);
  });

  it('B accepts an ack without cardPop (older peer): A card keeps cardAgentSig, no pair', async () => {
    const invite = await a.client.pairing.createInvite();
    const accepted = await b.client.pairing.acceptInvite({ link: invite.inviteUrl, allowed: true });
    if (accepted.status !== 'pending') throw new Error('test');
    await deliver(a, accepted.handshake.envelope);
    const real = await lastSent(a, 'handshake-ack');
    const legacy = { ...(await bodyOf(a, real.id)) };
    delete legacy.cardPop;
    const old = await craft({
      signer: await agentSigner(a.keyStore),
      entries: await entries(b, a),
      payload: {
        type: 'handshake-ack',
        body: legacy,
        replyTo: accepted.handshake.envelope.id,
        files: [],
      },
      createdAt: clock.t,
      thread: real.thread,
    });
    expect(await deliver(b, old)).toMatchObject([{ outcome: 'ok', contactId: a.id }]);
    const aCard = await a.client.identity.signedCard();
    expect(await b.client.proofSigner(fromOf(aCard))).toEqual({
      evm: a.id,
      agentCard: aCard.card,
      cardSig: aCard.cardSig,
    });
  });
});

describe('card-update carries both (04 §3.4.1)', () => {
  beforeEach(async () => {
    await pairWith(clock, a, b);
    await pairWith(clock, b, a);
    await rotate(b);
  });

  async function cardUpdate(change: (body: Record<string, JsonValue>) => void = () => undefined) {
    const payload = (await cardUpdatePayload(b)) as { body: Record<string, JsonValue> };
    const body = { ...payload.body };
    change(body);
    return craft({
      signer: await agentSigner(b.keyStore),
      entries: await entries(a, b),
      payload: { ...payload, body } as unknown as JsonValue,
      createdAt: clock.t,
    });
  }

  it('a card-update with a valid pair is applied and the pair stored with the new card', async () => {
    const env = await cardUpdate();
    expect(await deliver(a, env)).toEqual([
      { envelopeId: env.id, outcome: 'ok', contactId: b.id, flagged: false },
    ]);
    const bCard = await b.client.identity.signedCard();
    expect(await a.client.proofSigner(fromOf(bCard))).toEqual({
      evm: b.id,
      agentCard: bCard.card,
      cardSig: bCard.cardSig,
      cardAgentSig: bCard.cardAgentSig,
      cardPop: bCard.cardPop,
    });
  });

  it('a present but invalid or half pair drops the whole card-update; the old card stays', async () => {
    const epoch0 = await a.store.transaction((tx) => tx.get('contacts', { contact_id: b.id }));
    const old = await a.client.proofSigner(epoch0?.agent_nostr ?? '');
    const changes: ((body: Record<string, JsonValue>) => void)[] = [
      // A replay of the previous epoch's signatures.
      (body) => {
        body.cardPop = old?.cardPop ?? null;
        body.cardAgentSig = old?.cardAgentSig ?? null;
      },
      (body) => {
        body.cardPop = old?.cardPop ?? null;
      },
      (body) => {
        body.cardAgentSig = old?.cardAgentSig ?? null;
      },
      (body) => {
        delete body.cardPop;
      },
      (body) => {
        delete body.cardAgentSig;
      },
    ];
    for (const change of changes) {
      const env = await cardUpdate(change);
      // A half pair fails the payload schema, an invalid one the card check: dropped either way.
      expect(await deliver(a, env)).toMatchObject([{ outcome: 'dropped' }]);
      const row = await a.store.transaction((tx) => tx.get('contacts', { contact_id: b.id }));
      expect(row?.key_epoch).toBe(0);
    }
  });

  it('a card-update without the pair (older peer) is applied; its card has no pair', async () => {
    const env = await cardUpdate((body) => {
      delete body.cardPop;
      delete body.cardAgentSig;
    });
    expect(await deliver(a, env)).toMatchObject([{ outcome: 'ok', contactId: b.id }]);
    const bCard = await b.client.identity.signedCard();
    expect(await a.client.proofSigner(fromOf(bCard))).toEqual({
      evm: b.id,
      agentCard: bCard.card,
      cardSig: bCard.cardSig,
    });
  });
});

// --- end to end: a proof pack with the produced pair verifies (07 §8) ------------------------------

/** The record-message vector's fee asset address (a named constant keeps secret scanners off it). */
const FEE_ASSET = '0x05f7cddba6070777972ad9ff9df5312872a49685';

/** A Base Sepolia read client that answers getRecord with `state` and has no code at any address. */
function fakeChain(config: ChainConfig, state: Record<string, unknown>): VerifyChain {
  const client = {
    readContract: () => Promise.resolve(state),
    getCode: () => Promise.resolve(undefined),
  } as unknown as ReadClient;
  return { config, client };
}

/** A pack for an envelope `from` sent to `to`, signed (Record) by `from`'s agent key. */
async function packFor(from: TestAgent, to: TestAgent, signer: object | undefined) {
  const config = getChainConfig(84532) as ChainConfig;
  const notary = config.contracts.notary;
  const cek = generateCek();
  const envelope = await craft({
    signer: await agentSigner(from.keyStore),
    entries: await entries(to, from),
    cek,
    createdAt: clock.t,
  });
  const envHash = encodeHex0x(envelopeHash(envelope));
  const salt = `0x${'5a'.repeat(32)}`;
  const record: OccRecord = {
    signer: from.id,
    envelopeHash: envHash,
    recipientCommitment: encodeHex0x(recipientCommitment(to.id, salt)),
    parentRecordId: `0x${'0'.repeat(64)}`,
    appId: `0x${'0'.repeat(64)}`,
    kind: 1,
    feeToken: FEE_ASSET,
    maxFee: '250000',
    nonce: '424242',
    deadline: clock.t + 3_600,
  };
  const domain = occV2Domain(config.chainId, notary);
  const signature = await from.keyStore.sign712(recordTypedData(domain, record));
  const notarizedAt = clock.t + 100;
  const deliveredAt = clock.t + 200;
  const state = {
    signer: from.id,
    timestamp: BigInt(notarizedAt),
    kind: 1,
    receiptFlags: 1,
    envelopeHash: envHash,
    recipientCommitment: record.recipientCommitment,
    recordStructHash: encodeHex0x(hashRecord(domain, record).structHash),
    receiptAt: [BigInt(deliveredAt), 0n, 0n, 0n],
  };
  const iso = (s: number) => new Date(s * 1000).toISOString().replace('.000Z', 'Z');
  const pack = {
    type: 'agentlink.proof',
    version: 1,
    chainId: config.chainId,
    notary,
    recordId: computeRecordId(config.chainId, notary, from.id, BigInt(record.nonce)),
    record,
    signature,
    signer: signer ?? { evm: from.id },
    envelopeHash: envHash,
    envelope,
    disclosure: { contentKey: encodeBase64url(cek) },
    ownerApproval: null,
    exportedAt: iso(clock.t + 300),
    recipient: { evm: to.id, salt },
    receipts: [
      { type: 'DELIVERED', signer: to.id, txHash: `0x${'cd'.repeat(32)}`, at: iso(deliveredAt) },
    ],
  };
  return { pack, chain: fakeChain(config, state), from: envelope.from };
}

describe('the pair reaches the proof pack (07 §8)', () => {
  beforeEach(async () => {
    await pairWith(clock, b, a);
  });

  it('init -> the own signer card -> verify: verified for an account signer', async () => {
    const own = await a.client.identity.signedCard();
    const signer = await a.client.proofSigner(fromOf(own));
    expect(signer).toMatchObject({ cardAgentSig: own.cardAgentSig, cardPop: own.cardPop });
    const { pack, chain } = await packFor(a, b, signer);
    const result = await verifyProofPack(JSON.stringify(pack), { chains: [chain] });
    expect(result.verdict).toBe('verified');
  });

  it('a recipient-exported pack with the contact pair also verifies', async () => {
    const signer = await b.client.proofSigner(fromOf(await a.client.identity.signedCard()));
    const { pack, chain } = await packFor(a, b, signer);
    expect((await verifyProofPack(JSON.stringify(pack), { chains: [chain] })).verdict).toBe(
      'verified',
    );
  });

  it('a card without the pair (older peer) stays record_only (card_pop_missing)', async () => {
    const full = await a.client.proofSigner(fromOf(await a.client.identity.signedCard()));
    const cardOnly: Record<string, unknown> = { ...full };
    delete cardOnly.cardAgentSig;
    delete cardOnly.cardPop;
    const { pack, chain } = await packFor(a, b, cardOnly);
    const result = await verifyProofPack(JSON.stringify(pack), { chains: [chain] });
    expect(result.verdict).toBe('record_only');
    expect(JSON.stringify(result)).toContain('card_pop_missing');
  });

  it('an unknown sender key has no signer card', async () => {
    expect(await a.client.proofSigner('00'.repeat(32))).toBeUndefined();
    expect(await a.client.proofSigner('not hex')).toBeUndefined();
  });

  it('no log line carries a card signature or key material', async () => {
    const own = await a.client.identity.signedCard();
    await rotate(a);
    const all = [...a.lines, ...b.lines].join('\n');
    expect(all).not.toContain(own.cardPop.slice(0, 24));
    expect(all).not.toContain(own.cardAgentSig.slice(2, 26));
    expect(all).not.toContain(encodeHex(agentCardJcsHash(own.card)).slice(0, 24));
    expect(all).not.toContain(encodeHex(decodeHex0x(own.card.agentNostr)).slice(0, 24));
  });
});
