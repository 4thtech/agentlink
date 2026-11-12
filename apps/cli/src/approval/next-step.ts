// The M1a `nextStep` of a `pending_approval` result (06 §2.5 step 2, IR-M1-9j-1 F02; 11 §6.10).
//
// Fixed text with two inserted values, each checked against its exact pattern right before it is
// inserted: the core's `apr_` approval ID (04 §2.4.1) and the local agent name (06 §6). Both
// patterns admit only `[A-Za-z0-9_-]`, and an agent name cannot start with `-`, so no inserted value
// can carry a shell metacharacter, a space, a quote or a newline, or be read as an option.
//
// The M1-9g copy catalogue has no M1a entry for this text yet (its `pending_approval.nextStep` is the
// M1b link version), so the spec's fixed sentences live here. The tool handlers (packages/mcp-tools) may not
// import this module (06 §1); the runtime hands it to them through the handler context (M1-9c).
import { approvalIdSchema } from '@4thtech-io/types';
import { DEFAULT_AGENT_NAME, isAgentName } from '../runtime/agent-name.js';
import { cliPrefix } from '../runtime/cli-prefix.js';
import { RuntimeError } from '../runtime/errors.js';

/** `apr_` + 16 bytes as unpadded base64url: 22 characters of `[A-Za-z0-9_-]`. */
const APPROVAL_ID_CHARS = /^apr_[A-Za-z0-9_-]{22}$/;

// REL051-CF1 (carried C5): the app first (its Home lists the request), the terminal only as the
// fallback for an owner without the app open.
const LEAD = 'Tell the user: Approve on Home in the AgentLink app, or in your own terminal run ';
const TAIL = " Your AI can't approve this for you. Then call the same tool again with approvalId.";
const ADD_AGENT = " If you have more than one AgentLink ID, add --agent with this ID's name.";

/** True only for a canonical approval ID (both the schema and the character pattern). */
export function isApprovalId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    APPROVAL_ID_CHARS.test(value) &&
    approvalIdSchema.safeParse(value).success
  );
}

/**
 * The shell command the owner runs (06 §2.5 step 2). `agentName` is the agent this server serves;
 * for the default agent (or none) the command has no `--agent`. A name that fails the pattern is
 * never inserted: the command then has no `--agent` and `needsAgentHint` is true. `prefix` is the
 * command that works on this machine (`cliPrefix()`; M1-36a), never a bare name that may not be on PATH.
 */
export function approveCommand(
  approvalId: string,
  agentName?: string,
  prefix: string = cliPrefix(),
): { command: string; needsAgentHint: boolean } {
  if (!isApprovalId(approvalId)) throw new RuntimeError('approval_id_invalid');
  const base = `${prefix} approve ${approvalId}`;
  if (agentName === undefined || agentName === DEFAULT_AGENT_NAME) {
    return { command: base, needsAgentHint: false };
  }
  if (!isAgentName(agentName)) return { command: base, needsAgentHint: true };
  return { command: `${base} --agent ${agentName}`, needsAgentHint: false };
}

/** The whole `nextStep` text of a `pending_approval` result in M1a (06 §2.5 step 2). */
export function approvalNextStep(approvalId: string, agentName?: string, prefix?: string): string {
  const { command, needsAgentHint } = approveCommand(approvalId, agentName, prefix);
  return `${LEAD}\`${command}\`.${needsAgentHint ? ADD_AGENT : ''}${TAIL}`;
}
