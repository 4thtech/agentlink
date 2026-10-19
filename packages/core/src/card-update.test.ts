// M1-4d-f (D-102; 04 §2.6, §2.9, §3.4.1; 07 §3, §8): the core's `card-update` sender, the agent's own
// card history, and the compare-and-set of a late `cardPop`.
//
// - Sender. After the agent's card changes (every change is a new key epoch, 07 §4.3), the core sends
//   one `card-update` to each active contact that does not hold the current card yet, carrying the
//   new card with `cardSig`, `cardAgentSig` and `cardPop`. It is idempotent: a contact that already
//   got the current card (a `card-update`, or the pairing message, from the current key) gets none.
// - Receiver. The contact applies it and stores the pair with the card; a replayed or older one is
//   refused (the epoch must increase, 04 §3.4.1).
// - History. The agent keeps its own earlier cards (one per key epoch) with their signatures, so
//   `proofSigner(from)` returns the card of the envelope's key epoch, and a pack for an envelope sent
//   before a rotation still verifies. A card that is not stored (a future epoch, a pending rotation)
//   has no signer.
// - Compare-and-set. A `cardPop` added on first use to a card stored before M1-4d-d is written with a
//   compare-and-set; a lost race is re-read (the winner's value is used) or reported, never ignored.
import {
  canonicalize,
  encodeHex,
  encodeBase64url,
  encodeHex0x,
  envelopeHash,
  generateCek,
  hashRecord,
  occV2Domain,
  recipientCommitment,
  recordTypedData,
  verifyCardPossession,
  type Envelope,
  type JsonValue,
  type KeyStore,
  type NostrEvent,
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
import { wrapEnvelope, type PublishOutcome } from '@4thtech-io/transport-nostr';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentLinkClient } from './client.js';
import { CoreError } from './errors.js';
import type { InboundReport } from './envelopes.js';
import { MemoryStore } from './store/memory-store.js';
import { rowKeyOf } from './store/store.js';
import {
  FakeClock,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
  RELAYS,
} from './testing/fixtures.js';
import {
  agentEnc,
  agentSigner,
  cardUpdatePayload,
  craft,
  giftWrapId,
  ownerEnc,
  pairWith,
  rotate,
  type TestAgent,
  type TestOwner,
} from './testing/envelopes.js';
import type { TransportFactory } from './transport.js';

const clock = new FakeClock();

/** A relay spy: records every publish and acks every relay. */
class RelaySpy {
  readonly published: NostrEvent[] = [];
  readonly factory: TransportFactory = (deps) => ({
    wrap: (envelope, recipients, keys) =>
      wrapEnvelope(envelope, recipients, keys, { now: deps.now }),
    publish: (event, relays) => {
      this.published.push(event);
      return Promise.resolve({
        results: relays.map((relay) => ({ relay, ok: true, reason: 'ok' as const })),
        acked: [...relays],
        sent: true,
      } as PublishOutcome);
    },
    // An empty catch-up pass: nothing new on the relays.
    sync: () =>
      Promise.resolve({
        partial: false,
        delivered: 0,
        duplicates: 0,
        dropped: 0,
        deferred: 0,
        relays: [],
      }),
  });
}

interface Agent extends TestAgent {
  readonly spy: RelaySpy;
}

async function agent(n: number, owner: MemoryOwnerKeyStore, name: string): Promise<Agent> {
  const store = new MemoryStore();
  const cipher = new TestStoreCipher();
  const keyStore: KeyStore = new MemoryKeyStore(seed(n));
  const spy = new RelaySpy();
  const client = await AgentLinkClient.create({
    keyStore,
    store,
    cipher,
    approvals: new RecordingApprovalChannel(),
    clock: clock.now,
    transport: spy.factory,
  });
  await client.identity.init({
    owner: await owner.unlock(passphrase()),
    ownerKeys: await owner.getPublicKeys(),
    name,
    relays: RELAYS,
  });
  const testOwner = owner as unknown as TestOwner;
  return { client, store, cipher, keyStore, owner: testOwner, id: client.agentId, spy };
}

