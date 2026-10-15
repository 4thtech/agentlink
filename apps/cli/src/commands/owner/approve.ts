// `agentlink approve <id>`, `agentlink deny <id>` and `agentlink approve` with no ID † (M1-9b;
// 04 §2.5, §2.5.2; 06 §2.5 step 3, §8; 11 §6.10; D-67, D-68, D-73 (3)).
//
// Flow, the same for one request and for a list:
// 1. open the agent (the same KeyStore and store file as the agent's own process, M1-9k);
// 2. read the pending rows, parse each stored action strictly and recompute its digest (pending.ts);
//    a row that fails is shown as a problem and never offered;
// 3. show each request as its card under the terminal output rule (render.ts);
// 4. (list) ask approve, deny or later for each; commitments are sent to `approve <id>` on their own;
//    then check again that every chosen request is still pending and unchanged, and drop the rest
//    with a notice (04 §2.5.2 step 4);
// 5. hand exactly the shown, still-pending requests to @agentlink/node, which recomputes each digest
//    from the same parsed action, shows the decisions, asks "Continue?", reads the owner code once at
//    the TTY prompt and signs one `approval.decide` (one item) or `approval.decideBatch` (2–20);
// 6. apply the signed object through this process's own client (`ownerActions.apply`): the core
//    verifies it and burns the nonce (M1-7d, M1-7e); print one fixed result line per request.
//
// The owner code never passes through this module (I-1). Nothing here decides: authority is the
// owner signature the core verifies (I-4).
import { MAX_APPROVAL_BATCH_ITEMS, type ReviewedApproval } from '@agentlink/node';
import { batchRegions } from '../../terminal/sanitize.js';
import { copy } from '../../tools/strings/index.js';
import { EXIT_FAILED, EXIT_OK, type CommandContext } from '../../dispatch.js';
import {
  badArguments,
  chooseAgent,
  openAgentHolding,
  ownerContext,
  ownerStep,
  printOutcome,
} from './common.js';
import type { OwnerAgent, OwnerCommandDeps } from './deps.js';
import {
  isLivePending,
  loadPending,
  readEntry,
  readRow,
  stillPending,
  type PendingRequest,
} from './pending.js';
import { cardFacts, cardLines, type CardFacts } from './render.js';
import { OWNER_TEXT } from './strings.js';

type Decision = 'approve' | 'deny';

interface Chosen {
  readonly request: PendingRequest;
  readonly facts: CardFacts;
  readonly decision: Decision;
}

const reviewed = (chosen: Chosen): ReviewedApproval => ({
  approvalId: chosen.request.approvalId,
  // The same frozen parsed object that was rendered: node recomputes the signed digest from it.
  action: chosen.request.action,
  storedDigest: chosen.request.storedDigest,
  decision: chosen.decision,
  commitment: chosen.request.commitment,
  summary: chosen.facts.summary,
  requestExpiresAt: chosen.request.expiresAt,
});

/** Signs and applies the chosen decisions; prints the outcome. */
async function signAndApply(
  deps: OwnerCommandDeps,
  context: CommandContext,
  agent: OwnerAgent,
  chosen: readonly Chosen[],
): Promise<number> {
  const owner = await ownerContext(agent);
  if (owner === undefined) {
    context.output.printError(OWNER_TEXT.noIdentity);
    return EXIT_FAILED;
  }
  const signed = await deps.decide(owner, chosen.map(reviewed));
  const outcome = await agent.client.ownerActions.apply(signed);
  const applied = printOutcome(
    context.output,
    outcome,
    chosen.map((c) => ({
      approvalId: c.request.approvalId,
      summary: c.facts.summary,
      decision: c.decision,
    })),
  );
  return applied ? EXIT_OK : EXIT_FAILED;
}

/** `approve <id>` and `deny <id>`: one request, one `approval.decide`. */
async function decideOne(
  deps: OwnerCommandDeps,
  context: CommandContext,
  approvalId: string,
  decision: Decision,
): Promise<number> {
  const { output } = context;
  const opened = await openAgentHolding(deps, output, context.parsed.agent, approvalId);
  if (!opened.ok) return opened.exit;
  const { agent } = opened;
  try {
    const row = await readRow(agent, approvalId);
    if (row === undefined) {
      output.printError(OWNER_TEXT.notFound);
      return EXIT_FAILED;
    }
    if (!isLivePending(row, deps.now())) {
      output.printError(OWNER_TEXT.notPending);
      return EXIT_FAILED;
    }
    const entry = await readEntry(agent, row);
    if (entry.kind !== 'ok') {
      output.printError(OWNER_TEXT.problem);
      return EXIT_FAILED;
    }
    const facts = await cardFacts(agent.client, entry);
    if (facts.terms === 'problem') {
      // The terms shown would not be the terms signed (M1-9q): never offered.
      output.printError(OWNER_TEXT.problem);
      return EXIT_FAILED;
    }
    for (const line of cardLines(entry, facts)) output.print(line);
    output.print('');
    // A commitment is decided alone, as here (D-31, 04 §2.5.2): one request, one approval.decide.
    const { kept } = await stillPending(agent, [entry], deps.now());
    if (kept.length === 0) {
      output.printError(OWNER_TEXT.notPending);
      return EXIT_FAILED;
    }
    return await signAndApply(deps, context, agent, [{ request: entry, facts, decision }]);
  } finally {
    await agent.close();
  }
}

