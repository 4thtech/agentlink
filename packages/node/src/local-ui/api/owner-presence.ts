// UX1113 WP-S2 (design-1112 §3.3; 04 §2.5 "Touch ID & master code page"; 08 §1): the API of
// Settings › Touch ID & master code. Five POST owner routes, each an owner-code step at its fixed path
// (owner-code-paths.ts), all run by the approval server's central presence gate (ownerGate), so each
// shares the one wrong-code backoff, the one-operation-at-a-time rule and the generic answers of every
// presence route. No MCP tool reaches any of them (I-4; apps/cli/test/owner-controls-fence.test.ts).
//
// - `check` (Check my master code): the master code only (a passkey proof is `presence_required`).
//   It is an oracle for the code, so it is exactly as limited as every presence route: the same
//   backoff and wait, and a wrong code is the same 403 `presence_rejected`. Signs nothing.
// - `test` (Test Touch ID): a passkey assertion or, in the desktop app, native presence (DESK051-C2);
//   never the master code. The gate checks it and opens the owner store with it, closes that session
//   at once, and the handler gets no way to sign or read anything.
// - `replace`: either proof. The gate opens the owner store for this one request and the handler's
//   `replaceOwnerCode` stages a new generated master code in `owner-next` for this page session
//   (OwnerCodeChanges below; owner-change-code.ts). The `owner` item is untouched, so the current code
//   keeps working. The answer carries the new code once; it is never logged or emitted.
// - `finish`: the new code typed back (never a passkey). It must open exactly the staged item of this
//   page session; a wrong one counts towards the backoff like any wrong code, and the third ends the
//   change. Then the staged item replaces the `owner` item, all or nothing.
// - `cancel`: no proof; drops this page session's staged change. The gate answers it itself.
import type { Argon2idParams } from '@4thtech-io/crypto';
import { equalBytes, wipe } from '@4thtech-io/crypto';
import { NodeKeyStoreError } from '../../errors.js';
import type { KeychainBackend } from '../../keychain.js';
import {
  dropOwnerCodeChange,
  finishOwnerCodeChange,
  openStagedOwnerCode,
  stageOwnerCodeChange,
  wipeOwnerCodeChange,
  type StagedOwnerCodeChange,
} from '../../owner-change-code.js';
import type { OwnerPublicKeys } from '@4thtech-io/crypto';
import { OWNER_CODE_PATHS, type LocalUiOwnerCodeStep } from '../owner-code-paths.js';
import {
  NOT_AVAILABLE,
  type LocalUiOwnerOperation,
  type LocalUiOwnerRoute,
  type LocalUiResult,
  type LocalUiRoute,
} from '../route-types.js';

const fixed = (status: number, body: Record<string, string>): LocalUiResult =>
  Object.freeze({ status, body: Object.freeze(body) });
const DONE = fixed(200, { status: 'done' });
const REFUSED = fixed(409, { status: 'refused' });
const UNFINISHED = fixed(409, { status: 'unfinished' });
/** The staged item may have replaced `owner` but the keychain did not confirm it (keep both codes). */
const UNCONFIRMED = fixed(200, { status: 'unconfirmed' });
/** The new code as the generator spells it: six groups of four, base32 upper case. */
const NEW_CODE = /^[A-Z2-7]{4}(?: [A-Z2-7]{4}){5}$/;

/** check, test: the gate verified presence; record the one operation, sign nothing. */
function presenceOnly(owner: LocalUiOwnerOperation): Promise<LocalUiResult> {
  if (owner.presenceChecked === undefined) return Promise.resolve(REFUSED);
  owner.presenceChecked();
  return Promise.resolve(DONE);
}

async function replace(owner: LocalUiOwnerOperation): Promise<LocalUiResult> {
  if (owner.replaceOwnerCode === undefined) return REFUSED;
  const outcome = await owner.replaceOwnerCode();
  if (outcome.status === 'unfinished') return UNFINISHED;
  if (!NEW_CODE.test(outcome.code)) return fixed(500, { status: 'failed' });
  return { status: 200, body: { status: 'staged', code: outcome.code } };
}

async function finish(owner: LocalUiOwnerOperation): Promise<LocalUiResult> {
  if (owner.finishOwnerCode === undefined) return REFUSED;
  // IR WP-S2 M-1: written but not confirmed is its own answer, never "nothing was changed".
  return (await owner.finishOwnerCode()) === 'done' ? DONE : UNCONFIRMED;
}

function route(
  step: LocalUiOwnerCodeStep,
  handler: (owner: LocalUiOwnerOperation) => Promise<LocalUiResult>,
): LocalUiOwnerRoute {
  return Object.freeze<LocalUiOwnerRoute>({
    method: 'POST',
    path: OWNER_CODE_PATHS[step],
    presence: true,
    ownerCode: step,
    handler: (_context, _request, owner) => handler(owner),
  });
}

export const ownerPresenceRoutes: readonly LocalUiRoute[] = Object.freeze([
  route('check', presenceOnly),
  route('test', presenceOnly),
  route('replace', replace),
  route('finish', finish),
  // The gate answers `cancel` itself (it needs no proof); this handler never runs (fail closed).
  route('cancel', () => Promise.resolve(NOT_AVAILABLE)),
]);

