// `agentlink doctor` (M1-9l; 06 §8; 07 §9.4; 11 §6.10): one line per subsystem with a status word
// and the fix. M1-9l covers the agent's keys, its KeyStore backend and warnings, its own relays,
// message-network reachability and whether it can sign; `ui`, `credits`, `verify` and the payment
// network and storage checks are M1-9h.
//
// Reachability uses the same fetch-only `catchUp` as `status`: it stores raw envelopes and processes
// nothing. Every line is fixed text or a count; no path, agent name, account name or error text is
// printed (I-5, I-7), only the fixed sentences of the runtime and of node (07 §9.4).
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  DISPATCH_TEXT,
  type CommandHandler,
} from '../dispatch.js';
import { readAgentConfig } from '../runtime/agent-dir.js';
import { terminalOneLine } from '../terminal/sanitize.js';
import { copy, renderCopy } from '../tools/strings/index.js';
import { TEXT, createDeps, fill, fixedErrorText, printAll, type CommandDeps } from './shared.js';

export function createDoctorHandler(deps: CommandDeps = createDeps()): CommandHandler {
  return async (context) => {
    if (context.parsed.positionals.length > 0) {
      context.output.printError(DISPATCH_TEXT.badArguments);
      return EXIT_USAGE;
    }
    let problems = 0;
    const emit = (text: string, problem = false): void => {
      if (problem) problems += 1;
      printAll(context, text.split('\n'));
    };

    let opened;
    try {
      opened = await deps.open(context.parsed.agent);
    } catch (error) {
      const text = fixedErrorText(error);
      emit(
        text === undefined ? TEXT.doctorOpenFailed : fill(TEXT.doctorNoAgent, { message: text }),
        true,
      );
      return EXIT_FAILED;
    }
    if (opened.status === 'needs_setup') {
      emit(
        fill(opened.reason === 'no_agent' ? TEXT.doctorNoAgent : TEXT.doctorNoKeychain, {
          message: terminalOneLine(opened.message),
        }),
        true,
      );
      if (opened.fix !== undefined)
        emit(fill(TEXT.doctorFix, { fix: terminalOneLine(opened.fix) }));
      return EXIT_FAILED;
    }

    const { agent } = opened;
    try {
      emit(copy('cli.doctor.keysFound'));

      const config = await readAgentConfig(deps.home, agent.name).catch(() => undefined);
      if (config !== undefined) {
        emit(config.config.keyStore === 'keychain' ? TEXT.doctorKeychain : TEXT.doctorFile);
      }

      const { client } = agent;
      try {
        const relays = (await client.identity.signedCard()).relays.length;
        emit(
          relays === 0 ? TEXT.doctorNoRelays : renderCopy(TEXT.doctorRelays, { count: relays }),
          relays === 0,
        );
      } catch {
        emit(TEXT.doctorNoRelays, true);
      }

      try {
        const caught = await client.catchUp({ budgetMs: 3_000 });
        emit(caught.partial ? TEXT.doctorPartial : copy('cli.doctor.networkOk'));
      } catch {
        emit(copy('cli.doctor.networkDown'), true);
      }

      try {
        const state = await client.identity.sendState();
        emit(state === 'ready' ? TEXT.doctorSend : TEXT.doctorSendBlocked, state !== 'ready');
      } catch {
        emit(TEXT.doctorSendBlocked, true);
      }

      // Keychain hygiene (IR-M1-8a-1 L-10): offered only when the runtime can list the items.
      if (deps.strayItems !== undefined) {
        const count = await deps.strayItems.count(agent.agentId).catch(() => 0);
        if (count > 0) {
          emit(renderCopy(TEXT.doctorStray, { count }));
          const prompter = deps.prompter();
          try {
            emit(TEXT.doctorStrayAsk);
            const answer = await prompter.ask();
            if (answer?.trim().toLowerCase() === 'y') {
              const removed = await deps.strayItems.remove(agent.agentId).catch(() => 0);
              emit(fill(TEXT.doctorStrayRemoved, { count: removed }));
            }
          } finally {
            prompter.close();
          }
        }
      }
      context.output.print('');
      context.output.print(TEXT.doctorNotChecked);
    } finally {
      await agent.close();
    }
    return problems === 0 ? EXIT_OK : EXIT_FAILED;
  };
}

export const doctorHandler: CommandHandler = createDoctorHandler();
