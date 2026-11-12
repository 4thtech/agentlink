// U3-f (S2; 04 §2.5 "Writing AI app configs"; 06 §7 "The app as a second path"; 08 §1 "Entry-only
// config display"; proposed, owner confirms at merge): the local app's entry-only view of an AI app
// config, and the exact replace and remove of its `agentlink` entry.
//
// - These files hold other servers' entries and their secrets. Only the `agentlink` member is ever
//   read out, and only when it is exactly what AgentLink writes for a valid local agent name (06 §6:
//   `npx -y @4thtech-io/agentlink mcp`, plus `--agent <name>` for any agent but `default`). Then it is
//   that agent's entry and holds no secret. Any other `agentlink` entry is `foreign`: a conflict with
//   manual steps, and nothing of it is returned (not its command, arguments or environment).
// - A change rewrites only that member. JSON: the file must be exactly `JSON.stringify` of its own
//   contents (json-config.ts canonicalForm), so re-printing keeps every other member's bytes. Codex
//   TOML: the three lines AgentLink writes are replaced or removed; no other line changes.
// - Errors are HarnessError codes with fixed text: never a path, a value or file content (I-7).
// - WP-D7 (plan 2026-11-12 Decision 2): the app form is ours too: `<node> <cli> mcp [--agent <name>]`
//   with the AgentLink desktop app's bundled Node and CLI (desktop-app.ts), on Windows `node.exe`
//   itself (no `cmd /c`). It is recognised only for the app this computer has (`options.app`): an
//   entry pointing at any other program stays foreign. The npx forms stay recognised as before.
import { appMcpWords, type AppStart } from './desktop-app.js';
import { HarnessError } from './errors.js';
import { mcpArgs, startWords, tomlTableFor, type HarnessDef } from './harnesses.js';
import {
  addJsonMcpServer,
  canonicalForm,
  isPlain,
  same,
  type Json,
  type Plain,
} from './json-config.js';
import { addTomlMcpServer, agentlinkTable, scanToml } from './toml-config.js';
import { DEFAULT_AGENT_NAME, isAgentName } from '../runtime/agent-name.js';

/** How an entry of ours starts AgentLink: `npx …`, or the desktop app's bundled Node and CLI. */
export type EntryForm = 'npx' | 'app';

/** WP-D7: which forms count as ours, and which one a written entry gets. */
export interface EntryOptions {
  /** The desktop app on this computer: its form is recognised (and written when `form` is 'app'). */
  readonly app?: AppStart;
  /** The form a written entry gets. Default: the form the entry has now, else `npx`. */
  readonly form?: EntryForm;
}

/** What the `agentlink` member of a config is, as far as the app may know. */
export type EntryState =
  | { readonly kind: 'none' }
  /** Exactly the entry AgentLink writes for `agent` (a valid local agent name), in `form`. */
  | {
      readonly kind: 'agent';
      readonly agent: string;
      readonly entry: Plain;
      readonly form: EntryForm;
    }
  /** An entry AgentLink did not write: left alone, nothing of it is shown. */
  | { readonly kind: 'foreign' };

const NONE: EntryState = Object.freeze({ kind: 'none' });
const FOREIGN: EntryState = Object.freeze({ kind: 'foreign' });

/** The entry's arguments for `agent` (06 §7): `default` has no `--agent`, as `init` writes it. */
export function agentlinkArgs(agent: string): string[] {
  if (!isAgentName(agent)) throw new HarnessError('unsafe_path');
  return mcpArgs(agent === DEFAULT_AGENT_NAME ? undefined : agent);
}

/** The exact entry AgentLink writes for `agent` in this harness (TOML: its `command` and `args`). */
export function agentlinkEntry(
  def: HarnessDef,
  agent: string,
  platform: NodeJS.Platform = process.platform,
): Plain {
  const args = agentlinkArgs(agent);
  if (def.format.kind === 'json') return def.format.entry(args, platform);
  const [command = 'npx', ...rest] = startWords(args, platform);
  return { command, args: rest };
}

/** WP-D7: the app-form entry for `agent`: the app's own Node runs its CLI; no shell, no npx. */
export function appEntry(def: HarnessDef, agent: string, start: AppStart): Plain {
  if (!isAgentName(agent)) throw new HarnessError('unsafe_path');
  const { command, args } = appMcpWords(start, agent === DEFAULT_AGENT_NAME ? undefined : agent);
  if (def.format.kind === 'json') return def.format.shape(command, args);
  return { command, args };
}

/** The entry of `form` for `agent` (the app form needs the app). */
export function entryOf(def: HarnessDef, agent: string, form: EntryForm, app?: AppStart): Plain {
  if (form === 'npx') return agentlinkEntry(def, agent);
  if (app === undefined) throw new HarnessError('unsafe_path');
  return appEntry(def, agent, app);
}

