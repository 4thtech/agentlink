// NET-OWNER-SET (S2; D-158 (6); 07 §4.3; I-4; IR L2): the full source scan of the I-4 canary, kept
// in a Node package (mcp-tools may not read files). Every non-test source of the MCP tools package
// (all tool tables, strings/ privacy.ts included, inline strings and any table added later) and of
// the CLI's MCP server (`apps/cli/src/mcp`) is read: none names the server-list routes, the owner
// pieces that sign a change, or the modules that hold them. Identifiers match as case-insensitive
// substrings (so `ServerListPlan` is caught too). The scanner proves itself on a planted fixture.
// The tools' schema and ToolClient checks stay in packages/mcp-tools/src/network-servers-i4.test.ts.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const ROOTS = ['packages/mcp-tools/src', 'apps/cli/src/mcp'];
const PLANTED = path.resolve(HERE, '../test/fixtures/i4-scan/planted.ts.txt');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(ts|tsx|mjs|js|json)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** Case-insensitive substrings: routes, owner pieces, module names and user words of the change. */
const FORBIDDEN = [
  '/api/ui/network/servers',
  '/api/ui/network/reset',
  '/api/ui/network/announce',
  '/api/ui/network/progress',
  'serverlist',
  'changeservers',
  'signserverchange',
  'network.announce',
  'network-announce',
  'prepareannounce',
  'afterannounce',
  'withdrawfromdefaultservers',
  'owner-server',
  'server-change-plan',
  'planserverchange',
  'network-servers',
  'owner-relay-migration',
  'owner servers',
  'use your own servers',
  'automatic servers',
];

/** The forbidden entries a text names (empty when none). */
function scan(text: string): string[] {
  const lower = text.toLowerCase();
  return FORBIDDEN.filter((word) => lower.includes(word));
}

describe('no MCP or agent path names a server-list change (full source scan, I-4)', () => {
  it('the scanner reports a planted reference (changeServers, ServerListPlan)', () => {
    const found = scan(readFileSync(PLANTED, 'utf8'));
    expect(found).toContain('changeservers');
    expect(found).toContain('serverlist');
    expect(scan('const p: ServerListPlan = x;')).toEqual(['serverlist']);
    expect(scan("op['network.announce']")).toEqual(['network.announce']);
  });

  it('reads every source of the MCP tools and the CLI MCP server; none names it', () => {
    const files = ROOTS.flatMap((root) => sources(path.join(REPO, root)));
    const tools = files.filter((f) => f.includes(`${path.sep}mcp-tools${path.sep}`));
    expect(tools.length).toBeGreaterThan(30);
    expect(files.some((f) => f.endsWith(path.join('strings', 'privacy.ts')))).toBe(true);
    expect(files.some((f) => f.includes(path.join('apps', 'cli', 'src', 'mcp')))).toBe(true);
    for (const file of files) {
      expect(scan(readFileSync(file, 'utf8')), path.relative(REPO, file)).toEqual([]);
    }
  });
});
