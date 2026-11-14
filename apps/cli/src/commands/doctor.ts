// `agentlink doctor` (M1-9l; 06 §8; 07 §9.4; 11 §6.10): one line per subsystem with a status word
// and the fix. M1-9l covers the agent's keys, its KeyStore backend and warnings, its own relays,
// message-network reachability and whether it can sign. M1-9h adds the proof network check (06 §8
// "RPC"): one block-number read per automatically selectable chain, within a short budget, through
// the address-checked RPC fetch (04 §4). Only a count is printed: never a network name, a URL or
// error text. The storage check waits for its spec (the drop has no health read yet).
//
// Reachability uses the same fetch-only `catchUp` as `status`: it stores raw envelopes and processes
// nothing. Every line is fixed text or a count; no path, agent name, account name or error text is
// printed (I-5, I-7), only the fixed sentences of the runtime and of node (07 §9.4).
import { commandPrefix } from '../runtime/cli-prefix.js';
import process from 'node:process';
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  DISPATCH_TEXT,
  type CommandHandler,
} from '../dispatch.js';
import * as chain from '@4thtech-io/chain';
import {
  hasOwnerOnMachine,
  hasUnfinishedOwnerCodeChange,
  NodeKeyStoreError,
  NodeStoreError,
  nodeRpcFetch,
  restoreHoldHere,
} from '@4thtech-io/node';
import { listAgentNames, readAgentConfig } from '../runtime/agent-dir.js';
import { localDoctorChecks, type LocalChecks } from './doctor-local.js';
import { isAgentName } from '../runtime/agent-name.js';
import { RuntimeError } from '../runtime/errors.js';
import { AGENT_PAUSED_TEXT, CoreError } from '@4thtech-io/core';
import { terminalOneLine, terminalSentence } from '../terminal/sanitize.js';
import { copy, renderCopy } from '@4thtech-io/mcp-tools/strings/index.js';
import { TEXT, agentPausedNow, createDeps, fill, printAll, type CommandDeps } from './shared.js';

/**
 * D-100: the rules line (11 §5: "rules", never "policy", except in the command itself). M1-36e: the
 * command starts with the bare `agentlink` (the installer adds it).
 */
export const DOCTOR_TEXT = Object.freeze({
  rulesOk: 'OK       Your rules are in use',
  /** Plain `doctor`: one block per ID on this computer. */
  idHeader: 'ID: {label}',
  apps: 'AI apps: {apps}',
  noApps: 'AI apps: none connected',
  idOk: 'OK       {label} is working',
  idProblem: 'Problem  {label} has a problem (see above)',
  /** W8-FEEDBACK-S1 (F8): there is an owner on this computer but no ID yet. */
  get noIdsYet(): string {
    return `Problem  You have no IDs yet. Open AgentLink to create one: run \`agentlink\`.`;
  },
  /** UX1113-R1 (04 §2.3.3): a restore stopped between the IDs and the owner. */
  get restoreUnfinished(): string {
    return `Problem  A restore didn't finish: your IDs are back, but not their owner\n         Run \`${commandPrefix()} restore\` with the same recovery kit, or choose the kit again in the app.`;
  },
  /** UX1113-R1 (fail closed): the keychain did not answer, so first run is held. */
  keychainUnanswered:
    "Problem  AgentLink couldn't check this computer's keychain. Try again.\n         Unlock the keychain if it asks, then run doctor again.",
  get rulesFailClosed(): string {
    return `Problem  Your rules can't be used, so AgentLink uses its strictest settings\n         In a terminal you opened yourself, run \`${commandPrefix()} policy recover\` to review and confirm them again.`;
  },
});

/** M1-33a (06 §3, D-109; decided by Tali in chat, 2026-10-20): the exact line, after a status word. */
export const DOCTOR_RECEIPTS_OLDER_DEFAULT =
  'Warning  Delivery receipts are on from an older default; they will turn off unless you keep them.';

/** M1-9h: how long `doctor` waits for each proof network. */
export const DOCTOR_PROOF_BUDGET_MS = 4_000;

/** The proof network check: how many shipped networks answered, out of how many. */
export type ProofNetworkCheck = () => Promise<{
  readonly answered: number;
  readonly total: number;
}>;

export interface DoctorDeps extends CommandDeps {
  /** Absent: the line is not printed (tests of other subsystems). */
  readonly proofNetwork?: ProofNetworkCheck;
  /**
   * F8: true when an owner is set up on this computer (store-only: reads no secret). Absent: the
   * "no IDs yet" line is never chosen and doctor keeps its set-up line.
   */
  readonly ownerOnMachine?: () => Promise<boolean>;
  /** R1: the local checks (last exit, leftover host note, half-removed IDs, AI apps). Absent: none. */
  readonly local?: () => Promise<LocalChecks>;
  /**
   * UX1113-R1 (04 §2.3.3, T-7): true when restored IDs wait for their owner (a restore stopped
   * between the IDs and the owner). Store-only. Absent: the line is never printed.
   */
  readonly restoreHold?: () => Promise<'finish_restore' | 'keychain_unavailable' | undefined>;
}