async function deliver(to: TestAgent, envelope: unknown): Promise<InboundReport[]> {
  const received = await to.client.envelopes.receive({ envelope, giftWrapId: giftWrapId() });
  if (received.status !== 'verified') return [received.report];
  return to.client.envelopes.processReceived();
}

/** The stored outbound card-update envelopes of `from`, oldest first. */
async function sentCardUpdates(from: TestAgent) {
  const rows = await from.store.transaction((tx) =>
    tx.select(
      'envelopes',
      { direction: 'out', type: 'card-update' },
      { orderBy: [['created_at', 'asc']] },
    ),
  );
  return rows.map((row) => ({
    row,
    envelope: JSON.parse(row.envelope_json ?? 'null') as Envelope,
  }));
}

/** The stored (sealed) payload body of an envelope. */
async function bodyOf(x: TestAgent, id: string): Promise<Record<string, JsonValue>> {
  const row = await x.store.transaction((tx) => tx.get('envelopes', { envelope_id: id }));
  if (row?.payload_json == null) throw new Error('test: no payload');
  const text = await x.cipher.open(
    { table: 'envelopes', column: 'payload_json', rowKey: rowKeyOf([id]) },
    row.payload_json,
  );
  return (JSON.parse(text) as { body: Record<string, JsonValue> }).body;
}

const nostrOf = async (x: TestAgent): Promise<string> =>
  (await x.client.identity.signedCard()).card.agentNostr.slice(2);

/** The 04 §3.2 entries of an envelope from `from` to `to`. */
async function entries(to: TestAgent, from: TestAgent) {
  return [
    { pk: await agentEnc(to) },
    { pk: await ownerEnc(to.owner) },
    { pk: await ownerEnc(from.owner) },
    { pk: await agentEnc(from) },
  ];
}

/** Rewrites the own stored card JSON (sealed) through `change`. */
async function editOwnCard(x: TestAgent, change: (value: Record<string, unknown>) => void) {
  const row = await x.store.transaction((tx) => tx.select('identity')[0]);
  if (row === undefined) throw new Error('test: no identity');
  const context = {
    table: 'identity' as const,
    column: 'agent_card_json',
    rowKey: rowKeyOf([x.id]),
  };
  const value = JSON.parse(await x.cipher.open(context, row.agent_card_json)) as Record<
    string,
    unknown
  >;
  change(value);
  const sealed = await x.cipher.seal(context, canonicalize(value as JsonValue));
  await x.store.transaction((tx) =>
    tx.update('identity', { agent_id: x.id }, { agent_card_json: sealed }),
  );
}

// --- proof pack helpers (07 §8) ---------------------------------------------------------------------

/** The record-message vector's fee asset address (a named constant keeps secret scanners off it). */
const FEE_ASSET = '0x05f7cddba6070777972ad9ff9df5312872a49685';

function fakeChain(config: ChainConfig, state: Record<string, unknown>): VerifyChain {
  const client = {
    readContract: () => Promise.resolve(state),
    getCode: () => Promise.resolve(undefined),
  } as unknown as ReadClient;
  return { config, client };
}

/** A pack for an already crafted `envelope` from `from` to `to`, signed (Record) by `from`. */
async function packOf(from: TestAgent, to: TestAgent, envelope: Envelope, cek: Uint8Array) {
  const config = getChainConfig(84532) as ChainConfig;
  const notary = config.contracts.notary;
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
    nonce: '434343',
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
  const pack = (signer: object | undefined) => ({
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
  });
  return { pack, chain: fakeChain(config, state) };
}

const ownerA = new MemoryOwnerKeyStore(seed(151), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(152), passphrase());
const ownerC = new MemoryOwnerKeyStore(seed(153), passphrase());

let a: Agent;
let b: Agent;
let c: Agent;

