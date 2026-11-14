// WIN-BROKEN-ID (04 §2.5 "An ID whose key is missing"; proposed, owner confirms at merge): the
// keychain side of an ID folder whose identity key is gone from this computer.
//
// - `agentIdentityMissing`: true when the ID's seed or store key is not in the keychain (what the
//   keychain KeyStore's open reports as `identity_missing`). The bytes read are wiped at once and
//   never leave this file; only the yes/no does.
// - `eraseBrokenAgentItems`: after the folder was set aside, the ID's leftover agent items (the
//   fixed erase list of 04 §2.5 step 6, agentEraseAccounts: never an owner account). Refused while
//   the seed is here: an ID that still has its key is removed only by the full removal, which signs
//   its `agent.revoke`. With the seed gone, nothing left can sign for this ID; the leftovers only
//   block a later restore of it (Restore never overwrites, 04 §2.3.3).
//
// I-7: errors are fixed text; no agent ID or account reaches a log or an answer.
import { wipe } from '@4thtech-io/crypto';
import { NodeKeyStoreError } from './errors.js';
import { KEYCHAIN_CALL_TIMEOUT_MS, guarded } from './keychain-keystore.js';
import {
  agentEraseAccounts,
  assertAgentId,
  keychainAccount,
  osKeychain,
  type KeychainBackend,
} from './keychain.js';

const eraseRefused = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'keystore_erase_failed',
    "AgentLink couldn't erase all of this ID's leftover keys. Nothing else was changed. Try again.",
  );

/** True when the seed or the store key of `agentId` is missing from `keychain`. */
export async function agentIdentityMissing(
  keychain: KeychainBackend,
  agentId: string,
  timeoutMs: number = KEYCHAIN_CALL_TIMEOUT_MS,
): Promise<boolean> {
  assertAgentId(agentId);
  for (const item of ['seed', 'store-key'] as const) {
    const bytes = await guarded(() => keychain.get(keychainAccount(agentId, item)), timeoutMs);
    if (bytes === null) return true;
    wipe(bytes);
  }
  return false;
}

/**
 * Erases the leftover agent items of an ID whose seed is gone (04 §2.5 step 6 list, no storage ids:
 * the store that names them cannot be opened). Refuses while the seed is here.
 */
export async function eraseBrokenAgentItems(
  keychain: KeychainBackend,
  agentId: string,
  timeoutMs: number = KEYCHAIN_CALL_TIMEOUT_MS,
): Promise<void> {
  assertAgentId(agentId);
  let accounts: string[];
  try {
    accounts = agentEraseAccounts(agentId, []);
  } catch {
    throw eraseRefused();
  }
  const seed = await guarded(() => keychain.get(keychainAccount(agentId, 'seed')), timeoutMs).catch(
    () => {
      throw eraseRefused();
    },
  );
  if (seed !== null) {
    wipe(seed);
    throw eraseRefused();
  }
  let failed = false;
  for (const account of accounts) {
    try {
      await guarded(() => keychain.delete(account), timeoutMs);
    } catch {
      failed = true;
    }
  }
  if (failed) throw eraseRefused();
}

/** The package entry: agentIdentityMissing against the OS keychain. */
export function osAgentIdentityMissing(agentId: string): Promise<boolean> {
  return agentIdentityMissing(osKeychain(), agentId);
}

/** The package entry: eraseBrokenAgentItems against the OS keychain. */
export function eraseOsBrokenAgentItems(agentId: string): Promise<void> {
  return eraseBrokenAgentItems(osKeychain(), agentId);
}
