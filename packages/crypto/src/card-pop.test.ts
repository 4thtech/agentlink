// M1-4d-d (D-102; 04 §2.9, 07 §8): the agent card's proof of possession. `cardPop` is BIP-340 by the
// card's `agentNostr` over taggedHash("agentlink/card-pop/v1", sha256(JCS(card))); it is made only
// through a KeyStore (KeyStore.signCardPop), for the store's own card at its current key epoch.
import { describe, expect, it } from 'vitest';
import { agentCardJcsHash, signAgentCard, type AgentCard } from './agent-card.js';
import { bip340Sign, bip340Verify } from './bip340.js';
import { cardPopSnapshot, signCardPop, verifyCardPop, verifyCardPossession } from './card-pop.js';
import { decodeHex, encodeHex, encodeHex0x, encodeUtf8 } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { TAGS, taggedHash } from './hash.js';
import * as mainEntry from './index.js';
import * as keystoreEntry from './keystore.js';
import { KeyStoreError, type KeyStore } from './keystore-api.js';
import { KEY_LABELS, derivePublicIdentity, deriveSecretKey } from './keys.js';
import { MemoryKeyStore, MemoryOwnerKeyStore } from './testing.js';

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 11);
const OTHER_SEED = Uint8Array.from({ length: 32 }, (_, i) => 90 - i);
const OWNER_SEED = Uint8Array.from({ length: 32 }, (_, i) => 55 ^ i);
const presence = () => ({ kind: 'passphrase', secret: encodeUtf8('card pop test') }) as const;

/** The card a store at `epoch` would issue for its own keys (04 §2.4). */
function cardOf(seed: Uint8Array, epoch = 0, over: Partial<Record<keyof AgentCard, unknown>> = {}) {
  const own = derivePublicIdentity(seed, epoch);
  const owner = derivePublicIdentity(OWNER_SEED, 0);
  return {
    version: 1,
    agentEvm: own.agentId,
    agentNostr: encodeHex0x(own.agentNostr),
    agentEnc: encodeHex0x(own.agentEnc),
    ownerEvm: owner.agentId,
    ownerNostr: encodeHex0x(owner.agentNostr),
    ownerEnc: encodeHex0x(owner.agentEnc),
    nameHash: `0x${'88'.repeat(32)}`,
    relaysHash: `0x${'99'.repeat(32)}`,
    issuedAt: 1_760_000_000,
    expiresAt: 0,
    keyEpoch: epoch,
    ...over,
  } as unknown as AgentCard;
}

const nostrSecret = (seed: Uint8Array, epoch = 0) => deriveSecretKey(seed, KEY_LABELS.nostr, epoch);
const evmSecret = (seed: Uint8Array) => deriveSecretKey(seed, KEY_LABELS.evm, 0);

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof KeyStoreError || error instanceof CryptoInputError) return error.code;
    throw error;
  }
  return 'accepted';
}

