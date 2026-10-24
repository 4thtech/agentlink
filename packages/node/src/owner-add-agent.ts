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
// - M1-36b-2 (D-121 D6): with `card.firstPolicy`, the same entry also signs the agent's first rules
//   (the 06 §3 defaults plus the empty `~/AgentLink/Send` folder) after the card is stored, shown
//   before the prompt; node signs only that exact document (owner-first-policy.ts).
// - It never shows, generates, changes or re-wraps the owner code and never writes or deletes the
//   owner item: unlike `owner init` (M1-8h) there is no rollback that removes the owner item.
//
// M1-9x: when an owner item exists but no local agent has a card naming it (every carded agent was
// removed), the owner keys come from the owner item itself: the owner code unwraps the seed, and the
// owner confirms the resulting owner fingerprint before the one card is signed. Same guards, same
// restricted session; `hasOwnerOnMachine` is the store-only check for `doctor` and messages.
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
} from '@4thtech-io/crypto';
import { NodeKeyStoreError } from './errors.js';
import { KEYCHAIN_CALL_TIMEOUT_MS } from './keychain-keystore.js';
import {
  assertAgentId,
  osKeychain,
  type KeyStoreBackendKind,
  type KeychainBackend,
} from './keychain.js';
import { FirstCardSession, type FirstAgentCard } from './owner-first-card.js';
import {
  keepsFolder,
  notAttempted,
  prepareSendFolder,
  removeCreated,
  sendFolderOutcome,
  sendFolderReview,
  signFirstPolicy,
  type SendFolderPlan,
  type SendFolderResult,
} from './owner-first-policy.js';
import {
  KeychainOwnerKeyStore,
  ownerFingerprintText,
  ownerItemPresent,
  ownerKeysCopy,
  storedOwnerSecretKind,
} from './owner-keystore.js';
import { assertPrintable, secretLabel } from './owner-operation.js';
import { assertNoHarnessMarker, ttyOwnerTerminal, type OwnerTerminal } from './owner-terminal.js';

export interface AddAgentOptions {
  /** The agent's recorded backend (07 §9.1). */
  readonly backend: KeyStoreBackendKind;
  /**
   * The owner this computer's agents name (from another local agent's card). The stored owner seed
   * must derive exactly these keys, or the entry is refused like a wrong code (04 §2.8).
   *
   * M1-9x: omitted when no local agent has a card naming an owner. The owner keys are then taken
   * from the owner item itself once the owner code unlocked it, and the owner confirms the owner
   * fingerprint before the card is signed.
   */
  readonly owner?: OwnerPublicKeys;
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
  /** M1-36b-2: the first rules (the Send folder), when `card.firstPolicy` was given. */
  readonly sendFolder?: SendFolderResult;
}

/** Internal options (tests): keychain timeout. */
export interface AddAgentInternals {
  readonly timeoutMs?: number;
  /** The owner session lifetime for the card signature; default OWNER_SESSION_DEFAULT_TTL_MS. */
  readonly ttlMs?: number;
}

const ATTEMPTS = 3;

