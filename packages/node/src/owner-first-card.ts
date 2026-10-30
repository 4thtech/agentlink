// M1-8h (IR-M1-9b-1 M-3): the agent's first card, signed in `owner init` (04 §2.5: the owner setup
// operation includes "the card signature at owner setup"; 04 §2.4, §2.9 `init`).
//
// `owner init` has just stored the new owner, and still holds the owner code it generated (or the
// passphrase the owner typed twice). It unlocks the stored owner once with that secret (no second
// entry: one entry, one owner operation, D-68 (1)) and hands core `identity.init` a session that can
// do exactly one thing: sign one AgentCard (owner-allowlist.ts) that names this agent and this owner.
// Core builds the card from the agent's KeyStore, checks the owner signature, adds the agent's
// endorsement and stores both (M1-7a). The session is then closed and the secret wiped by the caller.
//
// I-4: the session never reaches MCP-reachable code: the caller is the CLI's own `owner init`
// process, and the only object that receives it is core's IdentityService.
import {
  KeyStoreError,
  encodeHex0x,
  type JsonObject,
  type NostrEvent,
  type OwnerPublicKeys,
  type OwnerSession,
  type TypedData,
} from '@4thtech-io/crypto';
import type {
  IdentityView,
  InitIdentityInput,
  OwnerActionOutcome,
  PolicyEditOptions,
  PreparedOwnerAction,
  PreparedPolicyEdit,
} from '@4thtech-io/core';
import { allowedTypedData, ownerOperationRefused } from './owner-allowlist.js';
import type { FirstLabel, FirstLabelActions } from './owner-first-label.js';

/** What `owner init` needs of core's IdentityService (`client.identity`). */
export interface FirstCardIdentity {
  /** The stored identity, or undefined before the first card. */
  get(): Promise<IdentityView | undefined>;
  /** Issues and stores the first card (04 §2.9 `init`); never replaces one. */
  init(input: InitIdentityInput): Promise<IdentityView>;
}

/** The agent whose first card `owner init` signs, and the card's off-chain parts. */
export interface FirstAgentCard {
  /** The agent's EVM address (`0x` + 40 lowercase hex): the card must name exactly this agent. */
  readonly agent: string;
  /**
   * The agent's local name (its folder). The card's display name (`nameHash`) when no first label
   * is signed with it; with one, the card is named by the label instead (cardNameOf, U3-d-b).
   */
  readonly name: string;
  /** The agent's own relay list the card commits to (`relaysHash`). */
  readonly relays: readonly string[];
  /** The agent's core IdentityService. */
  readonly identity: FirstCardIdentity;
  /**
   * M1-36b-2 (D-121 D6): the agent's first rules, signed after the card in the same owner-code entry
   * (owner-first-policy.ts). Omitted: only the card is signed.
   */
  readonly firstPolicy?: FirstPolicy;
  /**
   * U3-d (D-138): the agent's first `agent.label`, signed after the card (and the first rules) in the
   * same gesture (owner-first-label.ts). Omitted: no label is signed (the folder name is shown).
   */
  readonly firstLabel?: FirstLabel;
  /**
   * W4-ONE-TOUCH (D-140; 04 §2.8 "Create an agent and connect its AI app with one gesture"): the
   * agent's first `app.connect`, fixed at begin, signed last in the same gesture and only after the
   * card, the rules (when given) and the label are stored and verified. Omitted: no app is connected.
   */
  readonly firstConnect?: FirstConnect;
  /**
   * W4-ONE-TOUCH: the plan fixed at begin (owner-add-agent-plan.ts): the ordered unsigned bodies the
   * one gesture may sign. With it, the owner session signs exactly these bodies, in order, each once
   * and byte for byte, and refuses anything else (the restricted session of 04 §2.8).
   */
  readonly plan?: readonly JsonObject[];
}

/** W4-ONE-TOUCH: the first `app.connect` of an agent created on the same screen (04 §2.8). */
export interface FirstConnect {
  /** The unsigned `app.connect` body fixed at begin (04 §2.5.1), for exactly this agent. */
  readonly body: JsonObject;
  /** Verifies, nonce-checks and stores one SignedOwnerAction in this agent's store (core apply). */
  apply(input: object): Promise<OwnerActionOutcome>;
}

/** What the first rules need of core's OwnerActions (`client.ownerActions`). */
export interface FirstPolicyActions {
  /** Builds the unsigned `policy.set` (M1-11r-b); signs and grants nothing. */
  preparePolicyEdit(patch: unknown, options?: PolicyEditOptions): Promise<PreparedPolicyEdit>;
  /** Verifies and applies one SignedOwnerAction (owner signature, nonce, version). */
  apply(input: object): Promise<OwnerActionOutcome>;
  /**
   * U3-d: builds the unsigned `agent.label` (core `prepareLabel`), for the first label signed with
   * the first rules (first run with a name, Add an agent). Absent: no first label can be signed.
   */
  prepareLabel?(label: string): Promise<PreparedOwnerAction>;
  /**
   * W4-ONE-TOUCH (04 §2.8 "Failure in the middle"): records a stored `app.connect` as not applied
   * (core `markAppNotApplied`) when its config entry could not be written. Absent: not recorded.
   */
  markAppNotApplied?(app: string, nonce: string): Promise<boolean>;
}

/** U3-d: the first-label actions of `actions`, when it can prepare one (core OwnerActions can). */
export function labelActionsOf(
  actions: FirstPolicyActions | undefined,
): FirstLabelActions | undefined {
  const prepare = actions?.prepareLabel;
  if (actions === undefined || prepare === undefined) return undefined;
  return Object.freeze<FirstLabelActions>({
    prepareLabel: (label) => prepare.call(actions, label),
    apply: (input) => actions.apply(input),
  });
}

/** M1-36b-2: the first rules: the 06 §3 defaults plus the empty `~/AgentLink/Send` folder. */
export interface FirstPolicy {
  readonly actions: FirstPolicyActions;
  /** The home folder the Send folder is created in; default the OS user's (tests only). */
  readonly home?: string;
  /**
   * W4-ONE-TOUCH: the unsigned first `policy.set` fixed at begin. With it, exactly this body is
   * signed (after the same checks), never a newly prepared one.
   */
  readonly body?: JsonObject;
}

/**
 * An OwnerSession that signs one AgentCard for `agent` and `owner`, then nothing. Every other method
 * is `owner_operation_refused`. Closing it closes the session it wraps.
 */
export class FirstCardSession implements OwnerSession {
  #inner: OwnerSession | null;
  readonly #agent: string;
  readonly #owner: {
    readonly ownerEvm: string;
    readonly ownerNostr: string;
    readonly ownerEnc: string;
  };
  #signed = 0;

  constructor(inner: OwnerSession, agent: string, owner: OwnerPublicKeys) {
    this.#inner = inner;
    this.#agent = agent;
    this.#owner = {
      ownerEvm: encodeHex0x(owner.ownerEvm),
      ownerNostr: encodeHex0x(owner.ownerNostr),
      ownerEnc: encodeHex0x(owner.ownerEnc),
    };
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
        card['ownerEnc'] !== this.#owner.ownerEnc
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

  close(): Promise<void> {
    const inner = this.#inner;
    this.#inner = null;
    return inner === null ? Promise.resolve() : inner.close();
  }
}
