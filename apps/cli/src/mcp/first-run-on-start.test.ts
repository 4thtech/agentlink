// M1-11b-8: `agentlink mcp` opens the first-run page once per start while there is no owner
// (06 §7; D-120 (1); D-130 (1); 04 §2.5; I-4, I-5).
//
// - Once per process start, and only while owner setup is wired (a keychain agent, no owner
//   anywhere, the app in this build): the local approval server starts and the OS opener gets the
//   one-shot /first-run link. The link never reaches a tool result, a log line or MCP output.
// - With an owner anywhere (setup not wired), nothing starts and nothing opens.
// - Tools keep answering as before: `needs_setup` with the fixed command when the agent is not set
//   up, and no tool result ever carries the first-run link.
// - Headless (CI, no display, an SSH session): nothing starts, nothing opens, nothing is retried.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AgentLinkClient } from '@4thtech-io/core';
import { createLogger, type Level } from '@4thtech-io/log';
import type { ApprovalServer } from '@4thtech-io/node';
import { describe, expect, it, vi } from 'vitest';
import type { OpenedAgent } from '../runtime/index.js';
import { createApprovalUi, type ApprovalUi } from './approval-ui.js';
import { createMcpCommand, type McpCommandDeps } from './command.js';
import { headlessDisplay, openFirstRunOnStart } from './first-run-on-start.js';

const A = `0x${'a'.repeat(40)}`;
const ORIGIN = 'http://localhost:47321';
const TOKEN = 'T'.repeat(43);
const FIRST_RUN_LINK = `${ORIGIN}/first-run?t=${TOKEN}`;
const DESKTOP = Object.freeze({ env: {}, platform: 'darwin' });

function recordingLogger() {
  const lines: string[] = [];
  const logger = createLogger({
    level: 'debug',
    sink: (_level: Level, line: string) => {
      lines.push(line);
    },
  });
  return { logger, lines };
}

interface FakeServer extends ApprovalServer {
  readonly firstRunOpens: { count: number };
}

/** A fake server whose first-run opener "opens" FIRST_RUN_LINK (never returned to anyone). */
function fakeServer(opens: boolean | 'throws' = true): FakeServer {
  const firstRunOpens = { count: 0 };
  return {
    origin: ORIGIN,
    port: 47321,
    firstRunOpens,
    address: () => ({ host: 'localhost', port: 47321, addresses: ['127.0.0.1'] }),
    approvalUrl: (id) => `${ORIGIN}/approve/${id}`,
    open: () => Promise.resolve(true),
    openFirstRun: () => {
      firstRunOpens.count += 1;
      if (opens === 'throws') return Promise.reject(new Error(`opener failed: ${FIRST_RUN_LINK}`));
      return Promise.resolve(opens);
    },
    openHome: () => Promise.resolve(true),
    notifyNewApproval: (id) => Promise.resolve(`${ORIGIN}/approve/${id}`),
    close: () => Promise.resolve(),
  };
}

function setupUi(server: ApprovalServer, wired = true, logger = recordingLogger().logger) {
  const start = vi.fn(() => Promise.resolve(server));
  const ui = createApprovalUi({
    start,
    agentName: 'default',
    logger,
    firstRunWired: () => wired,
  });
  return { ui, start };
}

