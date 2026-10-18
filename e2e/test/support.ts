// M1-13a: what both e2e variants share. An agent here is set up the way `agentlink init` and
// `agentlink owner init` leave it (an agent identity in the real OS keychain, the recorded config
// under <home>/.agentlink, an owner-signed first card in the real SQLite store), except that the
// owner is the crypto test seam's MemoryOwnerKeyStore with a code generated per run: no owner prompt
// exists without a TTY (D-67), and 04 §3.1.1 allows the seam in e2e. The AGENT key is the real
// keychain KeyStore throughout, and every agent runs in its own home directory and its own process.
//
// Owner approvals go through the CLI's own `agentlink approve <id>` handler (apps/cli dist), with
// only the TTY owner-code step replaced by the test owner's signature (the `decide` dependency).
//
// Nothing here prints. Logs go to files under the artifact directory, which the canary scan reads.
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { computeActionDigest, nostrTransport } from '@4thtech-io/core';
import {
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  randomBytes,
  type JsonObject,
  type OwnerPresence,
} from '@4thtech-io/crypto';
import { MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { createLogger, type Logger } from '@4thtech-io/log';
import { createOsKeychainAgent, LOCAL_APPROVAL_LIFETIME_S } from '@4thtech-io/node';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { approveHandler } from '../../apps/cli/dist/commands/owner/approve.js';
import { nodeOwnerDeps } from '../../apps/cli/dist/commands/owner/deps.js';
import {
  nodeRuntimeDeps,
  openAgent,
  writeAgentConfig,
  type RuntimeDeps,
} from '../../apps/cli/dist/runtime/index.js';
import { spellings } from '../src/canary-scan.mjs';
import { localRelayConnector } from '../src/local-connector.mjs';
import { RELAY_HOSTS } from '../src/relays.mjs';

export const HOST = fileURLToPath(new URL('../src/agent-host.mjs', import.meta.url));
export const SKILL_FILE = fileURLToPath(
  new URL('../../skills/agentlink/SKILL.md', import.meta.url),
);

/** Where logs, results and transcripts go (uploaded as the CI artifact, after the canary scan). */
export async function artifactDir(): Promise<string> {
  const dir =
    process.env['AGENTLINK_E2E_ARTIFACTS'] ??
    (await mkdtemp(join(tmpdir(), 'agentlink-e2e-artifacts-')));
  await mkdir(dir, { recursive: true });
  return dir;
}

/** The canaries file: OUTSIDE the artifact directory, never uploaded. */
export function canariesFile(): string {
  return (
    process.env['AGENTLINK_E2E_CANARIES'] ??
    join(tmpdir(), `agentlink-e2e-canaries-${process.pid}.json`)
  );
}

export interface Canary {
  readonly name: string;
  readonly value: string;
  readonly where?: 'all' | 'outside-transcripts';
}

export class Canaries {
  readonly list: Canary[] = [];
  add(canary: Canary): void {
    this.list.push(canary);
  }
  addBytes(name: string, bytes: Uint8Array): void {
    for (const s of spellings(name, bytes)) this.list.push(s);
  }
  async write(): Promise<string> {
    const file = canariesFile();
    await writeFile(file, JSON.stringify(this.list), { mode: 0o600 });
    return file;
  }
}

/** A log file for the driver's own logger (redacted lines only). */
export function fileLogger(name: string, stream: WriteStream): Logger {
  return createLogger({ name, sink: (_level, line) => void stream.write(`${line}\n`) });
}

/**
 * OPS-CI-7 (nightly two-machine run): the agents use the real relays through the production
 * transport instead of the local strfry containers. Opt-in by this variable; every other e2e
 * suite keeps the local relays.
 */
export const REAL_RELAYS = process.env['AGENTLINK_E2E_REAL_RELAYS'] === '1';

export function e2eRuntimeDeps(relays: Readonly<Record<string, number>>): RuntimeDeps {
  if (REAL_RELAYS) return nodeRuntimeDeps;
  const map = new Map(Object.entries(relays));
  return {
    ...nodeRuntimeDeps,
    transport: () =>
      nostrTransport({ connector: localRelayConnector(map), addressCheck: 'platform' }),
  };
}

export interface TestAgent {
  readonly label: string;
  readonly displayName: string;
  readonly home: string;
  readonly agentId: string;
  readonly relays: readonly string[];
  readonly owner: MemoryOwnerKeyStore;
  readonly presence: () => OwnerPresence;
}

/** Sets up one agent: keychain identity, config, owner-signed first card with `relays`. */
export async function setupAgent(options: {
  readonly label: string;
  readonly displayName: string;
  readonly relayHosts: readonly string[];
  readonly relayMap: Readonly<Record<string, number>>;
  readonly canaries: Canaries;
  readonly logger: Logger;
}): Promise<TestAgent> {
  const home = await realpath(await mkdtemp(join(tmpdir(), `agentlink-e2e-${options.label}-`)));
  const agentId = await createOsKeychainAgent();
  await writeAgentConfig(home, { v: 1, name: 'default', agentId, keyStore: 'keychain' });

  // The test owner: seed and code are canaries (they must never reach a log, relay or artifact).
  const seed = randomBytes(32);
  const code = encodeHex(randomBytes(16));
  options.canaries.addBytes(`${options.label} owner seed`, seed);
  options.canaries.add({ name: `${options.label} owner code`, value: code });
  const presence = (): OwnerPresence => ({ kind: 'passphrase', secret: encodeUtf8(code) });
  const owner = new MemoryOwnerKeyStore(seed, presence());
  seed.fill(0);

  const relays = options.relayHosts.map((host) => `wss://${host}`);
  const opened = await openAgent({
    home,
    deps: e2eRuntimeDeps(options.relayMap),
    logger: options.logger,
  });
  if (opened.status !== 'ok') throw new Error(`agent ${options.label} did not open`);
  const session = await owner.unlock(presence());
  try {
    await opened.agent.client.identity.init({
      owner: session,
      ownerKeys: await owner.getPublicKeys(),
      name: options.displayName,
      relays,
    });
  } finally {
    await session.close();
    await opened.agent.close();
  }
  return {
    label: options.label,
    displayName: options.displayName,
    home,
    agentId,
    relays,
    owner,
    presence,
  };
}

/** The pending approval IDs of an agent, read from its store the way `agentlink approve` reads them. */
export async function pendingApprovalIds(agent: TestAgent): Promise<string[]> {
  const deps = nodeOwnerDeps(agent.home);
  const opened = await deps.open(undefined);
  if (opened.status !== 'ok') throw new Error(`agent ${agent.label} did not open`);
  try {
    const rows = await opened.agent.store.transaction((tx) =>
      tx.select('approvals', { status: 'pending' }),
    );
    return rows.map((row) => String(row['approval_id']));
  } finally {
    await opened.agent.close();
  }
}

/** Rows of one store table of an agent, read the way `pendingApprovalIds` reads (a second reader). */
export async function storeRows(
  agent: TestAgent,
  table: 'envelopes' | 'approvals',
  where: Record<string, string> = {},
): Promise<Record<string, unknown>[]> {
  const deps = nodeOwnerDeps(agent.home);
  const opened = await deps.open(undefined);
  if (opened.status !== 'ok') throw new Error(`agent ${agent.label} did not open`);
  try {
    const rows = await opened.agent.store.transaction((tx) => tx.select(table, where as never));
    return rows as unknown as Record<string, unknown>[];
  } finally {
    await opened.agent.close();
  }
}

/** How many envelopes of `type` the agent has sent (direction `out`), from its own store. */
export async function sentCount(agent: TestAgent, type: string): Promise<number> {
  return (await storeRows(agent, 'envelopes', { direction: 'out', type })).length;
}

/** The part of the policy the scenarios change (06 §3 `commitments`). */
export interface CommitmentsEdit {
  commitments: {
    autoAcceptContacts: string[];
    autoAcceptMaxUSD: string;
    autoAcceptDirection: string;
  };
}

/**
 * The owner changes the policy: loads the effective policy, lets `edit` change a copy, signs a
 * `policy.set` with the test owner key and applies it (the same call `agentlink owner` makes). Call
 * it before the agent's MCP server starts.
 */
export async function setOwnerPolicy(
  agent: TestAgent,
  edit: (policy: CommitmentsEdit) => void,
  version: number,
): Promise<void> {
  const deps = nodeOwnerDeps(agent.home);
  const opened = await deps.open(undefined);
  if (opened.status !== 'ok') throw new Error(`agent ${agent.label} did not open`);
  try {
    const { ownerActions } = opened.agent.client;
    const loaded = await ownerActions.loadPolicy();
    if (loaded.mode === 'fail_closed') throw new Error('policy is fail-closed');
    const policy = structuredClone(loaded.policy) as unknown as CommitmentsEdit;
    edit(policy);
    const issuedAt = Math.floor(Date.now() / 1000);
    const keys = await agent.owner.getPublicKeys();
    const body: JsonObject = {
      v: 1,
      agent: agent.agentId,
      owner: encodeHex(keys.ownerNostr),
      op: 'policy.set',
      params: { version, policy: policy as unknown as JsonObject },
      nonce: encodeBase64url(randomBytes(16)),
      issuedAt,
      expiresAt: issuedAt + 600,
    };
    const session = await agent.owner.unlock(agent.presence());
    let sig: string;
    try {
      sig = await session.signOwnerAction(body);
    } finally {
      await session.close();
    }
    const applied = await ownerActions.apply(JSON.stringify({ body, sig }));
    if (applied.status !== 'applied') throw new Error('the policy was not applied');
  } finally {
    await opened.agent.close();
  }
}

/**
 * The owner approves one request through the CLI's `agentlink approve <id>` handler; only the TTY
 * owner-code step is the test owner's signature. Returns the handler's exit code (0: applied).
 */
export async function ownerApprove(agent: TestAgent, approvalId: string): Promise<number> {
  const real = nodeOwnerDeps(agent.home);
  const deps = {
    ...real,
    decide: async (
      context: { readonly agent: string; readonly owner: { readonly ownerNostr: Uint8Array } },
      reviewed: readonly {
        readonly approvalId: string;
        readonly action: JsonObject;
        readonly decision: 'approve' | 'deny';
        readonly requestExpiresAt: number;
      }[],
    ) => {
      const [item] = reviewed;
      if (item === undefined || reviewed.length !== 1) throw new Error('one request at a time');
      const issuedAt = Math.floor(Date.now() / 1000);
      const body: JsonObject = {
        v: 1,
        agent: context.agent,
        owner: encodeHex(context.owner.ownerNostr),
        op: 'approval.decide',
        params: {
          approvalId: item.approvalId,
          actionDigest: computeActionDigest(item.action),
          decision: item.decision,
        },
        nonce: encodeBase64url(randomBytes(16)),
        issuedAt,
        expiresAt: Math.min(issuedAt + LOCAL_APPROVAL_LIFETIME_S, item.requestExpiresAt),
      };
      const session = await agent.owner.unlock(agent.presence());
      try {
        return { body, sig: await session.signOwnerAction(body) };
      } finally {
        await session.close();
      }
    },
    ask: () => Promise.resolve('n'),
  } as unknown as typeof real;
  return approveHandler(deps)({
    command: 'approve',
    parsed: { values: {}, positionals: [approvalId], agent: undefined },
    output: { print: () => undefined, printError: () => undefined },
    terminal: { stdinIsTTY: true, stdoutIsTTY: true, env: {} },
  });
}

/** The environment of an agent's own processes: its home, the relay map, nothing else secret. */
export function agentEnv(
  agent: TestAgent,
  relayMap: Readonly<Record<string, number>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'LANG', 'TMPDIR']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  // On macOS the agent's keychain item is found through the real HOME (its data folder is `--home`,
  // not HOME), so in the nightly run its own processes keep it; on Linux the keyring is over D-Bus.
  const keepRealHome = REAL_RELAYS && process.platform === 'darwin';
  env['HOME'] = keepRealHome ? (process.env['HOME'] ?? agent.home) : agent.home;
  if (REAL_RELAYS) env['AGENTLINK_E2E_REAL_RELAYS'] = '1';
  env['AGENTLINK_E2E_RELAYS'] = JSON.stringify(relayMap);
  return env;
}

