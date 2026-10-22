// M1-8f: the passphrase-locked file KeyStore for headless machines (04 §2.8, D-54; 07 §9.1, §9.2).
// Opt-in only: chosen at `init` when the keychain probe failed, from an interactive terminal with no
// AI-app marker set (UX guards, not boundaries), and recorded per agent. The agent's keychain items
// live as entries of one `ALKS` v1 file, `~/.agentlink/keystore/<agentId>.alks`.
//
// The unlock secret comes from the passphrase file, the environment variable or a CLI prompt (in that
// order), never from an argument. Only the derived `kek` (with its salt and parameters) stays in
// memory; each operation re-reads the file, decrypts the entries, uses one and wipes them all. The
// file backend is a `KeychainBackend` over those entries, so the agent KeyStore, the policy-version
// mark (M1-8g) and the receipts-kept marker (M1-33a) are the keychain code unchanged. Every write
// runs the 04 §2.8 write protocol under the agent's inter-process lock; a header that no longer
// matches the in-memory kek (a passphrase change elsewhere) locks this process until it restarts.
//
// All crypto runs through @4thtech-io/crypto (`ALKS`/`ALKO` seal and open, M1-1f); this module only
// handles files, locking and unlock sources. Nothing secret is logged or put in an error (I-7).
import { homedir } from 'node:os';
import { isatty } from 'node:tty';
import { join } from 'node:path';
import {
  CryptoInputError,
  KEYSTORE_KDF_DEFAULTS,
  MASTER_SEED_LENGTH,
  randomBytes,
  wipe,
  type Argon2idParams,
} from '@4thtech-io/crypto';
import {
  deriveAgentId,
  generateSecretCode,
  keystoreSecretUnlocks,
  newKeystoreKek,
  openKeystoreFile,
  openKeystoreFileWithKek,
  openOwnerSeedWithoutCard,
  sealKeystoreFile,
} from '@4thtech-io/crypto/keystore';
import { NodeKeyStoreError } from './errors.js';
import {
  ensureKeystoreDir,
  keystoreFailed,
  listAgentFiles,
  readKeystoreFile,
  readPassphraseFile,
  removeStaleTemps,
  writeKeystoreFile,
  type KeystoreFsOptions,
} from './file-keystore-fs.js';
import { withInterProcessLock } from './inter-process-lock.js';
import {
  assertAgentId,
  selectKeyStoreBackend,
  type KeychainBackend,
  type KeychainProbe,
} from './keychain.js';
import { HARNESS_MARKERS } from './owner-terminal.js';

type KeystoreKek = Awaited<ReturnType<typeof newKeystoreKek>>;
type KeystoreEntry = Awaited<ReturnType<typeof openKeystoreFile>>['entries'][number];
type Env = Record<string, string | undefined>;

/** 07 §9.2 source 1: a path to the passphrase file. `init` writes only this variable. */
export const PASSPHRASE_FILE_ENV = 'AGENTLINK_KEYSTORE_PASSPHRASE_FILE';
/** 07 §9.2 source 2: the passphrase itself (weaker; `doctor` warns). Never written by `init`. */
export const PASSPHRASE_ENV = 'AGENTLINK_KEYSTORE_PASSPHRASE';
/** The owner wrap on a file-KeyStore machine (04 §2.8 "Where it lives"). */
export const OWNER_FILE = 'owner.alko';

/** What `doctor` reports about the unlock source (07 §9.4). Never the secret. */
export type FileKeyStoreWarning = 'passphrase_in_environment' | 'passphrase_file_readable';

/** `~/.agentlink/keystore` under `home` (default: the user's home directory). */
export function defaultKeystoreDir(home: string = homedir()): string {
  return join(home, '.agentlink', 'keystore');
}

const agentFile = (agentId: string): string => `${agentId}.alks`;
const lockFile = (dir: string, agentId: string): string => join(dir, `${agentId}.lock`);

// --- Errors: fixed sentences that say how to fix the problem (I-7). ---

