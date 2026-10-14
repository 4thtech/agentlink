// M1-8c: approving reviewed requests in one owner operation (04 §2.5.1, §2.5.2; D-68). One entry of
// the owner code signs one object over exactly the items shown: `approval.decide` for one item (a
// single decision is never a batch of one), `approval.decideBatch` for 2 to 20.
//
// What this module does (node, the signing surface):
// - recomputes each item's actionDigest = sha256(JCS(action)) from the action it is given and refuses
//   the whole operation if a stored digest differs (a mismatched request is never offered);
// - builds the canonical params: items in strictly ascending `approvalId` byte order, no duplicates;
// - sets expiresAt ≤ issuedAt + 600 s (proposed local bound) and ≤ the earliest request expiry;
// - shows every item and the totals, asks "Continue?", then the owner code once; signs; wipes.
//
// - refuses a commitment (D-31) inside a batch: terms are always decided alone (IR-D-68-1);
// - covers exactly one agent: the one `agent` of the context.
//
// What it does not do (core): loading the pending requests and their stored actions (M1-7e, with the
// CLI's `agentlink approve` in M1-9b), and verifying and applying the signed object whole-or-nothing
// in one store transaction, with the nonce (burned also when a batch is refused), per-item matching
// and refusal reports (M1-7d, M1-7e).
import {
  encodeBase64url,
  encodeHex,
  randomBytes,
  sha256,
  canonicalizeToBytes,
  type JsonObject,
  type JsonValue,
  type OwnerPublicKeys,
} from '@agentlink/crypto';
import { NodeKeyStoreError } from './errors.js';
import { assertAgentId, osKeychain } from './keychain.js';
import { KeychainOwnerKeyStore, ownerKeysCopy } from './owner-keystore.js';
import {
  assertPrintable,
  runOwnerOperation,
  type PromptingOwnerKeyStore,
} from './owner-operation.js';
import { ttyOwnerTerminal, type OwnerTerminal } from './owner-terminal.js';

/** 04 §2.5.2 (proposed): at most 20 items per `approval.decideBatch`; a batch has at least 2. */
export const MAX_APPROVAL_BATCH_ITEMS = 20;
export const MIN_APPROVAL_BATCH_ITEMS = 2;
/** 04 §2.5.1 / §2.5.2 (proposed): the CLI sets expiresAt at most issuedAt + 600 s. */
export const LOCAL_APPROVAL_LIFETIME_S = 600;

/** One pending request the owner reviewed and decided. */
export interface ReviewedApproval {
  /** `apr_` + base64url of 16 bytes (04 §2.4.1). */
  readonly approvalId: string;
  /**
   * The stored action the request covers, as JSON: its sha256(JCS) is the actionDigest that is
   * signed (for a commitment, the scope object of 04 §3.4.2). Recomputed here, never trusted.
   */
  readonly action: JsonValue;
  /** The digest stored with the request, if the caller has one: it must equal the recomputed one. */
  readonly storedDigest?: string;
  readonly decision: 'approve' | 'deny';
  /**
   * True for a commitment (D-31: a binding `accept`, anything under policy `commitments`). It is
   * never batched in M1 (IR-D-68-1): it is decided alone, as an `approval.decide`.
   */
  readonly commitment: boolean;
  /** Fixed text built by the core from stored data (I-5, 06 §2.1); never inbound text. */
  readonly summary: string;
  /** The pending request's expiry, unix seconds (04 §3.4.1). */
  readonly requestExpiresAt: number;
}

export interface ApprovalContext {
  /** The agent's EVM address, `0x` + 40 lowercase hex (04 §2.5.1 `agent`). */
  readonly agent: string;
  /** The owner the agent card names. */
  readonly owner: OwnerPublicKeys;
}

/** Internal (tests): a fixed clock and nonce. */
export interface ApprovalInternals {
  readonly nowSeconds?: () => number;
  readonly nonce?: () => Uint8Array;
}

/** How the stored owner secret is named in the summary line (11 §5.5). */
export type OwnerSecretName = 'owner code' | 'owner passphrase';

/** The object to sign and what the owner sees before entering the code. */
export interface ApprovalOperation {
  readonly body: JsonObject;
  readonly lines: readonly string[];
  readonly question: string;
}

