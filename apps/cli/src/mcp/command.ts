// `agentlink mcp` (06 §1, §8; M1-9c): the stdio MCP server for one local agent. It opens the agent
// the way every command does (M1-9k `openAgent`: one KeyStore, one store file shared with the other
// harnesses' servers and the owner's CLI), binds the tool registry to stdin and stdout, and closes
// the agent when the client closes stdin.
//
// - stdout carries only the MCP protocol: nothing else may write to it (the logger writes to stderr
//   in Node; the CLI output channel is never used here, src/output.ts).
// - When the agent is not set up, the server still starts and every tool answers `needs_setup` with
//   the runtime's fixed copy, so the agent can tell the user what to run.
// - The handlers get M1-9k's `approvalNextStep` through their context (06 §1: src/tools/ may not
//   import it).
// - The background loop (M1-9r, loop.ts): when the agent is set up, the server competes for the
//   agent's publisher lease and, while it holds it, keeps receiving, processing and delivering. On
//   close the loop stops and releases the lease before the agent closes. `agentlink://inbox`
//   notifications are optional (06 §6).
import process from 'node:process';
import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createLogger, type Logger } from '@agentlink/log';
import { approvalNextStep } from '../approval/next-step.js';
import { EXIT_OK, type CommandHandler } from '../dispatch.js';
import {
  openAgent,
  type OpenAgentOptions,
  type OpenAgentResult,
  type OpenedAgent,
} from '../runtime/index.js';
import { coreToolClient, type HandlerEnvironment, type ToolContext } from '../tools/index.js';
import { attachInboxResource, BackgroundLoop, type BackgroundLoopOptions } from './loop.js';
import { createMcpServer } from './server.js';

export interface McpCommandDeps {
  readonly openAgent: (options: OpenAgentOptions) => Promise<OpenAgentResult>;
  /** The transport; stdio by default. Tests pass an in-memory one. */
  readonly transport: () => Transport;
  readonly version: string;
  readonly logger?: Logger;
  /** Unix seconds. */
  readonly clock?: () => number;
  /** Background loop settings (tests: manual timers, short intervals). */
  readonly loop?: Pick<
    BackgroundLoopOptions,
    'timers' | 'leaseIntervalMs' | 'syncIntervalMs' | 'passBudgetMs'
  >;
}

const systemClock = (): number => Math.floor(Date.now() / 1000);

/** The handler context for an opened agent. */
export function agentToolContext(
  agent: OpenedAgent,
  logger: Logger,
  clock: () => number = systemClock,
): ToolContext {
  return Object.freeze<ToolContext>({
    client: coreToolClient(agent.client),
    clock,
    logger,
    agentName: agent.name,
    approvalNextStep: (approvalId: string) => approvalNextStep(approvalId, agent.name),
    // M1a has no result URL (D-73 (3)); M1-11a adds the local UI origin.
    urlOrigins: Object.freeze([]),
  });
}

export function createMcpCommand(deps: McpCommandDeps): CommandHandler {
  return async ({ parsed }) => {
    const logger = deps.logger ?? createLogger({ name: 'mcp' });
    const opened = await deps.openAgent({
      ...(parsed.agent === undefined ? {} : { agent: parsed.agent }),
      logger,
    });
    const agent = opened.status === 'ok' ? opened.agent : undefined;
    const env: HandlerEnvironment =
      opened.status === 'ok'
        ? agentToolContext(opened.agent, logger, deps.clock)
        : { needsSetup: { message: opened.message }, logger };

    const server = createMcpServer(env, deps.version);
    const loop =
      agent === undefined
        ? undefined
        : new BackgroundLoop({
            ...deps.loop,
            client: agent.client,
            logger,
            onInboxChanged: attachInboxResource(server, agent.client.inbox),
          });
    const closed = new Promise<void>((resolve) => {
      server.onclose = resolve;
    });
    try {
      await server.connect(deps.transport());
      logger.info('mcp server started', { setUp: agent !== undefined });
      loop?.start();
      await closed;
    } finally {
      // Stop the passes and release the lease while the store is still open (06 §6).
      await loop?.stop();
      await agent?.close();
    }
    return EXIT_OK;
  };
}

/** Where the stdio transport reads, writes and hears shutdown signals. Tests pass their own. */
export interface StdioSource {
  readonly stdin: Readable;
  readonly stdout: Writable;
  /** Emits `SIGTERM` and `SIGINT` (the process in production). */
  readonly signals: Pick<NodeJS.EventEmitter, 'once'>;
}

/**
 * The stdio transport. The SDK's transport does not watch for the end of stdin, so the server is
 * closed here when the client closes the pipe (06 §6: clean shutdown on stdin close). A harness
 * that stops the server with SIGTERM or SIGINT gets the same clean shutdown: the loop stops and the
 * lease is released before the agent closes.
 */
export function stdioTransport(io?: StdioSource): Transport {
  // Without `io`: the SDK's own process stdin and stdout (the only writer of stdout, see above).
  const transport =
    io === undefined ? new StdioServerTransport() : new StdioServerTransport(io.stdin, io.stdout);
  const stdin = io?.stdin ?? process.stdin;
  const signals = io?.signals ?? process;
  const close = (): void => {
    transport.close().catch(() => undefined);
  };
  stdin.once('end', close);
  stdin.once('close', close);
  signals.once('SIGTERM', close);
  signals.once('SIGINT', close);
  return transport;
}

/** The production `agentlink mcp` handler: stdio, the real runtime. */
export const mcpCommand = (version: string): CommandHandler =>
  createMcpCommand({
    openAgent: (options) => openAgent(options),
    transport: () => stdioTransport(),
    version,
  });
