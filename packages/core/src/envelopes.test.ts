// M1-7b: envelope build, receive and processing (04 §3.1–§3.4; §3.1.1 G-2 verification steps in
// order; §3.3 G-46/D-66 key commitment and wrap check; 07 §3.2 received rows, seen-set, held pool).
// The describe blocks follow the steps of 04 §3.1.1: 3 and 4 in `receive`, 5 to 9 in
// `processReceived`; then the send side.
import {
  checkWrap,
  decodeBase64url,
  decodeUtf8,
  decryptPayload,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  generateCek,
  parseJson,
  randomBytes,
  type EnvelopeRecipient,
  type JsonValue,
} from '@agentlink/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@agentlink/crypto/testing';
import { payloadSchema } from '@agentlink/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignedCard } from './card.js';
import { checkRecipientWrap } from './envelope-wraps.js';
import { MAX_WRAP_CHECKS, PROCESS_BATCH, UNOPENED_TYPE, type InboundReport } from './envelopes.js';
import { FakeClock, passphrase, seed } from './testing/fixtures.js';
import {
  agentEnc,
  agentSigner,
  cardUpdatePayload,
  craft,
  giftWrapId,
  kid64,
  makeAgent,
  ownerEnc,
  ownerSigner,
  pairWith,
  rotate,
  textPayload,
  type CraftEntry,
  type TestAgent,
} from './testing/envelopes.js';

// Counts the step 8 recomputed seals (04 §3.1.1 limits: at most 7 per envelope).
vi.mock('@agentlink/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentlink/crypto')>();
  return { ...actual, checkWrap: vi.fn(actual.checkWrap) };
});

const clock = new FakeClock();
const ownerA = new MemoryOwnerKeyStore(seed(201), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(202), passphrase());
const ownerS = new MemoryOwnerKeyStore(seed(209), passphrase());

interface World {
  readonly a: TestAgent;
  readonly b: TestAgent;
}

/** A (seed 1, owner A) and B (seed 2, owner B), each the other's contact. */
async function world(): Promise<World> {
  const a = await makeAgent(clock, new MemoryKeyStore(seed(1)), ownerA, 'alice');
  const b = await makeAgent(clock, new MemoryKeyStore(seed(2)), ownerB, 'bob');
  await pairWith(clock, a, b);
  await pairWith(clock, b, a);
  return { a, b };
}

/** The 04 §3.2 entries of an envelope from `from` to `to`, with optional per-role CEK overrides. */
async function standardEntries(
  to: TestAgent,
  from: TestAgent,
  over: { toOwner?: Uint8Array; fromOwner?: Uint8Array; fromAgentEpoch?: number } = {},
): Promise<CraftEntry[]> {
  return [
    { pk: await agentEnc(to) },
    { pk: await ownerEnc(to.owner), ...(over.toOwner ? { cek: over.toOwner } : {}) },
    { pk: await ownerEnc(from.owner), ...(over.fromOwner ? { cek: over.fromOwner } : {}) },
    { pk: await agentEnc(from, over.fromAgentEpoch) },
  ];
}

async function deliver(to: TestAgent, envelope: unknown): Promise<InboundReport[]> {
  const received = await to.client.envelopes.receive({ envelope, giftWrapId: giftWrapId() });
  expect(received.status).toBe('verified');
  return to.client.envelopes.processReceived();
}

const row = (agent: TestAgent, id: string) =>
  agent.store.transaction((tx) => tx.get('envelopes', { envelope_id: id }));
const heldRow = (agent: TestAgent, id: string) =>
  agent.store.transaction((tx) => tx.get('held_envelopes', { envelope_id: id }));
const seenRows = (agent: TestAgent) => agent.store.transaction((tx) => tx.select('seen'));
const contactRow = (agent: TestAgent, id: string) =>
  agent.store.transaction((tx) => tx.get('contacts', { contact_id: id }));

/** Captures every CEK the KeyStore hands out, to check that the core wipes it (04 §3.1.1 step 5). */
function captureCeks(agent: TestAgent): {
  ceks: Uint8Array[];
  calls: () => number;
  /** The most CEKs not yet wiped at any one time. */
  maxLive: () => number;
} {
  const ceks: Uint8Array[] = [];
  let maxLive = 0;
  const original = agent.keyStore.unwrapCek.bind(agent.keyStore);
  const spy = vi
    .spyOn(agent.keyStore, 'unwrapCek')
    .mockImplementation(async (wrapped, envelopeId, options) => {
      const cek = await original(wrapped, envelopeId, options);
      ceks.push(cek);
      maxLive = Math.max(maxLive, ceks.filter((c) => !c.every((b) => b === 0)).length);
      return cek;
    });
  return { ceks, calls: () => spy.mock.calls.length, maxLive: () => maxLive };
}

/** test-vectors/aead-envelope, case `verify` (M1-1h): a signed envelope. */
const M1_1H_ENVELOPE = {
  v: 1,
  id: 'CWwS0akF74XyLhggaFDzZQ',
  thread: 'Jqgjx2tXGK5rxsnWiTwjtw',
  from: 'a3e7f43667d462e884d2f8b9e5c8cb3333b9ce3011ad4140c51761b42805b8ec',
  createdAt: 1760000000,
  recipients: [
    {
      kid: 'LGGnk30hbYi4K8I9JxRqQA',
      enc: 'rTtSCNB7I8OCjSBc3wgz3sBPKaWuFk0DYD6UC00fCEQ',
      wk: 'vzBBon0C41a7SelbC0JbWkET43jM9d65kIDvVBk29WE1mCB0uzsT4IwcAwI2fi5Q',
    },
    {
      kid: 'eExmdPfwCWg6bBLEtFc46g',
      enc: 'THcfW4h_YGbIPNCEOQlugejW-ZC0Dpb8SsjxjAOSuWU',
      wk: '-DG2iVV68TQkG1dwshC8wrcxz6ReFz3nplx1oY-M9Bo38tLDUz--LYLwOawenNuD',
    },
    {
      kid: 'MW3kZCPdPhvhhCYviirPTQ',
      enc: 'lRIqmRE-cNcDIg0efmKJ24JTa-53Nb3C1cBFMfPqpG4',
      wk: 'enXaB7t8lA1OXHGHXCCorZdvxr56H7iGRa_P6FGauxsVqZfvgJzDryCmTGN3F4_5',
    },
    {
      kid: '54EhDMUO-6AUwd1daj9E_w',
      enc: '6jSVjm-FZj7QdQk8Vu2XAyzTDq3NrhwNpN2_au1UIiI',
      wk: 'cqpdsdxAuds7MMc6Vl2s1Cd_idqcbw-RfLbFEmvAOmGdiPvsxOvRYvX4uMb0Zn21',
    },
  ],
  aead: {
    alg: 'A256GCM-KC',
    iv: 'eIyG5R7rczoln9qC',
    kc: 'qxXFf1fkpoj09rhRjBmEnHIuDgnLDjzxEO94D48EFzk',
    ct: 'DhTMLvL8fTFxHsMMuOti-1sDzhTAdrD0Y7vdpw31rODqZe2rhCmKeD2VhH10wgFofsOkYe4VKaV6VjMTkjByMQKZXh0Vd6w11x_xgOMlVY3x7eL6vBbYseFC9bfJIrLMymr1-C9MBKh8Hrwk',
  },
  sig: '59d5ad41b878708e9e4120ab788c5c5b6c9f16b860521e9e33ffa2c183253d7fa3a321e95d6781c26a95f2f63a78d092c68061419cbf28a22cc9ddc318b26b80',
} as const;
/** The same suite's `decrypt-payload` expected plaintext, as UTF-8 text. */
const M1_1H_PLAINTEXT =
  '{"body":"Hello from the AgentLink test vectors ✓","files":[],"replyTo":null,"type":"text"}';

