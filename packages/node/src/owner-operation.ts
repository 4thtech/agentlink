// M1-8c: one owner operation (04 §2.5; D-68 "one entry, one owner operation, no unlock session").
// The owner sees what is about to be signed, types the owner code (or opted-in owner passphrase)
// once at the TTY prompt, the seed is unwrapped, exactly one object is signed, and the session is
// closed and its keys wiped before this returns, whatever happened. No API here keeps a session,
// caches the secret or the seed, or offers to remember it for a time.
//
// Batch approval (04 §2.5.2) is one such operation: owner-approval.ts builds one
// `approval.decideBatch` over the reviewed items and signs it here.
import {
  OWNER_SESSION_DEFAULT_TTL_MS,
  canonicalize,
  parseJson,
  type JsonObject,
  type OwnerKeyStore,
  type OwnerPublicKeys,
  type SecretKind,
  type TypedData,
} from '@agentlink/crypto';
import { assertAllowedOwnerAction, ownerOperationRefused } from './owner-allowlist.js';
import { NodeKeyStoreError } from './errors.js';
import { osKeychain } from './keychain.js';
import { KeychainOwnerKeyStore } from './owner-keystore.js';
import { assertNoHarnessMarker, ttyOwnerTerminal, type OwnerTerminal } from './owner-terminal.js';

/** The one object an owner operation signs. */
export type OwnerSignRequest =
  /** An OwnerAction body (04 §2.5.1), `owner` already set to the owner's Nostr key. */
  | { readonly kind: 'owner-action'; readonly action: JsonObject }
  /**
   * EIP-712 data: refused by every owner operation here (M1-8h-b, IR-M1-8h-1 L3). An agent card is
   * signed only through the bound card sessions (owner-first-card.ts). Kept in the type so a caller
   * that passes one gets the fixed refusal.
   */
  | { readonly kind: 'typed-data'; readonly typedData: TypedData };

/** The owner's signature. */
export type OwnerSignature =
  /** The SignedOwnerAction: `body` is the exact object that was signed (parsed from its JCS). */
  | {
      readonly kind: 'owner-action';
      readonly signed: { readonly body: JsonObject; readonly sig: string };
    }
  | { readonly kind: 'typed-data'; readonly signature: string };

/** What the owner is shown before the prompt. */
export interface OwnerReview {
  /** Fixed text lines (I-5: built from stored data, never inbound text). */
  readonly lines: readonly string[];
  /** A yes/no question asked after the lines and before the prompt; "no" cancels. */
  readonly question?: string;
}

/** One owner operation with a one-line summary, for the package entry. */
export type OwnerOperationItem = OwnerSignRequest & { readonly summary: string };

const invalid = (message: string): NodeKeyStoreError =>
  new NodeKeyStoreError('owner_operation_invalid', message);

// eslint-disable-next-line no-control-regex -- terminal control characters are refused in copy
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

/** A printable line for the owner's terminal: a non-empty string with no control character. */
export function assertPrintable(text: unknown, what: string): asserts text is string {
  if (typeof text !== 'string' || text.length === 0 || CONTROL.test(text)) {
    throw invalid(`${what} is not printable text.`);
  }
}

/** The request, read once and frozen before the owner is asked: what is shown is what is signed. */
function snapshot(request: unknown): OwnerSignRequest {
  if (typeof request !== 'object' || request === null) throw invalid('The request is malformed.');
  const { kind, action } = request as Record<string, unknown>;
  if (kind === 'owner-action') {
    if (typeof action !== 'object' || action === null || Array.isArray(action)) {
      throw invalid('An owner action must be an object.');
    }
    const copy = parseJson(canonicalize(action)) as JsonObject;
    // M1-8h: only the ops of 04 §2.5.1 (owner-allowlist.ts).
    assertAllowedOwnerAction(copy);
    return Object.freeze({ kind, action: copy });
  }
  if (kind === 'typed-data') {
    // M1-8h allowed only the agent card here (04 §2.4). M1-8h-b (IR-M1-8h-1 L3): not the card
    // either, and typed data is refused whatever it holds. This generic operation knows no agent to
    // bind a card to, so it would sign a card for any agent. Cards are signed only through the bound
    // sessions of owner init and owner add-agent (owner-first-card.ts, 04 §2.5, §2.8); the task that
    // adds another card flow (rotation, 04 §2.6) adds its own bound path.
    throw ownerOperationRefused();
  }
  throw invalid('The request has an unknown kind.');
}

/**
 * Reads an owner operation's request once and checks it against the allowlist (owner-allowlist.ts),
 * before any terminal, keychain or prompt is touched.
 */
export function checkOwnerRequest(request: unknown): OwnerSignRequest {
  return snapshot(request);
}

