// M1-5a: rumor (kind 14) -> seal (kind 13) -> gift wrap (kind 1059) and the unwrap rules
// (04 §3.1.1 verification step 2, §3.5; 07 §4.1, §4.2). Interop runs both directions against the
// nostr-tools NIP-59 reference. Every key is generated at runtime; no key material is committed.
//
// Interop and the KeyStore paths use the in-memory KeyStore and OwnerSession from the crypto test
// seam (@agentlink/crypto/testing, M1-1g-b). The rule tests use an EnvelopeKeys double over
// nostr-tools (referenceKeys), which can build the malformed and hostile events a real KeyStore
// never would. The code under test (rumor, size checks, seal, createGiftWrap from
// @agentlink/crypto and every unwrap rule) is ours either way.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AEAD_CT_MAX_LENGTH,
  KeyStoreError,
  MAX_RECIPIENTS,
  NOSTR_KIND_GIFT_WRAP,
  NOSTR_KIND_SEAL,
  canonicalize,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  envelopeHash,
  randomBytes,
  verifyEnvelope,
  verifyNostrEvent,
  type Envelope,
  type EnvelopeKeys,
  type NostrEvent,
  type UnsignedNostrEvent,
} from '@agentlink/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@agentlink/crypto/testing';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { v2 as nip44 } from 'nostr-tools/nip44';
import { createRumor, createSeal, createWrap, unwrapEvent, wrapEvent } from 'nostr-tools/nip59';
import {
  AGENTLINK_TAG,
  ENVELOPE_MAX_BYTES,
  GIFT_WRAP_MAX_BACKDATE_SECONDS,
  NOSTR_KIND_RUMOR,
  TransportError,
  randomPastTimestamp,
  unwrapGiftWrap,
  wrapEnvelope,
  type TransportErrorCode,
} from './index.js';

// --- fixtures -------------------------------------------------------------------------------------

interface TestKeys extends EnvelopeKeys {
  readonly pubkey: string;
  readonly secretKey: Uint8Array;
}

/** An EnvelopeKeys over a fresh nostr-tools key (the NIP-59 reference implementation). */
function referenceKeys(): TestKeys {
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  return {
    pubkey,
    secretKey,
    signEnvelopeHash: () => Promise.reject(new Error('not used by the transport')),
    unwrapCek: () => Promise.reject(new Error('not used by the transport')),
    signNostr: (event: UnsignedNostrEvent) =>
      Promise.resolve(
        finalizeEvent(
          {
            kind: event.kind,
            created_at: event.created_at,
            tags: event.tags.map((tag) => [...tag]),
            content: event.content,
          },
          secretKey,
        ) as unknown as NostrEvent,
      ),
    nip44Encrypt: (peer: string, plaintext: string) =>
      Promise.resolve(nip44.encrypt(plaintext, nip44.utils.getConversationKey(secretKey, peer))),
    nip44Decrypt: (peer: string, payload: string) =>
      Promise.resolve(nip44.decrypt(payload, nip44.utils.getConversationKey(secretKey, peer))),
  };
}

/** The same keys with every method spied, to prove what is (not) called. */
function spied(keys: TestKeys) {
  return {
    ...keys,
    signNostr: vi.fn(keys.signNostr),
    nip44Encrypt: vi.fn(keys.nip44Encrypt),
    nip44Decrypt: vi.fn(keys.nip44Decrypt),
  };
}

const b64 = (length: number) => encodeBase64url(randomBytes(length));

/** A structurally valid v1 envelope (04 §3.1) from `from`; the sig is well-formed, not verified. */
function makeEnvelope(
  from: string,
  { recipients = 3, ctBytes = 64, createdAt = 1_760_000_000 } = {},
): Envelope {
  return {
    v: 1,
    id: b64(16),
    thread: b64(16),
    from,
    createdAt,
    recipients: Array.from({ length: recipients }, () => ({
      kid: b64(16),
      enc: b64(32),
      wk: b64(48),
    })),
    aead: { alg: 'A256GCM-KC', iv: b64(12), kc: b64(32), ct: b64(ctBytes) },
    sig: encodeHex(randomBytes(64)),
  };
}

/** The largest envelope the parser accepts: 8 entries, the maximum ct, createdAt 2^53 - 1. */
function largestEnvelope(from: string): Envelope {
  return makeEnvelope(from, {
    recipients: MAX_RECIPIENTS,
    ctBytes: AEAD_CT_MAX_LENGTH,
    createdAt: Number.MAX_SAFE_INTEGER,
  });
}