// --- The staged change, held by the approval server --------------------------------------------

/** How long a staged change waits for the code to be typed back. */
export const OWNER_CODE_HOLD_MS = 10 * 60 * 1000;
/** Wrong codes typed back before the change ends. */
export const OWNER_CODE_TRIES = 3;

interface Held {
  /** The page session that began it (its cookie secret, copied). */
  readonly session: Uint8Array;
  readonly change: StagedOwnerCodeChange;
  readonly expiresAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
  tries: number;
}

export interface OwnerCodeChangesOptions {
  readonly keychain: () => KeychainBackend;
  readonly now: () => number;
  readonly kdf?: Argon2idParams;
  readonly holdMs?: number;
}

/**
 * At most one staged master-code change per server, bound to the page session that began it. It
 * holds ciphertext and public keys only (never the seed or the code). A new `begin` drops the one
 * before; expiry, Cancel, the third wrong entry and the server closing drop it too (the staged item is
 * removed only while it is still those bytes, so the current code keeps working).
 */
export class OwnerCodeChanges {
  readonly #options: OwnerCodeChangesOptions;
  #held: Held | undefined;
  #pending: Promise<unknown> = Promise.resolve();

  constructor(options: OwnerCodeChangesOptions) {
    this.#options = options;
  }

  /** Stages a new code for `session` (after presence). `seed` is not modified. */
  async begin(
    session: Uint8Array,
    seed: Uint8Array,
    owner: OwnerPublicKeys,
  ): Promise<
    { readonly status: 'staged'; readonly code: string } | { readonly status: 'unfinished' }
  > {
    await this.#drop(this.#held);
    const outcome = await stageOwnerCodeChange(this.#options.keychain(), seed, owner, {
      ...(this.#options.kdf === undefined ? {} : { kdf: this.#options.kdf }),
    });
    if (outcome.status !== 'staged') return outcome;
    const holdMs = this.#options.holdMs ?? OWNER_CODE_HOLD_MS;
    const held: Held = {
      session: session.slice(),
      change: outcome.change,
      expiresAt: this.#options.now() + holdMs,
      timer: setTimeout(() => void this.#drop(held), holdMs),
      tries: 0,
    };
    held.timer.unref();
    this.#held = held;
    return { status: 'staged', code: outcome.code };
  }

  /** The change `session` began, while it is still live; an expired one is dropped first. */
  async heldBy(session: Uint8Array): Promise<Held | undefined> {
    const held = this.#held;
    if (held === undefined || !equalBytes(held.session, session)) return undefined;
    if (this.#options.now() >= held.expiresAt) {
      await this.#drop(held);
      return undefined;
    }
    return held;
  }

  /** True when `typed` (wiped) opens exactly the staged item. */
  open(held: Held, typed: Uint8Array): Promise<boolean> {
    return openStagedOwnerCode(this.#options.keychain(), held.change, typed);
  }

  /** Counts a wrong code typed back; the third ends the change. */
  async rejected(held: Held): Promise<void> {
    held.tries += 1;
    if (held.tries >= OWNER_CODE_TRIES) await this.#drop(held);
  }

  /** The staged item replaces the `owner` item; the change is then over either way. */
  async finish(held: Held): Promise<'done' | 'unconfirmed'> {
    if (this.#held !== held) throw new Error('not pending');
    this.#forget(held);
    try {
      await finishOwnerCodeChange(this.#options.keychain(), held.change);
      return 'done';
    } catch (error) {
      // IR WP-S2 M-1: `owner_mismatch` is refused before any write (nothing changed). Anything else
      // may have written the `owner` item without a confirming read-back: the old code may be dead
      // and `owner-next` is kept, so the owner must keep both codes and finish in the terminal.
      if (error instanceof NodeKeyStoreError && error.code === 'owner_mismatch') throw error;
      return 'unconfirmed';
    } finally {
      wipeOwnerCodeChange(held.change);
    }
  }

  /** Cancel: drops `session`'s change. False when it has none. */
  async cancel(session: Uint8Array): Promise<boolean> {
    const held = await this.heldBy(session);
    if (held === undefined) return false;
    await this.#drop(held);
    return true;
  }

  /** The server closes: drop whatever is staged. */
  async clear(): Promise<void> {
    await this.#drop(this.#held);
    await this.#pending;
  }

  #forget(held: Held): void {
    clearTimeout(held.timer);
    if (this.#held === held) this.#held = undefined;
    wipe(held.session);
  }

  async #drop(held: Held | undefined): Promise<void> {
    if (held === undefined) return;
    const wasHeld = this.#held === held;
    this.#forget(held);
    if (!wasHeld) return;
    const removal = dropOwnerCodeChange(this.#options.keychain(), held.change).finally(() =>
      wipeOwnerCodeChange(held.change),
    );
    this.#pending = this.#pending.then(() => removal).catch(() => undefined);
    await removal.catch(() => false);
  }
}
