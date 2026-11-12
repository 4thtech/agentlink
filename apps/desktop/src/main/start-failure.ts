// What the shell shows when the core says it could not start (`stopped` with a start-failure
// reason; D2 open question 4). The supervisor stops restarting; this shows ONE fixed message for the
// reason (11 §5 plain words). Retrying is only from the tray ("Try again"). Nothing from the core or
// the environment is inserted into the text.
import type { Dialog } from './electron-api.js';
import type { StartFailureReason } from '../shared/protocol.js';

export const START_FAILURE_TEXT: Readonly<Record<StartFailureReason, string>> = Object.freeze({
  no_owner: "AgentLink isn't set up on this computer yet, so it couldn't start.",
  no_ids: "AgentLink couldn't open the page to make your first ID.",
  only_removing: "Some of your IDs were only half removed, so AgentLink couldn't start.",
  keychain: "AgentLink couldn't reach this computer's keychain, so it couldn't start.",
  open: "AgentLink couldn't open its page.",
});

export const START_FAILURE_TITLE = "AgentLink couldn't start";
export const START_FAILURE_DETAIL =
  'Run `agentlink doctor` in your own terminal to see why, then choose Try again in the AgentLink menu.';
export const START_FAILURE_BUTTONS = ['OK'] as const;

/** Shows the fixed message once. */
export async function showStartFailure(dialog: Dialog, reason: StartFailureReason): Promise<void> {
  try {
    await dialog.showMessageBox({
      type: 'error',
      title: START_FAILURE_TITLE,
      message: START_FAILURE_TEXT[reason],
      detail: START_FAILURE_DETAIL,
      buttons: [...START_FAILURE_BUTTONS],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
  } catch {
    // Nothing else to show; the tray still says "Not running".
  }
}
