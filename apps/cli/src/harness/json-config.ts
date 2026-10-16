// Adding the `agentlink` MCP server to a JSON harness config (Claude Code's `~/.claude.json`,
// Gemini CLI's `~/.gemini/settings.json`, Antigravity's `mcp_config.json` under `mcpServers`, and
// OpenCode's `opencode.json` under `mcp`; 06 §7, D-78). The file is edited only when the edit is exact and
// additive: the text must be what `JSON.stringify` would print for its own contents (so nothing the
// user wrote, such as comments, number forms or ordering, is lost), and the new entry is added as the
// first key of its object so no existing line changes. Anything else is refused, never rewritten.
import { HarnessError } from './errors.js';

export type JsonEdit =
  | { readonly status: 'change'; readonly text: string }
  /** The entry is already there, exactly as AgentLink would write it. Nothing to do. */
  | { readonly status: 'present' }
  /** An `agentlink` entry exists and differs. It is the user's; it is left alone. */
  | { readonly status: 'conflict' };

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Plain = { [key: string]: Json };

const isPlain = (value: unknown): value is Plain =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => same(item, b[index]))
    );
  }
  if (isPlain(a) && isPlain(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => k in b && same(a[k], b[k]));
  }
  return a === b;
}

const INDENTS: readonly (number | string)[] = [2, 4, '\t'];

/** The indent and final-newline form under which `text` is exactly `JSON.stringify`'s output. */
function canonicalForm(
  text: string,
  value: unknown,
): { indent: number | string; newline: boolean } | undefined {
  for (const indent of INDENTS) {
    const printed = JSON.stringify(value, null, indent);
    if (text === printed) return { indent, newline: false };
    if (text === `${printed}\n`) return { indent, newline: true };
  }
  return undefined;
}

/**
 * The new text of a JSON config with `mcpServers.agentlink` set to `entry`. `text` is undefined when
 * the file does not exist yet (the new file is the entry alone).
 */
export function addJsonMcpServer(
  text: string | undefined,
  entry: Plain,
  key: 'mcpServers' | 'mcp' = 'mcpServers',
): JsonEdit {
  if (text === undefined) {
    return {
      status: 'change',
      text: `${JSON.stringify({ [key]: { agentlink: entry } }, null, 2)}\n`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HarnessError('malformed');
  }
  if (!isPlain(parsed)) throw new HarnessError('malformed');
  const form = canonicalForm(text, parsed);
  if (form === undefined) throw new HarnessError('unsupported_format');

  const servers = parsed[key];
  let next: Plain;
  if (servers === undefined) {
    next = Object.fromEntries([[key, { agentlink: entry }], ...Object.entries(parsed)]);
  } else {
    if (!isPlain(servers)) throw new HarnessError('unsupported_format');
    if (Object.hasOwn(servers, 'agentlink')) {
      return same(servers['agentlink'], entry) ? { status: 'present' } : { status: 'conflict' };
    }
    const merged = Object.fromEntries([['agentlink', entry], ...Object.entries(servers)]);
    next = Object.fromEntries(
      Object.entries(parsed).map(([name, value]): [string, Json] => [
        name,
        name === key ? merged : value,
      ]),
    );
  }
  return {
    status: 'change',
    text: `${JSON.stringify(next, null, form.indent)}${form.newline ? '\n' : ''}`,
  };
}
