// U3-k: the local app end to end (USABILITY-WAVE-3; 08 §1, §4; 06 §7; 04 §2.5). One "computer": a
// fresh home folder, the built CLI's own code for everything the `agentlink ui` and `agentlink join`
// commands do, and the built local app in Chromium.
//
// What is the shipped code here: the `ui` and `join` command steps (serveUi, joinStep), the agent
// folder rules (agentDirectory), the runtime's openAgent, the app host and approval server, the AI
// apps desk that writes the harness config (with its backup), the MCP server of an AI app
// (createMcpCommand), and the built pages. What is substituted, through each part's own seam:
//   - the OS keychain is a file in a temp folder (e2e/src/file-keychain.mjs), never the real one;
//   - the relays are an in-memory Nostr relay (e2e/src/memory-relay.mjs), no network and no Docker;
//   - the browser's passkey is a CDP virtual authenticator with PRF (what Touch ID gives the page).
// Nothing is written outside the temp folder. Nothing here prints a key, a link or a path.
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkInviteLink, nostrTransport, type AgentLinkClient } from '@4thtech-io/core';
import { encodeUtf8, randomBytes, type OwnerPresence } from '@4thtech-io/crypto';
import { MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { createLogger } from '@4thtech-io/log';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { openAgentStoreWith } from '../../packages/node/dist/agent-store.js';
import {
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerEvent,
  type ApprovalServerOptions,
} from '../../packages/node/dist/approval-server.js';
import {
  createKeychainAgent,
  openRecordedKeyStore,
} from '../../packages/node/dist/keychain-keystore.js';
import { KeychainOwnerKeyStore } from '../../packages/node/dist/owner-keystore.js';
import {
  defaultOwnerFiles,
  ownerSetupAvailableWith,
} from '../../packages/node/dist/owner-setup.js';
import { createUiApprovalSource } from '../../apps/cli/dist/approval/ui-source.js';
import { appServes } from '../../apps/cli/dist/commands/current-agent.js';
import { serveUi, type UiDeps, type UiServer } from '../../apps/cli/dist/commands/ui.js';
import {
  openUiHostAgent,
  startUiWelcome,
  withoutAssets,
  type UiHostDeps,
} from '../../apps/cli/dist/commands/ui-host.js';
import { joinStep } from '../../apps/cli/dist/commands/join.js';
import { uiRemovalPort } from '../../apps/cli/dist/commands/ui-remove.js';
import { createAiAppsDesk } from '../../apps/cli/dist/harness/app-desk.js';
import { createMcpCommand } from '../../apps/cli/dist/mcp/command.js';
import { localUiOptions, type LocalUiWiringDeps } from '../../apps/cli/dist/mcp/local-ui-wiring.js';
import {
  agentDirectory,
  readAgentConfig,
  writeAgentConfig,
} from '../../apps/cli/dist/runtime/agent-dir.js';
import { nodeRuntimeDeps, openAgent, type RuntimeDeps } from '../../apps/cli/dist/runtime/index.js';
import { FileKeychain } from '../src/file-keychain.mjs';
import { memoryRelays } from '../src/memory-relay.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const APP_DIST = fileURLToPath(new URL('../../apps/local-ui/dist/', import.meta.url));
export const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
/** Relay hosts the cards name (the relay URL rule refuses local names; the in-memory relay takes all). */
export const CARD_RELAYS = ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'];

type Keychain = InstanceType<typeof FileKeychain>;
type Relays = ReturnType<typeof memoryRelays>;

/** The built app as the CLI embeds it: index.html and assets/<name>. */
export function builtAppFiles(): Map<string, Uint8Array> | undefined {
  try {
    const files = new Map<string, Uint8Array>([
      ['index.html', new Uint8Array(readFileSync(join(APP_DIST, 'index.html')))],
    ]);
    for (const name of readdirSync(join(APP_DIST, 'assets'))) {
      files.set(`assets/${name}`, new Uint8Array(readFileSync(join(APP_DIST, 'assets', name))));
    }
    return files;
  } catch {
    return undefined;
  }
}

/** One computer: a fresh home, its keychain stand-in, the shared in-memory relay. */
export interface Computer {
  readonly home: string;
  readonly keychain: Keychain;
  readonly relays: Relays;
  readonly runtime: RuntimeDeps;
  /** Every link the app handed to the OS browser opener. */
  readonly opened: string[];
  readonly events: ApprovalServerEvent[];
  readonly directory: ReturnType<typeof agentDirectory>;
}

export async function newComputer(
  relays: Relays = memoryRelays(),
  base?: string,
): Promise<Computer> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentlink-u3k-')));
  const home = join(root, 'home');
  await mkdir(home, { recursive: true });
  const keychain = new FileKeychain(join(root, 'keychain-stand-in.json'));
  const runtime: RuntimeDeps = {
    ...nodeRuntimeDeps,
    probeKeychain: () => Promise.resolve({ ok: true }),
    openKeyStore: (backend, agentId) => openRecordedKeyStore(backend, agentId, { keychain }),
    openStore: (backend, agentId, path) => openAgentStoreWith(backend, agentId, path, { keychain }),
    transport: () =>
      nostrTransport({ connector: relays.connector as never, addressCheck: 'platform' }),
    proofs: () => undefined,
  };
  void base;
  return {
    home,
    keychain,
    relays,
    runtime,
    opened: [],
    events: [],
    directory: agentDirectory(home, {
      createAgent: () => createKeychainAgent(keychain),
      discardKeys: async () => undefined,
    }),
  };
}