const allZero = (bytes: Uint8Array): boolean => bytes.every((b) => b === 0);

beforeEach(() => {
  vi.mocked(checkWrap).mockClear();
});

// --- Steps 3 and 4 (receive) -----------------------------------------------------------------------

describe('04 §3.1.1 step 3: strict parse, before anything is stored', () => {
  it('drops an envelope with an extra key, a wrong alg or too few recipients, and records nothing', async () => {
    const { a, b } = await world();
    const good = (await b.client.envelopes.build({ to: { contact: a.id }, payload: textPayload() }))
      .envelope;
    const bad: unknown[] = [
      { ...good, extra: 1 },
      { ...good, aead: { ...good.aead, alg: 'A256GCM' } },
      { ...good, recipients: good.recipients.slice(0, 1) }, // 04 §3.4: 2 to 5 entries
      'not an envelope',
    ];
    for (const envelope of bad) {
      const result = await a.client.envelopes.receive({ envelope, giftWrapId: giftWrapId() });
      expect(result).toEqual({
        status: 'processed',
        report: { outcome: 'dropped', reason: 'invalid', flagged: false },
      });
    }
    expect(await seenRows(a)).toEqual([]);
    expect(await row(a, good.id)).toBeUndefined();
  });
});

describe('04 §3.1.1 step 4: signature under `from`, envelope tag only', () => {
  it('drops a flipped signature and a `from` that did not sign, with the same result as step 3', async () => {
    const { a, b } = await world();
    const good = (await b.client.envelopes.build({ to: { contact: a.id }, payload: textPayload() }))
      .envelope;
    const flipped = `${good.sig.slice(0, -1)}${good.sig.endsWith('0') ? '1' : '0'}`;
    const strangerKey = encodeHex(
      (await new MemoryKeyStore(seed(77)).getPublicBundle()).agentNostr,
    );
    for (const envelope of [
      { ...good, sig: flipped },
      { ...good, from: strangerKey },
    ]) {
      const result = await a.client.envelopes.receive({ envelope, giftWrapId: giftWrapId() });
      // Uniform: no difference between a parse failure and a signature failure (I-7, no oracle).
      expect(result).toEqual({
        status: 'processed',
        report: { outcome: 'dropped', reason: 'invalid', flagged: false },
      });
    }
    expect(await seenRows(a)).toEqual([]);
  });

  it('stores a verified envelope as `received` with seen rows on the wrap id and the envelopeHash', async () => {
    const { a, b } = await world();
    const built = await b.client.envelopes.build({ to: { contact: a.id }, payload: textPayload() });
    const wrap = giftWrapId();
    const result = await a.client.envelopes.receive({ envelope: built.envelope, giftWrapId: wrap });
    expect(result.status).toBe('verified');
    const stored = await row(a, built.envelope.id);
    expect(stored).toMatchObject({
      state: 'received',
      type: UNOPENED_TYPE,
      direction: 'in',
      contact_id: null,
      payload_json: null,
      envelope_hash: built.envelopeHash,
    });
    const seen = await seenRows(a);
    // IR-M1-5a-1 L-3: never keyed on the sender-chosen id alone.
    expect(seen.map((s) => [s.kind, s.id]).sort()).toEqual(
      [
        ['envelope', built.envelopeHash],
        ['wrap', wrap],
      ].sort(),
    );
  });

  // The M1-1h aead-envelope fixture (test-vectors/aead-envelope `verify` and `decrypt-payload`),
  // copied here because core tests may not read test-vectors/ (boundary rules). Public test data:
  // ciphertext, public keys and a signature; its CEK stays in the vector file only.
  it('accepts the M1-1h fixture envelope at steps 3 and 4, and its payload passes step 6', async () => {
    const { a } = await world();
    const result = await a.client.envelopes.receive({ envelope: M1_1H_ENVELOPE });
    expect(result.status).toBe('verified');
    expect(payloadSchema.safeParse(parseJson(M1_1H_PLAINTEXT)).success).toBe(true);
    // Not addressed to this agent: step 5 drops it.
    expect(await a.client.envelopes.processReceived()).toEqual([
      {
        envelopeId: M1_1H_ENVELOPE.id,
        outcome: 'dropped',
        reason: 'not_for_agent',
        flagged: false,
      },
    ]);
  });
});

// --- Step 5 ----------------------------------------------------------------------------------------

