// M1-1c: the 04 §3.1 payload AEAD. AES-256-GCM under a 32-byte random CEK, a fresh 12-byte random
// IV per envelope, AAD = sha256(JCS({v, id, thread, from, createdAt, recipients})), and
// `ct` = ciphertext || 16-byte tag in base64url. The cross-runtime vectors are in
// test-vectors/aead-envelope; these tests pin the API rules.
import { describe, expect, it } from 'vitest';
import {
  CryptoInputError,
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
import { encryptPayloadWithIv } from './testing.js';

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
  it('returns aead {alg: A256GCM, iv: 12 bytes, ct: plaintext length + 16} that decrypts', async () => {
    const h = header();
    const cek = generateCek();
    const aead = await encryptPayload(h, cek, PLAINTEXT);
    expect(Object.keys(aead).sort()).toEqual(['alg', 'ct', 'iv']);
    expect(aead.alg).toBe('A256GCM');
    expect(decodeBase64url(aead.iv)).toHaveLength(12);
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
});
