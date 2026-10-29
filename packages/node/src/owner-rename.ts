// W4-RENAME-REACHES-CONTACTS (S2; D-141; 04 §2.5 "One entry", §2.5.1 `agent.label`, §2.6, §3.1.1
// "Epoch advance"; 08 §1; I-1, I-2, I-4, I-7): the rename gesture's owner part.
//
// A rename whose label differs from the name in the agent's current card is a key rotation (04 §2.6):
// the same presence gesture that signs `agent.label` signs the agent's next card (keyEpoch + 1, the
// new label as its self-declared name), one owner operation. With the one session the gate unlocked:
//
//   1. Refuse before anything is signed: the label body is not exactly the `agent.label` core prepared
//      for this agent and label (`not_applied`), the 4th rename in 24 h (`rename_limited`, with the
//      time it is allowed again), an unfinished earlier rotation (`rotation_pending`).
//   2. Core `identity.rotate({name})` with a RenameCardSession (signs exactly one AgentCard: this
//      agent, this owner, keyEpoch + 1, the new name) and the agent's KeyEpochControl over its
//      `key-epoch` item (key-epoch.ts), which accepts only that card session. Core previews the next
//      keys, has the owner sign the card, stores it as pending, advances the epoch (compare-and-set),
//      then commits the card and the name (identity.ts). The card commits first.
//   3. Then exactly the prepared `agent.label` is signed (the allowlist of owner-operation.ts) and
//      returned; the route has core verify and apply it, and writes config.json after (07 §9.1). A
//      failure between 2 and 3 leaves the card renamed and the label old: Try again signs only the
//      label, because a label equal to the card's name never rotates (D-141 (3)).
//   4. The core's card-update sender tells every contact the owner's rules allow (D-106), best effort
//      (the next sync pass sends what is left); the count of active, paired contacts is returned.
//
// I-4: called only from the app host's presence gate (approval-server.ts `renameAgent`); the session,
// the card session and the control never reach a handler, MCP code or a log. I-7: no label, name,
// card or key is logged; refusals are fixed codes.
import {
  KeyStoreError,
  agentCardNameHash,
  encodeHex0x,
  type JsonObject,
  type NostrEvent,
  type OwnerPublicKeys,
  type OwnerSession,
  type TypedData,
} from '@4thtech-io/crypto';
import type { IdentityService, RenameAllowance, SendState } from '@4thtech-io/core';
import { keyEpochControlFor, type AgentEpochKeys } from './key-epoch.js';
import { allowedTypedData, ownerOperationRefused } from './owner-allowlist.js';
import { checkGesture, signGesture, type OwnerReview } from './owner-operation.js';

/** What the rename needs of the open agent's core client. */
export interface RenameClient {
  readonly identity: Pick<
    IdentityService,
    'rotate' | 'get' | 'cardName' | 'renameAllowance' | 'sendState'
  >;
  /** Sends the current card to contacts that lack it (core `sendCardUpdates`); best effort. */
  sendCardUpdates?(): Promise<unknown>;
  /** Active, paired contacts (core `contacts.list`), for the count the answer carries. */
  readonly contacts?: {
    list(): Promise<readonly { readonly status: string; readonly pairing: string }[]>;
  };
}

export interface RenameInput {
  /** The open agent's agentId; the card and the label must name exactly it. */
  readonly agent: string;
  readonly client: RenameClient;
  /** The open agent's key items (epochKeysOf its KeyStore). */
  readonly epochKeys: AgentEpochKeys;
  /** What the owner is shown (fixed lines). */
  readonly review: OwnerReview;
  /** The new label: the card's new self-declared name. */
  readonly label: string;
  /** The unsigned `agent.label` core prepared for `agent` and `label`. */
  readonly labelBody: JsonObject;
}

export type RenameSignOutcome =
  | {
      readonly status: 'signed';
      /** The owner-signed `agent.label` (the route has core verify and apply it). */
      readonly label: { readonly body: JsonObject; readonly sig: string };
      /** Active, paired contacts that will be told. */
      readonly contacts: number;
    }
  | {
      readonly status: 'refused';
      readonly reason: 'rename_limited' | 'rotation_pending' | 'not_applied';
      /** With `rename_limited`: when a rename is allowed again (unix seconds). */
      readonly retryAt?: number;
    };