describe('04 §3.1.1 step 5: own entry, one unwrapCek, kc before AES-GCM', () => {
  it('drops an envelope with no entry for this agent (not for this agent)', async () => {
    const { a, b } = await world();
    const env = await craft({
      signer: await agentSigner(b.keyStore),
      entries: [{ pk: await ownerEnc(ownerA) }, { pk: await agentEnc(b) }],
      createdAt: clock.t,
    });
    expect(await deliver(a, env)).toEqual([
      { envelopeId: env.id, outcome: 'dropped', reason: 'not_for_agent', flagged: false },
    ]);
    expect(await row(a, env.id)).toBeUndefined();
  });

  it('with own entries at two epochs makes exactly one unwrapCek, at the highest epoch', async () => {
    const { a, b } = await world();
    await rotate(a);
    const spy = captureCeks(a);
    const env = await craft({
      signer: await agentSigner(b.keyStore),
      entries: [
        { pk: await agentEnc(a, 0) },
        { pk: await agentEnc(a, 1) },
        { pk: await ownerEnc(ownerA) },
        { pk: await ownerEnc(ownerB) },
        { pk: await agentEnc(b) },
      ],
      createdAt: clock.t,
    });
    const [done] = await deliver(a, env);
    expect(done).toMatchObject({ outcome: 'ok', contactId: b.id });
    expect(spy.calls()).toBe(1);
    expect(vi.mocked(a.keyStore.unwrapCek).mock.calls[0]?.[2]).toEqual({ epoch: 1 });
  });

  it('a failed tag and a failed unwrap are the same silent `open_failed` drop', async () => {
    const { a, b } = await world();
    const tampered = await craft({
      signer: await agentSigner(b.keyStore),
      entries: await standardEntries(a, b),
      createdAt: clock.t,
      tamperCt: true,
    });
    // This agent's entry carries random bytes under its own kid: the HPKE open fails.
    const ownKid = kid64(await agentEnc(a));
    const badWrap = await craft({
      signer: await agentSigner(b.keyStore),
      entries: await standardEntries(a, b),
      createdAt: clock.t,
      mutateRecipients: (list) =>
        list.map((r) => (r.kid === ownKid ? { ...r, wk: encodeBase64url(randomBytes(48)) } : r)),
    });
    const tamperedReports = await deliver(a, tampered);
    const badWrapReports = await deliver(a, badWrap);
    expect(tamperedReports).toEqual([
      { envelopeId: tampered.id, outcome: 'dropped', reason: 'open_failed', flagged: false },
    ]);
    expect(badWrapReports).toEqual([
      { envelopeId: badWrap.id, outcome: 'dropped', reason: 'open_failed', flagged: false },
    ]);
    expect(await row(a, tampered.id)).toBeUndefined();
    expect(await row(a, badWrap.id)).toBeUndefined();
  });

  it('a kc mismatch on a signature-valid envelope from a contact is refused and the contact flagged', async () => {
    const { a, b } = await world();
    const env = await craft({
      signer: await agentSigner(b.keyStore),
      entries: [
        // This agent's entry seals another CEK: its kc does not match aead.kc.
        { pk: await agentEnc(a), cek: generateCek() },
        { pk: await ownerEnc(ownerA) },
        { pk: await ownerEnc(ownerB) },
        { pk: await agentEnc(b) },
      ],
      createdAt: clock.t,
    });
    const spy = captureCeks(a);
    expect(await deliver(a, env)).toEqual([
      {
        envelopeId: env.id,
        outcome: 'refused',
        reason: 'key_commitment',
        contactId: b.id,
        flagged: true,
      },
    ]);
    expect(await row(a, env.id)).toMatchObject({
      state: 'refused',
      refused_reason: 'key_commitment',
      contact_id: b.id,
      envelope_json: null,
      payload_json: null,
    });
    expect(spy.ceks.every(allZero)).toBe(true);
  });

  it('a kc mismatch from a stranger is refused without flagging anyone', async () => {
    const { a } = await world();
    const s = await makeAgent(clock, new MemoryKeyStore(seed(9)), ownerS, 'stranger');
    const env = await craft({
      signer: await agentSigner(s.keyStore),
      entries: [
        { pk: await agentEnc(a), cek: generateCek() },
        { pk: await ownerEnc(ownerA) },
        { pk: await agentEnc(s) },
      ],
      createdAt: clock.t,
    });
    expect(await deliver(a, env)).toEqual([
      { envelopeId: env.id, outcome: 'refused', reason: 'key_commitment', flagged: false },
    ]);
    expect(await row(a, env.id)).toMatchObject({ state: 'refused', contact_id: null });
  });

  it('wipes the CEK after step 8 on success', async () => {
    const { a, b } = await world();
    const spy = captureCeks(a);
    const built = await b.client.envelopes.build({ to: { contact: a.id }, payload: textPayload() });
    await deliver(a, built.envelope);
    expect(spy.ceks).toHaveLength(1);
    expect(spy.ceks.every(allZero)).toBe(true);
  });
});

// --- Step 6 ----------------------------------------------------------------------------------------

describe('04 §3.1.1 step 6: the payload passes its strict schema', () => {
  it('drops an unknown type, an invalid body and bytes that are not UTF-8 JSON', async () => {
    const { a, b } = await world();
    const bodies: Uint8Array[] = [
      encodeUtf8(JSON.stringify({ type: 'shout', body: 'x', replyTo: null, files: [] })),
      encodeUtf8(JSON.stringify({ type: 'text', body: 7, replyTo: null, files: [] })),
      encodeUtf8(JSON.stringify({ type: 'text', body: 'x', replyTo: null })),
      new Uint8Array([0xff, 0xfe, 0x00]),
      encodeUtf8('{"type":"text","type":"text"}'),
    ];
    for (const payloadBytes of bodies) {
      const env = await craft({
        signer: await agentSigner(b.keyStore),
        entries: await standardEntries(a, b),
        payloadBytes,
        createdAt: clock.t,
      });
      expect(await deliver(a, env)).toEqual([
        { envelopeId: env.id, outcome: 'dropped', reason: 'payload_invalid', flagged: false },
      ]);
    }
  });
});

// --- Step 7 ----------------------------------------------------------------------------------------