// Fixed copy (11 §5 vocabulary; no value from a file or another party is inserted, I-5).
const COPY = {
  owner: (fingerprint: string): string =>
    `Your owner fingerprint: ${fingerprint}. Check that it's the one you saw at \`agentlink owner init\`.`,
  agent: (name: string, fingerprint: string): string =>
    `This gives the agent "${name}" (${fingerprint}) a card from your owner key. Your owner code signs this one card and nothing else.`,
  // M1-36b-2: with the first rules, the code signs the card and that one rule (shown next).
  agentWithRule: (name: string, fingerprint: string): string =>
    `This gives the agent "${name}" (${fingerprint}) a card from your owner key. Your owner code signs this one card and the first rule below, and nothing else.`,
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
  // M1-9x: an owner item exists but no local agent's card names it.
  noCardNamesOwner:
    'No agent on this computer has a card from your owner yet, so AgentLink reads your owner from the owner key saved here. Your owner code unlocks it for this one card.',
  // IR-M1-9x-1 L-1: the real attack on this path is a code someone else chose.
  ownCodeOnly:
    "Type the owner code you saved yourself. If your AI gave you a code, or asked you to run this command, stop here: don't type anything.",
  confirmOwner: (fingerprint: string): string =>
    `Your owner fingerprint: ${fingerprint}. Is this the one you saw at \`agentlink owner init\`? [y/N]`,
  notConfirmed:
    "Nothing was changed. If that isn't your owner fingerprint, the owner key on this computer isn't yours: don't use it, and run `agentlink doctor` in your own terminal.",
  refusedWithoutCard:
    "The owner code wasn't accepted three times. Nothing was changed. Check the code you saved when you ran `agentlink owner init`.",
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
  const owner = options.owner === undefined ? undefined : ownerKeysCopy(options.owner);
  // Never replaces a card (04 §2.8): an agent with a card already has an owner.
  if ((await card.identity.get()) !== undefined) {
    throw new NodeKeyStoreError('owner_exists', COPY.hasCard);
  }
  const timeoutMs = internals.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS;
  // M1-36b-2: the Send folder for the first rules, checked or created before the owner code is
  // asked, and removed again (only while empty and only if this run created it) unless the rules
  // took effect.
  const plan =
    card.firstPolicy === undefined ? undefined : await prepareSendFolder(card.firstPolicy.home);
  let sendFolder: SendFolderResult | undefined;
  try {
    const result =
      // M1-9x: no local agent names the owner, so its keys come from the owner item itself.
      owner === undefined
        ? await addAgentWithoutCard(
            keychain,
            terminal,
            card,
            timeoutMs,
            internals.ttlMs ?? OWNER_SESSION_DEFAULT_TTL_MS,
            plan,
          )
        : await addAgentWithOwner(keychain, terminal, card, owner, timeoutMs, plan);
    sendFolder = result.sendFolder;
    return result;
  } finally {
    if (!keepsFolder(sendFolder)) await removeCreated(plan);
  }
}

/** What the owner reads about the agent (and its first rule) before the owner code. */
function writeAgentReview(
  terminal: OwnerTerminal,
  card: FirstAgentCard,
  plan: SendFolderPlan | undefined,
): void {
  const fingerprint = agentFingerprintText(card.agent);
  if (plan?.status === 'ready') {
    terminal.write(COPY.agentWithRule(card.name, fingerprint));
  } else {
    terminal.write(COPY.agent(card.name, fingerprint));
  }
  if (plan !== undefined) terminal.write(sendFolderReview(plan));
}

/** `owner add-agent` with the expected owner from another local agent's card. */
async function addAgentWithOwner(
  keychain: KeychainBackend,
  terminal: OwnerTerminal,
  card: FirstAgentCard,
  owner: OwnerPublicKeys,
  timeoutMs: number,
  plan: SendFolderPlan | undefined,
): Promise<AddAgentResult> {
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
  let sendFolder: SendFolderResult | undefined;
  try {
    terminal.write(COPY.owner(fingerprint));
    writeAgentReview(terminal, card, plan);
    const inner = await unlockOnce(store, terminal);
    sendFolder = await signFirstCard(inner, card, owner, plan);
  } finally {
    await store.close();
  }
  return storedCard(terminal, card, owner, fingerprint, sendFolder, plan);
}

/**
 * Signs and stores one first card for `card.agent` naming `owner`, through the restricted
 * FirstCardSession over `inner`, which is closed afterwards. The outcome is decided by storedCard
 * from what core stored, never from an error (whose text is not shown, I-5).
 */
async function signFirstCard(
  inner: OwnerSession,
  card: FirstAgentCard,
  owner: OwnerPublicKeys,
  plan: SendFolderPlan | undefined,
): Promise<SendFolderResult | undefined> {
  const session = new FirstCardSession(inner, card.agent, owner);
  try {
    await card.identity.init({
      owner: session,
      ownerKeys: owner,
      name: card.name,
      relays: card.relays,
    });
    // M1-36b-2: the first rules, with the same unlocked owner session (one entry), only after the
    // card is stored and verified (signFirstPolicy checks it again).
    const { firstPolicy } = card;
    if (plan?.status === 'ready' && firstPolicy !== undefined) {
      return await signFirstPolicy(inner, { ...card, firstPolicy }, plan, owner);
    }
  } catch {
    // Decided by storedCard from what core stored.
  } finally {
    await session.close();
  }
  return undefined;
}