export interface McpCall {
  readonly structured: Record<string, unknown>;
  readonly text: string;
  readonly isError: boolean;
}

/** A scripted MCP client to an agent's `mcp` host over stdio; the host's stderr goes to `log`. */
export async function connectMcp(
  agent: TestAgent,
  relayMap: Readonly<Record<string, number>>,
  log: WriteStream,
): Promise<{
  call: (name: string, args?: Record<string, unknown>) => Promise<McpCall>;
  close: () => Promise<void>;
  tools: () => Promise<string[]>;
}> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [HOST, 'mcp', '--home', agent.home],
    env: agentEnv(agent, relayMap),
    stderr: 'pipe',
  });
  transport.stderr?.pipe(log, { end: false });
  const client = new Client({ name: 'agentlink-e2e', version: '0' });
  await client.connect(transport);
  await client.listTools();
  return {
    tools: async () => (await client.listTools()).tools.map((t) => t.name),
    call: async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as { type: string; text?: string }[];
      return {
        structured: (result.structuredContent ?? {}) as Record<string, unknown>,
        text: content.map((c) => c.text ?? '').join('\n'),
        isError: result.isError === true,
      };
    },
    close: () => client.close(),
  };
}

/** The agent's background loop alone (agent-host.mjs pump); stop it with `stopProcess`. */
export function spawnPump(
  agent: TestAgent,
  relayMap: Readonly<Record<string, number>>,
  log: WriteStream,
): ChildProcess {
  const child = spawn(process.execPath, [HOST, 'pump', '--home', agent.home], {
    env: agentEnv(agent, relayMap),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.pipe(log, { end: false });
  return child;
}

export function stopProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

/** Polls `check` every 500 ms until it returns a value, or fails after `ms`. */
export async function waitFor<T>(
  what: string,
  check: () => Promise<T | undefined>,
  ms: number,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export function openLog(dir: string, name: string): WriteStream {
  return createWriteStream(join(dir, name), { flags: 'a', mode: 0o600 });
}

export { RELAY_HOSTS };