/** Codex's three table lines for `agent` in `form`. */
function tomlLinesOf(agent: string, form: EntryForm, app?: AppStart): string[] {
  if (form === 'npx') return tomlTableFor(agentlinkArgs(agent));
  if (app === undefined || !isAgentName(agent)) throw new HarnessError('unsafe_path');
  const { command, args } = appMcpWords(app, agent === DEFAULT_AGENT_NAME ? undefined : agent);
  return agentlinkTable(command, args);
}

/** The agent an entry's words name: the value after `--agent`, else `default`. */
function candidateAgent(words: readonly unknown[]): string | undefined {
  const at = words.indexOf('--agent');
  if (at < 0) return DEFAULT_AGENT_NAME;
  const value = words[at + 1];
  return typeof value === 'string' && isAgentName(value) ? value : undefined;
}

function wordsOf(entry: Json): readonly unknown[] {
  if (!isPlain(entry)) return [];
  const args = entry['args'];
  if (Array.isArray(args)) return args;
  const command = entry['command'];
  return Array.isArray(command) ? command : [];
}

const PLATFORMS: readonly NodeJS.Platform[] = ['win32', 'linux'];

/**
 * The npx forms AgentLink writes for `agent`: ours, and for `default` also with `--agent default`.
 * Both start forms count (`npx …` and Windows' `cmd /c npx …`), so an entry written before a system
 * switched forms (or copied between systems) is still ours; the next write brings it to this system's.
 */
function oursFor(def: HarnessDef, agent: string): Plain[] {
  const forms: Plain[] = [];
  for (const platform of PLATFORMS) {
    forms.push(agentlinkEntry(def, agent, platform));
    if (agent === DEFAULT_AGENT_NAME && def.format.kind === 'json') {
      forms.push(def.format.entry([...mcpArgs(DEFAULT_AGENT_NAME)], platform));
    }
  }
  return forms;
}

/** The form of an entry that is exactly one of ours, or `undefined`. */
function formOf(
  def: HarnessDef,
  agent: string,
  entry: Json,
  app: AppStart | undefined,
): EntryForm | undefined {
  if (oursFor(def, agent).some((form) => same(entry, form))) return 'npx';
  if (app !== undefined && same(entry, appEntry(def, agent, app))) return 'app';
  return undefined;
}

interface ParsedJson {
  readonly parsed: Plain;
  readonly form: { readonly indent: number | string; readonly newline: boolean };
  readonly servers: Plain | undefined;
}

function parseJsonConfig(def: HarnessDef, text: string): ParsedJson {
  if (def.format.kind !== 'json') throw new HarnessError('unsupported_format');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HarnessError('malformed');
  }
  if (!isPlain(parsed)) throw new HarnessError('malformed');
  const form = canonicalForm(text, parsed);
  if (form === undefined) throw new HarnessError('unsupported_format');
  const servers = parsed[def.format.key];
  if (servers !== undefined && !isPlain(servers)) throw new HarnessError('unsupported_format');
  return { parsed, form, servers };
}

function jsonState(def: HarnessDef, text: string, app: AppStart | undefined): EntryState {
  const { servers } = parseJsonConfig(def, text);
  if (servers === undefined || !Object.hasOwn(servers, 'agentlink')) return NONE;
  const entry = servers['agentlink'] as Json;
  const agent = candidateAgent(wordsOf(entry));
  if (agent === undefined) return FOREIGN;
  const form = formOf(def, agent, entry, app);
  if (form === undefined) return FOREIGN;
  // A copy of an entry known to be exactly ours: it holds no other value of the file.
  return Object.freeze({
    kind: 'agent',
    agent,
    entry: JSON.parse(JSON.stringify(entry)) as Plain,
    form,
  });
}

const TOML_HEADER = '[mcp_servers.agentlink]';
const TOML_ARGS = /^args = (\[.*\])$/;

interface TomlTable {
  /** The index of the header line in `lines` (split on `\n`; a CRLF line keeps its `\r`). */
  readonly at: number;
  readonly agent: string;
  readonly form: EntryForm;
}

/** Codex: the one `[mcp_servers.agentlink]` table, when it is exactly the three lines we write. */
function tomlTable(text: string, app: AppStart | undefined): TomlTable | 'none' | 'foreign' {
  const paths = scanToml(text).paths;
  const ours = paths.filter((p) => p.path[0] === 'mcp_servers');
  // `mcp_servers = { … }` as one value: an agentlink entry inside it cannot be told apart.
  if (ours.some((p) => p.path.length === 1 && p.kind === 'key')) {
    throw new HarnessError('unsupported_format');
  }
  const agentlink = ours.filter((p) => p.path[1] === 'agentlink');
  if (agentlink.length === 0) return 'none';
  const shape = agentlink.map((p) => `${p.kind}:${p.path.join('.')}`).sort();
  const expected = [
    'key:mcp_servers.agentlink.args',
    'key:mcp_servers.agentlink.command',
    'table:mcp_servers.agentlink',
  ];
  if (shape.join('|') !== expected.join('|')) return 'foreign';
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  const headers = lines.flatMap((line, index) => (line === TOML_HEADER ? [index] : []));
  if (headers.length !== 1) return 'foreign';
  const at = headers[0] as number;
  const argsLine = TOML_ARGS.exec(lines[at + 2] ?? '');
  if (argsLine?.[1] === undefined) return 'foreign';
  let words: unknown;
  try {
    words = JSON.parse(argsLine[1]);
  } catch {
    return 'foreign';
  }
  if (!Array.isArray(words)) return 'foreign';
  const agent = candidateAgent(words);
  if (agent === undefined) return 'foreign';
  const found = lines.slice(at, at + 3).join('\n');
  const tables = PLATFORMS.map((p) => tomlTableFor(agentlinkArgs(agent), p).join('\n'));
  if (tables.includes(found)) return { at, agent, form: 'npx' };
  if (app !== undefined && tomlLinesOf(agent, 'app', app).join('\n') === found) {
    return { at, agent, form: 'app' };
  }
  return 'foreign';
}

