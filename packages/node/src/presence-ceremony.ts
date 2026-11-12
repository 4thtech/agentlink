// REL051-SF1: the single-use, action-bound challenge of every passkey presence proof on the local
// app (04 §2.5 "each passkey gesture unlocks the owner key for exactly one owner operation"; §2.5.3
// rules 1 and 5 applied to every presence route; 08 §1; I-4, I-7).
//
// What it is: the server's store of open presence ceremonies, and the binding of a ceremony to one
// request. Before a passkey gesture the page asks the very route it will call for a ceremony: the
// same method, path, query and action headers (`X-AgentLink-Input`, `X-AgentLink-Items`, the generation,
// `X-AgentLink-Digest`), with `X-AgentLink-Presence: challenge` and an empty body. The server answers
// a ceremony ID and a WebAuthn challenge derived from a fresh nonce and the binding of that request.
// The page then calls the route with `X-AgentLink-Presence: passkey`, `X-AgentLink-Ceremony: <id>`
// and the assertion (credential ID, authenticator data, clientDataJSON, signature, user handle, PRF
// output; pay-confirm.ts encodePayConfirmAssertion).
//
// Rules (each has a test in presence-ceremony.test.ts and the server tests):
// - A ceremony is bound to the page session that asked for it and to the binding of the request
//   (method, path with query, and the three action headers exactly as sent). It lives
//   PRESENCE_CEREMONY_TTL_MS (120 s), at most MAX_PRESENCE_CEREMONIES are open (the oldest goes).
// - `take` removes it whatever the outcome (single use): unknown, another session's, expired or
//   bound to another request are all refused, and the ceremony is gone.
// - The server then checks the assertion as a paid-action confirmation does (pay-confirm.ts
//   checkPayConfirmAssertion): `webauthn.get`, exactly this challenge, the page's origin, rpIdHash,
//   UP, the stored credential and the owner as user handle, the authenticator's signature with the
//   stored credential public key, and UV. A passkey without a stored key is refused on the passkey
//   path (`passkey_update_needed`); the master code still works.
// - So a captured request body is no longer a credential: it carries a signature over a challenge
//   that was consumed when it was first used, for one route and one input.
// - I-7: no nonce, challenge, binding or assertion is logged, emitted or put in an error. Ceremonies
//   live in memory only and are wiped when taken, expired, dropped or cleared.
import {
  concatBytes,
  encodeBase64url,
  encodeUtf8,
  equalBytes,
  randomBytes,
  sha256,
  wipe,
} from '@4thtech-io/crypto';

/** How long the page has between asking for a ceremony and sending the gesture. */
export const PRESENCE_CEREMONY_TTL_MS = 120_000;
/** At most this many open ceremonies (a few tabs and sheets); the oldest goes first. */
export const MAX_PRESENCE_CEREMONIES = 8;
/** The header that names the ceremony a passkey proof answers. */
export const PRESENCE_CEREMONY_HEADER = 'x-agentlink-ceremony';
/** The `X-AgentLink-Presence` value that asks for a ceremony instead of acting. */
export const PRESENCE_CHALLENGE_MODE = 'challenge';

const DOMAIN = encodeUtf8('agentlink/presence-ceremony/v1');
const ID = /^[A-Za-z0-9_-]{22}$/;

/** The parts of a request a ceremony is bound to. */
export interface PresenceBindingInput {
  readonly method: string;
  /** The request target as sent: path and query. */
  readonly target: string;
  readonly input: string | undefined;
  readonly items: string | undefined;
  readonly digest: string | undefined;
  /** The app host's generation (`X-AgentLink-Generation`): a ceremony never outlives a switch. */
  readonly generation?: string | undefined;
}

/** SHA-256 over the canonical JSON of the bound request parts. */
export function presenceBinding(parts: PresenceBindingInput): Uint8Array {
  const value = JSON.stringify([
    'agentlink-presence-binding-v1',
    parts.method,
    parts.target,
    parts.input ?? null,
    parts.items ?? null,
    parts.digest ?? null,
    parts.generation ?? null,
  ]);
  return sha256(encodeUtf8(value));
}

export interface PresenceCeremony {
  readonly id: string;
  readonly challenge: Uint8Array;
  readonly session: Uint8Array;
  readonly binding: Uint8Array;
  readonly expiresAt: number;
}

export type PresenceCeremonyTake = PresenceCeremony | 'unknown' | 'expired' | 'mismatch';

/** The open ceremonies of one local server. */
export class PresenceCeremonies {
  readonly #now: () => number;
  readonly #open = new Map<string, PresenceCeremony>();

  constructor(now: () => number) {
    this.#now = now;
  }

  /** A new ceremony for `session` and `binding`; its challenge goes to the page. */
  issue(session: Uint8Array, binding: Uint8Array): PresenceCeremony {
    this.sweep();
    while (this.#open.size >= MAX_PRESENCE_CEREMONIES) {
      const oldest = this.#open.keys().next();
      if (oldest.done === true) break;
      this.drop(oldest.value);
    }
    const nonce = randomBytes(32);
    const challenge = sha256(concatBytes(DOMAIN, nonce, binding));
    wipe(nonce);
    const ceremony: PresenceCeremony = {
      id: encodeBase64url(randomBytes(16)),
      challenge,
      session: session.slice(),
      binding: binding.slice(),
      expiresAt: this.#now() + PRESENCE_CEREMONY_TTL_MS,
    };
    this.#open.set(ceremony.id, ceremony);
    return ceremony;
  }

  /**
   * Takes the ceremony `id` for `session` and `binding`: single use, removed whatever the outcome
   * once it names an open ceremony. Another session's ceremony is `unknown` and is not consumed
   * (another page session can neither see nor spend it). The caller wipes the result (`wipeOf`).
   */
  take(id: unknown, session: Uint8Array, binding: Uint8Array): PresenceCeremonyTake {
    if (typeof id !== 'string' || !ID.test(id)) return 'unknown';
    const ceremony = this.#open.get(id);
    if (ceremony === undefined || !equalBytes(ceremony.session, session)) return 'unknown';
    this.#open.delete(id);
    if (this.#now() >= ceremony.expiresAt) {
      PresenceCeremonies.wipeOf(ceremony);
      return 'expired';
    }
    if (!equalBytes(ceremony.binding, binding)) {
      PresenceCeremonies.wipeOf(ceremony);
      return 'mismatch';
    }
    return ceremony;
  }

  /** Removes and wipes one ceremony. */
  drop(id: string): void {
    const ceremony = this.#open.get(id);
    if (ceremony === undefined) return;
    this.#open.delete(id);
    PresenceCeremonies.wipeOf(ceremony);
  }

  /** Drops the expired ceremonies, and with `open` those of page sessions no longer open. */
  sweep(open?: (session: Uint8Array) => boolean): void {
    const now = this.#now();
    for (const [id, ceremony] of [...this.#open]) {
      if (now >= ceremony.expiresAt || (open !== undefined && !open(ceremony.session))) {
        this.drop(id);
      }
    }
  }

  /** Drops every ceremony (the server closes). */
  clear(): void {
    for (const id of [...this.#open.keys()]) this.drop(id);
  }

  get size(): number {
    return this.#open.size;
  }

  /** Wipes a ceremony's bytes (after it was taken and used). */
  static wipeOf(ceremony: PresenceCeremony): void {
    wipe(ceremony.challenge, ceremony.session, ceremony.binding);
  }
}