describe('04 §3.1.1 step 7: sender role', () => {
  it('a contact current key: stored ok, payload only in an `enc` column', async () => {
    const { a, b } = await world();
    const built = await b.client.envelopes.build({
      to: { contact: a.id },
      payload: textPayload('plain words'),
    });
    expect(await deliver(a, built.envelope)).toEqual([
      { envelopeId: built.envelope.id, outcome: 'ok', contactId: b.id, flagged: false },
    ]);
    const stored = await row(a, built.envelope.id);
    expect(stored).toMatchObject({ state: 'ok', type: 'text', contact_id: b.id, direction: 'in' });
    expect(stored?.payload_json?.startsWith('test-sealed:')).toBe(true);
    expect(stored?.envelope_json?.includes('plain words')).toBe(false);
  });

  it('a superseded epoch key is refused (not ok), stored without ciphertext or payload', async () => {
    const { a, b } = await world();
    const oldKeys = new MemoryKeyStore(seed(2), { keyEpoch: 0 });
    await rotate(b);
    await deliver(
      a,
      (
        await b.client.envelopes.build({
          to: { contact: a.id },
          payload: await cardUpdatePayload(b),
        })
      ).envelope,
    );
    const env = await craft({
      signer: await agentSigner(oldKeys),
      entries: [
        { pk: await agentEnc(a) },
        { pk: await ownerEnc(ownerA) },
        { pk: await ownerEnc(ownerB) },
        { pk: (await oldKeys.getPublicBundle()).agentEnc },
      ],
      createdAt: clock.t,
    });
    expect(await deliver(a, env)).toEqual([
      {
        envelopeId: env.id,
        outcome: 'refused',
        reason: 'superseded_key',
        contactId: b.id,
        flagged: false,
      },
    ]);
    expect(await row(a, env.id)).toMatchObject({
      state: 'refused',
      refused_reason: 'superseded_key',
      envelope_json: null,
      payload_json: null,
    });
  });

  it('an unknown key goes to the requests queue (F-13)', async () => {
    const { a } = await world();
    const s = await makeAgent(clock, new MemoryKeyStore(seed(9)), ownerS, 'stranger');
    const env = await craft({
      signer: await agentSigner(s.keyStore),
      entries: [
        { pk: await agentEnc(a) },
        { pk: await ownerEnc(ownerA) },
        { pk: await agentEnc(s) },
      ],
      createdAt: clock.t,
    });
    expect(await deliver(a, env)).toEqual([
      { envelopeId: env.id, outcome: 'request', flagged: false },
    ]);
    expect(await row(a, env.id)).toMatchObject({
      state: 'request',
      contact_id: null,
      type: 'text',
    });
  });

  it('a handshake-ack from an unknown key with no pairing in progress is dropped, never queued as a request', async () => {
    const { a } = await world();
    const s = await makeAgent(clock, new MemoryKeyStore(seed(9)), ownerS, 'stranger');
    const env = await craft({
      signer: await agentSigner(s.keyStore),
      entries: [
        { pk: await agentEnc(a) },
        { pk: await ownerEnc(ownerA) },
        { pk: await agentEnc(s) },
      ],
      payload: handshakeAckPayload(await s.client.identity.signedCard()),
      createdAt: clock.t,
    });
    // No pairing in progress from that key (M1-7c): dropped, never parked (IR-M1-7b-1 M-1).
    expect(await deliver(a, env)).toEqual([
      { envelopeId: env.id, outcome: 'dropped', reason: 'pairing_unknown', flagged: false },
    ]);
    expect(await row(a, env.id)).toBeUndefined();
    expect(await a.store.transaction((tx) => tx.count('envelopes', { state: 'request' }))).toBe(0);
  });

  it('key table: a text from the own owner key or from a contact owner key is dropped', async () => {
    const { a } = await world();
    for (const owner of [ownerA, ownerB]) {
      const env = await craft({
        signer: await ownerSigner(owner),
        entries: [{ pk: await agentEnc(a) }, { pk: await ownerEnc(ownerA) }],
        createdAt: clock.t,
      });
      expect(await deliver(a, env)).toEqual([
        { envelopeId: env.id, outcome: 'dropped', reason: 'owner_key_type', flagged: false },
      ]);
    }
  });

  it('a card-update from a contact new key is applied, with step 8 against the new card', async () => {
    const { a, b } = await world();
    await rotate(b);
    const built = await b.client.envelopes.build({
      to: { contact: a.id },
      payload: await cardUpdatePayload(b),
    });
    expect(await deliver(a, built.envelope)).toEqual([
      { envelopeId: built.envelope.id, outcome: 'ok', contactId: b.id, flagged: false },
    ]);
    expect((await contactRow(a, b.id))?.key_epoch).toBe(1);
  });

  it('a card-update that carries another agent card is dropped and changes nothing', async () => {
    const { a, b } = await world();
    const c = await makeAgent(clock, new MemoryKeyStore(seed(3)), ownerB, 'carol');
    await pairWith(clock, a, c);
    await rotate(c);
    const env = await craft({
      signer: await agentSigner(b.keyStore),
      entries: await standardEntries(a, b),
      payload: await cardUpdatePayload(c),
      createdAt: clock.t,
    });
    expect(await deliver(a, env)).toEqual([
      {
        envelopeId: env.id,
        outcome: 'dropped',
        reason: 'card_update_invalid',
        contactId: b.id,
        flagged: false,
      },
    ]);
    expect((await contactRow(a, c.id))?.key_epoch).toBe(0);
  });

  it('the own owner-channel card-update copy is stored as sent and never applies a card (G-24)', async () => {
    const { a, b } = await world();
    const built = await a.client.envelopes.build({
      to: { owner: true },
      payload: await cardUpdatePayload(a),
    });
    expect(built.envelope.recipients).toHaveLength(2);
    // A new device: the store does not hold the sent row.
    await a.store.transaction((tx) => tx.delete('envelopes', { envelope_id: built.envelope.id }));
    const before = await a.store.transaction((tx) => tx.select('contacts'));
    expect(await deliver(a, built.envelope)).toEqual([
      { envelopeId: built.envelope.id, outcome: 'sent_copy', flagged: false },
    ]);
    expect(await row(a, built.envelope.id)).toMatchObject({ direction: 'out', state: 'ok' });
    expect(await a.store.transaction((tx) => tx.select('contacts'))).toEqual(before);
    // A contact is not a recipient of the owner-channel set: not for it.
    const atB = await b.client.envelopes.receive({ envelope: built.envelope });
    expect(atB.status).toBe('verified');
    expect(await b.client.envelopes.processReceived()).toEqual([
      {
        envelopeId: built.envelope.id,
        outcome: 'dropped',
        reason: 'not_for_agent',
        flagged: false,
      },
    ]);
  });
});

describe('04 §3.1.1 step 7: arrival order after a key rotation (held envelopes)', () => {
  it('an envelope from a contact new key before its card-update is held, then processed as the contact', async () => {
    const { a, b } = await world();
    await rotate(b);
    const text = await b.client.envelopes.build({ to: { contact: a.id }, payload: textPayload() });
    expect(await deliver(a, text.envelope)).toEqual([
      { envelopeId: text.envelope.id, outcome: 'held', flagged: false },
    ]);
    expect(await heldRow(a, text.envelope.id)).toMatchObject({
      owner_kid: kid64(await ownerEnc(ownerB)),
      release_at: clock.t + 172_800,
    });
    expect(await row(a, text.envelope.id)).toBeUndefined();
    const spy = captureCeks(a);
    const update = await b.client.envelopes.build({
      to: { contact: a.id },
      payload: await cardUpdatePayload(b),
    });
    expect(await deliver(a, update.envelope)).toEqual([
      { envelopeId: update.envelope.id, outcome: 'ok', contactId: b.id, flagged: false },
      { envelopeId: text.envelope.id, outcome: 'ok', contactId: b.id, flagged: false },
    ]);
    // One unwrapCek for the card-update, one for the held envelope's re-run; CEKs wiped.
    expect(spy.calls()).toBe(2);
    expect(spy.ceks.every(allZero)).toBe(true);
    expect(await heldRow(a, text.envelope.id)).toBeUndefined();
    expect(await row(a, text.envelope.id)).toMatchObject({ state: 'ok', contact_id: b.id });
  });

  it('in one pass the card-update is processed first, whatever the arrival order', async () => {
    const { a, b } = await world();
    await rotate(b);
    const text = await b.client.envelopes.build({ to: { contact: a.id }, payload: textPayload() });
    const update = await b.client.envelopes.build({
      to: { contact: a.id },
      payload: await cardUpdatePayload(b),
    });
    for (const e of [text.envelope, update.envelope]) {
      expect((await a.client.envelopes.receive({ envelope: e })).status).toBe('verified');
    }
    expect(await a.client.envelopes.processReceived()).toEqual([
      { envelopeId: update.envelope.id, outcome: 'ok', contactId: b.id, flagged: false },
      { envelopeId: text.envelope.id, outcome: 'ok', contactId: b.id, flagged: false },
    ]);
  });

  it('a held envelope with no card-update goes to requests after 48 h, never earlier', async () => {
    const { a, b } = await world();
    await rotate(b);
    const text = await b.client.envelopes.build({ to: { contact: a.id }, payload: textPayload() });
    const start = clock.t;
    try {
      expect(await deliver(a, text.envelope)).toMatchObject([{ outcome: 'held' }]);
      clock.t = start + 172_799;
      expect(await a.client.envelopes.processReceived()).toEqual([]);
      clock.t = start + 172_800;
      expect(await a.client.envelopes.processReceived()).toEqual([
        { envelopeId: text.envelope.id, outcome: 'request', flagged: false },
      ]);
      expect(await row(a, text.envelope.id)).toMatchObject({ state: 'request', contact_id: null });
      expect(await heldRow(a, text.envelope.id)).toBeUndefined();
    } finally {
      clock.t = start;
    }
  });

  it('a stranger that copies a contact owner kid is never accepted as the contact', async () => {
    const { a, b } = await world();
    const s = await makeAgent(clock, new MemoryKeyStore(seed(9)), ownerS, 'stranger');
    const env = await craft({
      signer: await agentSigner(s.keyStore),
      entries: [
        { pk: await agentEnc(a) },
        { pk: await ownerEnc(ownerA) },
        { pk: await ownerEnc(ownerB) },
        { pk: await agentEnc(s) },
      ],
      createdAt: clock.t,
    });
    expect(await deliver(a, env)).toMatchObject([{ outcome: 'held' }]);
    await rotate(b);
    const update = await b.client.envelopes.build({
      to: { contact: a.id },
      payload: await cardUpdatePayload(b),
    });
    expect(await deliver(a, update.envelope)).toEqual([
      { envelopeId: update.envelope.id, outcome: 'ok', contactId: b.id, flagged: false },
    ]);
    expect(await heldRow(a, env.id)).toBeDefined();
    const start = clock.t;
    try {
      clock.t = start + 172_800;
      expect(await a.client.envelopes.processReceived()).toEqual([
        { envelopeId: env.id, outcome: 'request', flagged: false },
      ]);
    } finally {
      clock.t = start;
    }
  });

  it('caps the held pool at 100 per owner kid, dropping the oldest', async () => {
    const { a } = await world();
    const s = await makeAgent(clock, new MemoryKeyStore(seed(9)), ownerS, 'stranger');
    const entries = [
      { pk: await agentEnc(a) },
      { pk: await ownerEnc(ownerA) },
      { pk: await ownerEnc(ownerB) },
      { pk: await agentEnc(s) },
    ];
    const signer = await agentSigner(s.keyStore);
    const start = clock.t;
    const ids: string[] = [];
    try {
      for (let i = 0; i < 101; i += 1) {
        clock.t = start + i;
        const env = await craft({ signer, entries, createdAt: start });
        ids.push(env.id);
        await deliver(a, env);
      }
    } finally {
      clock.t = start;
    }
    const held = await a.store.transaction((tx) => tx.select('held_envelopes'));
    expect(held).toHaveLength(100);
    expect(held.some((h) => h.envelope_id === ids[0])).toBe(false);
    expect(held.some((h) => h.envelope_id === ids[100])).toBe(true);
  });
});

