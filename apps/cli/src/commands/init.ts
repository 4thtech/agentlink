// `agentlink init [--agent <name>] [--harness <id|none>] [--config <path>] [--confirm <code>]` (M1-9a,
// M1-9t; 06 §7, 07 §9.1, §9.4; D-39, D-54, D-73 (7), D-78): the agent's identity in the OS keychain
// and the `agentlink` MCP entry in each detected harness (Claude Code, Claude Desktop, Codex, Gemini CLI, OpenCode,
// Antigravity), or in the one named with `--harness` (`none`: the identity only). `--config` names the
// OpenCode or Antigravity config file, checked under the 06 §7 write rules (resolveConfigTarget).
// Declining every proposed change writes no harness config but keeps the identity (D-78).
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
  CONFIG_PATH_HARNESSES,
  HARNESS_MESSAGES,
  HarnessError,
  applyHarness,
  detectHarnesses,
  displayPath,
  harnessById,
  isHarnessId,
  planHarness,
  resolveConfigTarget,
  type ConfigTarget,
  type HarnessContext,
  type HarnessDef,
  type HarnessPlan,
} from '../harness/index.js';
import {
  DEFAULT_AGENT_NAME,
  RUNTIME_MESSAGES,
  RuntimeError,
  isAgentName,
  listAgentNames,
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
  rerun: 'Then run: agentlink init{agentFlag}{harnessFlag}{configFlag} --confirm {code}',
  updated: 'OK       {appName} updated. Backup of the old file: {backup}',
  created: 'OK       {appName} set up',
  ownerStep:
    "One step left, and you must do it yourself: run `agentlink owner init` in your own terminal. Don't let your AI run it or see the code it shows. It's what stops any AI, including your own, from approving its own actions.",
  noAppsHere: "Problem  AgentLink didn't find {apps} on this computer.",
  appsAll: 'Claude Code, Claude Desktop, Codex, Gemini CLI, OpenCode or Antigravity',
  // No Claude desktop app on Linux, so it is not named there.
  appsLinux: 'Claude Code, Codex, Gemini CLI, OpenCode or Antigravity',
  restartDesktop: 'Warning Quit and reopen the Claude app. AgentLink appears under Connectors.',
  // D-78 (06 §7).
  declinedKept:
    'No app was changed. Your agent identity is kept. To set up one app later, run: agentlink init --harness <app>',
  ownerStepAdd:
    "One step left, and you must do it yourself: run `agentlink owner add-agent --agent {name}` in your own terminal, so this agent gets a card from your owner. Don't let your AI run it or see what you type.",
  configPlace: '<the same path>',
});

const DESKTOP_APP_NAME = harnessById('claude-desktop').appName;
const CODE_PATTERN = /^[0-9a-f]{4}-?[0-9a-f]{4}$/i;

type ChangePlan = Extract<HarnessPlan, { status: 'change' }>;

/** The code that binds `--confirm` to exactly the changes shown. */
const hashText = (text: string): string => encodeHex(sha256(new TextEncoder().encode(text)));

function confirmationCode(
  name: string,
  createIdentity: boolean,
  target: string,
  config: ConfigTarget | undefined,
  changes: readonly ChangePlan[],
  platform: NodeJS.Platform,
): string {
  // The target harness and the `--config` file are bound too, so a code shown for one harness or
  // file never confirms another (D-78).
  const lines = [
    `agentlink-init-v2 ${name} ${createIdentity ? 'new' : 'existing'} ${target}`,
    `config ${config === undefined ? '-' : hashText(`${config.dir}\0${config.name}`)}`,
    ...changes.map(
      (c) => `${c.def.id} ${hashText(displayPath(c.def, config, platform))} ${hashText(c.text)}`,
    ),
  ];
  const digest = encodeHex(sha256(new TextEncoder().encode(lines.join('\n'))));
  return `${digest.slice(0, 4)}-${digest.slice(4, 8)}`;
}

const withApp = (text: string, appName: string): string => text.replaceAll('{appName}', appName);

