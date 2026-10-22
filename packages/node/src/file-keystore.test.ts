// M1-8f (04 §2.8, D-54; 07 §9.1, §9.2): the passphrase-locked file KeyStore for headless machines.
// The 04 §2.8 "Required tests" this package owns: selection, unlock sources, environment, canary,
// wrong secret and tamper, agent binding, permissions, the write protocol, the passphrase change and
// agent ≠ owner. Every test runs on a temporary directory with the KDF floor (19 MiB, t = 2) so the
// suite stays fast; the default parameters are checked once.
import { spawn } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KEYSTORE_KDF_DEFAULTS,
  encodeHex,
  encodeUtf8,
  type Argon2idParams,
} from '@4thtech-io/crypto';
import {
  deriveAgentId,
  generateSecretCode,
  newKeystoreKek,
  sealOwnerSeed,
} from '@4thtech-io/crypto/keystore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeKeyStoreError } from './errors.js';
import {
  PASSPHRASE_ENV,
  PASSPHRASE_FILE_ENV,
  changeFileAgentPassphrase,
  createFileAgent,
  defaultKeystoreDir,
  fileKeychain,
  secretOpensAnyAgentFile,
  unlockFileAgent,
  writeAgentFile,
} from './file-keystore.js';
import { readKeystoreFile, writeKeystoreFile } from './file-keystore-fs.js';
import { openRecordedKeyStore } from './keychain-keystore.js';
import { keychainAccount, type KeychainProbe } from './keychain.js';

const FAST: Argon2idParams = Object.freeze({ memoryKiB: 19456, iterations: 2, parallelism: 1 });
const NO_KEYCHAIN: KeychainProbe = Object.freeze({
  ok: false,
  reason: 'unavailable',
  fix: 'Start a Secret Service provider.',
});
const KEYCHAIN_OK: KeychainProbe = Object.freeze({ ok: true });
/** A chosen passphrase that is also the canary of the I-7 test. */
const CANARY = 'canary-passphrase-7f3a9c';
const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const SEED_ID = deriveAgentId(SEED);

const utf8 = (text: string): Uint8Array => encodeUtf8(text);
const codeOf = (error: unknown): unknown => (error as { code?: unknown }).code;

async function rejection(promise: Promise<unknown>): Promise<NodeKeyStoreError> {
  try {
    await promise;
  } catch (error) {
    return error as NodeKeyStoreError;
  }
  throw new Error('expected a rejection');
}

let home: string;
let dir: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agentlink-file-ks-'));
  dir = defaultKeystoreDir(home);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** Creates a file agent with a chosen passphrase, from an interactive terminal with no marker. */
async function createWithPassphrase(passphrase = CANARY): Promise<string> {
  const { agentId, unlockCode } = await createFileAgent({
    probe: NO_KEYCHAIN,
    interactive: true,
    env: {},
    dir,
    kdf: FAST,
    passphrase: utf8(passphrase),
  });
  expect(unlockCode).toBeNull();
  return agentId;
}

/** A prompt that answers `value` (bytes, as the TTY prompt returns them). */
const promptWith = (value: string) => (): Promise<Uint8Array> => Promise.resolve(utf8(value));

