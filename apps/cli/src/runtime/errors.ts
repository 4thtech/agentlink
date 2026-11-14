// Errors of the CLI runtime (M1-9k). Every message is a fixed sentence that says how to fix the
// problem. No agent name, path, config text, approval ID or inbound content is ever interpolated, and
// no underlying error is attached as `cause` (I-5, I-7). Callers branch on `code`.

import { commandPrefix } from './cli-prefix.js';

export type RuntimeErrorCode =
  /** The agent name is not a valid local agent name (06 §6). */
  | 'agent_name_invalid'
  /** The agent's config file is missing a field, has an unknown one, or is not the agent's own. */
  | 'agent_config_invalid'
  /**
   * A folder or file under `~/.agentlink` breaks the folder rules: a link, the wrong file type, group
   * or other access, another owner, or a realpath outside `~/.agentlink/agents` (IR-M1-9k-1 F02).
   */
  | 'agent_path_invalid'
  /** `init` found an agent with this name already; it is never replaced unless asked (F03). */
  | 'agent_exists'
  /** The agent's store or keys could not be opened. */
  | 'agent_open_failed'
  /** U3-c (06 §6): an agent label breaks the label rule. */
  | 'agent_label_invalid'
  /** An approval ID failed its exact pattern (04 §2.4.1). */
  | 'approval_id_invalid'
  /** WIN-BROKEN-ID: the ID's key is here (or it is not a keychain ID); it is not set aside. */
  | 'agent_not_broken'
  /** WIN-BROKEN-ID: the folder was set aside but some of the ID's leftover keys stayed. */
  | 'agent_keys_left';

export const RUNTIME_MESSAGES: Readonly<Record<RuntimeErrorCode, string>> = Object.freeze({
  get agent_name_invalid(): string {
    return `That ID name isn't valid. ID names use lower-case letters, digits and -, start with a letter and have at most 32 characters. Check the name, or run \`${commandPrefix()} init --agent <name>\` yourself to create one.`;
  },
  get agent_config_invalid(): string {
    return `This ID's local settings are damaged. Run \`${commandPrefix()} doctor\` in your own terminal to see how to fix them.`;
  },
  get agent_path_invalid(): string {
    return `This ID's folder under ~/.agentlink must be a private folder of yours, with no links, readable only by you. Run \`${commandPrefix()} doctor\` in your own terminal to see how to fix it.`;
  },
  agent_exists:
    'An ID with this name is already set up on this machine. AgentLink never replaces it. Choose another name with --id.',
  get agent_open_failed(): string {
    return `AgentLink couldn't open this ID on this machine. Run \`${commandPrefix()} doctor\` in your own terminal to see why.`;
  },
  agent_label_invalid:
    'Use letters, digits, spaces, dots, apostrophes and hyphens, up to 32 characters.',
  approval_id_invalid: "That approval ID isn't valid. Check it and try again.",
  agent_not_broken:
    'This ID can be opened on this computer, so it was not moved. Nothing was changed.',
  agent_keys_left:
    "AgentLink moved this ID's folder aside, but couldn't remove all of its leftover keys. Try again.",
});

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  constructor(code: RuntimeErrorCode) {
    super(RUNTIME_MESSAGES[code]);
    this.name = 'RuntimeError';
    this.code = code;
  }
}
