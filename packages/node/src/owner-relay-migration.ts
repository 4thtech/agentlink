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
import {
  CoreError,
  TooManyPreviousError,
  type IdentityService,
  type IdentityView,
} from '@4thtech-io/core';
import { keyEpochControlFor, type AgentEpochKeys } from './key-epoch.js';
import { allowedTypedData, ownerOperationRefused } from './owner-allowlist.js';
import { osKeychain } from './keychain.js';
import { KeychainOwnerKeyStore } from './owner-keystore.js';
import { secretLabel, type OwnerReview, type PromptingOwnerKeyStore } from './owner-operation.js';
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
 * The one rotation both owner operations end in (NET-OWNER-SET generalises "Update your contact
 * details"): exactly one card at `view.keyEpoch` + 1 with the same name and exactly `relays`, signed
 * by this gesture's session through RelayCardSession, the announce choice stored with it when given,
 * then core's card-update sender (best effort). Answers the active, paired contacts to be told. A
 * locked or closed session signs nothing and changes nothing (KeyStoreError `owner_locked`).
 */
async function rotateToList(
  session: OwnerSession,
  ownerKeys: OwnerPublicKeys,
  input: RelayMigrationInput,
  view: IdentityView,
  relays: readonly string[],
  announceDefault?: boolean,
): Promise<number> {
  const { agent, client } = input;
  if (!session.isActive()) {
    throw new KeyStoreError('owner_locked', 'owner session: closed');
  }
  const card = new RelayCardSession(session, agent, ownerKeys, {
    keyEpoch: view.keyEpoch + 1,
    nameHash: view.card.nameHash,
    relays,
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
      relays,
      ...(announceDefault === undefined ? {} : { announceDefault }),
    });
  } finally {
    await card.close();
  }
  // D-106: the core's sender tells each contact the owner's rules allow; best effort here.
  await client.sendCardUpdates?.().catch(() => undefined);
  try {
    const list = (await client.contacts?.list()) ?? [];
    return list.filter((c) => c.status === 'active' && c.pairing === 'complete').length;
  } catch {
    return 0;
  }
}

/** The refusals both operations share, before anything is signed; else the identity's view. */
async function viewOrRefusal(
  input: RelayMigrationInput,
): Promise<IdentityView | 'not_applied' | 'rotation_pending'> {
  const { agent, client } = input;
  const view = await client.identity.get();
  if (view === undefined || view.agentId !== agent || view.revoked) return 'not_applied';
  const state = await client.identity.sendState();
  if (state === 'rotation_pending' || state === 'key_epoch_mismatch') return 'rotation_pending';
  return view;
}

/**
 * The migration's owner part with the session the gesture unlocked (see the header). Refusals come
 * before anything is signed. A locked or closed session signs nothing and changes nothing.
 */
export async function signRelayMigration(
  session: OwnerSession,
  ownerKeys: OwnerPublicKeys,
  input: RelayMigrationInput,
): Promise<RelayMigrationOutcome> {
  const view = await viewOrRefusal(input);
  if (typeof view === 'string') return refused(view);
  const migration = await input.client.identity.relayMigration();
  if (migration.status !== 'needed') return refused('current');
  const contacts = await rotateToList(session, ownerKeys, input, view, migration.relays);
  return Object.freeze({ status: 'migrated', contacts });
}

// ---------------------------------------------------------------------------------------------
// NET-OWNER-SET (S2; D-158 (2), (5), (6), (7); 04 §2.5, §2.6; 07 §4.3 "Use your own servers"; I-4,
// I-7): an owner server-list change, the generalised session. The input is the final list the app
// process built after testing every server again (core buildServerList, or the default set for a
// reset) and the announce choice. One gesture signs exactly one card at keyEpoch + 1 with exactly
// that list (RelayCardSession); the choice is stored with it (rotate({announceDefault})); the
// servers that leave stay readable for 30 days (M1-7j: core refuses more than 16 before anything is
// previewed or signed); contacts are told through core's card-update path. Reached only from the app
// host's presence gate (approval-server.ts `changeServers`); no MCP tool, tool argument or
// `nextStep` reaches it (I-4). Nothing is logged.

/** What a server-list change needs of the open agent's core client. */
export interface ServerChangeClient extends RelayMigrationClient {
  readonly identity: Pick<
    IdentityService,
    'rotate' | 'get' | 'relayMigration' | 'sendState' | 'relays' | 'leavingServers'
  >;
}

export interface ServerChangeInput extends RelayMigrationInput {
  readonly client: ServerChangeClient;
  /** The final list, in order: exactly what the card commits to (2 to 8 public servers). */
  readonly relays: readonly string[];
  /** The announce choice stored with the card (false: the opt-out; a reset passes true). */
  readonly announceDefault: boolean;
}

export type ServerChangeRefusal =
  'same_list' | 'rotation_pending' | 'not_applied' | 'too_many_previous';

