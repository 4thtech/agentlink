// M1-9z: changing the master code, the flow behind `agentlink owner change-code` † (04 §2.8
// "Changing the master code"; 07 §9.3). A master code that was exposed (typed into a shell, pasted
// into a chat) can be replaced without changing the owner: the same owner seed is re-wrapped under a
// new generated master code, so the owner keys, the ID tag and every agent card stay valid.
//
// - Guards before anything is read: the AI-app marker (UX guard) and, in the package entry, an
//   interactive terminal; no secret ever comes from an argument, variable, file or pipe.
// - Owner presence: the CURRENT master code (or opted-in passphrase), at most three tries. With an
//   expected owner (the one the local cards name), the item must unlock to exactly that owner.
// - The new secret is always a generated 120-bit master code (the `owner init` rules: shown once,
//   last four characters re-typed, screen cleared, never written to a file). A chosen passphrase is
//   not offered: moving to a generated code is the point of the change.
// - The re-wrap never loses the seed (owner-keystore.ts replaceOwnerWrap): stage, verify the staged
//   copy opens with the new code to the same owner, then replace; any failure before the replace
//   leaves the current code working.
// - A recovery kit (`ALKR`, 04 §2.3.2) is never read or changed: it has its own recovery code.
// - Every secret buffer (current secret, seed, new code) is wiped before returning.
import { homedir } from 'node:os';
import { removeUnsavedMarker } from './master-code-unsaved.js';
import {
  KeyStoreError,
  equalBytes,
  wipe,
  type Argon2idParams,
  type OwnerPublicKeys,
  type SecretKind,
} from '@4thtech-io/crypto';
import { generateSecretCode } from '@4thtech-io/crypto/keystore';
import { NodeKeyStoreError } from './errors.js';
import { KEYCHAIN_CALL_TIMEOUT_MS } from './keychain-keystore.js';
import { osKeychain, type KeyStoreBackendKind, type KeychainBackend } from './keychain.js';
import { grouped, retypeMatches } from './owner-init.js';
import {
  OWNER_NEXT_ACCOUNT,
  openOwnerItem,
  ownerFingerprintText,
  ownerKeysCopy,
  promoteStagedOwnerWrap,
  readOwnerItem,
  readStagedOwnerItem,
  removeStagedOwnerItem,
  replaceOwnerWrap,
  sameOwnerKeys,
  stageOwnerWrap,
  storedOwnerSecretKind,
  type OpenedOwnerItem,
} from './owner-keystore.js';
import { secretLabel } from './owner-operation.js';
import { assertNoHarnessMarker, ttyOwnerTerminal, type OwnerTerminal } from './owner-terminal.js';
import { CLI_COMMAND } from './cli-command.js';

export interface ChangeOwnerCodeOptions {
  /** The recorded backend of the agent the command runs for (07 §9.1). */
  readonly backend: KeyStoreBackendKind;
  /**
   * The owner this computer's agents name (from their cards). The owner item must unlock to exactly
   * these keys, or the entry is refused like a wrong code (04 §2.8). Omitted when no local card
   * names an owner: the keys then come from the item itself.
   */
  readonly owner?: OwnerPublicKeys;
  /** Checked for AI-app markers; default process.env. Never read for a secret. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ChangeOwnerCodeResult {
  /** The owner's public keys: unchanged by the new code. */
  readonly owner: OwnerPublicKeys;
  /** The short ID tag (11 §5.2): unchanged by the new code. */
  readonly fingerprint: string;
}

/** Internal options (tests): Argon2id parameters and keychain timeout. */
export interface ChangeOwnerCodeInternals {
  readonly kdf?: Argon2idParams;
  readonly timeoutMs?: number;
}

const ATTEMPTS = 3;

