// The fixed text for a core that says it could not start (`stopped` with a start-failure reason;
// D2 open question 4). The supervisor stops restarting; the window's status page (status-page.ts)
// shows this text with Try again and Open log folder (11 §5 plain words). Nothing from the core or
// the environment is inserted into the text.
import type { StartFailureReason } from '../shared/protocol.js';

export const START_FAILURE_TEXT: Readonly<Record<StartFailureReason, string>> = Object.freeze({
  no_owner: "AgentLink isn't set up on this computer yet, so it couldn't start.",
  no_ids: "AgentLink couldn't open the page to make your first ID.",
  only_removing: "Some of your IDs were only half removed, so AgentLink couldn't start.",
  keychain: "AgentLink couldn't reach this computer's keychain, so it couldn't start.",
  open: "AgentLink couldn't open its page.",
});
