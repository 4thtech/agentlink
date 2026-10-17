// M1-1k: the owner seed blobs `ALKP` v1 (passkey PRF wrap, 04 §2.3.1) and `ALKR` v1 (recovery code,
// 04 §2.3.2), D-82. The byte-exact cases are the `prf-wrap` vectors; these tests pin the API rules:
// fresh nonce and salt, the recovery-code format (grouping, alphabet), refusals before any KDF or
// decryption, one generic error with no partial output for a wrong secret or a tampered blob, the
// owner binding, type separation from `ALKO` and `ALKS` in both directions, and no secret in any
// error (I-7). The KDF runs at the floor (m = 19 MiB, t = 2, p = 1) to keep the suite fast.
import { describe, expect, it, vi } from 'vitest';
import {
  CryptoInputError,
  KEYSTORE_KDF_DEFAULTS,
  KEY_LABELS,
  decodeUtf8,
  encodeHex,
  encodeUtf8,
  ownerPrfSalt,
  readPasskeyBlobHeader,
  sha256,
} from './index.js';
import {
  deriveAgentId,
  derivePrfWrapKey,
  derivePublicKey,
  deriveKeystoreKek,
  generateRecoveryCode,
  normalizeSecret,
  openKeystoreFile,
  openOwnerSeed,
  openPasskeySeed,
  openRecoverySeed,
  sealKeystoreFile,
  sealOwnerSeed,
  sealPasskeySeed,
  sealRecoverySeed,
} from './keystore.js';

vi.setConfig({ testTimeout: 60_000 });

const FLOOR = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const bytesOf = (label: string): Uint8Array => sha256(encodeUtf8(`owner-seed-wrap.test/${label}`));
const SEED = bytesOf('seed');
const OTHER_SEED = bytesOf('other-seed');
const PRF = bytesOf('prf');
const OTHER_PRF = bytesOf('other-prf');
const CRED = bytesOf('cred').slice(0, 16);
const nostrOf = (seed: Uint8Array): Uint8Array => {
  const key = derivePublicKey(seed, KEY_LABELS.nostr, 0);
  if (key.label !== KEY_LABELS.nostr) throw new Error('unexpected key label');
  return key.publicKey;
};
const OWNER = nostrOf(SEED);
const OTHER_OWNER = nostrOf(OTHER_SEED);
const CODE = generateRecoveryCode();

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

describe('passkey PRF salt and wrap key (04 §2.3 step 3)', () => {
  it('the PRF salt is sha256("agentlink-owner-v1") and a fresh copy each call', () => {
    const salt = ownerPrfSalt();
    expect(encodeHex(salt)).toBe(encodeHex(sha256(encodeUtf8('agentlink-owner-v1'))));
    salt.fill(0);
    expect(encodeHex(ownerPrfSalt())).toBe(encodeHex(sha256(encodeUtf8('agentlink-owner-v1'))));
  });

  it('refuses a PRF output that is not 32 bytes', async () => {
    await refusal(() => derivePrfWrapKey(PRF.subarray(0, 31)));
    await refusal(() => derivePrfWrapKey(new Uint8Array(33)));
  });
});

