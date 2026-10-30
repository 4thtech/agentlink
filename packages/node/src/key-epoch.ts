// W4-RENAME-REACHES-CONTACTS (S2; D-141; 04 §2.6, §3.1.1 "Epoch advance"; crypto keystore-api.ts
// KeyEpochControl; I-4, I-7): the Node agent KeyStore's key epoch and its owner-only control.
//
// - Where the epoch lives. The agent item `key-epoch` (the keychain account `<agentId>:key-epoch`, or
//   the `ALKS` entry of that name), canonical ASCII decimal; absent means 0 (an agent that never
//   rotated). Not secret, but parsed strictly: a damaged item fails the open, never reads as 0.
// - Who follows it. A KeychainKeyStore opened without an explicit epoch reads it at open and again
//   whenever its current public bundle is asked for (the core asks before every send, sendState), so
//   a process that has the agent open (an AI app's `agentlink mcp`) is at the new epoch once the owner
//   flow advanced it, and never signs under the old one afterwards (08 §1). It never moves back: a
//   lowered item (a same-user edit) leaves a running KeyStore where it is, and the core then refuses
//   to send (`key_epoch_mismatch`).
// - Who moves it. Only KeyEpochControl.advanceEpoch: a compare-and-set on the item (read, compare,
//   write, read back) that takes only a session the control's owner flow accepts (by identity, never
//   by shape): presence_required otherwise, owner_locked once that session ended. previewEpoch gives
//   the next epoch's public keys and moves nothing. The core then commits the owner-signed card for
//   that epoch with its own compare-and-set on the identity row (identity.ts rotate), so of two racing
//   rotations one commits and the other fails; both would have signed the same derived keys.
// - Who can reach it. `epochKeysOf(keyStore)` gives an opaque token for a KeyStore this package
//   opened; `keyEpochControlFor` is internal to this package (not exported from index.ts) and is
//   called only by the rename gesture of the app host's owner flow (owner-rename.ts). No MCP tool is
//   given either (apps/cli/test/rename-fence.test.ts).
//
// Residual (G-1, D-67): a same-user process can rewrite the item directly. Raising it only stops the
// agent from sending (`rotation_pending`) until the owner renames or rotates again; it signs nothing
// and reveals nothing, since every epoch's keys are derivable from the seed anyway (04 §2.6).
import {
  KeyStoreError,
  type KeyEpochControl,
  type OwnerSession,
  type PublicIdentity,
} from '@4thtech-io/crypto';
import { CLI_COMMAND } from './cli-command.js';
import { NodeKeyStoreError } from './errors.js';
import { keychainAccount, type KeychainBackend } from './keychain.js';

/** The item name: the keychain account suffix and the `ALKS` entry name (04 §2.2, §2.8). */
export const KEY_EPOCH_ITEM = 'key-epoch';

/** The largest key epoch (04 §2.6; the KeyStore's own bound). */
const MAX_EPOCH = 2 ** 32 - 1;
/** `0`, or a non-zero digit and at most 9 more: no sign, space, leading zero or fraction. */
const CANONICAL = /^(?:0|[1-9][0-9]{0,9})$/;

const epochInvalid = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'key_epoch_invalid',
    `This agent's key epoch record is damaged, so it cannot send. Run \`${CLI_COMMAND} doctor\` for the fix.`,
  );

/** The item value of `epoch`: canonical ASCII decimal. */
export function encodeKeyEpoch(epoch: number): Uint8Array {
  if (!Number.isInteger(epoch) || epoch < 0 || epoch > MAX_EPOCH) throw epochInvalid();
  return Uint8Array.from(String(epoch), (c) => c.charCodeAt(0));
}

/** The epoch an item holds. Anything but the canonical form throws (never read as 0). */
export function decodeKeyEpoch(value: Uint8Array): number {
  if (!(value instanceof Uint8Array) || value.length === 0 || value.length > 10) {
    throw epochInvalid();
  }
  let text = '';
  for (const byte of value) text += String.fromCharCode(byte);
  if (!CANONICAL.test(text)) throw epochInvalid();
  const epoch = Number(text);
  if (epoch > MAX_EPOCH) throw epochInvalid();
  return epoch;
}

/** Runs one keychain call within the KeyStore's time limit (keychain-keystore.ts guarded). */
export type GuardedCall = <T>(call: () => Promise<T>) => Promise<T>;

