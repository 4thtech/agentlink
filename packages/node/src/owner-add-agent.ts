// M1-9t: adding an agent to the existing owner, the flow behind `agentlink owner add-agent --agent
// <name>` † (D-78; 04 §2.2, §2.5, §2.8 "Adding an agent to the existing owner"). Under one OS user,
// one owner key owns many local agents. A further agent gets its first card from the owner key that
// is already on the machine, run personally in a terminal the agent does not control.
//
// - Guards before anything is read: the AI-app marker (UX guard) and, in the package entry, an
//   interactive terminal; the owner secret never comes from an argument, variable, file or pipe.
// - Refusals before the owner code is asked for: no owner key on the machine (`owner init`), an
//   agent that already has a card (never replaced; a new card is a rotation, 04 §2.6).
// - The owner sees the owner fingerprint, the agent's name and its agent fingerprint first.
// - One entry, one owner operation (04 §2.5, D-68 (1)): the owner code (or opted-in passphrase)
//   unlocks the existing owner key for exactly one signature: one AgentCard naming exactly this
//   agent and this owner, through the restricted FirstCardSession (owner-first-card.ts), which
//   refuses every other signing request. The session is closed and the secret wiped. Three wrong
//   entries end the command and nothing is written.
// - It never shows, generates, changes or re-wraps the owner code and never writes or deletes the
//   owner item: unlike `owner init` (M1-8h) there is no rollback that removes the owner item.
//
// "Logical isolation, not a security boundary" (D-78): each agent keeps its own seed, store and Nostr
// identity, and owner actions bind to one agent (04 §2.5.1), but every agent runs as the same OS user
// (G-1, D-67).
import {
  OWNER_SESSION_DEFAULT_TTL_MS,
  KeyStoreError,
  agentFingerprint,
  decodeHex0x,
  encodeHex0x,
  formatFingerprint,
  verifyAgentCard,
  type AgentCard,
  type OwnerPublicKeys,
  type OwnerSession,
} from '@agentlink/crypto';
import { NodeKeyStoreError } from './errors.js';
import { KEYCHAIN_CALL_TIMEOUT_MS } from './keychain-keystore.js';
import {
  assertAgentId,
  osKeychain,
  type KeyStoreBackendKind,
  type KeychainBackend,
} from './keychain.js';
import { FirstCardSession, type FirstAgentCard } from './owner-first-card.js';
import { KeychainOwnerKeyStore, ownerFingerprintText, ownerKeysCopy } from './owner-keystore.js';
import { assertPrintable, secretLabel } from './owner-operation.js';
import { assertNoHarnessMarker, ttyOwnerTerminal, type OwnerTerminal } from './owner-terminal.js';

export interface AddAgentOptions {
  /** The agent's recorded backend (07 §9.1). */
  readonly backend: KeyStoreBackendKind;
  /**
   * The owner this computer's agents name (from another local agent's card). The stored owner seed
   * must derive exactly these keys, or the entry is refused like a wrong code (04 §2.8).
   */
  readonly owner: OwnerPublicKeys;
  /** Checked for AI-app markers; default process.env. Never read for a secret. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The agent being added: its first card is signed for exactly this agent. */
  readonly card: FirstAgentCard;
}

export interface AddAgentResult {
  /** The card, signed by the existing owner and stored. */
  readonly card: AgentCard;
  /** The short owner fingerprint (11 §5.2). */
  readonly fingerprint: string;
}

/** Internal options (tests): keychain timeout. */
export interface AddAgentInternals {
  readonly timeoutMs?: number;
}

const ATTEMPTS = 3;

// Fixed copy (11 §5 vocabulary; no value from a file or another party is inserted, I-5).
const COPY = {
  owner: (fingerprint: string): string =>
    `Your owner fingerprint: ${fingerprint}. Check that it's the one you saw at \`agentlink owner init\`.`,
  agent: (name: string, fingerprint: string): string =>
    `This gives the agent "${name}" (${fingerprint}) a card from your owner key. Your owner code signs this one card and nothing else.`,
  // A wrong code and an owner item that isn't the owner the other agents name get one answer
  // (04 §2.8: a wrong secret, a damaged item and a foreign owner are not told apart), so the copy
  // names both causes without saying which (IR-M1-9t-1 Info).
  wrong: "That owner code wasn't accepted. Check it and try again.",
  refused:
    "The owner code wasn't accepted three times. Nothing was changed. If you're sure the code is right, the owner key on this computer may not be the owner your other agents name: run `agentlink doctor` in your own terminal.",
  hasCard:
    'This agent already has a card from an owner. AgentLink never replaces a card. Nothing was changed.',
  noOwner:
    "No owner is set up on this computer yet. Run `agentlink owner init` yourself, in your own terminal. Don't let your AI run it or see the code it shows.",
  fileUnavailable:
    "This agent's identity is kept in a passphrase-locked file, which this version of AgentLink can't add to an owner yet. Update AgentLink.",
  unknownBackend:
    "This agent's recorded key store is not one AgentLink knows. Check the agent's config with `agentlink doctor`.",
  cardFailed:
    "The agent's card couldn't be signed. Your owner key wasn't changed. Run `agentlink owner add-agent` again.",
  cardUnknown:
    "Adding the agent didn't finish. Your owner key wasn't changed. Run `agentlink doctor` in your own terminal to see what is missing.",
  done: (name: string, fingerprint: string): string =>
    `OK       The agent "${name}" now has a card from your owner (${fingerprint}).`,
} as const;

