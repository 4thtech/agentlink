// The harnesses `init` configures: Claude Code, Codex and Gemini CLI (06 §7, D-73 (7)), and from
// M1-9t OpenCode and Antigravity (D-78). Each is a fixed table entry: where its config lives under the
// home folder, how to tell it is installed, and how the `agentlink` MCP entry is added. Paths never
// come from the environment (CODEX_HOME and similar overrides are not followed: a variable the agent
// can set must not move a write). The only path from input is `--config <path>`, for OpenCode and
// Antigravity only, resolved and checked by resolveConfigTarget under the 06 §7 write rules. The entry
// runs `npx -y @4thtech-io/agentlink mcp`, as 06 §7 shows for every harness; a non-default agent adds
// `--agent <name>` (the name is checked against 06 §6 first). Claude Desktop and the printed snippets
// for Cursor, VS Code, Windsurf and Cline follow in M1b.
//
// Nothing here puts a secret in a config: the entry holds the command and its arguments only.
import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { unifiedDiff } from './diff.js';
import { HarnessError, type HarnessErrorCode } from './errors.js';
import { readConfigFile, writeConfigFile, type ConfigFile, type FileOptions } from './files.js';
import { addJsonMcpServer } from './json-config.js';
import { addTomlMcpServer, agentlinkTable } from './toml-config.js';

export type HarnessId = 'claude-code' | 'codex' | 'gemini-cli' | 'opencode' | 'antigravity';

/** The `--harness` values (06 §7, D-78): one harness id, or `none` for the identity only. */
export const HARNESS_IDS: readonly HarnessId[] = Object.freeze([
  'claude-code',
  'codex',
  'gemini-cli',
  'opencode',
  'antigravity',
]);

/** The harnesses whose config may be named with `--config <path>` (06 §7, D-78). */
export const CONFIG_PATH_HARNESSES: readonly HarnessId[] = Object.freeze([
  'opencode',
  'antigravity',
]);

export const isHarnessId = (value: string): value is HarnessId =>
  (HARNESS_IDS as readonly string[]).includes(value);

/** A config file at a place the owner named with `--config`, already resolved and checked. */
export interface ConfigTarget {
  /** The real folder that holds the file (exists). */
  readonly dir: string;
  /** The file name (no separator). */
  readonly name: string;
  /** How the path is shown: under the home folder as `~/…`. */
  readonly display: string;
}

export const PACKAGE_NAME = '@4thtech-io/agentlink';

export interface HarnessContext extends FileOptions {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  /** The local agent name when it is not the default one. Already checked against 06 §6. */
  readonly agent?: string;
  /** Unix seconds, for the backup's name. */
  readonly now: number;
  /** `--config`: the file to use instead of the harness's default (OpenCode and Antigravity only). */
  readonly config?: ConfigTarget;
}

export interface HarnessDef {
  readonly id: HarnessId;
  /** Fixed display name (never taken from a file). */
  readonly appName: string;
  /** The config file below the home folder. */
  readonly parts: readonly string[];
  /** Things below the home folder whose presence means the app is installed. */
  readonly installedMarks: readonly (readonly string[])[];
  /** The command name searched on PATH. */
  readonly binary: string;
  readonly edit: (
    text: string | undefined,
    args: readonly string[],
  ) => ReturnType<typeof addJsonMcpServer> | ReturnType<typeof addTomlMcpServer>;
}

const mcpArgs = (agent: string | undefined): string[] => [
  '-y',
  PACKAGE_NAME,
  'mcp',
  ...(agent === undefined ? [] : ['--agent', agent]),
];

