// M1-8g: the policy-version high-water mark (04 §2.5.1, §2.2, §2.8; 07 §3.4; 06 §3 G-6), core's
// PolicyVersionMark, as an item next to the agent's other KeyStore items rather than a store row, so
// deleting or rolling back the store cannot lower it.
//
// The item is named `policy-version`: the keychain account `<agentId>:policy-version` (04 §2.2) and,
// on a file-KeyStore machine, the `ALKS` entry of the same name (04 §2.8, M1-8f). Its value is the
// version as canonical ASCII decimal. The version is not secret, but it is still parsed strictly: a
// malformed item throws and is never read as 0, so the core fails closed (M1-7d).
//
// `read` is one item read; one item write is atomic in the keychain and, with the 04 §2.8 write
// protocol, in the file. `raise` reads, compares, writes and reads back under the agent's
// inter-process lock (06 §6), so two processes cannot lower the mark and a write that did not stick
// is reported. Residual (G-1, D-67): a same-user process can rewrite the item directly, outside the
// lock; the mark makes a policy rollback need that edit as well as the store edit.
import type { PolicyVersionMark } from '@4thtech-io/core';
import { NodeKeyStoreError } from './errors.js';
import { KEYCHAIN_CALL_TIMEOUT_MS, guarded } from './keychain-keystore.js';
import { keychainAccount, type KeychainBackend } from './keychain.js';

/** The item name: the keychain account suffix and the `ALKS` entry name (04 §2.2, §2.8). */
export const POLICY_MARK_ITEM = 'policy-version';

/** Runs `fn` under the agent's inter-process lock (06 §6; SqliteStore.withInterProcessLock). */
export type WithInterProcessLock = <T>(fn: () => Promise<T> | T) => Promise<T>;

/** One backend's item: its bytes or null when absent, and an atomic replace. */
export interface PolicyMarkItem {
  read(): Promise<Uint8Array | null>;
  write(value: Uint8Array): Promise<void>;
}

/** `0`, or a non-zero digit and at most 15 more: no sign, space, leading zero, fraction or exponent. */
const CANONICAL = /^(?:0|[1-9][0-9]{0,15})$/;
const ASCII_DIGITS = /^[0-9]*$/;

const markInvalid = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'policy_mark_invalid',
    "This agent's policy version record is damaged, so no policy can be applied. Run `agentlink doctor` for the fix.",
  );

const versionInvalid = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'policy_version_invalid',
    'The policy version must be a whole number from 0 to 2^53 - 1.',
  );

const notRaised = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'policy_mark_not_raised',
    "This agent's policy version record could not be updated. The policy stays locked until the owner signs a newer one.",
  );

function assertVersion(version: unknown): asserts version is number {
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    throw versionInvalid();
  }
}

/** The item value of `version`: canonical ASCII decimal (04 §2.2, §2.8). */
export function encodePolicyVersion(version: number): Uint8Array {
  assertVersion(version);
  return Uint8Array.from(String(version), (c) => c.charCodeAt(0));
}

/** The version an item holds. Anything but the canonical form throws `policy_mark_invalid`. */
export function decodePolicyVersion(value: Uint8Array): number {
  if (!(value instanceof Uint8Array) || value.length === 0 || value.length > 16) {
    throw markInvalid();
  }
  let text = '';
  for (const byte of value) text += String.fromCharCode(byte);
  if (!ASCII_DIGITS.test(text) || !CANONICAL.test(text)) throw markInvalid();
  const version = Number(text);
  if (!Number.isSafeInteger(version)) throw markInvalid();
  return version;
}

async function readMark(item: PolicyMarkItem): Promise<number> {
  const value = await item.read();
  return value === null ? 0 : decodePolicyVersion(value);
}

/**
 * The mark over one backend's item (keychain here; the `ALKS` entry in M1-8f). A frozen object with
 * exactly `read` and `raise`: nothing lowers, resets or deletes it.
 */
export function createPolicyVersionMark(
  item: PolicyMarkItem,
  withLock: WithInterProcessLock,
): PolicyVersionMark {
  return Object.freeze({
    read: (): Promise<number> => readMark(item),
    raise: async (version: number): Promise<number> => {
      assertVersion(version);
      return withLock(async () => {
        const current = await readMark(item);
        if (current >= version) return current;
        await item.write(encodePolicyVersion(version));
        // The read-back: a write the backend accepted but did not keep is reported, not trusted.
        let stored: number;
        try {
          stored = await readMark(item);
        } catch {
          throw notRaised();
        }
        if (stored !== version) throw notRaised();
        return stored;
      });
    },
  });
}

export interface KeychainPolicyMarkOptions {
  /** Limit for each keychain call in milliseconds. Default KEYCHAIN_CALL_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}

/**
 * The mark as the keychain item `<agentId>:policy-version` under service `agentlink` (04 §2.2).
 * Native errors and timeouts become `keychain_failed` with a fixed sentence (I-7).
 */
export function keychainPolicyMark(
  keychain: KeychainBackend,
  agentId: string,
  withLock: WithInterProcessLock,
  options: KeychainPolicyMarkOptions = {},
): PolicyVersionMark {
  const account = keychainAccount(agentId, POLICY_MARK_ITEM);
  const timeoutMs = options.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS;
  return createPolicyVersionMark(
    {
      read: () => guarded(() => keychain.get(account), timeoutMs),
      write: (value) => guarded(() => keychain.set(account, value), timeoutMs),
    },
    withLock,
  );
}
