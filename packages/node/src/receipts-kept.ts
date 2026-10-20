// M1-33a: the receipts-kept marker (04 §2.2; 06 §3 "Existing policies"; D-109, decided by Tali in
// chat on 2026-10-20), core's ReceiptsKeptMark, as an item next to the agent's other KeyStore items:
// the keychain account `<agentId>:receipts-kept` (and, once the file KeyStore opens agents, the `ALKS`
// entry of the same name, 04 §2.8). Its value is the `policy.set` version at which the owner kept
// delivery receipts on, in the policy-version mark's canonical ASCII decimal form.
//
// It is not secret and grants nothing: it only records that the owner already answered. A malformed
// item throws on read, and the core reads that as not kept, so the owner is asked again. The write
// runs under the agent's inter-process lock and is read back. Residual (G-1): a same-user process
// can write the item directly, which only silences the question for a value the owner signed.
import type { ReceiptsKeptMark } from '@4thtech-io/core';
import { NodeKeyStoreError } from './errors.js';
import { KEYCHAIN_CALL_TIMEOUT_MS, guarded } from './keychain-keystore.js';
import { keychainAccount, type KeychainBackend } from './keychain.js';
import {
  decodePolicyVersion,
  encodePolicyVersion,
  type PolicyMarkItem,
  type WithInterProcessLock,
} from './policy-mark.js';

/** The item name: the keychain account suffix and the `ALKS` entry name (04 §2.2, §2.8). */
export const RECEIPTS_KEPT_ITEM = 'receipts-kept';

const notWritten = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'receipts_kept_not_written',
    'AgentLink could not remember that you kept delivery receipts on. It will ask again next time.',
  );

/** The marker over one backend's item (the keychain here). A frozen object: `read` and `write`. */
export function createReceiptsKeptMark(
  item: PolicyMarkItem,
  withLock: WithInterProcessLock,
): ReceiptsKeptMark {
  const read = async (): Promise<number | null> => {
    const value = await item.read();
    return value === null ? null : decodePolicyVersion(value);
  };
  return Object.freeze({
    read,
    write: async (version: number): Promise<void> => {
      const encoded = encodePolicyVersion(version);
      await withLock(async () => {
        await item.write(encoded);
        let stored: number | null;
        try {
          stored = await read();
        } catch {
          throw notWritten();
        }
        if (stored !== version) throw notWritten();
      });
    },
  });
}

/**
 * The marker as the keychain item `<agentId>:receipts-kept` under service `agentlink` (04 §2.2).
 * Native errors and timeouts become `keychain_failed` with a fixed sentence (I-7).
 */
export function keychainReceiptsKept(
  keychain: KeychainBackend,
  agentId: string,
  withLock: WithInterProcessLock,
  options: { readonly timeoutMs?: number } = {},
): ReceiptsKeptMark {
  const account = keychainAccount(agentId, RECEIPTS_KEPT_ITEM);
  const timeoutMs = options.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS;
  return createReceiptsKeptMark(
    {
      read: () => guarded(() => keychain.get(account), timeoutMs),
      write: (value) => guarded(() => keychain.set(account, value), timeoutMs),
    },
    withLock,
  );
}
