// IR-M1-1c-1 F1: guards our own RFC 9180 §7.1.4 check (the X25519 output must not be all zero).
// WebCrypto refuses small-order points by itself in every runtime we test, so the vectors pass even
// without our check. These tests prove that our check fires, before any HPKE or WebCrypto work:
// 1. With the noble X25519 shimmed to return 32 zero bytes for a valid key, wrap and unwrap still
//    refuse, which only our check can do (WebCrypto would see a normal key).
// 2. For every small-order point, the refusal happens with no call into @hpke/core or
//    crypto.subtle at all.
import { CipherSuite } from '@hpke/core';
import { x25519 } from '@noble/curves/ed25519.js';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { CryptoInputError, KEY_LABELS, decodeHex, randomBytes, wrapCek } from './index.js';
import { derivePublicKey, deriveSecretKey, unwrapCek } from './keystore.js';
import { hpkeOpen, hpkeSealSequence } from './testing.js';

// The noble module is replaced by itself with getSharedSecret wrapped in a spy, so a test can make
// it return an all-zero result once; everything else is the real library.
vi.mock('@noble/curves/ed25519.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@noble/curves/ed25519.js')>();
  return {
    ...actual,
    x25519: { ...actual.x25519, getSharedSecret: vi.fn(actual.x25519.getSharedSecret) },
  };
});

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

const SUBTLE_METHODS = ['importKey', 'exportKey', 'deriveBits', 'encrypt', 'decrypt', 'sign'];

let spies: MockInstance[] = [];

/** Spies on every @hpke/core suite entry and every crypto.subtle method HPKE uses. */
function watchHpkeAndWebCrypto(): void {
  const subtle = (globalThis as unknown as { crypto: { subtle: Record<string, unknown> } }).crypto
    .subtle;
  spies = [
    vi.spyOn(CipherSuite.prototype, 'createSenderContext'),
    vi.spyOn(CipherSuite.prototype, 'createRecipientContext'),
    vi.spyOn(CipherSuite.prototype, 'seal'),
    vi.spyOn(CipherSuite.prototype, 'open'),
    ...SUBTLE_METHODS.map((name) => vi.spyOn(subtle as Record<string, () => unknown>, name)),
  ];
}

function expectNoHpkeOrWebCryptoWork(): void {
  for (const spy of spies)
    expect(spy.getMockName() + String(spy.mock.calls.length)).toBe(spy.getMockName() + '0');
}

beforeEach(() => {
  vi.mocked(x25519.getSharedSecret).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  spies = [];
});

describe('RFC 9180 §7.1.4: our all-zero shared-secret check', () => {
  it('refuses a wrap whose X25519 output is all zero, even for a valid recipient key', async () => {
    const recipient = x25519Pair();
    vi.mocked(x25519.getSharedSecret).mockReturnValueOnce(new Uint8Array(32));
    watchHpkeAndWebCrypto();
    const error = await refusal(() =>
      wrapCek(recipient.publicKey, randomBytes(16), randomBytes(32)),
    );
    expect(error.code).toBe('invalid_public_key');
    expect(x25519.getSharedSecret).toHaveBeenCalledTimes(1);
    expectNoHpkeOrWebCryptoWork();
  });

  it('refuses an unwrap whose X25519 output is all zero, even for a valid wrap', async () => {
    const recipient = x25519Pair();
    const id = randomBytes(16);
    const wrapped = await wrapCek(recipient.publicKey, id, randomBytes(32));
    // The wrap is valid: without the shim it opens.
    expect(await unwrapCek(recipient.secretKey, wrapped, id)).toHaveLength(32);
    vi.mocked(x25519.getSharedSecret).mockReturnValueOnce(new Uint8Array(32));
    watchHpkeAndWebCrypto();
    const error = await refusal(() => unwrapCek(recipient.secretKey, wrapped, id));
    expect(error.code).toBe('open_failed');
    expectNoHpkeOrWebCryptoWork();
  });

  it('refuses the raw seal and open paths of the seam the same way', async () => {
    const r = x25519Pair();
    const e = x25519Pair();
    const info = randomBytes(8);
    const sealed = await hpkeSealSequence(r.publicKey, e.secretKey, info, [
      { aad: new Uint8Array(0), plaintext: randomBytes(5) },
    ]);
    vi.mocked(x25519.getSharedSecret).mockReturnValueOnce(new Uint8Array(32));
    vi.mocked(x25519.getSharedSecret).mockReturnValueOnce(new Uint8Array(32));
    watchHpkeAndWebCrypto();
    const sealError = await refusal(() =>
      hpkeSealSequence(r.publicKey, e.secretKey, info, [
        { aad: new Uint8Array(0), plaintext: randomBytes(5) },
      ]),
    );
    expect(sealError.code).toBe('invalid_public_key');
    const ct = sealed.ciphertexts[0]!;
    const openError = await refusal(() =>
      hpkeOpen(r.secretKey, sealed.enc, info, new Uint8Array(0), ct),
    );
    expect(openError.code).toBe('open_failed');
    expectNoHpkeOrWebCryptoWork();
  });

  it('refuses every small-order point before any HPKE or WebCrypto work, both directions', async () => {
    const recipient = x25519Pair();
    for (const point of SMALL_ORDER) {
      watchHpkeAndWebCrypto();
      const wrapError = await refusal(() => wrapCek(point, randomBytes(16), randomBytes(32)));
      expect(wrapError.code).toBe('invalid_public_key');
      const unwrapError = await refusal(() =>
        unwrapCek(recipient.secretKey, { enc: point, wk: randomBytes(48) }, randomBytes(16)),
      );
      expect(unwrapError.code).toBe('open_failed');
      expectNoHpkeOrWebCryptoWork();
      vi.restoreAllMocks();
    }
  });
});