const keystoreLocked = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'keystore_locked',
    "The agent's key file is locked. Give AgentLink its unlock code through AGENTLINK_KEYSTORE_PASSPHRASE_FILE, then restart; `agentlink doctor` shows how.",
  );

const openFailed = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'keystore_open_failed',
    "The agent's key file did not open: the unlock code is wrong, or the file is damaged or belongs to another agent. Check the code; `agentlink doctor` shows what is wrong.",
  );

const fileMissing = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'identity_missing',
    "This agent's key file is missing. Restore it from a backup or check the agent name; AgentLink never creates a new identity in its place.",
  );

const fileExists = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'identity_exists',
    'An agent with this identity already has a key file. AgentLink never replaces it.',
  );

const passphraseRefused = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'keystore_passphrase_refused',
    'That passphrase cannot be used. Choose one of at least 12 characters that is not your owner code, or use the generated unlock code.',
  );

const keychainAvailable = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'keystore_opt_in_refused',
    'This machine has a system keychain. AgentLink uses it, so no key file is needed.',
  );

const needsTerminal = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'keystore_opt_in_refused',
    'A key file is set up only in an interactive terminal. Run `agentlink init --keystore file` yourself, in a terminal window you opened.',
  );

const harnessDetected = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'harness_detected',
    'This looks like a terminal your AI app controls. Run `agentlink init --keystore file` yourself, in a terminal window you opened, so your AI never sees the unlock code.',
  );

/** The inter-process lock's own errors (NodeStoreError) become `keystore_failed` here. */
async function withAgentLock<T>(dir: string, agentId: string, fn: () => Promise<T>): Promise<T> {
  let failure: unknown;
  let failed = false;
  try {
    return await withInterProcessLock(lockFile(dir, agentId), async () => {
      try {
        return await fn();
      } catch (error) {
        failed = true;
        failure = error;
        throw error;
      }
    });
  } catch (error) {
    if (failed) throw failure;
    if (error instanceof NodeKeyStoreError) throw error;
    throw keystoreFailed();
  }
}

/** Throws `harness_detected` while any AI-app marker is set (04 §2.8, UX guard). */
function assertNoMarker(env: Env): void {
  for (const name of HARNESS_MARKERS) {
    const value = env[name];
    if (value !== undefined && value !== '') throw harnessDetected();
  }
}

/** A new kek for `ALKS`; a refused secret (too short, invalid) is `keystore_passphrase_refused`. */
async function newKek(
  secret: Uint8Array,
  secretKind: 1 | 2,
  kdf: Argon2idParams,
): Promise<KeystoreKek> {
  try {
    return await newKeystoreKek('ALKS', { secret, secretKind, source: 'prompt' }, kdf);
  } catch (error) {
    if (error instanceof CryptoInputError) throw passphraseRefused();
    throw error;
  }
}

/**
 * 04 §2.8 "Agent and owner secrets always differ": refuses an agent secret that unlocks the owner
 * wrap on this machine (`owner.alko`), normalised the way the owner wrap normalises it. A candidate
 * the owner wrap refuses counts as "does not unlock". A seed the check unwraps is wiped at once.
 */
async function assertNotOwnerSecret(
  dir: string,
  candidate: Uint8Array,
  fs: KeystoreFsOptions,
): Promise<void> {
  const blob = await readKeystoreFile(dir, OWNER_FILE, fs);
  if (blob === null) return;
  let unlocks = false;
  try {
    const seed = await openOwnerSeedWithoutCard(
      blob,
      { secret: candidate, source: 'prompt' },
      { fileKeystoreMachine: false },
    );
    wipe(seed);
    unlocks = true;
  } catch (error) {
    if (!(error instanceof CryptoInputError)) throw error;
  } finally {
    wipe(blob);
  }
  if (unlocks) throw passphraseRefused();
}

