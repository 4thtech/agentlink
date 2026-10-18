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
  type NostrEvent,
  type OwnerPublicKeys,
  type OwnerSession,
  type TypedData,
} from '@4thtech-io/crypto';
import type { IdentityView, InitIdentityInput } from '@4thtech-io/core';
import { allowedTypedData, ownerOperationRefused } from './owner-allowlist.js';

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
  /** The display name the card commits to (`nameHash`). */
  readonly name: string;
  /** The agent's own relay list the card commits to (`relaysHash`). */
  readonly relays: readonly string[];
  /** The agent's core IdentityService. */
  readonly identity: FirstCardIdentity;
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
