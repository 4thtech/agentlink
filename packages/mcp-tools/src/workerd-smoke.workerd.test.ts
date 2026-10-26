// M2-3t-w: the shared tool handlers load and run in the Cloudflare Workers runtime (workerd), where
// the remote MCP server (M2-3b) will call them. Runs in the package's `workerd` Vitest project only.
import { MCP_TOOL_NAMES } from '@4thtech-io/types';
import { describe, expect, it } from 'vitest';
import { callTool } from './index.js';
import { TOOLS } from './registry.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

describe('@4thtech-io/mcp-tools in workerd (M2-3t-w)', () => {
  it('runs inside the Workers runtime, not Node', () => {
    const g = globalThis as { navigator?: { userAgent?: string }; WebSocketPair?: unknown };
    expect(g.navigator?.userAgent).toBe('Cloudflare-Workers');
    expect(typeof g.WebSocketPair).toBe('function');
  });

  it('registers the frozen tool surface', () => {
    expect(TOOLS.map((tool) => tool.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
  });

  it('answers through callTool: needs_setup for a valid call, a refusal for an unknown tool', async () => {
    const env = { needsSetup: { message: 'Not set up yet.' }, logger } as never;
    const setup = await callTool('agentlink_status', {}, env);
    expect(setup.structured.status).toBe('needs_setup');
    const unknown = await callTool('agentlink_nope', {}, env);
    expect(unknown.structured.status).not.toBe('ok');
  });
});