/**
 * 04 §2.8, the owner side of agent ≠ owner: does `candidate` open any agent file in `dir`? For the
 * owner steps on a file-KeyStore machine (`owner init`, `owner change-code`). Unwrapped entries and
 * keks are wiped at once.
 */
export async function secretOpensAnyAgentFile(
  dir: string,
  candidate: Uint8Array,
  fs: KeystoreFsOptions = {},
): Promise<boolean> {
  for (const agentId of await listAgentFiles(dir, fs)) {
    const file = await readKeystoreFile(dir, agentFile(agentId), fs);
    if (file === null) continue;
    try {
      if (await keystoreSecretUnlocks(file, { secret: candidate, source: 'prompt' }, agentId)) {
        return true;
      }
    } finally {
      wipe(file);
    }
  }
  return false;
}

/**
 * Writes a new agent file for `seed` (with a fresh random store key) under `kek` and returns the
 * agent ID. Never replaces an existing file (`identity_exists`). Creation and test seam: the caller
 * owns `seed` and `kek`.
 */
export async function writeAgentFile(
  dir: string,
  seed: Uint8Array,
  kek: KeystoreKek,
  fs: KeystoreFsOptions = {},
): Promise<string> {
  const agentId = deriveAgentId(seed);
  await ensureKeystoreDir(dir, fs);
  const storeKey = randomBytes(32);
  try {
    return await withAgentLock(dir, agentId, async () => {
      const existing = await readKeystoreFile(dir, agentFile(agentId), fs);
      if (existing !== null) {
        wipe(existing);
        throw fileExists();
      }
      const sealed = await sealKeystoreFile(kek, agentId, [
        { name: 'seed', value: seed },
        { name: 'store-key', value: storeKey },
      ]);
      await writeKeystoreFile(dir, agentFile(agentId), sealed, fs);
      return agentId;
    });
  } finally {
    wipe(storeKey);
  }
}

export interface CreateFileAgentOptions {
  /** The keychain probe at `init`. A working keychain refuses the file KeyStore (no forced mode). */
  readonly probe: KeychainProbe;
  /** True only when `init` runs in an interactive terminal (stdin and stdout are TTYs). */
  readonly interactive: boolean;
  /** The environment checked for AI-app markers. Default `process.env`. */
  readonly env?: Env;
  /**
   * A chosen passphrase typed at the prompt (kind 2, at least 12 characters). Omitted: a generated
   * unlock code (kind 1), the default. The caller wipes it.
   */
  readonly passphrase?: Uint8Array;
  /**
   * For a generated code: shows the code and has the user re-type its last group; false writes
   * nothing (04 §2.8). The CLI always passes it.
   */
  readonly confirmCode?: (code: Uint8Array) => Promise<boolean>;
  /** Test seams. */
  readonly dir?: string;
  readonly kdf?: Argon2idParams;
  readonly fs?: KeystoreFsOptions;
}

/**
 * `agentlink init --keystore file` (04 §2.8 "Selection" 3; 07 §9.1): creates a new agent in a
 * passphrase-locked file and returns its agent ID, for the caller to record with the backend `file`,
 * and the generated unlock code (null for a chosen passphrase) to show once; the caller wipes it.
 * Refused while the keychain works, without an interactive terminal, or with an AI-app marker set,
 * before anything is written. No owner key is created here (04 §2.8: `owner init` is separate).
 */
