// RELAY-CARD-MIGRATION (S2; 0.5.13; 04 §2.5, §2.6, §3.4.1; 07 §4.3; I-1, I-4, I-7; owner-approved
// 2026-11-18): "Update your contact details", the owner part.
//
// An ID whose card still lists a relay the default set dropped (core relayMigration `needed`) moves
// to the migrated list with one owner operation: the presence gesture (Touch ID, passkey or the
// master code) unlocks one owner session, which signs exactly the agent's next card (keyEpoch + 1,
// the same name, the migrated list) through RelayCardSession. Core previews the next keys, stores the
// card as pending, advances the epoch (compare-and-set) and commits the card and the list
// (identity.rotate({relays})). Then the core's card-update sender tells every contact the owner's
// rules allow (D-106); during the transition that card-update also goes to the legacy relays
// (card-update.ts), so contacts still listening there learn it. Best effort: the next sync pass
// sends what is left.
//
// - Refused before anything is signed: nothing to update (`current`), an unfinished earlier rotation
//   (`rotation_pending`), another or a revoked agent (`not_applied`).
// - I-4: reached only from owner surfaces: the app host's presence gate (approval-server.ts
//   `updateContactDetails`) and `agentlink owner update-contact-details` at the owner's own terminal
//   (updateContactDetailsAtTerminal). No MCP tool reaches it. If the owner never does it nothing
//   breaks: the legacy relays are still read.
// - I-7: no card, relay list or key is logged; refusals are fixed codes.
import {
  KeyStoreError,
  agentCardRelaysHash,
  encodeHex0x,
  type NostrEvent,
  type OwnerPresence,
  type OwnerPublicKeys,
  type OwnerSession,
  type TypedData,
} from '@4thtech-io/crypto';
import type { IdentityService } from '@4thtech-io/core';
import { keyEpochControlFor, type AgentEpochKeys } from './key-epoch.js';
import { allowedTypedData, ownerOperationRefused } from './owner-allowlist.js';
import { osKeychain } from './keychain.js';
import { KeychainOwnerKeyStore } from './owner-keystore.js';
import { secretLabel, type OwnerReview } from './owner-operation.js';
import { assertNoHarnessMarker, ttyOwnerTerminal, type OwnerTerminal } from './owner-terminal.js';
import { NodeKeyStoreError } from './errors.js';

/** What the migration needs of the open agent's core client. */
export interface RelayMigrationClient {
  readonly identity: Pick<IdentityService, 'rotate' | 'get' | 'relayMigration' | 'sendState'>;
  /** Sends the current card to contacts that lack it (core `sendCardUpdates`); best effort. */
  sendCardUpdates?(): Promise<unknown>;
  /** Active, paired contacts (core `contacts.list`), for the count the answer carries. */
  readonly contacts?: {
    list(): Promise<readonly { readonly status: string; readonly pairing: string }[]>;
  };
}

export interface RelayMigrationInput {
  /** The open agent's agentId; the card must name exactly it. */
  readonly agent: string;
  readonly client: RelayMigrationClient;
  /** The open agent's key items (epochKeysOf its KeyStore). */
  readonly epochKeys: AgentEpochKeys;
}

export type RelayMigrationOutcome =
  | {
      readonly status: 'migrated';
      /** Active, paired contacts that will be told. */
      readonly contacts: number;
    }
  | {
      readonly status: 'refused';
      readonly reason: 'current' | 'rotation_pending' | 'not_applied';
    };

/** The owner statement (11 §5: no "relay"; plain words). */
export const CONTACT_DETAILS_REVIEW: OwnerReview = Object.freeze({
  lines: Object.freeze([
    'Update your contact details',
    'AgentLink moved to more reliable servers. Your contacts get your new details once.',
  ]) as unknown as string[],
});

/**
 * An OwnerSession that signs one AgentCard for `agent` and `owner`, at exactly `keyEpoch`, with
 * exactly `nameHash` (the name stays) and the `relaysHash` of exactly `relays`, then nothing. Every
 * other method is `owner_operation_refused`. Closing it does not close the session it wraps.
 */
export class RelayCardSession implements OwnerSession {
  #inner: OwnerSession | null;
  readonly #agent: string;
  readonly #owner: {
    readonly ownerEvm: string;
    readonly ownerNostr: string;
    readonly ownerEnc: string;
  };
  readonly #keyEpoch: number;
  readonly #nameHash: string;
  readonly #relaysHash: string;
  #signed = 0;

  constructor(
    inner: OwnerSession,
    agent: string,
    owner: OwnerPublicKeys,
    card: {
      readonly keyEpoch: number;
      readonly nameHash: string;
      readonly relays: readonly string[];
    },
  ) {
    this.#inner = inner;
    this.#agent = agent;
    this.#owner = {
      ownerEvm: encodeHex0x(owner.ownerEvm),
      ownerNostr: encodeHex0x(owner.ownerNostr),
      ownerEnc: encodeHex0x(owner.ownerEnc),
    };
    this.#keyEpoch = card.keyEpoch;
    this.#nameHash = card.nameHash;
    this.#relaysHash = encodeHex0x(agentCardRelaysHash(card.relays));
  }

  get expiresAt(): number {
    return this.#inner?.expiresAt ?? 0;
  }

  /** How many cards this session signed (0 or 1). */
  get signed(): number {
    return this.#signed;
  }

  isActive(): boolean {
    return this.#inner?.isActive() ?? false;
  }

  sign712(typedData: TypedData): Promise<string> {
    return Promise.resolve().then(() => {
      const inner = this.#inner;
      if (inner === null) throw new KeyStoreError('owner_locked', 'owner session: closed');
      if (this.#signed > 0) throw ownerOperationRefused();
      const typed = allowedTypedData(typedData);
      const card = typed.message;
      if (
        card['agentEvm'] !== this.#agent ||
        card['ownerEvm'] !== this.#owner.ownerEvm ||
        card['ownerNostr'] !== this.#owner.ownerNostr ||
        card['ownerEnc'] !== this.#owner.ownerEnc ||
        card['keyEpoch'] !== this.#keyEpoch ||
        card['nameHash'] !== this.#nameHash ||
        card['relaysHash'] !== this.#relaysHash
      ) {
        throw ownerOperationRefused();
      }
      this.#signed += 1;
      return inner.sign712(typed);
    });
  }

  signOwnerAction(): Promise<string> {
    return Promise.reject(ownerOperationRefused());
  }

  signEnvelopeHash(): Promise<string> {
    return Promise.reject(ownerOperationRefused());
  }

  signNostr(): Promise<NostrEvent> {
    return Promise.reject(ownerOperationRefused());
  }

  nip44Encrypt(): Promise<string> {
    return Promise.reject(ownerOperationRefused());
  }

  nip44Decrypt(): Promise<string> {
    return Promise.reject(ownerOperationRefused());
  }

  unwrapCek(): Promise<Uint8Array> {
    return Promise.reject(ownerOperationRefused());
  }

  /** Ends this wrapper only; the gate closes the session it wraps. */
  close(): Promise<void> {
    this.#inner = null;
    return Promise.resolve();
  }
}