/** The seams of the wiring `ui` uses, over this computer (the real desk reads the real config paths in `home`). */
export function wiringOf(pc: Computer, assets: Map<string, Uint8Array>): LocalUiWiringDeps {
  return {
    keyStoreOf: async (name) => (await readAgentConfig(pc.home, name))?.config.keyStore,
    ownerSetupAvailable: (first) =>
      ownerSetupAvailableWith(pc.keychain, first, defaultOwnerFiles(pc.home)),
    cardRelays: () => CARD_RELAYS,
    assets: () => ({ files: assets }),
    aiApps: () =>
      createAiAppsDesk({
        home: pc.home,
        env: {},
        desktopRunning: () => Promise.resolve(false),
      }),
  };
}

/** The approval server of this computer: the keychain stand-in, the opener recorded, the fast owner KDF. */
export function startServerOf(
  pc: Computer,
): (options: ApprovalServerOptions) => Promise<ApprovalServer> {
  return (options) => {
    const host = options.host;
    // The first agent's folders and the owner files are this computer's, never the real home.
    const patched: ApprovalServerOptions =
      host === undefined || host.firstRun === undefined
        ? options
        : {
            ...options,
            // W4-ONE-TOUCH: the CLI's first-run desk (`aiApps`) is kept.
            host: {
              ...host,
              firstRun: { ...host.firstRun, home: pc.home, ownerFiles: defaultOwnerFiles(pc.home) },
            },
          };
    return startApprovalServerWith(
      {
        ...patched,
        onEvent: (event) => {
          pc.events.push(event);
          options.onEvent?.(event);
        },
      },
      {
        keychain: pc.keychain,
        openOwnerStore: (expected) => KeychainOwnerKeyStore.open(pc.keychain, expected),
        opener: (url) => {
          pc.opened.push(url);
          return Promise.resolve(true);
        },
        notifier: () => Promise.resolve(true),
        ownerKdf: KDF,
      },
    );
  };
}

/**
 * The `UiDeps` of `agentlink ui` / `join` on this computer: the same steps as the CLI's nodeUiDeps
 * (apps/cli commands/ui.ts), over the seams above. `serveUi` is the shipped command logic.
 */