// Fixed copy (11 §5 vocabulary; no value from a file or another party is inserted, I-5).
const COPY = {
  intro:
    'This replaces your master code with a new one. Your ID tag stays the same, and your agents keep their cards.',
  current: 'First, type your current master code.',
  wrong: "That master code wasn't accepted. Check it and try again.",
  refused: `The master code wasn't accepted three times. Nothing was changed. Check the code you saved when you ran \`${CLI_COMMAND} owner init\`.`,
  noOwner: `No owner is set up on this computer yet. Run \`${CLI_COMMAND} owner init\` yourself, in your own terminal. Don't let your AI run it or see the code it shows.`,
  fileUnavailable:
    "This agent's identity is kept in a passphrase-locked file, which this version of AgentLink can't change a master code for yet. Update AgentLink.",
  unknownBackend: `This agent's recorded key store is not one AgentLink knows. Check the agent's config with \`${CLI_COMMAND} doctor\`.`,
  fingerprint: (fingerprint: string): string => `Your ID tag: ${fingerprint}. It doesn't change.`,
  // IR-M1-9z-1 F1: the old code stays the only working code until the replace has succeeded, so the
  // owner must keep it until then; discarding it is said only in `done`.
  beforeCode:
    'Store this new master code off this machine, for example in your password manager. Keep your current master code too until this finishes. Never type either into a chat or let your AI see them.',
  code: (code: string): string => `Your new master code: ${code}`,
  retype: 'Type its last four characters to continue:',
  retypeWrong: "That doesn't match. Check the last four characters of your new master code.",
  retypeFailed: `The new master code wasn't confirmed. Nothing was changed: your current master code still works. Run \`${CLI_COMMAND} owner change-code\` again.`,
  done: (fingerprint: string): string =>
    `Master code changed. Your old master code no longer works, so you can now discard it. Your ID tag is still ${fingerprint}.`,
  recoveryKit:
    "If you saved a recovery kit, it isn't changed: it still restores this owner with its own recovery code.",
  // IR-M1-9z-1 F2: a leftover `owner-next` item from an earlier change that didn't finish.
  unfinished:
    "An earlier master code change didn't finish. Type your current master code, or the new master code from that change if the current one no longer works.",
  eitherLabel: 'Owner passphrase or new master code:',
  cleanedUp:
    'Your current master code still works, so the unfinished change was cleaned up. Its new master code will never work: discard it.',
  completeAsk: (fingerprint: string): string =>
    `That is the new master code from the unfinished change, for owner ${fingerprint}. Finish that change now, so that this code becomes your master code? [y/N]`,
  completeDeclined: `Nothing was changed. Run \`${CLI_COMMAND} owner change-code\` again when you want to finish or clean up the earlier change.`,
  completed: (fingerprint: string): string =>
    `Master code change finished. Use the new master code from now on; your old master code no longer works, so you can now discard it. Your ID tag is still ${fingerprint}.`,
} as const;

/** Which item the typed secret opened: the `owner` item, or the staged one of an unfinished change. */
type Opened =
  | { readonly from: 'owner'; readonly item: OpenedOwnerItem }
  | { readonly from: 'staged'; readonly item: OpenedOwnerItem };

const rejected = (error: unknown): boolean =>
  (error instanceof KeyStoreError && error.code === 'presence_rejected') ||
  (error instanceof NodeKeyStoreError &&
    (error.code === 'owner_missing' || error.code === 'owner_mismatch'));

/**
 * Reads the owner secret at most three times. It opens the `owner` item when there is a usable one;
 * when an unfinished change left a staged item and the secret does not open the `owner` item, it
 * tries the staged item too. Returns which one opened, or refuses.
 */
async function openWithSecret(
  keychain: KeychainBackend,
  terminal: OwnerTerminal,
  label: string,
  expected: OwnerPublicKeys | undefined,
  hasOwnerItem: boolean,
  hasStaged: boolean,
  timeoutMs: number,
): Promise<Opened> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const secret = await terminal.readSecret(label);
    try {
      if (hasOwnerItem) {
        try {
          // openOwnerItem wipes the copy it is given whether or not it opens.
          const item = await openOwnerItem(
            keychain,
            { kind: 'passphrase', secret: secret.slice() },
            expected,
            timeoutMs,
          );
          return { from: 'owner', item };
        } catch (error) {
          if (!hasStaged || !rejected(error)) throw error;
        }
      }
      if (hasStaged) {
        const item = await openOwnerItem(
          keychain,
          { kind: 'passphrase', secret: secret.slice() },
          expected,
          timeoutMs,
          OWNER_NEXT_ACCOUNT,
        );
        return { from: 'staged', item };
      }
    } catch (error) {
      if (error instanceof KeyStoreError && error.code === 'presence_rejected') {
        if (attempt < ATTEMPTS - 1) terminal.write(COPY.wrong);
        continue;
      }
      if (error instanceof NodeKeyStoreError && error.code === 'owner_missing') {
        throw new NodeKeyStoreError('owner_missing', COPY.noOwner);
      }
      throw error;
    } finally {
      wipe(secret);
    }
  }
  throw new NodeKeyStoreError('owner_secret_refused', COPY.refused);
}

