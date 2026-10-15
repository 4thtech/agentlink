// The harnesses `init` configures in M1a: Claude Code, Codex and Gemini CLI (06 §7, D-73 (7)).
// Each is a fixed table entry: where its config lives under the home folder, how to tell it is
// installed, and how the `agentlink` MCP entry is added. Paths never come from input or from the
// environment (CODEX_HOME and similar overrides are not followed: a variable the agent can set must
// not move a write). The entry runs `npx -y @4thtech/agentlink mcp`, as 06 §7 shows for every
// harness; a non-default agent adds `--agent <name>` (the name is checked against 06 §6 first).
// Claude Desktop and the printed snippets for Antigravity, Cursor, VS Code, Windsurf and Cline are
// not part of this card's M1a scope (M1-9a lists them; they follow in M1b).
//
// Nothing here puts a secret in a config: the entry holds the command and its arguments only.
import { lstat, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { unifiedDiff } from './diff.js';
import { HarnessError, type HarnessErrorCode } from './errors.js';
import { readConfigFile, writeConfigFile, type ConfigFile, type FileOptions } from './files.js';
import { addJsonMcpServer } from './json-config.js';
import { addTomlMcpServer, agentlinkTable } from './toml-config.js';

export type HarnessId = 'claude-code' | 'codex' | 'gemini-cli';

export const PACKAGE_NAME = '@4thtech/agentlink';

export interface HarnessContext extends FileOptions {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  /** The local agent name when it is not the default one. Already checked against 06 §6. */
  readonly agent?: string;
  /** Unix seconds, for the backup's name. */
  readonly now: number;
}

interface HarnessDef {
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
]);

/** `~/.codex/config.toml`: how a config path is shown to the user. */
export function displayPath(def: HarnessDef): string {
  return `~/${def.parts.join('/')}`;
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

/** Reads the harness's config and works out the exact change, without writing anything. */
export async function planHarness(def: HarnessDef, context: HarnessContext): Promise<HarnessPlan> {
  // CLAUDE_CONFIG_DIR moves Claude Code's files; a write to ~/.claude.json would report success on a
  // file it does not read. It is not followed (an environment value must not move a write): refused.
  if (def.id === 'claude-code' && (context.env['CLAUDE_CONFIG_DIR'] ?? '') !== '') {
    return { status: 'blocked', def, reason: 'unsupported_format' };
  }
  try {
    const before = await readConfigFile(context.home, def.parts, context);
    const edit = def.edit(before.text, mcpArgs(context.agent));
    if (edit.status === 'present') return { status: 'present', def };
    if (edit.status === 'conflict') return { status: 'conflict', def };
    return {
      status: 'change',
      def,
      before,
      text: edit.text,
      diff: unifiedDiff(before.text ?? '', edit.text, displayPath(def)),
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
  return writeConfigFile(context.home, plan.def.parts, plan.before, plan.text, context);
}