describe('the approval UI opens the setup page at most once (M1-11b-8)', () => {
  it('starts the server, opens the first-run page once, and never again', async () => {
    const server = fakeServer();
    const { ui, start } = setupUi(server);
    await expect(ui.openSetupPage()).resolves.toBe(true);
    await expect(ui.openSetupPage()).resolves.toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
    expect(server.firstRunOpens.count).toBe(1);
    await ui.close();
  });

  it('opens nothing when the started server has no owner setup wired (an owner exists)', async () => {
    const server = fakeServer();
    const { ui } = setupUi(server, false);
    await expect(ui.openSetupPage()).resolves.toBe(false);
    expect(server.firstRunOpens.count).toBe(0);
    await ui.close();
  });

  it('without a firstRunWired check, never opens the setup page', async () => {
    const server = fakeServer();
    const ui = createApprovalUi({
      start: () => Promise.resolve(server),
      agentName: 'default',
      logger: recordingLogger().logger,
    });
    await expect(ui.openSetupPage()).resolves.toBe(false);
    expect(server.firstRunOpens.count).toBe(0);
    await ui.close();
  });

  it('after close, opens nothing and starts nothing', async () => {
    const server = fakeServer();
    const { ui, start } = setupUi(server);
    await ui.close();
    await expect(ui.openSetupPage()).resolves.toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it('an opener that fails or throws answers false and nothing of it is logged', async () => {
    for (const opens of [false, 'throws'] as const) {
      const { logger, lines } = recordingLogger();
      const { ui } = setupUi(fakeServer(opens), true, logger);
      await expect(ui.openSetupPage()).resolves.toBe(false);
      await expect(ui.openSetupPage()).resolves.toBe(false);
      expect(lines.join('\n')).not.toContain(TOKEN);
      expect(lines.join('\n')).not.toContain('/first-run');
      await ui.close();
    }
  });
});

describe('headlessDisplay (M1-11b-8)', () => {
  it('is false on a desktop', () => {
    expect(headlessDisplay({}, 'darwin')).toBe(false);
    expect(headlessDisplay({}, 'win32')).toBe(false);
    expect(headlessDisplay({ DISPLAY: ':0' }, 'linux')).toBe(false);
    expect(headlessDisplay({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBe(false);
  });

  it('is true in CI, over SSH, and on Linux without a display', () => {
    expect(headlessDisplay({ CI: 'true' }, 'darwin')).toBe(true);
    expect(headlessDisplay({ CI: '1' }, 'win32')).toBe(true);
    expect(headlessDisplay({ SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22' }, 'darwin')).toBe(true);
    expect(headlessDisplay({ SSH_TTY: '/dev/ttys001' }, 'linux')).toBe(true);
    expect(headlessDisplay({}, 'linux')).toBe(true);
    expect(headlessDisplay({ DISPLAY: '' }, 'freebsd')).toBe(true);
  });

  it('a CI value of false or 0 is not CI', () => {
    expect(headlessDisplay({ CI: 'false' }, 'darwin')).toBe(false);
    expect(headlessDisplay({ CI: '0' }, 'darwin')).toBe(false);
    expect(headlessDisplay({ CI: '' }, 'darwin')).toBe(false);
  });
});

describe('openFirstRunOnStart (M1-11b-8)', () => {
  it('opens the page when setup is available on a desktop, and logs one fixed line', async () => {
    const { logger, lines } = recordingLogger();
    const server = fakeServer();
    const { ui } = setupUi(server, true, logger);
    const available = vi.fn(() => Promise.resolve(true));
    await expect(openFirstRunOnStart({ available, ui, logger, ...DESKTOP })).resolves.toBe(true);
    expect(server.firstRunOpens.count).toBe(1);
    const all = lines.join('\n');
    expect(all).toContain('first-run page opened');
    expect(all).not.toContain(TOKEN);
    expect(all).not.toMatch(/https?:\/\//);
    await ui.close();
  });

  it('with an owner (setup not available), starts nothing and opens nothing', async () => {
    const server = fakeServer();
    const { ui, start } = setupUi(server);
    await expect(
      openFirstRunOnStart({ available: () => Promise.resolve(false), ui, ...DESKTOP }),
    ).resolves.toBe(false);
    expect(start).not.toHaveBeenCalled();
    expect(server.firstRunOpens.count).toBe(0);
  });

  it('a failing availability check fails closed (nothing starts)', async () => {
    const server = fakeServer();
    const { ui, start } = setupUi(server);
    await expect(
      openFirstRunOnStart({
        available: () => Promise.reject(new Error('keychain locked')),
        ui,
        ...DESKTOP,
      }),
    ).resolves.toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it('headless: checks nothing, starts nothing, opens nothing, and does not throw', async () => {
    for (const display of [
      { env: { CI: 'true' }, platform: 'darwin' },
      { env: {}, platform: 'linux' },
      { env: { SSH_CONNECTION: 'x' }, platform: 'darwin' },
    ]) {
      const server = fakeServer();
      const { ui, start } = setupUi(server);
      const available = vi.fn(() => Promise.resolve(true));
      await expect(openFirstRunOnStart({ available, ui, ...display })).resolves.toBe(false);
      expect(available).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(server.firstRunOpens.count).toBe(0);
    }
  });

  it('a server that cannot start is quiet (false, no throw, no retry)', async () => {
    const start = vi.fn(() => Promise.reject(new Error('EADDRINUSE')));
    const ui = createApprovalUi({
      start,
      agentName: 'default',
      logger: recordingLogger().logger,
      firstRunWired: () => true,
    });
    await expect(
      openFirstRunOnStart({ available: () => Promise.resolve(true), ui, ...DESKTOP }),
    ).resolves.toBe(false);
    await expect(
      openFirstRunOnStart({ available: () => Promise.resolve(true), ui, ...DESKTOP }),
    ).resolves.toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
  });
});

// ---- `agentlink mcp` start -----------------------------------------------------------------------

const parsed = { values: {}, positionals: [], agent: undefined };
const io = {
  output: { print: vi.fn(), printError: vi.fn() },
  terminal: { stdinIsTTY: false, stdoutIsTTY: false, env: {} },
};

function openedAgent(): OpenedAgent {
  const coreClient = {
    identity: { get: () => Promise.resolve(undefined) },
    publisherLease: () => ({
      held: false,
      take: () => Promise.resolve(false),
      renew: () => Promise.resolve(false),
      release: () => Promise.resolve(false),
    }),
    inbox: { counts: () => Promise.resolve({ inbox: [], requests: 0 }) },
  } as unknown as AgentLinkClient;
  return {
    name: 'default',
    agentId: A,
    client: coreClient,
    paths: { root: '/nonexistent/agentlink-m1-11b-8/agents/default' },
    close: () => Promise.resolve(),
  } as unknown as OpenedAgent;
}

interface Started {
  readonly server: FakeServer;
  readonly start: ReturnType<typeof vi.fn>;
  readonly available: ReturnType<typeof vi.fn>;
  readonly lines: string[];
  readonly client: Client;
  readonly running: Promise<number>;
}

async function startMcp(
  options: {
    readonly available?: boolean;
    readonly display?: { env: Record<string, string>; platform: string };
    readonly setUp?: boolean;
  } = {},
): Promise<Started> {
  const { logger, lines } = recordingLogger();
  const server = fakeServer();
  const start = vi.fn(() => Promise.resolve(server as ApprovalServer));
  const available = vi.fn(() => Promise.resolve(options.available ?? true));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const deps: McpCommandDeps = {
    openAgent: () =>
      Promise.resolve(
        options.setUp === false
          ? { status: 'needs_setup', reason: 'no_agent', message: 'Set up first.' }
          : { status: 'ok', agent: openedAgent() },
      ),
    transport: () => serverSide,
    version: '0',
    logger,
    approvalUi: (agent, log): ApprovalUi =>
      createApprovalUi({
        start,
        agentName: agent.name,
        logger: log,
        firstRunWired: () => true,
      }),
    firstRunAvailable: available,
    display: options.display ?? DESKTOP,
  };
  const running = createMcpCommand(deps)({ command: 'mcp', parsed, ...io });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  return { server, start, available, lines, client, running };
}

/** Lets the start's background open run to its end. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('agentlink mcp opens the first-run page once per start (M1-11b-8)', () => {
  it('one open per start while there is no owner; a tool call never reopens it', async () => {
    const mcp = await startMcp();
    await settle();
    expect(mcp.available).toHaveBeenCalledTimes(1);
    expect(mcp.server.firstRunOpens.count).toBe(1);
    await mcp.client.listTools();
    await mcp.client.callTool({ name: 'agentlink_status', arguments: {} }).catch(() => undefined);
    await settle();
    expect(mcp.server.firstRunOpens.count).toBe(1);
    expect(mcp.start).toHaveBeenCalledTimes(1);
    await mcp.client.close();
    await expect(mcp.running).resolves.toBe(0);
    // A second start (a new process) opens it once again.
    const again = await startMcp();
    await settle();
    expect(again.server.firstRunOpens.count).toBe(1);
    await again.client.close();
    await again.running;
  });

  it('none when an owner exists: no server starts and nothing opens', async () => {
    const mcp = await startMcp({ available: false });
    await settle();
    expect(mcp.start).not.toHaveBeenCalled();
    expect(mcp.server.firstRunOpens.count).toBe(0);
    await mcp.client.close();
    await mcp.running;
  });

  it('none in tool output or logs: no link, token or local address', async () => {
    const mcp = await startMcp();
    await settle();
    const tools = await mcp.client.listTools();
    const result = await mcp.client
      .callTool({ name: 'agentlink_status', arguments: {} })
      .catch((error: unknown) => ({ error: String(error) }));
    await mcp.client.close();
    await mcp.running;
    const visible = JSON.stringify([tools, result, mcp.lines]);
    expect(visible).not.toContain(TOKEN);
    expect(visible).not.toContain('first-run?');
    expect(visible).not.toContain(FIRST_RUN_LINK);
    expect(JSON.stringify([tools, result])).not.toContain(ORIGIN);
  });

  it('the needs_setup fallback is unchanged and opens nothing', async () => {
    // The same start without the first-run step (before M1-11b-8) is the baseline.
    const [baseClientSide, baseServerSide] = InMemoryTransport.createLinkedPair();
    const baseRunning = createMcpCommand({
      openAgent: () =>
        Promise.resolve({ status: 'needs_setup', reason: 'no_agent', message: 'Set up first.' }),
      transport: () => baseServerSide,
      version: '0',
      logger: recordingLogger().logger,
    })({ command: 'mcp', parsed, ...io });
    const baseClient = new Client({ name: 'test', version: '0' });
    await baseClient.connect(baseClientSide);
    const baseline = await baseClient.callTool({ name: 'agentlink_status', arguments: {} });
    await baseClient.close();
    await baseRunning;

    const mcp = await startMcp({ setUp: false });
    await settle();
    const result = (await mcp.client.callTool({ name: 'agentlink_status', arguments: {} })) as {
      structuredContent?: { status?: string; summary?: string };
    };
    expect(result.structuredContent?.status).toBe('needs_setup');
    expect(result.structuredContent?.summary).toBe('Set up first.');
    expect(result).toEqual(baseline);
    expect(mcp.available).not.toHaveBeenCalled();
    expect(mcp.start).not.toHaveBeenCalled();
    await mcp.client.close();
    await mcp.running;
  });

  it('headless: the server runs, tools answer, nothing starts or opens', async () => {
    const mcp = await startMcp({ display: { env: { CI: 'true' }, platform: 'linux' } });
    await settle();
    await mcp.client.listTools();
    expect(mcp.available).not.toHaveBeenCalled();
    expect(mcp.start).not.toHaveBeenCalled();
    await mcp.client.close();
    await expect(mcp.running).resolves.toBe(0);
  });
});
