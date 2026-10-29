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
import { HarnessError } from './errors.js';
import { mcpArgs, type HarnessDef } from './harnesses.js';
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

/** What the `agentlink` member of a config is, as far as the app may know. */
export type EntryState =
  | { readonly kind: 'none' }
  /** Exactly the entry AgentLink writes for `agent` (a valid local agent name). */
  | { readonly kind: 'agent'; readonly agent: string; readonly entry: Plain }
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
export function agentlinkEntry(def: HarnessDef, agent: string): Plain {
  const args = agentlinkArgs(agent);
  return def.format.kind === 'json' ? def.format.entry(args) : { command: 'npx', args };
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

/** The forms AgentLink writes for `agent`: ours, and for `default` also with `--agent default`. */
function oursFor(def: HarnessDef, agent: string): Plain[] {
  const forms = [agentlinkEntry(def, agent)];
  if (agent === DEFAULT_AGENT_NAME && def.format.kind === 'json') {
    forms.push(def.format.entry([...mcpArgs(DEFAULT_AGENT_NAME)]));
  }
  return forms;
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

function jsonState(def: HarnessDef, text: string): EntryState {
  const { servers } = parseJsonConfig(def, text);
  if (servers === undefined || !Object.hasOwn(servers, 'agentlink')) return NONE;
  const entry = servers['agentlink'] as Json;
  const agent = candidateAgent(wordsOf(entry));
  if (agent === undefined) return FOREIGN;
  if (!oursFor(def, agent).some((form) => same(entry, form))) return FOREIGN;
  // A copy of an entry known to be exactly ours: it holds no other value of the file.
  return Object.freeze({ kind: 'agent', agent, entry: JSON.parse(JSON.stringify(entry)) as Plain });
}

const TOML_HEADER = '[mcp_servers.agentlink]';
const TOML_ARGS = /^args = (\[.*\])$/;

interface TomlTable {
  /** The index of the header line in `lines` (split on `\n`; a CRLF line keeps its `\r`). */
  readonly at: number;
  readonly agent: string;
}

/** Codex: the one `[mcp_servers.agentlink]` table, when it is exactly the three lines we write. */
function tomlTable(text: string): TomlTable | 'none' | 'foreign' {
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
  const table = agentlinkTable('npx', agentlinkArgs(agent));
  if (lines.slice(at, at + 3).join('\n') !== table.join('\n')) return 'foreign';
  return { at, agent };
}

/**
 * The `agentlink` entry of this harness's config text (`undefined`: no file), entry-only. Throws
 * `malformed` or `unsupported_format` for a file the app cannot read or rewrite exactly.
 */
export function readEntryState(def: HarnessDef, text: string | undefined): EntryState {
  if (text === undefined) return NONE;
  if (def.format.kind === 'json') return jsonState(def, text);
  if (text === '') return NONE;
  const table = tomlTable(text);
  if (table === 'none') return NONE;
  if (table === 'foreign') return FOREIGN;
  return Object.freeze({
    kind: 'agent',
    agent: table.agent,
    entry: agentlinkEntry(def, table.agent),
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
function rewriteToml(text: string, agent: string | undefined): string {
  const table = tomlTable(text);
  if (table === 'none' || table === 'foreign') throw new HarnessError('changed');
  const crlf = text.includes('\r\n');
  const lines = text.split('\n');
  const replacement =
    agent === undefined
      ? []
      : agentlinkTable('npx', agentlinkArgs(agent)).map((line) => (crlf ? `${line}\r` : line));
  lines.splice(table.at, 3, ...replacement);
  return lines.join('\n');
}

/**
 * The config text with this harness running `agent`: added when there is no entry, replaced when
 * the entry is AgentLink's for another agent (a move). A foreign entry is never touched: `changed`.
 */
export function setEntry(def: HarnessDef, text: string | undefined, agent: string): string {
  const state = readEntryState(def, text);
  if (state.kind === 'foreign') throw new HarnessError('changed');
  if (state.kind === 'none') {
    const edit =
      def.format.kind === 'json'
        ? addJsonMcpServer(text, agentlinkEntry(def, agent), def.format.key)
        : addTomlMcpServer(text, agentlinkTable('npx', agentlinkArgs(agent)));
    if (edit.status !== 'change') throw new HarnessError('changed');
    return edit.text;
  }
  if (text === undefined) throw new HarnessError('changed');
  return def.format.kind === 'json'
    ? rewriteJson(def, text, agentlinkEntry(def, agent))
    : rewriteToml(text, agent);
}

/** The config text without AgentLink's entry. Only an entry AgentLink wrote is removed. */
export function removeEntry(def: HarnessDef, text: string | undefined): string {
  const state = readEntryState(def, text);
  if (state.kind !== 'agent' || text === undefined) throw new HarnessError('changed');
  return def.format.kind === 'json'
    ? rewriteJson(def, text, undefined)
    : rewriteToml(text, undefined);
}