export function uiDepsOf(
  pc: Computer,
  assets: Map<string, Uint8Array>,
): UiDeps & {
  stop(): void;
  readonly servers: UiServer[];
} {
  const wiring = wiringOf(pc, assets);
  const now = (): number => Math.floor(Date.now() / 1000);
  const owner = {
    open: async (name?: string) => {
      let opened: Awaited<ReturnType<typeof openAgentStoreWith>> | undefined;
      const deps: RuntimeDeps = {
        ...pc.runtime,
        openStore: async (backend, agentId, path) => {
          opened = await pc.runtime.openStore(backend, agentId, path);
          return opened;
        },
      };
      const result = await openAgent({
        home: pc.home,
        deps,
        logger: createLogger({ name: 'u3k-app', level: 'error', sink: () => undefined }),
        ...(name === undefined ? {} : { agent: name }),
      });
      if (result.status !== 'ok' || opened === undefined) {
        return { status: 'needs_setup' as const, message: 'not set up' };
      }
      return {
        status: 'ok' as const,
        agent: Object.freeze({
          name: result.agent.name,
          client: result.agent.client,
          store: opened.store,
          cipher: opened.cipher,
          close: () => result.agent.close(),
        }),
      };
    },
  };
  const hostDeps: UiHostDeps = {
    owner: owner as never,
    directory: pc.directory,
    localUi: (agent) => localUiOptions(agent, wiring),
    now,
  };
  const servers: UiServer[] = [];
  let stopWait: (() => void) | undefined;
  const startServer = startServerOf(pc);
  const deps: UiDeps = {
    agents: async () => (await pc.directory.list()).filter((e) => !e.removing).map((e) => e.name),
    lastUsed: () => pc.directory.readCurrent(),
    serves: appServes({ home: pc.home, env: {}, now: now() }),
    startWelcome: async (welcome = {}) => {
      const server = await startUiWelcome({
        directory: pc.directory,
        keychainUsable: () => Promise.resolve(true),
        assets: () => ({ files: assets }),
        open: (name) => openUiHostAgent(hostDeps, name),
        startServer: (options) => startServer(options),
        ...(welcome.invite === undefined ? {} : { waitingInvite: welcome.invite }),
        // U3-g-c: the same harness desk as `ui` (list only on Welcome).
        aiApps: () => wiring.aiApps(),
        // HOTFIX-045-REMOVE-FIRSTRUN: Remove works in the session first run started.
        removal: uiRemovalPort({ home: pc.home, runtime: pc.runtime }),
      });
      if (server !== undefined) servers.push(server);
      return server;
    },
    start: async (name, startOptions = {}) => {
      const { invite } = startOptions;
      const entry = await pc.directory.read(name ?? 'default').catch(() => undefined);
      if (entry?.removing === true) return undefined;
      const opened = await owner.open(name);
      if (opened.status !== 'ok') return undefined;
      const { agent } = opened;
      const localUi = await localUiOptions(agent, wiring);
      const page = localUi.ownerSetup === undefined ? ('home' as const) : ('first-run' as const);
      const source = createUiApprovalSource({ ...agent, close: () => Promise.resolve() } as never, {
        now,
      });
      const server = await startServer({
        source,
        localUi,
        host: {
          directory: pc.directory,
          initial: {
            name: agent.name,
            label: entry?.label ?? agent.name,
            source,
            localUi: withoutAssets(localUi),
            close: () => agent.close(),
          },
          open: (other) => openUiHostAgent(hostDeps, other),
          removal: uiRemovalPort({ home: pc.home, runtime: pc.runtime }),
          ...(invite === undefined ? {} : { waitingInvite: invite }),
        },
      });
      const ui: UiServer = {
        page,
        open: () => (invite === undefined ? server.openHome() : server.openJoin()),
        close: async () => {
          await server.close().catch(() => undefined);
          await agent.close();
        },
      };
      servers.push(ui);
      return ui;
    },
    waitMs: 30 * 60_000,
    interrupt: (stop) => {
      stopWait = stop;
      return () => {
        stopWait = undefined;
      };
    },
  };
  return Object.assign(deps, { stop: () => stopWait?.(), servers });
}

/** Runs `agentlink ui` on this computer until `stop()`; resolves to its exit code and printed lines. */
export function runUi(
  pc: Computer,
  assets: Map<string, Uint8Array>,
  options: { readonly invite?: string } = {},
): {
  readonly deps: ReturnType<typeof uiDepsOf>;
  readonly done: Promise<{ code: number; printed: string[]; errors: string[] }>;
} {
  const deps = uiDepsOf(pc, assets);
  const printed: string[] = [];
  const errors: string[] = [];
  const context = {
    command: options.invite === undefined ? 'ui' : 'join',
    parsed: { values: {}, positionals: [], agent: undefined },
    output: {
      print: (l: string) => void printed.push(l),
      printError: (l: string) => void errors.push(l),
    },
    // An owner's own terminal (a TTY, no harness marker).
    terminal: { stdinIsTTY: true, stdoutIsTTY: true, env: {} },
  };
  const done = serveUi(
    context as never,
    deps,
    'agentlink',
    options.invite === undefined ? undefined : { invite: options.invite, opened: 'opened' },
  ).then((code) => ({ code, printed, errors }));
  return { deps, done };
}

/** Waits until the link `ui` handed to the opener is there. */
export async function openedLink(pc: Computer, index = 0, ms = 30_000): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const link = pc.opened[index];
    if (link !== undefined) return link;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the app did not open a link');
}

/** An AI app's MCP server for one agent, in this process: what the entry in its settings starts. */
export interface AiAppMcp {
  call(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{
    structured: Record<string, unknown>;
    text: string;
    isError: boolean;
  }>;
  close(): Promise<void>;
}

export async function startAiAppMcp(pc: Computer, agent: string | undefined): Promise<AiAppMcp> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const handler = createMcpCommand({
    openAgent: (options) => openAgent({ ...options, home: pc.home, deps: pc.runtime }),
    transport: () => serverSide,
    version: '0.0.0-e2e',
    logger: createLogger({ name: 'u3k-mcp', level: 'error', sink: () => undefined }),
    loop: { syncIntervalMs: 500, leaseIntervalMs: 1_000 },
  });
  const done = handler({
    command: 'mcp',
    parsed: { values: {}, positionals: [], agent },
    output: { print: () => undefined, printError: () => undefined },
    terminal: { stdinIsTTY: false, stdoutIsTTY: false, env: {} },
  } as never);
  const client = new Client({ name: 'agentlink-e2e', version: '0' });
  await client.connect(clientSide);
  await client.listTools();
  return {
    call: async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as { type: string; text?: string }[];
      return {
        structured: (result.structuredContent ?? {}) as Record<string, unknown>,
        text: content.map((c) => c.text ?? '').join('\n'),
        isError: result.isError === true,
      };
    },
    close: async () => {
      await client.close();
      await done;
    },
  };
}