/** M1-9h doctor lines (11 §5: "public record", never chain, RPC or a network name). */
export const DOCTOR_PROOF_TEXT = Object.freeze({
  ok: 'OK       The public record answers, so proofs can be added and checked',
  get partial(): string {
    return `Warning  Part of the public record did not answer\n         Proofs still work where it answers. Check your connection and try again later.`;
  },
  down: "Problem  The public record can't be reached\n         Proofs can't be added or checked right now; messages and files still work. Check your connection.",
  none: 'Problem  This version of AgentLink has no public record to add proofs to\n         Update AgentLink.',
  notChecked: "File storage isn't checked yet.",
});

/** The default check: one `eth_blockNumber` per automatically selectable chain, in parallel. */
export function nodeProofNetworkCheck(
  options: {
    readonly fetchFn?: chain.RpcFetchFn;
    readonly configs?: readonly chain.ChainConfig[];
  } = {},
): ProofNetworkCheck {
  return async () => {
    const configs = options.configs ?? chain.autoSelectableChains();
    const fetchFn = options.fetchFn ?? nodeRpcFetch();
    const results = await Promise.all(
      configs.map(async (config) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const client = chain.createReadClient(config, { fetchFn });
          const timeout = new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), DOCTOR_PROOF_BUDGET_MS);
            (timer as { unref?: () => void }).unref?.();
          });
          return await Promise.race([
            client.getBlockNumber().then(
              (n) => typeof n === 'bigint' && n > 0n,
              () => false,
            ),
            timeout,
          ]);
        } catch {
          return false;
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }),
    );
    return { answered: results.filter(Boolean).length, total: configs.length };
  };
}

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