describe('ALKP v1 (04 §2.3.1)', () => {
  it('seals with a fresh nonce, opens, and exposes only the public header', async () => {
    const a = await sealPasskeySeed(PRF, SEED, CRED);
    const b = await sealPasskeySeed(PRF, SEED, CRED);
    expect(a.length).toBe(100 + CRED.length);
    expect(decodeUtf8(a.subarray(0, 4))).toBe('ALKP');
    expect(encodeHex(a)).not.toBe(encodeHex(b));
    expect(encodeHex(await openPasskeySeed(a, PRF, { expectedOwnerNostr: OWNER }))).toBe(
      encodeHex(SEED),
    );
    expect(encodeHex(await openPasskeySeed(b, PRF))).toBe(encodeHex(SEED));
    const header = readPasskeyBlobHeader(a);
    expect(encodeHex(header.ownerNostr)).toBe(encodeHex(OWNER));
    expect(encodeHex(header.credentialId)).toBe(encodeHex(CRED));
  });

  it('accepts credential IDs of 1 and 1023 bytes and refuses 0 and 1024 on seal', async () => {
    for (const length of [1, 1023]) {
      const blob = await sealPasskeySeed(PRF, SEED, new Uint8Array(length).fill(7));
      expect(blob.length).toBe(100 + length);
    }
    await refusal(() => sealPasskeySeed(PRF, SEED, new Uint8Array(0)));
    await refusal(() => sealPasskeySeed(PRF, SEED, new Uint8Array(1024)));
  });

  it('refuses a wrong-sized seed or PRF output on seal', async () => {
    await refusal(() => sealPasskeySeed(PRF, SEED.subarray(0, 31), CRED));
    await refusal(() => sealPasskeySeed(PRF.subarray(0, 31), SEED, CRED));
  });

  it('a wrong passkey, a tampered blob and a wrong owner give the same error and no output', async () => {
    const blob = await sealPasskeySeed(PRF, SEED, CRED);
    const tampered = blob.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 1;
    const owner = blob.slice();
    owner[6] = (owner[6] as number) ^ 1;
    const errors = [
      await refusal(() => openPasskeySeed(blob, OTHER_PRF)),
      await refusal(() => openPasskeySeed(tampered, PRF)),
      await refusal(() => openPasskeySeed(owner, PRF)),
      await refusal(() => openPasskeySeed(blob, PRF, { expectedOwnerNostr: OTHER_OWNER })),
    ];
    for (const error of errors) {
      expect(error.code).toBe('open_failed');
      expect(error.message).toBe((errors[0] as Error).message);
      noSecretIn(error, SEED, PRF, OTHER_PRF);
    }
  });

  it('refuses an expected owner key that is not 32 bytes', async () => {
    const blob = await sealPasskeySeed(PRF, SEED, CRED);
    const error = await refusal(() =>
      openPasskeySeed(blob, PRF, { expectedOwnerNostr: OWNER.subarray(0, 31) }),
    );
    expect(error.code).toBe('invalid_argument');
  });

  it('readPasskeyBlobHeader refuses a malformed blob', async () => {
    const blob = await sealPasskeySeed(PRF, SEED, CRED);
    await refusal(() => readPasskeyBlobHeader(blob.subarray(0, blob.length - 1)));
    await refusal(() => readPasskeyBlobHeader(new Uint8Array(0)));
  });
});

describe('recovery code (04 §2.3 step 5, §2.3.2)', () => {
  it('is 24 base32 characters in six groups of four that normalise to 15 bytes', () => {
    const text = decodeUtf8(CODE);
    expect(text).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){5}$/);
    expect(normalizeSecret(CODE, 1, 'prompt').length).toBe(15);
    expect(decodeUtf8(generateRecoveryCode())).not.toBe(text);
  });

  it('uses the whole base32 alphabet and nothing else', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64; i += 1) {
      for (const c of decodeUtf8(generateRecoveryCode()).replaceAll('-', '')) seen.add(c);
    }
    expect([...seen].every((c) => /^[A-Z2-7]$/.test(c))).toBe(true);
    expect(seen.size).toBe(32);
  });
});

