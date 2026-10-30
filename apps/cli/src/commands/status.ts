// `agentlink status [--brief]` (M1-9l; 06 §2.0, §6.1, §8; D-53, D-73): the same data as
// `agentlink_status`, read-only in fact.
//
// It calls `catchUp` and nothing else that writes: the fetch-only pass stores raw envelopes and
// counts them by sender against the existing contact list. No handshake, acknowledgement, card
// update, receipt or read mark is processed (06 §2.0, §9), so a pending pairing message stays
// unprocessed until the server's loop or the next inbox read handles it. The output carries counts
// and contact names under the 06 §2.1 rule only: never message text, subjects, file names or
// request content (I-5). Unknown senders are a count.
//
// `--brief` prints only the unread counts, the requests count and the contact names. Without it the
// command adds the agent's local name and ID and the number of contacts. Credits, prices, storage
// and pending approvals are not part of M1-9l (they need the chain and storage packages, M1-9h).
import { renderContactName, type CatchUpResult, type InboxCounts } from '@4thtech-io/core';
import { DISPATCH_TEXT, EXIT_OK, EXIT_USAGE, type CommandHandler } from '../dispatch.js';
import { terminalOneLine } from '../terminal/sanitize.js';
import { copy } from '@4thtech-io/mcp-tools/strings/index.js';
import {
  TEXT,
  agentPausedNow,
  createDeps,
  fill,
  printAll,
  withAgent,
  type CommandDeps,
} from './shared.js';

/** The 3 s budget of `agentlink_status` (06 §2.0). */
export const STATUS_CATCH_UP_MS = 3_000;

export function createStatusHandler(deps: CommandDeps = createDeps()): CommandHandler {
  return (context) => {
    if (context.parsed.positionals.length > 0) {
      context.output.printError(DISPATCH_TEXT.badArguments);
      return Promise.resolve(EXIT_USAGE);
    }
    const brief = context.parsed.values['brief'] === true;
    return withAgent(context, deps, async ({ client, name, agentId }) => {
      const warnings: string[] = [];
      let counts: InboxCounts;
      if (await agentPausedNow(client)) {
        // W4-PAUSE (06 §6): a paused agent answers from the store, with no relay fetch.
        counts = await client.inbox.counts();
        warnings.push(TEXT.statusPaused);
      } else {
        try {
          const caught: CatchUpResult = await client.catchUp({ budgetMs: STATUS_CATCH_UP_MS });
          counts = caught;
          if (caught.partial) warnings.push(TEXT.statusPartial);
          if (caught.incomplete > 0) warnings.push(TEXT.statusIncomplete);
        } catch {
          // Offline or no transport: the stored counts still answer (store reads only).
          counts = await client.inbox.counts();
          warnings.push(TEXT.statusOffline);
        }
      }

      const lines: string[] = [];
      if (!brief) {
        const contacts = await client.contacts.list();
        lines.push(
          fill('Agent: {name} ({agentId})', {
            name: terminalOneLine(name),
            agentId: terminalOneLine(agentId),
          }),
          fill('Contacts: {count}', { count: contacts.length }),
        );
      }
      let anything = false;
      for (const entry of counts.inbox) {
        const display = await client.contacts.get(entry.contactId).then(
          (view) => view.display,
          () => undefined,
        );
        if (display === undefined) continue;
        anything = true;
        lines.push(
          copy('cli.status.brief.messages', {
            count: entry.unread,
            contactName: terminalOneLine(renderContactName(display)),
          }),
        );
      }
      if (counts.requests > 0) {
        anything = true;
        lines.push(copy('cli.status.brief.requests', { count: counts.requests }));
      }
      if (!anything) lines.push(copy('cli.status.brief.nothing'));
      printAll(context, [...lines, ...warnings]);
      return EXIT_OK;
    });
  };
}

export const statusHandler: CommandHandler = createStatusHandler();
