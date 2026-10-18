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
import { KeyStoreError, wipe, type Argon2idParams, type OwnerPublicKeys } from '@agentlink/crypto';
import { generateSecretCode } from '@agentlink/crypto/keystore';
import { NodeKeyStoreError } from './errors.js';
import { KEYCHAIN_CALL_TIMEOUT_MS } from './keychain-keystore.js';
import { osKeychain, type KeyStoreBackendKind, type KeychainBackend } from './keychain.js';
import { grouped, retypeMatches } from './owner-init.js';
import {
  openOwnerItem,
  ownerFingerprintText,
  ownerKeysCopy,
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
  beforeCode:
    'Store this new owner code off this machine, for example in your password manager, and delete the old one there. Never type it into a chat or let your AI see it.',
  code: (code: string): string => `Your new owner code: ${code}`,
  retype: 'Type its last four characters to continue:',
  retypeWrong: "That doesn't match. Check the last four characters of your new owner code.",
  retypeFailed:
    "The new owner code wasn't confirmed. Nothing was changed: your current owner code still works. Run `agentlink owner change-code` again.",
  done: (fingerprint: string): string =>
    `Owner code changed. Your old owner code no longer works. Your owner fingerprint is still ${fingerprint}.`,
  recoveryKit:
    "If you saved a recovery kit, it isn't changed: it still restores this owner with its own recovery code.",
} as const;

/** Reads the current owner secret at most three times; returns the opened owner item or refuses. */
async function openWithCurrentSecret(
  keychain: KeychainBackend,
  terminal: OwnerTerminal,
  label: string,
  expected: OwnerPublicKeys | undefined,
  timeoutMs: number,
): Promise<OpenedOwnerItem> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const secret = await terminal.readSecret(label);
    try {
      // openOwnerItem wipes the secret whether or not it opens.
      return await openOwnerItem(keychain, { kind: 'passphrase', secret }, expected, timeoutMs);
    } catch (error) {
      if (error instanceof KeyStoreError && error.code === 'presence_rejected') {
        if (attempt < ATTEMPTS - 1) terminal.write(COPY.wrong);
        continue;
      }
      if (error instanceof NodeKeyStoreError && error.code === 'owner_missing') {
        throw new NodeKeyStoreError('owner_missing', COPY.noOwner);
      }
      throw error;
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
  // Header byte only: no secret is read and nothing is unlocked before the prompt.
  const kind = await storedOwnerSecretKind(keychain, timeoutMs);
  if (kind === null) throw new NodeKeyStoreError('owner_missing', COPY.noOwner);

  terminal.write(COPY.intro);
  terminal.write(COPY.current);
  const opened = await openWithCurrentSecret(
    keychain,
    terminal,
    secretLabel(kind),
    expected,
    timeoutMs,
  );
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