/** Polls `check` until it returns a value. */
export async function until<T>(
  what: string,
  check: () => Promise<T | undefined>,
  ms = 30_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** A client-side fake harness: the folders and the settings file an AI app leaves in a home. */
export async function fakeClaudeCode(home: string): Promise<{ file: string; mode: number }> {
  await mkdir(join(home, '.claude'), { recursive: true });
  const file = join(home, '.claude.json');
  // Settings the person already has; the app must keep every byte but its own entry, and the mode.
  await writeFile(
    file,
    `${JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } }, null, 2)}\n`,
    { mode: 0o640 },
  );
  const { chmod } = await import('node:fs/promises');
  await chmod(file, 0o640);
  return { file, mode: 0o640 };
}

/** Chromium with a virtual authenticator: Touch ID for the page (CDP WebAuthn, PRF on). */
export async function launchBrowser(): Promise<{ browser?: Browser; error?: unknown }> {
  const executablePath = process.env['AGENTLINK_TEST_CHROMIUM'];
  try {
    return {
      browser: await chromium.launch(executablePath === undefined ? {} : { executablePath }),
    };
  } catch (error) {
    return { error };
  }
}

export async function pageWithTouchId(
  browser: Browser,
  viewport = { width: 1280, height: 900 },
): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({
    viewport,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });
  return { page, context };
}

export type { AgentLinkClient };

/**
 * An agent the way 0.4.3 (and `agentlink init`) leaves it: a keychain identity, the four-key
 * config.json under <home>/.agentlink/agents/<name>, and an owner-signed first card. The owner here is
 * the crypto test seam (no passkey; the pages are not used for these agents), as in support.ts.
 */
export async function seedAgent(
  pc: Computer,
  options: { readonly name: string; readonly displayName: string },
): Promise<{ agentId: string; ownerCode: string }> {
  const agentId = await createKeychainAgent(pc.keychain);
  await writeAgentConfig(pc.home, { v: 1, name: options.name, agentId, keyStore: 'keychain' });
  const seed = randomBytes(32);
  const code = Buffer.from(randomBytes(16)).toString('hex');
  const presence = (): OwnerPresence => ({ kind: 'passphrase', secret: encodeUtf8(code) });
  const owner = new MemoryOwnerKeyStore(seed, presence());
  seed.fill(0);
  const opened = await openAgent({ agent: options.name, home: pc.home, deps: pc.runtime });
  if (opened.status !== 'ok') throw new Error('the seeded agent did not open');
  const session = await owner.unlock(presence());
  try {
    await opened.agent.client.identity.init({
      owner: session,
      ownerKeys: await owner.getPublicKeys(),
      name: options.displayName,
      relays: CARD_RELAYS,
    });
  } finally {
    await session.close();
    await opened.agent.close();
  }
  return { agentId, ownerCode: code };
}

/** Runs `agentlink join '<link>'` on this computer (the shipped joinStep) until `stop()`. */
export function runJoin(
  pc: Computer,
  assets: Map<string, Uint8Array>,
  link: string,
): {
  readonly deps: ReturnType<typeof uiDepsOf>;
  readonly done: Promise<{ code: number; printed: string[]; errors: string[] }>;
} {
  const deps = uiDepsOf(pc, assets);
  const printed: string[] = [];
  const errors: string[] = [];
  const done = joinStep(
    {
      command: 'join',
      parsed: { values: {}, positionals: [`'${link}'`], agent: undefined },
      output: {
        print: (l: string) => void printed.push(l),
        printError: (l: string) => void errors.push(l),
      },
      terminal: { stdinIsTTY: true, stdoutIsTTY: true, env: {} },
    } as never,
    {
      // A format 1 link resolves to itself (W4-SHORT-INVITE).
      resolve: (l) => Promise.resolve(l),
      check: (l, now) => checkInviteLink(l, now),
      now: () => Math.floor(Date.now() / 1000),
      // No app host is running on this computer: `join` starts its own.
      readRecord: () => Promise.resolve(undefined),
      alive: () => false,
      handoff: () => Promise.resolve('failed' as never),
      ui: deps,
    },
    'agentlink',
  ).then((code) => ({ code, printed, errors }));
  return { deps, done };
}
