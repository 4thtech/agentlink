// M1-UX-MULTI-AGENT: why an existing `agentlink` entry in an app's settings differs from the one
// `init` would write, in a form that is safe to show. Only the agent name (when it is a valid local
// name, 06 §6) is ever taken from the file; the command, URLs and other values are never returned.
import { DEFAULT_AGENT_NAME, isAgentName } from '../runtime/agent-name.js';
import { isPlain } from './json-config.js';

/** How the existing entry differs. Names are valid local agent names, nothing else from the file. */
export type ConflictDifference =
  | { readonly kind: 'other_agent'; readonly existing: string; readonly wanted: string }
  /** It starts AgentLink in another way (an older command, another version, another program). */
  | { readonly kind: 'other_command' }
  | { readonly kind: 'unknown' };

function agentOf(tokens: readonly string[]): string | undefined {
  const at = tokens.indexOf('--agent');
  if (at < 0) return DEFAULT_AGENT_NAME;
  const value = tokens[at + 1];
  return isAgentName(value) ? value : undefined;
}

/** Compares the words of the start command (program and arguments) of the entry with ours. */
function classify(existing: readonly string[], ours: readonly string[]): ConflictDifference {
  const runsMcp = existing.includes('mcp') && existing.some((t) => t.includes('agentlink'));
  if (!runsMcp) return { kind: 'other_command' };
  const was = agentOf(existing);
  const wanted = agentOf(ours) ?? DEFAULT_AGENT_NAME;
  if (was === undefined) return { kind: 'unknown' };
  if (was !== wanted) return { kind: 'other_agent', existing: was, wanted };
  return { kind: 'other_command' };
}

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((v): v is string => typeof v === 'string')
    ? [...value]
    : undefined;

/** The words of a JSON entry: `command` + `args`, or OpenCode's `command` array. */
function entryWords(entry: unknown): string[] | undefined {
  if (!isPlain(entry)) return undefined;
  const command = entry['command'];
  if (typeof command === 'string') {
    const args = entry['args'] === undefined ? [] : strings(entry['args']);
    return args === undefined ? undefined : [command, ...args];
  }
  return strings(command);
}

/** JSON config (`mcpServers` or `mcp`): `text` is the file, `args` what `init` would start with. */
export function explainJsonConflict(
  text: string | undefined,
  key: 'mcpServers' | 'mcp',
  args: readonly string[],
): ConflictDifference {
  try {
    const parsed: unknown = JSON.parse(text ?? '');
    const servers = isPlain(parsed) ? parsed[key] : undefined;
    const words = isPlain(servers) ? entryWords(servers['agentlink']) : undefined;
    return words === undefined ? { kind: 'unknown' } : classify(words, ['npx', ...args]);
  } catch {
    return { kind: 'unknown' };
  }
}

/** Codex's TOML: reads the `command` and `args` lines of `[mcp_servers.agentlink]`. */
export function explainTomlConflict(
  text: string | undefined,
  args: readonly string[],
): ConflictDifference {
  const lines = (text ?? '').replaceAll('\r\n', '\n').split('\n');
  const start = lines.findIndex((l) => l.trim() === '[mcp_servers.agentlink]');
  if (start < 0) return { kind: 'unknown' };
  const words: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) break;
    const command = /^command\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(trimmed);
    const list = /^args\s*=\s*(\[.*\])\s*(?:#.*)?$/.exec(trimmed);
    try {
      if (command?.[1] !== undefined) {
        const value: unknown = JSON.parse(command[1]);
        if (typeof value === 'string') words.unshift(value);
      } else if (list?.[1] !== undefined) {
        const value = strings(JSON.parse(list[1]));
        if (value !== undefined) words.push(...value);
      }
    } catch {
      return { kind: 'unknown' };
    }
  }
  return words.length === 0 ? { kind: 'unknown' } : classify(words, ['npx', ...args]);
}