function printPlan(
  context: CommandContext,
  plans: readonly HarnessPlan[],
  createIdentity: boolean,
  listApps: boolean,
  platform: NodeJS.Platform,
): void {
  const { output } = context;
  // With `--harness <id|none>` the owner chose, and nothing was looked for.
  if (listApps && plans.length > 0) {
    output.print(copy('cli.init.found', { count: plans.length }));
    for (const plan of plans) output.print(`  ${plan.def.appName}`);
  } else if (listApps) {
    const apps = platform === 'linux' ? INIT_TEXT.appsLinux : INIT_TEXT.appsAll;
    output.print(INIT_TEXT.noAppsHere.replace('{apps}', apps));
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
    // D-78 (06 §7): `--harness <id|none>`; `--config` only with OpenCode or Antigravity. The typed
    // values are never echoed (I-5).
    const harnessValue = parsed.values['harness'];
    const configValue = parsed.values['config'];
    if (
      harnessValue !== undefined &&
      (typeof harnessValue !== 'string' || (harnessValue !== 'none' && !isHarnessId(harnessValue)))
    ) {
      output.printError(DISPATCH_TEXT.badArguments);
      return EXIT_USAGE;
    }
    if (
      configValue !== undefined &&
      (typeof configValue !== 'string' ||
        typeof harnessValue !== 'string' ||
        !(CONFIG_PATH_HARNESSES as readonly string[]).includes(harnessValue))
    ) {
      output.printError(DISPATCH_TEXT.badArguments);
      return EXIT_USAGE;
    }
    const chosen: HarnessDef | undefined =
      typeof harnessValue === 'string' && isHarnessId(harnessValue)
        ? harnessById(harnessValue)
        : undefined;

    // 07 §9.1, §9.4: no usable keychain is `needs_setup`; nothing is written.
    const selection = selectKeyStoreBackend(await deps.probeKeychain(), { fileOptIn: false });
    if (!selection.ok) {
      if (selection.status !== 'needs_setup') throw new RuntimeError('agent_open_failed');
      output.printError(selection.message);
      if (selection.fix !== undefined) output.printError(selection.fix);
      return EXIT_FAILED;
    }

    let config: ConfigTarget | undefined;
    if (typeof configValue === 'string' && chosen !== undefined) {
      try {
        config = await resolveConfigTarget(deps.home, configValue);
      } catch (error) {
        if (!(error instanceof HarnessError)) throw error;
        output.printError(withApp(HARNESS_MESSAGES[error.code], chosen.appName));
        return EXIT_FAILED;
      }
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
      ...(config === undefined ? {} : { config }),
    };
    let targets: readonly HarnessDef[];
    if (harnessValue === 'none') targets = [];
    else if (chosen !== undefined) targets = [chosen];
    else targets = await detectHarnesses(harnessContext);
    const listApps = harnessValue === undefined;
    const plans: HarnessPlan[] = [];
    for (const def of targets) plans.push(await planHarness(def, harnessContext));
    const changes = plans.filter((p): p is ChangePlan => p.status === 'change');
    const blocked = plans.some((p) => p.status === 'blocked');

    const target = typeof harnessValue === 'string' ? harnessValue : '*';
    const code = confirmationCode(
      name,
      needIdentity,
      target,
      config,
      changes,
      deps.platform ?? process.platform,
    );
    const interactive = checkOwnerTerminal(terminal).ok && confirmValue === undefined;

    if (!needIdentity && changes.length === 0) {
      printPlan(context, plans, false, listApps, deps.platform ?? process.platform);
      output.print(INIT_TEXT.nothingToDo);
      return blocked ? EXIT_FAILED : EXIT_OK;
    }

    // The one harness the owner named can't be changed safely: stop before any code or write.
    if (chosen !== undefined && blocked) {
      printPlan(context, plans, false, listApps, deps.platform ?? process.platform);
      return EXIT_FAILED;
    }

    // Nothing has been written yet. Show everything first (D-39).
    printPlan(context, plans, needIdentity, listApps, deps.platform ?? process.platform);

    let approved: readonly ChangePlan[];
    let declined = false;
    if (interactive) {
      const yes: ChangePlan[] = [];
      for (const change of changes) {
        output.print('');
        output.print(copy('cli.init.changesFor', { appName: change.def.appName }));
        output.print(copy('cli.init.apply'));
        const answer = await deps.readLine();
        if (/^\s*y(es)?\s*$/i.test(answer)) yes.push(change);
      }
      approved = yes;
      // D-78 (06 §7): declining every app change never removes the identity; it is kept (or created,
      // as shown above, in a terminal the owner opened).
      declined = yes.length === 0 && changes.length > 0;
    } else if (confirmValue === undefined) {
      // Run by an agent: show the code and stop. Nothing is written.
      output.print('');
      output.print(copy('cli.init.agentConfirm', { code }));
      output.print(
        INIT_TEXT.rerun
          .replace('{agentFlag}', name === DEFAULT_AGENT_NAME ? '' : ` --agent ${name}`)
          // Fixed values only: the checked harness id, never the typed --config path (I-5).
          .replace('{harnessFlag}', typeof harnessValue === 'string' ? ` --harness ${target}` : '')
          .replace('{configFlag}', config === undefined ? '' : ` --config ${INIT_TEXT.configPlace}`)
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
    if (needIdentity) {
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
      for (const appName of applied) {
        output.print(
          appName === DESKTOP_APP_NAME
            ? INIT_TEXT.restartDesktop
            : copy('cli.init.restart', { appName }),
        );
      }
    }
    if (declined) output.print(INIT_TEXT.declinedKept);
    // D-78: with another agent already on this computer, the owner adds this one to the existing
    // owner instead of a second `owner init`. Names follow the 06 §6 pattern (nothing to sanitize).
    let others: string[] = [];
    try {
      others = (
        await listAgentNames(deps.home, deps.uid === undefined ? {} : { uid: deps.uid })
      ).filter((n) => n !== name && isAgentName(n));
    } catch {
      // Only the hint depends on it.
    }
    output.print(
      others.length > 0 ? INIT_TEXT.ownerStepAdd.replace('{name}', name) : INIT_TEXT.ownerStep,
    );
    return failed ? EXIT_FAILED : EXIT_OK;
  };
}
