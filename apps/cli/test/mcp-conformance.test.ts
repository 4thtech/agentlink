// MCP conformance over a real stdio process (06 §9, M1-9e): schema validation of every tool by an
// independent MCP client. It starts the real `agentlink mcp` from source in a child process with an
// empty home (no agent is set up, so tool calls answer `needs_setup`), as a client does, with the
// MCP SDK's client: `initialize`, then `tools/list`, which parses the result against the protocol's
// own schema and compiles every tool's input and output JSON Schema, then one call per tool whose
// structured result the client validates against that tool's output schema.
//
// The card named the MCP Inspector CLI. Its package (`@modelcontextprotocol/inspector-cli`) declares
// its licence as "SEE LICENSE IN LICENSE", which the dependency-review licence allowlist rejects, and
// weakening that gate for a dev tool is not worth it. This test is the equivalent check with the MCP
// SDK that the repository already pins (the Inspector is itself this SDK's client).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, describe, expect, it } from 'vitest';
import { SERVER_INSTRUCTIONS } from '../src/mcp/instructions.js';
import { toMcpTool } from '../src/mcp/server.js';
import { TOOLS } from '../src/tools/registry.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const hooks = new URL('./fixtures/source-resolve-hooks.mjs', import.meta.url).href;
const home = mkdtempSync(join(tmpdir(), 'agentlink-conformance-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** A valid argument object per tool (required fields only). */
const VALID_ARGS: Record<string, Record<string, unknown>> = {
  agentlink_status: {},
  agentlink_create_invite: {},
  agentlink_accept_invite: { inviteUrl: 'https://example.invalid/not-an-invite' },
  agentlink_list_contacts: {},
  agentlink_send: { contact: 'nobody', type: 'text', text: 'hello' },
  agentlink_propose_terms: {},
  agentlink_respond_to_terms: {},
  agentlink_inbox: {},
  agentlink_get_approval: { approvalId: 'apr_AAAAAAAAAAAAAAAAAAAAAA' },
};

describe('MCP conformance over stdio (06 §9)', () => {
  it('initializes, lists every tool with valid schemas and validates one result per tool', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        '--experimental-transform-types',
        '--no-warnings',
        '--experimental-loader',
        hooks,
        cli,
        'mcp',
      ],
      env: { PATH: process.env['PATH'] ?? '', HOME: home, USERPROFILE: home },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'conformance', version: '0' });
    try {
      await client.connect(transport);
      expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);

      // The SDK validates the list against the protocol schema and compiles every output schema.
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
      for (const [i, tool] of tools.entries()) {
        const def = toMcpTool(TOOLS[i]!);
        expect(tool.inputSchema, def.name).toEqual(def.inputSchema);
        expect(tool.outputSchema, def.name).toEqual(def.outputSchema);
        expect(tool.annotations, def.name).toEqual(def.annotations);
      }

      // `callTool` rejects a result whose structuredContent does not match the output schema.
      for (const tool of tools) {
        const args = VALID_ARGS[tool.name];
        expect(args, `a valid argument object for ${tool.name}`).toBeDefined();
        const result = await client.callTool({ name: tool.name, arguments: args! });
        expect(result.structuredContent, tool.name).toMatchObject({ status: expect.any(String) });
      }
    } finally {
      await client.close();
    }
  }, 90_000);
});
