// M1-13a: one agent's process in the e2e scenario. It runs the BUILT CLI (apps/cli/dist) exactly as
// `agentlink mcp` does (createMcpCommand: the runtime's openAgent with the real OS keychain KeyStore
// and SQLite store, the MCP server over stdio, the background loop with its publisher lease), with
// one substitution: the relay transport goes to the local relays (local-connector.mjs).
//
//   node agent-host.mjs mcp  --home <dir>   the stdio MCP server a harness (or the scripted client)
//                                           starts; it ends when stdin closes or on SIGTERM.
//   node agent-host.mjs pump --home <dir>   the background loop alone (no MCP), so pairing and
//                                           delivery continue between harness sessions in the LLM
//                                           run; it ends on SIGTERM or SIGINT.
//
// stdout carries only the MCP protocol; the redacting logger writes to stderr (06 §1, 04 §8.4).
// Nothing here holds or sees an owner key.
import process from 'node:process';
import { nostrTransport } from '@agentlink/core';
import { createLogger } from '@agentlink/log';
import { createMcpCommand, stdioTransport } from '../../apps/cli/dist/mcp/command.js';
import { BackgroundLoop } from '../../apps/cli/dist/mcp/loop.js';
import { nodeRuntimeDeps, openAgent } from '../../apps/cli/dist/runtime/index.js';
import { localRelayConnector, relayMapFromEnv } from './local-connector.mjs';

/** Short loop intervals: the scenario waits on pairing and delivery. */
const LOOP = Object.freeze({ syncIntervalMs: 1_000, leaseIntervalMs: 2_000 });

const [mode, flag, home] = process.argv.slice(2);
if ((mode !== 'mcp' && mode !== 'pump') || flag !== '--home' || typeof home !== 'string') {
  process.exitCode = 2;
  throw new Error('usage: agent-host.mjs mcp|pump --home <dir>');
}

// OPS-CI-7: the nightly two-machine run talks to the real relays through the production transport
// (with its address check); every other e2e suite keeps the local relays.
const deps =
  process.env['AGENTLINK_E2E_REAL_RELAYS'] === '1'
    ? nodeRuntimeDeps
    : {
        ...nodeRuntimeDeps,
        transport: () =>
          nostrTransport({
            connector: localRelayConnector(relayMapFromEnv()),
            addressCheck: 'platform',
          }),
      };
const open = (options) => openAgent({ ...options, home, deps });
const logger = createLogger({ name: `e2e-${mode}` });

if (mode === 'mcp') {
  const handler = createMcpCommand({
    openAgent: open,
    transport: () => stdioTransport(),
    version: '0.0.0-e2e',
    logger,
    loop: LOOP,
  });
  process.exitCode = await handler({
    command: 'mcp',
    parsed: { values: {}, positionals: [], agent: undefined },
    output: { print: () => undefined, printError: () => undefined },
    terminal: { stdinIsTTY: false, stdoutIsTTY: false, env: {} },
  });
} else {
  const opened = await open({ logger });
  if (opened.status !== 'ok') {
    process.exitCode = 1;
    throw new Error('the agent is not set up');
  }
  const { agent } = opened;
  const loop = new BackgroundLoop({ client: agent.client, logger, ...LOOP });
  // The loop's own timers never keep the process alive; this one does, until a signal.
  const keepAlive = setInterval(() => undefined, 60_000);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(keepAlive);
    await loop.stop();
    await agent.close();
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
  loop.start();
  logger.info('e2e pump started');
}
