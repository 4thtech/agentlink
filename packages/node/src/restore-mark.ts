// SEC-RESTORE-GUARD (D-156; 04 §2.2, §2.3.3 "After a restore", §2.8): the restore mark, core's
// RestoreMark, as an item next to the agent's other KeyStore items: the keychain account
// `<agentId>:restore-mark` and, on a file-KeyStore machine, the `ALKS` entry of the same name. Its
// value is the time of the last restore in unix seconds as canonical ASCII decimal, `0` for an ID
// created on this computer. A time the guard started for an update (no mark yet, or a damaged one)
// carries the prefix `u`; that reason only chooses the card's wording, never a decision.
//
// - Written `0` when an ID is created (createKeychainAgent, createFileAgent) and the time of the
//   restore when a restore writes the ID's keys (key-controls.ts importAgent, every restore path:
//   the app, the page and the terminal). It is not part of a recovery kit.
// - `read` is the only method: nothing in this package or behind an MCP tool lowers or clears it.
// - Fail closed: an item that is missing or damaged is replaced, under the agent's inter-process lock,
//   with the current time and read back, so the 24-hour guard starts now. A keychain that cannot be
//   read or written rejects, and the core then treats the guard as in force.
//
// Residual (G-1, D-67): a same-user process can edit KeyStore items directly (04 §2.5).
import type { RestoreMark, RestoreReason } from '@4thtech-io/core';
import { NodeKeyStoreError } from './errors.js';
import { KEYCHAIN_CALL_TIMEOUT_MS, guarded } from './keychain-keystore.js';
import { keychainAccount, type KeychainBackend } from './keychain.js';
import type { PolicyMarkItem, WithInterProcessLock } from './policy-mark.js';

/** The item name: the keychain account suffix and the `ALKS` entry name (04 §2.2, §2.8). */
export const RESTORE_MARK_ITEM = 'restore-mark';

/**
 * `0`, or a non-zero digit and at most 15 more (no sign, space, leading zero or fraction); a
 * non-zero time may carry the update prefix `u`.
 */
const CANONICAL = /^(?:0|u?[1-9][0-9]{0,15})$/;

const markInvalid = (): NodeKeyStoreError =>
  new NodeKeyStoreError('restore_mark_invalid', "This agent's restore record is damaged.");

const notWritten = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'restore_mark_not_written',
    "This agent's restore record could not be written. Paid actions ask you until it can be.",
  );

/**
 * The item value of `at` (unix seconds; 0 = never restored): canonical ASCII decimal, with the
 * prefix `u` when an update started the guard.
 */
export function encodeRestoreMark(at: number, reason: RestoreReason = 'restore'): Uint8Array {
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) throw markInvalid();
  const text = reason === 'update' && at > 0 ? `u${String(at)}` : String(at);
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

function markText(value: Uint8Array): string {
  if (!(value instanceof Uint8Array) || value.length === 0 || value.length > 17) {
    throw markInvalid();
  }
  let text = '';
  for (const byte of value) text += String.fromCharCode(byte);
  if (!CANONICAL.test(text)) throw markInvalid();
  return text;
}

/** The time an item holds. Anything but the canonical form throws `restore_mark_invalid`. */
export function decodeRestoreMark(value: Uint8Array): number {
  const text = markText(value);
  const at = Number(text.startsWith('u') ? text.slice(1) : text);
  if (!Number.isSafeInteger(at)) throw markInvalid();
  return at;
}

/** Why the guard of an item started (copy only). Throws like decodeRestoreMark. */
export function decodeRestoreReason(value: Uint8Array): RestoreReason {
  decodeRestoreMark(value);
  return markText(value).startsWith('u') ? 'update' : 'restore';
}

/** The mark's value, or undefined when the item is missing or damaged. Read errors propagate. */
async function readValue(item: PolicyMarkItem): Promise<number | undefined> {
  const value = await item.read();
  if (value === null) return undefined;
  try {
    return decodeRestoreMark(value);
  } catch {
    return undefined;
  }
}

/** The reason of the mark (copy only); `update` when it cannot be read. Never throws. */
async function readReason(item: PolicyMarkItem): Promise<RestoreReason> {
  try {
    const value = await item.read();
    return value === null ? 'update' : decodeRestoreReason(value);
  } catch {
    return 'update';
  }
}

/** The mark over one backend's item. A frozen object with exactly `read` and `reason`. */
export function createRestoreMark(
  item: PolicyMarkItem,
  withLock: WithInterProcessLock,
  now: () => number,
): RestoreMark {
  return Object.freeze({
    read: async (): Promise<number> => {
      const value = await readValue(item);
      if (value !== undefined) return value;
      // Missing or damaged: the guard starts now (fail closed), written under the lock and read back.
      return withLock(async () => {
        const again = await readValue(item);
        if (again !== undefined) return again;
        const at = Math.floor(now());
        await item.write(encodeRestoreMark(at, 'update'));
        let stored: number | undefined;
        try {
          stored = await readValue(item);
        } catch {
          throw notWritten();
        }
        if (stored !== at) throw notWritten();
        return at;
      });
    },
    reason: (): Promise<RestoreReason> => readReason(item),
  });
}

export interface KeychainRestoreMarkOptions {
  /** Limit for each keychain call in milliseconds. Default KEYCHAIN_CALL_TIMEOUT_MS. */
  readonly timeoutMs?: number;
  /** Unix seconds. Default: the system clock. */
  readonly now?: () => number;
}

/**
 * The mark as the item `<agentId>:restore-mark` of a keychain backend (the OS keychain, or the
 * `ALKS` entries behind the same interface). Native errors and timeouts become `keychain_failed`
 * with a fixed sentence (I-7).
 */
export function keychainRestoreMark(
  keychain: KeychainBackend,
  agentId: string,
  withLock: WithInterProcessLock,
  options: KeychainRestoreMarkOptions = {},
): RestoreMark {
  const account = keychainAccount(agentId, RESTORE_MARK_ITEM);
  const timeoutMs = options.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS;
  return createRestoreMark(
    {
      read: () => guarded(() => keychain.get(account), timeoutMs),
      write: (value) => guarded(() => keychain.set(account, value), timeoutMs),
    },
    withLock,
    options.now ?? ((): number => Math.floor(Date.now() / 1000)),
  );
}