// --- Step 8 ----------------------------------------------------------------------------------------

describe('04 §3.1.1 step 8: own owner entry and the wrap check (I-9, G-46)', () => {
  it('refuses an envelope without the own owner kid (stored as refused)', async () => {
    const { a, b } = await world();
    const env = await craft({
      signer: await agentSigner(b.keyStore),
      entries: [
        { pk: await agentEnc(a) },
        { pk: await ownerEnc(ownerB) },
        { pk: await agentEnc(b) },
      ],
      createdAt: clock.t,
    });
    expect(await deliver(a, env)).toEqual([
      {
        envelopeId: env.id,
        outcome: 'refused',
        reason: 'owner_entry_missing',
        contactId: b.id,
        flagged: false,
      },
    ]);
    expect(await row(a, env.id)).toMatchObject({
      state: 'refused',
      refused_reason: 'owner_entry_missing',
    });
  });

  it('T3: an own-owner entry that seals another CEK is refused and flagged, though this agent opens', async () => {
    const { a, b } = await world();
    const spy = captureCeks(a);
    const env = await craft({
      signer: await agentSigner(b.keyStore),
      entries: await standardEntries(a, b, { toOwner: generateCek() }),
      createdAt: clock.t,
    });
    expect(await deliver(a, env)).toEqual([
      {
        envelopeId: env.id,
        outcome: 'refused',
        reason: 'wrap_mismatch',
        contactId: b.id,
        flagged: true,
      },
    ]);
    expect(spy.ceks.every(allZero)).toBe(true);
  });

  it('T2: a sender-owner entry that seals another CEK is refused when the sender card is held', async () => {
    const { a, b } = await world();
    const env = await craft({
      signer: await agentSigner(b.keyStore),
      entries: await standardEntries(a, b, { fromOwner: generateCek() }),
      createdAt: clock.t,
    });
    expect(await deliver(a, env)).toEqual([
      {
        envelopeId: env.id,
        outcome: 'refused',
        reason: 'wrap_mismatch',
        contactId: b.id,
        flagged: true,
      },
    ]);
  });

  it('T2: a held envelope with such an entry is refused when its card-update is applied', async () => {
    const { a, b } = await world();
    await rotate(b);
    const env = await craft({
      signer: await agentSigner(b.keyStore),
      entries: await standardEntries(a, b, { fromOwner: generateCek(), fromAgentEpoch: 1 }),
      createdAt: clock.t,
    });
    expect(await deliver(a, env)).toMatchObject([{ outcome: 'held' }]);
    const update = await b.client.envelopes.build({
      to: { contact: a.id },
      payload: await cardUpdatePayload(b),
    });
    expect(await deliver(a, update.envelope)).toEqual([
      { envelopeId: update.envelope.id, outcome: 'ok', contactId: b.id, flagged: false },
      {
        envelopeId: env.id,
        outcome: 'refused',
        reason: 'wrap_mismatch',
        contactId: b.id,
        flagged: true,
      },
    ]);
  });

  it('an entry with an unknown kid (no card held) causes no refusal', async () => {
    const { a, b } = await world();
    const arbitrator = (await new MemoryKeyStore(seed(55)).getPublicBundle()).agentEnc;
    const env = await craft({
      signer: await agentSigner(b.keyStore),
      entries: [...(await standardEntries(a, b)), { pk: arbitrator, cek: generateCek() }],
      createdAt: clock.t,
    });
    expect(await deliver(a, env)).toMatchObject([{ outcome: 'ok', contactId: b.id }]);
  });

  it('a stranger whose own entry seals another CEK is not checked (its card is not held)', async () => {
    const { a } = await world();
    const s = await makeAgent(clock, new MemoryKeyStore(seed(9)), ownerS, 'stranger');
    const env = await craft({
      signer: await agentSigner(s.keyStore),
      entries: [
        { pk: await agentEnc(a) },
        { pk: await ownerEnc(ownerA) },
        { pk: await agentEnc(s), cek: generateCek() },
      ],
      createdAt: clock.t,
    });
    expect(await deliver(a, env)).toMatchObject([{ outcome: 'request' }]);
  });

  it(`recomputes at most ${MAX_WRAP_CHECKS} seals, and here exactly the 3 it holds keys for`, async () => {
    const { a, b } = await world();
    const built = await b.client.envelopes.build({ to: { contact: a.id }, payload: textPayload() });
    vi.mocked(checkWrap).mockClear();
    await deliver(a, built.envelope);
    expect(vi.mocked(checkWrap).mock.calls.length).toBe(3);
  });

  it('IR-M1-1l-1 L-2: a wrap check against the wrong entry fails closed (kid != sha256(pk)[:16])', async () => {
    const { a, b } = await world();
    const cek = generateCek();
    const env = await craft({
      signer: await agentSigner(b.keyStore),
      entries: await standardEntries(a, b),
      cek,
      createdAt: clock.t,
    });
    const id = decodeBase64url(env.id, { length: 16 });
    const ownerKid = kid64(await ownerEnc(ownerA));
    const ownerEntry = env.recipients.find((r) => r.kid === ownerKid) as EnvelopeRecipient;
    const agentKid = kid64(await agentEnc(a));
    const agentEntry = env.recipients.find((r) => r.kid === agentKid) as EnvelopeRecipient;
    expect(await checkRecipientWrap(await ownerEnc(ownerA), ownerEntry, id, cek)).toBe(true);
    // The agent's entry, under the owner key: refused on the kid before any comparison.
    expect(await checkRecipientWrap(await ownerEnc(ownerA), agentEntry, id, cek)).toBe(false);
    // The right bytes under a forged kid: refused too.
    expect(
      await checkRecipientWrap(await ownerEnc(ownerA), { ...ownerEntry, kid: agentKid }, id, cek),
    ).toBe(false);
    expect(
      await checkRecipientWrap(await ownerEnc(ownerA), { ...ownerEntry, enc: 'x' }, id, cek),
    ).toBe(false);
  });
});

