// Nostr events (NIP-01) for KeyStore.signNostr and the gift wrap (M1-1g).
import { describe, expect, it } from 'vitest';
import { bip340PublicKey } from './bip340.js';
import { encodeHex } from './encoding.js';
import { CryptoInputError } from './errors.js';
import {
  NOSTR_KIND_GIFT_WRAP,
  NOSTR_KIND_SEAL,
  nostrEventId,
  signNostrEvent,
  verifyNostrEvent,
  type NostrEvent,
  type UnsignedNostrEvent,
} from './nostr-event.js';

const SECRET = new Uint8Array(32).fill(3);
const PUB = encodeHex(bip340PublicKey(SECRET));

const UNSIGNED: UnsignedNostrEvent = {
  kind: 1,
  created_at: 1760000000,
  tags: [
    ['p', 'ab'.repeat(32)],
    ['t', 'x"y'],
  ],
  content: 'hello\n"world" é 🦄',
};

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof CryptoInputError) return error.code;
    throw error;
  }
  return 'accepted';
}

describe('nostrEventId', () => {
  it('is sha256 of the NIP-01 serialization (reference computed with CPython json + hashlib)', () => {
    // json.dumps([0, pub, created_at, kind, tags, content], separators=(",", ":"),
    // ensure_ascii=False), UTF-8, SHA-256; pub is the x-only key of secret key 1.
    const pub1 = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
    expect(nostrEventId(pub1, UNSIGNED)).toBe(
      '1561312cb9895dc5f73e2fa51e3444dcc9bddc73ec7c73cb59b712bfdf94bf4f',
    );
  });

  it('refuses malformed fields with stable codes', () => {
    const bad: unknown[] = [
      { ...UNSIGNED, kind: -1 },
      { ...UNSIGNED, kind: 65536 },
      { ...UNSIGNED, kind: 1.5 },
      { ...UNSIGNED, created_at: -1 },
      { ...UNSIGNED, created_at: 2 ** 53 },
      { ...UNSIGNED, tags: [['p', 1]] },
      { ...UNSIGNED, tags: 'p' },
      { ...UNSIGNED, content: 7 },
      { ...UNSIGNED, content: 'lone \ud800' },
      { ...UNSIGNED, tags: [['p', 'lone \udc00']] },
    ];
    for (const event of bad) {
      expect(codeOf(() => nostrEventId(PUB, event as UnsignedNostrEvent))).not.toBe('accepted');
    }
    expect(codeOf(() => nostrEventId(PUB.toUpperCase(), UNSIGNED))).toBe('invalid_hex');
    expect(codeOf(() => nostrEventId(PUB.slice(2), UNSIGNED))).toBe('invalid_length');
  });
});

describe('signNostrEvent / verifyNostrEvent', () => {
  const signed = signNostrEvent(SECRET, UNSIGNED);

  it('signs with the key it is given and sets pubkey, id and sig', () => {
    expect(signed.pubkey).toBe(PUB);
    expect(signed.id).toBe(nostrEventId(PUB, UNSIGNED));
    expect(signed.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyNostrEvent(signed)).toBe(true);
  });

  it('copies only the four signed fields from its input', () => {
    const extra = { ...UNSIGNED, pubkey: 'ff'.repeat(32), id: 'x', sig: 'y', other: 1 };
    const result = signNostrEvent(SECRET, extra);
    expect(Object.keys(result).sort()).toEqual(
      ['content', 'created_at', 'id', 'kind', 'pubkey', 'sig', 'tags'].sort(),
    );
    expect(result.pubkey).toBe(PUB);
  });

  it('returns a frozen event whose tags do not alias the input', () => {
    const tags = [['p', 'ab'.repeat(32)]];
    const result = signNostrEvent(SECRET, { ...UNSIGNED, tags });
    (tags[0] as string[])[1] = 'changed';
    expect(Object.isFrozen(result)).toBe(true);
    expect(verifyNostrEvent(result)).toBe(true);
  });

  it('rejects a change to any field', () => {
    const changes: Partial<NostrEvent>[] = [
      { kind: 2 },
      { created_at: UNSIGNED.created_at + 1 },
      { tags: [] },
      { content: 'other' },
      { pubkey: encodeHex(bip340PublicKey(new Uint8Array(32).fill(4))) },
      { id: '00'.repeat(32) },
      { sig: '00'.repeat(64) },
    ];
    for (const change of changes) {
      expect(verifyNostrEvent({ ...signed, ...change }), JSON.stringify(change)).toBe(false);
    }
  });

  it('returns false, never throws, for malformed events', () => {
    for (const event of [
      null,
      42,
      {},
      { ...signed, sig: signed.sig.toUpperCase() },
      { ...signed, id: signed.id.toUpperCase() },
      { ...signed, pubkey: 'zz' },
      { ...signed, tags: [[1]] },
    ]) {
      expect(verifyNostrEvent(event as NostrEvent)).toBe(false);
    }
  });

  it('exports the NIP-59 kinds', () => {
    expect(NOSTR_KIND_SEAL).toBe(13);
    expect(NOSTR_KIND_GIFT_WRAP).toBe(1059);
  });
});
