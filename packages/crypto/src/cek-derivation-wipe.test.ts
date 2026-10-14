// M1-1l (04 §3.3, step 3 of the payload decryption; 04 §8.3): every key derived from the CEK is
// wiped once it has been used. encKey and kc in encryptPayload and decryptPayload, kc in
// checkKeyCommitment, and the wrap ephemeral key ikm_j in wrapCek and checkWrap. hkdf.ts is
// replaced by itself with its outputs recorded, so the test can see that every one of them is
// all zero afterwards. The CEK itself is the caller's and stays untouched.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KEY_LABELS,
  checkKeyCommitment,
  checkWrap,
  decryptPayload,
  encodeBase64url,
  encodeHex,
  encryptPayload,
  generateCek,
  randomBytes,
  wrapCek,
  type EnvelopeHeader,
} from './index.js';
import { derivePublicKey } from './keystore.js';

const outputs: Uint8Array[] = [];

vi.mock('./hkdf.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./hkdf.js')>();
  return {
    ...actual,
    hkdfSha256: vi.fn((...args: Parameters<typeof actual.hkdfSha256>) => {
      const out = actual.hkdfSha256(...args);
      outputs.push(out);
      return out;
    }),
  };
});

const b64 = (length: number): string => encodeBase64url(randomBytes(length));

function header(): EnvelopeHeader {
  return {
    v: 1,
    id: b64(16),
    thread: b64(16),
    from: encodeHex(randomBytes(32)),
    createdAt: 1760000000,
    recipients: [{ kid: b64(16), enc: b64(32), wk: b64(48) }],
  };
}

function encPublicKey(): Uint8Array {
  const key = derivePublicKey(randomBytes(32), KEY_LABELS.enc, 0);
  if (key.label !== KEY_LABELS.enc) throw new Error('unreachable');
  return key.publicKey;
}

const allZero = (bytes: Uint8Array): boolean => bytes.every((byte) => byte === 0);

afterEach(() => {
  outputs.length = 0;
});

describe('keys derived from the CEK are wiped after use', () => {
  it('encryptPayload wipes encKey and kc; decryptPayload and checkKeyCommitment wipe theirs', async () => {
    const h = header();
    const cek = generateCek();
    const cekCopy = cek.slice();
    const aead = await encryptPayload(h, cek, randomBytes(40));
    await decryptPayload({ ...h, aead }, cek);
    expect(checkKeyCommitment({ ...h, aead }, cek)).toBe(true);
    // encrypt: encKey and kc; decrypt: kc then encKey; check: kc.
    expect(outputs).toHaveLength(5);
    for (const output of outputs) expect(allZero(output)).toBe(true);
    expect(cek).toEqual(cekCopy);
  });

  it('decryptPayload wipes the derived kc on a kc mismatch, and encKey on a failed tag', async () => {
    const h = header();
    const cek = generateCek();
    const aead = await encryptPayload(h, cek, randomBytes(40));
    outputs.length = 0;
    await expect(decryptPayload({ ...h, aead }, generateCek())).rejects.toMatchObject({
      code: 'open_failed',
    });
    const ct = aead.ct.startsWith('A') ? `B${aead.ct.slice(1)}` : `A${aead.ct.slice(1)}`;
    await expect(decryptPayload({ ...h, aead: { ...aead, ct } }, cek)).rejects.toMatchObject({
      code: 'open_failed',
    });
    expect(outputs).toHaveLength(3);
    for (const output of outputs) expect(allZero(output)).toBe(true);
  });

  it('wrapCek and checkWrap wipe the derived ephemeral key', async () => {
    const pk = encPublicKey();
    const id = randomBytes(16);
    const cek = generateCek();
    outputs.length = 0;
    const entry = await wrapCek(pk, id, cek);
    expect(await checkWrap(pk, id, cek, entry)).toBe(true);
    expect(outputs).toHaveLength(2);
    for (const output of outputs) expect(allZero(output)).toBe(true);
  });
});
