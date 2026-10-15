// The runtime-agnostic tool module (06 §1, D-73 (1); M1-9c): the registry, the handlers, the result
// helpers and the untrusted-content wrapper. `callTool` is the one entry the MCP binding
// (src/mcp/) and the mirroring CLI commands use, so a command and its tool cannot drift.
//
// Handlers for send, inbox, invites and terms land with M1-9p, M1-9o and M1-9q; until then their
// tools are registered and answer with the fixed "not available yet" error (06 §1 rule 3).
import type { McpToolName } from '@agentlink/types';
import type { HandlerEnvironment, ToolContext } from './context.js';
import { getApprovalHandler } from './get-approval.js';
import { listContactsHandler } from './list-contacts.js';
import { findTool } from './registry.js';
import {
  fail,
  finalizeResult,
  internalError,
  invalidArgument,
  notAvailable,
  type FinishedResult,
  type HandlerOutput,
} from './result.js';
import { statusHandler } from './status.js';
import { TOOL_TEXT } from './text.js';

export type ToolHandler = (input: unknown, context: ToolContext) => Promise<HandlerOutput>;

const stub: ToolHandler = () => Promise.resolve(notAvailable());

/** Every registered tool's handler. Tools whose card has not landed answer "not available yet". */
export const HANDLERS: Readonly<Partial<Record<McpToolName, ToolHandler>>> = Object.freeze({
  agentlink_status: statusHandler,
  agentlink_create_invite: stub, // M1-9o
  agentlink_accept_invite: stub, // M1-9o
  agentlink_list_contacts: listContactsHandler,
  agentlink_send: stub, // M1-9p
  agentlink_inbox: stub, // M1-9p
  agentlink_get_approval: getApprovalHandler,
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Runs one tool call and returns its checked result. Never throws and never echoes a value: an
 * unknown tool, a bad input or a handler failure becomes fixed text (I-5).
 */
export async function callTool(
  name: string,
  input: unknown,
  env: HandlerEnvironment,
): Promise<FinishedResult> {
  const origins = 'needsSetup' in env ? [] : env.urlOrigins;
  const tool = findTool(name);
  const handler = tool === undefined ? undefined : HANDLERS[tool.name];
  if (tool === undefined || handler === undefined)
    return finalizeResult(invalidArgument(), origins);
  const args = input ?? {};
  if (!isPlainObject(args)) return finalizeResult(invalidArgument(), origins);
  if ('needsSetup' in env) {
    const output =
      handler === stub
        ? notAvailable()
        : fail('needs_setup', env.needsSetup.message, TOOL_TEXT.setupFollowNextStep);
    return finalizeResult(output, origins);
  }
  let output: HandlerOutput;
  try {
    output = await handler(args, env);
  } catch {
    // The error's message could carry a value (I-5, I-7): never logged or returned.
    env.logger.warn('tool handler failed', { tool: tool.name });
    output = internalError();
  }
  return finalizeResult(output, origins);
}

export { TOOLS, PENDING_M1A_TOOLS, findTool, type ToolDefinition } from './registry.js';
export {
  coreToolClient,
  type HandlerEnvironment,
  type NeedsSetupContext,
  type ToolClient,
  type ToolContext,
} from './context.js';
export type { FinishedResult, ToolResult } from './result.js';
