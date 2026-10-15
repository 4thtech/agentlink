// Reading the pending approval requests for the owner commands (M1-9b; 04 §2.5.2 step 2, 06 §2.5
// step 3, 07 §3 `approvals`).
//
// For each row the CLI opens the sealed stored action itself, parses it under the strict
// `approval-request.action` schema and recomputes `actionDigest = sha256(JCS(action))` from the
// parsed action. The row's stored action text is the core's JCS text (M1-7e), so its own hash is the
// stored digest. A row whose action does not open, does not parse, or whose stored digest differs
// from the recomputed one is a problem: it is shown as such and never offered (IR-M1-8c-1 F-3).
//
// What the owner sees (render.ts) and what is signed (the `action` handed to @agentlink/node, which
// recomputes the digest once more) are the same parsed object (IR-M1-9j-1 F06). The row's stored
// `summary` is never shown: the review lines are derived from the action, not from text the agent
// or the core passed in (IR-M1-8c-1 F-4).
import { computeActionDigest, rowKeyOf, type Row, type Sealed } from '@agentlink/core';
import {
  encodeHex,
  encodeUtf8,
  parseJson,
  sha256,
  type JsonObject,
  type JsonValue,
} from '@agentlink/crypto';
import { approvalActionSchema, approvalIdSchema } from '@agentlink/types';
import type { OwnerAgent } from './deps.js';

/** A pending request whose stored action parsed and whose digest matched. */
export interface PendingRequest {
  readonly kind: 'ok';
  readonly approvalId: string;
  /** The parsed stored action: rendered for the owner, and the object whose digest is signed. */
  readonly action: JsonObject;
  /** sha256 of the stored action text (equal to `actionDigest` for an intact row). */
  readonly storedDigest: string;
  /** sha256(JCS(action)), recomputed here from `action`. */
  readonly actionDigest: string;
  /** A commitment (D-31): never batched (04 §2.5.2). */
  readonly commitment: boolean;
  /** Unix seconds. */
  readonly expiresAt: number;
  /** The sealed stored value, to check right before the prompt that the row did not change. */
  readonly sealedAction: Sealed;
}

/** A pending request that cannot be offered: shown as a problem (04 §2.5.2 step 2). */
export interface ProblemRequest {
  readonly kind: 'problem';
  readonly approvalId: string;
  readonly expiresAt: number;
}

export type PendingEntry = PendingRequest | ProblemRequest;

type ApprovalRow = Row<'approvals'>;

/** Pending and undecided and not expired: the only rows the owner may decide (04 §2.5.1). */
export function isLivePending(row: ApprovalRow, now: number): boolean {
  return (
    row.status === 'pending' &&
    row.signed_decision === null &&
    row.signed_cancel === null &&
    row.expires_at > now
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/** Opens and checks one row's stored action. */
export async function readEntry(agent: OwnerAgent, row: ApprovalRow): Promise<PendingEntry> {
  const problem: ProblemRequest = {
    kind: 'problem',
    approvalId: row.approval_id,
    expiresAt: row.expires_at,
  };
  let text: string;
  try {
    text = await agent.cipher.open(
      { table: 'approvals', column: 'action_json', rowKey: rowKeyOf([row.approval_id]) },
      row.action_json,
    );
  } catch {
    return problem;
  }
  let parsed: JsonValue;
  try {
    parsed = parseJson(text);
  } catch {
    return problem;
  }
  if (!approvalActionSchema.safeParse(parsed).success) return problem;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return problem;
  const action = deepFreeze(parsed as JsonObject);
  let actionDigest: string;
  try {
    actionDigest = computeActionDigest(action);
  } catch {
    return problem;
  }
  const storedDigest = encodeHex(sha256(encodeUtf8(text)));
  if (storedDigest !== actionDigest) return problem;
  const context = action['context'];
  const scoped =
    typeof context === 'object' &&
    context !== null &&
    !Array.isArray(context) &&
    (context as JsonObject)['scope'] !== undefined;
  return Object.freeze({
    kind: 'ok',
    approvalId: row.approval_id,
    action,
    storedDigest,
    actionDigest,
    commitment: row.scope_json !== null || scoped,
    expiresAt: row.expires_at,
    sealedAction: row.action_json,
  });
}

/** Soonest to expire first; ties by approvalId (04 §2.5.2 step 2). */
export function byExpiry(a: PendingEntry, b: PendingEntry): number {
  if (a.expiresAt !== b.expiresAt) return a.expiresAt - b.expiresAt;
  return a.approvalId < b.approvalId ? -1 : a.approvalId > b.approvalId ? 1 : 0;
}

/** Every live pending request of the agent, soonest to expire first. */
export async function loadPending(agent: OwnerAgent, now: number): Promise<PendingEntry[]> {
  const rows = await agent.store.transaction((tx) =>
    tx.select('approvals', { status: 'pending' }, { orderBy: [['expires_at', 'asc']] }),
  );
  const out: PendingEntry[] = [];
  for (const row of rows) {
    if (!isLivePending(row, now)) continue;
    out.push(await readEntry(agent, row));
  }
  return out.sort(byExpiry);
}

/** One approval row by ID, or undefined. */
export async function readRow(
  agent: OwnerAgent,
  approvalId: string,
): Promise<ApprovalRow | undefined> {
  if (!approvalIdSchema.safeParse(approvalId).success) return undefined;
  return agent.store.transaction((tx) => tx.get('approvals', { approval_id: approvalId }));
}

/**
 * Right before the owner code prompt (04 §2.5.2 step 4): the requests that are still live and
 * unchanged since they were shown. Everything else is dropped, and the caller tells the owner.
 */
export async function stillPending(
  agent: OwnerAgent,
  requests: readonly PendingRequest[],
  now: number,
): Promise<{ kept: PendingRequest[]; dropped: PendingRequest[] }> {
  const rows = await agent.store.transaction((tx) =>
    requests.map((r) => tx.get('approvals', { approval_id: r.approvalId })),
  );
  const kept: PendingRequest[] = [];
  const dropped: PendingRequest[] = [];
  requests.forEach((request, i) => {
    const row = rows[i];
    const ok =
      row !== undefined &&
      isLivePending(row, now) &&
      row.action_json === request.sealedAction &&
      row.expires_at === request.expiresAt;
    (ok ? kept : dropped).push(request);
  });
  return { kept, dropped };
}