beforeEach(async () => {
  a = await agent(51, ownerA, 'alice');
  b = await agent(52, ownerB, 'bob');
  c = await agent(53, ownerC, 'carol');
  // Both sides of a<->b and a<->c paired.
  await pairWith(clock, a, b);
  await pairWith(clock, b, a);
  await pairWith(clock, a, c);
  await pairWith(clock, c, a);
});

describe('card-update sender (04 §2.6, §2.9, §3.4.1)', () => {
  it('sends nothing while every contact holds the current card', async () => {
    expect(await a.client.sendCardUpdates()).toEqual({ sent: 0, failed: 0 });
    expect(await sentCardUpdates(a)).toHaveLength(0);
  });

  it('after a rotation: one card-update to every contact, with both signatures for the new card', async () => {
    await rotate(a);
    const own = await a.client.identity.signedCard();
    expect(await a.client.sendCardUpdates()).toEqual({ sent: 2, failed: 0 });
    const sent = await sentCardUpdates(a);
    expect(sent.map((s) => s.row.contact_id).sort()).toEqual([b.id, c.id].sort());
    for (const s of sent) {
      // From the new epoch key (04 §3.1.1 key table: the current key).
      expect(s.row.from_key).toBe(own.card.agentNostr.slice(2));
      const body = await bodyOf(a, s.row.envelope_id);
      expect(body.card).toEqual(own.card);
      expect(body.cardSig).toBe(own.cardSig);
      expect(body.name).toBe(own.name);
      expect(body.relays).toEqual([...own.relays]);
      expect(
        verifyCardPossession(own.card, body.cardAgentSig as string, body.cardPop as string),
      ).toBe(true);
    }
    // Published: one wrap per distinct recipient key of each envelope.
    expect(a.spy.published.length).toBeGreaterThanOrEqual(2);
  });

  it('is idempotent: a second pass sends nothing, a later rotation sends again', async () => {
    await rotate(a);
    await a.client.sendCardUpdates();
    expect(await a.client.sendCardUpdates()).toEqual({ sent: 0, failed: 0 });
    expect(await sentCardUpdates(a)).toHaveLength(2);
    await rotate(a);
    expect(await a.client.sendCardUpdates()).toEqual({ sent: 2, failed: 0 });
    expect(await sentCardUpdates(a)).toHaveLength(4);
  });

  it('syncInbox sends the pending card-updates, once', async () => {
    await rotate(a);
    await a.client.syncInbox();
    expect((await sentCardUpdates(a)).map((s) => s.row.contact_id).sort()).toEqual(
      [b.id, c.id].sort(),
    );
    await a.client.syncInbox();
    expect(await sentCardUpdates(a)).toHaveLength(2);
  });

  it('a card-update the outbox gave up on is sent again', async () => {
    await rotate(a);
    await a.client.sendCardUpdates();
    const toB = (await sentCardUpdates(a)).find((s) => s.row.contact_id === b.id);
    await a.store.transaction((tx) =>
      tx.update(
        'envelopes',
        { envelope_id: toB?.row.envelope_id ?? '' },
        { delivery: 'not_delivered' },
      ),
    );
    expect(await a.client.sendCardUpdates()).toEqual({ sent: 1, failed: 0 });
  });

  it('refuses to send without a transport, before anything is stored', async () => {
    const store = new MemoryStore();
    const keyStore = new MemoryKeyStore(seed(54));
    const offline = await AgentLinkClient.create({
      keyStore,
      store,
      cipher: new TestStoreCipher(),
      approvals: new RecordingApprovalChannel(),
      clock: clock.now,
    });
    await expect(offline.sendCardUpdates()).rejects.toMatchObject({
      code: 'transport_unavailable',
    });
  });

  it('skips a blocked contact', async () => {
    await a.client.contacts.block(c.id);
    await rotate(a);
    expect(await a.client.sendCardUpdates()).toEqual({ sent: 1, failed: 0 });
    expect((await sentCardUpdates(a)).map((s) => s.row.contact_id)).toEqual([b.id]);
  });

  it('refuses to send while the rotation is unfinished (rotation_pending)', async () => {
    const control = a.owner.epochControl(a.keyStore);
    await control.advanceEpoch(0, await a.owner.unlock(passphrase()));
    await expect(a.client.sendCardUpdates()).rejects.toMatchObject({ code: 'rotation_pending' });
    expect(await sentCardUpdates(a)).toHaveLength(0);
  });

  it('the contact accepts it and stores the new card with its pair', async () => {
    await rotate(a);
    await a.client.sendCardUpdates();
    const toB = (await sentCardUpdates(a)).find((s) => s.row.contact_id === b.id);
    expect(await deliver(b, toB?.envelope)).toMatchObject([{ outcome: 'ok', contactId: a.id }]);
    const own = await a.client.identity.signedCard();
    const row = await b.store.transaction((tx) => tx.get('contacts', { contact_id: a.id }));
    expect(row?.key_epoch).toBe(1);
    expect(await b.client.proofSigner(own.card.agentNostr.slice(2))).toEqual({
      evm: a.id,
      agentCard: own.card,
      cardSig: own.cardSig,
      cardAgentSig: own.cardAgentSig,
      cardPop: own.cardPop,
    });
  });

  it('a replayed or older card-update is refused; the newer card stays', async () => {
    await rotate(a);
    await a.client.sendCardUpdates();
    const first = (await sentCardUpdates(a)).find((s) => s.row.contact_id === b.id);
    await rotate(a);
    await a.client.sendCardUpdates();
    const second = (await sentCardUpdates(a)).filter((s) => s.row.contact_id === b.id)[1];
    expect(await deliver(b, second?.envelope)).toMatchObject([{ outcome: 'ok' }]);
    // The epoch-1 update, after epoch 2 was applied: not newer, dropped.
    expect(await deliver(b, first?.envelope)).toMatchObject([{ outcome: 'dropped' }]);
    // The same epoch-2 card again, in a fresh envelope from the current key: not newer, dropped.
    const again = await craft({
      signer: await agentSigner(a.keyStore),
      entries: await entries(b, a),
      payload: await cardUpdatePayload(a),
      createdAt: clock.t,
    });
    expect(await deliver(b, again)).toMatchObject([{ outcome: 'dropped' }]);
    const row = await b.store.transaction((tx) => tx.get('contacts', { contact_id: a.id }));
    expect(row?.key_epoch).toBe(2);
  });
});

