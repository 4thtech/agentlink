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
//
// What the approval is for (M1-22): while it reads `pending` or `approved`, `action` names the tool
// and, for `agentlink_respond_to_terms` with `accept` or `reject`, the answered `envelopeId` and the
// `decision` (core `resumeOf`: structured, schema-checked values only, never terms, text, paths or
// links). An approved one adds a fixed `nextStep` that says how to finish, so a fresh session can
// complete it with only the `approvalId`. Every value is checked again here against its exact
// pattern or enum before it is used; anything else drops `action` (fail closed). It authorises
// nothing: the call that names the `approvalId` is checked against the owner-signed digest (I-4).
import type { ApprovalResume, ApprovalState as CoreApprovalState } from '@agentlink/core';
import { APPROVAL_TOOL_NAMES, approvalIdSchema, type ApprovalStatus } from '@agentlink/types';
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

/** An envelope ID (04 §2.4.1): 16 bytes, base64url without padding. */
const ENVELOPE_ID = /^[A-Za-z0-9_-]{22}$/;

type Action =
  | { tool: 'agentlink_respond_to_terms'; envelopeId: string; decision: 'accept' | 'reject' }
  | { tool: string };

/** The core's resume, re-checked: only known tool names, IDs and decisions pass. */
function actionOf(resume: ApprovalResume | undefined): Action | undefined {
  if (typeof resume !== 'object' || resume === null) return undefined;
  const { tool } = resume as { tool?: unknown };
  if (typeof tool !== 'string' || !(APPROVAL_TOOL_NAMES as readonly string[]).includes(tool)) {
    return undefined;
  }
  const { envelopeId, decision } = resume as { envelopeId?: unknown; decision?: unknown };
  if (envelopeId === undefined && decision === undefined) return { tool };
  if (
    tool === 'agentlink_respond_to_terms' &&
    typeof envelopeId === 'string' &&
    ENVELOPE_ID.test(envelopeId) &&
    (decision === 'accept' || decision === 'reject')
  ) {
    return { tool, envelopeId, decision };
  }
  return undefined;
}

const fill = (template: string, slots: Readonly<Record<string, string>>): string =>
  Object.entries(slots).reduce(
    (text, [key, value]) => text.split(`{${key}}`).join(value),
    template,
  );

/** The fixed "how to finish" step for an approved request (checked values only). */
function finishStep(action: Action, approvalId: string): string {
  return 'envelopeId' in action
    ? fill(TOOL_TEXT.approvalFinishTerms, {
        envelopeId: action.envelopeId,
        decision: action.decision,
        approvalId,
      })
    : fill(TOOL_TEXT.approvalFinishTool, { tool: action.tool, approvalId });
}

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
  const open = mapped.approval === 'pending' || mapped.approval === 'approved';
  let action: Action | undefined;
  if (open) {
    try {
      action = actionOf(await context.client.approvalResume?.(approvalId));
    } catch {
      // The state above still answers; the error text is never logged or returned (I-5).
      context.logger.info('approval action unavailable');
    }
  }
  return ok(summary, {
    approval: mapped.approval,
    ...(decidedAt === undefined ? {} : { decidedAt }),
    ...(mapped.used === true ? { used: true } : {}),
    ...(action === undefined ? {} : { action }),
    ...(action !== undefined && mapped.approval === 'approved'
      ? { nextStep: finishStep(action, approvalId) }
      : {}),
  });
}