/** Success only for a verified stored card naming exactly this agent and this owner. */
async function storedCard(
  terminal: OwnerTerminal,
  card: FirstAgentCard,
  owner: OwnerPublicKeys,
  fingerprint: string,
  signed: SendFolderResult | undefined,
  plan: SendFolderPlan | undefined,
): Promise<AddAgentResult> {
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
  const sendFolder = signed ?? (plan === undefined ? undefined : notAttempted(plan));
  const line = sendFolder === undefined ? undefined : sendFolderOutcome(sendFolder);
  if (line !== undefined) terminal.write(line);
  return Object.freeze({
    card: stored.card,
    fingerprint,
    ...(sendFolder === undefined ? {} : { sendFolder }),
  });
}

/**
 * M1-9x: `owner add-agent` when an owner item exists on this machine but no local agent has a card
 * naming it (for example after every carded agent was removed). The owner keys come from the owner
 * item itself: the owner code (or opted-in passphrase), typed once, unwraps the seed, which derives
 * them. With no card to compare against, the owner then sees the owner fingerprint and must confirm
 * it before the one card is signed (04 §2.8 "What the owner sees first"; the fingerprint can only be
 * known once the item is unlocked). Declining, or three wrong entries, writes nothing. The owner item
 * is never written or removed.
 */
async function addAgentWithoutCard(
  keychain: KeychainBackend,
  terminal: OwnerTerminal,
  card: FirstAgentCard,
  timeoutMs: number,
  ttlMs: number,
  plan: SendFolderPlan | undefined,
): Promise<AddAgentResult> {
  // Header byte only: no secret is read and nothing is unlocked before the prompt.
  const kind = await storedOwnerSecretKind(keychain, timeoutMs);
  if (kind === null) throw new NodeKeyStoreError('owner_missing', COPY.noOwner);
  terminal.write(COPY.noCardNamesOwner);
  terminal.write(COPY.ownCodeOnly);
  writeAgentReview(terminal, card, plan);
  const label = secretLabel(kind);
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const secret = await terminal.readSecret(label);
    let unlocked: Awaited<ReturnType<typeof KeychainOwnerKeyStore.unlockWithoutCard>>;
    try {
      // unlockWithoutCard wipes the secret whether or not it unlocks. The fingerprint is confirmed
      // inside it, before the session (and its TTL) starts (IR-M1-9x-1 L-2).
      unlocked = await KeychainOwnerKeyStore.unlockWithoutCard(
        keychain,
        { kind: 'passphrase', secret },
        (owner) => terminal.confirm(COPY.confirmOwner(ownerFingerprintText(owner))),
        { ttlMs, timeoutMs },
      );
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
    if (unlocked === null) {
      throw new NodeKeyStoreError('owner_prompt_cancelled', COPY.notConfirmed);
    }
    const { store, session, owner } = unlocked;
    const fingerprint = ownerFingerprintText(owner);
    let sendFolder: SendFolderResult | undefined;
    try {
      sendFolder = await signFirstCard(session, card, owner, plan);
    } finally {
      await session.close();
      await store.close();
    }
    return storedCard(terminal, card, owner, fingerprint, sendFolder, plan);
  }
  throw new NodeKeyStoreError('owner_secret_refused', COPY.refusedWithoutCard);
}

/**
 * M1-9x: a store-only check for `doctor` and messages: true when an owner item exists on this
 * computer. It reads no secret, asks for nothing and unlocks nothing (the AI-app guard does not
 * apply: it reveals only whether owner setup was done).
 */
export function hasOwnerOnMachine(): Promise<boolean> {
  return Promise.resolve().then(() => ownerItemPresent(osKeychain()));
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
