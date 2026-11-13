// Stub: Invite landing page. The real implementation lands with its backlog task.
export const packageName = '@4thtech-io/invite';

// The install-and-accept prompt, for the e2e tests through the package entry (boundary policy).
export { INSTALL_AND_ACCEPT_TEMPLATE, buildPrompt } from './prompt.js';
// U3-invite: the page's one step (08 §4), for the browser tests.
export {
  ASK_AI_TEMPLATE,
  INSTALL_PS1_TEMPLATE,
  INSTALL_SH_TEMPLATE,
  JOIN_COMMAND_TEMPLATE,
  MAX_COMMAND_CHARS,
  buildAskAi,
  buildCommands,
  buildJoinCommand,
  type InviteCommands,
} from './prompt.js';
// REL051-INV: the page's fixed outside links and release switch, for the site and browser tests.
export {
  DOCS_LINKS,
  MAC_APP_AVAILABLE,
  MAC_APP_URLS,
  WIN_APP_AVAILABLE,
  WIN_APP_URL,
} from './config.js';
