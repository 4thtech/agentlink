// M2-3t-w: the crypto package runs in the Cloudflare Workers runtime (workerd), where the cloud agent
// (M2-3a) will use it. Only the public API and the in-memory KeyStore of the test seam are used;
// the test runs in the package's `workerd` Vitest project (vitest.config.ts), never in Node.
import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  decodeBase64url,
  decryptPayload,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  encryptPayload,
  envelopeHash,
  generateCek,
  hkdfSha256,
  randomBytes,
  sha256,
  verifyEnvelope,
  type EnvelopeHeader,
} from './index.js';
import { MemoryKeyStore } from './testing.js';

const b64 = (length: number): string => encodeBase64url(randomBytes(length));

function header(from: string): EnvelopeHeader {
  return {
    v: 1,
    id: b64(16),
    thread: b64(16),
    from,
    createdAt: 1_760_000_000,
    recipients: [1, 2].map(() => ({ kid: b64(16), enc: b64(32), wk: b64(48) })),
  };
}

describe('@4thtech-io/crypto in workerd (M2-3t-w)', () => {
  it('runs inside the Workers runtime, not Node', () => {
    const g = globalThis as { navigator?: { userAgent?: string }; WebSocketPair?: unknown };
    expect(g.navigator?.userAgent).toBe('Cloudflare-Workers');
    expect(typeof g.WebSocketPair).toBe('function');
  });

  it('hashes, derives keys and canonicalises', () => {
    expect(encodeHex(sha256(encodeUtf8('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(hkdfSha256(randomBytes(32), randomBytes(16), encodeUtf8('info'), 32)).toHaveLength(32);
    expect(canonicalize({ b: 1, a: [true, null] })).toBe('{"a":[true,null],"b":1}');
  });

  it('encrypts and decrypts a payload (AES-GCM through WebCrypto and the key commitment)', async () => {
    const h = header(encodeHex(randomBytes(32)));
    const cek = generateCek();
    const plaintext = encodeUtf8('hello from the Worker');
    const aead = await encryptPayload(h, cek, plaintext);
    expect(decodeBase64url(aead.iv)).toHaveLength(12);
    expect(await decryptPayload({ ...h, aead }, cek)).toEqual(plaintext);
    await expect(decryptPayload({ ...h, aead }, generateCek())).rejects.toThrow();
  });

  it('signs an envelope with a KeyStore and verifies it with the public key (BIP-340)', async () => {
    const store = new MemoryKeyStore(randomBytes(32));
    const { agentNostr } = await store.getPublicBundle();
    const unsigned = {
      ...header(encodeHex(agentNostr)),
      aead: { alg: 'A256GCM-KC' as const, iv: b64(12), kc: b64(32), ct: b64(32) },
    };
    const sig = await store.signEnvelopeHash(envelopeHash(unsigned));
    expect(verifyEnvelope({ ...unsigned, sig })).toBe(true);
    const other = await store.signEnvelopeHash(envelopeHash({ ...unsigned, createdAt: 1 }));
    expect(verifyEnvelope({ ...unsigned, sig: other })).toBe(false);
  });
});