/** Exactly an `agent.label` for `agent` and `label`, nothing more. */
function isLabelBody(body: unknown, agent: string, label: string): body is JsonObject {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const b = body as JsonObject;
  const params = b['params'];
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return false;
  const p = params as JsonObject;
  return (
    b['op'] === 'agent.label' &&
    b['agent'] === agent &&
    Object.keys(p).length === 2 &&
    p['agent'] === agent &&
    p['label'] === label
  );
}

/**
 * An OwnerSession that signs one AgentCard for `agent` and `owner`, at exactly `keyEpoch` and with
 * the `nameHash` of exactly `name`, then nothing. Every other method is `owner_operation_refused`.
 * Closing it does not close the session it wraps (the gate does).
 */
export class RenameCardSession implements OwnerSession {
  #inner: OwnerSession | null;
  readonly #agent: string;
  readonly #owner: {
    readonly ownerEvm: string;
    readonly ownerNostr: string;
    readonly ownerEnc: string;
  };
  readonly #keyEpoch: number;
  readonly #nameHash: string;
  #signed = 0;

  constructor(
    inner: OwnerSession,
    agent: string,
    owner: OwnerPublicKeys,
    card: { readonly keyEpoch: number; readonly name: string },
  ) {
    this.#inner = inner;
    this.#agent = agent;
    this.#owner = {
      ownerEvm: encodeHex0x(owner.ownerEvm),
      ownerNostr: encodeHex0x(owner.ownerNostr),
      ownerEnc: encodeHex0x(owner.ownerEnc),
    };
    this.#keyEpoch = card.keyEpoch;
    this.#nameHash = encodeHex0x(agentCardNameHash(card.name));
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
        card['nameHash'] !== this.#nameHash
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

const refused = (
  reason: 'rename_limited' | 'rotation_pending' | 'not_applied',
  retryAt?: number,
): RenameSignOutcome =>
  Object.freeze({ status: 'refused', reason, ...(retryAt === undefined ? {} : { retryAt }) });

/** The checks before the gesture signs anything (also the route's precheck). */
export function renameRefusal(
  allowance: RenameAllowance,
  state: SendState,
): RenameSignOutcome | undefined {
  if (state === 'rotation_pending' || state === 'key_epoch_mismatch') {
    return refused('rotation_pending');
  }
  if (allowance.status === 'limited') return refused('rename_limited', allowance.retryAt);
  return undefined;
}

/**
 * The rename gesture's owner part with the session the gate unlocked (see the header): the next card
 * first, then exactly the prepared `agent.label`. Refusals come before anything is signed.
 */
export async function signRename(
  session: OwnerSession,
  ownerKeys: OwnerPublicKeys,
  input: RenameInput,
): Promise<RenameSignOutcome> {
  const { agent, client, label } = input;
  if (!isLabelBody(input.labelBody, agent, label)) return refused('not_applied');
  // Checked first (the label is checked again by core's label rule when it is applied).
  const frozen = checkGesture(input.review, [{ kind: 'owner-action', action: input.labelBody }]);
  const view = await client.identity.get();
  if (view === undefined || view.agentId !== agent || view.revoked) return refused('not_applied');
  const refusal = renameRefusal(
    await client.identity.renameAllowance(),
    await client.identity.sendState(),
  );
  if (refusal !== undefined) return refusal;
  const card = new RenameCardSession(session, agent, ownerKeys, {
    keyEpoch: view.keyEpoch + 1,
    name: label,
  });
  try {
    // The control takes exactly this gesture's card session, while the gate's session is live.
    const epochControl = keyEpochControlFor(
      input.epochKeys,
      (owner) => owner === card && session.isActive(),
    );
    await client.identity.rotate({ owner: card, ownerKeys, epochControl, name: label });
  } finally {
    await card.close();
  }
  const [signed] = await signGesture(session, frozen);
  if (signed?.kind !== 'owner-action') return refused('not_applied');
  // D-106: the core's sender tells each contact the owner's rules allow; best effort here, the next
  // sync pass sends what is left.
  await client.sendCardUpdates?.().catch(() => undefined);
  let contacts: number;
  try {
    const list = (await client.contacts?.list()) ?? [];
    contacts = list.filter((c) => c.status === 'active' && c.pairing === 'complete').length;
  } catch {
    contacts = 0;
  }
  return Object.freeze({ status: 'signed', label: signed.signed, contacts });
}
