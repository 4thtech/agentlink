// DESK-D12a: the native presence wrap `ALKH` v1 (04 §2.3.4, D-145 phase 2). The byte-exact cases are
// the `alkh` vectors; these tests pin the API rules: the per-install challenge (a fresh P-256 peer
// point that is never G, or 32 fresh bytes), a fresh nonce, refusals before decryption, one generic
// error with no partial output for a wrong secret, a tampered blob or a wrong owner or kind, the
// binding of the credential and challenge, type separation from `ALKP`, inputs left untouched, and
// no secret in any error (I-7). The Secure Enclave key is stood in for by a test P-256 key.
import { p256 } from '@noble/curves/nist.js';
import { describe, expect, it } from 'vitest';
import {
  CryptoInputError,
  KEY_LABELS,
  NATIVE_PRESENCE_MACOS,
  NATIVE_PRESENCE_WINDOWS,
  encodeHex,
  encodeUtf8,
  readNativeBlobHeader,
  sha256,
} from './index.js';
import {
  createNativeChallenge,
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
const HELLO_NAME = encodeUtf8('agentlink-owner-native');
const HELLO_SPKI = new Uint8Array(294).fill(0x30);
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
    nativeSecret: ecdh(SE_SECRET, peer),
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

describe('createNativeChallenge (04 §2.3.4)', () => {
  it('kind 1: a fresh P-256 peer point, uncompressed, never G and never repeated', () => {
    const a = createNativeChallenge(NATIVE_PRESENCE_MACOS);
    const b = createNativeChallenge(NATIVE_PRESENCE_MACOS);
    expect(a.length).toBe(65);
    expect(a[0]).toBe(0x04);
    expect(() => p256.Point.fromBytes(a).assertValidity()).not.toThrow();
    expect(encodeHex(a)).not.toBe(encodeHex(b));
    expect(encodeHex(a)).not.toBe(encodeHex(G));
  });

  it('kind 2: 32 fresh bytes', () => {
    const a = createNativeChallenge(NATIVE_PRESENCE_WINDOWS);
    const b = createNativeChallenge(NATIVE_PRESENCE_WINDOWS);
    expect(a.length).toBe(32);
    expect(encodeHex(a)).not.toBe(encodeHex(b));
  });

  it('refuses an unknown kind', async () => {
    for (const kind of [0, 3, 1.5, '1', undefined]) {
      const error = await refusal(() => createNativeChallenge(kind as never));
      expect(error.code).toBe('invalid_argument');
    }
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
      macInput(peer, { credentialId: new Uint8Array(1024) }),
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