export const HARNESSES: readonly HarnessDef[] = Object.freeze<HarnessDef[]>([
  {
    id: 'claude-code',
    appName: 'Claude Code',
    // User scope: the top-level `mcpServers` of ~/.claude.json.
    parts: ['.claude.json'],
    installedMarks: [['.claude'], ['.claude.json']],
    binary: 'claude',
    edit: (text, args) =>
      addJsonMcpServer(text, { type: 'stdio', command: 'npx', args: [...args], env: {} }),
  },
  {
    id: 'codex',
    appName: 'Codex',
    parts: ['.codex', 'config.toml'],
    installedMarks: [['.codex']],
    binary: 'codex',
    edit: (text, args) => addTomlMcpServer(text, agentlinkTable('npx', args)),
  },
  {
    id: 'gemini-cli',
    appName: 'Gemini CLI',
    parts: ['.gemini', 'settings.json'],
    installedMarks: [['.gemini']],
    binary: 'gemini',
    edit: (text, args) => addJsonMcpServer(text, { command: 'npx', args: [...args] }),
  },
  {
    // https://opencode.ai/docs/mcp-servers/ (checked 2026-10-16): `mcp.<name>` with `type: "local"`,
    // `command` as one array (program and arguments) and `enabled`.
    id: 'opencode',
    appName: 'OpenCode',
    parts: ['.config', 'opencode', 'opencode.json'],
    installedMarks: [['.config', 'opencode']],
    binary: 'opencode',
    edit: (text, args) =>
      addJsonMcpServer(text, { type: 'local', command: ['npx', ...args], enabled: true }, 'mcp'),
  },
  {
    // https://antigravity.google/docs/mcp (checked 2026-10-16): global `~/.gemini/config/mcp_config.json`,
    // `mcpServers.<name>` with `command` and `args`. Older builds read another file: `--config`.
    id: 'antigravity',
    appName: 'Antigravity',
    parts: ['.gemini', 'config', 'mcp_config.json'],
    installedMarks: [
      ['.gemini', 'antigravity'],
      ['.gemini', 'config', 'mcp_config.json'],
    ],
    binary: 'antigravity',
    edit: (text, args) => addJsonMcpServer(text, { command: 'npx', args: [...args] }),
  },
]);

/** The table entry for a harness id. */
export function harnessById(id: HarnessId): HarnessDef {
  const def = HARNESSES.find((h) => h.id === id);
  if (def === undefined) throw new Error('unknown harness');
  return def;
}

/** `~/.codex/config.toml`: how a config path is shown to the user. */
export function displayPath(def: HarnessDef, config?: ConfigTarget): string {
  return config === undefined ? `~/${def.parts.join('/')}` : config.display;
}

/**
 * Resolves `--config <path>` under the 06 §7 harness-config write rules (D-78): the folder is
 * resolved with `realpath` (links in folders followed) and must exist; the file must be a `.json`
 * file; nothing under `~/.agentlink`, `~/.ssh`, `~/.gnupg` or the keychain folders. The final
 * component is checked again when it is read and written (no link, a regular file with one name,
 * O_NOFOLLOW; files.ts), and the write is atomic (a temporary file and a rename in the same folder).
 * These checks stop accidents and redirection by inbound content or tool arguments; a same-user
 * process can still swap a folder in between (TOCTOU, G-1). Throws `unsafe_path`.
 */
export async function resolveConfigTarget(home: string, typed: string): Promise<ConfigTarget> {
  if (typed === '' || typed.includes('\0')) throw new HarnessError('unsafe_path');
  const absolute = resolve(typed);
  const name = basename(absolute);
  if (!name.endsWith('.json') || name === '.json') throw new HarnessError('unsafe_path');
  let dir: string;
  let homeReal: string;
  try {
    dir = await realpath(dirname(absolute));
    homeReal = await realpath(home);
  } catch {
    throw new HarnessError('unsafe_path');
  }
  if (
    !(await stat(dir).then(
      (info) => info.isDirectory(),
      () => false,
    ))
  ) {
    throw new HarnessError('unsafe_path');
  }
  const roots = [
    ['.agentlink'],
    ['.ssh'],
    ['.gnupg'],
    ['Library', 'Keychains'],
    ['.local', 'share', 'keyrings'],
  ].map((parts) => join(homeReal, ...parts));
  // Both spellings of each root: as named, and resolved (a root such as ~/.agentlink may itself be
  // a link to another folder; IR-M1-9t-1 L-1). A root that does not exist is checked as named.
  const forbidden: string[] = [];
  for (const root of roots) {
    forbidden.push(root);
    try {
      forbidden.push(await realpath(root));
    } catch {
      // Not there: only the named spelling applies.
    }
  }
  for (const root of forbidden) {
    if (dir === root || dir.startsWith(`${root}${sep}`)) throw new HarnessError('unsafe_path');
  }
  const path = join(dir, name);
  const inHome = relative(homeReal, path);
  const display =
    inHome !== '' && !inHome.startsWith('..') && !isAbsolute(inHome)
      ? `~/${inHome.split(sep).join('/')}`
      : path;
  return Object.freeze({ dir, name, display });
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** True when `name` is a file in a PATH folder. Relative PATH entries are ignored. */
async function onPath(
  name: string,
  env: HarnessContext['env'],
  platform: NodeJS.Platform,
): Promise<boolean> {
  const folders = (env['PATH'] ?? '').split(delimiter).filter((p) => p !== '' && isAbsolute(p));
  const names = platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const folder of folders) {
    for (const candidate of names) {
      try {
        if ((await stat(join(folder, candidate))).isFile()) return true;
      } catch {
        // not here
      }
    }
  }
  return false;
}