const refused = (reason: 'current' | 'rotation_pending' | 'not_applied'): RelayMigrationOutcome =>
  Object.freeze({ status: 'refused', reason });

/**
 * The migration's owner part with the session the gesture unlocked (see the header). Refusals come
 * before anything is signed. A locked or closed session signs nothing and changes nothing.
 */
export async function signRelayMigration(
  session: OwnerSession,
  ownerKeys: OwnerPublicKeys,
  input: RelayMigrationInput,
): Promise<RelayMigrationOutcome> {
  const { agent, client } = input;
  const view = await client.identity.get();
  if (view === undefined || view.agentId !== agent || view.revoked) return refused('not_applied');
  const state = await client.identity.sendState();
  if (state === 'rotation_pending' || state === 'key_epoch_mismatch') {
    return refused('rotation_pending');
  }
  const migration = await client.identity.relayMigration();
  if (migration.status !== 'needed') return refused('current');
  if (!session.isActive()) {
    throw new KeyStoreError('owner_locked', 'owner session: closed');
  }
  const card = new RelayCardSession(session, agent, ownerKeys, {
    keyEpoch: view.keyEpoch + 1,
    nameHash: view.card.nameHash,
    relays: migration.relays,
  });
  try {
    // The control takes exactly this gesture's card session, while the gate's session is live.
    const epochControl = keyEpochControlFor(
      input.epochKeys,
      (owner) => owner === card && session.isActive(),
    );
    await client.identity.rotate({
      owner: card,
      ownerKeys,
      epochControl,
      relays: migration.relays,
    });
  } finally {
    await card.close();
  }
  // D-106: the core's sender tells each contact the owner's rules allow; best effort here.
  await client.sendCardUpdates?.().catch(() => undefined);
  let contacts: number;
  try {
    const list = (await client.contacts?.list()) ?? [];
    contacts = list.filter((c) => c.status === 'active' && c.pairing === 'complete').length;
  } catch {
    contacts = 0;
  }
  return Object.freeze({ status: 'migrated', contacts });
}

export interface ContactDetailsAtTerminalInput extends RelayMigrationInput {
  /** The owner the agent's card names. */
  readonly ownerKeys: OwnerPublicKeys;
  /** For tests: the owner store and terminal; production uses the OS keychain and this TTY. */
  readonly store?: KeychainOwnerKeyStore;
  readonly terminal?: OwnerTerminal;
}

/**
 * `agentlink owner update-contact-details` † (the package entry): one owner operation at this
 * process's own terminal. Shows the statement, asks "Continue?", reads the master code once at the
 * prompt, unlocks, runs signRelayMigration, then closes the session and locks the store whatever
 * happened. A wrong code is `presence_rejected` and nothing is signed. No argument, variable, file
 * or pipe carries the owner secret; an AI harness or a missing terminal is refused first.
 */
export async function updateContactDetailsAtTerminal(
  input: ContactDetailsAtTerminalInput,
): Promise<RelayMigrationOutcome> {
  assertNoHarnessMarker();
  const terminal = input.terminal ?? ttyOwnerTerminal();
  // Refusals before the owner is asked for anything.
  const migration = await input.client.identity.relayMigration();
  if (migration.status !== 'needed') return refused('current');
  const store = input.store ?? (await KeychainOwnerKeyStore.open(osKeychain(), input.ownerKeys));
  try {
    for (const line of CONTACT_DETAILS_REVIEW.lines) terminal.write(line);
    if (!(await terminal.confirm('Continue?'))) {
      throw new NodeKeyStoreError('owner_prompt_cancelled', 'Cancelled. Nothing was changed.');
    }
    const kind = await store.secretKind();
    const presence: OwnerPresence =
      terminal.readPresence === undefined
        ? { kind: 'passphrase', secret: await terminal.readSecret(secretLabel(kind)) }
        : await terminal.readPresence(secretLabel(kind));
    const session = await store.unlock(presence);
    try {
      return await signRelayMigration(session, input.ownerKeys, input);
    } finally {
      await session.close();
      await store.lock();
    }
  } finally {
    if (input.store === undefined) await store.close();
  }
}
