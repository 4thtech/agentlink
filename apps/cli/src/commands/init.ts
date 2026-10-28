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
// All key creation is `@4thtech-io/node`'s (`createOsKeychainAgent`); nothing here is crypto, apart
// from hashing the proposed changes into the confirmation code.
//
// M1-36b (owner decisions D1, D5 of 2026-10-22):
// - D5: without `--agent`, a run for exactly one app names the agent after it (`codex`,
//   `claude-code`, …; already valid 06 §6 names). Several apps at once, `--harness none`, or a
//   computer that already has an agent with the usual name keep `default`, so earlier setups and
//   their MCP entries stay as they are. `--agent` always wins.
// - D1: in a terminal the owner opened, after the app changes, `init` offers to install AgentLink on
//   this computer: the exact `npm` command is shown and runs only after a `y`. Run by an agent it
//   never installs and never asks; it prints the command for the user. Declined or failed, npx stays
//   the fallback, and every command printed here starts with the form that works (M1-36a).
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { encodeHex, sha256 } from '@4thtech-io/crypto';
import { createOsKeychainAgent, probeOsKeychain, selectKeyStoreBackend } from '@4thtech-io/node';
import type { KeychainProbe } from '@4thtech-io/node';
import {
  DISPATCH_TEXT,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  type CommandContext,
  type CommandHandler,
} from '../dispatch.js';
import { nodeOwnerDeps } from './owner/deps.js';
import {
  CONFIG_PATH_HARNESSES,
  HARNESS_MESSAGES,
  HarnessError,
  applyHarness,
  detectHarnesses,
  harnessById,
  isHarnessId,
  planHarness,
  planSessionHook,
  applySessionHook,
  resolveInstalledCli,
  HOOK_HARNESS,
  HOOK_SETTINGS_DISPLAY,
  resolveConfigTarget,
  type ConfigTarget,
  type HarnessContext,
  type HarnessDef,
  type HarnessPlan,
  type HookPlan,
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
import { GLOBAL_PREFIX, cliPrefix } from '../runtime/cli-prefix.js';
import { INSTALL_COMMAND, installGlobally, isAgentlinkOnPath } from './global-install.js';
import { sanitizeTerminalText } from '../terminal/sanitize.js';
import { copy } from '@4thtech-io/mcp-tools/strings/index.js';
import { firstRunStep } from './first-run.js';
import { appServes, chooseCurrentAgent } from './current-agent.js';
import { readAppCurrent } from '../runtime/agent-dir.js';

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
  /**
   * `"<node>" "<script>"` of the installed program for `--hook` (M1-29), or undefined when only a
   * temporary or unsafe copy is running (installed-cli.ts).
   */
  readonly installedCli?: () => Promise<string | undefined>;
  /** Whether the Claude desktop app is running now (no shell). Absent: treated as not running. */
  readonly claudeDesktopRunning?: () => Promise<boolean>;
  /** Whether this agent already has a card from an owner. Absent: treated as no card yet. */
  readonly hasOwnerCard?: (name: string) => Promise<boolean>;
  /** The command that runs AgentLink as it was started (M1-36a `cliPrefix`). */
  readonly cliPrefix?: () => string;
  /** Whether an `agentlink` program is on PATH. Absent: treated as installed (no offer, no tip). */
  readonly agentlinkOnPath?: () => boolean;
  /** Runs the global install (M1-36b, D1); true when it succeeded. Absent: never offered. */
  readonly installGlobal?: () => Promise<boolean>;
  /** M1-11b-6: the first-run page step (first-run.ts); true when it handled the owner step. */
  readonly firstRun?: (
    context: CommandContext,
    name: string,
    interactive: boolean,
    /** The command to name (M1-36a `cliPrefix`, after the install offer). */
    prefix: string,
  ) => Promise<boolean>;
}

/**
 * One line reader for the whole run: lines typed ahead are kept for the next question instead of
 * being lost with a reader that closes after each answer. Paused between questions, so the process
 * can still exit.
 */
