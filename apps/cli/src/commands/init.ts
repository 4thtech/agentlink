// `agentlink init [--agent <name>] [--confirm <code>]` (M1-9a; 06 §7, 07 §9.1, §9.4; D-39, D-54,
// D-73 (7)): the agent's identity in the OS keychain and the `agentlink` MCP entry in each detected
// harness (Claude Code, Codex, Gemini CLI).
//
// Nothing is written before the user has seen the exact diff of each config file and agreed:
//
// - Interactive terminal, no harness marker: the diff of each harness, then a y/N prompt for each.
// - Run by an agent (no TTY, or a harness marker set): the diff and a one-time confirmation code are
//   printed and nothing is written. The code is a hash of exactly the changes shown (and the agent
//   name), so it only matches while those changes are still the proposed ones; once they are applied
//   the code no longer matches anything. `init --confirm <code>` then writes. This is transparency,
//   not a security boundary: a shell-capable agent could edit its harness config anyway (06 §7).
//
// No OS keychain: `needs_setup` with the 07 §9.4 copy, and nothing is written (the file KeyStore,
// `init --keystore file`, waits for M1-8f and is not registered, D-73 (4)). The owner key is not
// created here (`agentlink owner init`, M1-9b), and `init` never prints or accepts an owner secret.
// An existing agent is reused and never replaced, so `init` can be re-run to add another harness.
// All key creation is `@agentlink/node`'s (`createOsKeychainAgent`); nothing here is crypto, apart
// from hashing the proposed changes into the confirmation code.
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { encodeHex, sha256 } from '@agentlink/crypto';
import { createOsKeychainAgent, probeOsKeychain, selectKeyStoreBackend } from '@agentlink/node';
import type { KeychainProbe } from '@agentlink/node';
import {
  DISPATCH_TEXT,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  type CommandContext,
  type CommandHandler,
} from '../dispatch.js';
import {
  HARNESS_MESSAGES,
  HarnessError,
  applyHarness,
  detectHarnesses,
  planHarness,
  type HarnessContext,
  type HarnessPlan,
} from '../harness/index.js';
import {
  DEFAULT_AGENT_NAME,
  RUNTIME_MESSAGES,
  RuntimeError,
  isAgentName,
  readAgentConfig,
  writeAgentConfig,
} from '../runtime/index.js';
import { checkOwnerTerminal } from '../runtime/guards.js';
import { sanitizeTerminalText } from '../terminal/sanitize.js';
import { copy } from '../tools/strings/index.js';

/** The Node pieces `init` uses. Tests pass doubles; production uses `nodeInitDeps()`. */
export interface InitDeps {
  readonly home: string;
  readonly probeKeychain: () => Promise<KeychainProbe>;
  /** Creates a new agent in the keychain and returns its agent ID (04 §2.9). */
  readonly createAgent: () => Promise<string>;
  /** Reads one answer line from the terminal (the question is printed by the handler). */
  readonly readLine: () => Promise<string>;
  /** Unix seconds. */
  readonly clock: () => number;
  readonly platform?: NodeJS.Platform;
  /** Who must own the config folders and files (tests only). */
  readonly uid?: number;
}

export function nodeInitDeps(): InitDeps {
  return {
    home: homedir(),
    probeKeychain: () => probeOsKeychain(),
    createAgent: () => createOsKeychainAgent(),
    readLine: async () => {
      // No `output`: the question is printed through the CLI's output channel (src/output.ts).
      const rl = createInterface({ input: process.stdin });
      try {
        return await new Promise<string>((resolve) => {
          rl.once('line', resolve);
          rl.once('close', () => resolve(''));
        });
      } finally {
        rl.close();
      }
    },
    clock: () => Math.floor(Date.now() / 1000),
  };
}