/** An envelope-shaped object whose JCS is exactly `bytes` long (ct padded; not parseable). */
function envelopeOfSize(from: string, bytes: number): Envelope {
  const envelope = makeEnvelope(from);
  const base = encodeUtf8(canonicalize({ ...envelope, aead: { ...envelope.aead, ct: '' } })).length;
  return { ...envelope, aead: { ...envelope.aead, ct: 'A'.repeat(bytes - base) } };
}

const utf8Length = (text: string) => encodeUtf8(text).length;

/** A mutable plain copy (nostr-tools marks the events it verifies, and ours are frozen). */
const plain = (event: NostrEvent) => JSON.parse(JSON.stringify(event)) as never;

async function codeOf(promise: Promise<unknown>): Promise<TransportErrorCode | 'accepted'> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TransportError) return error.code;
    throw error;
  }
  return 'accepted';
}

/** A gift wrap built entirely by the reference, around a rumor with the given fields. */
function referenceWrap(
  sender: TestKeys,
  recipient: TestKeys,
  rumor: { kind?: number; tags?: string[][]; content: string },
) {
  return wrapEvent(
    {
      kind: rumor.kind ?? NOSTR_KIND_RUMOR,
      tags: rumor.tags ?? [[...AGENTLINK_TAG]],
      content: rumor.content,
    },
    sender.secretKey,
    recipient.pubkey,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

// --- constants ------------------------------------------------------------------------------------

describe('constants (04 §3.1.1, §3.5)', () => {
  it('fixes the rumor kind, the tag, the envelope limit and the 2-day back-dating window', () => {
    expect(NOSTR_KIND_RUMOR).toBe(14);
    expect(AGENTLINK_TAG).toEqual(['agentlink', '1']);
    expect(ENVELOPE_MAX_BYTES).toBe(24_576);
    expect(GIFT_WRAP_MAX_BACKDATE_SECONDS).toBe(2 * 24 * 60 * 60);
  });
});

// --- interop with nostr-tools ---------------------------------------------------------------------
//
// Our side is the real in-memory KeyStore and OwnerSession (@agentlink/crypto/testing): seal
// signing and both NIP-44 layers go through @agentlink/crypto. The other side is nostr-tools.

/** A MemoryKeyStore over a fresh random seed, with its Nostr key as 64 lowercase hex. */
async function memoryKeys(keyEpoch = 0) {
  const store = new MemoryKeyStore(randomBytes(32), { keyEpoch });
  const pubkey = encodeHex((await store.getPublicBundle()).agentNostr);
  return { store, pubkey };
}

/** An open OwnerSession over a fresh owner seed, with the owner Nostr key as hex. */
async function ownerSession() {
  const secret = randomBytes(32);
  const owner = new MemoryOwnerKeyStore(randomBytes(32), {
    kind: 'passphrase',
    secret: secret.slice(),
  });
  const pubkey = encodeHex((await owner.getPublicKeys()).ownerNostr);
  const session = await owner.unlock({ kind: 'passphrase', secret });
  return { owner, session, pubkey };
}

/** A v1 envelope from `keys`, signed with its real envelope signature (04 §3.1.1). */
async function signedEnvelope(keys: EnvelopeKeys, from: string): Promise<Envelope> {
  const { sig: _unused, ...unsigned } = makeEnvelope(from);
  void _unused;
  return { ...unsigned, sig: await keys.signEnvelopeHash(envelopeHash(unsigned)) };
}

describe('interop with the nostr-tools NIP-59 reference (our side: MemoryKeyStore)', () => {
  it('ours -> reference: the reference unwraps every wrap; the rumor content is JCS(envelope) byte for byte', async () => {
    const sender = await memoryKeys();
    const recipients = [referenceKeys(), referenceKeys(), referenceKeys()];
    const envelope = await signedEnvelope(sender.store, sender.pubkey);
    const result = await wrapEnvelope(
      envelope,
      recipients.map((r) => r.pubkey),
      sender.store,
    );
    expect(result.wraps).toHaveLength(3);
    for (const [index, recipient] of recipients.entries()) {
      const wrap = result.wraps[index]!;
      expect(wrap.recipient).toBe(recipient.pubkey);
      expect(verifyEvent(plain(wrap.event))).toBe(true);
      const rumor = unwrapEvent(plain(wrap.event), recipient.secretKey);
      expect(rumor.kind).toBe(14);
      expect(rumor.pubkey).toBe(sender.pubkey);
      expect(rumor.tags).toEqual([['agentlink', '1']]);
      expect(rumor.content).toBe(canonicalize(envelope));
      expect(encodeUtf8(rumor.content)).toEqual(encodeUtf8(canonicalize(envelope)));
    }
  });

  it('reference -> ours: a reference gift wrap of JCS(envelope) unwraps to the parsed envelope', async () => {
    const sender = referenceKeys();
    const recipient = await memoryKeys();
    const envelope = makeEnvelope(sender.pubkey);
    const wrap = wrapEvent(
      { kind: NOSTR_KIND_RUMOR, tags: [[...AGENTLINK_TAG]], content: canonicalize(envelope) },
      sender.secretKey,
      recipient.pubkey,
    );
    const opened = await unwrapGiftWrap(wrap, recipient.store);
    expect(opened.envelope).toEqual(envelope);
    expect(opened.giftWrapId).toBe(wrap.id);
    expect(opened.giftWrapCreatedAt).toBe(wrap.created_at);
  });

  it('reference -> ours: a JSON round trip of the wrap (as a relay delivers it) unwraps too', async () => {
    const sender = referenceKeys();
    const recipient = await memoryKeys();
    const envelope = makeEnvelope(sender.pubkey);
    const wrap = JSON.parse(
      JSON.stringify(
        wrapEvent(
          { kind: NOSTR_KIND_RUMOR, tags: [[...AGENTLINK_TAG]], content: canonicalize(envelope) },
          sender.secretKey,
          recipient.pubkey,
        ),
      ),
    ) as unknown;
    expect((await unwrapGiftWrap(wrap, recipient.store)).envelope).toEqual(envelope);
  });

  it('ours -> ours round trip through a JSON round trip; the envelope signature still verifies', async () => {
    const sender = await memoryKeys();
    const recipient = await memoryKeys();
    const envelope = await signedEnvelope(sender.store, sender.pubkey);
    const { wraps } = await wrapEnvelope(envelope, [recipient.pubkey], sender.store);
    const relayed = JSON.parse(JSON.stringify(wraps[0]!.event)) as unknown;
    const opened = await unwrapGiftWrap(relayed, recipient.store);
    expect(opened.envelope).toEqual(envelope);
    expect(verifyEnvelope(opened.envelope)).toBe(true);
  });
});

describe('OwnerSession and key epochs (04 §3.1.1)', () => {
  it('an OwnerSession seals an owner-authored envelope; the agent and the reference both open it', async () => {
    const { owner, session, pubkey: ownerPub } = await ownerSession();
    const agent = await memoryKeys();
    const reference = referenceKeys();
    const envelope = await signedEnvelope(session, ownerPub);
    const { wraps } = await wrapEnvelope(envelope, [agent.pubkey, reference.pubkey], session);
    expect((await unwrapGiftWrap(wraps[0]!.event, agent.store)).envelope).toEqual(envelope);
    const rumor = unwrapEvent(plain(wraps[1]!.event), reference.secretKey);
    expect(rumor.pubkey).toBe(ownerPub);
    expect(rumor.content).toBe(canonicalize(envelope));
    await owner.close();
  });

  it('an OwnerSession reads the owner copy of an agent envelope (I-9)', async () => {
    const { owner, session, pubkey: ownerPub } = await ownerSession();
    const agent = await memoryKeys();
    const envelope = await signedEnvelope(agent.store, agent.pubkey);
    const { wraps } = await wrapEnvelope(envelope, [ownerPub], agent.store);
    expect((await unwrapGiftWrap(wraps[0]!.event, session)).envelope).toEqual(envelope);
    await owner.close();
  });

  it('an OwnerSession cannot seal for an agent key: the seal key is not envelope.from', async () => {
    const { owner, session } = await ownerSession();
    const agent = await memoryKeys();
    const envelope = await signedEnvelope(agent.store, agent.pubkey);
    expect(await codeOf(wrapEnvelope(envelope, [referenceKeys().pubkey], session))).toBe(
      'sender_mismatch',
    );
    await owner.close();
  });

  it('an older epoch key opens a wrap addressed to it when that epoch is asked for', async () => {
    const seed = randomBytes(32);
    const atEpoch0 = new MemoryKeyStore(seed);
    const atEpoch1 = new MemoryKeyStore(seed, { keyEpoch: 1 });
    const oldPub = encodeHex((await atEpoch0.getPublicBundle()).agentNostr);
    const sender = await memoryKeys();
    const envelope = await signedEnvelope(sender.store, sender.pubkey);
    const { wraps } = await wrapEnvelope(envelope, [oldPub], sender.store);
    expect(await codeOf(unwrapGiftWrap(wraps[0]!.event, atEpoch1))).toBe('decrypt_failed');
    expect((await unwrapGiftWrap(wraps[0]!.event, atEpoch1, { epoch: 0 })).envelope).toEqual(
      envelope,
    );
  });

  it('passes KeyStoreError epoch_unavailable through unchanged (KeyStore and OwnerSession)', async () => {
    const recipient = await memoryKeys();
    const { owner, session, pubkey: ownerPub } = await ownerSession();
    const sender = await memoryKeys();
    const envelope = await signedEnvelope(sender.store, sender.pubkey);
    const { wraps } = await wrapEnvelope(envelope, [recipient.pubkey, ownerPub], sender.store);
    for (const [event, keys] of [
      [wraps[0]!.event, recipient.store],
      [wraps[1]!.event, session],
    ] as const) {
      const error = await unwrapGiftWrap(event, keys, { epoch: 1 }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(KeyStoreError);
      expect(error).not.toBeInstanceOf(TransportError);
      expect((error as KeyStoreError).code).toBe('epoch_unavailable');
    }
    await owner.close();
  });

  it('passes keystore_closed through unchanged', async () => {
    const recipient = await memoryKeys();
    const sender = await memoryKeys();
    const envelope = await signedEnvelope(sender.store, sender.pubkey);
    const { wraps } = await wrapEnvelope(envelope, [recipient.pubkey], sender.store);
    await recipient.store.close();
    await expect(unwrapGiftWrap(wraps[0]!.event, recipient.store)).rejects.toMatchObject({
      name: 'KeyStoreError',
      code: 'keystore_closed',
    });
  });
});

// --- send side ------------------------------------------------------------------------------------

describe('wrapEnvelope', () => {
  it('makes one gift wrap per distinct recipient key, each with its own ephemeral key', async () => {
    const sender = referenceKeys();
    const a = referenceKeys();
    const b = referenceKeys();
    const { wraps } = await wrapEnvelope(
      makeEnvelope(sender.pubkey),
      [a.pubkey, b.pubkey, a.pubkey],
      sender,
    );
    expect(wraps.map((w) => w.recipient)).toEqual([a.pubkey, b.pubkey]);
    const signers = new Set(wraps.map((w) => w.event.pubkey));
    expect(signers.size).toBe(2);
    for (const wrap of wraps) {
      expect(wrap.event.kind).toBe(NOSTR_KIND_GIFT_WRAP);
      expect(wrap.event.tags).toEqual([['p', wrap.recipient]]);
      expect(wrap.event.pubkey).not.toBe(sender.pubkey);
      expect(wrap.event.pubkey).not.toBe(wrap.recipient);
      expect(verifyNostrEvent(wrap.event)).toBe(true);
    }
  });

  it('seals with the sender key through EnvelopeKeys.signNostr (kind 13, no tags), encrypted per recipient', async () => {
    const sender = spied(referenceKeys());
    const a = referenceKeys();
    const b = referenceKeys();
    const { wraps } = await wrapEnvelope(makeEnvelope(sender.pubkey), [a.pubkey, b.pubkey], sender);
    expect(sender.signNostr).toHaveBeenCalledTimes(2);
    for (const call of sender.signNostr.mock.calls) {
      expect(call[0].kind).toBe(NOSTR_KIND_SEAL);
      expect(call[0].tags).toEqual([]);
    }
    expect(sender.nip44Encrypt.mock.calls.map((call) => call[0])).toEqual([a.pubkey, b.pubkey]);
    for (const [index, recipient] of [a, b].entries()) {
      const wrap = wraps[index]!;
      const seal = JSON.parse(
        nip44.decrypt(
          wrap.event.content,
          nip44.utils.getConversationKey(recipient.secretKey, wrap.event.pubkey),
        ),
      ) as NostrEvent;
      expect(seal.kind).toBe(13);
      expect(seal.pubkey).toBe(sender.pubkey);
      expect(seal.tags).toEqual([]);
      expect(verifyNostrEvent(seal)).toBe(true);
    }
  });

  it('reports the final size of each gift wrap: the event JSON and the relay EVENT frame, in bytes', async () => {
    const sender = referenceKeys();
    const { wraps } = await wrapEnvelope(
      makeEnvelope(sender.pubkey),
      [referenceKeys().pubkey],
      sender,
    );
    const wrap = wraps[0]!;
    expect(wrap.eventBytes).toBe(utf8Length(JSON.stringify(wrap.event)));
    expect(wrap.frameBytes).toBe(utf8Length(JSON.stringify(['EVENT', wrap.event])));
  });

  it('the largest envelope the parser accepts (24 563 bytes as JCS) yields gift wraps under 64 KiB', async () => {
    const sender = referenceKeys();
    const envelope = largestEnvelope(sender.pubkey);
    const size = utf8Length(canonicalize(envelope));
    // 04 §3.1.1 size table: 24 563 bytes with kc and alg A256GCM-KC (G-46, D-66).
    expect(size).toBe(24_563);
    expect(size).toBeLessThanOrEqual(ENVELOPE_MAX_BYTES);
    expect(size).toBeGreaterThan(24_000);
    const { wraps } = await wrapEnvelope(envelope, [referenceKeys().pubkey], sender);
    expect(wraps[0]!.eventBytes).toBeLessThan(65_536);
    expect(wraps[0]!.frameBytes).toBeLessThan(65_536);
  });

  it('refuses an envelope of 24 577 bytes before wrapping: no seal, no encryption', async () => {
    const sender = spied(referenceKeys());
    const envelope = envelopeOfSize(sender.pubkey, ENVELOPE_MAX_BYTES + 1);
    expect(utf8Length(canonicalize(envelope))).toBe(24_577);
    expect(await codeOf(wrapEnvelope(envelope, [referenceKeys().pubkey], sender))).toBe(
      'envelope_too_large',
    );
    expect(sender.signNostr).not.toHaveBeenCalled();
    expect(sender.nip44Encrypt).not.toHaveBeenCalled();
  });

  it('the size limit is exactly 24 576 bytes: that size passes the size check and reaches the parser', async () => {
    const sender = spied(referenceKeys());
    const envelope = envelopeOfSize(sender.pubkey, ENVELOPE_MAX_BYTES);
    expect(utf8Length(canonicalize(envelope))).toBe(24_576);
    // Padded ct exceeds the parser's own ct limit, so the strict parser (not the size check) refuses it.
    expect(await codeOf(wrapEnvelope(envelope, [referenceKeys().pubkey], sender))).toBe(
      'invalid_envelope',
    );
    expect(sender.signNostr).not.toHaveBeenCalled();
  });

  it('refuses an envelope that fails the strict parser, before any key operation', async () => {
    const sender = spied(referenceKeys());
    const bad = { ...makeEnvelope(sender.pubkey), extra: 1 } as unknown as Envelope;
    expect(await codeOf(wrapEnvelope(bad, [referenceKeys().pubkey], sender))).toBe(
      'invalid_envelope',
    );
    const noSig = Object.fromEntries(
      Object.entries(makeEnvelope(sender.pubkey)).filter(([key]) => key !== 'sig'),
    );
    expect(
      await codeOf(wrapEnvelope(noSig as unknown as Envelope, [referenceKeys().pubkey], sender)),
    ).toBe('invalid_envelope');
    expect(
      await codeOf(wrapEnvelope(null as unknown as Envelope, [referenceKeys().pubkey], sender)),
    ).toBe('invalid_envelope');
    expect(sender.signNostr).not.toHaveBeenCalled();
    expect(sender.nip44Encrypt).not.toHaveBeenCalled();
  });

  it('refuses keys whose seal key is not envelope.from (impersonation on send), and returns no wrap', async () => {
    const sender = referenceKeys();
    const other = referenceKeys();
    expect(
      await codeOf(wrapEnvelope(makeEnvelope(other.pubkey), [referenceKeys().pubkey], sender)),
    ).toBe('sender_mismatch');
  });

  it('refuses a seal from the signer whose tags, created_at or kind differ from the request (IR-M1-5a-1 L-4)', async () => {
    const NOW = 1_760_000_000;
    const sender = referenceKeys();
    const tamperings: ((event: UnsignedNostrEvent) => UnsignedNostrEvent)[] = [
      (event) => ({ ...event, tags: [['x', 'y']] }),
      (event) => ({ ...event, created_at: event.created_at + 1 }),
      (event) => ({ ...event, created_at: NOW + 10 }),
      (event) => ({ ...event, created_at: NOW - GIFT_WRAP_MAX_BACKDATE_SECONDS - 1 }),
      (event) => ({ ...event, kind: 1 }),
    ];
    for (const tamper of tamperings) {
      const faulty = {
        ...sender,
        signNostr: (event: UnsignedNostrEvent) => sender.signNostr(tamper(event)),
      };
      expect(
        await codeOf(
          wrapEnvelope(makeEnvelope(sender.pubkey), [referenceKeys().pubkey], faulty, {
            now: () => NOW,
          }),
        ),
      ).toBe('invalid_seal');
    }
  });

  it('refuses a missing, empty, oversized or malformed recipient list', async () => {
    const sender = spied(referenceKeys());
    const envelope = makeEnvelope(sender.pubkey);
    const nine = Array.from({ length: MAX_RECIPIENTS + 1 }, () => referenceKeys().pubkey);
    const valid = referenceKeys().pubkey;
    for (const recipients of [
      [],
      nine,
      [valid.toUpperCase()],
      [valid.slice(2)],
      [`${valid}00`],
      ['f'.repeat(64)], // not an x coordinate on secp256k1 (>= p)
      [42],
      'not an array',
    ]) {
      expect(await codeOf(wrapEnvelope(envelope, recipients as string[], sender))).toBe(
        'invalid_recipient',
      );
    }
    expect(sender.signNostr).not.toHaveBeenCalled();
  });

  it('eight distinct recipients are allowed, nine duplicates of eight keys collapse to eight', async () => {
    const sender = referenceKeys();
    const eight = Array.from({ length: MAX_RECIPIENTS }, () => referenceKeys().pubkey);
    const { wraps } = await wrapEnvelope(
      makeEnvelope(sender.pubkey),
      [...eight, eight[0]!],
      sender,
    );
    expect(wraps).toHaveLength(8);
  });
});

// --- timestamps -----------------------------------------------------------------------------------

describe('created_at randomisation (NIP-59; 04 §3.5)', () => {
  const NOW = 1_760_000_000;
  const WINDOW = GIFT_WRAP_MAX_BACKDATE_SECONDS;

  it('randomPastTimestamp is uniform over [now - 2 d, now]', () => {
    const samples = Array.from({ length: 20_000 }, () => randomPastTimestamp(NOW));
    for (const value of samples) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(NOW - WINDOW);
      expect(value).toBeLessThanOrEqual(NOW);
    }
    const offsets = samples.map((value) => NOW - value);
    const mean = offsets.reduce((sum, value) => sum + value, 0) / offsets.length;
    // Uniform on [0, W]: mean W/2, standard error W / sqrt(12 n) ~ 353 s at n = 20 000.
    expect(Math.abs(mean - WINDOW / 2)).toBeLessThan(3_000);
    // Every tenth of the window is hit, roughly equally (expected 2 000 each).
    const deciles = new Array<number>(10).fill(0);
    for (const offset of offsets) deciles[Math.min(9, Math.floor((offset / WINDOW) * 10))]! += 1;
    for (const count of deciles) expect(count).toBeGreaterThan(1_600);
    expect(Math.min(...offsets)).toBeLessThan(WINDOW * 0.01);
    expect(Math.max(...offsets)).toBeGreaterThan(WINDOW * 0.99);
  });

  it('refuses a clock that is not a non-negative safe integer', () => {
    for (const now of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => randomPastTimestamp(now)).toThrow(TransportError);
    }
  });

  it('gift wraps and seals are back-dated within [now - 2 d, now]; the rumor carries now', async () => {
    const sender = referenceKeys();
    const recipients = Array.from({ length: MAX_RECIPIENTS }, () => referenceKeys());
    const wrapTimes: number[] = [];
    const sealTimes: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      const { wraps } = await wrapEnvelope(
        makeEnvelope(sender.pubkey),
        recipients.map((r) => r.pubkey),
        sender,
        { now: () => NOW },
      );
      for (const [index, recipient] of recipients.entries()) {
        const event = wraps[index]!.event;
        wrapTimes.push(event.created_at);
        const seal = JSON.parse(
          nip44.decrypt(
            event.content,
            nip44.utils.getConversationKey(recipient.secretKey, event.pubkey),
          ),
        ) as NostrEvent;
        sealTimes.push(seal.created_at);
        const rumor = unwrapEvent(plain(event), recipient.secretKey);
        expect(rumor.created_at).toBe(NOW);
      }
    }
    for (const times of [wrapTimes, sealTimes]) {
      for (const value of times) {
        expect(value).toBeGreaterThanOrEqual(NOW - WINDOW);
        expect(value).toBeLessThanOrEqual(NOW);
      }
      // 24 draws: they are not all the same, and they spread over the window.
      expect(new Set(times).size).toBeGreaterThan(20);
      expect(Math.max(...times) - Math.min(...times)).toBeGreaterThan(WINDOW / 2);
    }
  });

  it('defaults to the wall clock', async () => {
    const sender = referenceKeys();
    const before = Math.floor(Date.now() / 1000);
    const { wraps } = await wrapEnvelope(
      makeEnvelope(sender.pubkey),
      [referenceKeys().pubkey],
      sender,
    );
    const after = Math.floor(Date.now() / 1000);
    expect(wraps[0]!.event.created_at).toBeGreaterThanOrEqual(before - WINDOW);
    expect(wraps[0]!.event.created_at).toBeLessThanOrEqual(after);
  });
});

