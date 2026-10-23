// M1-9zd: the reminder before every owner code prompt (11 §5.5, §6.10). The owner code is read by
// @4thtech-io/node's own TTY prompt inside the steps below; this module only prints fixed text
// before each of them and never sees the code (I-1). Every owner command gets its deps through
// `ownerStep` (common.ts), which applies this, so no owner command can prompt without it.
import type { Output } from '../../output.js';
import type { OwnerCommandDeps } from './deps.js';
import { OWNER_TEXT } from './strings.js';

/** `deps` with the reminder printed right before each step that prompts for the owner code. */
export function withOwnerPrompts(deps: OwnerCommandDeps, output: Output): OwnerCommandDeps {
  const hint = (): void => {
    output.print(OWNER_TEXT.codeHint);
  };
  return Object.freeze<OwnerCommandDeps>({
    ...deps,
    initOwner: (options) => {
      // When the card already names an owner, node refuses before it shows or asks anything.
      if (options.cardOwner === undefined) output.print(OWNER_TEXT.newCodeHint);
      return deps.initOwner(options);
    },
    addAgent: (options) => {
      hint();
      return deps.addAgent(options);
    },
    changeOwnerCode: (options) => {
      hint();
      return deps.changeOwnerCode(options);
    },
    decide: (context, reviewed) => {
      hint();
      return deps.decide(context, reviewed);
    },
    signOwnerAction: (owner, item) => {
      hint();
      return deps.signOwnerAction(owner, item);
    },
  });
}
