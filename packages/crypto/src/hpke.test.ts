// M1-1c: 04 §3.3 CEK wrapping with RFC 9180 HPKE, mode Base, DHKEM(X25519, HKDF-SHA256),
// HKDF-SHA256, AES-256-GCM (suite 0x0020/0x0001/0x0002) through @hpke/core. info =
// utf8("agentlink/v1/cek") || the envelope id's 16 raw bytes, empty AAD, one seal per recipient.
// The published RFC 9180 vector, fixed-ephemeral wraps and every small-order point sealed under the
// all-zero key schedule run cross-runtime in test-vectors/hpke; these tests pin the API rules.
import { describe, expect, it } from 'vitest';
import {
  CEK_INFO_LABEL,
  CryptoInputError,
  KEY_LABELS,
  cekInfo,
  concatBytes,
  decodeHex,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  randomBytes,
  wrapCek,
} from './index.js';
import { derivePublicKey, deriveSecretKey, unwrapCek } from './keystore.js';
import { hpkeOpen, hpkeSealSequence, wrapCekWithEphemeralKey } from './testing.js';

function x25519Pair(): { secretKey: Uint8Array; publicKey: Uint8Array } {
  const seed = randomBytes(32);
  const key = derivePublicKey(seed, KEY_LABELS.enc, 0);
  if (key.label !== KEY_LABELS.enc) throw new Error('unreachable');
  return { secretKey: deriveSecretKey(seed, KEY_LABELS.enc, 0), publicKey: key.publicKey };
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

// RFC 7748 §6.1 / RFC 9180 §7.1.4: every X25519 u-coordinate whose DH output is all zero (small
// order, including the non-canonical encodings p and p + 1), each also with the high bit set.
const SMALL_ORDER = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800',
  '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
].flatMap((hex) => {
  const point = decodeHex(hex);
  const high = point.slice();
  high[31] = (high[31] as number) | 0x80;
  return [point, high];
});

describe('cekInfo', () => {
  it('is utf8("agentlink/v1/cek") followed by the raw 16-byte id', () => {
    const id = randomBytes(16);
    expect(CEK_INFO_LABEL).toBe('agentlink/v1/cek');
    expect(cekInfo(id)).toEqual(concatBytes(encodeUtf8('agentlink/v1/cek'), id));
  });

  it('refuses an id that is not 16 bytes', () => {
    for (const length of [0, 15, 17, 22]) {
      expect(() => cekInfo(randomBytes(length))).toThrow(CryptoInputError);
    }
  });
});