/** The short agent fingerprint of 04 §2.9 for a checked agent ID. */
function agentFingerprintText(agent: string): string {
  return formatFingerprint(agentFingerprint(decodeHex0x(agent)), 'short');
}

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

/** Reads the owner secret at most three times; returns the unlocked session or refuses. */
async function unlockOnce(
  store: KeychainOwnerKeyStore,
  terminal: OwnerTerminal,
): Promise<OwnerSession> {
  const label = secretLabel(await store.secretKind());
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const secret = await terminal.readSecret(label);
    try {
      // unlock wipes the secret whether or not it unlocks (OwnerKeyStore contract).
      return await store.unlock(
        { kind: 'passphrase', secret },
        { ttlMs: OWNER_SESSION_DEFAULT_TTL_MS },
      );
    } catch (error) {
      if (error instanceof KeyStoreError && error.code === 'presence_rejected') {
        if (attempt < ATTEMPTS - 1) terminal.write(COPY.wrong);
        continue;
      }
      throw error;
    }
  }
  throw new NodeKeyStoreError('owner_secret_refused', COPY.refused);
}

/**
 * Runs `owner add-agent` against `keychain` on `terminal`. Nothing is written before the owner code
 * unlocked the existing owner key, and then only the one card; the owner item is never written.
 */
export async function addAgentWith(
  keychain: KeychainBackend,
  terminal: OwnerTerminal,
  options: AddAgentOptions,
  internals: AddAgentInternals = {},
): Promise<AddAgentResult> {
  assertNoHarnessMarker(options.env ?? process.env);
  if (options.backend === 'file') {
    throw new NodeKeyStoreError('backend_unavailable', COPY.fileUnavailable);
  }
  if (options.backend !== 'keychain') {
    throw new NodeKeyStoreError('backend_unavailable', COPY.unknownBackend);
  }
  const { card } = options;
  assertAgentId(card.agent);
  assertPrintable(card.name, 'The agent name');
  const owner = ownerKeysCopy(options.owner);
  // Never replaces a card (04 §2.8): an agent with a card already has an owner.
  if ((await card.identity.get()) !== undefined) {
    throw new NodeKeyStoreError('owner_exists', COPY.hasCard);
  }
  const timeoutMs = internals.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS;
  let store: KeychainOwnerKeyStore;
  try {
    store = await KeychainOwnerKeyStore.open(keychain, owner, { timeoutMs });
  } catch (error) {
    if (error instanceof NodeKeyStoreError && error.code === 'owner_missing') {
      throw new NodeKeyStoreError('owner_missing', COPY.noOwner);
    }
    throw error;
  }
  const fingerprint = ownerFingerprintText(owner);
  try {
    terminal.write(COPY.owner(fingerprint));
    terminal.write(COPY.agent(card.name, agentFingerprintText(card.agent)));
    const inner = await unlockOnce(store, terminal);
    const session = new FirstCardSession(inner, card.agent, owner);
    try {
      await card.identity.init({
        owner: session,
        ownerKeys: owner,
        name: card.name,
        relays: card.relays,
      });
    } catch {
      // Decided below from what core stored, never from the error (whose text is not shown, I-5).
    } finally {
      await session.close();
    }
  } finally {
    await store.close();
  }
  let stored: Awaited<ReturnType<FirstAgentCard['identity']['get']>>;
  try {
    stored = await card.identity.get();
  } catch {
    throw new NodeKeyStoreError('owner_card_failed', COPY.cardUnknown);
  }
  // No rollback: the owner item was never written, so there is nothing to remove.
  if (!namesOwner(stored, card.agent, owner)) {
    throw new NodeKeyStoreError('owner_card_failed', COPY.cardFailed);
  }
  terminal.write(COPY.done(card.name, fingerprint));
  return Object.freeze({ card: stored.card, fingerprint });
}

/**
 * The package entry (index.ts): `owner add-agent` against the OS keychain on this process's own
 * terminal. Refused with an AI-app marker set (`harness_detected`) or without an interactive
 * terminal (`owner_prompt_unavailable`), before the keychain is touched.
 */
export function addAgentToOwner(options: AddAgentOptions): Promise<AddAgentResult> {
  return Promise.resolve().then(() => {
    if (typeof options !== 'object' || options === null || options.card === undefined) {
      throw new NodeKeyStoreError(
        'owner_operation_invalid',
        'Adding an agent needs the agent whose card to sign. Run `agentlink owner add-agent --agent <name>`.',
      );
    }
    assertNoHarnessMarker(options.env ?? process.env);
    return addAgentWith(osKeychain(), ttyOwnerTerminal(), options);
  });
}