async function confirmNewCode(terminal: OwnerTerminal, code: Uint8Array): Promise<void> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const typed = await terminal.readSecret(COPY.retype);
    const ok = retypeMatches(typed, code);
    wipe(typed);
    if (ok) return;
    terminal.write(COPY.retypeWrong);
  }
  terminal.clearScreen();
  throw new NodeKeyStoreError('owner_secret_refused', COPY.retypeFailed);
}

/**
 * Runs `owner change-code` against `keychain` on `terminal`. Nothing is written before the current
 * secret opened the owner item and the owner confirmed the new code; then only the re-wrap.
 *
 * IR-M1-9z-1 F2: a leftover `owner-next` item (an earlier change that didn't finish) is noticed
 * first. If the typed secret opens the `owner` item, the leftover is removed (the seed is safe in the
 * `owner` item) and the change goes on as usual. If it opens only the leftover (the new code of the
 * unfinished change, to the expected owner), the owner sees the fingerprint and may finish that
 * change: the leftover replaces the `owner` item, which must be unchanged since the start.
 */
export async function changeOwnerCodeWith(
  keychain: KeychainBackend,
  terminal: OwnerTerminal,
  options: ChangeOwnerCodeOptions,
  internals: ChangeOwnerCodeInternals = {},
): Promise<ChangeOwnerCodeResult> {
  assertNoHarnessMarker(options.env ?? process.env);
  if (options.backend === 'file') {
    throw new NodeKeyStoreError('backend_unavailable', COPY.fileUnavailable);
  }
  if (options.backend !== 'keychain') {
    throw new NodeKeyStoreError('backend_unavailable', COPY.unknownBackend);
  }
  const expected = options.owner === undefined ? undefined : ownerKeysCopy(options.owner);
  const timeoutMs = internals.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS;
  // Ciphertext and header bytes only: no secret is read and nothing is unlocked before the prompt.
  const staged = await readStagedOwnerItem(keychain, timeoutMs);
  let ownerSeen: Uint8Array | null = null;
  try {
    let kind: SecretKind | null;
    try {
      kind = await storedOwnerSecretKind(keychain, timeoutMs);
    } catch (error) {
      // A damaged `owner` item is still recoverable from a leftover staged item.
      if (staged === null || !(error instanceof NodeKeyStoreError)) throw error;
      kind = null;
    }
    if (kind === null && staged === null) {
      throw new NodeKeyStoreError('owner_missing', COPY.noOwner);
    }
    if (staged !== null) ownerSeen = await readOwnerItem(keychain, timeoutMs);

    terminal.write(COPY.intro);
    let label = secretLabel(kind ?? 1);
    if (staged !== null) {
      terminal.write(COPY.unfinished);
      if (kind === 2) label = COPY.eitherLabel;
    } else {
      terminal.write(COPY.current);
    }
    const opened = await openWithSecret(
      keychain,
      terminal,
      label,
      expected,
      kind !== null,
      staged !== null,
      timeoutMs,
    );
    if (opened.from === 'staged') {
      return await finishUnfinished(keychain, terminal, opened.item, ownerSeen, timeoutMs);
    }
    if (staged !== null) {
      // The `owner` item opened with the owner's secret: the leftover is stale; remove it safely.
      await removeStagedOwnerItem(keychain, staged, timeoutMs);
      terminal.write(COPY.cleanedUp);
    }
    return await changeOpened(keychain, terminal, opened.item, internals, timeoutMs);
  } finally {
    wipe(staged, ownerSeen);
  }
}

/** The usual change: a new generated code, confirmed, then the safe re-wrap. */
async function changeOpened(
  keychain: KeychainBackend,
  terminal: OwnerTerminal,
  opened: OpenedOwnerItem,
  internals: ChangeOwnerCodeInternals,
  timeoutMs: number,
): Promise<ChangeOwnerCodeResult> {
  let code: Uint8Array | undefined;
  try {
    const fingerprint = ownerFingerprintText(opened.owner);
    terminal.write(COPY.fingerprint(fingerprint));
    terminal.write(COPY.beforeCode);
    code = generateSecretCode();
    terminal.write(COPY.code(grouped(code)));
    await confirmNewCode(terminal, code);
    terminal.clearScreen();
    await replaceOwnerWrap(keychain, opened.seed, opened.owner, opened.blob, code, {
      ...(internals.kdf === undefined ? {} : { kdf: internals.kdf }),
      timeoutMs,
    });
    terminal.write(COPY.done(fingerprint));
    terminal.write(COPY.recoveryKit);
    return Object.freeze({ owner: ownerKeysCopy(opened.owner), fingerprint });
  } finally {
    wipe(opened.seed, opened.blob, code);
  }
}

