// W4-RENAME-REACHES-CONTACTS (S2; D-141 (2); 04 §2.5.1 `agent.label`, §3.1.1 "Epoch advance"; I-4):
// renames stay owner-only, in the app. No MCP tool and no CLI command renames an agent, changes its
// card or advances its key epoch.
//
// - MCP surface: no registered tool's name or description offers a rename, a label or a key
//   rotation, and no source reachable from packages/mcp-tools/src names the epoch control, the
//   rotation, the label prepare or the rename gesture (comments excluded); ToolContext reaches no
//   KeyEpochControl method.
// - CLI surface: no registered command or subcommand renames the agent or rotates its keys
//   (`contacts rename` names a contact, an owner alias, and stays).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { KeyEpochControl } from '@4thtech-io/crypto';
import type { ToolContext } from '@4thtech-io/mcp-tools';
import { TOOLS } from '@4thtech-io/mcp-tools/registry.js';
import { COMMANDS } from '../src/dispatch.js';

const TOOLS_DIR = fileURLToPath(new URL('../../../packages/mcp-tools/src/', import.meta.url));
const RELATIVE = /(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;
/** What would reach a rename or a rotation from a tool module. */
const RENAME_NAME =
  /epochcontrol|advanceepoch|previewepoch|\.rotate\(|preparelabel|renameagent|signrename|epochkeys|agent\.label/i;

type Depth = [never, 0, 1, 2, 3, 4];
/** Every property name reachable in T through objects and function results (bounded depth). */
type DeepKeys<T, D extends number = 4> = [D] extends [never]
  ? never
  : T extends string | number | boolean | bigint | symbol | null | undefined | Uint8Array
    ? never
    : T extends (...args: never[]) => infer R
      ? DeepKeys<Awaited<R>, Depth[D]>
      : T extends object
        ? { [K in keyof T & string]-?: K | DeepKeys<T[K], Depth[D]> }[keyof T & string]
        : never;

const isSource = (name: string): boolean => name.endsWith('.ts') && !name.endsWith('.test.ts');

function listSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__snapshots__' ? [] : listSources(path);
    return isSource(entry.name) ? [path] : [];
  });
}

function toolGraph(): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = listSources(TOOLS_DIR);
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const text = readFileSync(file, 'utf8');
    seen.set(file, text);
    for (const match of text.matchAll(RELATIVE)) {
      const target = resolve(dirname(file), match[1]!.replace(/\.js$/, '.ts'));
      if (target.startsWith(TOOLS_DIR) && isSource(target)) queue.push(target);
    }
  }
  return seen;
}

/** Line and block comments removed (prose may name what the code must not reach). */
const withoutComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

describe('no MCP tool renames an agent or rotates its keys (D-141, I-4)', () => {
  it('no tool name or description offers a rename, a label or a rotation', () => {
    expect(TOOLS.length).toBeGreaterThan(5);
    for (const tool of TOOLS) {
      expect(tool.name).not.toMatch(/rename|label|rotat|epoch/i);
      expect(String(tool.description)).not.toMatch(/rename (your|the|this) agent|rotat|key epoch/i);
    }
  });

  it('no source reachable from the tool modules names the epoch control or the rename gesture', () => {
    const graph = toolGraph();
    expect(graph.size).toBeGreaterThan(20);
    for (const [file, text] of graph) {
      expect(withoutComments(text), file).not.toMatch(RENAME_NAME);
    }
  });

  it('ToolContext reaches no KeyEpochControl method (type level)', () => {
    expectTypeOf<Extract<DeepKeys<ToolContext>, keyof KeyEpochControl>>().toEqualTypeOf<never>();
    expectTypeOf<'client'>().toExtend<DeepKeys<ToolContext>>();
    expectTypeOf<string>().not.toExtend<DeepKeys<ToolContext>>();
  });
});

describe('no CLI command renames an agent or rotates its keys (D-141 (2))', () => {
  it('no registered command is a rename, a label or a rotation', () => {
    for (const command of COMMANDS) {
      expect(command.name).not.toMatch(/rename|label|rotat|epoch/i);
    }
  });
});
