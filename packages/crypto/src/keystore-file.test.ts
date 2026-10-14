// M1-1f: the file KeyStore `ALKS` v1 and the owner wrap `ALKO` v1 (04 §2.8, D-54; 04 §2.2, §2.3).
// The byte-exact cases are the keystore-file vectors (Node only) and the Argon2id vectors of
// owner-wrap; these tests pin the API rules: fresh salt and nonce, label and magic separation in
// both directions, agent and owner binding, refusals before the KDF, the local-only owner wrap, one
// generic error for a wrong secret or a tampered file, and no secret in any error (I-7).
// The KDF runs at the floor (m = 19 MiB, t = 2, p = 1) to keep the suite fast; the defaults run in
// the vectors.
import { describe, expect, it } from 'vitest';
import {
  CryptoInputError,
  KEYSTORE_KDF_BOUNDS,
  KEYSTORE_KDF_DEFAULTS,
  decodeUtf8,
  encodeUtf8,
  sha256,
} from './index.js';
import {
  deriveAgentId,
  deriveKeystoreKek,
  derivePublicKey,
  generateSecretCode,
  newKeystoreKek,
  openKeystoreFile,
  openKeystoreFileWithKek,
  openOwnerSeed,
  sealKeystoreFile,
  sealOwnerSeed,
} from './keystore.js';

const FLOOR = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const PHRASE = encodeUtf8('correct horse battery staple');
const OTHER_PHRASE = encodeUtf8('correct horse battery stapler');
const seedOf = (label: string): Uint8Array => sha256(encodeUtf8(`keystore-file.test/${label}`));

const SEED_1 = seedOf('agent-1');
const SEED_2 = seedOf('agent-2');
const OWNER_SEED = seedOf('owner');
const AGENT_1 = deriveAgentId(SEED_1);
const AGENT_2 = deriveAgentId(SEED_2);
const STORE_VALUE = seedOf('store');

function ownerOf(seed: Uint8Array): { ownerEvm: Uint8Array; ownerNostr: Uint8Array } {
  const evm = derivePublicKey(seed, 'agentlink/v1/evm', 0);
  const nostr = derivePublicKey(seed, 'agentlink/v1/nostr', 0);
  if (evm.label !== 'agentlink/v1/evm' || nostr.label !== 'agentlink/v1/nostr') throw new Error();
  return { ownerEvm: evm.address, ownerNostr: nostr.publicKey };
}
const OWNER = ownerOf(OWNER_SEED);

const entriesFor = (seed: Uint8Array) => [
  { name: 'seed', value: seed },
  { name: 'store-key', value: STORE_VALUE },
];

async function refusedWith(run: () => Promise<unknown>, code: string): Promise<CryptoInputError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(CryptoInputError);
    expect((error as CryptoInputError).code).toBe(code);
    return error as CryptoInputError;
  }
  throw new Error('expected a refusal');
}

const phrase = (secret: Uint8Array) => ({ secret, source: 'prompt' as const });

describe('KDF parameters', () => {
  it('pins the defaults and the read bounds of 04 §2.8', () => {
    expect(KEYSTORE_KDF_DEFAULTS).toEqual({ memoryKiB: 65536, iterations: 3, parallelism: 1 });
    expect(KEYSTORE_KDF_BOUNDS).toEqual({
      minMemoryKiB: 19456,
      maxMemoryKiB: 262144,
      minIterations: 2,
      maxIterations: 8,
      minParallelism: 1,
      maxParallelism: 4,
    });
    expect(Object.isFrozen(KEYSTORE_KDF_DEFAULTS)).toBe(true);
  });

  it('refuses out-of-bounds parameters on create, before the KDF runs', async () => {
    for (const params of [
      { ...FLOOR, memoryKiB: 19455 },
      { ...FLOOR, iterations: 1 },
      { ...FLOOR, memoryKiB: 262145 },
      { ...FLOOR, iterations: 9 },
      { ...FLOOR, parallelism: 0 },
      { ...FLOOR, parallelism: 5 },
    ]) {
      await refusedWith(
        () => newKeystoreKek('ALKS', { secret: PHRASE, secretKind: 2, source: 'prompt' }, params),
        'invalid_argument',
      );
    }
  });
});

