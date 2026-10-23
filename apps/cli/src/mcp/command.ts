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
// - M1-11a-b, the local approval UI (approval-ui.ts): when the agent is set up, the handlers get an
//   `approvalLink` that starts the local approval server on the first `pending_approval` and reuses
//   it; the result then carries the approval page's url next to the `agentlink approve` command. On
//   close the server stops after the loop and before the agent closes (its source reads the store).
// - M1-11s-b, the local UI app (D-118): the same server serves the app embedded in this build
//   (local-ui-assets.ts) at /settings and /first-run, with the agent's core client for its API.
import { dirname } from 'node:path';
import process from 'node:process';
import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createLogger, type Logger } from '@4thtech-io/log';
import { startApprovalServer, type AgentStore } from '@4thtech-io/node';
import { approvalNextStep } from '../approval/next-step.js';
import { createUiApprovalSource } from '../approval/ui-source.js';
import { EXIT_OK, type CommandHandler } from '../dispatch.js';
import {
  nodeRuntimeDeps,
  openAgent,
  type OpenAgentOptions,
  type OpenAgentResult,
  type OpenedAgent,
} from '../runtime/index.js';
import { cliPrefix } from '../runtime/cli-prefix.js';
import { ownerKnownAbsent } from '../runtime/owner-on-machine.js';
import { coreToolClient, type HandlerEnvironment, type ToolContext } from '../tools/index.js';
import { createApprovalUi, type ApprovalUi } from './approval-ui.js';
import { approvalWaitMsFor } from './approval-wait.js';
import { embeddedLocalUiAssets } from './local-ui-assets.js';
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
  /**
   * M1-11a-b: the local approval UI for an opened agent (started on demand, closed with the
   * server). Without it, `pending_approval` results carry the CLI command only (M1a).
   */
  readonly approvalUi?: (agent: OpenedAgent, logger: Logger) => ApprovalUi;
}

const systemClock = (): number => Math.floor(Date.now() / 1000);

/** The handler context for an opened agent. */
export function agentToolContext(
  agent: OpenedAgent,
  logger: Logger,
  clock: () => number = systemClock,
  approvalUi?: ApprovalUi,
): ToolContext {
  return Object.freeze<ToolContext>({
    client: coreToolClient(agent.client, {
      ...(agent.files === undefined ? {} : { files: agent.files }),
      ...(agent.proofs === undefined ? {} : { proofs: agent.proofs }),
      ...(agent.freeCredits === undefined ? {} : { freeCredits: agent.freeCredits }),
    }),
    clock,
    logger,
    agentName: agent.name,
    approvalNextStep: (approvalId: string) => approvalNextStep(approvalId, agent.name),
    // No fixed result origin: only the local UI link's own origin, added with it (M1-11a-b).
    urlOrigins: Object.freeze([]),
    ...(approvalUi === undefined
      ? {}
      : { approvalLink: (approvalId: string) => approvalUi.link(approvalId) }),
    // M1-36a-b: the no-owner text names the command that works here, and `owner init` on a
    // machine known to have no owner (folder names and file presence only; never a key).
    cliPrefix: cliPrefix(),
    ownerExists: async () =>
      (await ownerKnownAbsent(dirname(agent.paths.root), agent.name)) ? false : undefined,
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
    const approvalUi = agent === undefined ? undefined : deps.approvalUi?.(agent, logger);
    const env: HandlerEnvironment =
      opened.status === 'ok'
        ? agentToolContext(opened.agent, logger, deps.clock, approvalUi)
        : { needsSetup: { message: opened.message }, logger };

    // M1-36j (D4): only with the approval page can a call wait for the owner's decision.
    const server = createMcpServer(
      env,
      deps.version,
      approvalUi === undefined ? {} : { approvalWaitMs: approvalWaitMsFor },
    );
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
      // Stop the passes and release the lease while the store is still open (06 §6), then the
      // approval server, whose source reads the same store (M1-11a-b).
      await loop?.stop();
      await approvalUi?.close();
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

/** The production `agentlink mcp` handler: stdio, the real runtime, the local approval UI. */
export const mcpCommand = (version: string): CommandHandler => {
  // The approval source reads the agent's store and opens its sealed rows (M1-11a ui-source.ts),
  // so the store the runtime opens is kept here, as the owner commands do (commands/owner/deps.ts).
  let opened: AgentStore | undefined;
  return createMcpCommand({
    openAgent: (options) =>
      openAgent({
        ...options,
        deps: {
          ...nodeRuntimeDeps,
          openStore: async (backend, agentId, path) => {
            opened = await nodeRuntimeDeps.openStore(backend, agentId, path);
            return opened;
          },
        },
      }),
    transport: () => stdioTransport(),
    version,
    approvalUi: (agent, logger) => {
      const store = opened;
      return createApprovalUi({
        agentName: agent.name,
        logger,
        start: () => {
          if (store === undefined) return Promise.reject(new Error('approval ui: no store'));
          const source = createUiApprovalSource(
            {
              name: agent.name,
              client: agent.client,
              store: store.store,
              cipher: store.cipher,
              // The MCP server owns the agent's lifetime; the source never closes it.
              close: () => Promise.resolve(),
            },
            { now: systemClock },
          );
          return startApprovalServer({
            source,
            localUi: { assets: embeddedLocalUiAssets(), client: agent.client },
            // Fixed values only (ApprovalServerEvent, I-7).
            onEvent: (event) => {
              logger.debug('approval ui event', { ...event });
              // IR-M1-11s-c-1 L-2: an owner set up from the first-run page is named outside the
              // browser too (a fixed line and the public fingerprint), to compare with
              // `agentlink doctor`.
              if (
                event.kind === 'owner_setup' &&
                (event.outcome === 'done' || event.outcome === 'done_unconfirmed') &&
                event.fingerprint !== undefined
              ) {
                logger.info(
                  `Approvals on this computer are now protected by a new owner, set up on the setup page. If you did not do this yourself, do not use this agent; check with \`${cliPrefix()} doctor\`.`,
                  { fingerprint: event.fingerprint },
                );
              }
            },
          });
        },
      });
    },
  });
};
