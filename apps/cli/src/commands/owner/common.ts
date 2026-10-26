// Shared steps of the owner commands (M1-9b): choosing the agent, the owner context for signing,
// printing outcomes, and turning @4thtech-io/node's fixed-text errors into output.
import type { OwnerActionOutcome } from '@4thtech-io/core';
import { decodeHex0x, KeyStoreError } from '@4thtech-io/crypto';
import { NodeKeyStoreError, type ApprovalContext } from '@4thtech-io/node';
import { DISPATCH_TEXT, EXIT_FAILED, EXIT_USAGE, type CommandContext } from '../../dispatch.js';
import type { Output } from '../../output.js';
import { isAgentName } from '../../runtime/agent-name.js';
import { copy } from '@4thtech-io/mcp-tools/strings/index.js';
import type { OwnerAgent, OwnerCommandDeps } from './deps.js';
import { readRow } from './pending.js';
import { withOwnerPrompts } from './prompts.js';
import { OWNER_TEXT } from './strings.js';

export type Opened =
  { readonly ok: true; readonly agent: OwnerAgent } | { readonly ok: false; readonly exit: number };

/** Opens one agent, printing the fixed setup copy when it is not usable. */
export async function openOne(
  deps: OwnerCommandDeps,
  output: Output,
  name: string | undefined,
): Promise<Opened> {
  const result = await deps.open(name);
  if (result.status === 'ok') return { ok: true, agent: result.agent };
  output.printError(result.message);
  if (result.fix !== undefined) output.printError(result.fix);
  return { ok: false, exit: EXIT_FAILED };
}

/**
 * The agent that holds `approvalId` (06 §2.5 step 2): the `--agent` one; the only one; or, on a
 * machine with several agents, the one whose store has a row with this ID.
 */
export async function openAgentHolding(
  deps: OwnerCommandDeps,
  output: Output,
  flag: string | undefined,
  approvalId: string,
): Promise<Opened> {
  if (flag !== undefined) return openOne(deps, output, flag);
  const names = (await deps.listAgents()).filter((n) => isAgentName(n));
  if (names.length <= 1) return openOne(deps, output, names[0]);
  for (const name of names) {
    const result = await deps.open(name);
    if (result.status !== 'ok') continue;
    if ((await readRow(result.agent, approvalId)) !== undefined) {
      return { ok: true, agent: result.agent };
    }
    await result.agent.close();
  }
  output.printError(OWNER_TEXT.notFound);
  return { ok: false, exit: EXIT_FAILED };
}

/** One agent's list (04 §2.5.2 step 1): `--agent`, the only one, or asked when there are several. */
export async function chooseAgent(
  deps: OwnerCommandDeps,
  output: Output,
  flag: string | undefined,
): Promise<Opened> {
  if (flag !== undefined) return openOne(deps, output, flag);
  const names = (await deps.listAgents()).filter((n) => isAgentName(n));
  if (names.length <= 1) return openOne(deps, output, names[0]);
  // Agent names passed the 06 §6 pattern: [a-z0-9-] only, nothing to sanitize.
  names.forEach((name, i) => output.print(`  ${String(i + 1)}. ${name}`));
  const answer = (await deps.ask(OWNER_TEXT.severalAgents)).trim();
  const index = /^[0-9]{1,3}$/.test(answer) ? Number(answer) - 1 : -1;
  const chosen = names[index];
  if (chosen === undefined) {
    output.printError(OWNER_TEXT.agentNotChosen);
    return { ok: false, exit: EXIT_FAILED };
  }
  return openOne(deps, output, chosen);
}

/** The agent and the owner its card names (04 §2.5.1 `agent`, `owner`), or undefined. */
export async function ownerContext(agent: OwnerAgent): Promise<ApprovalContext | undefined> {
  const view = await agent.client.identity.get();
  if (view === undefined || view.revoked) return undefined;
  return {
    agent: view.agentId,
    owner: {
      ownerEvm: decodeHex0x(view.card.ownerEvm),
      ownerNostr: decodeHex0x(view.card.ownerNostr),
      ownerEnc: decodeHex0x(view.card.ownerEnc),
    },
  };
}

/**
 * One result line per decided item, then the footer (11 §6.10). A refused batch applies nothing
 * (04 §2.5.2): the items the core named as not matching get the failed line, and the others are
 * told they were held back with it and still wait (04 §2.5.2 "reports which items failed").
 */
export function printOutcome(
  output: Output,
  outcome: OwnerActionOutcome,
  items: readonly {
    readonly approvalId: string;
    readonly summary: string;
    readonly decision: 'approve' | 'deny';
  }[],
): boolean {
  const applied = outcome.status === 'applied';
  const failedIds = new Set(
    outcome.status === 'refused' ? (outcome.items ?? []).map((i) => i.approvalId) : [],
  );
  for (const item of items) {
    if (applied) {
      const key =
        item.decision === 'approve' ? 'cli.approve.resultApproved' : 'cli.approve.resultDenied';
      output.print(copy(key, { action: item.summary }));
    } else if (failedIds.size === 0 || failedIds.has(item.approvalId)) {
      output.print(copy('cli.approve.resultFailed', { action: item.summary }));
    } else {
      output.print(`${OWNER_TEXT.heldBack} ${item.summary}`);
    }
  }
  output.print(copy('cli.approve.footer'));
  return applied;
}

/**
 * A wrong owner code (`presence_rejected`). By name and code as well as by class: the owner store
 * may come from another copy of @4thtech-io/crypto than this module's.
 */
export function isPresenceRejected(error: unknown): boolean {
  if (error instanceof KeyStoreError) return error.code === 'presence_rejected';
  return (
    error instanceof Error &&
    error.name === 'KeyStoreError' &&
    (error as { code?: unknown }).code === 'presence_rejected'
  );
}

/**
 * Runs an owner command body with `deps` that print the owner code reminder before every prompt
 * (M1-9zd, prompts.ts). @4thtech-io/node's errors carry fixed text only (no secret, no stored
 * value), so their message is what the owner sees; a wrong owner code gets the fixed reminder
 * (M1-9zd); every other error goes to the dispatcher, which prints fixed text.
 */
export async function ownerStep(
  context: CommandContext,
  deps: OwnerCommandDeps,
  body: (deps: OwnerCommandDeps) => Promise<number>,
): Promise<number> {
  try {
    return await body(withOwnerPrompts(deps, context.output));
  } catch (error) {
    if (error instanceof NodeKeyStoreError) {
      context.output.printError(error.message);
      return EXIT_FAILED;
    }
    if (isPresenceRejected(error)) {
      context.output.printError(OWNER_TEXT.wrongCode);
      return EXIT_FAILED;
    }
    throw error;
  }
}

/** Fixed usage error for extra or missing positionals (I-5: the typed value is never echoed). */
export function badArguments(output: Output): number {
  output.printError(DISPATCH_TEXT.badArguments);
  return EXIT_USAGE;
}
