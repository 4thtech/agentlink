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
// - M1-8h: in the same owner operation, the agent's first card (04 §2.5 "the card signature at owner
//   setup"; owner-first-card.ts). The new owner is stored, unlocked once with the secret still in
//   memory (no second entry), and core `identity.init` gets a session that signs exactly one card for
//   this agent and this owner. All or nothing: if no card naming this owner is stored, the new owner
//   item is removed again, so the owner can simply run `owner init` again. An agent that already has
//   a card is refused before any code is shown (never replaces an owner or a card).
// - M1-8h-b (IR-M1-8h-1): the rollback removes the owner item only while it is still exactly the
//   item this run stored (L2); before the code is shown, the owner is asked for the display name the
//   card commits to (11 §5; Enter keeps the local agent name).
import {
  OWNER_SESSION_DEFAULT_TTL_MS,
  encodeHex0x,
  equalBytes,
  verifyAgentCard,
  wipe,
  type AgentCard,
  type Argon2idParams,
  type OwnerPublicKeys,
} from '@4thtech-io/crypto';
import { generateSecretCode } from '@4thtech-io/crypto/keystore';
import { restrictName } from '@4thtech-io/core';
import { NodeKeyStoreError } from './errors.js';
import { KEYCHAIN_CALL_TIMEOUT_MS } from './keychain-keystore.js';
import {
  assertAgentId,
  osKeychain,
  type KeyStoreBackendKind,
  type KeychainBackend,
} from './keychain.js';
import { FirstCardSession, type FirstAgentCard } from './owner-first-card.js';

export type { FirstAgentCard } from './owner-first-card.js';
import {
  KeychainOwnerKeyStore,
  assertOwnerPassphraseLength,
  newOwnerSeed,
  ownerFingerprintText,
  readOwnerItem,
  removeOwnerItemIfOurs,
  secretRefused,
  storeOwnerSeed,
} from './owner-keystore.js';
import { assertPrintable } from './owner-operation.js';
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
  /**
   * M1-8h: the agent whose first card this operation signs (owner-first-card.ts). Required by the
   * package entry (`initOwner`); internal callers that set up an owner alone (tests) omit it.
   */
  readonly firstCard?: FirstAgentCard;
}

/** The package entry's options: `owner init` always issues the agent's first card (M1-8h). */
export type OwnerSetupOptions = OwnerInitOptions & { readonly firstCard: FirstAgentCard };

export interface OwnerInitResult {
  /** The new owner's public keys, for the agent card (04 §2.4). */
  readonly owner: OwnerPublicKeys;
  /** The short owner fingerprint (11 §5.2). */
  readonly fingerprint: string;
  /** 1 = generated owner code, 2 = chosen owner passphrase. */
  readonly secretKind: 1 | 2;
  /** M1-8h: the first card, signed by the new owner and stored, when `firstCard` was given. */
  readonly card?: AgentCard;
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
  ownerOnMachine:
    "An owner is already set up on this computer, so AgentLink won't create another. To give this agent a card from it, run `agentlink owner add-agent --agent <name>` yourself, in your own terminal.",
  ownerExistsCard:
    "This agent already has an owner. AgentLink won't replace it. To use an owner from another device, link it from that device.",
  cardFailed:
    "Your agent's card couldn't be signed, so the owner wasn't saved. Run `agentlink owner init` again.",
  cardUnknown:
    "Owner setup didn't finish. Run `agentlink doctor` in your own terminal to see what is missing.",
  keychainFailed:
    'The system keychain refused the request. Unlock it and try again; `agentlink doctor` shows what is wrong.',
  // M1-8h-b: the display-name prompt (11 §5: the name is self-declared, 04 §2.4).
  nameNote: 'Contacts see this name labelled as self-declared. You can keep the suggested one.',
  nameQuestion: (suggested: string): string =>
    `Your agent's name for contacts (press Enter for "${suggested}"):`,
  nameRefused:
    'Use up to 32 letters, digits, spaces, dots, apostrophes or hyphens, in one script, without words such as "owner" or "verified".',
  nameKept: (suggested: string): string => `Keeping "${suggested}" as your agent's name.`,
} as const;

/** The code as groups of four, for display only (04 §2.8). */
export function grouped(code: Uint8Array): string {
  const text = new TextDecoder().decode(code);
  return (text.match(/.{1,4}/g) ?? []).join(' ');
}

