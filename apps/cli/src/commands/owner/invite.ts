// `agentlink invite [--long]` † (M1-9l; SEC-INVITE-CAPS, D-156, owner decision 18 Nov 2026; 04
// §2.5.1 `invite.create`, §3.6; 06 §8; 11 §5.11): the owner's own invite from the terminal.
//
// - An owner operation: the dispatcher's owner guard runs first (interactive terminal, no AI harness
//   marker; a UX guard, D-67). Then @4thtech-io/node shows the fixed summary, asks for the owner's
//   presence (master code at its own TTY prompt) and signs one `invite.create`; core verifies that
//   signature and records its nonce before it makes the invite (client.createOwnerInvite). Such an
//   invite is the owner's: not capped, not counted, and whoever pairs through it is a kept contact.
// - Without presence nothing is made. The AI's path is `agentlink_create_invite` (capped; its
//   contacts wait for the owner's Keep).
// - The link holds the invite secret: it is printed to this terminal only (never a log line, I-7).
//   W4-SHORT-INVITE (D-139 (7)): short by default; `--long` makes the format 1 link.
import { encodeBase64url, encodeHex, randomBytes, type JsonObject } from '@4thtech-io/crypto';
import { copy, formatDate } from '@4thtech-io/mcp-tools/strings/index.js';
import { OWNER_ACTION_MAX_LIFETIME_SECONDS } from '@4thtech-io/types';
import { EXIT_FAILED, EXIT_OK, type CommandHandler } from '../../dispatch.js';
import { TEXT, fill } from '../shared.js';
import { badArguments, chooseAgent, ownerContext, ownerStep } from './common.js';
import type { OwnerCommandDeps } from './deps.js';
import { OWNER_TEXT } from './strings.js';

/** Fixed text (11 §5.11). */
export const INVITE_OWNER_TEXT = Object.freeze({
  summary:
    'Create an invite from you. Whoever uses it first is connected with this ID as your contact.',
  failed: "Problem  That didn't go through. No invite was made.",
});

export function inviteOwnerHandler(deps: OwnerCommandDeps): CommandHandler {
  return (context) =>
    ownerStep(context, deps, async (deps) => {
      const { output } = context;
      if (context.parsed.positionals.length > 0) return badArguments(output);
      const long = context.parsed.values['long'] === true;
      const opened = await chooseAgent(deps, output, context.parsed.agent);
      if (!opened.ok) return opened.exit;
      const { agent } = opened;
      try {
        const owner = await ownerContext(agent);
        if (owner === undefined) {
          output.printError(OWNER_TEXT.noIdentity);
          return EXIT_FAILED;
        }
        const issuedAt = deps.now();
        const body: JsonObject = {
          v: 1,
          agent: owner.agent,
          owner: encodeHex(owner.owner.ownerNostr),
          op: 'invite.create',
          params: {},
          nonce: encodeBase64url(randomBytes(16)),
          issuedAt,
          expiresAt: issuedAt + OWNER_ACTION_MAX_LIFETIME_SECONDS['invite.create'],
        };
        const signature = await deps.signOwnerAction(owner.owner, {
          kind: 'owner-action',
          action: body,
          summary: INVITE_OWNER_TEXT.summary,
        });
        if (signature.kind !== 'owner-action') {
          output.printError(INVITE_OWNER_TEXT.failed);
          return EXIT_FAILED;
        }
        let invite;
        try {
          invite = await agent.client.createOwnerInvite(
            signature.signed,
            long ? { long: true } : {},
          );
        } catch {
          output.printError(INVITE_OWNER_TEXT.failed);
          return EXIT_FAILED;
        }
        const date = formatDate(new Date(invite.expiresAt * 1000));
        for (const line of [
          fill(TEXT.inviteReady, { date }),
          '',
          invite.inviteUrl,
          '',
          TEXT.inviteShareHeader,
          copy('chat.status.ok.inviteShare', { date, inviteUrl: invite.inviteUrl }),
          '',
          TEXT.inviteNext,
        ]) {
          output.print(line);
        }
        return EXIT_OK;
      } finally {
        await agent.close();
      }
    });
}
