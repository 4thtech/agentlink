// `agentlink contacts rename <contactId> <alias>` † and `agentlink contacts remove <contactId>` †
// (M1-9za; 04 §2.5, §2.5.1 `contact.rename`, `contact.remove`; 06 §2.1 rule 1, §8; 07 §3; 02 F-14).
//
// Live finding (2026-10-17): two contacts that declared the same name made every send by that name
// AMBIGUOUS_CONTACT, and nothing could fix it. These owner commands can.
//
// - Owner operations: the dispatcher's owner-terminal guard runs first (interactive terminal, no AI
//   harness marker; a UX guard, not a security boundary, D-67); then @4thtech-io/node shows the fixed
//   summary, reads the owner code once at its own TTY prompt and signs one owner action. The core
//   verifies the owner signature and the nonce and applies it (I-4). No MCP tool does either.
// - The contact is named by its ID only (`agentlink contacts` lists it): a name can be ambiguous,
//   which is the problem these commands fix.
// - The alias must already be its own restricted form (06 §2.1 `restrictName`), and no other active
//   contact may show it, so renaming never makes a name ambiguous again. Checked before the prompt.
// - Nothing the caller typed is echoed in an error (I-5). The summary shows the contact under the
//   name rule and the alias only after it passed the check above.
// - Remove keeps the 07 §3 tombstone: later messages from the contact are dropped, and only a new
//   pairing brings it back. The contact is not told.
import { isRestrictedAlias, renderContactName, type ContactView } from '@4thtech-io/core';
import { encodeBase64url, encodeHex, randomBytes, type JsonObject } from '@4thtech-io/crypto';
import { OWNER_ACTION_MAX_LIFETIME_SECONDS } from '@4thtech-io/types';
import { EXIT_FAILED, EXIT_OK, type CommandContext, type CommandHandler } from '../../dispatch.js';
import { commandPrefix } from '../../runtime/cli-prefix.js';
import { terminalOneLine } from '../../terminal/sanitize.js';
import { removeInvisible } from '@4thtech-io/mcp-tools/untrusted.js';
import { badArguments, chooseAgent, ownerContext, ownerStep } from './common.js';
import type { OwnerCommandDeps } from './deps.js';
import { OWNER_TEXT } from './strings.js';

/** A contact ID as `agentlink contacts` prints it (04 §2.9): `0x` + 40 hex. */
const CONTACT_ID = /^0x[0-9a-fA-F]{40}$/;

/** Fixed text (11 §5 vocabulary). Only the name-rule name and a checked alias are ever inserted. */
export const CONTACTS_MANAGE_TEXT = Object.freeze({
  get badId(): string {
    return `That is not a contact ID. Run \`${commandPrefix()} contacts\` to see each contact with its ID, then use the ID.`;
  },
  get notFound(): string {
    return `No contact with that ID. Run \`${commandPrefix()} contacts\` to see your contacts.`;
  },
  badAlias:
    'That name can’t be used. Use letters, numbers, spaces, dots, apostrophes and hyphens, one script, at most 32 characters, and no words such as “verified” or “owner”.',
  aliasTaken: 'Another contact already shows that name. Choose a different one.',
  renameSummary: (current: string, alias: string): string =>
    `Rename the contact ${current} to “${alias}”. Your AI and AgentLink will show this name for it.`,
  removeSummary: (current: string): string =>
    `Remove the contact ${current}. Your AI can no longer send to it, and messages from it are dropped. It isn’t told. To talk again, pair with a new invite.`,
  renamed: 'OK       Renamed.',
  removed: 'OK       Removed.',
  failed: "Problem  That didn't go through. Nothing was changed.",
});

const fold = (text: string): string =>
  removeInvisible(text).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/** The contact's name as the name rule shows it (06 §2.1), one sanitized line. */
const shown = (contact: ContactView): string => terminalOneLine(renderContactName(contact.display));

async function manage(
  deps: OwnerCommandDeps,
  context: CommandContext,
  op: 'contact.rename' | 'contact.remove',
  rawId: string,
  rawAlias: string | undefined,
): Promise<number> {
  const { output } = context;
  if (!CONTACT_ID.test(rawId)) {
    output.printError(CONTACTS_MANAGE_TEXT.badId);
    return EXIT_FAILED;
  }
  const contactId = rawId.toLowerCase();
  let alias: string | undefined;
  if (op === 'contact.rename') {
    // NFKC first, so an alias typed in another normal form is accepted as its one canonical form.
    const typed = rawAlias?.normalize('NFKC');
    if (!isRestrictedAlias(typed)) {
      output.printError(CONTACTS_MANAGE_TEXT.badAlias);
      return EXIT_FAILED;
    }
    alias = typed;
  }

  const opened = await chooseAgent(deps, output, context.parsed.agent);
  if (!opened.ok) return opened.exit;
  const { agent } = opened;
  try {
    const contacts = await agent.client.contacts.list();
    const contact = contacts.find((c) => c.id === contactId);
    if (contact === undefined) {
      output.printError(CONTACTS_MANAGE_TEXT.notFound);
      return EXIT_FAILED;
    }
    if (alias !== undefined) {
      const wanted = fold(alias);
      const taken = contacts.some(
        (c) => c.id !== contactId && c.status === 'active' && fold(c.display.name) === wanted,
      );
      if (taken) {
        output.printError(CONTACTS_MANAGE_TEXT.aliasTaken);
        return EXIT_FAILED;
      }
    }
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
      op,
      params: alias === undefined ? { contact: contactId } : { contact: contactId, alias },
      nonce: encodeBase64url(randomBytes(16)),
      issuedAt,
      expiresAt: issuedAt + OWNER_ACTION_MAX_LIFETIME_SECONDS[op],
    };
    const summary =
      alias === undefined
        ? CONTACTS_MANAGE_TEXT.removeSummary(shown(contact))
        : CONTACTS_MANAGE_TEXT.renameSummary(shown(contact), terminalOneLine(alias));
    const signature = await deps.signOwnerAction(owner.owner, {
      kind: 'owner-action',
      action: body,
      summary,
    });
    if (signature.kind !== 'owner-action') {
      output.printError(CONTACTS_MANAGE_TEXT.failed);
      return EXIT_FAILED;
    }
    const outcome = await agent.client.ownerActions.apply(signature.signed);
    if (outcome.status !== 'applied') {
      output.printError(CONTACTS_MANAGE_TEXT.failed);
      return EXIT_FAILED;
    }
    output.print(
      op === 'contact.rename' ? CONTACTS_MANAGE_TEXT.renamed : CONTACTS_MANAGE_TEXT.removed,
    );
    return EXIT_OK;
  } finally {
    await agent.close();
  }
}

/** `contacts rename | remove` (the `contacts` handler hands these subcommands here). */
export function contactsManageHandler(deps: OwnerCommandDeps): CommandHandler {
  return (context) =>
    ownerStep(context, deps, (deps) => {
      const [sub, id, alias, ...extra] = context.parsed.positionals;
      if (extra.length > 0 || id === undefined || context.parsed.values['verify'] !== undefined) {
        return Promise.resolve(badArguments(context.output));
      }
      if (sub === 'rename' && alias !== undefined) {
        return manage(deps, context, 'contact.rename', id, alias);
      }
      if (sub === 'remove' && alias === undefined) {
        return manage(deps, context, 'contact.remove', id, undefined);
      }
      return Promise.resolve(badArguments(context.output));
    });
}