describe('selection (04 §2.8 "Selection", 07 §9.1)', () => {
  it('refuses the file KeyStore while the keychain works (no forced file mode)', async () => {
    const error = await rejection(
      createFileAgent({ probe: KEYCHAIN_OK, interactive: true, env: {}, dir, kdf: FAST }),
    );
    expect(codeOf(error)).toBe('keystore_opt_in_refused');
    await expect(stat(dir)).rejects.toThrow();
  });

  it('refuses an opt-in without an interactive terminal and writes nothing', async () => {
    const error = await rejection(
      createFileAgent({ probe: NO_KEYCHAIN, interactive: false, env: {}, dir, kdf: FAST }),
    );
    expect(codeOf(error)).toBe('keystore_opt_in_refused');
    await expect(stat(dir)).rejects.toThrow();
  });

  it.each(['CLAUDECODE', 'CODEX_SANDBOX', 'GEMINI_CLI'])(
    'refuses the opt-in while the harness marker %s is set',
    async (marker) => {
      const error = await rejection(
        createFileAgent({
          probe: NO_KEYCHAIN,
          interactive: true,
          env: { [marker]: '1' },
          dir,
          kdf: FAST,
        }),
      );
      expect(codeOf(error)).toBe('harness_detected');
      await expect(stat(dir)).rejects.toThrow();
    },
  );

  it('creates a generated unlock code by default: 24 base32 characters, shown once', async () => {
    const { agentId, unlockCode } = await createFileAgent({
      probe: NO_KEYCHAIN,
      interactive: true,
      env: {},
      dir,
      kdf: FAST,
    });
    expect(agentId).toMatch(/^0x[0-9a-f]{40}$/);
    expect(unlockCode).toBeInstanceOf(Uint8Array);
    const code = new TextDecoder().decode(unlockCode as Uint8Array);
    expect(code).toMatch(/^[A-Z2-7]{24}$/);
    // The code opens the file in lower case, grouped with dashes and spaces (normalisation).
    const grouped = (code.match(/.{4}/g) as string[]).join('- ').toLowerCase();
    const unlocked = await unlockFileAgent(agentId, { dir, env: {}, prompt: promptWith(grouped) });
    unlocked.close();
  });

  it('uses the 04 §2.8 default KDF parameters for new files', async () => {
    const { agentId } = await createFileAgent({
      probe: NO_KEYCHAIN,
      interactive: true,
      env: {},
      dir,
      passphrase: utf8(CANARY),
    });
    const file = await readFile(join(dir, `${agentId}.alks`));
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    expect(view.getUint32(7, false)).toBe(KEYSTORE_KDF_DEFAULTS.memoryKiB);
    expect(file[11]).toBe(KEYSTORE_KDF_DEFAULTS.iterations);
    expect(file[12]).toBe(KEYSTORE_KDF_DEFAULTS.parallelism);
    expect(file[5]).toBe(2); // secretKind: chosen passphrase
  });

  it('refuses a chosen passphrase under 12 characters', async () => {
    const error = await rejection(
      createFileAgent({
        probe: NO_KEYCHAIN,
        interactive: true,
        env: {},
        dir,
        kdf: FAST,
        passphrase: utf8('short pass'),
      }),
    );
    expect(codeOf(error)).toBe('keystore_passphrase_refused');
  });

  it('never replaces an existing agent file', async () => {
    const kek = await newKeystoreKek(
      'ALKS',
      { secret: utf8(CANARY), secretKind: 2, source: 'prompt' },
      FAST,
    );
    await writeAgentFile(dir, SEED, kek);
    const before = await readFile(join(dir, `${SEED_ID}.alks`));
    const error = await rejection(writeAgentFile(dir, SEED, kek));
    expect(codeOf(error)).toBe('identity_exists');
    expect(await readFile(join(dir, `${SEED_ID}.alks`))).toEqual(before);
  });
});

