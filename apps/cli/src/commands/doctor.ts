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
import { hasUnfinishedOwnerCodeChange } from '@4thtech-io/node';
import { listAgentNames, readAgentConfig } from '../runtime/agent-dir.js';
import { isAgentName } from '../runtime/agent-name.js';
import { terminalOneLine } from '../terminal/sanitize.js';
import { copy, renderCopy } from '../tools/strings/index.js';
import { TEXT, createDeps, fill, fixedErrorText, printAll, type CommandDeps } from './shared.js';

/** D-100: the rules line (11 §5: "rules", never "policy", except in the command itself). */
const DOCTOR_RULES_OK = 'OK       Your rules are in use';
const DOCTOR_RULES_FAIL_CLOSED =
  "Problem  Your rules can't be used, so AgentLink uses its strictest settings\n         In a terminal you opened yourself, run `agentlink policy recover` to review and confirm them again.";

/** True when another local agent on this machine has a stored card (never reads a secret). */
async function otherAgentHasCard(deps: CommandDeps, except: string): Promise<boolean> {
  const names = await listAgentNames(deps.home).catch(() => [] as string[]);
  for (const name of names) {
    if (name === except || !isAgentName(name)) continue;
    const other = await deps.open(name).catch(() => undefined);
    if (other === undefined || other.status !== 'ok') continue;
    try {
      if ((await other.agent.client.identity.get().catch(() => undefined)) !== undefined) {
        return true;
      }
    } finally {
      await other.agent.close();
    }
  }
  return false;
}

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

      // M1-9z (IR-M1-9z-1 F2): a leftover owner code change; `owner change-code` finishes it.
      if (deps.unfinishedOwnerCodeChange !== undefined) {
        if (await deps.unfinishedOwnerCodeChange().catch(() => false)) {
          emit(TEXT.doctorOwnerCodeUnfinished, true);
        }
      }

      // M1-9u: the agent exists but no owner card is stored for it. Read from the agent's own store
      // (no KeyStore secret); the later checks would only fail in confusing ways.
      const view = await agent.client.identity.get().catch(() => undefined);
      if (view === undefined) {
        emit(
          copy('cli.doctor.noOwnerCard', {
            agent: isAgentName(agent.name) ? agent.name : '<name>',
          }),
          true,
        );
        await agent.close();
        if (!(await otherAgentHasCard(deps, agent.name))) {
          emit(copy('cli.doctor.noOwnerCardNoOthers'));
        }
        return EXIT_FAILED;
      }

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

      // D-100 (06 §8): rules that fail closed (G-6) name the deliberate way back. Fixed text only:
      // never the kind's code or anything from the stored rules. A runtime without the loader
      // shows nothing here.
      const rules = await Promise.resolve()
        .then(() => client.ownerActions.loadPolicy())
        .catch(() => undefined);
      if (rules !== undefined) {
        emit(
          rules.mode === 'fail_closed' ? DOCTOR_RULES_FAIL_CLOSED : DOCTOR_RULES_OK,
          rules.mode === 'fail_closed',
        );
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

export const doctorHandler: CommandHandler = createDoctorHandler(
  createDeps({ unfinishedOwnerCodeChange: hasUnfinishedOwnerCodeChange }),
);