describe('wrapCek and unwrapCek', () => {
  it('round-trips a CEK with a 32-byte enc and a 48-byte wk', async () => {
    const recipient = x25519Pair();
    const id = randomBytes(16);
    const cek = randomBytes(32);
    const wrapped = await wrapCek(recipient.publicKey, id, cek);
    expect(wrapped.enc).toHaveLength(32);
    expect(wrapped.wk).toHaveLength(48);
    expect(await unwrapCek(recipient.secretKey, wrapped, id)).toEqual(cek);
  });

  it('takes (secretKey, wrapped, envelopeId) and builds info itself (04 §3.1.1, IR-M1-1c-1 F5)', async () => {
    const recipient = x25519Pair();
    const id = randomBytes(16);
    const wrapped = await wrapCek(recipient.publicKey, id, randomBytes(32));
    // The argument order of EnvelopeKeys.unwrapCek(wrapped, envelopeId), after the raw key; no
    // info and no epoch (the KeyStore picks the key for an epoch, M1-1g).
    expect(unwrapCek.length).toBe(3);
    // @ts-expect-error the envelope id comes last; the old (secretKey, id, wrapped) order is refused
    const error = await refusal(() => unwrapCek(recipient.secretKey, id, wrapped));
    expect(error.code).toBe('invalid_argument');
    // An info in place of the id is refused before any HPKE work: it is not 16 bytes.
    const info = cekInfo(id);
    expect((await refusal(() => unwrapCek(recipient.secretKey, wrapped, info))).code).toBe(
      'invalid_length',
    );
  });

  it('uses a fresh ephemeral key for every seal', async () => {
    const recipient = x25519Pair();
    const id = randomBytes(16);
    const cek = randomBytes(32);
    const a = await wrapCek(recipient.publicKey, id, cek);
    const b = await wrapCek(recipient.publicKey, id, cek);
    expect(encodeHex(a.enc)).not.toBe(encodeHex(b.enc));
    expect(encodeHex(a.wk)).not.toBe(encodeHex(b.wk));
  });

  it('seals mode Base with info = label || raw id and an empty AAD', async () => {
    const recipient = x25519Pair();
    const id = randomBytes(16);
    const cek = randomBytes(32);
    const { enc, wk } = await wrapCek(recipient.publicKey, id, cek);
    const info = concatBytes(encodeUtf8('agentlink/v1/cek'), id);
    expect(await hpkeOpen(recipient.secretKey, enc, info, new Uint8Array(0), wk)).toEqual(cek);
    // The id as base64url text in info, or a non-empty AAD, is a different seal.
    const textInfo = concatBytes(encodeUtf8('agentlink/v1/cek'), encodeUtf8(encodeBase64url(id)));
    expect(
      (await refusal(() => hpkeOpen(recipient.secretKey, enc, textInfo, new Uint8Array(0), wk)))
        .code,
    ).toBe('open_failed');
    expect(
      (await refusal(() => hpkeOpen(recipient.secretKey, enc, info, new Uint8Array(1), wk))).code,
    ).toBe('open_failed');
  });

  it('is deterministic for a fixed ephemeral key (test seam)', async () => {
    const recipient = x25519Pair();
    const ephemeral = x25519Pair();
    const id = randomBytes(16);
    const cek = randomBytes(32);
    const a = await wrapCekWithEphemeralKey(recipient.publicKey, id, cek, ephemeral.secretKey);
    const b = await wrapCekWithEphemeralKey(recipient.publicKey, id, cek, ephemeral.secretKey);
    expect(a.enc).toEqual(ephemeral.publicKey);
    expect(a).toEqual(b);
    expect(await unwrapCek(recipient.secretKey, a, id)).toEqual(cek);
  });

  it('fails for another recipient, another envelope id and any tampered byte', async () => {
    const recipient = x25519Pair();
    const id = randomBytes(16);
    const wrapped = await wrapCek(recipient.publicKey, id, randomBytes(32));
    const flip = (bytes: Uint8Array, index: number): Uint8Array => {
      const copy = bytes.slice();
      copy[index] = (copy[index] as number) ^ 1;
      return copy;
    };
    const attempts: (() => Promise<unknown>)[] = [
      () => unwrapCek(x25519Pair().secretKey, wrapped, id),
      () => unwrapCek(recipient.secretKey, wrapped, randomBytes(16)),
      () => unwrapCek(recipient.secretKey, { enc: flip(wrapped.enc, 0), wk: wrapped.wk }, id),
      () => unwrapCek(recipient.secretKey, { enc: wrapped.enc, wk: flip(wrapped.wk, 0) }, id),
      () => unwrapCek(recipient.secretKey, { enc: wrapped.enc, wk: flip(wrapped.wk, 47) }, id),
    ];
    for (const attempt of attempts) expect((await refusal(attempt)).code).toBe('open_failed');
  });

  it('refuses every small-order recipient key on wrap (all-zero shared secret)', async () => {
    for (const point of SMALL_ORDER) {
      const error = await refusal(() => wrapCek(point, randomBytes(16), randomBytes(32)));
      expect(error.code).toBe('invalid_public_key');
    }
  });

  it('refuses every small-order enc on unwrap (all-zero shared secret)', async () => {
    const recipient = x25519Pair();
    for (const point of SMALL_ORDER) {
      const wrapped = { enc: point, wk: randomBytes(48) };
      const error = await refusal(() => unwrapCek(recipient.secretKey, wrapped, randomBytes(16)));
      expect(error.code).toBe('open_failed');
    }
  });

  it('refuses wrong lengths and non-byte arguments before any HPKE work', async () => {
    const r = x25519Pair();
    const id = randomBytes(16);
    const cek = randomBytes(32);
    const ok = await wrapCek(r.publicKey, id, cek);
    const lengthCases: (() => Promise<unknown>)[] = [
      () => wrapCek(randomBytes(31), id, cek),
      () => wrapCek(r.publicKey, randomBytes(15), cek),
      () => wrapCek(r.publicKey, randomBytes(17), cek),
      () => wrapCek(r.publicKey, id, randomBytes(31)),
      () => wrapCek(r.publicKey, id, randomBytes(33)),
      () => unwrapCek(randomBytes(31), ok, id),
      () => unwrapCek(r.secretKey, ok, randomBytes(15)),
      () => unwrapCek(r.secretKey, { enc: randomBytes(31), wk: ok.wk }, id),
      () => unwrapCek(r.secretKey, { enc: ok.enc, wk: ok.wk.subarray(0, 47) }, id),
      () => unwrapCek(r.secretKey, { enc: ok.enc, wk: concatBytes(ok.wk, new Uint8Array(1)) }, id),
    ];
    for (const attempt of lengthCases) expect((await refusal(attempt)).code).toBe('invalid_length');
    const notBytes = 'x' as unknown as Uint8Array;
    for (const attempt of [
      () => wrapCek(notBytes, id, cek),
      () => wrapCek(r.publicKey, id, notBytes),
      () => unwrapCek(notBytes, ok, id),
      () => unwrapCek(r.secretKey, { enc: notBytes, wk: ok.wk }, id),
      () => unwrapCek(r.secretKey, null as unknown as typeof ok, id),
    ]) {
      expect((await refusal(attempt)).code).toBe('invalid_argument');
    }
  });

  it('leaves the caller-owned key and CEK buffers unchanged', async () => {
    const r = x25519Pair();
    const id = randomBytes(16);
    const cek = randomBytes(32);
    const [skCopy, cekCopy] = [r.secretKey.slice(), cek.slice()];
    const wrapped = await wrapCek(r.publicKey, id, cek);
    await unwrapCek(r.secretKey, wrapped, id);
    expect(r.secretKey).toEqual(skCopy);
    expect(cek).toEqual(cekCopy);
  });

  it('never puts key or CEK bytes into an error (I-7)', async () => {
    const r = x25519Pair();
    const id = randomBytes(16);
    const wrapped = await wrapCek(r.publicKey, id, randomBytes(32));
    const errors = [
      await refusal(() => unwrapCek(x25519Pair().secretKey, wrapped, id)),
      await refusal(() => unwrapCek(r.secretKey, { enc: SMALL_ORDER[0]!, wk: wrapped.wk }, id)),
      await refusal(() => wrapCek(r.publicKey, id, randomBytes(31))),
    ];
    for (const error of errors) {
      const text = `${error.message} ${String(error.cause ?? '')}`;
      for (const secret of [r.secretKey, wrapped.wk, wrapped.enc]) {
        expect(text).not.toContain(encodeHex(secret));
        expect(text).not.toContain(encodeBase64url(secret));
      }
    }
  });
});

describe('RFC 9180 suite (test seam)', () => {
  it('opens what a multi-message sender context sealed, in sequence order', async () => {
    const r = x25519Pair();
    const e = x25519Pair();
    const info = randomBytes(20);
    const messages = [0, 1, 2].map(() => ({ aad: randomBytes(8), plaintext: randomBytes(29) }));
    const sealed = await hpkeSealSequence(r.publicKey, e.secretKey, info, messages);
    expect(sealed.enc).toEqual(e.publicKey);
    expect(sealed.ciphertexts).toHaveLength(3);
    const first = messages[0]!;
    expect(
      await hpkeOpen(r.secretKey, sealed.enc, info, first.aad, sealed.ciphertexts[0]!),
    ).toEqual(first.plaintext);
    // The second ciphertext uses sequence number 1, so a single-shot open (seq 0) fails.
    const second = messages[1]!;
    const error = await refusal(() =>
      hpkeOpen(r.secretKey, sealed.enc, info, second.aad, sealed.ciphertexts[1]!),
    );
    expect(error.code).toBe('open_failed');
  });
});
