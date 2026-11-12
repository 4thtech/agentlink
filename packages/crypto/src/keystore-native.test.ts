// DESK-D12a: the native presence wrap `ALKH` v1 (04 §2.3.4, D-145 phase 2). The byte-exact cases are
// the `alkh` vectors; these tests pin the API rules: a fresh nonce, G or the SE key refused as the
// peer, refusals before decryption, one generic error with no partial output for a wrong secret, a
// tampered blob or a wrong owner or kind, the binding of the credential and the per-install peer key
// or challenge, the DESK-D12b helper records, type separation from `ALKP`, inputs left untouched, and
// no secret in any error (I-7). The Secure Enclave key is stood in for by a test P-256 key.
import { p256 } from '@noble/curves/nist.js';
import { describe, expect, it } from 'vitest';
import { RSA_2048_SPKI, RSA_3072_SPKI } from './keystore-native-spki.fixture.js';
import { randomBytes } from './random.js';
import {
  CryptoInputError,
  KEY_LABELS,
  NATIVE_PRESENCE_MACOS,
  NATIVE_PRESENCE_WINDOWS,
  encodeHex,
  encodeNativeHelperRecord,
  encodeUtf8,
  readNativeBlobHeader,
  readNativeCreateOutput,
  readNativeHelperRecord,
  sha256,
} from './index.js';
import {
  deriveNativeWrapKey,
  derivePublicKey,
  openNativeSeed,
  openPasskeySeed,
  sealNativeSeed,
  sealPasskeySeed,
} from './keystore.js';

const bytesOf = (label: string): Uint8Array => sha256(encodeUtf8(`keystore-native.test/${label}`));
const SEED = bytesOf('seed');
const OTHER_SEED = bytesOf('other-seed');
const nostrOf = (seed: Uint8Array): Uint8Array => {
  const key = derivePublicKey(seed, KEY_LABELS.nostr, 0);
  if (key.label !== KEY_LABELS.nostr) throw new Error('unexpected key label');
  return key.publicKey;
};
const OWNER = nostrOf(SEED);
const OTHER_OWNER = nostrOf(OTHER_SEED);
const G = p256.Point.BASE.toBytes(false);

// Test stand-in for the Secure Enclave key: the helper's ECDH is the X coordinate of d·peer.
const SE_SECRET = bytesOf('se-key');
const SE_PUB = p256.getPublicKey(SE_SECRET, false);
const OTHER_SE_PUB = p256.getPublicKey(bytesOf('other-se-key'), false);
const ecdh = (secretKey: Uint8Array, peer: Uint8Array): Uint8Array =>
  p256.getSharedSecret(secretKey, peer, true).slice(1);
const SE_HANDLE = bytesOf('se-handle');
const HELLO_NAME = encodeUtf8('AgentLink-owner-00112233445566778899aabbccddeeff');

// Stand-in for the helper's `create` (DESK-D12b): a per-install random peer point (its secret is
// dropped here, as the helper discards it) or 32 random bytes.
function createNativeChallenge(kind: number): Uint8Array {
  if (kind === NATIVE_PRESENCE_WINDOWS) return randomBytes(32);
  return p256.getPublicKey(p256.utils.randomSecretKey(), false);
}
const HELLO_SPKI = RSA_2048_SPKI;
const HELLO_SIGNATURE = new Uint8Array(256).map((_, i) => (i * 7 + 1) & 0xff);

async function refusal(run: () => Promise<unknown> | unknown): Promise<CryptoInputError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(CryptoInputError);
    return error as CryptoInputError;
  }
  throw new Error('expected a refusal');
}

function noSecretIn(error: Error, ...secrets: Uint8Array[]): void {
  const text = `${error.message} ${String((error as { code?: unknown }).code)}`;
  for (const secret of secrets) {
    expect(text).not.toContain(encodeHex(secret));
    expect(text).not.toContain(encodeHex(secret.subarray(0, 8)));
  }
}