const ANSWER_APPROVE = new Set(['a', 'approve']);
const ANSWER_DENY = new Set(['d', 'deny']);

/** `approve` with no ID: one agent's list, one owner code entry (D-68). */
async function reviewList(deps: OwnerCommandDeps, context: CommandContext): Promise<number> {
  const { output } = context;
  const opened = await chooseAgent(deps, output, context.parsed.agent);
  if (!opened.ok) return opened.exit;
  const { agent } = opened;
  try {
    const entries = await loadPending(agent, deps.now());
    if (entries.length === 0) {
      output.print(copy('cli.approve.nothing'));
      return EXIT_OK;
    }
    output.print(copy('cli.approve.waiting', { count: entries.length }));
    output.print('');
    // At most 20 cards at a time (06 §8, 04 §2.5.2 step 2); the rest wait for the next review.
    const { shown, omitted } = batchRegions(entries);
    const chosen: Chosen[] = [];
    let number = 0;
    for (const entry of shown) {
      number += 1;
      if (entry.kind !== 'ok') {
        output.print(`${String(number)}. ${OWNER_TEXT.problemListed}`);
        output.print('');
        continue;
      }
      const facts = await cardFacts(agent.client, entry);
      if (facts.terms === 'problem') {
        output.print(`${String(number)}. ${OWNER_TEXT.problemListed}`);
        output.print('');
        continue;
      }
      for (const line of cardLines(entry, facts, number)) output.print(line);
      if (entry.commitment) {
        // Listed, never selectable: terms are decided alone (IR-D-68-1, 04 §2.5.2).
        output.print(copy('cli.approve.termsOwn', { approvalId: entry.approvalId }));
        output.print('');
        continue;
      }
      const answer = (await deps.ask(copy('cli.approve.question'))).trim().toLowerCase();
      output.print('');
      if (ANSWER_APPROVE.has(answer)) chosen.push({ request: entry, facts, decision: 'approve' });
      else if (ANSWER_DENY.has(answer)) chosen.push({ request: entry, facts, decision: 'deny' });
    }
    if (omitted > 0) output.print(OWNER_TEXT.moreWaiting);
    if (chosen.length === 0) {
      output.print(OWNER_TEXT.nothingDecided);
      return EXIT_OK;
    }
    if (chosen.length > MAX_APPROVAL_BATCH_ITEMS) {
      // Unreachable while batchRegions shows at most 20; kept so the bound never depends on it.
      output.printError(OWNER_TEXT.nothingDecided);
      return EXIT_FAILED;
    }
    // 04 §2.5.2 step 4: drop anything no longer pending (or changed) and say so.
    const { kept, dropped } = await stillPending(
      agent,
      chosen.map((c) => c.request),
      deps.now(),
    );
    if (dropped.length > 0) {
      output.print(OWNER_TEXT.dropped);
      for (const request of dropped) {
        const facts = chosen.find((c) => c.request === request)?.facts;
        if (facts !== undefined) output.print(`  ${facts.summary}`);
      }
    }
    const final = chosen.filter((c) => kept.includes(c.request));
    if (final.length === 0) {
      output.print(OWNER_TEXT.noneLeft);
      return EXIT_OK;
    }
    return await signAndApply(deps, context, agent, final);
  } finally {
    await agent.close();
  }
}

export function approveHandler(deps: OwnerCommandDeps) {
  return (context: CommandContext): Promise<number> =>
    ownerStep(context, () => {
      const { positionals } = context.parsed;
      if (positionals.length > 1) return Promise.resolve(badArguments(context.output));
      const id = positionals[0];
      return id === undefined ? reviewList(deps, context) : decideOne(deps, context, id, 'approve');
    });
}

export function denyHandler(deps: OwnerCommandDeps) {
  return (context: CommandContext): Promise<number> =>
    ownerStep(context, () => {
      const { positionals } = context.parsed;
      const id = positionals[0];
      if (positionals.length !== 1 || id === undefined) {
        return Promise.resolve(badArguments(context.output));
      }
      return decideOne(deps, context, id, 'deny');
    });
}
