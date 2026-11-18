// `agentlink owner update-contact-details` † (RELAY-CARD-MIGRATION, 0.5.13; 04 §2.5, §2.6; 07 §4.3;
// 11 §5; I-4; owner-approved 2026-11-18): the terminal's "Update your contact details".
//
// - An owner command: the dispatcher's owner guard runs first (interactive terminal, no AI-harness
//   marker; a UX guard, D-67). An ID already on the current list asks for nothing.
// - Otherwise @4thtech-io/node (updateContactDetailsAtTerminal) shows the fixed statement, asks for
//   the owner's presence (the master code at its own TTY prompt) and signs the ID's next card with
//   the migrated list; core's card-update then tells the contacts. Without presence nothing changes.
// - No MCP tool reaches this (I-4). Copy never says "relay" (11 §5).
import { EXIT_FAILED, EXIT_OK, type CommandContext } from '../../dispatch.js';
import { commandPrefix } from '../../runtime/cli-prefix.js';
import { chooseAgent, ownerContext } from './common.js';
import type { OwnerCommandDeps } from './deps.js';
import { OWNER_TEXT } from './strings.js';

/** Fixed text (11 §5). */
export const CONTACT_DETAILS_TEXT = Object.freeze({
  current: 'OK       Your contact details are up to date. Nothing to do.',
  done: 'OK       Contact details updated. Your contacts get your new details.',
  failed: "Problem  That didn't go through. Your contact details didn't change.",
  pending: 'Problem  An earlier change of this ID is still finishing. Try again in a minute.',
  get doctorHint(): string {
    return `Notice   Update your contact details: AgentLink moved to more reliable servers.\n         Your contacts need your new details once. Run \`${commandPrefix()} owner update-contact-details\`.`;
  },
});

export async function updateContactDetailsOne(
  deps: OwnerCommandDeps,
  context: CommandContext,
): Promise<number> {
  const { output } = context;
  const opened = await chooseAgent(deps, output, context.parsed.agent);
  if (!opened.ok) return opened.exit;
  const { agent } = opened;
  try {
    const owner = await ownerContext(agent);
    if (owner === undefined) {
      output.printError(OWNER_TEXT.noIdentity);
      return EXIT_FAILED;
    }
    if ((await agent.client.identity.relayMigration()).status !== 'needed') {
      output.print(CONTACT_DETAILS_TEXT.current);
      return EXIT_OK;
    }
    if (deps.updateContactDetails === undefined) {
      output.printError(CONTACT_DETAILS_TEXT.failed);
      return EXIT_FAILED;
    }
    let outcome: Awaited<ReturnType<NonNullable<OwnerCommandDeps['updateContactDetails']>>>;
    try {
      outcome = await deps.updateContactDetails({ agent, owner: owner.owner });
    } catch {
      output.printError(CONTACT_DETAILS_TEXT.failed);
      return EXIT_FAILED;
    }
    if (outcome.status === 'migrated') {
      output.print(CONTACT_DETAILS_TEXT.done);
      return EXIT_OK;
    }
    if (outcome.reason === 'current') {
      output.print(CONTACT_DETAILS_TEXT.current);
      return EXIT_OK;
    }
    output.printError(
      outcome.reason === 'rotation_pending'
        ? CONTACT_DETAILS_TEXT.pending
        : CONTACT_DETAILS_TEXT.failed,
    );
    return EXIT_FAILED;
  } finally {
    await agent.close();
  }
}