/** Finishes an unfinished change whose staged item the owner just opened, after a yes. */
async function finishUnfinished(
  keychain: KeychainBackend,
  terminal: OwnerTerminal,
  opened: OpenedOwnerItem,
  ownerSeen: Uint8Array | null,
  timeoutMs: number,
): Promise<ChangeOwnerCodeResult> {
  try {
    const fingerprint = ownerFingerprintText(opened.owner);
    if (!(await terminal.confirm(COPY.completeAsk(fingerprint)))) {
      throw new NodeKeyStoreError('owner_prompt_cancelled', COPY.completeDeclined);
    }
    await promoteStagedOwnerWrap(keychain, opened.blob, ownerSeen, timeoutMs);
    terminal.write(COPY.completed(fingerprint));
    terminal.write(COPY.recoveryKit);
    return Object.freeze({ owner: ownerKeysCopy(opened.owner), fingerprint });
  } finally {
    wipe(opened.seed, opened.blob);
  }
}

/**
 * M1-9z: a store-only check for `doctor`: true when a leftover `owner-next` item shows a master code
 * change that didn't finish. It reads only ciphertext, asks for nothing and unlocks nothing; the
 * bytes are wiped at once. `owner change-code` finishes or cleans it up.
 */
export function hasUnfinishedOwnerCodeChange(): Promise<boolean> {
  return Promise.resolve().then(async () => {
    const staged = await readStagedOwnerItem(osKeychain());
    if (staged === null) return false;
    wipe(staged);
    return true;
  });
}

/**
 * The package entry (index.ts): `owner change-code` against the OS keychain on this process's own
 * terminal. Refused with an AI-app marker set (`harness_detected`) or without an interactive
 * terminal (`owner_prompt_unavailable`), before the keychain is touched.
 */
export function changeOwnerCode(options: ChangeOwnerCodeOptions): Promise<ChangeOwnerCodeResult> {
  return Promise.resolve().then(() => {
    if (typeof options !== 'object' || options === null) {
      throw new NodeKeyStoreError(
        'owner_operation_invalid',
        `Changing the master code needs the agent it runs for. Run \`${CLI_COMMAND} owner change-code\`.`,
      );
    }
    assertNoHarnessMarker(options.env ?? process.env);
    return changeOwnerCodeWith(osKeychain(), ttyOwnerTerminal(), options).then(async (result) => {
      // REL051-CF3: a new master code replaced any that was never saved.
      await removeUnsavedMarker(homedir());
      return result;
    });
  });
}

// --- UX1113 WP-S2: the app's Replace master code (04 §2.5 "Touch ID & master code page") ---------
//
// The same `owner-next` protocol as `owner change-code`, split at the read-back so the owner sees the
// new code in the app and types it back before anything replaces the `owner` item:
//
// 1. stage (after the approval server's presence gate opened the owner store for this request): a
//    leftover `owner-next` item is never overwritten (`unfinished`: `owner change-code` in the
//    owner's own terminal finishes or cleans it up); the `owner` item is read as it is now; a new
//    generated 120-bit master code wraps the same seed into `owner-next`, read back and opened to the
//    same owner (stageOwnerWrap). The `owner` item is untouched: the current code keeps working.
// 2. open: the code the owner typed back must open exactly that staged item to the same owner.
// 3. finish: the staged item replaces the `owner` item only while that is still the item read in
//    step 1, and is removed only after an exact read-back (promoteStagedOwnerWrap). Any failure keeps
//    `owner-next`, so the seed is never lost.
// 4. drop: an unfinished change (Cancel, expiry, three wrong entries, the server closing) removes the
//    staged item only while it is still those bytes; the current code keeps working.
//
// Neither the seed nor the new code is kept: the caller wipes the seed right after staging, and the
// code's bytes are wiped once its display text is made. Nothing here logs or emits.