const APPROVAL_ID = /^apr_[A-Za-z0-9_-]{22}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

const invalid = (message: string): NodeKeyStoreError =>
  new NodeKeyStoreError('owner_operation_invalid', message);

interface Item {
  readonly commitment: boolean;
  readonly approvalId: string;
  readonly actionDigest: string;
  readonly decision: 'approve' | 'deny';
  readonly summary: string;
  readonly requestExpiresAt: number;
}

/** Reads one reviewed item once and recomputes its digest. */
function item(value: unknown, index: number): Item {
  const where = `Item ${String(index + 1)}`;
  if (typeof value !== 'object' || value === null) throw invalid(`${where} is malformed.`);
  const { approvalId, action, storedDigest, decision, commitment, summary, requestExpiresAt } =
    value as Record<string, unknown>;
  if (typeof commitment !== 'boolean') throw invalid(`${where} doesn't say whether it is terms.`);
  if (typeof approvalId !== 'string' || !APPROVAL_ID.test(approvalId)) {
    throw invalid(`${where} has no valid approval ID.`);
  }
  if (decision !== 'approve' && decision !== 'deny') {
    throw invalid(`${where} has no decision.`);
  }
  assertPrintable(summary, `${where}'s summary`);
  if (
    typeof requestExpiresAt !== 'number' ||
    !Number.isInteger(requestExpiresAt) ||
    requestExpiresAt < 0 ||
    requestExpiresAt > MAX_SAFE
  ) {
    throw invalid(`${where} has no valid expiry.`);
  }
  if (action === undefined) throw invalid(`${where} has no action.`);
  let actionDigest: string;
  try {
    actionDigest = encodeHex(sha256(canonicalizeToBytes(action)));
  } catch {
    throw invalid(`${where}'s action is not valid JSON.`);
  }
  if (storedDigest !== undefined && storedDigest !== actionDigest) {
    // 04 §2.5.2 step 2: a request whose stored digest does not match is a problem, never offered.
    throw invalid(`${where} doesn't match what was requested. It was not offered for approval.`);
  }
  if (!DIGEST.test(actionDigest)) throw invalid(`${where} has no valid digest.`);
  return { commitment, approvalId, actionDigest, decision, summary, requestExpiresAt };
}

/** "Approve 3 and deny 1" (11 §6, D-68). */
function totals(items: readonly Item[]): string {
  const approve = items.filter((i) => i.decision === 'approve').length;
  const deny = items.length - approve;
  if (deny === 0) return `Approve ${String(approve)}`;
  if (approve === 0) return `Deny ${String(deny)}`;
  return `Approve ${String(approve)} and deny ${String(deny)}`;
}

/**
 * Builds the one OwnerAction for `reviewed` (04 §2.5.1, §2.5.2) and the text shown before the prompt.
 * Pure apart from the clock and the nonce. Refuses (`owner_operation_invalid`) an empty list, more
 * than 20 items, a duplicate approvalId, a malformed item, a stored digest that does not match, and a
 * request that has already expired.
 */
