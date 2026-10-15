// `agentlink invite` (M1-9l; 06 §8, §7.1; 11 §6.1, §6.10): creates a single-use invite and prints
// the link on its own line, the ready-to-send share text and where the safety code is compared.
// Needs no owner presence (the invite carries only the agent's own signed card, 04 §3.6). The link
// holds the invite secret: it is printed to the terminal the user asked in and goes nowhere else
// (never a log line, I-7).
import { DISPATCH_TEXT, EXIT_OK, EXIT_USAGE, type CommandHandler } from '../dispatch.js';
import { copy, formatDate } from '../tools/strings/index.js';
import { TEXT, createDeps, fill, printAll, withAgent, type CommandDeps } from './shared.js';

export function createInviteHandler(deps: CommandDeps = createDeps()): CommandHandler {
  return (context) => {
    if (context.parsed.positionals.length > 0) {
      context.output.printError(DISPATCH_TEXT.badArguments);
      return Promise.resolve(EXIT_USAGE);
    }
    return withAgent(context, deps, async ({ client }) => {
      const invite = await client.pairing.createInvite();
      const date = formatDate(new Date(invite.expiresAt * 1000));
      printAll(context, [
        fill(TEXT.inviteReady, { date }),
        '',
        invite.inviteUrl,
        '',
        TEXT.inviteShareHeader,
        copy('chat.status.ok.inviteShare', { date, inviteUrl: invite.inviteUrl }),
        '',
        TEXT.inviteNext,
      ]);
      return EXIT_OK;
    });
  };
}

export const inviteHandler: CommandHandler = createInviteHandler();