export function sharedLineReader(): () => Promise<string> {
  const queue: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  let rl: ReturnType<typeof createInterface> | undefined;
  let closed = false;
  return () =>
    new Promise<string>((resolve) => {
      const queued = queue.shift();
      if (queued !== undefined) return resolve(queued);
      if (closed) return resolve('');
      if (rl === undefined) {
        // No `output`: the question is printed through the CLI's output channel (src/output.ts).
        const reader = createInterface({ input: process.stdin });
        rl = reader;
        reader.on('line', (line) => {
          const next = waiting.shift();
          if (next !== undefined) next(line);
          else queue.push(line);
          if (waiting.length === 0) reader.pause();
        });
        reader.once('close', () => {
          closed = true;
          for (const next of waiting.splice(0)) next('');
        });
      }
      waiting.push(resolve);
      rl.resume();
    });
}

/** Runs a fixed program without a shell and tests its output. */
function runsCheck(command: string, args: readonly string[], match: RegExp): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    execFile(command, [...args], { timeout: 5_000, windowsHide: true }, (error, stdout) => {
      resolve(error === null && match.test(String(stdout)));
    });
  });
}

function isClaudeDesktopRunning(platform: NodeJS.Platform): Promise<boolean> {
  if (platform === 'darwin') return runsCheck('pgrep', ['-x', 'Claude'], /\d/);
  if (platform === 'win32') {
    return runsCheck('tasklist', ['/FI', 'IMAGENAME eq Claude.exe', '/NH'], /Claude\.exe/i);
  }
  return Promise.resolve(false);
}

export function nodeInitDeps(): InitDeps {
  return {
    home: homedir(),
    probeKeychain: () => probeOsKeychain(),
    createAgent: () => createOsKeychainAgent(),
    readLine: sharedLineReader(),
    claudeDesktopRunning: () => isClaudeDesktopRunning(process.platform),
    hasOwnerCard: async (name) => {
      const opened = await nodeOwnerDeps().open(name);
      if (opened.status !== 'ok') return false;
      try {
        return (await opened.agent.client.identity.get()) !== undefined;
      } finally {
        await opened.agent.close();
      }
    },
    clock: () => Math.floor(Date.now() / 1000),
    installedCli: () => resolveInstalledCli(process.argv[1], process.execPath),
    cliPrefix: () => cliPrefix(),
    agentlinkOnPath: () => isAgentlinkOnPath(process.env),
    installGlobal: () => installGlobally(),
    firstRun: (context, name, interactive, prefix) =>
      firstRunStep(context, name, interactive, prefix),
  };
}

/** Fixed text of `init --hook` (M1-29). Nothing from a file or the user is inserted. */
export const HOOK_TEXT = Object.freeze({
  intro:
    'This adds a start-of-session note to Claude Code: a line or two saying who has written to you. It runs the AgentLink program installed on this computer. It never reads message text and changes nothing.',
  noInstall:
    'The hook needs AgentLink installed on this computer, and this copy is only running temporarily. Install it with `npm install -g @4thtech-io/agentlink`, then run the same command again. Nothing was changed.',
  notFound: "Problem  AgentLink didn't find Claude Code on this computer. Nothing was changed.",
  present: 'OK       The AgentLink start-of-session note is already set up in Claude Code',
  conflict:
    'Claude Code already has a different AgentLink start-of-session hook, so AgentLink left it as it is. Nothing was changed there.',
  updated: 'OK       Claude Code updated. Backup of the old file: {backup}',
  created: 'OK       Claude Code start-of-session note set up',
  restart: 'Warning Claude Code needs a restart. Quit and reopen Claude Code.',
  rerun: 'Then run: {prefix} init --hook{agentFlag} --confirm {code}',
});

