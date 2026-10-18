// The OS keychain (04 §2.2): macOS Keychain, Windows Credential Manager and the Linux Secret Service,
// through @napi-rs/keyring (03 §6). Items are generic credentials under service `agentlink`; values
// are bytes and never become JS strings. Also the keychain probe and backend selection at `init`
// (04 §2.8 "Selection", 07 §9.1).
import { equalBytes, encodeHex, randomBytes } from '@4thtech-io/crypto';
import { NodeKeyStoreError } from './errors.js';

/** The keychain service of every AgentLink item (04 §2.2). */
export const KEYCHAIN_SERVICE = 'agentlink';

/**
 * The Linux store every entry is pinned to. Unpinned, @napi-rs/keyring falls back from the Secret
 * Service to the kernel keyring (keyutils), which does not survive a reboot: an agent created there
 * would lose its identity. Pinned, a machine without a Secret Service fails the probe instead, and
 * `init` answers `needs_setup` (04 §2.8).
 */
export const KEYCHAIN_LINUX_STORE = 'secret-service';

/**
 * The agent's keychain items (04 §2.8: the names are the `ALKS` entry names): the seed, the store key
 * and the policy-version mark (M1-8g, 04 §2.5.1). Storage credentials (`s3:<id>`, 07 §5.2) join when
 * the storage card needs them.
 */
export type KeychainItem = 'seed' | 'store-key' | 'policy-version';

/** A narrow view of the OS keychain under one service. Values are bytes; callers wipe what they get. */
export interface KeychainBackend {
  /** The item's bytes, or null when there is none. Rejects when the keychain cannot be read. */
  get(account: string): Promise<Uint8Array | null>;
  /** Creates or replaces the item. */
  set(account: string, value: Uint8Array): Promise<void>;
  /** True when an item was deleted, false when there was none. */
  delete(account: string): Promise<boolean>;
}

const AGENT_ID = /^0x[0-9a-f]{40}$/;

/** Throws `agent_id_invalid` unless `agentId` is the exact 04 §2.9 text form. */
export function assertAgentId(agentId: unknown): asserts agentId is string {
  if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) {
    throw new NodeKeyStoreError(
      'agent_id_invalid',
      "The agent ID is not valid. Use the ID that init recorded in the agent's config.",
    );
  }
}

/**
 * The keychain account of an agent item: `<agentId>` for the seed (04 §2.2, §2.9) and
 * `<agentId>:<name>` for every other item, so several agents share one machine (`--agent <name>`).
 */
export function keychainAccount(agentId: string, item: KeychainItem): string {
  assertAgentId(agentId);
  return item === 'seed' ? agentId : `${agentId}:${item}`;
}

type Binding = typeof import('@napi-rs/keyring');

/**
 * The napi-rs loader reads these to load another native library or a WASI build instead of the
 * pinned platform package (IR-M1-8a-1 L-7). Not a boundary against a same-user process, which can
 * set NODE_OPTIONS or edit node_modules (04 §2.5), but the seed code should not change silently.
 */
const LOADER_OVERRIDES = [
  'NAPI_RS_NATIVE_LIBRARY_PATH',
  'NAPI_RS_FORCE_WASI',
  'NAPI_RS_WASI_FLAVOR',
];

/**
 * The OS keychain through @napi-rs/keyring. The native binding loads on first use, so importing this
 * package loads no native code. `service` is `agentlink` except in tests.
 *
 * Internal to @4thtech-io/node (IR-M1-8a-1 M-2): it returns raw item bytes, the agent seed included,
 * so the package entry never exports it (fence.test.ts).
 */
export function osKeychain(service: string = KEYCHAIN_SERVICE): KeychainBackend {
  let binding: Promise<Binding> | undefined;
  const entry = async (account: string) => {
    for (const name of LOADER_OVERRIDES) Reflect.deleteProperty(process.env, name);
    binding ??= import('@napi-rs/keyring');
    const { AsyncEntry } = await binding;
    return new AsyncEntry(service, account, { linux: { store: KEYCHAIN_LINUX_STORE } });
  };
  return {
    async get(account) {
      // 2.1.0 declares Uint8Array but returns a plain number[] (seen on macOS): copy it into bytes
      // and zero the array, so callers always get a Uint8Array they can wipe.
      const raw: unknown = await (await entry(account)).getSecret();
      if (raw === undefined || raw === null) return null;
      if (raw instanceof Uint8Array) return raw;
      if (!Array.isArray(raw)) throw new TypeError('keychain: unexpected secret type');
      const bytes = Uint8Array.from(raw as number[]);
      raw.fill(0);
      return bytes;
    },
    async set(account, value) {
      await (await entry(account)).setSecret(value);
    },
    async delete(account) {
      return (await entry(account)).deleteCredential();
    },
  };
}