export async function createFileAgent(
  options: CreateFileAgentOptions,
): Promise<{ readonly agentId: string; readonly unlockCode: Uint8Array | null }> {
  if (!selectKeyStoreBackend(options.probe, { fileOptIn: true }).ok) throw keychainAvailable();
  if (options.interactive !== true) throw needsTerminal();
  assertNoMarker(options.env ?? process.env);
  const dir = options.dir ?? defaultKeystoreDir();
  const fs = options.fs ?? {};
  const chosen = options.passphrase !== undefined;
  const secret = chosen ? Uint8Array.from(options.passphrase as Uint8Array) : generateSecretCode();
  let kek: KeystoreKek | undefined;
  const seed = randomBytes(MASTER_SEED_LENGTH);
  let returned = false;
  try {
    await assertNotOwnerSecret(dir, secret, fs);
    kek = await newKek(secret, chosen ? 2 : 1, options.kdf ?? KEYSTORE_KDF_DEFAULTS);
    if (!chosen && options.confirmCode !== undefined && !(await options.confirmCode(secret))) {
      throw new NodeKeyStoreError(
        'keystore_passphrase_refused',
        'The unlock code was not confirmed, so nothing was set up. Run the command again.',
      );
    }
    const agentId = await writeAgentFile(dir, seed, kek, fs);
    returned = !chosen;
    return Object.freeze({ agentId, unlockCode: chosen ? null : secret });
  } finally {
    wipe(seed);
    if (kek !== undefined) wipe(kek.kek);
    if (!returned) wipe(secret);
  }
}

// --- Unlocking (07 §9.2) ---

/** An unlocked file agent: an opaque handle. The kek stays in this module. */
export interface UnlockedFileAgent {
  readonly agentId: string;
  /** What `doctor` should warn about the unlock source (07 §9.4). */
  readonly warnings: readonly FileKeyStoreWarning[];
  /** Wipes the kek; every later operation is `keystore_locked`. */
  close(): void;
}

interface UnlockedState {
  readonly dir: string;
  readonly agentId: string;
  readonly fs: KeystoreFsOptions;
  kek: KeystoreKek | null;
  /** The file's header no longer matches the kek: locked until restarted (04 §2.8 "Writes"). */
  stale: boolean;
}

const unlockedStates = new WeakMap<UnlockedFileAgent, UnlockedState>();

export interface UnlockFileAgentOptions {
  /** The environment the two variables are read from and removed from. Default `process.env`. */
  readonly env?: Env;
  /** 07 §9.2 source 3: the CLI prompt (no echo, bytes). The MCP server has none. */
  readonly prompt?: (label: string) => Promise<Uint8Array>;
  /** Test seams. */
  readonly dir?: string;
  readonly fs?: KeystoreFsOptions;
}

/**
 * 07 §9.2: the unlock secret from the passphrase file, the environment variable or the prompt, in
 * that order. Both variables are removed from `env` whichever source is used (04 §2.8). Returns
 * null when there is no source. The caller wipes the secret.
 */
async function readUnlockSecret(
  env: Env,
  prompt: UnlockFileAgentOptions['prompt'],
): Promise<{
  readonly secret: Uint8Array;
  readonly source: 'file' | 'prompt';
  readonly warnings: FileKeyStoreWarning[];
} | null> {
  const path = env[PASSPHRASE_FILE_ENV];
  const value = env[PASSPHRASE_ENV];
  Reflect.deleteProperty(env, PASSPHRASE_FILE_ENV);
  Reflect.deleteProperty(env, PASSPHRASE_ENV);
  if (path !== undefined && path !== '') {
    const { secret, readableByOthers } = await readPassphraseFile(path);
    return {
      secret,
      source: 'file',
      warnings: readableByOthers ? ['passphrase_file_readable'] : [],
    };
  }
  if (value !== undefined && value !== '') {
    // Environment input loses nothing, as prompt input (04 §2.8 `password`). The JS string itself
    // cannot be wiped (04 §2.8 residual).
    return {
      secret: new TextEncoder().encode(value),
      source: 'prompt',
      warnings: ['passphrase_in_environment'],
    };
  }
  if (prompt !== undefined) {
    const typed = await prompt('Unlock code or passphrase for this agent');
    if (!(typed instanceof Uint8Array)) throw keystoreLocked();
    return { secret: typed, source: 'prompt', warnings: [] };
  }
  return null;
}