/** Reads the agent's key epoch: the item, or 0 when there is none. */
export async function readKeyEpoch(
  items: KeychainBackend,
  agentId: string,
  call: GuardedCall,
): Promise<number> {
  const value = await call(() => items.get(keychainAccount(agentId, KEY_EPOCH_ITEM)));
  return value === null ? 0 : decodeKeyEpoch(value);
}

/** What a control needs of the KeyStore that registered its token. Module-private. */
export interface EpochKeysState {
  readonly items: KeychainBackend;
  readonly agentId: string;
  readonly call: GuardedCall;
  /** The public keys of `epoch` from the seed (checked to derive the agent), at any epoch. */
  publicAt(epoch: number): Promise<PublicIdentity>;
}

declare const EPOCH_KEYS: unique symbol;
/**
 * An opaque token for one agent's key items, for the app host's rename gesture only (owner-rename.ts).
 * It has no method and no field: only this package can turn it into a KeyEpochControl.
 */
export interface AgentEpochKeys {
  readonly [EPOCH_KEYS]: true;
}

const STATES = new WeakMap<AgentEpochKeys, EpochKeysState>();
const BY_KEYSTORE = new WeakMap<object, AgentEpochKeys>();

/** Called by keychain-keystore.ts for each KeyStore (and facade) it opens. */
export function registerEpochKeys(keyStore: object, state: EpochKeysState): void {
  const token = Object.freeze(Object.create(null) as object) as AgentEpochKeys;
  STATES.set(token, Object.freeze({ ...state }));
  BY_KEYSTORE.set(keyStore, token);
}

/** The same token for a wrapper of `of` (the frozen KeyStore facade). */
export function aliasEpochKeys(alias: object, of: object): void {
  const token = BY_KEYSTORE.get(of);
  if (token !== undefined) BY_KEYSTORE.set(alias, token);
}

/** The token of a KeyStore this package opened, else undefined (a test double, another backend). */
export function epochKeysOf(keyStore: unknown): AgentEpochKeys | undefined {
  if (typeof keyStore !== 'object' || keyStore === null) return undefined;
  return BY_KEYSTORE.get(keyStore);
}

const conflict = (): KeyStoreError =>
  new KeyStoreError('epoch_conflict', 'keystore: the key epoch is not the expected one');
const unavailable = (): KeyStoreError =>
  new KeyStoreError('epoch_unavailable', 'keystore: that key epoch is not available');

/**
 * The KeyEpochControl over `keys` (internal: the rename gesture builds one per gesture). `accepts`
 * names the one session this control takes (identity, never shape): anything else is
 * presence_required, an ended session owner_locked.
 */
export function keyEpochControlFor(
  keys: AgentEpochKeys,
  accepts: (owner: OwnerSession) => boolean,
): KeyEpochControl {
  const state = STATES.get(keys);
  if (state === undefined) {
    throw new KeyStoreError('presence_required', 'keystore: not an epoch control of this package');
  }
  const current = (): Promise<number> => readKeyEpoch(state.items, state.agentId, state.call);
  return Object.freeze<KeyEpochControl>({
    async previewEpoch(epoch: number): Promise<PublicIdentity> {
      if (!Number.isInteger(epoch) || epoch < 0 || epoch > MAX_EPOCH) throw unavailable();
      const now = await current();
      if (epoch <= now) throw conflict();
      if (epoch > now + 1) throw unavailable();
      return state.publicAt(epoch);
    },
    async advanceEpoch(expected: number, owner: OwnerSession): Promise<PublicIdentity> {
      let accepted: boolean;
      try {
        accepted = accepts(owner);
      } catch {
        accepted = false;
      }
      if (!accepted) {
        throw new KeyStoreError('presence_required', 'keystore: the owner session is not accepted');
      }
      if (!owner.isActive()) {
        throw new KeyStoreError('owner_locked', 'keystore: the owner session has ended');
      }
      if (!Number.isInteger(expected) || expected < 0 || expected >= MAX_EPOCH) throw conflict();
      if ((await current()) !== expected) throw conflict();
      const account = keychainAccount(state.agentId, KEY_EPOCH_ITEM);
      await state.call(() => state.items.set(account, encodeKeyEpoch(expected + 1)));
      // Read back: a write that did not stick is reported, never assumed.
      if ((await current()) !== expected + 1) throw conflict();
      return state.publicAt(expected + 1);
    },
  });
}