/**
 * The `agentlink` entry of this harness's config text (`undefined`: no file), entry-only. Throws
 * `malformed` or `unsupported_format` for a file the app cannot read or rewrite exactly.
 */
export function readEntryState(
  def: HarnessDef,
  text: string | undefined,
  options: EntryOptions = {},
): EntryState {
  if (text === undefined) return NONE;
  if (def.format.kind === 'json') return jsonState(def, text, options.app);
  if (text === '') return NONE;
  const table = tomlTable(text, options.app);
  if (table === 'none') return NONE;
  if (table === 'foreign') return FOREIGN;
  return Object.freeze({
    kind: 'agent',
    agent: table.agent,
    entry: entryOf(def, table.agent, table.form, options.app),
    form: table.form,
  });
}

function printJson(parsed: Plain, form: ParsedJson['form']): string {
  return `${JSON.stringify(parsed, null, form.indent)}${form.newline ? '\n' : ''}`;
}

/** The JSON text with the `agentlink` member replaced in place (`entry`) or removed (`undefined`). */
function rewriteJson(def: HarnessDef, text: string, entry: Plain | undefined): string {
  const { parsed, form, servers } = parseJsonConfig(def, text);
  if (def.format.kind !== 'json' || servers === undefined) throw new HarnessError('changed');
  const key = def.format.key;
  const nextServers: Plain = Object.fromEntries(
    Object.entries(servers).flatMap(([name, value]): [string, Json][] =>
      name !== 'agentlink' ? [[name, value]] : entry === undefined ? [] : [[name, entry]],
    ),
  );
  const next: Plain = Object.fromEntries(
    Object.entries(parsed).map(([name, value]): [string, Json] => [
      name,
      name === key ? nextServers : value,
    ]),
  );
  return printJson(next, form);
}

/** Codex: the three table lines replaced (`agent`) or removed (`undefined`); other lines unchanged. */
function rewriteToml(
  text: string,
  agent: string | undefined,
  form: EntryForm,
  app: AppStart | undefined,
): string {
  const table = tomlTable(text, app);
  if (table === 'none' || table === 'foreign') throw new HarnessError('changed');
  const crlf = text.includes('\r\n');
  const lines = text.split('\n');
  const replacement =
    agent === undefined
      ? []
      : tomlLinesOf(agent, form, app).map((line) => (crlf ? `${line}\r` : line));
  lines.splice(table.at, 3, ...replacement);
  return lines.join('\n');
}

/**
 * The config text with this harness running `agent`: added when there is no entry, replaced when
 * the entry is AgentLink's for another agent (a move) or in another form (WP-D7 "Use the app").
 * A foreign entry is never touched: `changed`.
 */
export function setEntry(
  def: HarnessDef,
  text: string | undefined,
  agent: string,
  options: EntryOptions = {},
): string {
  const state = readEntryState(def, text, options);
  if (state.kind === 'foreign') throw new HarnessError('changed');
  const form = options.form ?? (state.kind === 'agent' ? state.form : 'npx');
  if (state.kind === 'none') {
    const edit =
      def.format.kind === 'json'
        ? addJsonMcpServer(text, entryOf(def, agent, form, options.app), def.format.key)
        : addTomlMcpServer(text, tomlLinesOf(agent, form, options.app));
    if (edit.status !== 'change') throw new HarnessError('changed');
    return edit.text;
  }
  if (text === undefined) throw new HarnessError('changed');
  return def.format.kind === 'json'
    ? rewriteJson(def, text, entryOf(def, agent, form, options.app))
    : rewriteToml(text, agent, form, options.app);
}

/** The config text without AgentLink's entry. Only an entry AgentLink wrote is removed. */
export function removeEntry(
  def: HarnessDef,
  text: string | undefined,
  options: EntryOptions = {},
): string {
  const state = readEntryState(def, text, options);
  if (state.kind !== 'agent' || text === undefined) throw new HarnessError('changed');
  return def.format.kind === 'json'
    ? rewriteJson(def, text, undefined)
    : rewriteToml(text, undefined, 'npx', options.app);
}