/** Fixed text that has no entry in the copy sheet yet (no value from a file or the user is inserted). */
export const INIT_TEXT = Object.freeze({
  badCode:
    "That confirmation code isn't right. Run `{prefix} init` again to see the changes and the code.",
  codeMismatch:
    "That confirmation code doesn't match the changes proposed now (they may have changed). Run `{prefix} init` again to see them and the new code.",
  identity: "AgentLink will create this agent's identity and keep it in your system keychain.",
  identityDone: 'OK       Agent identity created',
  nothingToDo: 'OK AgentLink is already set up. Nothing to change.',
  present: 'OK       {appName} is already set up for AgentLink',
  conflict:
    '{appName} already has an entry named agentlink that is different, so AgentLink left it as it is. Nothing was changed there.',
  // M1-UX-MULTI-AGENT: what differs, and how to replace. Only fixed text and valid agent names.
  conflictOtherAgent:
    '          It starts the agent {existing}, but this run is for the agent {wanted}.',
  conflictOtherCommand:
    '          It starts AgentLink in another way (for example an older command or another version).',
  conflictUnknown: "          AgentLink couldn't tell how it differs.",
  conflictFix:
    '          AgentLink never replaces it. To switch, remove the entry named agentlink from {path} (your AI app can help), then run `{prefix} init{agentFlag} --harness {id}`.',
  rerun: 'Then run: {prefix} init{agentFlag}{harnessFlag}{configFlag} --confirm {code}',
  updated: 'OK       {appName} updated. Backup of the old file: {backup}',
  created: 'OK       {appName} set up',
  ownerStep:
    "One step left, and you must do it yourself: run `{prefix} owner init{agentFlag}` in your own terminal. Don't let your AI run it or see the code it shows. It's what stops any AI, including your own, from approving its own actions.",
  noAppsHere: "Problem  AgentLink didn't find {apps} on this computer.",
  appsAll:
    'Claude Code, Claude Desktop, Codex, Gemini CLI, OpenCode, Antigravity, Cursor or Windsurf',
  // No Claude desktop app on Linux, so it is not named there.
  appsLinux: 'Claude Code, Codex, Gemini CLI, OpenCode, Antigravity, Cursor or Windsurf',
  restartDesktop: 'Warning Quit and reopen the Claude app. AgentLink appears under Connectors.',
  desktopStillOpen:
    'Problem  Claude Desktop is still open, so AgentLink did not change its settings (it rewrites them when it quits). Quit Claude Desktop (Cmd+Q), then run `{prefix} init --harness claude-desktop`.',
  quitDesktopMac: 'Quit Claude Desktop first (Cmd+Q), then press Enter.',
  quitDesktopOther: 'Quit Claude Desktop first (close it completely), then press Enter.',
  allQuestion: 'Set up AgentLink in all {count} apps? (y/N)',
  applyApp: 'Apply the changes to {appName}? (y/N)',
  skipped: 'Skipped {appName}.',
  summaryTitle: 'Summary:',
  summarySetUp: '  {appName}: set up',
  summaryPresent: '  {appName}: already set up',
  summarySkipped: '  {appName}: skipped',
  summaryBlocked: '  {appName}: blocked. {reason}',
  summaryConflict:
    '  {appName}: blocked. It already has a different entry named agentlink, left as it is.',
  // D-78 (06 §7).
  declinedKept:
    'No app was changed. Your agent identity is kept. To set up one app later, run `{prefix} init --harness <app>`.',
  ownerStepAdd:
    "One step left, and you must do it yourself: run `{prefix} owner add-agent --agent {name}` in your own terminal, so this agent gets a card from your owner. Don't let your AI run it or see what you type.",
  configPlace: '<the same path>',
  // M1-36b (D1). Fixed text: the command is a constant, nothing from a file or the user.
  installOffer:
    'Recommended: install AgentLink on this computer. Your AI apps then start it faster, and the commands AgentLink shows you are shorter.',
  installCommand: `This runs: ${INSTALL_COMMAND}`,
  installQuestion: 'Install it now? (y/N)',
  installing: 'Installing AgentLink. This can take a minute…',
  installed: 'OK       AgentLink is installed on this computer',
  installSkipped: `OK       Not installed. AgentLink keeps working without it. To install it later, run: ${INSTALL_COMMAND}`,
  installFailed: `Problem  The install didn't finish, so AgentLink keeps working without it. To try again, run: ${INSTALL_COMMAND}`,
  installTip: `Recommended: install AgentLink on this computer, so it starts faster. In a terminal, run: ${INSTALL_COMMAND}`,
});

/** `{prefix}` (M1-36a) and `{agentFlag}` filled in; the name is a checked 06 §6 name. */
function initText(text: string, prefix: string, name?: string): string {
  return text
    .replaceAll('{prefix}', prefix)
    .replaceAll(
      '{agentFlag}',
      name === undefined || name === DEFAULT_AGENT_NAME ? '' : ` --agent ${name}`,
    );
}