describe('own card history: proofSigner for earlier key epochs (07 §8)', () => {
  it('returns the card of each retained epoch with its pair', async () => {
    const epoch0 = await a.client.identity.signedCard();
    await rotate(a);
    const epoch1 = await a.client.identity.signedCard();
    await rotate(a);
    const epoch2 = await a.client.identity.signedCard();
    for (const card of [epoch0, epoch1, epoch2]) {
      expect(await a.client.proofSigner(card.card.agentNostr.slice(2))).toEqual({
        evm: a.id,
        agentCard: card.card,
        cardSig: card.cardSig,
        cardAgentSig: card.cardAgentSig,
        cardPop: card.cardPop,
      });
    }
  });

  it('never returns a card for a future epoch or an unfinished rotation', async () => {
    const control = a.owner.epochControl(a.keyStore);
    const next = await control.previewEpoch(1);
    const nextKey = encodeHex(next.agentNostr);
    expect(await a.client.proofSigner(nextKey)).toBeUndefined();
    // The KeyStore advances, the card is not committed (rotation_pending): still no signer.
    await control.advanceEpoch(0, await a.owner.unlock(passphrase()));
    expect(await a.client.identity.sendState()).toBe('rotation_pending');
    expect(await a.client.proofSigner(nextKey)).toBeUndefined();
  });

  it('a pack for an envelope sent before the rotation verifies after it', async () => {
    const cek = generateCek();
    // Sent at epoch 0, from the epoch-0 key.
    const envelope = await craft({
      signer: await agentSigner(a.keyStore),
      entries: await entries(b, a),
      cek,
      createdAt: clock.t,
    });
    await rotate(a);
    await rotate(a);
    const signer = await a.client.proofSigner(envelope.from);
    expect(signer).toMatchObject({ agentCard: { keyEpoch: 0 } });
    const { pack, chain } = await packOf(a, b, envelope, cek);
    const result = await verifyProofPack(JSON.stringify(pack(signer)), { chains: [chain] });
    expect(result.verdict).toBe('verified');
    // The current card instead of the envelope's epoch card fails attribution.
    const current = await a.client.proofSigner(await nostrOf(a));
    const wrong = await verifyProofPack(JSON.stringify(pack(current)), { chains: [chain] });
    expect(wrong.verdict).not.toBe('verified');
  });

  it('a rotation signs the cardPop of a card stored before M1-4d-d, while it still can', async () => {
    const epoch0 = await a.client.identity.signedCard();
    await editOwnCard(a, (value) => {
      delete value.cardPop;
    });
    await rotate(a);
    const signer = await a.client.proofSigner(epoch0.card.agentNostr.slice(2));
    expect(signer?.cardPop).toBeDefined();
    expect(
      verifyCardPossession(epoch0.card, signer?.cardAgentSig ?? '', signer?.cardPop ?? ''),
    ).toBe(true);
  });

  it('a late cardPop on the current card keeps the history', async () => {
    const epoch0 = await a.client.identity.signedCard();
    await rotate(a);
    await editOwnCard(a, (value) => {
      delete value.cardPop;
    });
    const used = await a.client.identity.signedCard();
    expect(verifyCardPossession(used.card, used.cardAgentSig, used.cardPop)).toBe(true);
    expect(await a.client.proofSigner(epoch0.card.agentNostr.slice(2))).toMatchObject({
      agentCard: epoch0.card,
      cardPop: epoch0.cardPop,
    });
  });

  it('a stored history entry that does not verify makes the identity unreadable', async () => {
    await rotate(a);
    const current = await nostrOf(a);
    await editOwnCard(a, (value) => {
      const history = value.history as Record<string, unknown>[];
      const entry = history[0] as Record<string, unknown>;
      history[0] = { ...entry, cardSig: `0x${'11'.repeat(65)}` };
    });
    await expect(a.client.proofSigner(current)).rejects.toMatchObject({
      code: 'store_unreadable',
    });
    await expect(a.client.identity.signedCard()).rejects.toMatchObject({
      code: 'store_unreadable',
    });
  });
});

