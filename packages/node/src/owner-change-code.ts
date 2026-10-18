// M1-9z: changing the owner code, the flow behind `agentlink owner change-code` † (04 §2.8
// "Changing the owner code"; 07 §9.3). An owner code that was exposed (typed into a shell, pasted
// into a chat) can be replaced without changing the owner: the same owner seed is re-wrapped under a
// new generated owner code, so the owner keys, the owner fingerprint and every agent card stay valid.
//
// - Guards before anything is read: the AI-app marker (UX guard) and, in the package entry, an
//   interactive terminal; no secret ever comes from an argument, variable, file or pipe.
// - Owner presence: the CURRENT owner code (or opted-in passphrase), at most three tries. With an
//   expected owner (the one the local cards name), the item must unlock to exactly that owner.
// - The new secret is always a generated 120-bit owner code (the `owner init` rules: shown once,
//   last four characters re-typed, screen cleared, never written to a file). A chosen passphrase is
//   not offered: moving to a generated code is the point of the change.
// - The re-wrap never loses the seed (owner-keystore.ts replaceOwnerWrap): stage, verify the staged
//   copy opens with the new code to the same owner, then replace; any failure before the replace
//   leaves the current code working.
// - A recovery kit (`ALKR`, 04 §2.3.2) is never read or changed: it has its own recovery code.
// - Every secret buffer (current secret, seed, new code) is wiped before returning.
import {
  KeyStoreError,
  wipe,
  type Argon2idParams,
  type OwnerPublicKeys,
  type SecretKind,
} from '@agentlink/crypto';
import { generateSecretCode } from '@agentlink/crypto/keystore';
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
  storedOwnerSecretKind,
  type OpenedOwnerItem,
} from './owner-keystore.js';
import { secretLabel } from './owner-operation.js';
import { assertNoHarnessMarker, ttyOwnerTerminal, type OwnerTerminal } from './owner-terminal.js';

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
  /** The short owner fingerprint (11 §5.2): unchanged by the new code. */
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
    'This replaces your owner code with a new one. Your owner fingerprint stays the same, and your agents keep their cards.',
  current: 'First, type your current owner code.',
  wrong: "That owner code wasn't accepted. Check it and try again.",
  refused:
    "The owner code wasn't accepted three times. Nothing was changed. Check the code you saved when you ran `agentlink owner init`.",
  noOwner:
    "No owner is set up on this computer yet. Run `agentlink owner init` yourself, in your own terminal. Don't let your AI run it or see the code it shows.",
  fileUnavailable:
    "This agent's identity is kept in a passphrase-locked file, which this version of AgentLink can't change an owner code for yet. Update AgentLink.",
  unknownBackend:
    "This agent's recorded key store is not one AgentLink knows. Check the agent's config with `agentlink doctor`.",
  fingerprint: (fingerprint: string): string =>
    `Your owner fingerprint: ${fingerprint}. It doesn't change.`,
  // IR-M1-9z-1 F1: the old code stays the only working code until the replace has succeeded, so the
  // owner must keep it until then; discarding it is said only in `done`.
  beforeCode:
    'Store this new owner code off this machine, for example in your password manager. Keep your current owner code too until this finishes. Never type either into a chat or let your AI see them.',
  code: (code: string): string => `Your new owner code: ${code}`,
  retype: 'Type its last four characters to continue:',
  retypeWrong: "That doesn't match. Check the last four characters of your new owner code.",
  retypeFailed:
    "The new owner code wasn't confirmed. Nothing was changed: your current owner code still works. Run `agentlink owner change-code` again.",
  done: (fingerprint: string): string =>
    `Owner code changed. Your old owner code no longer works, so you can now discard it. Your owner fingerprint is still ${fingerprint}.`,
  recoveryKit:
    "If you saved a recovery kit, it isn't changed: it still restores this owner with its own recovery code.",
  // IR-M1-9z-1 F2: a leftover `owner-next` item from an earlier change that didn't finish.
  unfinished:
    "An earlier owner code change didn't finish. Type your current owner code, or the new owner code from that change if the current one no longer works.",
  eitherLabel: 'Owner passphrase or new owner code:',
  cleanedUp:
    'Your current owner code still works, so the unfinished change was cleaned up. Its new owner code will never work: discard it.',
  completeAsk: (fingerprint: string): string =>
    `That is the new owner code from the unfinished change, for owner ${fingerprint}. Finish that change now, so that this code becomes your owner code? [y/N]`,
  completeDeclined:
    'Nothing was changed. Run `agentlink owner change-code` again when you want to finish or clean up the earlier change.',
  completed: (fingerprint: string): string =>
    `Owner code change finished. Use the new owner code from now on; your old owner code no longer works, so you can now discard it. Your owner fingerprint is still ${fingerprint}.`,
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
 * M1-9z: a store-only check for `doctor`: true when a leftover `owner-next` item shows an owner code
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
        'Changing the owner code needs the agent it runs for. Run `agentlink owner change-code`.',
      );
    }
    assertNoHarnessMarker(options.env ?? process.env);
    return changeOwnerCodeWith(osKeychain(), ttyOwnerTerminal(), options);
  });
}