export function createDoctorHandler(deps: DoctorDeps = createDeps()): CommandHandler {
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

    // R1: these read only local files, so they come first and also help when no ID can be opened.
    const local = await deps.local?.().catch(() => undefined);
    if (local !== undefined) {
      for (const line of local.lines) emit(line);
      problems += local.problems;
    }
    // UX1113-R1: an unfinished restore is named before anything tries to open an ID.
    const hold = await deps.restoreHold?.().catch(() => 'keychain_unavailable' as const);
    if (hold === 'finish_restore') emit(DOCTOR_TEXT.restoreUnfinished, true);
    if (hold === 'keychain_unavailable') emit(DOCTOR_TEXT.keychainUnanswered, true);

    /** One ID's checks (`name` undefined: the default ID). True when it stopped early on a problem. */
    const checkOne = async (
      name: string | undefined,
      withProofNetwork: boolean,
    ): Promise<boolean> => {
      let opened;
      try {
        opened = await deps.open(name);
      } catch (error) {
        // WIN-BROKEN-ID: the whole fixed sentence (never cut at 128); a missing key names the fix.
        const shown = name ?? 'default';
        const label = await readAgentConfig(deps.home, shown)
          .then((found) => found?.config.label ?? shown)
          .catch(() => shown);
        const lines = doctorOpenProblem(error, label);
        emit(lines === undefined ? TEXT.doctorOpenFailed : lines.join('\n'), true);
        return true;
      }
      if (opened.status === 'needs_setup') {
        // F8: an owner and no ID at all is not "not set up": the next step is to open AgentLink.
        if (
          opened.reason === 'no_agent' &&
          deps.ownerOnMachine !== undefined &&
          (await deps.ownerOnMachine().catch(() => false)) &&
          (await listAgentNames(deps.home).catch(() => ['?'] as string[])).length === 0
        ) {
          emit(DOCTOR_TEXT.noIdsYet, true);
          return true;
        }
        emit(
          fill(opened.reason === 'no_agent' ? TEXT.doctorNoAgent : TEXT.doctorNoKeychain, {
            message: terminalOneLine(opened.message),
          }),
          true,
        );
        if (opened.fix !== undefined)
          emit(fill(TEXT.doctorFix, { fix: terminalOneLine(opened.fix) }));
        return true;
      }

      const { agent } = opened;
      try {
        emit(copy('cli.doctor.keysFound'));

        // M1-9z (IR-M1-9z-1 F2): a leftover master code change; `owner change-code` finishes it.
        if (deps.unfinishedOwnerCodeChange !== undefined) {
          if (await deps.unfinishedOwnerCodeChange().catch(() => false)) {
            emit(TEXT.doctorOwnerCodeUnfinished, true);
          }
        }

        // M1-9u: the agent exists but no owner card is stored for it. Read from the agent's own store
        // (no KeyStore secret); the later checks would only fail in confusing ways.
        const view = await agent.client.identity.get().catch(() => undefined);
        if (view === undefined) {
          emit(copy('cli.doctor.noOwnerCard', { prefix: 'agentlink' }), true);
          await agent.close();
          if (!(await otherAgentHasCard(deps, agent.name))) {
            emit(copy('cli.doctor.noOwnerCardNoOthers', { prefix: 'agentlink' }));
          }
          return true;
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

        if (await agentPausedNow(client)) {
          // W4-PAUSE (06 §6): a paused agent fetches nothing, so the network is not checked.
          emit(TEXT.statusPaused);
        } else {
          try {
            const caught = await client.catchUp({ budgetMs: 3_000 });
            emit(caught.partial ? TEXT.doctorPartial : copy('cli.doctor.networkOk'));
          } catch {
            emit(copy('cli.doctor.networkDown'), true);
          }
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
            rules.mode === 'fail_closed' ? DOCTOR_TEXT.rulesFailClosed : DOCTOR_TEXT.rulesOk,
            rules.mode === 'fail_closed',
          );
          // M1-33a (06 §3 "Existing policies", D-109): a notice, not a problem. A runtime that can't
          // tell shows nothing.
          if (rules.mode === 'signed') {
            const older = await Promise.resolve()
              .then(() => client.ownerActions.receiptsOnFromOlderDefault())
              .catch(() => false);
            if (older) emit(DOCTOR_RECEIPTS_OLDER_DEFAULT);
          }
        }

        // M1-9h: the proof network (06 §8 "RPC"). Counts only (I-7).
        if (deps.proofNetwork !== undefined && withProofNetwork) {
          const reach = await deps.proofNetwork().catch(() => ({ answered: 0, total: 1 }));
          if (reach.total === 0) emit(DOCTOR_PROOF_TEXT.none, true);
          else if (reach.answered === reach.total) emit(DOCTOR_PROOF_TEXT.ok);
          else if (reach.answered > 0) emit(DOCTOR_PROOF_TEXT.partial);
          else emit(DOCTOR_PROOF_TEXT.down, true);
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
      } finally {
        await agent.close();
      }
      return false;
    };

    // Plain `doctor` (no --agent): every ID on this computer, by display name, with its AI apps and
    // one OK/Problem line; the checks of one ID are the same as with --agent.
    const all = context.parsed.agent === undefined ? local?.ids : undefined;
    let failed = false;
    if (all !== undefined && all.length > 0) {
      let first = true;
      for (const id of all) {
        const before = problems;
        const label = terminalOneLine(id.label);
        context.output.print('');
        context.output.print(fill(DOCTOR_TEXT.idHeader, { label }));
        context.output.print(
          id.apps.length === 0
            ? DOCTOR_TEXT.noApps
            : fill(DOCTOR_TEXT.apps, { apps: id.apps.map((a) => terminalOneLine(a)).join(', ') }),
        );
        const stopped = await checkOne(id.name, first);
        first = false;
        failed = failed || stopped;
        const bad = stopped || problems > before;
        emit(fill(bad ? DOCTOR_TEXT.idProblem : DOCTOR_TEXT.idOk, { label }), false);
      }
    } else {
      failed = await checkOne(context.parsed.agent, true);
      if (failed) return EXIT_FAILED;
    }
    context.output.print('');
    context.output.print(DOCTOR_PROOF_TEXT.notChecked);
    return problems === 0 && !failed ? EXIT_OK : EXIT_FAILED;
  };
}

export const doctorHandler: CommandHandler = createDoctorHandler({
  ...createDeps({ unfinishedOwnerCodeChange: hasUnfinishedOwnerCodeChange }),
  proofNetwork: nodeProofNetworkCheck(),
  ownerOnMachine: hasOwnerOnMachine,
  restoreHold: restoreHoldHere,
  local: () => localDoctorChecks({ env: process.env }),
});

/**
 * WIN-BROKEN-ID: doctor's lines for an ID that would not open, or undefined when the error is not one
 * of AgentLink's fixed sentences (doctor then prints its own). A missing key (`identity_missing`) is a
 * Problem line naming the ID and a Fix line naming the app (11 §5: "its key", no keychain jargon);
 * any other fixed sentence is printed whole (terminalSentence), never cut with `…`.
 */
export function doctorOpenProblem(error: unknown, label: string): string[] | undefined {
  if (isFixedError(error) && (error as { code?: unknown }).code === 'identity_missing') {
    return [
      `Problem  ID "${terminalOneLine(label)}" can't be opened: its key isn't on this computer.`,
      '         Open AgentLink to restore it from a backup or remove it from this computer.',
    ];
  }
  if (!isFixedError(error)) return undefined;
  if (error instanceof CoreError && error.code === 'agent_paused') {
    return [fill(TEXT.doctorNoAgent, { message: AGENT_PAUSED_TEXT })];
  }
  return [fill(TEXT.doctorNoAgent, { message: terminalSentence(error.message) })];
}

function isFixedError(error: unknown): error is Error {
  return (
    error instanceof CoreError ||
    error instanceof RuntimeError ||
    error instanceof NodeKeyStoreError ||
    error instanceof NodeStoreError
  );
}