/** The harnesses that look installed on this computer, in table order. */
export async function detectHarnesses(context: HarnessContext): Promise<HarnessDef[]> {
  const found: HarnessDef[] = [];
  for (const def of HARNESSES) {
    let installed = false;
    for (const mark of def.installedMarks) {
      if (await exists(join(context.home, ...mark))) installed = true;
    }
    installed ||= await onPath(def.binary, context.env, context.platform ?? process.platform);
    if (installed) found.push(def);
  }
  return found;
}

export type HarnessPlan =
  | {
      readonly status: 'change';
      readonly def: HarnessDef;
      readonly before: ConfigFile;
      readonly text: string;
      /** The exact diff, as display lines. */
      readonly diff: readonly string[];
    }
  /** AgentLink is already configured there, as it would write it. */
  | { readonly status: 'present'; readonly def: HarnessDef }
  /** An `agentlink` entry exists and differs: left alone. */
  | { readonly status: 'conflict'; readonly def: HarnessDef }
  /** Refused with a reason (unsafe path, malformed file, form that cannot be edited exactly). */
  | { readonly status: 'blocked'; readonly def: HarnessDef; readonly reason: HarnessErrorCode };

/** The folder and parts of the file to read and write: the default, or the `--config` target. */
function where(def: HarnessDef, context: HarnessContext): [string, readonly string[]] {
  const config = context.config;
  if (config === undefined) return [context.home, def.parts];
  if (!(CONFIG_PATH_HARNESSES as readonly string[]).includes(def.id)) {
    throw new HarnessError('unsafe_path');
  }
  return [config.dir, [config.name]];
}

/** Reads the harness's config and works out the exact change, without writing anything. */
export async function planHarness(def: HarnessDef, context: HarnessContext): Promise<HarnessPlan> {
  // CLAUDE_CONFIG_DIR moves Claude Code's files; a write to ~/.claude.json would report success on a
  // file it does not read. It is not followed (an environment value must not move a write): refused.
  if (def.id === 'claude-code' && (context.env['CLAUDE_CONFIG_DIR'] ?? '') !== '') {
    return { status: 'blocked', def, reason: 'unsupported_format' };
  }
  try {
    const before = await readConfigFile(...where(def, context), context);
    const edit = def.edit(before.text, mcpArgs(context.agent));
    if (edit.status === 'present') return { status: 'present', def };
    if (edit.status === 'conflict') return { status: 'conflict', def };
    return {
      status: 'change',
      def,
      before,
      text: edit.text,
      diff: unifiedDiff(before.text ?? '', edit.text, displayPath(def, context.config)),
    };
  } catch (error) {
    if (error instanceof HarnessError) return { status: 'blocked', def, reason: error.code };
    throw error;
  }
}

/** Writes a planned change (atomic, with a backup). Returns the backup's file name, if any. */
export async function applyHarness(
  plan: Extract<HarnessPlan, { status: 'change' }>,
  context: HarnessContext,
): Promise<{ backup: string | undefined }> {
  const [base, parts] = where(plan.def, context);
  return writeConfigFile(base, parts, plan.before, plan.text, context);
}