/** D5: the agent name an app gets when `--agent` is not given (each id is a valid 06 §6 name). */
export const agentNameForApp = (def: HarnessDef): string => def.id;

/** Local agent names on this computer, or undefined when they can't be listed. */
async function knownAgents(deps: InitDeps): Promise<readonly string[] | undefined> {
  try {
    return await listAgentNames(deps.home, deps.uid === undefined ? {} : { uid: deps.uid });
  } catch {
    return undefined;
  }
}

/**
 * D5 (IR-M1-36b-1): an existing agent is always reused, never a second one created without
 * `--agent`. `default` when it exists; else the only agent on this computer; with several and no
 * `default`, the current agent (U3-b: never asked; the last used one in app.json, else the one an AI
 * app serves, else the first by name). Only a computer with no agent yet gets a new one:
 * named after the app when the run is for exactly one app, otherwise `default`. Agents that can't be
 * listed: `default`, as before M1-36b.
 */
async function defaultAgentName(
  deps: InitDeps,
  apps: readonly HarnessDef[] | undefined,
  context: HarnessContext,
): Promise<string> {
  const known = await knownAgents(deps);
  if (known === undefined) return DEFAULT_AGENT_NAME;
  const valid = known.filter((n) => isAgentName(n));
  if (valid.includes(DEFAULT_AGENT_NAME)) return DEFAULT_AGENT_NAME;
  if (valid.length > 0) {
    const last = await readAppCurrent(deps.home, deps.uid === undefined ? {} : { uid: deps.uid });
    const current = await chooseCurrentAgent(valid, last, appServes(context, apps));
    if (current !== undefined) return current;
  }
  const [app] = apps ?? [];
  if (apps?.length !== 1 || app === undefined) return DEFAULT_AGENT_NAME;
  return agentNameForApp(app);
}

/**
 * D1: in a terminal the owner opened, offers the global install with its exact command and runs it
 * only after a `y`. Returns the command prefix to print from now on.
 */
async function offerInstall(context: CommandContext, deps: InitDeps): Promise<string> {
  const { output } = context;
  const prefix = deps.cliPrefix?.() ?? cliPrefix();
  if (deps.installGlobal === undefined || deps.agentlinkOnPath === undefined) return prefix;
  if (prefix === GLOBAL_PREFIX || deps.agentlinkOnPath()) return prefix;
  output.print('');
  output.print(INIT_TEXT.installOffer);
  output.print(INIT_TEXT.installCommand);
  output.print(INIT_TEXT.installQuestion);
  if (!/^\s*y(es)?\s*$/i.test(await deps.readLine())) {
    output.print(INIT_TEXT.installSkipped);
    return prefix;
  }
  output.print(INIT_TEXT.installing);
  if (!(await deps.installGlobal())) {
    output.printError(INIT_TEXT.installFailed);
    return prefix;
  }
  output.print(INIT_TEXT.installed);
  // The bare name only when the new program is really reachable; npx works either way.
  return deps.agentlinkOnPath() ? GLOBAL_PREFIX : prefix;
}

/** D1, run by an agent: the command for the user, never run here. */
function installTip(context: CommandContext, deps: InitDeps): void {
  const prefix = deps.cliPrefix?.() ?? cliPrefix();
  if (deps.agentlinkOnPath === undefined || prefix === GLOBAL_PREFIX || deps.agentlinkOnPath()) {
    return;
  }
  context.output.print(INIT_TEXT.installTip);
}

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
): string {
  // The target harness and the `--config` file are bound too, so a code shown for one harness or
  // file never confirms another (D-78).
  const lines = [
    `agentlink-init-v2 ${name} ${createIdentity ? 'new' : 'existing'} ${target}`,
    `config ${config === undefined ? '-' : hashText(`${config.dir}\0${config.name}`)}`,
    ...changes.map(
      // M1-36g-c: the path shown and the file written, as resolved by the plan (environment applied).
      (c) => `${c.def.id} ${hashText(`${c.path}\0${c.file}`)} ${hashText(c.text)}`,
    ),
  ];
  const digest = encodeHex(sha256(new TextEncoder().encode(lines.join('\n'))));
  return `${digest.slice(0, 4)}-${digest.slice(4, 8)}`;
}