export type ServerChangeOutcome =
  | {
      readonly status: 'changed';
      /** Active, paired contacts that will be told. */
      readonly contacts: number;
      /** The latest end of the leaving servers (unix seconds), or null when none runs. */
      readonly leavingUntil: number | null;
    }
  | {
      readonly status: 'refused';
      readonly reason: ServerChangeRefusal;
      /** `too_many_previous` only: the unix second from which the change fits. */
      readonly fitsAt?: number;
    };

const changeRefused = (reason: ServerChangeRefusal, fitsAt?: number): ServerChangeOutcome =>
  Object.freeze({ status: 'refused', reason, ...(fitsAt === undefined ? {} : { fitsAt }) });

/** A lost compare-and-set or an earlier unfinished rotation (core identity.rotate). */
const isRotationConflict = (error: unknown): boolean =>
  error instanceof CoreError &&
  (error.code === 'concurrent_rotation' ||
    error.code === 'key_epoch_mismatch' ||
    error.code === 'rotation_pending');

/**
 * The server-list change's owner part with the session the gesture unlocked (see above). Refused
 * before anything is signed: another or a revoked agent (`not_applied`), an unfinished earlier
 * rotation (`rotation_pending`), the same list (`same_list`), more than 16 leaving servers
 * (`too_many_previous` with `fitsAt`, from core's check before any key is previewed). Of two changes
 * at once, one wins; the other is `rotation_pending` (core's compare-and-set on the epoch). A locked
 * or closed session signs nothing and changes nothing.
 */
export async function signServerChange(
  session: OwnerSession,
  ownerKeys: OwnerPublicKeys,
  input: ServerChangeInput,
): Promise<ServerChangeOutcome> {
  const view = await viewOrRefusal(input);
  if (typeof view === 'string') return changeRefused(view);
  const { identity } = input.client;
  const relays = Object.freeze([...input.relays]);
  const current = await identity.relays();
  if (current.length === relays.length && current.every((r, i) => r === relays[i])) {
    return changeRefused('same_list');
  }
  let contacts: number;
  try {
    contacts = await rotateToList(session, ownerKeys, input, view, relays, input.announceDefault);
  } catch (error) {
    if (error instanceof TooManyPreviousError) {
      return changeRefused('too_many_previous', error.fitsAt);
    }
    if (isRotationConflict(error)) return changeRefused('rotation_pending');
    throw error;
  }
  let leavingUntil: number | null = null;
  try {
    for (const e of await identity.leavingServers()) {
      if (leavingUntil === null || e.until > leavingUntil) leavingUntil = e.until;
    }
  } catch {
    leavingUntil = null;
  }
  return Object.freeze({ status: 'changed', contacts, leavingUntil });
}

export interface ContactDetailsAtTerminalInput extends RelayMigrationInput {
  /** The owner the agent's card names. */
  readonly ownerKeys: OwnerPublicKeys;
}

/**
 * The owner operation with the owner store and terminal it is given (REL-0513-FENCE: internal, never
 * a package export; tests reach it by this module path). Shows the statement, asks "Continue?",
 * reads the master code once at the prompt, unlocks, runs signRelayMigration, then closes the
 * session and locks the store whatever happened. A wrong code is `presence_rejected` and nothing is
 * signed. The caller opens and closes the store. Refused before anything is shown when there is
 * nothing to update.
 */
export async function updateContactDetailsWith(
  store: PromptingOwnerKeyStore,
  terminal: OwnerTerminal,
  input: ContactDetailsAtTerminalInput,
): Promise<RelayMigrationOutcome> {
  const migration = await input.client.identity.relayMigration();
  if (migration.status !== 'needed') return refused('current');
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
}

/**
 * `agentlink owner update-contact-details` † (the package entry; REL-0513-FENCE): one owner
 * operation on this OS user's keychain and this process's own TTY prompt, like
 * performOwnerOperation, changeOwnerCode and restoreInTerminal. No owner-store or terminal seam: the
 * input carries neither, and anything extra in it is never read. No argument, variable, file or pipe
 * carries the owner secret; an AI harness or a missing terminal is refused first.
 */
export async function updateContactDetailsAtTerminal(
  input: ContactDetailsAtTerminalInput,
): Promise<RelayMigrationOutcome> {
  assertNoHarnessMarker();
  const terminal = ttyOwnerTerminal();
  const { agent, client, epochKeys, ownerKeys } = input;
  const checked: ContactDetailsAtTerminalInput = { agent, client, epochKeys, ownerKeys };
  // Refusals before the owner store is opened.
  if ((await client.identity.relayMigration()).status !== 'needed') return refused('current');
  const store = await KeychainOwnerKeyStore.open(osKeychain(), ownerKeys);
  try {
    return await updateContactDetailsWith(store, terminal, checked);
  } finally {
    await store.close();
  }
}
