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
  /** An approval ID failed its exact pattern (04 §2.4.1). */
  | 'approval_id_invalid';

export const RUNTIME_MESSAGES: Readonly<Record<RuntimeErrorCode, string>> = Object.freeze({
  get agent_name_invalid(): string {
    return `That agent name isn't valid. Agent names use lower-case letters, digits and -, start with a letter and have at most 32 characters. Check the name, or run \`${commandPrefix()} init --agent <name>\` yourself to create one.`;
  },
  get agent_config_invalid(): string {
    return `This agent's local settings are damaged. Run \`${commandPrefix()} doctor\` in your own terminal to see how to fix them.`;
  },
  get agent_path_invalid(): string {
    return `This agent's folder under ~/.agentlink must be a private folder of yours, with no links, readable only by you. Run \`${commandPrefix()} doctor\` in your own terminal to see how to fix it.`;
  },
  agent_exists:
    'An agent with this name is already set up on this machine. AgentLink never replaces it. Choose another name with --agent.',
  get agent_open_failed(): string {
    return `AgentLink couldn't open this agent on this machine. Run \`${commandPrefix()} doctor\` in your own terminal to see why.`;
  },
  approval_id_invalid: "That approval ID isn't valid. Check it and try again.",
});

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  constructor(code: RuntimeErrorCode) {
    super(RUNTIME_MESSAGES[code]);
    this.name = 'RuntimeError';
    this.code = code;
  }
}