/** The prompt label for the stored secret (11 §5.5 names). */
export const secretLabel = (kind: SecretKind): string =>
  kind === 1 ? 'Owner code:' : 'Owner passphrase:';

/** What owner flows need from the owner store beyond OwnerKeyStore: the stored secret's kind. */
export interface PromptingOwnerKeyStore extends OwnerKeyStore {
  secretKind(): Promise<SecretKind>;
}

/**
 * The objects one gesture may sign (04 §2.5, D-68): exactly one, or the two of 06 §3 "Remember for
 * this contact": an `approval.decide` and the `policy.set` it brings, confirmed on one screen.
 */
function assertOneGesture(frozen: readonly OwnerSignRequest[]): void {
  if (frozen.length === 1) return;
  const op = (r: OwnerSignRequest | undefined): unknown =>
    r?.kind === 'owner-action' ? r.action['op'] : undefined;
  if (
    frozen.length === 2 &&
    op(frozen[0]) === 'approval.decide' &&
    op(frozen[1]) === 'policy.set'
  ) {
    return;
  }
  throw invalid('One owner operation signs one object, or an approval with its rule change.');
}

/**
 * Runs one owner operation: shows the review, asks its question if any, reads the owner secret once
 * at the prompt, unlocks, signs exactly the snapshots (one object, or an approval and its rule change
 * in the same gesture), then closes the session (its keys are wiped) and locks the store, whatever
 * happened. Every signature after that fails with `owner_locked`. A wrong secret is
 * `presence_rejected` (KeyStoreError) and nothing is signed.
 */
export async function runOwnerGesture(
  store: PromptingOwnerKeyStore,
  terminal: OwnerTerminal,
  review: OwnerReview,
  requests: readonly OwnerSignRequest[],
): Promise<readonly OwnerSignature[]> {
  if (!Array.isArray(requests)) throw invalid('The request is malformed.');
  const frozen = (requests as readonly unknown[]).map(snapshot);
  assertOneGesture(frozen);
  const lines = [...review.lines];
  if (lines.length === 0) throw invalid('Nothing to show the owner.');
  for (const line of lines) assertPrintable(line, 'A review line');
  if (review.question !== undefined) assertPrintable(review.question, 'The question');
  const kind = await store.secretKind();
  for (const line of lines) terminal.write(line);
  if (review.question !== undefined && !(await terminal.confirm(review.question))) {
    throw new NodeKeyStoreError('owner_prompt_cancelled', 'Cancelled. Nothing was changed.');
  }
  const secret = await terminal.readSecret(secretLabel(kind));
  // unlock wipes the secret whether or not it unlocks (OwnerKeyStore contract).
  const session = await store.unlock(
    { kind: 'passphrase', secret },
    { ttlMs: OWNER_SESSION_DEFAULT_TTL_MS },
  );
  try {
    const out: OwnerSignature[] = [];
    for (const request of frozen) {
      if (request.kind === 'owner-action') {
        const sig = await session.signOwnerAction(request.action);
        out.push(
          Object.freeze({
            kind: request.kind,
            signed: Object.freeze({ body: request.action, sig }),
          }),
        );
      } else {
        const signature = await session.sign712(request.typedData);
        out.push(Object.freeze({ kind: request.kind, signature }));
      }
    }
    return Object.freeze(out);
  } finally {
    await session.close();
    await store.lock();
  }
}

/** One owner operation that signs one object (runOwnerGesture with a single request). */
export async function runOwnerOperation(
  store: PromptingOwnerKeyStore,
  terminal: OwnerTerminal,
  review: OwnerReview,
  request: OwnerSignRequest,
): Promise<OwnerSignature> {
  const [signature] = await runOwnerGesture(store, terminal, review, [request]);
  if (signature === undefined) throw new Error('unreachable');
  return signature;
}

/**
 * The package entry (index.ts): one owner operation for the owner the agent card names, against the
 * OS keychain's `owner` item, on this process's own terminal. No argument, variable, file or pipe
 * carries the owner secret; without an interactive terminal this is `owner_prompt_unavailable`
 * before anything is read.
 */
export async function performOwnerOperation(
  owner: OwnerPublicKeys,
  item: OwnerOperationItem,
): Promise<OwnerSignature> {
  // M1-8h: an object outside the allowlist is refused first, with fixed text (owner-allowlist.ts).
  checkOwnerRequest(item);
  assertNoHarnessMarker();
  const terminal = ttyOwnerTerminal();
  const store = await KeychainOwnerKeyStore.open(osKeychain(), owner);
  try {
    const { summary } = item;
    assertPrintable(summary, 'The summary');
    return await runOwnerOperation(store, terminal, { lines: [summary] }, item);
  } finally {
    await store.close();
  }
}
