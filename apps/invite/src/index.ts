// Stub: Invite landing page. The real implementation lands with its backlog task.
export const packageName = '@4thtech-io/invite';

// The install-and-accept prompt, for the e2e tests through the package entry (boundary policy).
export { INSTALL_AND_ACCEPT_TEMPLATE, buildPrompt } from './prompt.js';
// U3-invite: the page's one step (08 §4), for the browser tests.
export {
  ASK_AI_TEMPLATE,
  JOIN_COMMAND_TEMPLATE,
  MAX_COMMAND_CHARS,
  buildAskAi,
  buildJoinCommand,
} from './prompt.js';
export { NODE_DOWNLOAD_URL } from './strings.js';
