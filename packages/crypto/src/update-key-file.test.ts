// WP-D10: the desktop update key file ALKU v1 (update-key-file.ts).
import { describe, expect, it } from 'vitest';
import { encodeUtf8 } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { newKeystoreKek, sealOwnerSeed } from './keystore-file.js';
import {
  UPDATE_KEY_FILE_HEADER_LENGTH,
  UPDATE_KEY_FILE_LENGTH,
  openUpdateKeyFile,
  readUpdateKeyFileRole,
  sealUpdateKeyFile,
} from './update-key-file.js';

const FAST = { memoryKiB: 19456, iterations: 2, parallelism: 1 };
const PASS = encodeUtf8('correct horse battery staple');
const SECRET = new Uint8Array(32).fill(7);

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (error) {
    if (error instanceof CryptoInputError) return error.code;
    throw error;
  }
};

describe('ALKU v1', () => {
  it('round-trips, with the role in the public header', async () => {
    const file = await sealUpdateKeyFile('root', SECRET, PASS, FAST);
    expect(file.length).toBe(UPDATE_KEY_FILE_LENGTH);
    expect([...file.subarray(0, 4)]).toEqual([0x41, 0x4c, 0x4b, 0x55]); // ALKU
    expect(readUpdateKeyFileRole(file)).toBe('root');
    expect(await openUpdateKeyFile(file, 'root', PASS)).toEqual(SECRET);
  });

  it('refuses the wrong role, a flipped role byte, a wrong passphrase and any tampering', async () => {
    const file = await sealUpdateKeyFile('update', SECRET, PASS, FAST);
    expect(await code(openUpdateKeyFile(file, 'root', PASS))).toBe('open_failed');
    const flipped = file.slice();
    flipped[5] = 1; // claims root: the AAD no longer matches
    expect(await code(openUpdateKeyFile(flipped, 'root', PASS))).toBe('open_failed');
    expect(
      await code(openUpdateKeyFile(file, 'update', encodeUtf8('another long passphrase'))),
    ).toBe('open_failed');
    for (const i of [4, 12, UPDATE_KEY_FILE_HEADER_LENGTH, file.length - 1]) {
      const t = file.slice();
      t[i] = (t[i] as number) ^ 1;
      expect(await code(openUpdateKeyFile(t, 'update', PASS)), String(i)).toBe('open_failed');
    }
    expect(await code(openUpdateKeyFile(file.subarray(1), 'update', PASS))).toBe('open_failed');
  });

  it('never opens an ALKO owner wrap, and needs a 16-character passphrase', async () => {
    const kek = await newKeystoreKek(
      'ALKO',
      { secret: PASS, secretKind: 2, source: 'prompt' },
      FAST,
    );
    const alko = await sealOwnerSeed(kek, SECRET, {
      destination: 'local',
      fileKeystoreMachine: false,
    });
    expect(readUpdateKeyFileRole(alko)).toBeUndefined();
    expect(await code(openUpdateKeyFile(alko, 'root', PASS))).toBe('open_failed');
    expect(await code(sealUpdateKeyFile('root', SECRET, encodeUtf8('too short'), FAST))).toBe(
      'passphrase_too_short',
    );
  });
});
