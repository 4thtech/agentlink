// `agentlink policy` † (M1-9m). RED stub: the tests in test/policy-command.test.ts describe it.
import { DISPATCH_TEXT, EXIT_FAILED, type CommandHandler } from '../../dispatch.js';
import type { OwnerCommandDeps } from './deps.js';

export interface PolicyCommandOptions {
  /** The home folder `~` stands for. Default: the OS user's. */
  readonly home?: string;
}

export function policyHandler(
  _deps: OwnerCommandDeps,
  _options: PolicyCommandOptions = {},
): CommandHandler {
  return ({ output }) => {
    output.printError(DISPATCH_TEXT.notAvailable);
    return Promise.resolve(EXIT_FAILED);
  };
}