// --- Step 9 ----------------------------------------------------------------------------------------

describe('04 §3.1.1 step 9: freshness and uniqueness', () => {
  it('refuses a createdAt more than 300 s ahead and accepts exactly 300 s', async () => {
    const { a, b } = await world();
    const signer = await agentSigner(b.keyStore);
    const entries = await standardEntries(a, b);
    const late = await craft({ signer, entries, createdAt: clock.t + 301 });
    const edge = await craft({ signer, entries, createdAt: clock.t + 300 });
    expect(await deliver(a, late)).toEqual([
      {
        envelopeId: late.id,
        outcome: 'refused',
        reason: 'future_created_at',
        contactId: b.id,
        flagged: false,
      },
    ]);
    expect(await deliver(a, edge)).toMatchObject([{ outcome: 'ok' }]);
  });

  it('the same id with the same hash is a silent duplicate', async () => {
    const { a, b } = await world();
    const built = await b.client.envelopes.build({ to: { contact: a.id }, payload: textPayload() });
    await deliver(a, built.envelope);
    const again = await a.client.envelopes.receive({
      envelope: built.envelope,
      giftWrapId: giftWrapId(),
    });
    expect(again).toEqual({
      status: 'processed',
      report: { envelopeId: built.envelope.id, outcome: 'duplicate', flagged: false },
    });
    expect(await a.client.envelopes.processReceived()).toEqual([]);
  });

  it('the same id with another hash from the same contact is refused and the contact flagged', async () => {
    const { a, b } = await world();
    const signer = await agentSigner(b.keyStore);
    const entries = await standardEntries(a, b);
    const first = await craft({ signer, entries, createdAt: clock.t });
    const second = await craft({ signer, entries, createdAt: clock.t, id: first.id });
    await deliver(a, first);
    expect(await a.client.envelopes.receive({ envelope: second })).toEqual({
      status: 'processed',
      report: {
        envelopeId: first.id,
        outcome: 'refused',
        reason: 'duplicate_id',
        contactId: b.id,
        flagged: true,
      },
    });
    expect(await row(a, first.id)).toMatchObject({ state: 'ok' });
  });

  it('IR-M1-5a-1 L-3: a stranger envelope that copies an id does not suppress the real one', async () => {
    const { a, b } = await world();
    const s = await makeAgent(clock, new MemoryKeyStore(seed(9)), ownerS, 'stranger');
    const real = await craft({
      signer: await agentSigner(b.keyStore),
      entries: await standardEntries(a, b),
      createdAt: clock.t,
    });
    const copy = await craft({
      signer: await agentSigner(s.keyStore),
      entries: [{ pk: await ownerEnc(ownerA) }, { pk: await agentEnc(s) }],
      createdAt: clock.t,
      id: real.id,
    });
    expect((await a.client.envelopes.receive({ envelope: copy })).status).toBe('verified');
    const wrap = giftWrapId();
    expect((await a.client.envelopes.receive({ envelope: real, giftWrapId: wrap })).status).toBe(
      'retry',
    );
    expect((await seenRows(a)).some((r) => r.id === wrap)).toBe(false);
    // The copy is not for this agent and is dropped; the real one is then accepted on a later sync.
    expect(await a.client.envelopes.processReceived()).toMatchObject([{ outcome: 'dropped' }]);
    expect(await deliver(a, real)).toMatchObject([{ outcome: 'ok', contactId: b.id }]);
  });

  it('uniqueness also covers held envelopes', async () => {
    const { a, b } = await world();
    await rotate(b);
    const signer = await agentSigner(b.keyStore);
    const entries = await standardEntries(a, b, { fromAgentEpoch: 1 });
    const first = await craft({ signer, entries, createdAt: clock.t });
    expect(await deliver(a, first)).toMatchObject([{ outcome: 'held' }]);
    const second = await craft({ signer, entries, createdAt: clock.t, id: first.id });
    expect(await a.client.envelopes.receive({ envelope: second })).toMatchObject({
      status: 'processed',
      report: { outcome: 'refused', reason: 'duplicate_id' },
    });
  });
});

// Blocked and removed contacts that rotate (IR-M1-7a-1 R2-M1, F-14): contacts.test.ts.

// --- Send ------------------------------------------------------------------------------------------

