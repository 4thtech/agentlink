// The import fence of M1-9i-b2 (04 §2.3.3 "Security properties", I-4: no MCP tool may export keys or
// add storage credentials): no MCP tool handler reaches KeyExportControl, KeyImportControl or
// StorageCredentialControl. The tool modules (packages/mcp-tools/src/, 06 §1) are what the MCP server calls, and
// ToolContext is all they are given, so the fence has two halves:
//
// - static: every source file reachable from packages/mcp-tools/src/ by relative imports names none of the three
//   controls and none of their factories (any identifier containing `exportControl`,
//   `importControl` or `credentialControl`, in any case; the M1-9i-c backends name theirs so), and
//   imports neither @4thtech-io/node (where the backends live) nor @4thtech-io/crypto/keystore;
// - type level: no property path of ToolContext reaches a method of the three controls.
//
// The ESLint tool-module zone (eslint.config.mjs) already keeps @4thtech-io/node and relative
// escapes out of packages/mcp-tools/src/; this test also covers a type-only reference, which lint allows.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  KeyExportControl,
  KeyImportControl,
  StorageCredentialControl,
} from '@4thtech-io/crypto';
import type { ToolContext } from '@4thtech-io/mcp-tools';

const TOOLS_DIR = fileURLToPath(new URL('../../../packages/mcp-tools/src/', import.meta.url));

/** Any identifier naming one of the controls or a factory of one. */
const CONTROL_NAME = /(?:export|import|credential)control/i;
const FENCED_IMPORT = /from\s+['"]@4thtech-io\/(?:node|crypto\/keystore)(?:\/[^'"]*)?['"]/;
const RELATIVE = /(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;

const isSource = (name: string): boolean => name.endsWith('.ts') && !name.endsWith('.test.ts');

function listSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__snapshots__' ? [] : listSources(path);
    return isSource(entry.name) ? [path] : [];
  });
}

/** The tool modules and every file they reach by a relative import, transitively. */
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

/**
 * The source without its comments (comments are prose about the controls, not references to them).
 * A small lexer, not a regex (AUDIT-FABLE-M1-9i-b2-1 Low): string, template and regex literals are
 * kept verbatim and never read as the start of a comment, so `'//'` or `'/*'` in a string cannot hide
 * the code after it. A `/` starts a regex literal after an operator or bracket, else it is division.
 */
function code(text: string): string {
  let out = '';
  let i = 0;
  let last = ''; // the last significant character of code, for the regex-or-division choice
  const literal = (end: string): void => {
    const start = i;
    i += 1;
    let inClass = false;
    while (i < text.length) {
      const c = text[i]!;
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (end === '/' && (c === '[' || c === ']')) inClass = c === '[';
      if (c === end && !inClass) {
        i += 1;
        break;
      } else if (end !== '`' && c === '\n') break;
      else i += 1;
    }
    out += text.slice(start, i);
    last = 'a';
  };
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += ' ';
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`') literal(c);
    else if (c === '/' && (last === '' || '(,=:[!&|?{};+-*%<>~^'.includes(last))) literal('/');
    else {
      out += c;
      if (!/\s/.test(c)) last = c;
      i += 1;
    }
  }
  return out;
}

describe('no MCP tool handler reaches the owner controls (M1-9i-b2, I-4)', () => {
  const graph = toolGraph();

  it('walks every tool module, the registry and the handler table (not vacuous)', () => {
    const names = [...graph.keys()].map((file) => file.slice(TOOLS_DIR.length));
    expect(names).toContain('index.ts');
    expect(names).toContain('registry.ts');
    expect(names).toContain('context.ts');
    expect(names).toContain('send.ts');
    expect(names.length).toBeGreaterThan(20);
  });

  it('no reached file names a control or a control factory', () => {
    const hits = [...graph].filter(([, text]) => CONTROL_NAME.test(code(text)));
    expect(hits.map(([file]) => file)).toEqual([]);
  });

  it('no reached file imports the KeyStore backends or the secret-key subpath', () => {
    const hits = [...graph].filter(([, text]) => FENCED_IMPORT.test(code(text)));
    expect(hits.map(([file]) => file)).toEqual([]);
  });

  it('the scan would catch a reference (negative control)', () => {
    for (const sample of [
      "import type { KeyExportControl } from '@4thtech-io/crypto';",
      'const control = owner.storageCredentialControl(keys);',
      'createKeyImportControl(store)',
    ]) {
      expect(CONTROL_NAME.test(code(sample)), sample).toBe(true);
    }
    expect(FENCED_IMPORT.test("import { openAgent } from '@4thtech-io/node';")).toBe(true);
    expect(FENCED_IMPORT.test("import type { X } from '@4thtech-io/crypto/keystore';")).toBe(true);
    expect(CONTROL_NAME.test(code('// KeyExportControl is owner-only'))).toBe(false);
    expect(CONTROL_NAME.test(code('/* a\n StorageCredentialControl */ x'))).toBe(false);
  });

  it('a comment marker inside a string, template or regex literal hides nothing (Fable Low)', () => {
    for (const sample of [
      "const a = '//'; const c = owner.exportControl;",
      "const b = '/*'; createKeyImportControl(store); const d = '*/';",
      'const t = `//${x}`; const k = keys.storageCredentialControl;',
      'const r = /\\/\\//; const e = owner.exportControl;',
      'const s = "/*"; type K = KeyExportControl;',
    ]) {
      expect(CONTROL_NAME.test(code(sample)), sample).toBe(true);
    }
  });
});

type ControlMethod =
  keyof KeyExportControl | keyof KeyImportControl | keyof StorageCredentialControl;
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

describe('ToolContext offers no control method (type level)', () => {
  it('no property path of what a handler is given reaches a control method', () => {
    expectTypeOf<Extract<DeepKeys<ToolContext>, ControlMethod>>().toEqualTypeOf<never>();
    // The walk is not vacuous: it reaches into the client, and stays a set of literal names (an
    // index signature widening it to `string` would make the Extract above pass vacuously).
    expectTypeOf<'client'>().toExtend<DeepKeys<ToolContext>>();
    expectTypeOf<'agentName'>().toExtend<DeepKeys<ToolContext>>();
    expectTypeOf<string>().not.toExtend<DeepKeys<ToolContext>>();
  });
});