/** Fixed text that has no entry in the copy sheet yet (no value from a file or the user is inserted). */
export const INIT_TEXT = Object.freeze({
  badCode:
    "That confirmation code isn't right. Run `agentlink init` again to see the changes and the code.",
  codeMismatch:
    "That confirmation code doesn't match the changes proposed now (they may have changed). Run `agentlink init` again to see them and the new code.",
  identity: "AgentLink will create this agent's identity and keep it in your system keychain.",
  identityDone: 'OK       Agent identity created',
  nothingToDo: 'OK AgentLink is already set up. Nothing to change.',
  present: 'OK       {appName} is already set up for AgentLink',
  conflict:
    '{appName} already has an entry named agentlink that is different, so AgentLink left it as it is. Nothing was changed there.',
  rerun: 'Then run: agentlink init{agentFlag} --confirm {code}',
  updated: 'OK       {appName} updated. Backup of the old file: {backup}',
  created: 'OK       {appName} set up',
  ownerStep:
    "One step left, and you must do it yourself: run `agentlink owner init` in your own terminal. Don't let your AI run it or see the code it shows. It's what stops any AI, including your own, from approving its own actions.",
  noAppsHere: "Problem  AgentLink didn't find Claude Code, Codex or Gemini CLI on this computer.",
});

const CODE_PATTERN = /^[0-9a-f]{4}-?[0-9a-f]{4}$/i;

type ChangePlan = Extract<HarnessPlan, { status: 'change' }>;

/** The code that binds `--confirm` to exactly the changes shown. */
function confirmationCode(
  name: string,
  createIdentity: boolean,
  changes: readonly ChangePlan[],
): string {
  const lines = [
    `agentlink-init-v1 ${name} ${createIdentity ? 'new' : 'existing'}`,
    ...changes.map((c) => `${c.def.id} ${encodeHex(sha256(new TextEncoder().encode(c.text)))}`),
  ];
  const digest = encodeHex(sha256(new TextEncoder().encode(lines.join('\n'))));
  return `${digest.slice(0, 4)}-${digest.slice(4, 8)}`;
}

const withApp = (text: string, appName: string): string => text.replaceAll('{appName}', appName);

function printPlan(
  context: CommandContext,
  plans: readonly HarnessPlan[],
  createIdentity: boolean,
): void {
  const { output } = context;
  if (plans.length > 0) {
    output.print(copy('cli.init.found', { count: plans.length }));
    for (const plan of plans) output.print(`  ${plan.def.appName}`);
  } else {
    output.print(INIT_TEXT.noAppsHere);
  }
  if (createIdentity) output.print(INIT_TEXT.identity);
  for (const plan of plans) {
    output.print('');
    switch (plan.status) {
      case 'change':
        output.print(copy('cli.init.changesFor', { appName: plan.def.appName }));
        // The diff holds text from the user's own file: sanitized like any printed value (06 §8).
        for (const line of plan.diff) output.print(sanitizeTerminalText(line));
        break;
      case 'present':
        output.print(withApp(INIT_TEXT.present, plan.def.appName));
        break;
      case 'conflict':
        output.print(withApp(INIT_TEXT.conflict, plan.def.appName));
        break;
      case 'blocked':
        output.printError(withApp(HARNESS_MESSAGES[plan.reason], plan.def.appName));
        break;
    }
  }
}

async function createIdentity(deps: InitDeps, name: string): Promise<void> {
  const agentId = await deps.createAgent();
  await writeAgentConfig(
    deps.home,
    { v: 1, name, agentId, keyStore: 'keychain' },
    {
      ...(deps.uid === undefined ? {} : { uid: deps.uid }),
    },
  );
}