function macInput(peer: Uint8Array, overrides: Record<string, unknown> = {}) {
  return {
    kind: NATIVE_PRESENCE_MACOS,
    nativeSecret: 'nativeSecret' in overrides ? overrides.nativeSecret : ecdh(SE_SECRET, peer),
    seed: SEED,
    credentialId: SE_HANDLE,
    credentialPublicKey: SE_PUB,
    challenge: peer,
    ...overrides,
  } as Parameters<typeof sealNativeSeed>[0];
}

const winInput = (challenge: Uint8Array) =>
  ({
    kind: NATIVE_PRESENCE_WINDOWS,
    nativeSecret: HELLO_SIGNATURE,
    seed: SEED,
    credentialId: HELLO_NAME,
    credentialPublicKey: HELLO_SPKI,
    challenge,
  }) as const;

describe('helper records (04 §2.3.4, DESK-D12b record v1)', () => {
  it('kind 1 round-trips 01 ‖ u16be L ‖ handle ‖ SE public key ‖ peer key', () => {
    const peer = createNativeChallenge(NATIVE_PRESENCE_MACOS);
    const fields = { credentialId: SE_HANDLE, credentialPublicKey: SE_PUB, challenge: peer };
    const record = encodeNativeHelperRecord(NATIVE_PRESENCE_MACOS, fields);
    expect(record.length).toBe(3 + SE_HANDLE.length + 130);
    expect(record[0]).toBe(1);
    const read = readNativeHelperRecord(NATIVE_PRESENCE_MACOS, record);
    expect(encodeHex(read.credentialId)).toBe(encodeHex(SE_HANDLE));
    expect(encodeHex(read.challenge)).toBe(encodeHex(peer));
  });

  it('kind 2 round-trips 01 ‖ u8 N ‖ name ‖ u16be S ‖ SPKI ‖ challenge', () => {
    const challenge = createNativeChallenge(NATIVE_PRESENCE_WINDOWS);
    const fields = { credentialId: HELLO_NAME, credentialPublicKey: HELLO_SPKI, challenge };
    const record = encodeNativeHelperRecord(NATIVE_PRESENCE_WINDOWS, fields);
    const read = readNativeHelperRecord(NATIVE_PRESENCE_WINDOWS, record);
    expect(encodeHex(read.credentialPublicKey)).toBe(encodeHex(HELLO_SPKI));
    expect(encodeHex(read.challenge)).toBe(encodeHex(challenge));
  });

  it('refuses G or the SE key as the peer, a wrong version, a kind mix-up and a bad name', async () => {
    const peer = createNativeChallenge(NATIVE_PRESENCE_MACOS);
    const good = encodeNativeHelperRecord(NATIVE_PRESENCE_MACOS, {
      credentialId: SE_HANDLE,
      credentialPublicKey: SE_PUB,
      challenge: peer,
    });
    const v2 = good.slice();
    v2[0] = 2;
    await refusal(() => readNativeHelperRecord(NATIVE_PRESENCE_MACOS, v2));
    await refusal(() => readNativeHelperRecord(NATIVE_PRESENCE_WINDOWS, good));
    await refusal(() => readNativeHelperRecord(NATIVE_PRESENCE_MACOS, good.subarray(1)));
    for (const challenge of [G, SE_PUB]) {
      await refusal(() =>
        encodeNativeHelperRecord(NATIVE_PRESENCE_MACOS, {
          credentialId: SE_HANDLE,
          credentialPublicKey: SE_PUB,
          challenge,
        }),
      );
    }
    await refusal(() =>
      encodeNativeHelperRecord(NATIVE_PRESENCE_WINDOWS, {
        credentialId: new Uint8Array(65).fill(0x41),
        credentialPublicKey: HELLO_SPKI,
        challenge: new Uint8Array(32).fill(1),
      }),
    );
  });
});

