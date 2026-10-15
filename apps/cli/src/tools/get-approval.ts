// `agentlink_get_approval` (06 §2.5; M1-9c, M1-9c-b). Read-only: it never applies, claims or changes
// an approval row. It reports what the core's approval read gives for the row's own stored action
// (M1-7e-3 `ApprovalService.read`: the stored signed objects are re-verified before the row's
// `status` cache is read, and the cache only takes authority away):
//
//   pending → pending; approved → approved; denied, cancelled → denied; expired → expired;
//   used (a void row whose approve decision verifies) → expired with `used: true`; void (withdrawn
//   or superseded before any use) → expired without `used`; unknown/invalid (the stored action does
//   not open, or a stored decision or cancel does not verify) → denied; unknown/not_found →
//   `not_found`. It fails closed and never reports `signed`. `decidedAt` is the row's `decided_at`,
//   once decided.
import type { ApprovalState as CoreApprovalState } from '@agentlink/core';
import { approvalIdSchema, type ApprovalStatus } from '@agentlink/types';
import { copy } from './strings/index.js';
import type { ToolContext } from './context.js';
import { fail, invalidArgument, ok, type HandlerOutput } from './result.js';
import { TOOL_TEXT } from './text.js';

const APPROVAL_ID = /^apr_[A-Za-z0-9_-]{22}$/;

/** The 06 §2.5 state for a core approval read, or `not_found` for an unknown ID. */
export function approvalStateOf(
  state: CoreApprovalState,
): { approval: ApprovalStatus; used?: true } | 'not_found' {
  switch (state.status) {
    case 'pending':
    case 'approved':
    case 'expired':
      return { approval: state.status };
    case 'denied':
    case 'cancelled':
      return { approval: 'denied' };
    case 'used':
      return { approval: 'expired', used: true };
    case 'void':
      return { approval: 'expired' };
    case 'unknown':
      return state.reason === 'not_found' ? 'not_found' : { approval: 'denied' };
    default:
      // Anything the core adds later is not an approval: fail closed.
      return { approval: 'denied' };
  }
}

const SUMMARY: Readonly<Record<ApprovalStatus, string>> = {
  pending: TOOL_TEXT.approvalPending,
  approved: TOOL_TEXT.approvalApproved,
  denied: TOOL_TEXT.approvalDenied,
  expired: TOOL_TEXT.approvalExpired,
};

const rfc3339 = (unixSeconds: number): string =>
  new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

function readApprovalId(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== 'approvalId') return undefined;
  const value = (input as { approvalId?: unknown }).approvalId;
  return typeof value === 'string' &&
    APPROVAL_ID.test(value) &&
    approvalIdSchema.safeParse(value).success
    ? value
    : undefined;
}

export async function getApprovalHandler(
  input: unknown,
  context: ToolContext,
): Promise<HandlerOutput> {
  const approvalId = readApprovalId(input);
  if (approvalId === undefined) return invalidArgument();
  const state = await context.client.approvalState(approvalId);
  const mapped = approvalStateOf(state);
  if (mapped === 'not_found') {
    return fail('not_found', TOOL_TEXT.approvalNotFound, TOOL_TEXT.approvalNotFoundNextStep);
  }
  const decidedAt =
    state.status !== 'unknown' && mapped.approval !== 'pending' && state.decidedAt !== undefined
      ? rfc3339(state.decidedAt)
      : undefined;
  const summary = mapped.used === true ? copy('chat.commitment.used') : SUMMARY[mapped.approval];
  return ok(summary, {
    approval: mapped.approval,
    ...(decidedAt === undefined ? {} : { decidedAt }),
    ...(mapped.used === true ? { used: true } : {}),
  });
}