const YES = /^\s*y(es)?\s*$/i;

const withApp = (text: string, appName: string): string => text.replaceAll('{appName}', appName);

function printDiff(output: CommandContext['output'], plan: ChangePlan): void {
  output.print(copy('cli.init.changesFor', { appName: plan.def.appName }));
  // The diff holds text from the user's own file: sanitized like any printed value (06 §8).
  for (const line of plan.diff) output.print(sanitizeTerminalText(line));
}

function printPlan(
  context: CommandContext,
  plans: readonly HarnessPlan[],
  createIdentity: boolean,
  listApps: boolean,
  platform: NodeJS.Platform,
  showDiffs = true,
  explain: { readonly prefix: string; readonly name: string } = {
    prefix: cliPrefix(),
    name: DEFAULT_AGENT_NAME,
  },
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
    if (plan.status === 'change' && !showDiffs) continue;
    output.print('');
    switch (plan.status) {
      case 'change':
        // In a terminal, each diff is printed right above its own question instead (UX-B F9).
        if (showDiffs) printDiff(output, plan);
        break;
      case 'present':
        output.print(withApp(INIT_TEXT.present, plan.def.appName));
        break;
      case 'conflict':
        output.print(withApp(INIT_TEXT.conflict, plan.def.appName));
        for (const line of conflictLines(plan, explain.prefix, explain.name)) output.print(line);
        break;
      case 'blocked':
        output.printError(withApp(HARNESS_MESSAGES[plan.reason], plan.def.appName));
        break;
    }
  }
}

/** M1-UX-MULTI-AGENT: what differs in the existing entry and how to replace it (fixed text). */
function conflictLines(
  plan: Extract<HarnessPlan, { status: 'conflict' }>,
  prefix: string,
  name: string,
): string[] {
  const { difference } = plan;
  const what =
    difference.kind === 'other_agent'
      ? INIT_TEXT.conflictOtherAgent
          .replace('{existing}', difference.existing)
          .replace('{wanted}', difference.wanted)
      : difference.kind === 'other_command'
        ? INIT_TEXT.conflictOtherCommand
        : INIT_TEXT.conflictUnknown;
  const fix = initText(INIT_TEXT.conflictFix, prefix, name)
    .replace('{path}', plan.path)
    .replace('{id}', plan.def.id);
  return [what, fix];
}

/** One line per app: set up, already set up, skipped or blocked (with the fixed reason). */
function printSummary(
  output: CommandContext['output'],
  plans: readonly HarnessPlan[],
  applied: readonly string[],
  failedApps: ReadonlyMap<string, string>,
): void {
  if (plans.length < 2) return;
  output.print('');
  output.print(INIT_TEXT.summaryTitle);
  for (const plan of plans) {
    const appName = plan.def.appName;
    let line: string;
    if (plan.status === 'present') line = INIT_TEXT.summaryPresent;
    else if (plan.status === 'conflict') line = INIT_TEXT.summaryConflict;
    else if (plan.status === 'blocked') {
      // A reason can name the app; withApp below fills it.
      line = INIT_TEXT.summaryBlocked.replace('{reason}', HARNESS_MESSAGES[plan.reason]);
    } else if (failedApps.has(plan.def.id)) {
      line = INIT_TEXT.summaryBlocked.replace('{reason}', failedApps.get(plan.def.id) ?? '');
    } else if (applied.includes(appName)) line = INIT_TEXT.summarySetUp;
    else line = INIT_TEXT.summarySkipped;
    output.print(withApp(line, appName));
  }
}

/**
 * The other local agents on this computer (D-78); empty when the list cannot be read (only the
 * owner-step hint and the first-run offer depend on it, and the first-run page checks for other
 * agent folders again, failing closed: local-ui-wiring.ts).
 */
