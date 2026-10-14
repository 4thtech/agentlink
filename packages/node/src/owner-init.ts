// M1-8c: creating the owner key on a keychain machine, the flow behind `agentlink owner init` †
// (04 §2.2, §2.8 "owner init rules"; 07 §9.3, §9.4; D-67). Until the M1b setup page exists the owner
// runs it personally, in a terminal the agent does not control.
//
// - Default: a generated 120-bit owner code (secretKind 1), shown once, re-typed, screen cleared.
// - A chosen owner passphrase (secretKind 2) only after an explicit opt-in that first states the
//   offline-guessing exposure (04 §2.2); at least 12 code points after NFKC (D-66 (3)).
// - Never overwrites: an existing `owner` item, or an owner the agent card already names, refuses.
// - The code is display-only: never written to a file, never offered as one (04 §2.8).
// - The owner fingerprint and the lost-code consequence are shown before the code.
// - File-KeyStore machines: a chosen passphrase is refused; their `owner.alko` is M1-8f.
import { equalBytes, wipe, type Argon2idParams, type OwnerPublicKeys } from '@agentlink/crypto';
import { generateSecretCode } from '@agentlink/crypto/keystore';
import { NodeKeyStoreError } from './errors.js';
import { osKeychain, type KeyStoreBackendKind, type KeychainBackend } from './keychain.js';
import {
  assertOwnerPassphraseLength,
  newOwnerSeed,
  ownerFingerprintText,
  readOwnerItem,
  secretRefused,
  storeOwnerSeed,
} from './owner-keystore.js';
import { assertNoHarnessMarker, ttyOwnerTerminal, type OwnerTerminal } from './owner-terminal.js';

export interface OwnerInitOptions {
  /** The agent's recorded backend (07 §9.1). */
  readonly backend: KeyStoreBackendKind;
  /** The explicit opt-in to a chosen owner passphrase (keychain machines only, D-67). */
  readonly choosePassphrase?: boolean;
  /** The owner the agent card already names, if any: then `owner init` refuses (04 §2.8). */
  readonly cardOwner?: OwnerPublicKeys;
  /** Checked for AI-app markers; default process.env. Never read for a secret. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface OwnerInitResult {
  /** The new owner's public keys, for the agent card (04 §2.4). */
  readonly owner: OwnerPublicKeys;
  /** The short owner fingerprint (11 §5.2). */
  readonly fingerprint: string;
  /** 1 = generated owner code, 2 = chosen owner passphrase. */
  readonly secretKind: 1 | 2;
}

/** Internal options (tests): Argon2id parameters and keychain timeout. */
export interface OwnerInitInternals {
  readonly kdf?: Argon2idParams;
  readonly timeoutMs?: number;
}

const ATTEMPTS = 3;

// 07 §9.4 copy (string keys cli.owner_init.*). "Owner code" and "owner passphrase" are the 11 §5.5
// names; never "password".
const COPY = {
  ownerExists: (fingerprint: string): string =>
    `This agent already has an owner (${fingerprint}). AgentLink won't replace it. To use an owner from another device, link it from that device.`,
  fingerprint: (fingerprint: string): string => `Your owner fingerprint: ${fingerprint}.`,
  beforeCode:
    "Store this owner code off this machine, for example in your password manager. Without it, nobody can approve for this agent or remove it, and until backups are available you'd have to set up a new agent and pair again.",
  beforePassphrase:
    "Keep this owner passphrase off this machine, for example in your password manager. Without it, nobody can approve for this agent or remove it, and until backups are available you'd have to set up a new agent and pair again.",
  code: (grouped: string): string => `Your owner code: ${grouped}`,
  retype: 'Type its last four characters to continue:',
  retypeWrong: "That doesn't match. Check the last four characters of your owner code.",
  retypeFailed:
    "The owner code wasn't confirmed. Nothing was saved; run `agentlink owner init` again.",
  passphraseNote:
    'A passphrase you choose is weaker than a generated owner code. Any program running as you on this computer, including your AI app, can read the locked copy your passphrase protects and try to guess the passphrase offline. A generated owner code makes that infeasible.',
  passphraseConfirm: 'Use your own owner passphrase anyway? [y/N]',
  passphrase: 'Owner passphrase (at least 12 characters):',
  passphraseAgain: 'Type it again:',
  passphraseMismatch: "The two entries don't match.",
  done: (fingerprint: string): string =>
    `Owner set up. Your owner fingerprint: ${fingerprint}. Check that \`agentlink doctor\` shows the same one.`,
  fileNoPassphrase:
    'On a computer without a system keychain, approvals are protected by a generated owner code only.',
  fileUnavailable:
    "This agent's identity is kept in a passphrase-locked file, which this version of AgentLink can't set up an owner for yet. Update AgentLink.",
} as const;

/** The code as groups of four, for display only (04 §2.8). */
function grouped(code: Uint8Array): string {
  const text = new TextDecoder().decode(code);
  return (text.match(/.{1,4}/g) ?? []).join(' ');
}

