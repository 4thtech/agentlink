// The common tool-result shape (06 §1 rule 3, §2.5): `{status, summary, nextStep?, url?,
// approvalId?}`, plus each tool's own fields (`toolResult(shape)`).
//
// - Every non-`ok` result has `nextStep`; `pending_approval` has the `approvalId`, and no other
//   status carries an `approvalId`. Its `url` is optional: in M1a the owner approves in the CLI and
//   there is no link (06 §2.5, D-73 (3)); the local UI or console link arrives in M1b.
// - `summary` and `nextStep` are our template text (I-5): inbound content never appears there, and
//   they hold no control, format or separator character, so they cannot fake structure.
// - `code` (PROPOSED: the spec uses it, e.g. `AMBIGUOUS_CONTACT`, `USE_TERMS_TOOLS`) names a
//   refusal or error; never on `ok`.
// - I-4: results are strict, so a result can never carry a decision, a signature or a policy.
import { z } from 'zod';
import { APPROVAL_STATUSES, MAX_URL_LENGTH, MCP_STATUSES } from './constants.js';
import { approvalIdSchema, hasControlOrFormat, ijsonString } from './encoding.js';
import { checkProofStatus, proofStatusShape, utcTimestampSchema } from './proof.js';

/** Upper bound on `summary` and `nextStep` in code points (one sentence each, 06 §1 rule 2). */
export const MAX_TOOL_TEXT_CHARS = 500;

/** Our own one-line text: I-JSON, 1–500 code points, no control or format character. */
export const toolTextSchema = ijsonString({ min: 1, max: MAX_TOOL_TEXT_CHARS }).refine(
  (s) => !hasControlOrFormat(s),
  'must not contain control or format characters',
);

/**
 * A link in a result: the local UI (`http` on a loopback host with a port) or the console
 * (`https`). No user info, no whitespace.
 */
export const resultUrlSchema = z
  .string()
  .max(MAX_URL_LENGTH)
  .regex(
    /^(?:https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?|http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5})(?:[/?#][\x21-\x7e]*)?$/,
    { message: 'must be an https URL or an http URL on 127.0.0.1, localhost or [::1] with a port' },
  );

/** An error or refusal code: upper snake case. */
export const toolErrorCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'must be an UPPER_SNAKE_CASE code');

/** The fields every tool result has (06 §1 rule 3). */
export const toolResultShape = {
  status: z.enum(MCP_STATUSES),
  summary: toolTextSchema,
  nextStep: toolTextSchema.exactOptional(),
  url: resultUrlSchema.exactOptional(),
  approvalId: approvalIdSchema.exactOptional(),
  code: toolErrorCodeSchema.exactOptional(),
};

type CommonFields = {
  status?: unknown;
  nextStep?: unknown;
  url?: unknown;
  approvalId?: unknown;
  code?: unknown;
};

/** The rules between the common fields. */
export function checkToolResult(r: CommonFields, ctx: z.core.$RefinementCtx): void {
  const issue = (message: string, path: string[]) =>
    ctx.addIssue({ code: 'custom', message, path });
  const pending = r.status === 'pending_approval';
  if (r.status !== 'ok' && r.nextStep === undefined) {
    issue('every result that is not ok has nextStep', ['nextStep']);
  }
  if (pending && r.approvalId === undefined)
    issue('pending_approval has the approvalId', ['approvalId']);
  if (!pending && r.approvalId !== undefined) {
    issue('only pending_approval carries an approvalId', ['approvalId']);
  }
  if (r.status === 'ok' && r.code !== undefined) issue('an ok result has no error code', ['code']);
}

/**
 * A strict tool-result schema: the common fields, the tool's own `shape` (which may narrow
 * `status`, as ProofStatus does) and an optional extra check for the tool's own rules.
 */
export function toolResult<S extends z.core.$ZodShape>(
  shape: S,
  check?: (value: Record<string, unknown>, ctx: z.core.$RefinementCtx) => void,
) {
  return z.strictObject({ ...toolResultShape, ...shape }).superRefine((value, ctx) => {
    checkToolResult(value as CommonFields, ctx);
    check?.(value as Record<string, unknown>, ctx);
  });
}

/** The common shape alone. */
export const toolResultSchema = toolResult({});

/** `agentlink_notarize` and `agentlink_get_proof` return a ProofStatus (06 §2.4) as their result. */
export const proofStatusResultSchema = toolResult(proofStatusShape, checkProofStatus);

/**
 * `agentlink_get_approval` (06 §2.5). The approval's state is `approval`, not `status`, so it never
 * collides with the common tool `status` (06 §2.5: `{status: "ok", approval, decidedAt?, used?}`).
 * An `ok` result has `approval`; `decidedAt` (UTC) only once the owner decided, so never while
 * pending; `used: true` only on `expired`, for an approval already used once (06 §2.5 M1a mapping).
 */
export const getApprovalResultSchema = toolResult(
  {
    approval: z.enum(APPROVAL_STATUSES).exactOptional(),
    decidedAt: utcTimestampSchema.exactOptional(),
    used: z.literal(true).exactOptional(),
  },
  (r, ctx) => {
    if ((r.status === 'ok') !== (r.approval !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'an ok result has the approval state, and only an ok result',
        path: ['approval'],
      });
    }
    if (r.decidedAt !== undefined && (r.approval === undefined || r.approval === 'pending')) {
      ctx.addIssue({
        code: 'custom',
        message: 'decidedAt only once the owner decided',
        path: ['decidedAt'],
      });
    }
    if (r.used !== undefined && r.approval !== 'expired') {
      ctx.addIssue({
        code: 'custom',
        message: 'used only on an expired approval (already used once)',
        path: ['used'],
      });
    }
  },
);

export type ToolResult = z.infer<typeof toolResultSchema>;
export type GetApprovalResult = z.infer<typeof getApprovalResultSchema>;
export type ProofStatusResult = z.infer<typeof proofStatusResultSchema>;