describe('build: recipient set, signature and limits (04 §3.1–§3.2, §3.4.1)', () => {
  it('each of the four recipients decrypts the same payload (I-9 for both owners, F-60)', async () => {
    const { a, b } = await world();
    const built = await b.client.envelopes.build({
      to: { contact: a.id },
      payload: textPayload('to all'),
    });
    const env = built.envelope;
    expect(env.recipients).toHaveLength(4);
    const id = decodeBase64url(env.id, { length: 16 });
    const opened: string[] = [];
    const sessionA = await ownerA.unlock(passphrase());
    const sessionB = await ownerB.unlock(passphrase());
    const openers = [
      { keys: a.keyStore, pk: await agentEnc(a) },
      { keys: sessionA, pk: await ownerEnc(ownerA) },
      { keys: sessionB, pk: await ownerEnc(ownerB) },
      { keys: b.keyStore, pk: await agentEnc(b) },
    ];
    for (const { keys, pk } of openers) {
      const entry = env.recipients.find((r) => r.kid === kid64(pk)) as EnvelopeRecipient;
      const cek = await keys.unwrapCek(
        {
          enc: decodeBase64url(entry.enc, { length: 32 }),
          wk: decodeBase64url(entry.wk, { length: 48 }),
        },
        id,
      );
      opened.push(decodeUtf8(await decryptPayload(env, cek)));
    }
    expect(new Set(opened).size).toBe(1);
    expect(JSON.parse(opened[0] as string)).toMatchObject({ type: 'text', body: 'to all' });
    expect(built.recipientNostrKeys).toHaveLength(4);
  });

  it('when both agents have the same owner there are 3 entries and the owner opens one', async () => {
    const a = await makeAgent(clock, new MemoryKeyStore(seed(1)), ownerA, 'alice');
    const c = await makeAgent(clock, new MemoryKeyStore(seed(3)), ownerA, 'carol');
    await pairWith(clock, a, c);
    await pairWith(clock, c, a);
    const built = await c.client.envelopes.build({ to: { contact: a.id }, payload: textPayload() });
    expect(built.envelope.recipients).toHaveLength(3);
    expect(built.recipientNostrKeys).toHaveLength(3);
    const ownerKid = kid64(await ownerEnc(ownerA));
    expect(built.envelope.recipients.filter((r) => r.kid === ownerKid)).toHaveLength(1);
    expect(await deliver(a, built.envelope)).toMatchObject([{ outcome: 'ok', contactId: c.id }]);
  });

  it('stores the sent envelope as ciphertext with the payload only in an `enc` column', async () => {
    const { a, b } = await world();
    const built = await b.client.envelopes.build({
      to: { contact: a.id },
      payload: textPayload('secret words'),
    });
    const stored = await row(b, built.envelope.id);
    expect(stored).toMatchObject({
      direction: 'out',
      state: 'ok',
      delivery: 'queued',
      contact_id: a.id,
    });
    expect(stored?.envelope_json?.includes('secret words')).toBe(false);
    expect(stored?.payload_json?.startsWith('test-sealed:')).toBe(true);
    expect(stored?.envelope_hash).toBe(built.envelopeHash);
  });

  it('keeps one thread per contact and follows the replied-to envelope', async () => {
    const { a, b } = await world();
    const first = await b.client.envelopes.build({
      to: { contact: a.id },
      payload: textPayload('1'),
    });
    const second = await b.client.envelopes.build({
      to: { contact: a.id },
      payload: textPayload('2'),
    });
    expect(second.thread).toBe(first.thread);
    await deliver(a, second.envelope);
    const reply = await a.client.envelopes.build({
      to: { contact: b.id },
      payload: { ...(textPayload('re') as object), replyTo: second.envelope.id } as JsonValue,
    });
    expect(reply.thread).toBe(first.thread);
  });

  it('refuses types the agent may not send, or on the wrong channel', async () => {
    const { a, b } = await world();
    // A user message on the owner channel.
    await expect(
      b.client.envelopes.build({ to: { owner: true }, payload: textPayload() }),
    ).rejects.toMatchObject({ code: 'type_not_sendable' });
    // A pairing type through the contact path (pairing is M1-7c's flow).
    await expect(
      b.client.envelopes.build({
        to: { contact: a.id },
        payload: handshakeAckPayload(await b.client.identity.signedCard()),
      }),
    ).rejects.toMatchObject({ code: 'type_not_sendable' });
    await expect(
      b.client.envelopes.build({ to: { contact: a.id }, payload: { type: 'text', body: 1 } }),
    ).rejects.toMatchObject({ code: 'payload_invalid' });
  });

  it('refuses a blocked contact and a payload over the size limit', async () => {
    const { a, b } = await world();
    await expect(
      b.client.envelopes.build({ to: { contact: a.id }, payload: textPayload('x'.repeat(17_200)) }),
    ).rejects.toMatchObject({ code: 'envelope_too_large' });
    await b.client.contacts.block(a.id);
    await expect(
      b.client.envelopes.build({ to: { contact: a.id }, payload: textPayload() }),
    ).rejects.toMatchObject({ code: 'contact_not_active' });
  });

  it('every send path calls assertCanSend first: a pending rotation refuses (IR-M1-7a-1 L-1)', async () => {
    const { a, b } = await world();
    await b.owner.epochControl(b.keyStore).advanceEpoch(0, await b.owner.unlock(passphrase()));
    await expect(
      b.client.envelopes.build({ to: { contact: a.id }, payload: textPayload() }),
    ).rejects.toMatchObject({ code: 'rotation_pending' });
  });
});

// --- Review IR-M1-7b-1 -----------------------------------------------------------------------------

/** A schema-valid `approval` payload (approval.cancel). Its owner signature is M1-7d/e's to verify. */
const approvalPayload = (): JsonValue => ({
  type: 'approval',
  body: {
    signed: {
      body: {
        v: 1,
        agent: `0x${'1a'.repeat(20)}`,
        owner: 'c3'.repeat(32),
        op: 'approval.cancel',
        params: { approvalId: `apr_${encodeBase64url(new Uint8Array(16).fill(7))}` },
        nonce: encodeBase64url(new Uint8Array(16).fill(9)),
        issuedAt: 1_760_000_000,
        expiresAt: 1_760_000_600,
      },
      sig: 'f6'.repeat(64),
    },
  },
  replyTo: null,
  files: [],
});

/** A schema-valid `handshake-ack` (04 §3.4.1) carrying `signed`'s card, with random pairing values. */
const handshakeAckPayload = (signed: SignedCard): JsonValue => ({
  type: 'handshake-ack',
  body: {
    inviteId: encodeBase64url(randomBytes(16)),
    handshakeId: encodeBase64url(randomBytes(16)),
    handshakeHash: `0x${encodeHex(randomBytes(32))}`,
    codeReveal: encodeBase64url(randomBytes(32)),
    card: signed.card as unknown as JsonValue,
    cardSig: signed.cardSig,
    relays: [...signed.relays],
  },
  replyTo: null,
  files: [],
});

