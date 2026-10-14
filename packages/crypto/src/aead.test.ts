// M1-1c: the 04 §3.1 payload AEAD. AES-256-GCM, a fresh 12-byte random IV per envelope, AAD =
// sha256(JCS({v, id, thread, from, createdAt, recipients})), and `ct` = ciphertext || 16-byte tag in
// base64url. M1-1l (G-46, D-66, 04 §3.3): the AES key is encKey = HKDF-SHA256(CEK, "",
// "agentlink/v1/payload-key" ‖ id, 32), never the CEK, and `aead.kc` = HKDF-SHA256(CEK, "",
// "agentlink/v1/payload-commit" ‖ id, 32) is checked in constant time before AES-GCM. The
// cross-runtime vectors are in test-vectors/aead-envelope; these tests pin the API rules.
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CryptoInputError,
  KEY_COMMITMENT_LENGTH,
  PAYLOAD_COMMIT_LABEL,
  PAYLOAD_KEY_LABEL,
  checkKeyCommitment,
  concatBytes,
  decodeBase64url,
  decryptPayload,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  encryptPayload,
  envelopeAad,
  generateCek,
  randomBytes,
  type EnvelopeHeader,
  type UnsignedEnvelope,
} from './index.js';
import { deriveKeyCommitment, derivePayloadKey, encryptPayloadWithIv } from './testing.js';

const b64 = (length: number): string => encodeBase64url(randomBytes(length));

function header(): EnvelopeHeader {
  return {
    v: 1,
    id: b64(16),
    thread: b64(16),
    from: encodeHex(randomBytes(32)),
    createdAt: 1760000000,
    recipients: [1, 2, 3, 4].map(() => ({ kid: b64(16), enc: b64(32), wk: b64(48) })),
  };
}

async function refusal(run: () => Promise<unknown>): Promise<CryptoInputError> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CryptoInputError);
  return caught as CryptoInputError;
}

