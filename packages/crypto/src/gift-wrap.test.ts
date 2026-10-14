// NIP-59 gift wrap with an ephemeral key created and wiped inside @agentlink/crypto (07 §4.1,
// M1-1g). Seal and rumor handling, timestamp randomisation and unwrap rules are M1-5a.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeHex } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { createGiftWrap } from './gift-wrap.js';
import { derivePublicIdentity } from './keys.js';
import { MemoryKeyStore } from './memory-keystore.js';
import { NOSTR_KIND_GIFT_WRAP, NOSTR_KIND_SEAL, verifyNostrEvent } from './nostr-event.js';

const SENDER = Uint8Array.from({ length: 32 }, (_, i) => i + 10);
const RECIPIENT = Uint8Array.from({ length: 32 }, (_, i) => 90 + i);
const recipientHex = encodeHex(derivePublicIdentity(RECIPIENT, 0).agentNostr);

async function seal() {
  const sender = new MemoryKeyStore(SENDER);
  return sender.signNostr({
    kind: NOSTR_KIND_SEAL,
    created_at: 1760000000,
    tags: [],
    content: 'sealed rumor ciphertext',
  });
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof CryptoInputError) return error.code;
    throw error;
  }
  return 'accepted';
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createGiftWrap', () => {
  it('builds a signed kind 1059 event to the recipient that only the recipient opens', async () => {
    const s = await seal();
    const wrap = createGiftWrap(s, recipientHex, 1759990000);
    expect(wrap.kind).toBe(NOSTR_KIND_GIFT_WRAP);
    expect(wrap.created_at).toBe(1759990000);
    expect(wrap.tags).toEqual([['p', recipientHex]]);
    expect(verifyNostrEvent(wrap)).toBe(true);
    expect(wrap.pubkey).not.toBe(s.pubkey);

    const recipient = new MemoryKeyStore(RECIPIENT);
    const opened = JSON.parse(await recipient.nip44Decrypt(wrap.pubkey, wrap.content)) as unknown;
    expect(opened).toEqual(s);

    const other = new MemoryKeyStore(SENDER);
    await expect(other.nip44Decrypt(wrap.pubkey, wrap.content)).rejects.toThrow(CryptoInputError);
  });

  it('uses a fresh ephemeral key per wrap', async () => {
    const s = await seal();
    const one = createGiftWrap(s, recipientHex, 1759990000);
    const two = createGiftWrap(s, recipientHex, 1759990000);
    expect(one.pubkey).not.toBe(two.pubkey);
  });

  it('wipes the ephemeral secret key before returning', async () => {
    const s = await seal();
    const drawn: Uint8Array[] = [];
    const source = (
      globalThis as unknown as { crypto: { getRandomValues(a: Uint8Array): Uint8Array } }
    ).crypto;
    const original = source.getRandomValues.bind(source);
    vi.spyOn(source, 'getRandomValues').mockImplementation((array: Uint8Array) => {
      original(array);
      drawn.push(array);
      return array;
    });
    createGiftWrap(s, recipientHex, 1759990000);
    // The first draw is the ephemeral key; later draws (the NIP-44 nonce, BIP-340 aux) are public
    // or wiped by their own owners.
    expect(drawn.length).toBeGreaterThan(0);
    expect((drawn[0] as Uint8Array).every((x) => x === 0)).toBe(true);
  });

  it('refuses a seal that is not a valid signed kind 13 event', async () => {
    const s = await seal();
    expect(codeOf(() => createGiftWrap({ ...s, kind: 14 }, recipientHex, 0))).toBe(
      'invalid_argument',
    );
    expect(codeOf(() => createGiftWrap({ ...s, content: 'changed' }, recipientHex, 0))).toBe(
      'invalid_argument',
    );
  });

  it('refuses a recipient that is not a 64-hex x-only key on the curve, and a bad time', async () => {
    const s = await seal();
    expect(codeOf(() => createGiftWrap(s, recipientHex.toUpperCase(), 0))).toBe('invalid_hex');
    expect(codeOf(() => createGiftWrap(s, '00'.repeat(32), 0))).toBe('invalid_public_key');
    expect(codeOf(() => createGiftWrap(s, recipientHex, -1))).toBe('invalid_argument');
  });
});
