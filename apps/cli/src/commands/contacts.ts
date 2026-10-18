// `agentlink contacts` (M1-9l; 06 §2.1, §8; 11 §6.10): lists contacts under the contact-name rule.
//
// A name appears only as the owner's alias or the restricted name with its identity label
// (`display`, rendered by renderContactName), never as the name the contact declared (D-53, I-5).
// The list carries no safety code and no message text. Each contact's ID is listed for
// `contacts rename | remove` † (M1-9za), which the dispatcher guards and the owner handler runs. `contacts --verify <id>` is an owner
// operation (M1-9m): the dispatcher already requires an interactive terminal for it, and until that
// card lands this handler says it is not available.
import { renderContactName } from '@4thtech-io/core';
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  DISPATCH_TEXT,
  type CommandHandler,
} from '../dispatch.js';
import { terminalOneLine } from '../terminal/sanitize.js';
import { TEXT, createDeps, fill, printAll, withAgent, type CommandDeps } from './shared.js';
import { renderCopy } from '../tools/strings/index.js';

export function createContactsHandler(
  deps: CommandDeps = createDeps(),
  /** `contacts rename | remove` † (M1-9za): the owner handler the subcommands are handed to. */
  manage?: CommandHandler,
): CommandHandler {
  return (context) => {
    const sub = context.parsed.positionals[0];
    if (manage !== undefined && (sub === 'rename' || sub === 'remove')) return manage(context);
    if (context.parsed.positionals.length > 0) {
      context.output.printError(DISPATCH_TEXT.badArguments);
      return Promise.resolve(EXIT_USAGE);
    }
    if (context.parsed.values['verify'] !== undefined) {
      context.output.printError(TEXT.verifyNotYet);
      return Promise.resolve(EXIT_FAILED);
    }
    return withAgent(context, deps, async ({ client }) => {
      const contacts = await client.contacts.list();
      if (contacts.length === 0) {
        context.output.print(TEXT.contactsNone);
        return EXIT_OK;
      }
      const lines = [renderCopy(TEXT.contactsHeader, { count: contacts.length }), ''];
      contacts.forEach((contact, index) => {
        const state =
          contact.pairing === 'complete'
            ? contact.status === 'active'
              ? 'paired'
              : String(contact.status)
            : `pairing ${String(contact.pairing)}`;
        const checked = contact.safetyCodeChecked
          ? 'safety code checked'
          : 'safety code not checked';
        lines.push(
          fill('{index}. {name}', {
            index: index + 1,
            name: terminalOneLine(renderContactName(contact.display)),
          }),
          fill('   {state} · {checked} · owner {fingerprint}', {
            state: terminalOneLine(state),
            checked,
            fingerprint: terminalOneLine(contact.ownerFingerprint.short),
          }),
          // M1-9za: the ID `contacts rename` and `contacts remove` take (04 §2.9; checked hex).
          fill('   ID {id}', { id: terminalOneLine(contact.id) }),
        );
      });
      printAll(context, lines);
      return EXIT_OK;
    });
  };
}

export const contactsHandler: CommandHandler = createContactsHandler();