describe('ALKH v1 seal and open (04 §2.3.4)', () => {
  it('round-trips kind 1 with an ECDH secret, a fresh nonce each seal, and the header', async () => {
    const peer = createNativeChallenge(NATIVE_PRESENCE_MACOS);
    const input = macInput(peer);
    const a = await sealNativeSeed(input);
    const b = await sealNativeSeed(input);
    expect(a.length).toBe(234 + SE_HANDLE.length);
    expect(encodeHex(a)).not.toBe(encodeHex(b));
    const secret = ecdh(SE_SECRET, peer);
    const seed = await openNativeSeed(a, secret, {
      expectedOwnerNostr: OWNER,
      expectedKind: NATIVE_PRESENCE_MACOS,
    });
    expect(encodeHex(seed)).toBe(encodeHex(SEED));
    expect(encodeHex(await openNativeSeed(b, secret))).toBe(encodeHex(SEED));
    const header = readNativeBlobHeader(a);
    expect(header.kind).toBe(NATIVE_PRESENCE_MACOS);
    expect(encodeHex(header.ownerNostr)).toBe(encodeHex(OWNER));
    expect(encodeHex(header.credentialId)).toBe(encodeHex(SE_HANDLE));
    expect(encodeHex(header.credentialPublicKey)).toBe(encodeHex(SE_PUB));
    expect(encodeHex(header.challenge)).toBe(encodeHex(peer));
    header.challenge.fill(0);
    expect(encodeHex(readNativeBlobHeader(a).challenge)).toBe(encodeHex(peer));
  });

  it('round-trips kind 2 with a 256-byte signature', async () => {
    const challenge = createNativeChallenge(NATIVE_PRESENCE_WINDOWS);
    const blob = await sealNativeSeed(winInput(challenge));
    expect(blob.length).toBe(104 + HELLO_NAME.length + HELLO_SPKI.length + 32);
    const seed = await openNativeSeed(blob, HELLO_SIGNATURE, {
      expectedKind: NATIVE_PRESENCE_WINDOWS,
    });
    expect(encodeHex(seed)).toBe(encodeHex(SEED));
  });

  it('leaves the caller’s secret, seed and header inputs untouched', async () => {
    const peer = createNativeChallenge(NATIVE_PRESENCE_MACOS);
    const input = macInput(peer);
    const copies = [input.nativeSecret, input.seed, input.credentialId, peer].map(encodeHex);
    const blob = await sealNativeSeed(input);
    await openNativeSeed(blob, input.nativeSecret);
    expect([input.nativeSecret, input.seed, input.credentialId, peer].map(encodeHex)).toEqual(
      copies,
    );
  });

  it('a wrong secret, another install, a tampered blob, a wrong owner or kind give one error and no output', async () => {
    const peer = createNativeChallenge(NATIVE_PRESENCE_MACOS);
    const secret = ecdh(SE_SECRET, peer);
    const blob = await sealNativeSeed(macInput(peer));
    const tampered = blob.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 1;
    const otherInstall = ecdh(SE_SECRET, createNativeChallenge(NATIVE_PRESENCE_MACOS));
    const errors = [
      await refusal(() => openNativeSeed(blob, ecdh(bytesOf('other-se-key'), peer))),
      await refusal(() => openNativeSeed(blob, otherInstall)),
      await refusal(() => openNativeSeed(tampered, secret)),
      await refusal(() => openNativeSeed(blob, secret, { expectedOwnerNostr: OTHER_OWNER })),
      await refusal(() => openNativeSeed(blob, secret, { expectedKind: NATIVE_PRESENCE_WINDOWS })),
      await refusal(() => openNativeSeed(blob, secret.subarray(0, 31))),
      await refusal(() => openNativeSeed(blob, new Uint8Array(32))),
    ];
    for (const error of errors) {
      expect(error.code).toBe('open_failed');
      expect(error.message).toBe((errors[0] as Error).message);
      noSecretIn(error, SEED, secret);
    }
  });

  it('binds the credential: the same secret under another credential key, ID or owner gives another wrap key', () => {
    const peer = createNativeChallenge(NATIVE_PRESENCE_MACOS);
    const base = {
      kind: NATIVE_PRESENCE_MACOS,
      nativeSecret: ecdh(SE_SECRET, peer),
      credentialId: SE_HANDLE,
      credentialPublicKey: SE_PUB,
      challenge: peer,
      ownerNostr: OWNER,
    } as const;
    const keys = [
      deriveNativeWrapKey(base),
      deriveNativeWrapKey({ ...base, credentialPublicKey: OTHER_SE_PUB }),
      deriveNativeWrapKey({ ...base, credentialId: SE_HANDLE.subarray(1) }),
      deriveNativeWrapKey({ ...base, ownerNostr: OTHER_OWNER }),
      deriveNativeWrapKey({ ...base, challenge: createNativeChallenge(NATIVE_PRESENCE_MACOS) }),
    ].map(encodeHex);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('refuses a fixed or unsafe peer point, an off-curve point and wrong lengths on seal', async () => {
    const peer = createNativeChallenge(NATIVE_PRESENCE_MACOS);
    const offCurve = peer.slice();
    offCurve[64] = (offCurve[64] as number) ^ 1;
    const cases = [
      macInput(G),
      macInput(SE_PUB),
      macInput(offCurve, { nativeSecret: new Uint8Array(32).fill(1) }),
      macInput(peer, { credentialPublicKey: SE_PUB.subarray(0, 64) }),
      macInput(peer, { nativeSecret: new Uint8Array(32) }),
      macInput(peer, { nativeSecret: new Uint8Array(33).fill(1) }),
      macInput(peer, { credentialId: new Uint8Array(0) }),
      macInput(peer, { credentialId: new Uint8Array(1025) }),
      macInput(peer, { seed: SEED.subarray(0, 31) }),
      macInput(peer, { kind: 3 }),
      { ...winInput(new Uint8Array(31).fill(1)) },
      { ...winInput(new Uint8Array(32).fill(1)), nativeSecret: new Uint8Array(255).fill(1) },
      { ...winInput(new Uint8Array(32).fill(1)), credentialPublicKey: new Uint8Array(0) },
    ];
    for (const input of cases) {
      const error = await refusal(() => sealNativeSeed(input as never));
      noSecretIn(error, SEED);
    }
  });

  it('refuses an expected owner that is not 32 bytes and an unknown expected kind', async () => {
    const peer = createNativeChallenge(NATIVE_PRESENCE_MACOS);
    const blob = await sealNativeSeed(macInput(peer));
    const secret = ecdh(SE_SECRET, peer);
    expect(
      (await refusal(() => openNativeSeed(blob, secret, { expectedOwnerNostr: OWNER.subarray(1) })))
        .code,
    ).toBe('invalid_argument');
    expect(
      (await refusal(() => openNativeSeed(blob, secret, { expectedKind: 3 as never }))).code,
    ).toBe('invalid_argument');
  });

  it('keeps ALKH and ALKP apart in both directions, even with a rewritten magic', async () => {
    const peer = createNativeChallenge(NATIVE_PRESENCE_MACOS);
    const secret = ecdh(SE_SECRET, peer);
    const alkh = await sealNativeSeed(macInput(peer));
    const alkp = await sealPasskeySeed(secret, SEED, SE_HANDLE);
    await refusal(() => openNativeSeed(alkp, secret));
    await refusal(() => openPasskeySeed(alkh, secret));
    const patched = alkh.slice();
    patched.set(encodeUtf8('ALKP'), 0);
    await refusal(() => openPasskeySeed(patched, secret));
    await refusal(() => readNativeBlobHeader(alkp));
  });
});

// DESK-D12c, folding in the Fable review of DESK-D12a (lows 1 to 3).
describe('Fable review of DESK-D12a: -G, the Windows create output, the RSA modulus', () => {
  const negate = (point: Uint8Array): Uint8Array => p256.Point.fromBytes(point).negate().toBytes(false);

  it('refuses -G and -credPub as the peer (the X coordinate of G or of the SE key)', async () => {
    for (const peer of [negate(G), negate(SE_PUB)]) {
      await refusal(() => sealNativeSeed(macInput(peer)));
      expect(() =>
        encodeNativeHelperRecord(NATIVE_PRESENCE_MACOS, {
          credentialId: SE_HANDLE,
          credentialPublicKey: SE_PUB,
          challenge: peer,
        }),
      ).toThrow(CryptoInputError);
    }
  });

  it('refuses a kind 2 credential key that is not an RSA SubjectPublicKeyInfo', async () => {
    await refusal(() =>
      sealNativeSeed({ ...winInput(randomBytes(32)), credentialPublicKey: new Uint8Array(294).fill(0x30) }),
    );
    await refusal(() => sealNativeSeed({ ...winInput(randomBytes(32)), credentialPublicKey: SE_PUB }));
  });

  it('ties the signature length to the SPKI modulus (256 for RSA-2048, 384 for RSA-3072)', async () => {
    const challenge = randomBytes(32);
    await refusal(() => sealNativeSeed({ ...winInput(challenge), nativeSecret: new Uint8Array(384).fill(1) }));
    const sig384 = new Uint8Array(384).fill(3);
    const blob = await sealNativeSeed({
      ...winInput(challenge),
      credentialPublicKey: RSA_3072_SPKI,
      nativeSecret: sig384,
    });
    expect(encodeHex(await openNativeSeed(blob, sig384))).toBe(encodeHex(SEED));
    await refusal(() => openNativeSeed(blob, HELLO_SIGNATURE));
  });

  it('reads the Windows create output: record ‖ u16be L ‖ signature, L the modulus size', () => {
    const challenge = randomBytes(32);
    const fields = { credentialId: HELLO_NAME, credentialPublicKey: HELLO_SPKI, challenge };
    const record = encodeNativeHelperRecord(NATIVE_PRESENCE_WINDOWS, fields);
    const out = new Uint8Array([...record, 0x01, 0x00, ...HELLO_SIGNATURE]);
    const read = readNativeCreateOutput(NATIVE_PRESENCE_WINDOWS, out);
    expect(encodeHex(read.record)).toBe(encodeHex(record));
    expect(encodeHex(read.credential.challenge)).toBe(encodeHex(challenge));
    expect(encodeHex(read.firstSecret ?? new Uint8Array(0))).toBe(encodeHex(HELLO_SIGNATURE));
    for (const bad of [
      record,
      out.subarray(0, out.length - 1),
      new Uint8Array([...out, 0]),
      new Uint8Array([...record, 0x01, 0x80, ...new Uint8Array(384).fill(1)]),
      new Uint8Array([...record, 0x01, 0x00, ...new Uint8Array(256)]),
    ]) {
      expect(() => readNativeCreateOutput(NATIVE_PRESENCE_WINDOWS, bad)).toThrow(CryptoInputError);
    }
  });

  it('reads the macOS create output: the record alone, no secret (create needs no gesture)', () => {
    const peer = createNativeChallenge(NATIVE_PRESENCE_MACOS);
    const record = encodeNativeHelperRecord(NATIVE_PRESENCE_MACOS, {
      credentialId: SE_HANDLE,
      credentialPublicKey: SE_PUB,
      challenge: peer,
    });
    const read = readNativeCreateOutput(NATIVE_PRESENCE_MACOS, record);
    expect(encodeHex(read.record)).toBe(encodeHex(record));
    expect(read.firstSecret).toBeUndefined();
    expect(() =>
      readNativeCreateOutput(NATIVE_PRESENCE_MACOS, new Uint8Array([...record, 0, 32, ...new Uint8Array(32).fill(1)])),
    ).toThrow(CryptoInputError);
  });
});
