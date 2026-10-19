// The owner commands † of M1-9b: `owner init`, `approve` (one request, or one agent's list),
// `deny` and `cancel`; and `policy` (M1-9m). The dispatcher (M1-9k) runs the owner-terminal guard (TTY, no harness marker)
// before any of these handlers; owner presence is the owner code at @4thtech-io/node's TTY prompt.
import type { CommandHandler, CommandName } from '../../dispatch.js';
import { approveHandler, denyHandler } from './approve.js';
import { cancelHandler } from './cancel.js';
import { nodeOwnerDeps, type OwnerCommandDeps } from './deps.js';
import { ownerHandler } from './owner-init.js';
import { policyHandler } from './policy.js';

export { nodeOwnerDeps, type OwnerAgent, type OwnerCommandDeps } from './deps.js';
export { contactsManageHandler } from './contacts-manage.js';
export { policyHandler, type PolicyCommandOptions } from './policy.js';
export { PROVISIONAL_CARD_RELAYS } from './card-relays.js';

/** The handlers to register with createDispatcher. */
export function ownerCommandHandlers(
  deps: OwnerCommandDeps = nodeOwnerDeps(),
): Partial<Record<CommandName, CommandHandler>> {
  return {
    owner: ownerHandler(deps),
    approve: approveHandler(deps),
    deny: denyHandler(deps),
    cancel: cancelHandler(deps),
    // M1-9m: the owner's rules (allowed folders for sending files).
    policy: policyHandler(deps),
  };
}
