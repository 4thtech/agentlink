// Tool results (06 §1 rules 2 and 3, §2.5; M1-9c). Every tool returns a `status`, a one-sentence
// `summary` and, when the status is not `ok`, a `nextStep`; `pending_approval` adds the
// `approvalId`. The handlers build results only through these helpers, and `finalizeResult` checks
// each one before it leaves the server:
//
// - `summary` and `nextStep` are our text: I-JSON, 1 to 500 code points, no control or format
//   character (`toolTextSchema`, @agentlink/types). Inbound content never reaches them (I-5).
// - A `url` must start with one of the context's allowed origins (the local UI or the console;
//   IR-M1-2b-1 F-5). M1a has none (D-73 (3)), so any `url` is refused.
// - A result that breaks a rule is replaced by a fixed internal error: the server never echoes the
//   offending text.
import { toolResultCommonSchema, type McpStatus } from '@agentlink/types';
import type { ToolContext } from './context.js';

/** A tool result: the common fields plus the tool's own `structuredContent` fields. */
export type ToolResult = {
  readonly status: McpStatus;
  readonly summary: string;
  readonly nextStep?: string;
  readonly url?: string;
  readonly approvalId?: string;
  readonly code?: string;
} & Readonly<Record<string, unknown>>;

/** A result ready for the MCP layer: the structured content and the text block. */
export interface FinishedResult {
  readonly structured: ToolResult;
  /** The text content: the summary (and `nextStep`), or the untrusted blocks a handler built. */
  readonly text: string;
}

/** What a handler returns: the result and, for wrapped content, its own text (06 §4). */
export interface HandlerOutput {
  readonly result: ToolResult;
  readonly text?: string;
}

/** Fixed text (I-5: never built from a value). */
export const RESULT_TEXT = Object.freeze({
  internalSummary: 'Something went wrong in AgentLink, so nothing was done.',
  internalNextStep:
    'Tell the user AgentLink hit a problem. They can run `agentlink doctor` in their own terminal to see why.',
  invalidSummary: "That request isn't valid for this tool, so nothing was done.",
  invalidNextStep: "Check the tool's input fields and call it again.",
  notAvailableSummary:
    "This AgentLink tool isn't available in this version yet, so nothing was done.",
  notAvailableNextStep:
    'Tell the user this AgentLink feature is coming in a later version. Nothing else is needed now.',
});

export const ok = (
  summary: string,
  fields: Readonly<Record<string, unknown>> = {},
): HandlerOutput => ({
  result: { ...fields, status: 'ok', summary },
});

/** A non-`ok`, non-approval result. `code` is an UPPER_SNAKE_CASE constant, never a value. */
export function fail(
  status: Exclude<McpStatus, 'ok' | 'pending_approval'>,
  summary: string,
  nextStep: string,
  code?: string,
  fields: Readonly<Record<string, unknown>> = {},
): HandlerOutput {
  return {
    result: {
      ...fields,
      status,
      summary,
      nextStep,
      ...(code === undefined ? {} : { code }),
    },
  };
}

/** A `pending_approval` result (06 §2.5 step 2): no `url` in M1a; `nextStep` from M1-9k. */
export function pendingApproval(
  context: ToolContext,
  approvalId: string,
  summary: string,
  fields: Readonly<Record<string, unknown>> = {},
): HandlerOutput {
  return {
    result: {
      ...fields,
      status: 'pending_approval',
      summary,
      approvalId,
      nextStep: context.approvalNextStep(approvalId),
    },
  };
}

export const invalidArgument = (): HandlerOutput =>
  fail('error', RESULT_TEXT.invalidSummary, RESULT_TEXT.invalidNextStep, 'INVALID_ARGUMENT');

export const notAvailable = (): HandlerOutput =>
  fail('error', RESULT_TEXT.notAvailableSummary, RESULT_TEXT.notAvailableNextStep, 'NOT_AVAILABLE');

export const internalError = (): HandlerOutput =>
  fail('error', RESULT_TEXT.internalSummary, RESULT_TEXT.internalNextStep, 'INTERNAL');

/** True when the url starts with one of the allowed origins followed by `/`, `?`, `#` or nothing. */
function urlAllowed(url: unknown, origins: readonly string[]): boolean {
  if (typeof url !== 'string') return false;
  return origins.some(
    (origin) => url === origin || ['/', '?', '#'].some((sep) => url.startsWith(origin + sep)),
  );
}

/**
 * The rule check of 06 §1 rule 3 and §2.5; returns false on any break. The field rules (text, `code`,
 * `nextStep` on every non-ok result, `approvalId` only on `pending_approval`, a well-formed `url`)
 * are the ones in @agentlink/types; only the origin pin of `url` is ours (IR-M1-9c-1 F06).
 */
export function resultIsValid(result: ToolResult, urlOrigins: readonly string[]): boolean {
  if (!toolResultCommonSchema.safeParse(result).success) return false;
  return result.url === undefined || urlAllowed(result.url, urlOrigins);
}

/** The default text block: the summary, then the `nextStep` on its own line. */
export function resultText(result: ToolResult): string {
  return result.nextStep === undefined ? result.summary : `${result.summary}\n${result.nextStep}`;
}

/** Checks a handler's output and gives the MCP layer its structured content and text. */
export function finalizeResult(
  output: HandlerOutput,
  urlOrigins: readonly string[],
): FinishedResult {
  const checked = resultIsValid(output.result, urlOrigins) ? output : internalError();
  return { structured: checked.result, text: checked.text ?? resultText(checked.result) };
}