/** 04 §2.8 kind 1, step 4: `0`, `1` and `8` read as `O`, `I` and `B`. */
const LOOKALIKE: Readonly<Record<number, number>> = { 0x30: 0x4f, 0x31: 0x49, 0x38: 0x42 };

/**
 * The last group of the code, re-typed, read the way the code itself is read (04 §2.8 kind 1):
 * spaces and dashes ignored, ASCII upper case, and 0/1/8 as O/I/B.
 */
export function retypeMatches(typed: Uint8Array, code: Uint8Array): boolean {
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
  const first = options.firstCard;
  if (first !== undefined) {
    assertAgentId(first.agent);
    // Never replaces a card (04 §2.8): an agent with a card already has an owner.
    if ((await first.identity.get()) !== undefined) {
      throw new NodeKeyStoreError('owner_exists', COPY.ownerExistsCard);
    }
  }
  const existing = await readOwnerItem(keychain, internals.timeoutMs);
  if (existing !== null) {
    wipe(existing);
    // D-78 (04 §2.8): one owner per OS user owns many agents; never a second owner.
    throw new NodeKeyStoreError('owner_exists', COPY.ownerOnMachine);
  }

  // M1-8h-b: the display name the first card commits to, asked before any code is shown.
  const named = first === undefined ? undefined : await withDisplayName(terminal, first);

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
    const blob = await storeOwnerSeed(
      keychain,
      seed,
      { secret, secretKind: usePassphrase ? 2 : 1 },
      internals,
    );
    const card =
      named === undefined
        ? undefined
        : await issueFirstCard(keychain, keys, secret, named, blob, internals.timeoutMs);
    terminal.write(COPY.done(fingerprint));
    return Object.freeze({
      owner: keys,
      fingerprint,
      secretKind: usePassphrase ? 2 : 1,
      ...(card === undefined ? {} : { card }),
    });
  } finally {
    wipe(seed, secret);
  }
}

/** True when `card` is a verified stored card for `agent` that names exactly `owner`. */
function namesOwner(
  stored: { card: AgentCard; cardSig: string; cardAgentSig: string } | undefined,
  agent: string,
  owner: OwnerPublicKeys,
): stored is { card: AgentCard; cardSig: string; cardAgentSig: string } {
  return (
    stored !== undefined &&
    stored.card.agentEvm === agent &&
    stored.card.ownerEvm === encodeHex0x(owner.ownerEvm) &&
    stored.card.ownerNostr === encodeHex0x(owner.ownerNostr) &&
    stored.card.ownerEnc === encodeHex0x(owner.ownerEnc) &&
    verifyAgentCard(stored.card, stored.cardSig, stored.cardAgentSig)
  );
}

/** M1-11s-c: what signFirstCardWith found in core afterwards. */
export type FirstCardOutcome =
  | { readonly kind: 'signed'; readonly card: AgentCard }
  /** No verified card naming this owner is stored: the caller rolls the new owner back. */
  | { readonly kind: 'not_signed' }
  /** Core could not be read back: whether a card names this owner is unknown (keep the owner). */
  | { readonly kind: 'unknown' };

/**
 * M1-8h, shared with the first-run page's owner setup (M1-11s-c): signs and stores the first card
 * with the owner just stored, unlocked once with `secret` (a copy; `secret` itself is wiped by the
 * caller), through a FirstCardSession that signs exactly one card for this agent and owner. Whatever
 * happens, the outcome is read back from core: a verified card for this agent naming this owner is
 * `signed`; anything else is `not_signed`, or `unknown` when core could not be read. Nothing is
 * rolled back here; the error text is never shown (I-5).
 */
export async function signFirstCardWith(
  keychain: KeychainBackend,
  owner: OwnerPublicKeys,
  secret: Uint8Array,
  first: FirstAgentCard,
  timeoutMs: number = KEYCHAIN_CALL_TIMEOUT_MS,
): Promise<FirstCardOutcome> {
  try {
    const store = await KeychainOwnerKeyStore.open(keychain, owner, { timeoutMs });
    try {
      // unlock wipes the copy it is given (OwnerKeyStore contract).
      const inner = await store.unlock(
        { kind: 'passphrase', secret: secret.slice() },
        { ttlMs: OWNER_SESSION_DEFAULT_TTL_MS },
      );
      const session = new FirstCardSession(inner, first.agent, owner);
      try {
        await first.identity.init({
          owner: session,
          ownerKeys: owner,
          name: first.name,
          relays: first.relays,
        });
      } finally {
        await session.close();
      }
    } finally {
      await store.close();
    }
  } catch {
    // Decided below from what core stored, never from the error (whose text is not shown).
  }
  let stored: Awaited<ReturnType<FirstAgentCard['identity']['get']>>;
  try {
    stored = await first.identity.get();
  } catch {
    return { kind: 'unknown' };
  }
  if (namesOwner(stored, first.agent, owner)) return { kind: 'signed', card: stored.card };
  return { kind: 'not_signed' };
}