/**
 * Unlocks the file agent `agentId` (07 §9.2): reads the secret, checks the file (04 §2.8 "Checks on
 * every open"), removes stale temporary files under the lock, derives the kek and authenticates the
 * file, whose `seed` must derive `agentId`. A wrong secret and a damaged or foreign file are the same
 * `keystore_open_failed`; no source is `keystore_locked`; a missing file is `identity_missing`.
 * Asynchronous: the MCP server answers `initialize` before it finishes (04 §2.8 target).
 */
export async function unlockFileAgent(
  agentId: string,
  options: UnlockFileAgentOptions = {},
): Promise<UnlockedFileAgent> {
  assertAgentId(agentId);
  const dir = options.dir ?? defaultKeystoreDir();
  const fs = options.fs ?? {};
  const read = await readUnlockSecret(options.env ?? process.env, options.prompt);
  if (read === null) throw keystoreLocked();
  try {
    const file = await readKeystoreFile(dir, agentFile(agentId), fs);
    if (file === null) throw fileMissing();
    let opened: Awaited<ReturnType<typeof openKeystoreFile>>;
    try {
      await withAgentLock(dir, agentId, () => removeStaleTemps(dir, agentFile(agentId), fs));
      opened = await openKeystoreFile(file, { secret: read.secret, source: read.source }, agentId);
    } catch (error) {
      if (error instanceof CryptoInputError) throw openFailed();
      throw error;
    } finally {
      wipe(file);
    }
    wipe(...opened.entries.map((entry) => entry.value));
    const state: UnlockedState = { dir, agentId, fs, kek: opened.kek, stale: false };
    const handle: UnlockedFileAgent = Object.freeze({
      agentId,
      warnings: Object.freeze([...read.warnings]),
      close: (): void => {
        if (state.kek !== null) wipe(state.kek.kek);
        state.kek = null;
      },
    });
    unlockedStates.set(handle, state);
    return handle;
  } finally {
    wipe(read.secret);
  }
}

/** The file's entries under the in-memory kek. A changed header locks this process (04 §2.8). */
async function readEntries(state: UnlockedState): Promise<readonly KeystoreEntry[]> {
  const kek = state.kek;
  if (kek === null || state.stale) throw keystoreLocked();
  const file = await readKeystoreFile(state.dir, agentFile(state.agentId), state.fs);
  if (file === null) throw fileMissing();
  try {
    return await openKeystoreFileWithKek(file, kek, state.agentId);
  } catch (error) {
    if (!(error instanceof CryptoInputError)) throw error;
    state.stale = true;
    if (state.kek !== null) wipe(state.kek.kek);
    state.kek = null;
    throw keystoreLocked();
  } finally {
    wipe(file);
  }
}

/** 04 §2.8 write protocol: lock, re-read, header check, decrypt, change, write with a fresh nonce. */
async function writeEntries<T>(
  state: UnlockedState,
  change: (entries: readonly KeystoreEntry[]) => { entries: KeystoreEntry[]; result: T } | null,
  noChange: T,
): Promise<T> {
  return withAgentLock(state.dir, state.agentId, async () => {
    const entries = await readEntries(state);
    try {
      const next = change(entries);
      if (next === null) return noChange;
      const kek = state.kek;
      if (kek === null) throw keystoreLocked();
      const sealed = await sealKeystoreFile(kek, state.agentId, next.entries);
      await writeKeystoreFile(state.dir, agentFile(state.agentId), sealed, state.fs);
      return next.result;
    } finally {
      wipe(...entries.map((entry) => entry.value));
    }
  });
}

/**
 * The file agent's entries as a KeychainBackend (internal, like osKeychain: it returns raw item
 * bytes). Accounts are this agent's keychain accounts (`<agentId>` for the seed, `<agentId>:<name>`
 * for the rest, 04 §2.2); the entry names are the account suffixes (04 §2.8). The seed is never
 * replaced or removed, and another agent's account is refused.
 */