/** A copy of `value` without `key`. */
function withoutKey<T extends object>(value: T, key: keyof T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

interface GcmParams {
  name: 'AES-GCM';
  iv: Uint8Array;
  additionalData: Uint8Array;
  tagLength: 128;
}

/** The part of WebCrypto these tests use (the package has no DOM typings). */
interface WebCryptoSubtle {
  importKey(
    format: 'raw',
    key: Uint8Array,
    algorithm: 'AES-GCM',
    extractable: false,
    usages: string[],
  ): Promise<unknown>;
  decrypt(params: GcmParams, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
}

function webCrypto(): WebCryptoSubtle {
  return (globalThis as unknown as { crypto: { subtle: WebCryptoSubtle } }).crypto.subtle;
}

const PLAINTEXT = encodeUtf8('{"body":"hello","files":[],"replyTo":null,"type":"text"}');

describe('generateCek', () => {
  it('returns 32 fresh random bytes each time', () => {
    const a = generateCek();
    const b = generateCek();
    expect(a).toHaveLength(32);
    expect(encodeHex(a)).not.toBe(encodeHex(b));
  });
});

describe('encryptPayload and decryptPayload', () => {
  it('returns aead {alg: A256GCM-KC, iv: 12 bytes, kc: 32 bytes, ct: plaintext length + 16} that decrypts', async () => {
    const h = header();
    const cek = generateCek();
    const aead = await encryptPayload(h, cek, PLAINTEXT);
    expect(Object.keys(aead).sort()).toEqual(['alg', 'ct', 'iv', 'kc']);
    expect(aead.alg).toBe('A256GCM-KC');
    expect(decodeBase64url(aead.iv)).toHaveLength(12);
    expect(decodeBase64url(aead.kc)).toHaveLength(32);
    expect(decodeBase64url(aead.ct)).toHaveLength(PLAINTEXT.length + 16);
    const envelope: UnsignedEnvelope = { ...h, aead };
    expect(await decryptPayload(envelope, cek)).toEqual(PLAINTEXT);
    // A signed envelope decrypts the same way: sig is not part of the AAD.
    const signed = { ...envelope, sig: encodeHex(randomBytes(64)) };
    expect(await decryptPayload(signed, cek)).toEqual(PLAINTEXT);
  });

  it('draws a fresh IV for every encryption', async () => {
    const h = header();
    const cek = generateCek();
    const a = await encryptPayload(h, cek, PLAINTEXT);
    const b = await encryptPayload(h, cek, PLAINTEXT);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('encrypts an empty payload to the 16-byte tag alone', async () => {
    const h = header();
    const cek = generateCek();
    const aead = await encryptPayload(h, cek, new Uint8Array(0));
    expect(decodeBase64url(aead.ct)).toHaveLength(16);
    expect(await decryptPayload({ ...h, aead }, cek)).toEqual(new Uint8Array(0));
  });

  it('is deterministic for a fixed IV (test seam) and authenticates the header AAD', async () => {
    const h = header();
    const cek = generateCek();
    const iv = randomBytes(12);
    const a = await encryptPayloadWithIv(h, cek, iv, PLAINTEXT);
    expect(a).toEqual(await encryptPayloadWithIv(h, cek, iv, PLAINTEXT));
    expect(a.iv).toBe(encodeBase64url(iv));
    // The AAD is the 32 raw bytes of envelopeAad: the same header in another order of keys gives
    // the same JCS form, so the same ciphertext.
    const reordered = Object.fromEntries(Object.entries(h).reverse()) as unknown as EnvelopeHeader;
    expect(await encryptPayloadWithIv(reordered, cek, iv, PLAINTEXT)).toEqual(a);
    expect(envelopeAad(reordered)).toEqual(envelopeAad(h));
  });

  it('fails when any header field changes, including recipient order and createdAt', async () => {
    const h = header();
    const cek = generateCek();
    const aead = await encryptPayload(h, cek, PLAINTEXT);
    const variants: EnvelopeHeader[] = [
      { ...h, createdAt: h.createdAt + 1 },
      { ...h, recipients: [...h.recipients].reverse() },
      { ...h, thread: b64(16) },
      { ...h, id: b64(16) },
      { ...h, from: encodeHex(randomBytes(32)) },
      { ...h, recipients: [...h.recipients.slice(0, 3)] },
    ];
    for (const variant of variants) {
      expect((await refusal(() => decryptPayload({ ...variant, aead }, cek))).code).toBe(
        'open_failed',
      );
    }
  });

  it('fails for a tampered ct or tag, another IV and another CEK', async () => {
    const h = header();
    const cek = generateCek();
    const aead = await encryptPayload(h, cek, PLAINTEXT);
    const ct = decodeBase64url(aead.ct);
    const flipped = (index: number): string => {
      const copy = ct.slice();
      copy[index] = (copy[index] as number) ^ 0x80;
      return encodeBase64url(copy);
    };
    for (const [changed, key] of [
      [{ ...aead, ct: flipped(0) }, cek],
      [{ ...aead, ct: flipped(ct.length - 1) }, cek],
      [{ ...aead, iv: b64(12) }, cek],
      [aead, generateCek()],
    ] as const) {
      expect((await refusal(() => decryptPayload({ ...h, aead: changed }, key))).code).toBe(
        'open_failed',
      );
    }
  });

  it('refuses a malformed header or envelope, and a CEK or IV of the wrong length', async () => {
    const h = header();
    const cek = generateCek();
    const aead = await encryptPayload(h, cek, PLAINTEXT);
    const badHeader = { ...h, createdAt: -1 };
    expect((await refusal(() => encryptPayload(badHeader, cek, PLAINTEXT))).code).toBe(
      'invalid_envelope',
    );
    const withAead = { ...h, aead } as unknown as EnvelopeHeader;
    expect((await refusal(() => encryptPayload(withAead, cek, PLAINTEXT))).code).toBe(
      'invalid_envelope',
    );
    const badAlg = { ...h, aead: { ...aead, alg: 'A128GCM' } } as unknown as UnsignedEnvelope;
    expect((await refusal(() => decryptPayload(badAlg, cek))).code).toBe('invalid_envelope');
    // The earlier form (alg A256GCM, no kc) is refused, and so is the old alg with a kc (D-66).
    const withoutKc = withoutKey(aead, 'kc');
    const oldForm = { ...h, aead: { ...withoutKc, alg: 'A256GCM' } } as unknown as UnsignedEnvelope;
    expect((await refusal(() => decryptPayload(oldForm, cek))).code).toBe('invalid_envelope');
    const oldAlg = { ...h, aead: { ...aead, alg: 'A256GCM' } } as unknown as UnsignedEnvelope;
    expect((await refusal(() => decryptPayload(oldAlg, cek))).code).toBe('invalid_envelope');
    for (const attempt of [
      () => encryptPayload(h, randomBytes(31), PLAINTEXT),
      () => encryptPayload(h, randomBytes(16), PLAINTEXT),
      () => decryptPayload({ ...h, aead }, randomBytes(33)),
      () => encryptPayloadWithIv(h, cek, randomBytes(11), PLAINTEXT),
      () => encryptPayloadWithIv(h, cek, randomBytes(16), PLAINTEXT),
    ]) {
      expect((await refusal(attempt)).code).toBe('invalid_length');
    }
    const notBytes = 'x' as unknown as Uint8Array;
    expect((await refusal(() => encryptPayload(h, cek, notBytes))).code).toBe('invalid_argument');
    expect((await refusal(() => encryptPayload(h, notBytes, PLAINTEXT))).code).toBe(
      'invalid_argument',
    );
  });

  it('leaves the CEK and plaintext buffers unchanged and puts no secret in errors (I-7)', async () => {
    const h = header();
    const cek = generateCek();
    const [cekCopy, ptCopy] = [cek.slice(), PLAINTEXT.slice()];
    const aead = await encryptPayload(h, cek, PLAINTEXT);
    expect(cek).toEqual(cekCopy);
    expect(PLAINTEXT).toEqual(ptCopy);
    const error = await refusal(() => decryptPayload({ ...h, aead }, generateCek()));
    const text = `${error.message} ${String(error.cause ?? '')}`;
    expect(text).not.toContain(encodeHex(cek));
    expect(text).not.toContain(encodeBase64url(cek));
  });

  it('reports a runtime without WebCrypto as a platform error, never as a refused input', async () => {
    const h = header();
    const cek = generateCek();
    const aead = await encryptPayload(h, cek, PLAINTEXT);
    const random = (array: Uint8Array): Uint8Array => array;
    vi.stubGlobal('crypto', { getRandomValues: random });
    for (const attempt of [
      () => encryptPayload(h, cek, PLAINTEXT),
      () => decryptPayload({ ...h, aead }, cek),
    ]) {
      const error: unknown = await attempt().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(CryptoInputError);
    }
  });
});

// 04 §3.3: an independent reference for the two derivations (the library directly, not hkdf.ts).
function reference(label: string, cek: Uint8Array, id: Uint8Array): Uint8Array {
  return hkdf(sha256, cek, new Uint8Array(0), concatBytes(encodeUtf8(label), id), 32);
}

/** AES-256-GCM open on WebCrypto directly, for checking which key a ciphertext is under. */
async function gcmOpen(
  key: Uint8Array,
  iv: Uint8Array,
  aad: Uint8Array,
  ct: Uint8Array,
): Promise<Uint8Array | undefined> {
  const api = webCrypto();
  const cryptoKey = await api.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  try {
    return new Uint8Array(
      await api.decrypt(
        { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
        cryptoKey,
        ct,
      ),
    );
  } catch {
    return undefined;
  }
}

const flipBit = (value: string, index: number): string => {
  const bytes = decodeBase64url(value);
  bytes[index] = (bytes[index] as number) ^ 0x01;
  return encodeBase64url(bytes);
};

describe('payload key and key commitment (04 §3.3, G-46, D-66)', () => {
  it('fixes the labels and the 32-byte commitment', () => {
    expect(PAYLOAD_KEY_LABEL).toBe('agentlink/v1/payload-key');
    expect(PAYLOAD_COMMIT_LABEL).toBe('agentlink/v1/payload-commit');
    expect(KEY_COMMITMENT_LENGTH).toBe(32);
  });

  it('derives encKey and kc with HKDF-SHA256 (ikm = CEK, empty salt, info = label ‖ raw id)', async () => {
    const h = header();
    const id = decodeBase64url(h.id);
    const cek = generateCek();
    const iv = randomBytes(12);
    const encKey = reference('agentlink/v1/payload-key', cek, id);
    const kc = reference('agentlink/v1/payload-commit', cek, id);
    expect(derivePayloadKey(cek, id)).toEqual(encKey);
    expect(deriveKeyCommitment(cek, id)).toEqual(kc);
    const aead = await encryptPayloadWithIv(h, cek, iv, PLAINTEXT);
    expect(aead.kc).toBe(encodeBase64url(kc));
    // AES-256-GCM runs under encKey, never under the CEK itself.
    const ct = decodeBase64url(aead.ct);
    const aad = envelopeAad(h);
    expect(await gcmOpen(encKey, iv, aad, ct)).toEqual(PLAINTEXT);
    expect(await gcmOpen(cek, iv, aad, ct)).toBeUndefined();
    // The CEK and the two derivations are three different values.
    expect(new Set([encodeHex(cek), encodeHex(encKey), encodeHex(kc)]).size).toBe(3);
  });

  it('binds kc to the envelope id and the CEK', async () => {
    const h = header();
    const cek = generateCek();
    const a = await encryptPayload(h, cek, PLAINTEXT);
    expect((await encryptPayload(h, cek, PLAINTEXT)).kc).toBe(a.kc);
    expect((await encryptPayload({ ...h, id: b64(16) }, cek, PLAINTEXT)).kc).not.toBe(a.kc);
    expect((await encryptPayload(h, generateCek(), PLAINTEXT)).kc).not.toBe(a.kc);
  });

  it('refuses a derivation with a CEK or id of the wrong length', () => {
    const id = randomBytes(16);
    for (const run of [
      () => derivePayloadKey(randomBytes(31), id),
      () => deriveKeyCommitment(randomBytes(33), id),
      () => derivePayloadKey(generateCek(), randomBytes(15)),
      () => deriveKeyCommitment(generateCek(), randomBytes(17)),
    ]) {
      expect(run).toThrow(expect.objectContaining({ code: 'invalid_length' }));
    }
  });
});

describe('decryptPayload checks kc before AES-GCM; checkKeyCommitment tells the two apart', () => {
  it('refuses a kc with one bit flipped as open_failed, with no AES-GCM decryption', async () => {
    const h = header();
    const cek = generateCek();
    const aead = await encryptPayload(h, cek, PLAINTEXT);
    const decrypt = vi.spyOn(webCrypto(), 'decrypt');
    for (const index of [0, 31]) {
      const changed = { ...h, aead: { ...aead, kc: flipBit(aead.kc, index) } };
      expect((await refusal(() => decryptPayload(changed, cek))).code).toBe('open_failed');
      expect(checkKeyCommitment(changed, cek)).toBe(false);
    }
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('refuses a ciphertext that opens under the CEK given when kc commits to another CEK', async () => {
    // The sender's equivocation: ct is a valid AES-GCM ciphertext under this CEK's encKey, but the
    // signed kc commits to another CEK. AES-GCM alone would accept it; the kc check must not.
    const h = header();
    const cek = generateCek();
    const other = generateCek();
    const iv = randomBytes(12);
    const aead = await encryptPayloadWithIv(h, cek, iv, PLAINTEXT);
    const otherKc = (await encryptPayloadWithIv(h, other, iv, PLAINTEXT)).kc;
    const equivocal = { ...h, aead: { ...aead, kc: otherKc } };
    const encKey = reference('agentlink/v1/payload-key', cek, decodeBase64url(h.id));
    const ct = decodeBase64url(aead.ct);
    expect(await gcmOpen(encKey, iv, envelopeAad(h), ct)).toEqual(PLAINTEXT);
    expect((await refusal(() => decryptPayload(equivocal, cek))).code).toBe('open_failed');
    expect(checkKeyCommitment(equivocal, cek)).toBe(false);
    // The CEK the kc commits to passes the commitment and fails the tag: the same open_failed.
    expect(checkKeyCommitment(equivocal, other)).toBe(true);
    expect((await refusal(() => decryptPayload(equivocal, other))).code).toBe('open_failed');
  });

  it('a tampered ct passes the commitment check and fails decryption: a tag failure', async () => {
    const h = header();
    const cek = generateCek();
    const aead = await encryptPayload(h, cek, PLAINTEXT);
    const last = decodeBase64url(aead.ct).length - 1;
    const tampered = { ...h, aead: { ...aead, ct: flipBit(aead.ct, last) } };
    expect(checkKeyCommitment(tampered, cek)).toBe(true);
    expect((await refusal(() => decryptPayload(tampered, cek))).code).toBe('open_failed');
    const signed = { ...h, aead, sig: encodeHex(randomBytes(64)) };
    expect(checkKeyCommitment({ ...h, aead }, cek)).toBe(true);
    expect(checkKeyCommitment(signed, cek)).toBe(true);
    expect(checkKeyCommitment(signed, generateCek())).toBe(false);
  });

  it('checkKeyCommitment parses strictly and refuses a CEK of the wrong length', async () => {
    const h = header();
    const cek = generateCek();
    const aead = await encryptPayload(h, cek, PLAINTEXT);
    const noKc = withoutKey(aead, 'kc');
    const malformed = [
      { ...h, aead: { ...aead, kc: b64(31) } },
      { ...h, aead: { ...aead, kc: b64(33) } },
      { ...h, aead: { ...aead, kc: `${aead.kc}=` } },
      { ...h, aead: noKc },
    ] as unknown as UnsignedEnvelope[];
    for (const envelope of malformed) {
      expect(() => checkKeyCommitment(envelope, cek)).toThrow(
        expect.objectContaining({ code: 'invalid_envelope' }),
      );
      expect((await refusal(() => decryptPayload(envelope, cek))).code).toBe('invalid_envelope');
    }
    expect(() => checkKeyCommitment({ ...h, aead }, randomBytes(16))).toThrow(
      expect.objectContaining({ code: 'invalid_length' }),
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