describe('ALKS v1', () => {
  it('seals with a fresh salt per kek and a fresh nonce per write, and opens to the entries', async () => {
    const secret = { secret: PHRASE, secretKind: 2, source: 'prompt' } as const;
    const kek = await newKeystoreKek('ALKS', secret, FLOOR);
    const kek2 = await newKeystoreKek('ALKS', secret, FLOOR);
    expect(kek.salt).not.toEqual(kek2.salt);
    expect(kek.kek).not.toEqual(kek2.kek);

    const file = await sealKeystoreFile(kek, AGENT_1, entriesFor(SEED_1));
    const again = await sealKeystoreFile(kek, AGENT_1, entriesFor(SEED_1));
    expect(decodeUtf8(file.subarray(0, 4))).toBe('ALKS');
    expect(file.subarray(30, 42)).not.toEqual(again.subarray(30, 42));
    // header 43 + 42-character agent ID, entries `seed` (2+4+4+32) and `store-key` (2+9+4+32), tag.
    expect(file.length).toBe(85 + 42 + 47 + 16);

    const opened = await openKeystoreFile(file, phrase(PHRASE), AGENT_1);
    expect(opened.entries.map((e) => e.name)).toEqual(['seed', 'store-key']);
    expect(opened.entries[0]?.value).toBeInstanceOf(Uint8Array);
    expect(opened.entries[0]?.value).toEqual(SEED_1);
    expect(opened.kek.kek).toEqual(kek.kek);
    expect(await openKeystoreFileWithKek(again, opened.kek, AGENT_1)).toEqual(opened.entries);
  });

  it('opens a generated code in any accepted spelling', async () => {
    const code = generateSecretCode();
    const kek = await newKeystoreKek(
      'ALKS',
      { secret: code, secretKind: 1, source: 'prompt' },
      FLOOR,
    );
    const file = await sealKeystoreFile(kek, AGENT_1, entriesFor(SEED_1));
    const spelled = encodeUtf8(`${decodeUtf8(code).toLowerCase()}\r\n`);
    const opened = await openKeystoreFile(file, { secret: spelled, source: 'file' }, AGENT_1);
    expect(opened.entries[0]?.value).toEqual(SEED_1);
  });

  it('gives one generic error for a wrong passphrase and a tampered file', async () => {
    const kek = await newKeystoreKek(
      'ALKS',
      { secret: PHRASE, secretKind: 2, source: 'prompt' },
      FLOOR,
    );
    const file = await sealKeystoreFile(kek, AGENT_1, entriesFor(SEED_1));
    const wrong = await refusedWith(
      () => openKeystoreFile(file, phrase(OTHER_PHRASE), AGENT_1),
      'open_failed',
    );
    const messages = new Set([wrong.message]);
    for (const offset of [0, 4, 5, 6, 10, 11, 12, 13, 29, 30, 42, 43, 85, file.length - 1]) {
      const tampered = file.slice();
      tampered[offset] = (tampered[offset] as number) ^ 0x01;
      const error = await refusedWith(
        () => openKeystoreFile(tampered, phrase(PHRASE), AGENT_1),
        'open_failed',
      );
      messages.add(error.message);
    }
    for (const cut of [
      file.subarray(0, file.length - 1),
      file.subarray(0, 85),
      file.subarray(0, 20),
      new Uint8Array(0),
    ]) {
      const error = await refusedWith(
        () => openKeystoreFile(cut, phrase(PHRASE), AGENT_1),
        'open_failed',
      );
      messages.add(error.message);
    }
    expect(messages.size).toBe(1);
    expect([...messages][0]).not.toMatch(/horse|staple|seed|0x/i);
  });

  it('binds the agent: two agents with the same passphrase cannot swap files', async () => {
    const kek = await newKeystoreKek(
      'ALKS',
      { secret: PHRASE, secretKind: 2, source: 'prompt' },
      FLOOR,
    );
    const file1 = await sealKeystoreFile(kek, AGENT_1, entriesFor(SEED_1));
    const file2 = await sealKeystoreFile(kek, AGENT_2, entriesFor(SEED_2));
    await refusedWith(() => openKeystoreFile(file2, phrase(PHRASE), AGENT_1), 'open_failed');
    await refusedWith(() => openKeystoreFile(file1, phrase(PHRASE), AGENT_2), 'open_failed');
  });

  it('refuses to seal a seed entry that does not derive the agent ID', async () => {
    const kek = await newKeystoreKek(
      'ALKS',
      { secret: PHRASE, secretKind: 2, source: 'prompt' },
      FLOOR,
    );
    await refusedWith(() => sealKeystoreFile(kek, AGENT_1, entriesFor(SEED_2)), 'invalid_argument');
    await refusedWith(
      () => sealKeystoreFile(kek, AGENT_1, [{ name: 'store-key', value: STORE_VALUE }]),
      'invalid_argument',
    );
  });

  it('refuses an agent ID outside the exact 04 §2.9 form before any path or KDF', async () => {
    const kek = await newKeystoreKek(
      'ALKS',
      { secret: PHRASE, secretKind: 2, source: 'prompt' },
      FLOOR,
    );
    const file = await sealKeystoreFile(kek, AGENT_1, entriesFor(SEED_1));
    for (const bad of [
      AGENT_1.toUpperCase(),
      AGENT_1.slice(2),
      AGENT_1.slice(0, -1),
      '../owner',
      'agent_01',
    ]) {
      await refusedWith(() => openKeystoreFile(file, phrase(PHRASE), bad), 'invalid_argument');
      await refusedWith(() => sealKeystoreFile(kek, bad, entriesFor(SEED_1)), 'invalid_argument');
    }
  });

  it('refuses duplicate entry names and plaintext above 64 KiB when sealing', async () => {
    const kek = await newKeystoreKek(
      'ALKS',
      { secret: PHRASE, secretKind: 2, source: 'prompt' },
      FLOOR,
    );
    await refusedWith(
      () =>
        sealKeystoreFile(kek, AGENT_1, [...entriesFor(SEED_1), { name: 'seed', value: SEED_1 }]),
      'invalid_argument',
    );
    const big = new Uint8Array(65536);
    await refusedWith(
      () => sealKeystoreFile(kek, AGENT_1, [...entriesFor(SEED_1), { name: 'blob', value: big }]),
      'invalid_argument',
    );
  });

  it('refuses a write whose file header no longer matches the in-memory kek', async () => {
    const secret = { secret: PHRASE, secretKind: 2, source: 'prompt' } as const;
    const kek = await newKeystoreKek('ALKS', secret, FLOOR);
    const rekeyed = await newKeystoreKek('ALKS', secret, FLOOR);
    const file = await sealKeystoreFile(rekeyed, AGENT_1, entriesFor(SEED_1));
    await refusedWith(() => openKeystoreFileWithKek(file, kek, AGENT_1), 'open_failed');
  });
});

