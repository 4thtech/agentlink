// WP-13 (F-4 / F45; 06 §6 "MCP session heartbeat"; 07 §3.2 `mcp_sessions`.version): `agentlink mcp`
// writes the version it runs into its session row, so the app can tell an AI app that still runs an
// older AgentLink after an update ("Restart {app} to use the new version").
import { McpSession, MemoryStore, type AgentLinkClient } from '@4thtech-io/core';
import { describe, expect, it } from 'vitest';
import type { OpenedAgent } from '../runtime/index.js';
import { cliVersion, setCliVersion } from '../runtime/cli-version.js';
import { processHeartbeat } from './command.js';

describe('processHeartbeat writes the running version (WP-13)', () => {
  it('passes the CLI version to the session row', async () => {
    const before = cliVersion();
    setCliVersion('0.4.14');
    try {
      const store = new MemoryStore();
      let seen: Parameters<AgentLinkClient['mcpSession']>[0] | undefined;
      const client = {
        mcpSession: (options: Parameters<AgentLinkClient['mcpSession']>[0]) => {
          seen = options;
          return new McpSession({
            store,
            now: () => 1_800_000_000,
            agentId: `0x${'a'.repeat(40)}`,
            ...options,
          });
        },
      } as unknown as AgentLinkClient;
      const session = processHeartbeat.session({ client } as unknown as OpenedAgent);
      expect(seen?.version).toBe('0.4.14');
      expect(seen?.pid).toBe(process.pid);
      await (session as McpSession).start('claude-code');
      const [row] = await store.transaction((tx) => tx.select('mcp_sessions'));
      expect(row?.version).toBe('0.4.14');
    } finally {
      setCliVersion(before);
    }
  });
});