export function buildApprovalOperation(
  context: ApprovalContext,
  reviewed: readonly ReviewedApproval[],
  internals: ApprovalInternals = {},
  secretName: OwnerSecretName = 'owner code',
): ApprovalOperation {
  assertAgentId(context.agent);
  const owner = ownerKeysCopy(context.owner);
  if (!Array.isArray(reviewed) || reviewed.length === 0) {
    throw invalid('Nothing was selected to approve or deny.');
  }
  if (reviewed.length > MAX_APPROVAL_BATCH_ITEMS) {
    throw invalid(
      `At most ${String(MAX_APPROVAL_BATCH_ITEMS)} approvals can be reviewed together. Review the rest next.`,
    );
  }
  const items = (reviewed as readonly unknown[]).map(item);
  if (items.length > 1 && items.some((i) => i.commitment)) {
    // IR-D-68-1: commitments are never batched in M1; each is approved on its own (D-31).
    throw invalid('Terms are approved one at a time. Review them on their own.');
  }
  // Canonical order: strictly ascending approvalId, byte order. IDs are ASCII, so UTF-16 code-unit
  // order is byte order. Equal neighbours are duplicates.
  const signedOrder = [...items].sort((a, b) =>
    a.approvalId < b.approvalId ? -1 : a.approvalId > b.approvalId ? 1 : 0,
  );
  for (let i = 1; i < signedOrder.length; i += 1) {
    if (signedOrder[i - 1]?.approvalId === signedOrder[i]?.approvalId) {
      throw invalid('The same approval is listed twice.');
    }
  }
  const issuedAt = Math.floor(internals.nowSeconds?.() ?? Date.now() / 1000);
  const earliest = Math.min(...items.map((i) => i.requestExpiresAt));
  const expiresAt = Math.min(issuedAt + LOCAL_APPROVAL_LIFETIME_S, earliest);
  if (expiresAt <= issuedAt) {
    throw invalid('A request in this list has expired. Review the list again.');
  }
  const nonceBytes = internals.nonce?.() ?? randomBytes(16);
  if (!(nonceBytes instanceof Uint8Array) || nonceBytes.length !== 16) {
    throw invalid('The nonce must be 16 bytes.');
  }
  const params = (i: Item): JsonObject => ({
    approvalId: i.approvalId,
    actionDigest: i.actionDigest,
    decision: i.decision,
  });
  const single = signedOrder.length === 1;
  const body: JsonObject = {
    v: 1,
    agent: context.agent,
    owner: encodeHex(owner.ownerNostr),
    op: single ? 'approval.decide' : 'approval.decideBatch',
    params: single ? params(signedOrder[0] as Item) : { items: signedOrder.map(params) },
    nonce: encodeBase64url(nonceBytes),
    issuedAt,
    expiresAt,
  };
  // Shown soonest to expire first (04 §2.5.2 step 2); ties keep the signed order.
  const shown = [...signedOrder].sort((a, b) => a.requestExpiresAt - b.requestExpiresAt);
  const n = items.length;
  const lines = [
    `Waiting for you: ${String(n)}`,
    ...shown.map(
      (i, k) =>
        `  ${String(k + 1)}. ${i.decision === 'approve' ? 'Approve' : 'Deny'}: ${i.summary}`,
    ),
    `${totals(items)}. Your ${secretName} covers exactly ${n === 1 ? 'this one' : `these ${String(n)}`}. Anything new waits for your next review.`,
  ];
  return Object.freeze({ body, lines: Object.freeze(lines), question: 'Continue? (y/N)' });
}

/**
 * One owner operation over the reviewed items: builds the object, shows it, asks "Continue?", reads
 * the owner code once, signs, closes the session and wipes the secret. Returns the SignedOwnerAction
 * for the core to verify and apply (M1-7e).
 */
export async function decideReviewedWith(
  store: PromptingOwnerKeyStore,
  terminal: OwnerTerminal,
  context: ApprovalContext,
  reviewed: readonly ReviewedApproval[],
  internals: ApprovalInternals = {},
): Promise<{ readonly body: JsonObject; readonly sig: string }> {
  const kind = await store.secretKind();
  const operation = buildApprovalOperation(
    context,
    reviewed,
    internals,
    kind === 1 ? 'owner code' : 'owner passphrase',
  );
  const signature = await runOwnerOperation(
    store,
    terminal,
    { lines: operation.lines, question: operation.question },
    { kind: 'owner-action', action: operation.body },
  );
  if (signature.kind !== 'owner-action') throw new Error('unreachable');
  return signature.signed;
}

/**
 * The package entry (index.ts) behind `agentlink approve` (M1-9b): the reviewed items, signed with the
 * owner code typed at this process's own terminal, against the OS keychain's `owner` item.
 */
export async function decideReviewedApprovals(
  context: ApprovalContext,
  reviewed: readonly ReviewedApproval[],
): Promise<{ readonly body: JsonObject; readonly sig: string }> {
  const terminal = ttyOwnerTerminal();
  const store = await KeychainOwnerKeyStore.open(osKeychain(), context.owner);
  try {
    return await decideReviewedWith(store, terminal, context, reviewed);
  } finally {
    await store.close();
  }
}
