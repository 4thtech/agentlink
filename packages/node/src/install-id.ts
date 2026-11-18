// DEVICES-INTERIM (core devices.ts): this computer's install id, core's InstallIdSource, as an item
// next to the agent's other KeyStore items: the keychain account `<agentId>:install-id` and, on a
// file-KeyStore machine, the `ALKS` entry of the same name. Its value is 16 CSPRNG bytes as 32
// lowercase hex (ASCII).
//
// - Created the first time it is read (an ID created before this version gets one then), under the
//   agent's inter-process lock and read back, so every process of this install agrees on one id.
// - A damaged item is replaced with a new id: it is a label, and a new id only starts the store's
//   install afresh (devices.ts).
// - Never part of a recovery kit (key-controls.ts KIT_ITEMS), so a restore on another computer gets
//   its own id; erased with the agent's other items (keychain.ts agentEraseAccounts).
// - Never sent to any 4thTech service, relay or contact, never logged, never printed by `doctor`.
import type { InstallIdSource } from '@4thtech-io/core';
import { randomBytes } from '@4thtech-io/crypto';
import { NodeKeyStoreError } from './errors.js';
import { KEYCHAIN_CALL_TIMEOUT_MS, guarded } from './keychain-keystore.js';
import { keychainAccount, type KeychainBackend } from './keychain.js';
import type { PolicyMarkItem, WithInterProcessLock } from './policy-mark.js';

/** The item name: the keychain account suffix and the `ALKS` entry name (04 §2.2, §2.8). */
export const INSTALL_ID_ITEM = 'install-id';

const CANONICAL = /^[0-9a-f]{32}$/;

const notWritten = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'install_id_not_written',
    "This computer's install record for this ID could not be written.",
  );

function decode(value: Uint8Array | null): string | undefined {
  if (!(value instanceof Uint8Array) || value.length !== 32) return undefined;
  let text = '';
  for (const byte of value) text += String.fromCharCode(byte);
  return CANONICAL.test(text) ? text : undefined;
}

function freshId(): string {
  let text = '';
  for (const byte of randomBytes(16)) text += byte.toString(16).padStart(2, '0');
  return text;
}

/** The install id over one backend's item. A frozen object with exactly `read`. */
export function createInstallId(
  item: PolicyMarkItem,
  withLock: WithInterProcessLock,
): InstallIdSource {
  return Object.freeze({
    read: async (): Promise<string> => {
      const value = decode(await item.read());
      if (value !== undefined) return value;
      return withLock(async () => {
        const again = decode(await item.read());
        if (again !== undefined) return again;
        const id = freshId();
        try {
          await item.write(Uint8Array.from(id, (c) => c.charCodeAt(0)));
          if (decode(await item.read()) !== id) throw notWritten();
        } catch {
          throw notWritten();
        }
        return id;
      });
    },
  });
}

/**
 * The install id as the item `<agentId>:install-id` of a keychain backend (the OS keychain, or the
 * `ALKS` entries behind the same interface). Native errors and timeouts become `keychain_failed`
 * with a fixed sentence (I-7).
 */
export function keychainInstallId(
  keychain: KeychainBackend,
  agentId: string,
  withLock: WithInterProcessLock,
  options: { readonly timeoutMs?: number } = {},
): InstallIdSource {
  const account = keychainAccount(agentId, INSTALL_ID_ITEM);
  const timeoutMs = options.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS;
  return createInstallId(
    {
      read: () => guarded(() => keychain.get(account), timeoutMs),
      write: (value) => guarded(() => keychain.set(account, value), timeoutMs),
    },
    withLock,
  );
}
