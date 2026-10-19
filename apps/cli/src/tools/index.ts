// The runtime-agnostic tool module (06 §1, D-73 (1); M1-9c): the registry, the handlers, the result
// helpers and the untrusted-content wrapper. `callTool` is the one entry the MCP binding
// (src/mcp/) and the mirroring CLI commands use, so a command and its tool cannot drift.
//
// Every M1a tool has its handler: invites (M1-9o), send and inbox (M1-9p), terms (M1-9q); the file
// tools of M1b (M1-9d-1): `path` on send and agentlink_fetch_file; the proof tools (M1-9d-2):
// `notarize` on send and the terms tools, agentlink_notarize, agentlink_acknowledge,
// agentlink_get_proof, agentlink_export_proof_pack, agentlink_verify_proof_pack. A tool
// whose card has not landed would answer the fixed "not available yet" error (06 §1 rule 3).
import type { McpToolName } from '@4thtech-io/types';
import { acceptInviteHandler } from './accept-invite.js';
import { acknowledgeHandler } from './acknowledge.js';
import type { HandlerEnvironment, ToolContext } from './context.js';
import { createInviteHandler } from './create-invite.js';
import { exportProofPackHandler } from './export-proof-pack.js';
import { fetchFileHandler } from './fetch-file.js';
import { getApprovalHandler } from './get-approval.js';
import { getProofHandler } from './get-proof.js';
import { inboxHandler } from './inbox.js';
import { matchesSchema } from './input.js';
import { notarizeHandler } from './notarize.js';
import { proposeTermsHandler } from './propose-terms.js';
import { respondToTermsHandler } from './respond-to-terms.js';
import { listContactsHandler } from './list-contacts.js';
import { findTool } from './registry.js';
import {
  fail,
  finalizeResult,
  internalError,
  invalidArgument,
  notAvailable,
  withApprovalLink,
  type FinishedResult,
  type HandlerOutput,
} from './result.js';
import { sendHandler } from './send.js';
import { statusHandler } from './status.js';
import { TOOL_TEXT } from './text.js';
import { verifyProofPackHandler } from './verify-proof-pack.js';

export type ToolHandler = (input: unknown, context: ToolContext) => Promise<HandlerOutput>;

const stub: ToolHandler = () => Promise.resolve(notAvailable());

/** Every registered tool's handler. Tools whose card has not landed answer "not available yet". */
export const HANDLERS: Readonly<Partial<Record<McpToolName, ToolHandler>>> = Object.freeze({
  agentlink_status: statusHandler,
  agentlink_create_invite: createInviteHandler,
  agentlink_accept_invite: acceptInviteHandler,
  agentlink_list_contacts: listContactsHandler,
  agentlink_send: sendHandler,
  agentlink_propose_terms: proposeTermsHandler,
  agentlink_respond_to_terms: respondToTermsHandler,
  agentlink_inbox: inboxHandler,
  agentlink_fetch_file: fetchFileHandler,
  agentlink_get_approval: getApprovalHandler,
  agentlink_notarize: notarizeHandler,
  agentlink_acknowledge: acknowledgeHandler,
  agentlink_get_proof: getProofHandler,
  agentlink_export_proof_pack: exportProofPackHandler,
  agentlink_verify_proof_pack: verifyProofPackHandler,
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
  if (!isPlainObject(args) || !matchesSchema(tool.inputSchema, args)) {
    return finalizeResult(invalidArgument(), origins);
  }
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
  // M1-11a-b: under `agentlink mcp`, a pending_approval gets the local approval UI link.
  const linked = await withApprovalLink(output, env);
  return finalizeResult(linked.output, linked.origins);
}

export { TOOLS, PENDING_M1A_TOOLS, findTool, type ToolDefinition } from './registry.js';
export {
  coreToolClient,
  type ApprovalLink,
  type AttachedFile,
  type AttachOutcome,
  type AttachRefusal,
  type CoreToolClientOptions,
  type FileOpener,
  type FileTools,
  type HandlerEnvironment,
  type InboxPage,
  type InboxPageQuery,
  type InboundPageItem,
  type NeedsSetupContext,
  type AccountView,
  type PackCheck,
  type PackFolders,
  type PackReadOutcome,
  type PackSaveOutcome,
  type ProofPlatformTools,
  type ProofTools,
  type OutboundPageItem,
  type PageFile,
  type PageItem,
  type ToolClient,
  type ToolContext,
} from './context.js';
export type { FinishedResult, ToolResult } from './result.js';
