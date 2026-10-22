// M1-8f: the shared contracts against the file KeyStore (04 §2.8): the KeyStore conformance suite
// (M1-1g-h) over the `ALKS` file, and the M1-8g policy-version mark contract with the mark as the
// `ALKS` entry `policy-version`, written with the 04 §2.8 write protocol. The KDF runs at the floor
// so each open stays fast.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeUtf8, type Argon2idParams } from '@4thtech-io/crypto';
import { deriveAgentId, newKeystoreKek } from '@4thtech-io/crypto/keystore';
import { runKeyStoreConformance } from '@4thtech-io/crypto/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openAgentStoreWith } from './agent-store.js';
import { fileKeychain, unlockFileAgent, writeAgentFile } from './file-keystore.js';
import { withInterProcessLock } from './inter-process-lock.js';
import { KeychainKeyStore, openRecordedKeyStore } from './keychain-keystore.js';
import { keychainAccount, type KeychainBackend } from './keychain.js';
import { describePolicyMarkContract, type MarkHarness } from './policy-mark.fixture.js';
import { POLICY_MARK_ITEM, keychainPolicyMark } from './policy-mark.js';

const FAST: Argon2idParams = Object.freeze({ memoryKiB: 19456, iterations: 2, parallelism: 1 });
const PASSPHRASE = 'contract test passphrase';
const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const AGENT_ID = deriveAgentId(SEED);

let root: string;
let counter = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentlink-file-contract-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A fresh keystore directory holding the SEED agent, unlocked from the prompt. */
async function freshUnlocked(): Promise<{ dir: string; keychain: KeychainBackend; close(): void }> {
  counter += 1;
  const home = join(root, `home-${counter}`);
  await mkdir(home);
  const dir = join(home, '.agentlink', 'keystore');
  const kek = await newKeystoreKek(
    'ALKS',
    { secret: encodeUtf8(PASSPHRASE), secretKind: 2, source: 'prompt' },
    FAST,
  );
  await writeAgentFile(dir, SEED, kek);
  const unlocked = await unlockFileAgent(AGENT_ID, {
    dir,
    env: {},
    prompt: () => Promise.resolve(encodeUtf8(PASSPHRASE)),
  });
  return { dir, keychain: fileKeychain(unlocked), close: () => unlocked.close() };
}

runKeyStoreConformance(
  {
    name: 'KeychainKeyStore over the ALKS file',
    seed: SEED,
    open: async (keyEpoch) =>
      KeychainKeyStore.open((await freshUnlocked()).keychain, AGENT_ID, { keyEpoch }),
  },
  { describe, it },
);

runKeyStoreConformance(
  {
    name: 'the KeyStore facade over the ALKS file (openRecordedKeyStore "file")',
    seed: SEED,
    open: async (keyEpoch) => {
      const { dir } = await freshUnlocked();
      const unlocked = await unlockFileAgent(AGENT_ID, {
        dir,
        env: {},
        prompt: () => Promise.resolve(encodeUtf8(PASSPHRASE)),
      });
      return openRecordedKeyStore(
        'file',
        AGENT_ID,
        { keychain: failingKeychain, file: unlocked },
        { keyEpoch },
      );
    },
  },
  { describe, it },
);

/** The OS keychain must never be touched for a file agent (07 §9.1: no fallback). */
const failingKeychain: KeychainBackend = {
  get: () => Promise.reject(new Error('the keychain was used for a file agent')),
  set: () => Promise.reject(new Error('the keychain was used for a file agent')),
  delete: () => Promise.reject(new Error('the keychain was used for a file agent')),
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function fileHarness(): Promise<MarkHarness> {
  const { dir, keychain, close } = await freshUnlocked();
  const lockPath = join(dir, '..', 'agent.sqlite.lock');
  const account = keychainAccount(AGENT_ID, POLICY_MARK_ITEM);
  const withLock = <T>(fn: () => Promise<T> | T): Promise<T> => withInterProcessLock(lockPath, fn);
  let fault: 'none' | 'read' | 'write' | 'lost-write' = 'none';
  let delay: (value: Uint8Array) => number = () => 0;
  let writes = 0;
  // The fault seam wraps the file backend, as the keychain double does for the keychain item.
  const faulty: KeychainBackend = {
    get: async (name) => {
      if (fault === 'read') throw new Error('file read failed');
      return keychain.get(name);
    },
    set: async (name, value) => {
      const copy = value.slice();
      const ms = delay(copy);
      if (ms > 0) await sleep(ms);
      if (fault === 'write') throw new Error('file write failed');
      writes += 1;
      if (fault === 'lost-write') return;
      await keychain.set(name, copy);
    },
    delete: (name) => keychain.delete(name),
  };
  return {
    open: () => keychainPolicyMark(faulty, AGENT_ID, withLock),
    raw: () => keychain.get(account),
    plant: async (value) => {
      if (value === null) await keychain.delete(account);
      else await keychain.set(account, value);
    },
    fault: (kind) => {
      fault = kind;
    },
    delayWrites: (fn) => {
      delay = fn;
    },
    writes: () => writes,
    holdLock: async () => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held!: () => void;
      const acquired = new Promise<void>((resolve) => {
        held = resolve;
      });
      void withInterProcessLock(lockPath, async () => {
        held();
        await released;
      });
      await acquired;
      return release;
    },
    close: () => {
      close();
      return Promise.resolve();
    },
  };
}

describePolicyMarkContract('ALKS entry policy-version (file KeyStore)', fileHarness);

describe('openAgentStoreWith over the file backend (M1-8f, M1-8g)', () => {
  it('opens the store with the file store key and hands the file entry as the policy mark', async () => {
    const { dir, keychain, close } = await freshUnlocked();
    const unlocked = await unlockFileAgent(AGENT_ID, {
      dir,
      env: {},
      prompt: () => Promise.resolve(encodeUtf8(PASSPHRASE)),
    });
    const opened = await openAgentStoreWith('file', AGENT_ID, join(dir, '..', 'agent.sqlite'), {
      keychain: failingKeychain,
      file: unlocked,
    });
    try {
      expect(await opened.policyMark.read()).toBe(0);
      expect(await opened.policyMark.raise(4)).toBe(4);
      expect(await keychain.get(keychainAccount(AGENT_ID, POLICY_MARK_ITEM))).toEqual(
        encodeUtf8('4'),
      );
    } finally {
      await opened.close();
      unlocked.close();
      close();
    }
  });
});