/** The `init` command handler. */
export function createInitHandler(deps: InitDeps = nodeInitDeps()): CommandHandler {
  return async (context) => {
    const { output, parsed, terminal } = context;

    // Arguments: `--agent` is checked here too (the dispatcher already did), the code by its form.
    const name = parsed.agent ?? DEFAULT_AGENT_NAME;
    if (!isAgentName(name)) {
      output.printError(RUNTIME_MESSAGES.agent_name_invalid);
      return EXIT_USAGE;
    }
    const confirmValue = parsed.values['confirm'];
    if (
      parsed.positionals.length > 0 ||
      (confirmValue !== undefined && typeof confirmValue !== 'string')
    ) {
      output.printError(DISPATCH_TEXT.badArguments);
      return EXIT_USAGE;
    }
    if (typeof confirmValue === 'string' && !CODE_PATTERN.test(confirmValue)) {
      output.printError(INIT_TEXT.badCode);
      return EXIT_USAGE;
    }

    // 07 §9.1, §9.4: no usable keychain is `needs_setup`; nothing is written.
    const selection = selectKeyStoreBackend(await deps.probeKeychain(), { fileOptIn: false });
    if (!selection.ok) {
      if (selection.status !== 'needs_setup') throw new RuntimeError('agent_open_failed');
      output.printError(selection.message);
      if (selection.fix !== undefined) output.printError(selection.fix);
      return EXIT_FAILED;
    }

    const existing = await readAgentConfig(
      deps.home,
      name,
      deps.uid === undefined ? {} : { uid: deps.uid },
    );
    const needIdentity = existing === undefined;

    const harnessContext: HarnessContext = {
      home: deps.home,
      env: terminal.env,
      ...(deps.platform === undefined ? {} : { platform: deps.platform }),
      ...(name === DEFAULT_AGENT_NAME ? {} : { agent: name }),
      now: deps.clock(),
      ...(deps.uid === undefined ? {} : { uid: deps.uid }),
    };
    const detected = await detectHarnesses(harnessContext);
    const plans: HarnessPlan[] = [];
    for (const def of detected) plans.push(await planHarness(def, harnessContext));
    const changes = plans.filter((p): p is ChangePlan => p.status === 'change');
    const blocked = plans.some((p) => p.status === 'blocked');

    const code = confirmationCode(name, needIdentity, changes);
    const interactive = checkOwnerTerminal(terminal).ok && confirmValue === undefined;

    if (!needIdentity && changes.length === 0) {
      printPlan(context, plans, false);
      output.print(INIT_TEXT.nothingToDo);
      return blocked ? EXIT_FAILED : EXIT_OK;
    }

    // Nothing has been written yet. Show everything first (D-39).
    printPlan(context, plans, needIdentity);

    let approved: readonly ChangePlan[];
    let makeIdentity = needIdentity;
    if (interactive) {
      const yes: ChangePlan[] = [];
      for (const change of changes) {
        output.print('');
        output.print(copy('cli.init.apply'));
        const answer = await deps.readLine();
        if (/^\s*y(es)?\s*$/i.test(answer)) yes.push(change);
      }
      approved = yes;
      // The identity alone is created in a terminal the owner opened, when no app needs a change.
      makeIdentity = needIdentity && (yes.length > 0 || changes.length === 0);
      if (yes.length === 0 && changes.length > 0) {
        output.print(copy('cli.init.cancelled'));
        return blocked ? EXIT_FAILED : EXIT_OK;
      }
    } else if (confirmValue === undefined) {
      // Run by an agent: show the code and stop. Nothing is written.
      output.print('');
      output.print(copy('cli.init.agentConfirm', { code }));
      output.print(
        INIT_TEXT.rerun
          .replace('{agentFlag}', name === DEFAULT_AGENT_NAME ? '' : ` --agent ${name}`)
          .replace('{code}', code),
      );
      return blocked && changes.length === 0 && !needIdentity ? EXIT_FAILED : EXIT_OK;
    } else {
      if (confirmValue.replace('-', '').toLowerCase() !== code.replace('-', '')) {
        output.printError(INIT_TEXT.codeMismatch);
        return EXIT_FAILED;
      }
      approved = changes;
    }

    // Write: identity first (an existing agent is reused), then each confirmed harness.
    let failed = blocked;
    if (makeIdentity) {
      await createIdentity(deps, name);
      output.print(INIT_TEXT.identityDone);
    }
    const applied: string[] = [];
    for (const change of approved) {
      try {
        const { backup } = await applyHarness(change, harnessContext);
        output.print(
          withApp(
            backup === undefined
              ? INIT_TEXT.created
              : INIT_TEXT.updated.replace('{backup}', backup),
            change.def.appName,
          ),
        );
        applied.push(change.def.appName);
      } catch (error) {
        if (!(error instanceof HarnessError)) throw error;
        output.printError(withApp(HARNESS_MESSAGES[error.code], change.def.appName));
        failed = true;
      }
    }
    if (applied.length > 0) {
      output.print(copy('cli.init.done'));
      for (const appName of applied) output.print(copy('cli.init.restart', { appName }));
    }
    output.print(INIT_TEXT.ownerStep);
    return failed ? EXIT_FAILED : EXIT_OK;
  };
}