describe('a late cardPop is a compare-and-set (identity #addCardPop)', () => {
  /** Stores the current card in its pre-M1-4d-d form (no cardPop). */
  const legacy = () =>
    editOwnCard(a, (value) => {
      delete value.cardPop;
    });

  it('a lost race uses the stored winner, never a value that was not written', async () => {
    await legacy();
    const original = a.keyStore.signCardPop.bind(a.keyStore);
    let raced = false;
    // Another process adds its cardPop between the read and the write.
    a.keyStore.signCardPop = async (card) => {
      const mine = await original(card);
      if (!raced) {
        raced = true;
        const theirs = await original(card);
        await editOwnCard(a, (value) => {
          value.cardPop = theirs;
          value.writer = 'other';
        });
      }
      return mine;
    };
    const used = await a.client.identity.signedCard();
    expect(raced).toBe(true);
    expect((await a.client.identity.get())?.cardPop).toBe(used.cardPop);
    expect(verifyCardPossession(used.card, used.cardAgentSig, used.cardPop)).toBe(true);
  });

  it('a race that keeps losing is reported, not ignored', async () => {
    await legacy();
    const original = a.keyStore.signCardPop.bind(a.keyStore);
    let n = 0;
    // Every attempt loses: another writer changes the stored card (still without a cardPop).
    a.keyStore.signCardPop = async (card) => {
      n += 1;
      await editOwnCard(a, (value) => {
        value.writer = n;
      });
      return original(card);
    };
    const error = await a.client.identity.signedCard().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoreError);
    expect(error).toMatchObject({ code: 'key_epoch_mismatch' });
    expect((await a.client.identity.get())?.cardPop).toBeNull();
  });
});