export function fileKeychain(unlocked: UnlockedFileAgent): KeychainBackend {
  const state = unlockedStates.get(unlocked);
  if (state === undefined) throw keystoreLocked();
  const entryName = (account: string): string => {
    if (account === state.agentId) return 'seed';
    const prefix = `${state.agentId}:`;
    if (
      typeof account === 'string' &&
      account.startsWith(prefix) &&
      account.length > prefix.length
    ) {
      return account.slice(prefix.length);
    }
    throw keystoreFailed();
  };
  const writable = (account: string): string => {
    const name = entryName(account);
    if (name === 'seed') throw keystoreFailed();
    return name;
  };
  return Object.freeze({
    async get(account: string): Promise<Uint8Array | null> {
      const name = entryName(account);
      const entries = await readEntries(state);
      try {
        const found = entries.find((entry) => entry.name === name);
        return found === undefined ? null : found.value.slice();
      } finally {
        wipe(...entries.map((entry) => entry.value));
      }
    },
    async set(account: string, value: Uint8Array): Promise<void> {
      const name = writable(account);
      if (!(value instanceof Uint8Array)) throw keystoreFailed();
      const copy = value.slice();
      try {
        await writeEntries(
          state,
          (entries) => ({
            entries: [...entries.filter((entry) => entry.name !== name), { name, value: copy }],
            result: undefined,
          }),
          undefined,
        );
      } finally {
        wipe(copy);
      }
    },
    async delete(account: string): Promise<boolean> {
      const name = writable(account);
      return writeEntries(
        state,
        (entries) =>
          entries.some((entry) => entry.name === name)
            ? { entries: entries.filter((entry) => entry.name !== name), result: true }
            : null,
        false,
      );
    },
  });
}

/** True when `unlocked` is a live handle for `agentId` from unlockFileAgent. */
export function isUnlockedFileAgent(unlocked: unknown, agentId: string): boolean {
  const state = unlockedStates.get(unlocked as UnlockedFileAgent);
  return state !== undefined && state.agentId === agentId && state.kek !== null && !state.stale;
}

// --- Changing the passphrase (`agentlink keystore passphrase`, 04 §2.8) ---

export interface ChangeFileAgentPassphraseOptions {
  /** The CLI prompt. The current secret is read only here, never from the file or the variable. */
  readonly prompt: (label: string) => Promise<Uint8Array>;
  /** A new chosen passphrase (kind 2). Omitted: a new generated unlock code (kind 1). */
  readonly passphrase?: Uint8Array;
  /** As createFileAgent: shows the new code and has the user re-type its last group. */
  readonly confirmCode?: (code: Uint8Array) => Promise<boolean>;
  /** Test seams. */
  readonly dir?: string;
  readonly kdf?: Argon2idParams;
  readonly fs?: KeystoreFsOptions;
}

/**
 * Re-wraps the agent file under a new secret with a fresh salt, under the agent's lock (04 §2.8).
 * Needs the current secret typed at the prompt; a wrong one changes nothing. A new secret that
 * unlocks the owner wrap is refused. Every running server's next operation then fails closed
 * (`keystore_locked`) until it restarts with the new secret. Returns the new generated code, or
 * null for a chosen passphrase; the caller shows it once and wipes it.
 */
