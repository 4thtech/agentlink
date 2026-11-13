// REL051-CF3 (R1-CLASS-03, R1-UI-02; 04 §2.3.3 T-12, §2.5; 08 §1; proposed, owner confirms at merge):
// the master code that first run or a restore just showed, held so that a reload of "Your master
// code" (or of restore step 4) shows the same code and step again until the owner says "I saved it".
//
// - Server memory only, never on disk, in a log, an event, an error or an MCP answer (I-4, I-7).
// - Bound to the page session that got the code in its one answer: only that session's
//   `POST /api/ui/master-code/show` gets it back (a session cookie survives a reload; a restart makes
//   new sessions, so a restart never shows it again).
// - At most one, for MASTER_CODE_HOLD_MS (10 minutes, as an opened kit); a new one replaces it.
//   Expiry, "I saved it", a replaced master code and the server closing wipe it.
// - What the page needs to draw the step again comes with it, public fields only (`view`).
//
// Residual (G-1, as the opened kit of 04 §2.3.3): a same-user process that can read the server's
// memory, or that holds this page session, could read the code during those 10 minutes.
import { decodeUtf8, encodeUtf8, equalBytes, wipe, type JsonValue } from '@4thtech-io/crypto';
import type { UnsavedKind } from '../master-code-unsaved.js';

/** How long a shown master code can be shown again to the same page session. */
export const MASTER_CODE_HOLD_MS = 10 * 60 * 1000;

interface Held {
  readonly session: Uint8Array;
  readonly code: Uint8Array;
  readonly kind: UnsavedKind;
  readonly view: Readonly<Record<string, JsonValue>>;
  readonly expiresAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

export type HeldMasterCode =
  | {
      readonly status: 'shown';
      readonly kind: UnsavedKind;
      readonly code: string;
      readonly view: Readonly<Record<string, JsonValue>>;
    }
  /** Held for another page session (another tab): nothing to say here. */
  | { readonly status: 'elsewhere' }
  | { readonly status: 'none' };

export class MasterCodeHold {
  readonly #now: () => number;
  readonly #holdMs: number;
  #held: Held | undefined;

  constructor(options: { readonly now: () => number; readonly holdMs?: number }) {
    this.#now = options.now;
    this.#holdMs = options.holdMs ?? MASTER_CODE_HOLD_MS;
  }

  /** Holds `code` (as shown) for `session`; any earlier hold is wiped. */
  hold(
    session: Uint8Array,
    code: string,
    kind: UnsavedKind,
    view: Readonly<Record<string, JsonValue>>,
  ): void {
    this.clear();
    const held: Held = {
      session: session.slice(),
      code: encodeUtf8(code),
      kind,
      view,
      expiresAt: this.#now() + this.#holdMs,
      timer: setTimeout(() => this.#drop(held), this.#holdMs),
    };
    held.timer.unref();
    this.#held = held;
  }

  /** The code again, for the session that got it, while it lasts. */
  shownTo(session: Uint8Array): HeldMasterCode {
    const held = this.#live();
    if (held === undefined) return { status: 'none' };
    if (!equalBytes(held.session, session)) return { status: 'elsewhere' };
    return { status: 'shown', kind: held.kind, code: decodeUtf8(held.code), view: held.view };
  }

  /** "I saved it" from `session`: wipes its hold. False when another session holds one. */
  saved(session: Uint8Array): boolean {
    const held = this.#live();
    if (held === undefined) return true;
    if (!equalBytes(held.session, session)) return false;
    this.#drop(held);
    return true;
  }

  /** Wipes whatever is held (a replaced master code, the server closing). */
  clear(): void {
    if (this.#held !== undefined) this.#drop(this.#held);
  }

  #live(): Held | undefined {
    const held = this.#held;
    if (held !== undefined && this.#now() >= held.expiresAt) {
      this.#drop(held);
      return undefined;
    }
    return held;
  }

  #drop(held: Held): void {
    clearTimeout(held.timer);
    if (this.#held === held) this.#held = undefined;
    wipe(held.code, held.session);
  }
}
