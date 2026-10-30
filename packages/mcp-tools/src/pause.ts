// W4-PAUSE (S2; D-143 (5); 06 §6 "Paused agents"; Q-143-2, decided by Tali in chat, 2026-10-30,
// Decision 50: refused, not queued; I-4, I-5).
//
// While the owner has paused the agent in the AgentLink app, every tool that sends or fetches is
// refused before any effect with `status: "rejected"`, `code: "AGENT_PAUSED"` and the fixed nextStep.
// The handler never runs, so nothing is resolved, sent, fetched or kept under `clientRequestId`
// (07 §3.3) and the same call works after resume. The read tools still answer from the store, with
// no relay fetch (status.ts, inbox.ts). Fail closed: a pause state that cannot be read counts as
// paused. No tool, argument, result field or annotation is added (06 §2.0): `rejected` and `code`
// already exist (06 §1 rule 3). No tool pauses or resumes (I-4).
import type { McpToolName } from '@4thtech-io/types';
import type { ToolClient } from './context.js';
import { fail, type HandlerOutput } from './result.js';
import { TOOL_TEXT } from './text.js';

/** The tools that send or fetch (06 §6 "Paused agents", in its order). */
export const PAUSE_REFUSED_TOOLS: ReadonlySet<McpToolName> = new Set<McpToolName>([
  'agentlink_send',
  'agentlink_acknowledge',
  'agentlink_propose_terms',
  'agentlink_respond_to_terms',
  'agentlink_notarize',
  'agentlink_create_invite',
  'agentlink_accept_invite',
  'agentlink_fetch_file',
]);

/** True while paused, and when the pause state cannot be read (fail closed). */
export async function agentPaused(client: ToolClient): Promise<boolean> {
  if (client.paused === undefined) return false;
  try {
    return await client.paused();
  } catch {
    // The error could carry a path or a store message (I-7): never logged or returned.
    return true;
  }
}

/** The fixed refusal (I-5: no slot takes any value). */
export const agentPausedOutput = (): HandlerOutput =>
  fail('rejected', TOOL_TEXT.pausedSummary, TOOL_TEXT.pausedNextStep, 'AGENT_PAUSED');