async function otherAgentNames(deps: InitDeps, name: string): Promise<string[]> {
  try {
    return (
      await listAgentNames(deps.home, deps.uid === undefined ? {} : { uid: deps.uid })
    ).filter((n) => n !== name && isAgentName(n));
  } catch {
    return [];
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

/**
 * `init --hook` (M1-29; 06 §7, D-53): adds the SessionStart hook to Claude Code's settings, as its own
 * opt-in. Same rules as the MCP entry: the exact diff first, a y/N in a terminal the owner opened, or
 * a one-time code when run by an agent; a code for the MCP entry never confirms it. Needs no keychain
 * and creates no identity.
 */
async function runHookOptIn(
  context: CommandContext,
  deps: InitDeps,
  requested: string,
  confirmValue: string | undefined,
): Promise<number> {
  const { output, terminal } = context;
  let name = requested;
  // D5: `default` when it exists, else the Claude Code agent, else the only agent.
  if (context.parsed.agent === undefined) {
    const known = await knownAgents(deps);
    if (known !== undefined && !known.includes(DEFAULT_AGENT_NAME)) {
      const claude = agentNameForApp(HOOK_HARNESS);
      const valid = known.filter((n) => isAgentName(n));
      if (valid.includes(claude)) name = claude;
      else if (valid.length === 1 && valid[0] !== undefined) name = valid[0];
    }
  }
  const prefix = deps.installedCli === undefined ? undefined : await deps.installedCli();
  if (prefix === undefined) {
    output.printError(HOOK_TEXT.noInstall);
    return EXIT_FAILED;
  }
  const command = `${prefix} status --brief${name === DEFAULT_AGENT_NAME ? '' : ` --agent ${name}`}`;
  const harnessContext: HarnessContext = {
    home: deps.home,
    env: terminal.env,
    ...(deps.platform === undefined ? {} : { platform: deps.platform }),
    now: deps.clock(),
    ...(deps.uid === undefined ? {} : { uid: deps.uid }),
  };
  if (context.parsed.values['harness'] === undefined) {
    const found = await detectHarnesses(harnessContext);
    if (!found.some((h) => h.id === HOOK_HARNESS.id)) {
      output.printError(HOOK_TEXT.notFound);
      return EXIT_FAILED;
    }
  }
  const plan: HookPlan = await planSessionHook(harnessContext, command);
  switch (plan.status) {
    case 'present':
      output.print(HOOK_TEXT.present);
      return EXIT_OK;
    case 'conflict':
      output.print(HOOK_TEXT.conflict);
      return EXIT_OK;
    case 'blocked':
      output.printError(withApp(HARNESS_MESSAGES[plan.reason], HOOK_HARNESS.appName));
      return EXIT_FAILED;
    case 'change':
      break;
  }

  const code = (() => {
    const digest = encodeHex(
      sha256(
        new TextEncoder().encode(
          `agentlink-init-hook-v1 ${name} ${hashText(HOOK_SETTINGS_DISPLAY)} ${hashText(plan.text)}`,
        ),
      ),
    );
    return `${digest.slice(0, 4)}-${digest.slice(4, 8)}`;
  })();
  const interactive = checkOwnerTerminal(terminal).ok && confirmValue === undefined;
  const agentFlag = name === DEFAULT_AGENT_NAME ? '' : ` --agent ${name}`;

  // Nothing has been written yet. Show the exact change first.
  output.print(HOOK_TEXT.intro);
  output.print('');
  output.print(copy('cli.init.changesFor', { appName: HOOK_HARNESS.appName }));
  for (const line of plan.diff) output.print(sanitizeTerminalText(line));

  if (interactive) {
    output.print('');
    output.print(copy('cli.init.apply'));
    if (!/^\s*y(es)?\s*$/i.test(await deps.readLine())) {
      output.print(copy('cli.init.cancelled'));
      return EXIT_OK;
    }
  } else if (confirmValue === undefined) {
    output.print('');
    output.print(copy('cli.init.agentConfirm', { code }));
    output.print(
      HOOK_TEXT.rerun
        .replace('{prefix}', deps.cliPrefix?.() ?? cliPrefix())
        .replace('{agentFlag}', agentFlag)
        .replace('{code}', code),
    );
    return EXIT_OK;
  } else if (confirmValue.replace('-', '').toLowerCase() !== code.replace('-', '')) {
    output.printError(initText(INIT_TEXT.codeMismatch, deps.cliPrefix?.() ?? cliPrefix()));
    return EXIT_FAILED;
  }

  try {
    const { backup } = await applySessionHook(plan, harnessContext);
    output.print(
      backup === undefined ? HOOK_TEXT.created : HOOK_TEXT.updated.replace('{backup}', backup),
    );
    output.print(HOOK_TEXT.restart);
    return EXIT_OK;
  } catch (error) {
    if (!(error instanceof HarnessError)) throw error;
    output.printError(withApp(HARNESS_MESSAGES[error.code], HOOK_HARNESS.appName));
    return EXIT_FAILED;
  }
}

/** The `init` command handler. */
export function createInitHandler(deps: InitDeps = nodeInitDeps()): CommandHandler {
  return async (context) => {
    const { output, parsed, terminal } = context;
    const startPrefix = deps.cliPrefix?.() ?? cliPrefix();

    // Arguments: `--agent` is checked here too (the dispatcher already did), the code by its form.
    if (parsed.agent !== undefined && !isAgentName(parsed.agent)) {
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
      output.printError(initText(INIT_TEXT.badCode, startPrefix));
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
    if (parsed.values['hook'] === true) {
      // `--hook` is Claude Code only and takes neither `--config` nor `--harness none`.
      if (
        configValue !== undefined ||
        (harnessValue !== undefined && harnessValue !== 'claude-code')
      ) {
        output.printError(DISPATCH_TEXT.badArguments);
        return EXIT_USAGE;
      }
      return runHookOptIn(context, deps, parsed.agent ?? DEFAULT_AGENT_NAME, confirmValue);
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

    const baseContext: HarnessContext = {
      home: deps.home,
      env: terminal.env,
      ...(deps.platform === undefined ? {} : { platform: deps.platform }),
      now: deps.clock(),
      ...(deps.uid === undefined ? {} : { uid: deps.uid }),
      ...(config === undefined ? {} : { config }),
    };
    let targets: readonly HarnessDef[];
    if (harnessValue === 'none') targets = [];
    else if (chosen !== undefined) targets = [chosen];
    else targets = await detectHarnesses(baseContext);

    // D5: named after the app unless `--agent` says otherwise.
    // U3-b: never asked which agent; with several, the current one (defaultAgentName).
    const name: string =
      parsed.agent ??
      (await defaultAgentName(deps, harnessValue === 'none' ? undefined : targets, baseContext));
    const existing = await readAgentConfig(
      deps.home,
      name,
      deps.uid === undefined ? {} : { uid: deps.uid },
    );
    const needIdentity = existing === undefined;
    const harnessContext: HarnessContext = {
      ...baseContext,
      ...(name === DEFAULT_AGENT_NAME ? {} : { agent: name }),
    };
    const listApps = harnessValue === undefined;
    const plans: HarnessPlan[] = [];
    for (const def of targets) plans.push(await planHarness(def, harnessContext));
    const changes = plans.filter((p): p is ChangePlan => p.status === 'change');
    const blocked = plans.some((p) => p.status === 'blocked');

    const target = typeof harnessValue === 'string' ? harnessValue : '*';
    const code = confirmationCode(name, needIdentity, target, config, changes);
    const interactive = checkOwnerTerminal(terminal).ok && confirmValue === undefined;

    if (!needIdentity && changes.length === 0) {
      printPlan(context, plans, false, listApps, deps.platform ?? process.platform, true, {
        prefix: startPrefix,
        name,
      });
      output.print(INIT_TEXT.nothingToDo);
      printSummary(output, plans, [], new Map());
      let nowPrefix = startPrefix;
      if (interactive) nowPrefix = await offerInstall(context, deps);
      else installTip(context, deps);
      // M1-11b-6: after the install offer (M1-36b), so the step names the command that now works.
      // IR-M1-11b-6-1 L-1: only with no other agent here, as at the end of a fresh setup.
      if ((await otherAgentNames(deps, name)).length === 0) {
        await deps.firstRun?.(context, name, interactive, nowPrefix);
      }
      return blocked ? EXIT_FAILED : EXIT_OK;
    }

    // The one harness the owner named can't be changed safely: stop before any code or write.
    if (chosen !== undefined && blocked) {
      printPlan(context, plans, false, listApps, deps.platform ?? process.platform, true, {
        prefix: startPrefix,
        name,
      });
      return EXIT_FAILED;
    }

    // Nothing has been written yet. Show everything first (D-39).
    printPlan(
      context,
      plans,
      needIdentity,
      listApps,
      deps.platform ?? process.platform,
      !interactive,
      { prefix: startPrefix, name },
    );

    let approved: readonly ChangePlan[];
    let declined = false;
    if (interactive) {
      const yes: ChangePlan[] = [];
      let all = false;
      if (changes.length > 1) {
        // Every change is shown once, then one question for all of them (UX: ask once).
        for (const change of changes) {
          output.print('');
          printDiff(output, change);
        }
        output.print('');
        output.print(INIT_TEXT.allQuestion.replace('{count}', String(changes.length)));
        all = YES.test(await deps.readLine());
      }
      for (const change of changes) {
        if (all) {
          yes.push(change);
          continue;
        }
        let answer: string;
        if (changes.length > 1) {
          output.print(withApp(INIT_TEXT.applyApp, change.def.appName));
          answer = await deps.readLine();
        } else {
          // UX-B F9: the header and diff once, right above their question.
          output.print('');
          printDiff(output, change);
          output.print(copy('cli.init.apply'));
          answer = await deps.readLine();
        }
        if (YES.test(answer)) yes.push(change);
        else {
          output.print(withApp(INIT_TEXT.skipped, change.def.appName));
        }
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
        initText(INIT_TEXT.rerun, startPrefix, name)
          // Fixed values only: the checked harness id, never the typed --config path (I-5).
          .replace('{harnessFlag}', typeof harnessValue === 'string' ? ` --harness ${target}` : '')
          .replace('{configFlag}', config === undefined ? '' : ` --config ${INIT_TEXT.configPlace}`)
          .replace('{code}', code),
      );
      installTip(context, deps);
      return blocked && changes.length === 0 && !needIdentity ? EXIT_FAILED : EXIT_OK;
    } else {
      if (confirmValue.replace('-', '').toLowerCase() !== code.replace('-', '')) {
        output.printError(initText(INIT_TEXT.codeMismatch, startPrefix));
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
    const failedApps = new Map<string, string>();
    for (const change of approved) {
      if (change.def.appName === DESKTOP_APP_NAME) {
        // The app rewrites its settings when it quits, so it must be closed before AgentLink writes.
        let running = (await deps.claudeDesktopRunning?.()) === true;
        for (let asks = 0; running && interactive && asks < 3; asks += 1) {
          output.print(
            (deps.platform ?? process.platform) === 'darwin'
              ? INIT_TEXT.quitDesktopMac
              : INIT_TEXT.quitDesktopOther,
          );
          await deps.readLine();
          running = (await deps.claudeDesktopRunning?.()) === true;
        }
        if (running) {
          const line = initText(INIT_TEXT.desktopStillOpen, startPrefix);
          output.printError(line);
          failedApps.set(change.def.id, line);
          continue;
        }
      }
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
        failedApps.set(change.def.id, withApp(HARNESS_MESSAGES[error.code], change.def.appName));
        failed = true;
      }
    }
    printSummary(output, plans, applied, failedApps);
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
    // D1: offered after the app changes, so the owner step below uses the command that works.
    let prefix = startPrefix;
    if (interactive) prefix = await offerInstall(context, deps);
    else installTip(context, deps);
    if (declined) output.print(initText(INIT_TEXT.declinedKept, prefix));
    // D-78: with another agent already on this computer, the owner adds this one to the existing
    // owner instead of a second `owner init`. Names follow the 06 §6 pattern (nothing to sanitize).
    const others = await otherAgentNames(deps, name);
    // M1-11b-6: with no other agent, the first-run page may take the owner step (first-run.ts).
    if (
      others.length === 0 &&
      (await deps.firstRun?.(context, name, interactive, prefix)) === true
    ) {
      return failed ? EXIT_FAILED : EXIT_OK;
    }
    if (others.length > 0) {
      // Only agents without a card need the add-agent step (a new identity never has one).
      const hasCard =
        !needIdentity && (await deps.hasOwnerCard?.(name).catch(() => false)) === true;
      if (!hasCard) output.print(initText(INIT_TEXT.ownerStepAdd, prefix).replace('{name}', name));
    } else {
      output.print(initText(INIT_TEXT.ownerStep, prefix, name));
    }
    return failed ? EXIT_FAILED : EXIT_OK;
  };
}