describe('ALKO v1 (owner seed wrap, local storage only)', () => {
  it('is exactly 90 bytes and opens to the owner seed for both secret kinds', async () => {
    const code = generateSecretCode();
    for (const secret of [
      { secret: code, secretKind: 1, source: 'prompt' } as const,
      { secret: PHRASE, secretKind: 2, source: 'prompt' } as const,
    ]) {
      const kek = await newKeystoreKek('ALKO', secret, FLOOR);
      const blob = await sealOwnerSeed(kek, OWNER_SEED, {
        destination: 'local',
        fileKeystoreMachine: false,
      });
      expect(blob.length).toBe(90);
      expect(decodeUtf8(blob.subarray(0, 4))).toBe('ALKO');
      const seed = await openOwnerSeed(blob, { secret: secret.secret, source: 'prompt' }, OWNER, {
        fileKeystoreMachine: false,
      });
      expect(seed).toEqual(OWNER_SEED);
    }
  });

  it('refuses passphrase wrapping for a blob flagged for relay publication', async () => {
    const kek = await newKeystoreKek(
      'ALKO',
      { secret: PHRASE, secretKind: 2, source: 'prompt' },
      FLOOR,
    );
    await refusedWith(
      () =>
        sealOwnerSeed(kek, OWNER_SEED, {
          destination: 'relay' as 'local',
          fileKeystoreMachine: false,
        }),
      'relay_publication_refused',
    );
    const codeKek = await newKeystoreKek(
      'ALKO',
      { secret: generateSecretCode(), secretKind: 1, source: 'prompt' },
      FLOOR,
    );
    await refusedWith(
      () =>
        sealOwnerSeed(codeKek, OWNER_SEED, {
          destination: 'relay' as 'local',
          fileKeystoreMachine: false,
        }),
      'relay_publication_refused',
    );
  });

  it('refuses a chosen owner passphrase on a file-KeyStore machine, on create and on open', async () => {
    const kek = await newKeystoreKek(
      'ALKO',
      { secret: PHRASE, secretKind: 2, source: 'prompt' },
      FLOOR,
    );
    await refusedWith(
      () => sealOwnerSeed(kek, OWNER_SEED, { destination: 'local', fileKeystoreMachine: true }),
      'secret_kind_refused',
    );
    const blob = await sealOwnerSeed(kek, OWNER_SEED, {
      destination: 'local',
      fileKeystoreMachine: false,
    });
    await refusedWith(
      () => openOwnerSeed(blob, phrase(PHRASE), OWNER, { fileKeystoreMachine: true }),
      'secret_kind_refused',
    );
  });

  it('refuses a seed that does not derive the expected owner', async () => {
    const kek = await newKeystoreKek(
      'ALKO',
      { secret: PHRASE, secretKind: 2, source: 'prompt' },
      FLOOR,
    );
    const blob = await sealOwnerSeed(kek, OWNER_SEED, {
      destination: 'local',
      fileKeystoreMachine: false,
    });
    await refusedWith(
      () => openOwnerSeed(blob, phrase(PHRASE), ownerOf(SEED_1), { fileKeystoreMachine: false }),
      'open_failed',
    );
    await refusedWith(
      () => openOwnerSeed(blob, phrase(OTHER_PHRASE), OWNER, { fileKeystoreMachine: false }),
      'open_failed',
    );
  });

  it('never opens as the other type: label and magic separation in both directions', async () => {
    const secret = { secret: PHRASE, secretKind: 2, source: 'prompt' } as const;
    const alksKek = await newKeystoreKek('ALKS', secret, FLOOR);
    const alkoKek = await newKeystoreKek('ALKO', secret, FLOOR);
    // Same secret, salt and parameters: the HKDF label alone separates the two keks.
    const sameSalt = await deriveKeystoreKek('ALKO', secret, alksKek.salt, FLOOR);
    expect(sameSalt.kek).not.toEqual(alksKek.kek);
    // A kek of one format cannot seal the other.
    await refusedWith(
      () =>
        sealOwnerSeed(alksKek, OWNER_SEED, { destination: 'local', fileKeystoreMachine: false }),
      'invalid_argument',
    );
    await refusedWith(
      () => sealKeystoreFile(alkoKek, AGENT_1, entriesFor(SEED_1)),
      'invalid_argument',
    );

    const blob = await sealOwnerSeed(alkoKek, OWNER_SEED, {
      destination: 'local',
      fileKeystoreMachine: false,
    });
    const file = await sealKeystoreFile(alksKek, AGENT_1, entriesFor(SEED_1));
    await refusedWith(() => openKeystoreFile(blob, phrase(PHRASE), AGENT_1), 'open_failed');
    await refusedWith(
      () => openOwnerSeed(file, phrase(PHRASE), OWNER, { fileKeystoreMachine: false }),
      'open_failed',
    );
    // ALKS magic patched onto an ALKO blob still fails (length and label).
    const patched = blob.slice();
    patched.set(encodeUtf8('ALKS'), 0);
    await refusedWith(
      () => openOwnerSeed(patched, phrase(PHRASE), OWNER, { fileKeystoreMachine: false }),
      'open_failed',
    );
  });

  it('refuses a seed that is not 32 bytes when sealing', async () => {
    const kek = await newKeystoreKek(
      'ALKO',
      { secret: PHRASE, secretKind: 2, source: 'prompt' },
      FLOOR,
    );
    await refusedWith(
      () =>
        sealOwnerSeed(kek, OWNER_SEED.subarray(1), {
          destination: 'local',
          fileKeystoreMachine: false,
        }),
      'invalid_length',
    );
  });
});
