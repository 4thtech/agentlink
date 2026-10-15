// MCP Inspector (CLI mode) schema validation of every tool (06 §9, M1-9e). The pinned
// `@modelcontextprotocol/inspector-cli` is the independent MCP client: it starts the real
// `agentlink mcp` server from source over stdio, runs `tools/list` and fails on any tool list the
// MCP SDK's own schema validation rejects. The test then checks that what the Inspector received is
// exactly the registry. An empty home means no agent is set up; `tools/list` does not need one.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { toMcpTool } from '../src/mcp/server.js';
import { TOOLS } from '../src/tools/registry.js';

const run = promisify(execFile);
const inspector = fileURLToPath(
  new URL('../node_modules/@modelcontextprotocol/inspector-cli/build/index.js', import.meta.url),
);
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const hooks = new URL('./fixtures/source-resolve-hooks.mjs', import.meta.url).href;
const home = mkdtempSync(join(tmpdir(), 'agentlink-inspector-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('MCP Inspector CLI (06 §9)', () => {
  it('lists and validates every tool of the registry', async () => {
    const { stdout } = await run(
      process.execPath,
      [
        inspector,
        process.execPath,
        '--experimental-transform-types',
        '--no-warnings',
        '--experimental-loader',
        hooks,
        cli,
        'mcp',
        '--method',
        'tools/list',
      ],
      {
        env: { PATH: process.env['PATH'] ?? '', HOME: home, USERPROFILE: home, DO_NOT_TRACK: '1' },
        // The Inspector probes `../package.json` relative to the working directory to name its
        // client; the directory of its own entry (build/) is the one place that is always right.
        cwd: dirname(inspector),
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const listed = JSON.parse(stdout) as { tools: Record<string, unknown>[] };
    expect(listed.tools.map((t) => t['name'])).toEqual(TOOLS.map((t) => t.name));
    for (const [i, tool] of listed.tools.entries()) {
      const def = toMcpTool(TOOLS[i]!);
      expect(tool['inputSchema'], def.name).toEqual(def.inputSchema);
      expect(tool['outputSchema'], def.name).toEqual(def.outputSchema);
      expect(tool['annotations'], def.name).toEqual(def.annotations);
    }
  }, 90_000);
});
