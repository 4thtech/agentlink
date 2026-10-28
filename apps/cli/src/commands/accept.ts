// `agentlink accept <url> [--approval <id>]` (M1-9l; 06 §2 `agentlink_accept_invite`, §7.1, §8;
// 04 §3.6, §2.9).
//
// It applies `contacts.acceptInvites` exactly as the tool does: under the default `approval` (and
// whenever the policy fails closed) nothing is stored. The command creates the approval request and
// prints the fixed M1a text that names `agentlink approve <id>` for the owner's own terminal; it
// never prompts for the owner passphrase, with or without a terminal (owner presence is the
// `approve` command's, M1-9b). After the owner approves, the same command with `--approval <id>`
// proceeds once: core re-verifies the stored owner signature against the digest it recomputes from
// this call's action, and claims the approval in one compare-and-set (I-4). Under `auto` the
// pairing is staged and its handshake published at once.
//
// The link is untrusted input (I-5): core decodes and checks it; nothing the link carries is
// printed except through the contact-name rule (restricted name plus label).
import {
  CoreError,
  acceptInviteSummary,
  evaluate,
  renderContactName,
  type CoreErrorCode,
} from '@4thtech-io/core';
import { approvalNextStep, isApprovalId } from '../approval/next-step.js';
import {
  DISPATCH_TEXT,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  type CommandContext,
  type CommandHandler,
} from '../dispatch.js';
import { acceptInviteAction } from '@4thtech-io/mcp-tools/accept-action.js';
import { RUNTIME_MESSAGES } from '../runtime/errors.js';
import type { OpenedAgent } from '../runtime/open-agent.js';
import { terminalOneLine } from '../terminal/sanitize.js';
import { TEXT, createDeps, fill, printAll, withAgent, type CommandDeps } from './shared.js';

/** Core errors that only mean "the outbox could not publish right now". */
const OFFLINE_CODES: ReadonlySet<CoreErrorCode> = new Set<CoreErrorCode>(['transport_unavailable']);

async function publishHandshake(agent: OpenedAgent): Promise<boolean> {
  try {
    const summary = await agent.client.outbox.processDue();
    return summary.sent > 0 && summary.failed === 0 && summary.notDelivered === 0;
  } catch (error) {
    if (error instanceof CoreError && !OFFLINE_CODES.has(error.code)) throw error;
    return false;
  }
}

export function createAcceptHandler(deps: CommandDeps = createDeps()): CommandHandler {
  return (context: CommandContext) => {
    const [link, ...extra] = context.parsed.positionals;
    if (link === undefined || extra.length > 0) {
      context.output.printError(DISPATCH_TEXT.badArguments);
      return Promise.resolve(EXIT_USAGE);
    }
    const approvalValue = context.parsed.values['approval'];
    if (approvalValue !== undefined && !isApprovalId(approvalValue)) {
      context.output.printError(RUNTIME_MESSAGES.approval_id_invalid);
      return Promise.resolve(EXIT_USAGE);
    }
    const approvalId = typeof approvalValue === 'string' ? approvalValue : undefined;

    return withAgent(context, deps, async (agent) => {
      const { client } = agent;
      // Step 1 always runs and stores nothing: decode, strict schema, expiry, both card signatures,
      // name and relays (04 §3.6 Accept). A bad link ends here with core's fixed sentence.
      const checked = await client.pairing.acceptInvite({ link });
      const contactName = terminalOneLine(renderContactName(checked.contact.display));
      const action = await acceptInviteAction(link);
      const decision = evaluate(await client.ownerActions.loadPolicy(), { kind: 'invite.accept' });
      if (decision === 'deny') {
        context.output.printError(TEXT.acceptNotAllowed);
        return EXIT_FAILED;
      }

      if (decision === 'approval') {
        if (approvalId === undefined) {
          const pending = await client.approvalService.request({
            action,
            summary: acceptInviteSummary(checked.contact),
          });
          printAll(context, [
            approvalNextStep(pending.approvalId, agent.name),
            fill(TEXT.acceptThenRetry, { approvalId: pending.approvalId }),
          ]);
          return EXIT_OK;
        }
        const used = await client.approvalService.use(approvalId, action, decision);
        if (used.status !== 'used') {
          context.output.printError(
            used.status === 'pending'
              ? TEXT.acceptStillWaiting
              : used.status === 'denied'
                ? TEXT.acceptDenied
                : used.status === 'expired'
                  ? TEXT.acceptExpired
                  : TEXT.acceptRefused,
          );
          return EXIT_FAILED;
        }
      }

      const started = await client.pairing.acceptInvite({ link, allowed: true });
      if (started.status !== 'pending') {
        // `allowed` was set, so this does not happen; fail closed with fixed text if it ever does.
        context.output.printError(DISPATCH_TEXT.failed);
        return EXIT_FAILED;
      }
      const sent = await publishHandshake(agent);
      printAll(context, [fill(TEXT.acceptWaiting, { contactName })]);
      if (!sent) printAll(context, [TEXT.acceptOffline]);
      return EXIT_OK;
    });
  };
}

export const acceptHandler: CommandHandler = createAcceptHandler();