/** The result of the keychain probe. `fix` says how to make the keychain usable (07 §9.1). */
export type KeychainProbe =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'unavailable' | 'timeout'; readonly fix: string };

export interface ProbeOptions {
  /** Default 10 s: a locked macOS keychain may wait for the user to unlock it. */
  readonly timeoutMs?: number;
  /** Picks the fix text. Default `process.platform`. */
  readonly platform?: string;
}

function keychainFix(platform: string): string {
  switch (platform) {
    case 'darwin':
      return 'Unlock your keychain (over SSH: `security unlock-keychain`), then try again.';
    case 'linux':
      return 'Start a Secret Service provider such as GNOME Keyring in a D-Bus session, then try again.';
    case 'win32':
      return 'Check that Windows Credential Manager is available for this user, then try again.';
    default:
      return 'Make sure the system keychain is available, then try again.';
  }
}

/**
 * 04 §2.8: writes, reads and deletes a random probe item, with a timeout. Any failure, wrong bytes
 * or a timeout means no usable keychain.
 */
export async function probeKeychain(
  keychain: KeychainBackend,
  options: ProbeOptions = {},
): Promise<KeychainProbe> {
  const account = `probe:${encodeHex(randomBytes(16))}`;
  const value = randomBytes(16);
  // The item is deleted before the attempt settles, whatever the read did, so a failed probe leaves
  // nothing behind. After a timeout the attempt keeps running and still deletes it when the keychain
  // answers.
  const attempt = (async () => {
    await keychain.set(account, value);
    // Nothing between set and delete may throw: a failed read is null, a non-byte value is unequal.
    const read: unknown = await keychain.get(account).catch(() => null);
    const same = read instanceof Uint8Array && equalBytes(read, value);
    return (await keychain.delete(account)) && same;
  })().catch(() => false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), options.timeoutMs ?? 10_000);
  });
  const result = await Promise.race([attempt, timeout]);
  clearTimeout(timer);
  if (result === true) return { ok: true };
  return {
    ok: false,
    reason: result === 'timeout' ? 'timeout' : 'unavailable',
    fix: keychainFix(options.platform ?? process.platform),
  };
}

/** The backend recorded per agent at `init` (07 §9.1). */
export type KeyStoreBackendKind = 'keychain' | 'file';

export type KeyStoreSelection =
  | { readonly ok: true; readonly backend: KeyStoreBackendKind }
  | {
      readonly ok: false;
      readonly status: 'needs_setup';
      readonly reason: 'no_keychain';
      readonly message: string;
      readonly fix: string;
    }
  | {
      readonly ok: false;
      readonly status: 'refused';
      readonly reason: 'keychain_available';
      readonly message: string;
    };

/** 07 §9.4 copy (string key `needs_setup.no_keychain`). */
const NO_KEYCHAIN =
  "This machine has no system keychain (common in containers, WSL and SSH sessions), so AgentLink can't protect your agent's identity here yet. To keep it in a passphrase-locked file instead, run `agentlink init --keystore file` yourself, in your own terminal.";

/**
 * The backend for a new agent at `init` (04 §2.8, 07 §9.1): the keychain whenever the probe
 * succeeds, and then a file opt-in is refused (there is no forced file mode); without a keychain,
 * `needs_setup` unless the user opted in. `fileOptIn` is true only for an opt-in made in an
 * interactive terminal with no harness marker set; checking that is the caller's job (M1-8f).
 */
export function selectKeyStoreBackend(
  probe: KeychainProbe,
  { fileOptIn }: { readonly fileOptIn: boolean },
): KeyStoreSelection {
  if (probe.ok) {
    return fileOptIn
      ? {
          ok: false,
          status: 'refused',
          reason: 'keychain_available',
          message: 'This machine has a system keychain. AgentLink uses it.',
        }
      : { ok: true, backend: 'keychain' };
  }
  if (fileOptIn) return { ok: true, backend: 'file' };
  return {
    ok: false,
    status: 'needs_setup',
    reason: 'no_keychain',
    message: NO_KEYCHAIN,
    fix: probe.fix,
  };
}