/** 04 §2.8 kind 1, step 4: `0`, `1` and `8` read as `O`, `I` and `B`. */
const LOOKALIKE: Readonly<Record<number, number>> = { 0x30: 0x4f, 0x31: 0x49, 0x38: 0x42 };

/**
 * The last group of the code, re-typed, read the way the code itself is read (04 §2.8 kind 1):
 * spaces and dashes ignored, ASCII upper case, and 0/1/8 as O/I/B.
 */
function retypeMatches(typed: Uint8Array, code: Uint8Array): boolean {
  const cleaned: number[] = [];
  for (const byte of typed) {
    if (byte === 0x20 || byte === 0x2d) continue;
    const upper = byte >= 0x61 && byte <= 0x7a ? byte - 0x20 : byte;
    cleaned.push(LOOKALIKE[upper] ?? upper);
  }
  const typedBytes = Uint8Array.from(cleaned);
  cleaned.fill(0);
  const ok = equalBytes(typedBytes, code.subarray(code.length - 4));
  wipe(typedBytes);
  return ok;
}

/**
 * Runs `owner init` against `keychain` on `terminal`. Nothing is written until the owner confirmed
 * the code (or typed the passphrase twice); every secret buffer is wiped before returning.
 */
export async function initOwnerWith(
  keychain: KeychainBackend,
  terminal: OwnerTerminal,
  options: OwnerInitOptions,
  internals: OwnerInitInternals = {},
): Promise<OwnerInitResult> {
  assertNoHarnessMarker(options.env ?? process.env);
  const choose = options.choosePassphrase === true;
  if (options.backend === 'file') {
    if (choose) throw new NodeKeyStoreError('owner_secret_refused', COPY.fileNoPassphrase);
    throw new NodeKeyStoreError('backend_unavailable', COPY.fileUnavailable);
  }
  if (options.backend !== 'keychain') {
    throw new NodeKeyStoreError(
      'backend_unavailable',
      "This agent's recorded key store is not one AgentLink knows. Check the agent's config with `agentlink doctor`.",
    );
  }
  if (options.cardOwner !== undefined) {
    throw new NodeKeyStoreError(
      'owner_exists',
      COPY.ownerExists(ownerFingerprintText(options.cardOwner)),
    );
  }
  const existing = await readOwnerItem(keychain, internals.timeoutMs);
  if (existing !== null) {
    wipe(existing);
    throw new NodeKeyStoreError(
      'owner_exists',
      "This agent already has an owner. AgentLink won't replace it. To use an owner from another device, link it from that device.",
    );
  }

  let usePassphrase = false;
  if (choose) {
    terminal.write(COPY.passphraseNote);
    usePassphrase = await terminal.confirm(COPY.passphraseConfirm);
  }

  const { seed, keys } = newOwnerSeed();
  let secret: Uint8Array | undefined;
  try {
    const fingerprint = ownerFingerprintText(keys);
    // 04 §2.8 owner init rules: the fingerprint and what a lost secret means come first, on both
    // paths (IR-M1-8c-1 F-5).
    terminal.write(COPY.fingerprint(fingerprint));
    if (usePassphrase) {
      terminal.write(COPY.beforePassphrase);
      secret = await readNewPassphrase(terminal);
    } else {
      terminal.write(COPY.beforeCode);
      secret = generateSecretCode();
      terminal.write(COPY.code(grouped(secret)));
      await confirmCode(terminal, secret);
      terminal.clearScreen();
    }
    await storeOwnerSeed(keychain, seed, { secret, secretKind: usePassphrase ? 2 : 1 }, internals);
    terminal.write(COPY.done(fingerprint));
    return Object.freeze({ owner: keys, fingerprint, secretKind: usePassphrase ? 2 : 1 });
  } finally {
    wipe(seed, secret);
  }
}

async function confirmCode(terminal: OwnerTerminal, code: Uint8Array): Promise<void> {
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

/** Reads a chosen owner passphrase twice; D-66 (3) length rule; three attempts. */
async function readNewPassphrase(terminal: OwnerTerminal): Promise<Uint8Array> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const first = await terminal.readSecret(COPY.passphrase);
    try {
      assertOwnerPassphraseLength(first);
    } catch (error) {
      wipe(first);
      if (error instanceof NodeKeyStoreError) {
        terminal.write(error.message);
        continue;
      }
      throw error;
    }
    const second = await terminal.readSecret(COPY.passphraseAgain);
    const same = equalBytes(first, second);
    wipe(second);
    if (same) return first;
    wipe(first);
    terminal.write(COPY.passphraseMismatch);
  }
  throw secretRefused();
}

/**
 * The package entry (index.ts): `owner init` against the OS keychain on this process's own terminal.
 * Refused with an AI-app marker set (`harness_detected`) or without an interactive terminal
 * (`owner_prompt_unavailable`), before the keychain is touched.
 */
export function initOwner(options: OwnerInitOptions): Promise<OwnerInitResult> {
  return Promise.resolve().then(() => {
    assertNoHarnessMarker(options.env ?? process.env);
    return initOwnerWith(osKeychain(), ttyOwnerTerminal(), options);
  });
}