describe('review IR-M1-7b-1', () => {
  it('M-1: a stranger flood of pairing envelopes cannot push out a contact message', async () => {
    const { a, b } = await world();
    const s = await makeAgent(clock, new MemoryKeyStore(seed(9)), ownerS, 'stranger');
    const signer = await agentSigner(s.keyStore);
    const entries = [{ pk: await agentEnc(a) }, { pk: await ownerEnc(ownerA) }];
    const strangerCard = await s.client.identity.signedCard();
    // Fill the 1 000 `received` slots with signature-valid handshake-acks from an unknown key.
    for (let i = 0; i < 1_000; i += 1) {
      const env = await craft({
        signer,
        entries,
        payload: handshakeAckPayload(strangerCard),
        createdAt: clock.t,
      });
      expect((await a.client.envelopes.receive({ envelope: env })).status).toBe('verified');
    }
    const honest = await b.client.envelopes.build({
      to: { contact: a.id },
      payload: textPayload(),
    });
    expect((await a.client.envelopes.receive({ envelope: honest.envelope })).status).toBe('retry');
    // One pass drops every one (no pairing in progress from that key, M1-7c): nothing stays parked.
    const reports = await a.client.envelopes.processReceived();
    expect(reports).toHaveLength(1_000);
    expect(reports.every((r) => r.outcome === 'dropped' && r.reason === 'pairing_unknown')).toBe(
      true,
    );
    expect(await a.store.transaction((tx) => tx.count('envelopes', { state: 'received' }))).toBe(0);
    expect(await deliver(a, honest.envelope)).toMatchObject([{ outcome: 'ok', contactId: b.id }]);
  }, 120_000);

  it('M-1: a revoke from an unknown key is dropped, not parked in `received`', async () => {
    const { a } = await world();
    const s = await makeAgent(clock, new MemoryKeyStore(seed(9)), ownerS, 'stranger');
    const revoke: JsonValue = {
      type: 'revoke',
      body: {
        signed: {
          body: {
            v: 1,
            agent: `0x${'1a'.repeat(20)}`,
            owner: 'c3'.repeat(32),
            op: 'agent.revoke',
            params: { reason: 'retired' },
            nonce: encodeBase64url(new Uint8Array(16).fill(9)),
            issuedAt: 1_760_000_000,
            expiresAt: 0,
          },
          sig: 'f6'.repeat(64),
        },
      },
      replyTo: null,
      files: [],
    };
    expect(payloadSchema.safeParse(revoke).success).toBe(true);
    const env = await craft({
      signer: await agentSigner(s.keyStore),
      entries: [{ pk: await agentEnc(a) }, { pk: await ownerEnc(ownerA) }],
      payload: revoke,
      createdAt: clock.t,
    });
    expect(await deliver(a, env)).toEqual([
      { envelopeId: env.id, outcome: 'dropped', reason: 'type_unhandled', flagged: false },
    ]);
    expect(await row(a, env.id)).toBeUndefined();
  });

  it('M-2: an owner kid shared by an active and a blocked contact holds; the active one is delivered, the blocked one dropped at release', async () => {
    const { a, b } = await world();
    const d = await makeAgent(clock, new MemoryKeyStore(seed(4)), ownerB, 'dave');
    await pairWith(clock, a, d);
    await pairWith(clock, d, a);
    await a.client.contacts.block(d.id);
    // B (active) rotates: its text before the card-update is held, then delivered.
    await rotate(b);
    const text = await b.client.envelopes.build({ to: { contact: a.id }, payload: textPayload() });
    expect(await deliver(a, text.envelope)).toMatchObject([{ outcome: 'held' }]);
    const update = await b.client.envelopes.build({
      to: { contact: a.id },
      payload: await cardUpdatePayload(b),
    });
    expect(await deliver(a, update.envelope)).toEqual([
      { envelopeId: update.envelope.id, outcome: 'ok', contactId: b.id, flagged: false },
      { envelopeId: text.envelope.id, outcome: 'ok', contactId: b.id, flagged: false },
    ]);
    // D (blocked) rotates: its new key's text carries the same owner kid, is held, never queued.
    await rotate(d);
    const fromD = await craft({
      signer: await agentSigner(d.keyStore),
      entries: await standardEntries(a, d, { fromAgentEpoch: 1 }),
      createdAt: clock.t,
    });
    expect(await deliver(a, fromD)).toMatchObject([{ outcome: 'held' }]);
    const start = clock.t;
    try {
      clock.t = start + 172_800;
      expect(await a.client.envelopes.processReceived()).toEqual([
        { envelopeId: fromD.id, outcome: 'dropped', reason: 'held_owner_inactive', flagged: false },
      ]);
      expect(await heldRow(a, fromD.id)).toBeUndefined();
      expect(await a.store.transaction((tx) => tx.count('envelopes', { state: 'request' }))).toBe(
        0,
      );
    } finally {
      clock.t = start;
    }
  });

  it('L-1: a card-update from a key that is neither the contact key nor the card key is dropped', async () => {
    const { a, b } = await world();
    const s = await makeAgent(clock, new MemoryKeyStore(seed(9)), ownerS, 'stranger');
    await rotate(b);
    const env = await craft({
      signer: await agentSigner(s.keyStore),
      entries: [
        { pk: await agentEnc(a) },
        { pk: await ownerEnc(ownerA) },
        { pk: await ownerEnc(ownerB) },
        { pk: await agentEnc(s) },
      ],
      payload: await cardUpdatePayload(b),
      createdAt: clock.t,
    });
    expect(await deliver(a, env)).toEqual([
      { envelopeId: env.id, outcome: 'dropped', reason: 'card_update_invalid', flagged: false },
    ]);
    expect(await heldRow(a, env.id)).toBeUndefined();
    expect((await contactRow(a, b.id))?.key_epoch).toBe(0);
  });

  it('L-2: the key table for `approval` (owner channel)', async () => {
    const { a, b } = await world();
    expect(payloadSchema.safeParse(approvalPayload()).success).toBe(true);
    const to = async () => [{ pk: await agentEnc(a) }, { pk: await ownerEnc(ownerA) }];
    const cases = [
      // From a contact's agent key: owner-channel types come only from the own owner.
      { signer: await agentSigner(b.keyStore), reason: 'owner_channel_type' },
      // From a contact's owner key.
      { signer: await ownerSigner(ownerB), reason: 'owner_key_type' },
      // Signed by the agent's own key: the agent never signs an owner-authored type.
      { signer: await agentSigner(a.keyStore), reason: 'agent_key_type' },
    ] as const;
    for (const { signer, reason } of cases) {
      const env = await craft({
        signer,
        entries: await to(),
        payload: approvalPayload(),
        createdAt: clock.t,
      });
      expect(await deliver(a, env)).toEqual([
        { envelopeId: env.id, outcome: 'dropped', reason, flagged: false },
      ]);
      expect(await row(a, env.id)).toBeUndefined();
    }
    // From the own owner key: accepted for its handler (M1-7d/e), kept as `received`.
    const own = await craft({
      signer: await ownerSigner(ownerA),
      entries: await to(),
      payload: approvalPayload(),
      createdAt: clock.t,
    });
    expect(await deliver(a, own)).toEqual([
      { envelopeId: own.id, outcome: 'deferred', flagged: false },
    ]);
    expect(await row(a, own.id)).toMatchObject({ state: 'received' });
  });

  it('L-4: a malformed gift-wrap id is refused (`retry`), and nothing is stored', async () => {
    const { a, b } = await world();
    const built = await b.client.envelopes.build({ to: { contact: a.id }, payload: textPayload() });
    for (const bad of ['', 'XYZ', 'A'.repeat(64), 'ab'.repeat(31)]) {
      expect(
        await a.client.envelopes.receive({ envelope: built.envelope, giftWrapId: bad }),
      ).toEqual({
        status: 'retry',
        report: { outcome: 'dropped', reason: 'wrap_id_invalid', flagged: false },
      });
    }
    expect(await row(a, built.envelope.id)).toBeUndefined();
    expect(await seenRows(a)).toEqual([]);
  });

  it(`L-5: a pass holds at most ${PROCESS_BATCH} CEKs at once, and each is wiped`, async () => {
    const { a, b } = await world();
    const signer = await agentSigner(b.keyStore);
    const entries = await standardEntries(a, b);
    const count = PROCESS_BATCH + 10;
    for (let i = 0; i < count; i += 1) {
      const env = await craft({ signer, entries, createdAt: clock.t });
      expect((await a.client.envelopes.receive({ envelope: env })).status).toBe('verified');
    }
    const spy = captureCeks(a);
    const reports = await a.client.envelopes.processReceived();
    expect(reports.filter((r) => r.outcome === 'ok')).toHaveLength(count);
    expect(spy.calls()).toBe(count);
    expect(spy.maxLive()).toBeLessThanOrEqual(PROCESS_BATCH);
    expect(spy.ceks.every(allZero)).toBe(true);
  });
});
