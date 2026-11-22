// RELAY-SHARED-CONN L4 (D-159 (1), (8); 07 §4.2 "One relay link per computer"): an `agentlink mcp`
// process starts its shared relay link before it opens the agent (so the agent's pool is built on
// it) and closes it when the process ends, after the agent.
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLogger } from '@4thtech-io/log';
import { describe, expect, it, vi } from 'vitest';
import { createMcpCommand } from './command.js';

const io = {
  output: { print: vi.fn(), printError: vi.fn() },
  terminal: { stdinIsTTY: false, stdoutIsTTY: false, env: {} },
};
const parsed = { values: {}, positionals: [] } as unknown as Parameters<
  ReturnType<typeof createMcpCommand>
>[0]['parsed'];

describe('agentlink mcp: the shared relay link', () => {
  it('starts the link before opening the agent and closes it on exit', async () => {
    const order: string[] = [];
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const command = createMcpCommand({
      openAgent: () => {
        order.push('open agent');
        return Promise.resolve({
          status: 'needs_setup',
          reason: 'no_agent',
          message: 'not set up',
        });
      },
      transport: () => serverSide,
      version: '0',
      logger: createLogger({ level: 'error', sink: () => undefined }),
      relayLink: {
        start: () => {
          order.push('link start');
          return Promise.resolve();
        },
        close: () => {
          order.push('link close');
          return Promise.resolve();
        },
      },
    });
    const run = command({ command: 'mcp', parsed, ...io });
    await vi.waitFor(() => expect(order).toContain('open agent'));
    await clientSide.close();
    await run;
    expect(order).toEqual(['link start', 'open agent', 'link close']);
  });

  it('a link that fails to start never stops the server; it still closes on exit', async () => {
    const order: string[] = [];
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const command = createMcpCommand({
      openAgent: () => {
        order.push('open agent');
        return Promise.resolve({ status: 'needs_setup', reason: 'no_agent', message: 'x' });
      },
      transport: () => serverSide,
      version: '0',
      logger: createLogger({ level: 'error', sink: () => undefined }),
      relayLink: {
        start: () => Promise.reject(new Error('endpoint')),
        close: () => {
          order.push('link close');
          return Promise.resolve();
        },
      },
    });
    const run = command({ command: 'mcp', parsed, ...io });
    await vi.waitFor(() => expect(order).toContain('open agent'));
    await clientSide.close();
    await run;
    expect(order).toEqual(['open agent', 'link close']);
  });
});