describe('TAGS.cardPop and the cardPop helpers (04 §2.9, D-102)', () => {
  it('is the 04 §2.9 tag, distinct from every other tag', () => {
    expect(TAGS.cardPop).toBe('agentlink/card-pop/v1');
    const values = Object.values(TAGS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('signCardPop is BIP-340 by agentNostr over taggedHash(cardPop, sha256(JCS(card)))', () => {
    const card = cardOf(SEED);
    const pop = signCardPop(nostrSecret(SEED), card);
    expect(pop).toHaveLength(64);
    const message = taggedHash('agentlink/card-pop/v1', agentCardJcsHash(card));
    expect(bip340Verify(decodeHex(card.agentNostr.slice(2)), message, pop)).toBe(true);
    expect(verifyCardPop(card, encodeHex(pop))).toBe(true);
  });

  it('signCardPop refuses a key that is not the card agentNostr', () => {
    expect(() => signCardPop(nostrSecret(OTHER_SEED), cardOf(SEED))).toThrow(CryptoInputError);
    expect(() => signCardPop(nostrSecret(SEED, 1), cardOf(SEED))).toThrow(CryptoInputError);
    expect(() => signCardPop(nostrSecret(SEED), { not: 'a card' })).toThrow(CryptoInputError);
  });

  it('verifyCardPop fails for any other card: epoch, owner, name, key, and other tags', () => {
    const card = cardOf(SEED);
    const pop = encodeHex(signCardPop(nostrSecret(SEED), card));
    const hash = agentCardJcsHash(card);
    expect(verifyCardPop(cardOf(SEED, 0, { issuedAt: 1_760_000_001 }), pop)).toBe(false);
    expect(verifyCardPop(cardOf(SEED, 0, { nameHash: `0x${'87'.repeat(32)}` }), pop)).toBe(false);
    expect(verifyCardPop(cardOf(SEED, 1), pop)).toBe(false);
    for (const tag of [TAGS.envelope, TAGS.ownerAction]) {
      const wrongTag = encodeHex(bip340Sign(nostrSecret(SEED), taggedHash(tag, hash)));
      expect(verifyCardPop(card, wrongTag)).toBe(false);
    }
    expect(verifyCardPop(card, encodeHex(bip340Sign(nostrSecret(SEED), hash)))).toBe(false);
  });

  it('verifyCardPop answers false, never throws, for malformed input', () => {
    const card = cardOf(SEED);
    const pop = encodeHex(signCardPop(nostrSecret(SEED), card));
    for (const bad of [undefined, null, 1, '', pop.toUpperCase(), `0x${pop}`, pop.slice(2), {}]) {
      expect(verifyCardPop(card, bad)).toBe(false);
    }
    expect(verifyCardPop({ ...card, extra: 1 }, pop)).toBe(false);
    expect(verifyCardPop(null, pop)).toBe(false);
  });

  it('verifyCardPossession needs both cardAgentSig (agentEvm) and cardPop (agentNostr)', () => {
    const card = cardOf(SEED);
    const pop = encodeHex(signCardPop(nostrSecret(SEED), card));
    const agentSig = signAgentCard(card, evmSecret(SEED));
    const otherSig = signAgentCard(card, evmSecret(OTHER_SEED));
    expect(verifyCardPossession(card, agentSig, pop)).toBe(true);
    expect(verifyCardPossession(card, otherSig, pop)).toBe(false);
    expect(verifyCardPossession(card, agentSig, `${pop.slice(0, -2)}00`)).toBe(false);
    expect(verifyCardPossession(card, undefined, pop)).toBe(false);
    expect(verifyCardPossession(card, agentSig, undefined)).toBe(false);
  });

  it('cardPopSnapshot accepts only the card of exactly these keys at this epoch', () => {
    const own = derivePublicIdentity(SEED, 0);
    expect(cardPopSnapshot(cardOf(SEED), own)).toEqual(cardOf(SEED));
    const refused = [
      cardOf(SEED, 1),
      cardOf(OTHER_SEED),
      cardOf(SEED, 0, { agentEnc: encodeHex0x(derivePublicIdentity(OTHER_SEED, 0).agentEnc) }),
      cardOf(SEED, 0, { agentEvm: derivePublicIdentity(OTHER_SEED, 0).agentId }),
      { garbage: true },
    ];
    for (const card of refused) {
      expect(() => cardPopSnapshot(card, own)).toThrow(CryptoInputError);
    }
  });

  it('the signer is in the restricted keystore entry only; the checks are public', () => {
    expect(typeof keystoreEntry.signCardPop).toBe('function');
    expect('signCardPop' in mainEntry).toBe(false);
    expect(typeof mainEntry.verifyCardPop).toBe('function');
    expect(typeof mainEntry.verifyCardPossession).toBe('function');
    expect(typeof mainEntry.cardPopSnapshot).toBe('function');
  });
});

describe('KeyStore.signCardPop (MemoryKeyStore)', () => {
  it("signs the store's own card at the current epoch, 128 lowercase hex", async () => {
    const store: KeyStore = new MemoryKeyStore(SEED);
    const card = cardOf(SEED);
    const pop = await store.signCardPop(card);
    expect(pop).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyCardPop(card, pop)).toBe(true);
  });

  it('refuses any card that is not its own current one, before using a key', async () => {
    const store: KeyStore = new MemoryKeyStore(SEED, { keyEpoch: 1 });
    expect(verifyCardPop(cardOf(SEED, 1), await store.signCardPop(cardOf(SEED, 1)))).toBe(true);
    for (const card of [
      cardOf(SEED, 0),
      cardOf(SEED, 2),
      cardOf(OTHER_SEED, 1),
      cardOf(SEED, 1, { agentEvm: derivePublicIdentity(OTHER_SEED, 0).agentId }),
    ]) {
      expect(await codeOf(() => store.signCardPop(card))).toBe('invalid_argument');
    }
  });

  it('a refusal names no input value (I-7)', async () => {
    const store: KeyStore = new MemoryKeyStore(SEED);
    const card = cardOf(OTHER_SEED);
    const message = await store.signCardPop(card).then(
      () => '',
      (error: Error) => error.message,
    );
    expect(message).not.toBe('');
    for (const value of Object.values(card)) {
      if (typeof value === 'string') expect(message).not.toContain(value.slice(2, 12));
    }
  });

  it('follows an epoch advance and fails closed after close()', async () => {
    const store = new MemoryKeyStore(SEED);
    const owner = new MemoryOwnerKeyStore(OWNER_SEED, presence());
    const session = await owner.unlock(presence());
    await owner.epochControl(store).advanceEpoch(0, session);
    expect(await codeOf(() => store.signCardPop(cardOf(SEED, 0)))).toBe('invalid_argument');
    expect(verifyCardPop(cardOf(SEED, 1), await store.signCardPop(cardOf(SEED, 1)))).toBe(true);
    await store.close();
    expect(await codeOf(() => store.signCardPop(cardOf(SEED, 1)))).toBe('keystore_closed');
  });
});
