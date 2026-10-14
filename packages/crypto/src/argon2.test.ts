// M1-1f: Argon2id v1.3 (RFC 9106) through @noble/hashes, the KDF of the owner passphrase wrap, the
// file KeyStore and the recovery code (04 §2.3, §2.8). The cross-runtime vectors are in
// test-vectors/owner-wrap; these tests pin the API rules.
import { describe, expect, it } from 'vitest';
import { CryptoInputError, encodeHex, encodeUtf8 } from './index.js';
import { argon2id } from './keystore.js';
import { argon2idWithSecretAndAd } from './testing.js';

const SMALL = { memoryKiB: 32, iterations: 3, parallelism: 4 } as const;

async function refusedWith(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(CryptoInputError);
    expect((error as CryptoInputError).code).toBe(code);
    return;
  }
  throw new Error('expected a refusal');
}

describe('argon2id', () => {
  it('matches RFC 9106 §5.3 (secret and associated data through the test seam)', async () => {
    const out = await argon2idWithSecretAndAd(
      new Uint8Array(32).fill(0x01),
      new Uint8Array(16).fill(0x02),
      SMALL,
      { secret: new Uint8Array(8).fill(0x03), ad: new Uint8Array(12).fill(0x04), length: 32 },
    );
    expect(encodeHex(out)).toBe('0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
  });

  it('is the same function with no secret and no associated data', async () => {
    const password = encodeUtf8('long phrase');
    const salt = new Uint8Array(16).fill(7);
    const plain = await argon2id(password, salt, SMALL);
    const seam = await argon2idWithSecretAndAd(password, salt, SMALL, {
      secret: new Uint8Array(0),
      ad: new Uint8Array(0),
      length: 32,
    });
    expect(plain).toEqual(seam);
    expect(plain.length).toBe(32);
  });

  it('refuses parameters outside RFC 9106 or above the 256 MiB cap, before running', async () => {
    const password = encodeUtf8('long phrase');
    const salt = new Uint8Array(16);
    for (const params of [
      { ...SMALL, memoryKiB: 31 },
      { ...SMALL, memoryKiB: 262145 },
      { ...SMALL, iterations: 0 },
      { ...SMALL, parallelism: 0 },
      { ...SMALL, iterations: 1.5 },
    ]) {
      await refusedWith(() => argon2id(password, salt, params), 'invalid_argument');
    }
    await refusedWith(() => argon2id(password, new Uint8Array(7), SMALL), 'invalid_argument');
    await refusedWith(
      () => argon2id('x' as unknown as Uint8Array, salt, SMALL),
      'invalid_argument',
    );
  });
});