// --- receive side ---------------------------------------------------------------------------------

describe('unwrapGiftWrap: fail closed (04 §3.1.1 step 2)', () => {
  it('rejects a seal key that is not envelope.from (impersonation)', async () => {
    const sender = referenceKeys();
    const victim = referenceKeys();
    const recipient = referenceKeys();
    const wrap = referenceWrap(sender, recipient, {
      content: canonicalize(makeEnvelope(victim.pubkey)),
    });
    expect(await codeOf(unwrapGiftWrap(wrap, recipient))).toBe('sender_mismatch');
  });

  it('rejects a rumor key that is not the seal key (impersonation), whichever key `from` names', async () => {
    const sealer = referenceKeys();
    const author = referenceKeys();
    const recipient = referenceKeys();
    for (const from of [sealer.pubkey, author.pubkey]) {
      const rumor = createRumor(
        {
          kind: NOSTR_KIND_RUMOR,
          tags: [[...AGENTLINK_TAG]],
          content: canonicalize(makeEnvelope(from)),
        },
        author.secretKey,
      );
      const wrap = createWrap(
        createSeal(rumor, sealer.secretKey, recipient.pubkey),
        recipient.pubkey,
      );
      expect(await codeOf(unwrapGiftWrap(wrap, recipient))).toBe('rumor_mismatch');
    }
  });

  it('rejects a rumor without the agentlink tag, or with another version', async () => {
    const sender = referenceKeys();
    const recipient = referenceKeys();
    const content = canonicalize(makeEnvelope(sender.pubkey));
    for (const tags of [
      [],
      [['agentlink', '2']],
      [['agentlink']],
      [['agentlink', '1', 'x']],
      [['p', recipient.pubkey]],
      [['Agentlink', '1']],
    ]) {
      const wrap = referenceWrap(sender, recipient, { tags, content });
      expect(await codeOf(unwrapGiftWrap(wrap, recipient))).toBe('missing_agentlink_tag');
    }
    // Other tags next to it are fine.
    const ok = referenceWrap(sender, recipient, {
      tags: [['x', 'y'], [...AGENTLINK_TAG]],
      content,
    });
    expect(await codeOf(unwrapGiftWrap(ok, recipient))).toBe('accepted');
  });

  it('rejects a rumor of another kind', async () => {
    const sender = referenceKeys();
    const recipient = referenceKeys();
    const wrap = referenceWrap(sender, recipient, {
      kind: 1,
      content: canonicalize(makeEnvelope(sender.pubkey)),
    });
    expect(await codeOf(unwrapGiftWrap(wrap, recipient))).toBe('invalid_rumor');
  });

  it('rejects a rumor whose id is not its NIP-01 id, a signed rumor and a rumor with extra fields', async () => {
    const sender = referenceKeys();
    const recipient = referenceKeys();
    const base = createRumor(
      {
        kind: NOSTR_KIND_RUMOR,
        tags: [[...AGENTLINK_TAG]],
        content: canonicalize(makeEnvelope(sender.pubkey)),
      },
      sender.secretKey,
    );
    const variants = [
      { ...base, id: '0'.repeat(64) },
      { ...base, sig: '0'.repeat(128) },
      { ...base, extra: true },
      { ...base, created_at: -1 },
    ];
    for (const rumor of variants) {
      const seal = finalizeEvent(
        {
          kind: NOSTR_KIND_SEAL,
          created_at: base.created_at,
          tags: [],
          content: nip44.encrypt(
            JSON.stringify(rumor),
            nip44.utils.getConversationKey(sender.secretKey, recipient.pubkey),
          ),
        },
        sender.secretKey,
      );
      const wrap = createWrap(seal, recipient.pubkey);
      expect(await codeOf(unwrapGiftWrap(wrap, recipient))).toBe('invalid_rumor');
    }
  });

  it('rejects a seal with a bad signature, another kind or tags', async () => {
    const sender = referenceKeys();
    const recipient = referenceKeys();
    const rumor = createRumor(
      {
        kind: NOSTR_KIND_RUMOR,
        tags: [[...AGENTLINK_TAG]],
        content: canonicalize(makeEnvelope(sender.pubkey)),
      },
      sender.secretKey,
    );
    const good = createSeal(rumor, sender.secretKey, recipient.pubkey);
    const tampered = { ...good, created_at: good.created_at + 1 };
    const sealOf = (kind: number, tags: string[][]) =>
      finalizeEvent(
        { kind, created_at: good.created_at, tags, content: good.content },
        sender.secretKey,
      );
    for (const seal of [
      tampered,
      sealOf(1, []),
      sealOf(NOSTR_KIND_SEAL, [['p', recipient.pubkey]]),
    ]) {
      const wrap = createWrap(seal as never, recipient.pubkey);
      expect(await codeOf(unwrapGiftWrap(wrap, recipient))).toBe('invalid_seal');
    }
  });

  it('rejects a gift wrap with a bad signature or another kind, before any decryption', async () => {
    const sender = referenceKeys();
    const recipient = spied(referenceKeys());
    const wrap = referenceWrap(sender, recipient, {
      content: canonicalize(makeEnvelope(sender.pubkey)),
    });
    const relabelled = finalizeEvent(
      { kind: 4, created_at: wrap.created_at, tags: wrap.tags, content: wrap.content },
      generateSecretKey(),
    );
    for (const event of [
      { ...wrap, content: `${wrap.content.slice(0, -4)}AAAA` },
      { ...wrap, sig: '0'.repeat(128) },
      { ...wrap, id: '0'.repeat(64) },
      relabelled,
      { ...wrap, extra: 1 },
      { ...wrap, kind: undefined },
      null,
      'string',
      [wrap],
    ]) {
      expect(await codeOf(unwrapGiftWrap(event, recipient))).toBe('invalid_gift_wrap');
    }
    expect(recipient.nip44Decrypt).not.toHaveBeenCalled();
  });

  it('rejects a gift wrap addressed to another key', async () => {
    const sender = referenceKeys();
    const recipient = referenceKeys();
    const wrap = referenceWrap(sender, recipient, {
      content: canonicalize(makeEnvelope(sender.pubkey)),
    });
    expect(await codeOf(unwrapGiftWrap(wrap, referenceKeys()))).toBe('decrypt_failed');
  });

  it('rejects a rumor whose content is not a parseable v1 envelope', async () => {
    const sender = referenceKeys();
    const recipient = referenceKeys();
    for (const content of [
      'not json',
      '{}',
      canonicalize({ ...makeEnvelope(sender.pubkey), v: 2 }),
      `${canonicalize(makeEnvelope(sender.pubkey))} `.replace('{"aead"', '{"aead":1,"aead"'),
    ]) {
      const wrap = referenceWrap(sender, recipient, { content });
      expect(await codeOf(unwrapGiftWrap(wrap, recipient))).toBe('invalid_envelope');
    }
  });

  it('rejects a seal or rumor that is not JSON', async () => {
    const sender = referenceKeys();
    const recipient = referenceKeys();
    // The gift wrap holds a non-JSON "seal".
    const ephemeral = generateSecretKey();
    const wrap = finalizeEvent(
      {
        kind: NOSTR_KIND_GIFT_WRAP,
        created_at: 1_760_000_000,
        tags: [['p', recipient.pubkey]],
        content: nip44.encrypt(
          'not a seal',
          nip44.utils.getConversationKey(ephemeral, recipient.pubkey),
        ),
      },
      ephemeral,
    );
    expect(await codeOf(unwrapGiftWrap(wrap, recipient))).toBe('invalid_seal');
    // The seal holds a non-JSON "rumor".
    const seal = finalizeEvent(
      {
        kind: NOSTR_KIND_SEAL,
        created_at: 1_760_000_000,
        tags: [],
        content: nip44.encrypt(
          'not a rumor',
          nip44.utils.getConversationKey(sender.secretKey, recipient.pubkey),
        ),
      },
      sender.secretKey,
    );
    expect(await codeOf(unwrapGiftWrap(createWrap(seal, recipient.pubkey), recipient))).toBe(
      'invalid_rumor',
    );
  });

  it('passes the epoch option to both NIP-44 decryptions', async () => {
    const sender = referenceKeys();
    const recipient = spied(referenceKeys());
    const wrap = referenceWrap(sender, recipient, {
      content: canonicalize(makeEnvelope(sender.pubkey)),
    });
    await unwrapGiftWrap(wrap, recipient, { epoch: 0 });
    expect(recipient.nip44Decrypt).toHaveBeenCalledTimes(2);
    for (const call of recipient.nip44Decrypt.mock.calls) expect(call[2]).toEqual({ epoch: 0 });
  });

  it('lets a KeyStore state error through unchanged (it is not the event that failed)', async () => {
    const sender = referenceKeys();
    const recipient = referenceKeys();
    const wrap = referenceWrap(sender, recipient, {
      content: canonicalize(makeEnvelope(sender.pubkey)),
    });
    const closed = new KeyStoreError('keystore_closed', 'closed');
    const keys = { ...recipient, nip44Decrypt: () => Promise.reject(closed) };
    await expect(unwrapGiftWrap(wrap, keys)).rejects.toBe(closed);
  });

  it('errors never echo the input (I-7)', async () => {
    const sender = referenceKeys();
    const recipient = referenceKeys();
    const envelope = makeEnvelope(referenceKeys().pubkey);
    const wrap = referenceWrap(sender, recipient, { content: canonicalize(envelope) });
    let caught: unknown;
    try {
      await unwrapGiftWrap(wrap, recipient);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TransportError);
    const text = `${(caught as Error).message} ${String((caught as Error).cause ?? '')}`;
    for (const secret of [
      envelope.from,
      envelope.id,
      envelope.aead.ct.slice(0, 16),
      sender.pubkey,
      wrap.id,
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});