/**
 * M1-8h: signs and stores the first card (signFirstCardWith). A verified card for this agent naming
 * this owner is success; anything else removes the new owner item, only if it is still `blob` (the
 * item this run stored, IR-M1-8h-1 L2), and is `owner_card_failed` (fixed text). When core could not
 * be read back, the owner key is kept (removing it could leave a card whose owner key is gone).
 */
async function issueFirstCard(
  keychain: KeychainBackend,
  owner: OwnerPublicKeys,
  secret: Uint8Array,
  first: FirstAgentCard,
  blob: Uint8Array,
  timeoutMs: number = KEYCHAIN_CALL_TIMEOUT_MS,
): Promise<AgentCard> {
  const outcome = await signFirstCardWith(keychain, owner, secret, first, timeoutMs);
  if (outcome.kind === 'signed') return outcome.card;
  if (outcome.kind === 'unknown')
    throw new NodeKeyStoreError('owner_card_failed', COPY.cardUnknown);
  // IR-M1-8h-1 L2: remove only the item this run stored; another run's item is never deleted.
  const removal = await removeOwnerItemIfOurs(keychain, blob, timeoutMs);
  if (removal === 'failed') throw new NodeKeyStoreError('keychain_failed', COPY.keychainFailed);
  if (removal === 'other') throw new NodeKeyStoreError('owner_card_failed', COPY.cardUnknown);
  throw new NodeKeyStoreError('owner_card_failed', COPY.cardFailed);
}

/**
 * M1-8h-b: a display name the owner typed is used only when it fits the restricted-name rule of
 * 11 §5.2 (06 §2.1), so contacts can show it: after NFC and trimming, 1 to 32 letters, digits,
 * spaces, `.`, `'` and `-` (combining marks allowed), and core `restrictName` returns it unchanged
 * (IR-M1-8h-b-1 L1: no NFKC change, no reserved word, no mixed or look-alike script). Control,
 * format (bidi) and other characters are refused, never stripped.
 */
const DISPLAY_NAME = /^[\p{L}\p{M}\p{N} .'-]{1,32}$/u;

function displayNameAllowed(typed: string): boolean {
  // The fingerprint argument only shapes the fallback, which never equals an accepted name here.
  return DISPLAY_NAME.test(typed) && restrictName(typed, '0000·0000') === typed;
}

/**
 * M1-8h-b: asks the owner for the agent's display name (self-declared, 04 §2.4), on terminals that
 * can read a visible line. Enter keeps the name the caller passed (the local agent name); a name
 * outside the rule is asked again, and after three refusals the caller's name is kept.
 */
async function withDisplayName(
  terminal: OwnerTerminal,
  first: FirstAgentCard,
): Promise<FirstAgentCard> {
  if (terminal.readText === undefined) return first;
  assertPrintable(first.name, 'The agent name');
  terminal.write(COPY.nameNote);
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const typed = (await terminal.readText(COPY.nameQuestion(first.name))).normalize('NFC').trim();
    if (typed === '') return first;
    if (displayNameAllowed(typed)) return { ...first, name: typed };
    terminal.write(COPY.nameRefused);
  }
  terminal.write(COPY.nameKept(first.name));
  return first;
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
export function initOwner(options: OwnerSetupOptions): Promise<OwnerInitResult> {
  return Promise.resolve().then(() => {
    // M1-8h: `owner init` always signs the agent's first card in the same operation (04 §2.5).
    if (typeof options !== 'object' || options === null || options.firstCard === undefined) {
      throw new NodeKeyStoreError(
        'owner_operation_invalid',
        "Owner setup needs this agent's card to sign. Run `agentlink owner init`.",
      );
    }
    assertNoHarnessMarker(options.env ?? process.env);
    return initOwnerWith(osKeychain(), ttyOwnerTerminal(), options);
  });
}