export async function changeFileAgentPassphrase(
  agentId: string,
  options: ChangeFileAgentPassphraseOptions,
): Promise<{ readonly unlockCode: Uint8Array | null }> {
  assertAgentId(agentId);
  const dir = options.dir ?? defaultKeystoreDir();
  const fs = options.fs ?? {};
  if (typeof options.prompt !== 'function') throw keystoreLocked();
  const current = await options.prompt('Current unlock code or passphrase');
  if (!(current instanceof Uint8Array)) throw keystoreLocked();
  const chosen = options.passphrase !== undefined;
  const next = chosen ? Uint8Array.from(options.passphrase as Uint8Array) : generateSecretCode();
  let returned = false;
  try {
    await withAgentLock(dir, agentId, async () => {
      const file = await readKeystoreFile(dir, agentFile(agentId), fs);
      if (file === null) throw fileMissing();
      let opened: Awaited<ReturnType<typeof openKeystoreFile>>;
      try {
        opened = await openKeystoreFile(file, { secret: current, source: 'prompt' }, agentId);
      } catch (error) {
        if (error instanceof CryptoInputError) throw openFailed();
        throw error;
      } finally {
        wipe(file);
      }
      let kek: KeystoreKek | undefined;
      try {
        await assertNotOwnerSecret(dir, next, fs);
        kek = await newKek(next, chosen ? 2 : 1, options.kdf ?? KEYSTORE_KDF_DEFAULTS);
        if (!chosen && options.confirmCode !== undefined && !(await options.confirmCode(next))) {
          throw new NodeKeyStoreError(
            'keystore_passphrase_refused',
            'The new unlock code was not confirmed, so the old one still works. Run the command again.',
          );
        }
        const sealed = await sealKeystoreFile(kek, agentId, opened.entries);
        await writeKeystoreFile(dir, agentFile(agentId), sealed, fs);
      } finally {
        wipe(opened.kek.kek, ...opened.entries.map((entry) => entry.value));
        if (kek !== undefined) wipe(kek.kek);
      }
    });
    returned = !chosen;
    return Object.freeze({ unlockCode: chosen ? null : next });
  } finally {
    wipe(current);
    if (!returned) wipe(next);
  }
}

// --- The package's public entry points (index.ts). They take no directory, KDF or filesystem seam,
// and probe the keychain and the terminal themselves, so a caller cannot pass a failed probe to get a
// file KeyStore while the keychain works (04 §2.8: no forced file mode).

export interface FileKeyStoreSetupOptions {
  /** A chosen passphrase typed at the prompt; omitted, a generated unlock code (the default). */
  readonly passphrase?: Uint8Array;
  /** Shows a generated code and has the user re-type its last group (04 §2.8). */
  readonly confirmCode?: (code: Uint8Array) => Promise<boolean>;
}

/**
 * `agentlink init --keystore file`: runs the given keychain probe (the OS one, from
 * keychain-keystore.ts) and checks the terminal itself, then creates the file agent.
 */
export async function createFileKeyStoreAgentWith(
  probe: () => Promise<KeychainProbe>,
  options: FileKeyStoreSetupOptions = {},
): Promise<{ readonly agentId: string; readonly unlockCode: Uint8Array | null }> {
  // stdin and stdout are terminals (a UX guard: a same-user process can fake one, 04 §2.8).
  const interactive = isatty(0) && isatty(1);
  return createFileAgent({
    probe: await probe(),
    interactive,
    env: process.env,
    ...(options.passphrase === undefined ? {} : { passphrase: options.passphrase }),
    ...(options.confirmCode === undefined ? {} : { confirmCode: options.confirmCode }),
  });
}

/** Unlocks a file agent from `~/.agentlink/keystore` and `process.env` (07 §9.2). */
export function unlockFileKeyStoreAgent(
  agentId: string,
  options: { readonly prompt?: (label: string) => Promise<Uint8Array> } = {},
): Promise<UnlockedFileAgent> {
  return unlockFileAgent(
    agentId,
    options.prompt === undefined
      ? { env: process.env }
      : { env: process.env, prompt: options.prompt },
  );
}

/** `agentlink keystore passphrase` over `~/.agentlink/keystore` (04 §2.8). */
export function changeFileKeyStorePassphrase(
  agentId: string,
  options: {
    readonly prompt: (label: string) => Promise<Uint8Array>;
    readonly passphrase?: Uint8Array;
    readonly confirmCode?: (code: Uint8Array) => Promise<boolean>;
  },
): Promise<{ readonly unlockCode: Uint8Array | null }> {
  return changeFileAgentPassphrase(agentId, {
    prompt: options.prompt,
    ...(options.passphrase === undefined ? {} : { passphrase: options.passphrase }),
    ...(options.confirmCode === undefined ? {} : { confirmCode: options.confirmCode }),
  });
}
