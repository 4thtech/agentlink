// M1-36j (D4, Tali 2026-10-22): when the owner's approval page is open, the tool call waits briefly
// for the owner's decision, so the user does not have to come back and tell the agent "done".
//
// - Only a `pending_approval` result that carries the local approval page `url` (the page was
//   opened for the owner, M1-11a-b) waits, and only when the MCP layer gives a budget for the
//   calling harness (mcp/approval-wait.ts). Anything else is returned as it is, with no read.
// - The wait reads the approval through the core's read-only `approvalState` (`ApprovalService.read`:
//   it never applies, claims or changes a row) at most once per interval. No lock or transaction is
//   held between reads; each read is the core's own short store transaction.
// - It stops at once on the client's cancel (the request's AbortSignal) and at the budget.
// - Approval semantics do not change (06 §2.5, I-4): the decision still needs owner presence on the
//   page or in the CLI, and nothing here runs the action. An approval decided during the wait gives a
//   `pending_approval` with a fixed nextStep that tells the agent to call the same tool again now
//   with the `approvalId` (06 §2.5 step 4, unchanged); a denial gives `rejected` with
//   `APPROVAL_DENIED`. A timeout, a cancel, a read error or any other state returns the original
//   result unchanged (fail closed: the next call or `agentlink_get_approval` sorts it out).
// - Every text is fixed; the only inserted value is the `approvalId`, checked against its exact
//   pattern (I-5). A read error is never logged or returned (I-7).
import { approvalIdSchema } from '@4thtech-io/types';
import type { ToolContext } from './context.js';
import { fail, type HandlerOutput } from './result.js';
import { TOOL_TEXT } from './text.js';

/** The calm read interval: one approval read per interval at most. */
export const APPROVAL_WAIT_INTERVAL_MS = 1_500;

const APPROVAL_ID = /^apr_[A-Za-z0-9_-]{22}$/;

export interface ApprovalWaitOptions {
  /** The budget for this call, in ms; 0 or less: no wait. */
  readonly waitMs: number;
  /** The client's cancel for this request. */
  readonly signal?: AbortSignal;
  /** Read interval in ms (tests); default APPROVAL_WAIT_INTERVAL_MS. */
  readonly intervalMs?: number;
}

/**
 * M1-36i-e: one time budget per tool call. The approval wait is what is left of the harness's
 * budget after the time the call has already spent (a free test credits wait, M1-36i-c, can take
 * about 20 s): never more than `waitMs`, never less than 0. At 0 the linked pending_approval comes
 * back at once, so the call stays under the harness's tool-call timeout. A clock that went
 * backwards or a value that is not a number counts as nothing spent (never a longer wait).
 */
export function approvalWaitLeft(waitMs: number, spentMs: number): number {
  if (!(waitMs > 0) || !Number.isFinite(waitMs)) return 0;
  const spent = Number.isFinite(spentMs) && spentMs > 0 ? spentMs : 0;
  return Math.max(0, waitMs - spent);
}

type Decision = 'approved' | 'denied' | undefined;

/** Resolves after `ms`, or at once when `signal` aborts. Never rejects. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener('abort', done, { once: true });
  });
}

async function readDecision(context: ToolContext, approvalId: string): Promise<Decision | 'other'> {
  let status: string;
  try {
    status = (await context.client.approvalState(approvalId)).status;
  } catch {
    // The error could carry a value (I-7): never logged or returned.
    return 'other';
  }
  // The core's read (06 §2.5 mapping): only these are acted on. `expired`, `used`, `void` and
  // `unknown` (not found, or a stored object that does not verify) leave the result unchanged.
  switch (status) {
    case 'pending':
      return undefined;
    case 'approved':
      return 'approved';
    case 'denied':
    case 'cancelled':
      return 'denied';
    default:
      return 'other';
  }
}

/**
 * Waits up to `options.waitMs` for the owner's decision on a linked `pending_approval` result and
 * returns the decision result, or `output` itself (the same object) when there is nothing to wait
 * for, the budget runs out, the client cancels, or the state is anything but approved or denied.
 */
export async function waitForApprovalDecision(
  output: HandlerOutput,
  context: ToolContext,
  options: ApprovalWaitOptions,
): Promise<HandlerOutput> {
  const { result } = output;
  const { signal } = options;
  const approvalId = result.approvalId;
  if (
    !(options.waitMs > 0) ||
    !Number.isFinite(options.waitMs) ||
    signal?.aborted === true ||
    result.status !== 'pending_approval' ||
    typeof result.url !== 'string' ||
    output.text !== undefined ||
    typeof approvalId !== 'string' ||
    !APPROVAL_ID.test(approvalId) ||
    !approvalIdSchema.safeParse(approvalId).success
  ) {
    return output;
  }
  const interval = Math.max(1, options.intervalMs ?? APPROVAL_WAIT_INTERVAL_MS);
  const deadline = Date.now() + options.waitMs;
  // A function, so each check reads the signal now (it can abort during any await).
  const cancelled = (): boolean => signal?.aborted === true;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return output;
    await pause(Math.min(interval, left), signal);
    if (cancelled() || Date.now() > deadline) return output;
    const decision = await readDecision(context, approvalId);
    if (cancelled()) return output;
    if (decision === 'other') return output;
    if (decision === 'approved') return approvedOutput(output, approvalId);
    if (decision === 'denied') {
      return fail(
        'rejected',
        TOOL_TEXT.approvalDenied,
        TOOL_TEXT.approvalWaitDeniedNextStep,
        'APPROVAL_DENIED',
      );
    }
  }
}

/** The approved result: still `pending_approval` (the action has not run), no url, fixed text. */
function approvedOutput(output: HandlerOutput, approvalId: string): HandlerOutput {
  const rest: Record<string, unknown> = { ...output.result };
  delete rest['url'];
  return {
    result: {
      ...rest,
      status: 'pending_approval',
      approvalId,
      summary: TOOL_TEXT.approvalWaitApproved,
      nextStep: TOOL_TEXT.approvalWaitApprovedNextStep.split('{approvalId}').join(approvalId),
    },
  };
}