/** A staged change: ciphertext and public keys only. */
export interface StagedOwnerCodeChange {
  /** The `owner-next` blob this change wrote (ciphertext). */
  readonly staged: Uint8Array;
  /** The `owner` item as read when the change was staged (ciphertext). */
  readonly ownerSeen: Uint8Array;
  readonly owner: OwnerPublicKeys;
}

export type StageOwnerCodeOutcome =
  | {
      readonly status: 'staged';
      readonly change: StagedOwnerCodeChange;
      /** The new master code in six groups of four, for display once. */
      readonly code: string;
    }
  /** A leftover `owner-next` item: nothing was written. */
  | { readonly status: 'unfinished' };

/**
 * Step 1. `seed` is the owner seed the caller's presence opened (not modified; the caller wipes it);
 * it must derive exactly `owner`.
 */
export async function stageOwnerCodeChange(
  keychain: KeychainBackend,
  seed: Uint8Array,
  owner: OwnerPublicKeys,
  internals: ChangeOwnerCodeInternals = {},
): Promise<StageOwnerCodeOutcome> {
  const timeoutMs = internals.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS;
  const keys = ownerKeysCopy(owner);
  if (!sameOwnerKeys(seed, keys)) {
    throw new NodeKeyStoreError('owner_mismatch', 'The owner key does not match.');
  }
  const leftover = await readStagedOwnerItem(keychain, timeoutMs);
  if (leftover !== null) {
    wipe(leftover);
    return { status: 'unfinished' };
  }
  const ownerSeen = await readOwnerItem(keychain, timeoutMs);
  if (ownerSeen === null) throw new NodeKeyStoreError('owner_missing', COPY.noOwner);
  const code = generateSecretCode();
  try {
    const staged = await stageOwnerWrap(keychain, seed, keys, code, {
      ...(internals.kdf === undefined ? {} : { kdf: internals.kdf }),
      timeoutMs,
    });
    return Object.freeze({
      status: 'staged' as const,
      change: Object.freeze({ staged, ownerSeen, owner: keys }),
      code: grouped(code),
    });
  } catch (error) {
    wipe(ownerSeen);
    throw error;
  } finally {
    wipe(code);
  }
}

/**
 * Step 2. True when `typed` (wiped here) opens exactly the staged item of `change` to its owner;
 * false for a wrong code. A staged item that is gone or changed throws.
 */
export async function openStagedOwnerCode(
  keychain: KeychainBackend,
  change: StagedOwnerCodeChange,
  typed: Uint8Array,
  internals: ChangeOwnerCodeInternals = {},
): Promise<boolean> {
  const timeoutMs = internals.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS;
  let opened: OpenedOwnerItem;
  try {
    // openOwnerItem wipes the secret it is given, whether or not it opens.
    opened = await openOwnerItem(
      keychain,
      { kind: 'passphrase', secret: typed },
      change.owner,
      timeoutMs,
      OWNER_NEXT_ACCOUNT,
    );
  } catch (error) {
    if (error instanceof KeyStoreError && error.code === 'presence_rejected') return false;
    throw error;
  }
  try {
    if (!equalBytes(opened.blob, change.staged)) {
      throw new NodeKeyStoreError('owner_mismatch', 'The staged change is not this one.');
    }
    return true;
  } finally {
    wipe(opened.seed, opened.blob);
  }
}

/** Step 3: the staged item replaces the `owner` item (all or nothing). */
export async function finishOwnerCodeChange(
  keychain: KeychainBackend,
  change: StagedOwnerCodeChange,
  internals: ChangeOwnerCodeInternals = {},
): Promise<void> {
  await promoteStagedOwnerWrap(
    keychain,
    change.staged,
    change.ownerSeen,
    internals.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS,
  );
}

/** Step 4: removes this change's staged item (only while it is still those bytes). */
export async function dropOwnerCodeChange(
  keychain: KeychainBackend,
  change: StagedOwnerCodeChange,
  internals: ChangeOwnerCodeInternals = {},
): Promise<boolean> {
  return removeStagedOwnerItem(
    keychain,
    change.staged,
    internals.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS,
  ).catch(() => false);
}

/** Wipes the ciphertext a change holds (after finish or drop). */
export function wipeOwnerCodeChange(change: StagedOwnerCodeChange): void {
  wipe(change.staged, change.ownerSeen);
}
