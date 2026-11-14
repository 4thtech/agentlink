// WIN-BROKEN-ID (04 §2.5 "An ID whose key is missing"; proposed, owner confirms at merge): the
// keychain side of an ID folder whose identity key is gone from this computer.
//
// - `agentIdentityMissing`: true when the ID's seed or store key is not in the keychain (what the
//   keychain KeyStore's open reports as `identity_missing`). The bytes read are wiped at once and
//   never leave this file; only the yes/no does.
// - `agentSeedMissing`: true only when the seed itself is gone. Only such an ID may be set aside
//   ("Remove from this computer"); one whose seed is here but whose store key is missing still has
//   a key that can sign for it, so it is never set aside without its signed removal.
// - `eraseBrokenAgentItems`: the ID's leftover agent items (the fixed erase list of 04 §2.5 step 6,
//   agentEraseAccounts: never an owner account). Refused while the seed is here, read again right
//   before the deletes. Set-aside keeps the store key (`keepStoreKey`), so the set-aside store stays
//   readable; a restore of this ID erases what is left first (the kit carries every item).
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

/** True when the seed of `agentId` is missing from `keychain` (WIN-BROKEN-ID r1 M1). */
export async function agentSeedMissing(
  keychain: KeychainBackend,
  agentId: string,
  timeoutMs: number = KEYCHAIN_CALL_TIMEOUT_MS,
): Promise<boolean> {
  assertAgentId(agentId);
  const seed = await guarded(() => keychain.get(keychainAccount(agentId, 'seed')), timeoutMs);
  if (seed === null) return true;
  wipe(seed);
  return false;
}

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
  options: { readonly keepStoreKey?: boolean } = {},
): Promise<void> {
  assertAgentId(agentId);
  let accounts: string[];
  try {
    const storeKey = keychainAccount(agentId, 'store-key');
    accounts = agentEraseAccounts(agentId, []).filter(
      (account) => options.keepStoreKey !== true || account !== storeKey,
    );
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

/** The package entry: agentSeedMissing against the OS keychain. */
export function osAgentSeedMissing(agentId: string): Promise<boolean> {
  return agentSeedMissing(osKeychain(), agentId);
}

/** The package entry: agentIdentityMissing against the OS keychain. */
export function osAgentIdentityMissing(agentId: string): Promise<boolean> {
  return agentIdentityMissing(osKeychain(), agentId);
}

/** The package entry: set-aside's leftover erase (the store key is kept) against the OS keychain. */
export function eraseOsBrokenAgentItems(agentId: string): Promise<void> {
  return eraseBrokenAgentItems(osKeychain(), agentId, KEYCHAIN_CALL_TIMEOUT_MS, {
    keepStoreKey: true,
  });
}
