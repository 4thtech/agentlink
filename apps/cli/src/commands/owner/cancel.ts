// `agentlink cancel <id>` † (M1-9b; 04 §2.5.1 `approval.cancel`, §3.4.2 rule 6; 06 §8; D-55, G-7).
//
// Voids an approval that has not been used yet, or the unused parts of a commitment approval. On a
// request still pending, the core records the cancel as its denial (04 §2.5.1). The cancel only
// ever takes authority away; the core verifies the owner signature and burns the nonce (M1-7d).
//
// The request is shown first (its card when the stored action parses, under the terminal output
// rule), then @4thtech-io/node shows the fixed summary, reads the owner code once at the TTY prompt
// and signs one `approval.cancel`. The owner code never passes through this module (I-1).
import { encodeBase64url, encodeHex, randomBytes, type JsonObject } from '@4thtech-io/crypto';
import { LOCAL_APPROVAL_LIFETIME_S } from '@4thtech-io/node';
import { EXIT_FAILED, EXIT_OK, type CommandContext } from '../../dispatch.js';
import { badArguments, openAgentHolding, ownerContext, ownerStep } from './common.js';
import type { OwnerCommandDeps } from './deps.js';
import { readEntry, readRow } from './pending.js';
import { cardFacts, cardLines } from './render.js';
import { OWNER_TEXT } from './strings.js';

/** Rows a cancel can still take authority from (the core decides; this only avoids a useless prompt). */
const CANCELLABLE = new Set(['pending', 'approved']);

async function cancelOne(
  deps: OwnerCommandDeps,
  context: CommandContext,
  approvalId: string,
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
    const now = deps.now();
    if (!CANCELLABLE.has(row.status) || row.signed_cancel !== null || row.expires_at <= now) {
      output.printError(OWNER_TEXT.cancelNotPossible);
      return EXIT_FAILED;
    }
    const entry = await readEntry(agent, row);
    if (entry.kind === 'ok') {
      const facts = await cardFacts(agent.client, entry);
      for (const line of cardLines(entry, facts)) output.print(line);
    } else {
      // A damaged request can still be cancelled: a cancel only takes authority away.
      output.print(OWNER_TEXT.problem);
    }
    output.print('');
    const owner = await ownerContext(agent);
    if (owner === undefined) {
      output.printError(OWNER_TEXT.noIdentity);
      return EXIT_FAILED;
    }
    const issuedAt = now;
    const body: JsonObject = {
      v: 1,
      agent: owner.agent,
      owner: encodeHex(owner.owner.ownerNostr),
      op: 'approval.cancel',
      params: { approvalId },
      nonce: encodeBase64url(randomBytes(16)),
      issuedAt,
      expiresAt: issuedAt + LOCAL_APPROVAL_LIFETIME_S,
    };
    const signature = await deps.signOwnerAction(owner.owner, {
      kind: 'owner-action',
      action: body,
      summary: OWNER_TEXT.cancelSummary,
    });
    if (signature.kind !== 'owner-action') {
      output.printError(OWNER_TEXT.cancelFailed);
      return EXIT_FAILED;
    }
    const outcome = await agent.client.ownerActions.apply(signature.signed);
    if (outcome.status !== 'applied') {
      output.printError(OWNER_TEXT.cancelFailed);
      return EXIT_FAILED;
    }
    output.print(OWNER_TEXT.cancelled);
    return EXIT_OK;
  } finally {
    await agent.close();
  }
}

export function cancelHandler(deps: OwnerCommandDeps) {
  return (context: CommandContext): Promise<number> =>
    ownerStep(context, deps, (deps) => {
      const { positionals } = context.parsed;
      const id = positionals[0];
      if (positionals.length !== 1 || id === undefined) {
        return Promise.resolve(badArguments(context.output));
      }
      return cancelOne(deps, context, id);
    });
}