describe('ALKR v1 (04 §2.3.2)', () => {
  it('round trips with a fresh salt and nonce; any spelling of the code opens it', async () => {
    const a = await sealRecoverySeed(CODE, SEED, FLOOR);
    const b = await sealRecoverySeed(CODE, SEED, FLOOR);
    expect(a.length).toBe(90);
    expect(decodeUtf8(a.subarray(0, 4))).toBe('ALKR');
    expect(encodeHex(a.subarray(13, 29))).not.toBe(encodeHex(b.subarray(13, 29)));
    expect(encodeHex(a.subarray(30, 42))).not.toBe(encodeHex(b.subarray(30, 42)));
    const spelled = encodeUtf8(decodeUtf8(CODE).toLowerCase().replaceAll('-', ' '));
    const seed = await openRecoverySeed(
      a,
      { secret: spelled, source: 'prompt' },
      { expectedOwnerNostr: OWNER },
    );
    expect(encodeHex(seed)).toBe(encodeHex(SEED));
    expect(encodeHex(await openRecoverySeed(b, { secret: CODE, source: 'prompt' }))).toBe(
      encodeHex(SEED),
    );
  });

  it('writes the default KDF parameters when none are given', async () => {
    const blob = await sealRecoverySeed(CODE, SEED);
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    expect(view.getUint32(7, false)).toBe(KEYSTORE_KDF_DEFAULTS.memoryKiB);
    expect(blob[11]).toBe(KEYSTORE_KDF_DEFAULTS.iterations);
    expect(blob[12]).toBe(KEYSTORE_KDF_DEFAULTS.parallelism);
    expect(blob[5]).toBe(1);
  });

  it('refuses a chosen passphrase: only generated codes wrap a recovery blob', async () => {
    const error = await refusal(() =>
      sealRecoverySeed(encodeUtf8('correct horse battery staple'), SEED, FLOOR),
    );
    expect(error.code).toBe('invalid_secret');
  });

  it('a mistyped code fails cleanly without partial output', async () => {
    const blob = await sealRecoverySeed(CODE, SEED, FLOOR);
    const text = decodeUtf8(CODE);
    const swapped = (text[0] === 'A' ? 'B' : 'A') + text.slice(1);
    const outside = `${text.slice(0, -1)}!`;
    const wrong = await refusal(() =>
      openRecoverySeed(blob, { secret: encodeUtf8(swapped), source: 'prompt' }),
    );
    expect(wrong.code).toBe('open_failed');
    const malformed = await refusal(() =>
      openRecoverySeed(blob, { secret: encodeUtf8(outside), source: 'prompt' }),
    );
    expect(malformed.code).toBe('invalid_secret');
    noSecretIn(wrong, SEED, normalizeSecret(CODE, 1, 'prompt'));
  });

  it('refuses another owner and a tampered blob with the same error', async () => {
    const blob = await sealRecoverySeed(CODE, SEED, FLOOR);
    const tampered = blob.slice();
    tampered[50] = (tampered[50] as number) ^ 1;
    const a = await refusal(() =>
      openRecoverySeed(blob, { secret: CODE, source: 'prompt' }, { expectedOwnerNostr: OTHER_OWNER }),
    );
    const b = await refusal(() => openRecoverySeed(tampered, { secret: CODE, source: 'prompt' }));
    expect(a.code).toBe('open_failed');
    expect(b.message).toBe(a.message);
  });
});

describe('type separation (D-82): ALKP, ALKR, ALKO and ALKS never open as one another', () => {
  it('ALKO and ALKS readers refuse ALKP and ALKR blobs, also with a rewritten magic', async () => {
    const alkr = await sealRecoverySeed(CODE, SEED, FLOOR);
    const alkp = await sealPasskeySeed(PRF, SEED, CRED);
    const asAlko = alkr.slice();
    asAlko.set(encodeUtf8('ALKO'), 0);
    const owner = {
      ownerNostr: OWNER,
      ownerEvm: (() => {
        const key = derivePublicKey(SEED, KEY_LABELS.evm, 0);
        if (key.label !== KEY_LABELS.evm) throw new Error('unexpected key label');
        return key.address;
      })(),
    };
    for (const blob of [alkr, alkp, asAlko]) {
      await refusal(() =>
        openOwnerSeed(blob, { secret: CODE, source: 'prompt' }, owner, {
          fileKeystoreMachine: false,
        }),
      );
      await refusal(() =>
        openKeystoreFile(blob, { secret: CODE, source: 'prompt' }, '0x' + '00'.repeat(20)),
      );
    }
  });

  it('ALKR and ALKP readers refuse ALKO and ALKS blobs under the same code', async () => {
    const kek = await deriveKeystoreKek(
      'ALKO',
      { secret: CODE, secretKind: 1, source: 'prompt' },
      new Uint8Array(16).fill(1),
      FLOOR,
    );
    const alko = await sealOwnerSeed(kek, SEED, { destination: 'local', fileKeystoreMachine: true });
    const asAlkr = alko.slice();
    asAlkr.set(encodeUtf8('ALKR'), 0);
    const alksKek = await deriveKeystoreKek(
      'ALKS',
      { secret: CODE, secretKind: 1, source: 'prompt' },
      new Uint8Array(16).fill(2),
      FLOOR,
    );
    const alks = await sealKeystoreFile(alksKek, deriveAgentId(SEED), [{ name: 'seed', value: SEED }]);
    for (const blob of [alko, asAlkr, alks]) {
      await refusal(() => openRecoverySeed(blob, { secret: CODE, source: 'prompt' }));
      await refusal(() => openPasskeySeed(blob, PRF));
    }
  });
});