describe('unlock sources (04 §2.8 "Unlocking the agent key", 07 §9.2)', () => {
  it('reads the passphrase file first and removes both variables from the environment', async () => {
    const agentId = await createWithPassphrase();
    const secretPath = join(home, 'secret');
    await writeFile(secretPath, `${CANARY}\n`, { mode: 0o600 });
    const env: Record<string, string | undefined> = {
      [PASSPHRASE_FILE_ENV]: secretPath,
      [PASSPHRASE_ENV]: 'not-the-passphrase-at-all',
    };
    const unlocked = await unlockFileAgent(agentId, { dir, env });
    expect(env[PASSPHRASE_FILE_ENV]).toBeUndefined();
    expect(env[PASSPHRASE_ENV]).toBeUndefined();
    expect(unlocked.warnings).toEqual([]);
    unlocked.close();
  });

  it('reads the value variable when no file is named, with a warning, and removes it', async () => {
    const agentId = await createWithPassphrase();
    const env: Record<string, string | undefined> = { [PASSPHRASE_ENV]: CANARY };
    const unlocked = await unlockFileAgent(agentId, { dir, env });
    expect(env[PASSPHRASE_ENV]).toBeUndefined();
    expect(unlocked.warnings).toEqual(['passphrase_in_environment']);
    unlocked.close();
  });

  it('does not let a child process started later inherit either variable', async () => {
    const agentId = await createWithPassphrase();
    const secretPath = join(home, 'secret');
    await writeFile(secretPath, CANARY, { mode: 0o600 });
    process.env[PASSPHRASE_FILE_ENV] = secretPath;
    process.env[PASSPHRASE_ENV] = CANARY;
    try {
      const unlocked = await unlockFileAgent(agentId, { dir });
      unlocked.close();
      const child = spawn(
        process.execPath,
        [
          '-e',
          `process.stdout.write(String(process.env.${PASSPHRASE_FILE_ENV} ?? '-') + String(process.env.${PASSPHRASE_ENV} ?? '-'))`,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
      await new Promise((resolve) => child.on('exit', resolve));
      expect(out).toBe('--');
    } finally {
      Reflect.deleteProperty(process.env, PASSPHRASE_FILE_ENV);
      Reflect.deleteProperty(process.env, PASSPHRASE_ENV);
    }
  });

  it('asks the prompt only when neither variable is set', async () => {
    const agentId = await createWithPassphrase();
    const prompt = vi.fn(promptWith(CANARY));
    const unlocked = await unlockFileAgent(agentId, { dir, env: {}, prompt });
    expect(prompt).toHaveBeenCalledTimes(1);
    unlocked.close();
  });

  it('is keystore_locked with no source, and names no detail of the file', async () => {
    const agentId = await createWithPassphrase();
    const error = await rejection(unlockFileAgent(agentId, { dir, env: {} }));
    expect(codeOf(error)).toBe('keystore_locked');
    expect(error.message).not.toContain(agentId);
    expect(error.message).not.toContain(dir);
  });

  it('accepts a passphrase file readable by others, with a warning (container secret mounts)', async () => {
    const agentId = await createWithPassphrase();
    const secretPath = join(home, 'secret');
    await writeFile(secretPath, CANARY);
    await chmod(secretPath, 0o444);
    const unlocked = await unlockFileAgent(agentId, {
      dir,
      env: { [PASSPHRASE_FILE_ENV]: secretPath },
    });
    expect(unlocked.warnings).toEqual(['passphrase_file_readable']);
    unlocked.close();
  });

  it('follows a symlinked passphrase path to its real file (secret mounts), then opens it', async () => {
    const agentId = await createWithPassphrase();
    const real = join(home, 'real-secret');
    await writeFile(real, CANARY, { mode: 0o600 });
    const link = join(home, 'secret-link');
    await symlink(real, link);
    const unlocked = await unlockFileAgent(agentId, {
      dir,
      env: { [PASSPHRASE_FILE_ENV]: link },
    });
    unlocked.close();
  });

  it.each([
    [
      'writable by group',
      async (p: string) => {
        await writeFile(p, CANARY);
        await chmod(p, 0o620);
      },
    ],
    [
      'writable by others',
      async (p: string) => {
        await writeFile(p, CANARY);
        await chmod(p, 0o602);
      },
    ],
    [
      'larger than 1 KiB',
      async (p: string) => {
        await writeFile(p, 'x'.repeat(1025), { mode: 0o600 });
      },
    ],
    [
      'a directory',
      async (p: string) => {
        await mkdir(p, { mode: 0o700 });
      },
    ],
  ])('refuses a passphrase file that is %s', async (_name, make) => {
    const agentId = await createWithPassphrase();
    const secretPath = join(home, 'secret');
    await make(secretPath);
    const env: Record<string, string | undefined> = { [PASSPHRASE_FILE_ENV]: secretPath };
    const error = await rejection(unlockFileAgent(agentId, { dir, env }));
    expect(codeOf(error)).toBe('keystore_file_unsafe');
    expect(env[PASSPHRASE_FILE_ENV]).toBeUndefined();
  });
});

describe('wrong secret, tamper and agent binding (04 §2.8)', () => {
  it('gives one generic error for a wrong passphrase and for a tampered file', async () => {
    const agentId = await createWithPassphrase();
    const wrong = await rejection(
      unlockFileAgent(agentId, { dir, env: {}, prompt: promptWith('the wrong passphrase!') }),
    );
    const path = join(dir, `${agentId}.alks`);
    const file = await readFile(path);
    file[file.length - 1] = (file[file.length - 1] as number) ^ 1;
    await writeFile(path, file);
    const tampered = await rejection(
      unlockFileAgent(agentId, { dir, env: {}, prompt: promptWith(CANARY) }),
    );
    expect(codeOf(wrong)).toBe('keystore_open_failed');
    expect(codeOf(tampered)).toBe('keystore_open_failed');
    expect(wrong.message).toBe(tampered.message);
  });

  it('refuses a swapped file of another agent with the same passphrase', async () => {
    const a = await createWithPassphrase();
    const b = await createWithPassphrase();
    await copyFile(join(dir, `${a}.alks`), join(dir, `${b}.alks`));
    await chmod(join(dir, `${b}.alks`), 0o600);
    const error = await rejection(unlockFileAgent(b, { dir, env: {}, prompt: promptWith(CANARY) }));
    expect(codeOf(error)).toBe('keystore_open_failed');
  });

  it.each([
    `0x${'AB'.repeat(20)}`,
    `${'ab'.repeat(20)}`,
    `0x${'ab'.repeat(19)}`,
    '../../etc/passwd',
    '',
  ])('refuses the agent ID %j before any path is built', async (agentId) => {
    const error = await rejection(
      unlockFileAgent(agentId, { dir, env: {}, prompt: promptWith(CANARY) }),
    );
    expect(codeOf(error)).toBe('agent_id_invalid');
  });

  it('is identity_missing for a missing file, never a new identity', async () => {
    await createWithPassphrase();
    const missing = `0x${'cd'.repeat(20)}`;
    const error = await rejection(
      unlockFileAgent(missing, { dir, env: {}, prompt: promptWith(CANARY) }),
    );
    expect(codeOf(error)).toBe('identity_missing');
    expect(await readdir(dir)).not.toContain(`${missing}.alks`);
  });
});

describe('file permissions (04 §2.8 "File handling")', () => {
  it.each([0o000, 0o077])('creates 0700 / 0600 whatever the umask (%o)', async (mask) => {
    const previous = process.umask(mask);
    let agentId: string;
    try {
      agentId = await createWithPassphrase();
    } finally {
      process.umask(previous);
    }
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, `${agentId}.alks`))).mode & 0o777).toBe(0o600);
  });

  it.each([0o640, 0o604, 0o660])('refuses a keystore file with mode %o', async (mode) => {
    const agentId = await createWithPassphrase();
    await chmod(join(dir, `${agentId}.alks`), mode);
    const error = await rejection(
      unlockFileAgent(agentId, { dir, env: {}, prompt: promptWith(CANARY) }),
    );
    expect(codeOf(error)).toBe('keystore_file_unsafe');
  });

  it('refuses a keystore directory with group or other bits', async () => {
    const agentId = await createWithPassphrase();
    await chmod(dir, 0o750);
    const error = await rejection(
      unlockFileAgent(agentId, { dir, env: {}, prompt: promptWith(CANARY) }),
    );
    expect(codeOf(error)).toBe('keystore_file_unsafe');
  });

  it('refuses a symlinked keystore file', async () => {
    const agentId = await createWithPassphrase();
    const path = join(dir, `${agentId}.alks`);
    const elsewhere = join(home, 'elsewhere.alks');
    await copyFile(path, elsewhere);
    await chmod(elsewhere, 0o600);
    await rm(path);
    await symlink(elsewhere, path);
    const error = await rejection(
      unlockFileAgent(agentId, { dir, env: {}, prompt: promptWith(CANARY) }),
    );
    expect(codeOf(error)).toBe('keystore_file_unsafe');
  });

  it('refuses a hard-linked keystore file (a second name outside the directory)', async () => {
    const agentId = await createWithPassphrase();
    const { link } = await import('node:fs/promises');
    await link(join(dir, `${agentId}.alks`), join(home, 'second-name.alks'));
    const error = await rejection(
      unlockFileAgent(agentId, { dir, env: {}, prompt: promptWith(CANARY) }),
    );
    expect(codeOf(error)).toBe('keystore_file_unsafe');
  });

  it('refuses a symlinked keystore directory', async () => {
    const agentId = await createWithPassphrase();
    const moved = join(home, 'moved-keystore');
    const { rename } = await import('node:fs/promises');
    await rename(dir, moved);
    await symlink(moved, dir);
    const error = await rejection(
      unlockFileAgent(agentId, { dir, env: {}, prompt: promptWith(CANARY) }),
    );
    expect(codeOf(error)).toBe('keystore_file_unsafe');
  });

  it('accepts a symlinked home directory that still resolves inside', async () => {
    const agentId = await createWithPassphrase();
    const linkedHome = join(
      tmpdir(),
      `agentlink-home-link-${encodeHex(SEED.subarray(0, 4))}-${process.pid}`,
    );
    await symlink(home, linkedHome);
    try {
      const unlocked = await unlockFileAgent(agentId, {
        dir: defaultKeystoreDir(linkedHome),
        env: {},
        prompt: promptWith(CANARY),
      });
      unlocked.close();
    } finally {
      await rm(linkedHome, { force: true });
    }
  });

  it('refuses a file owned by another user (fstat on the descriptor)', async () => {
    const agentId = await createWithPassphrase();
    const error = await rejection(
      readKeystoreFile(dir, `${agentId}.alks`, { uid: (process.getuid?.() ?? 0) + 1 }),
    );
    expect(codeOf(error)).toBe('keystore_file_unsafe');
  });

  it('refuses to write where the mode does not stick (DrvFs, 9p, SMB, FUSE)', async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const error = await rejection(
      writeKeystoreFile(dir, 'probe.alks', Uint8Array.of(1, 2, 3), {
        chmod: () => Promise.resolve(),
        mode: () => 0o777,
      }),
    );
    expect(codeOf(error)).toBe('keystore_file_unsafe');
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('the write protocol (04 §2.8 "Writes")', () => {
  async function unlockedStore(agentId: string, passphrase = CANARY) {
    return unlockFileAgent(agentId, { dir, env: {}, prompt: promptWith(passphrase) });
  }

  it('adds, reads and removes an item; the seed is never replaced', async () => {
    const agentId = await createWithPassphrase();
    const unlocked = await unlockedStore(agentId);
    const keychain = fileKeychain(unlocked);
    const account = keychainAccount(agentId, 'policy-version');
    expect(await keychain.get(account)).toBeNull();
    await keychain.set(account, utf8('7'));
    expect(await keychain.get(account)).toEqual(utf8('7'));
    expect(await keychain.delete(account)).toBe(true);
    expect(await keychain.delete(account)).toBe(false);
    const seedError = await rejection(keychain.set(keychainAccount(agentId, 'seed'), SEED));
    expect(codeOf(seedError)).toBe('keystore_failed');
    const other = await rejection(keychain.get(keychainAccount(`0x${'ef'.repeat(20)}`, 'seed')));
    expect(codeOf(other)).toBe('keystore_failed');
    unlocked.close();
  });

  it('after a passphrase change elsewhere, the running server fails closed and loses no item', async () => {
    const agentId = await createWithPassphrase();
    const server = await unlockedStore(agentId);
    const keychain = fileKeychain(server);
    await keychain.set(keychainAccount(agentId, 'policy-version'), utf8('3'));
    const next = 'a brand new passphrase';
    await changeFileAgentPassphrase(agentId, {
      dir,
      kdf: FAST,
      prompt: promptWith(CANARY),
      passphrase: utf8(next),
    });
    const write = await rejection(
      keychain.set(keychainAccount(agentId, 'receipts-kept'), utf8('1')),
    );
    expect(codeOf(write)).toBe('keystore_locked');
    // Stays locked until restarted, reads included.
    const read = await rejection(keychain.get(keychainAccount(agentId, 'policy-version')));
    expect(codeOf(read)).toBe('keystore_locked');
    server.close();
    const reopened = await unlockedStore(agentId, next);
    expect(await fileKeychain(reopened).get(keychainAccount(agentId, 'policy-version'))).toEqual(
      utf8('3'),
    );
    expect(await fileKeychain(reopened).get(keychainAccount(agentId, 'receipts-kept'))).toBeNull();
    reopened.close();
    const old = await rejection(unlockedStore(agentId, CANARY));
    expect(codeOf(old)).toBe('keystore_open_failed');
  });

  it('asks for the current passphrase at the prompt only; a wrong one changes nothing', async () => {
    const agentId = await createWithPassphrase();
    const before = await readFile(join(dir, `${agentId}.alks`));
    const error = await rejection(
      changeFileAgentPassphrase(agentId, {
        dir,
        kdf: FAST,
        prompt: promptWith('not the current one'),
        passphrase: utf8('a brand new passphrase'),
      }),
    );
    expect(codeOf(error)).toBe('keystore_open_failed');
    expect(await readFile(join(dir, `${agentId}.alks`))).toEqual(before);
  });

  it('changes to a new generated code with a fresh salt', async () => {
    const agentId = await createWithPassphrase();
    const before = await readFile(join(dir, `${agentId}.alks`));
    const { unlockCode } = await changeFileAgentPassphrase(agentId, {
      dir,
      kdf: FAST,
      prompt: promptWith(CANARY),
    });
    const after = await readFile(join(dir, `${agentId}.alks`));
    expect(after[5]).toBe(1);
    expect(encodeHex(after.subarray(13, 29))).not.toBe(encodeHex(before.subarray(13, 29)));
    const code = new TextDecoder().decode(unlockCode as Uint8Array);
    (await unlockedStore(agentId, code)).close();
  });

  it('concurrent writers under the lock lose no update', async () => {
    const agentId = await createWithPassphrase();
    const a = await unlockedStore(agentId);
    const b = await unlockedStore(agentId);
    const names = Array.from({ length: 6 }, (_, i) => `s3:item-${i}`);
    await Promise.all(
      names.map((name, i) =>
        fileKeychain(i % 2 === 0 ? a : b).set(`${agentId}:${name}`, utf8(`v${i}`)),
      ),
    );
    for (const [i, name] of names.entries()) {
      expect(await fileKeychain(a).get(`${agentId}:${name}`)).toEqual(utf8(`v${i}`));
    }
    a.close();
    b.close();
  });

  it('a crash between write and rename leaves the old file valid', async () => {
    const agentId = await createWithPassphrase();
    const name = `${agentId}.alks`;
    const before = await readFile(join(dir, name));
    const error = await rejection(
      writeKeystoreFile(dir, name, Uint8Array.of(9, 9, 9), {
        beforeRename: () => {
          throw new Error('simulated crash');
        },
      }),
    );
    expect(error).toBeInstanceOf(Error);
    expect(await readFile(join(dir, name))).toEqual(before);
    (await unlockedStore(agentId)).close();
  });

  it('removes stale temporary files at start-up', async () => {
    const agentId = await createWithPassphrase();
    const stale = join(dir, `.${agentId}.alks.tmp-0123456789abcdef`);
    await writeFile(stale, 'partial', { mode: 0o600 });
    (await unlockedStore(agentId)).close();
    expect(await readdir(dir)).not.toContain(`.${agentId}.alks.tmp-0123456789abcdef`);
  });

  it('refuses every operation after close', async () => {
    const agentId = await createWithPassphrase();
    const unlocked = await unlockedStore(agentId);
    unlocked.close();
    const error = await rejection(fileKeychain(unlocked).get(keychainAccount(agentId, 'seed')));
    expect(codeOf(error)).toBe('keystore_locked');
  });
});

describe('agent ≠ owner (04 §2.8 "Passphrase strength")', () => {
  async function plantOwner(): Promise<string> {
    const code = new TextDecoder().decode(generateSecretCode());
    const kek = await newKeystoreKek(
      'ALKO',
      { secret: utf8(code), secretKind: 1, source: 'prompt' },
      FAST,
    );
    const blob = await sealOwnerSeed(kek, new Uint8Array(32).fill(5), {
      destination: 'local',
      fileKeystoreMachine: true,
    });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    await writeKeystoreFile(dir, 'owner.alko', blob);
    return code;
  }

  it('refuses an agent passphrase that unlocks owner.alko, in any spelling', async () => {
    const ownerCode = await plantOwner();
    const spelled = (ownerCode.match(/.{4}/g) as string[]).join(' ').toLowerCase();
    const error = await rejection(createWithPassphrase(spelled));
    expect(codeOf(error)).toBe('keystore_passphrase_refused');
  });

  it('refuses a passphrase change to the owner code', async () => {
    const agentId = await createWithPassphrase();
    const ownerCode = await plantOwner();
    const error = await rejection(
      changeFileAgentPassphrase(agentId, {
        dir,
        kdf: FAST,
        prompt: promptWith(CANARY),
        passphrase: utf8(ownerCode),
      }),
    );
    expect(codeOf(error)).toBe('keystore_passphrase_refused');
  });

  it('tells the owner side whether a candidate opens any agent file on the machine', async () => {
    await createWithPassphrase('first agent passphrase');
    await createWithPassphrase(CANARY);
    expect(await secretOpensAnyAgentFile(dir, utf8(CANARY))).toBe(true);
    expect(await secretOpensAnyAgentFile(dir, utf8('none of the agents use this'))).toBe(false);
  });
});

describe('canary (I-7)', () => {
  it('never puts the passphrase, the seed or the store key in a log, error or other file', async () => {
    const logs: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      }),
    );
    const errors: string[] = [];
    const record = async (promise: Promise<unknown>): Promise<void> => {
      try {
        await promise;
      } catch (error) {
        errors.push(String((error as Error).message), String((error as Error).stack));
      }
    };
    try {
      const kek = await newKeystoreKek(
        'ALKS',
        { secret: utf8(CANARY), secretKind: 2, source: 'prompt' },
        FAST,
      );
      await writeAgentFile(dir, SEED, kek);
      await record(
        unlockFileAgent(SEED_ID, { dir, env: {}, prompt: promptWith('wrong passphrase!!') }),
      );
      await record(unlockFileAgent(SEED_ID, { dir, env: { [PASSPHRASE_ENV]: `${CANARY}x` } }));
      const unlocked = await unlockFileAgent(SEED_ID, { dir, env: { [PASSPHRASE_ENV]: CANARY } });
      const store = await openRecordedKeyStore('keychain', SEED_ID, {
        keychain: fileKeychain(unlocked),
      });
      await store.getPublicBundle();
      await record(store.getPublicBundle({ epoch: 5 }));
      await record(fileKeychain(unlocked).set(keychainAccount(SEED_ID, 'seed'), SEED));
      await store.close();
      unlocked.close();
      await record(fileKeychain(unlocked).get(keychainAccount(SEED_ID, 'store-key')));
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const seedHex = encodeHex(SEED);
    for (const text of [...logs, ...errors]) {
      expect(text).not.toContain(CANARY);
      expect(text).not.toContain(seedHex);
    }
    expect(errors.length).toBeGreaterThan(0);
    // The only files are the ciphertext and the lock; none holds a plaintext canary.
    for (const name of await readdir(dir)) {
      expect(name).toMatch(/^0x[0-9a-f]{40}\.(alks|lock)$/);
      const bytes = await readFile(join(dir, name));
      expect(bytes.includes(Buffer.from(CANARY))).toBe(false);
      expect(bytes.includes(Buffer.from(SEED))).toBe(false);
    }
  });
});
