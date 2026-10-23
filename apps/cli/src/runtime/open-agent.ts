// Opening an agent (M1-9k; 06 §6, 07 §9.1, D-73 (3)). Every `agentlink` command and every
// `agentlink mcp` process opens an agent the same way, so all of them share one KeyStore and one
// SQLite store file (06 §6: SQLite WAL and the store's busy timeout order their transactions):
//
// 1. the local agent name (06 §6 pattern), then its recorded config under ~/.agentlink;
// 2. the recorded KeyStore backend: for the keychain, the probe and `selectKeyStoreBackend`
//    (`needs_setup` with the 07 §9.4 copy without a usable keychain), then `openAgentKeyStore`;
// 3. `openAgentStore` (store, cipher, policy mark);
// 4. the relay I/O from @4thtech-io/node as the client's transport (07 §4.2);
// 5. the M1a approval channel over the same store, and `AgentLinkClient.create`;
// 6. the files platform (M1-9d-1, src/runtime/files.ts): the allowed-folder check of `path`
//    arguments, the encrypted drop (D-48), the SSRF-safe download and the inbox folder.
//
// I-1/I-4: the runtime holds only the agent's KeyStore interface; it never holds an owner key and
// takes no owner presence. Owner commands (M1-9b) take presence themselves, through @4thtech-io/node.
// I-7: errors carry fixed text only (RuntimeError, or @4thtech-io/node's own fixed messages).
import { homedir } from 'node:os';
import process from 'node:process';
import {
  AgentLinkClient,
  nostrTransport,
  type ApprovalChannel,
  type TransportFactory,
} from '@4thtech-io/core';
import type { KeyStore } from '@4thtech-io/crypto';
import { createLogger, type Logger } from '@4thtech-io/log';
import { cliLogLevel } from './log-level.js';
import {
  nodeHostResolver,
  nodeNip11Fetcher,
  nodeRelayConnector,
  openAgentKeyStore,
  openAgentStore,
  probeOsKeychain,
  selectKeyStoreBackend,
  type AgentStore,
  type KeyStoreBackendKind,
  type KeychainProbe,
} from '@4thtech-io/node';
import { createLocalApprovalChannel, storeApprovalReader } from '../approval/local-channel.js';
import { readAgentConfig, type AgentPaths } from './agent-dir.js';
import { DEFAULT_AGENT_NAME, isAgentName } from './agent-name.js';
import { RuntimeError } from './errors.js';
import { DROP_ORIGIN, nodeFileOpener, nodeFilesPlatform } from './files.js';
import { fileFreeCreditsMarker } from './free-credits.js';
import { nodeProofs, type NodeProofs } from './proofs.js';
import type { FileOpener, ProofPlatformTools } from '../tools/context.js';
import type { FreeCreditsMarker } from '../tools/free-credits.js';

/** The Node pieces the runtime is built from. Tests pass doubles; production uses @4thtech-io/node. */
export interface RuntimeDeps {
  readonly probeKeychain: () => Promise<KeychainProbe>;
  readonly openKeyStore: (backend: KeyStoreBackendKind, agentId: string) => Promise<KeyStore>;
  readonly openStore: (
    backend: KeyStoreBackendKind,
    agentId: string,
    path: string,
  ) => Promise<AgentStore>;
  readonly transport: () => TransportFactory;
  readonly createClient: typeof AgentLinkClient.create;
  /**
   * The proof platform (M1-9d-2, src/runtime/proofs.ts): read clients, chain-state ports and
   * submitters for the shipped chains, the pack files and the verifier. Absent or undefined: no
   * proof tools (the core answers PROOFS_UNAVAILABLE).
   */
  readonly proofs?: (options: { readonly home: string }) => NodeProofs | undefined;
}

export const nodeRuntimeDeps: RuntimeDeps = Object.freeze<RuntimeDeps>({
  probeKeychain: () => probeOsKeychain(),
  openKeyStore: (backend: KeyStoreBackendKind, agentId: string) =>
    openAgentKeyStore(backend, agentId),
  openStore: (backend: KeyStoreBackendKind, agentId: string, path: string) =>
    openAgentStore(backend, agentId, path),
  transport: () =>
    nostrTransport({
      connector: nodeRelayConnector(),
      addressCheck: { resolver: nodeHostResolver() },
      nip11: nodeNip11Fetcher(),
    }),
  createClient: (options) => AgentLinkClient.create(options),
  proofs: ({ home }) => nodeProofs({ home }),
});

export interface OpenAgentOptions {
  /** The local agent name (06 §6). Default `default`. */
  readonly agent?: string;
  /** The home directory that holds `.agentlink`. Default the OS user's home. */
  readonly home?: string;
  readonly deps?: RuntimeDeps;
  /** Unix seconds. Default the system clock. */
  readonly clock?: () => number;
  readonly logger?: Logger;
}

/** An opened agent. `close()` closes the relay connections, the store and the KeyStore, once. */
export interface OpenedAgent {
  readonly name: string;
  readonly agentId: string;
  readonly paths: AgentPaths;
  readonly client: AgentLinkClient;
  /** The M1a approval channel the client was built with (06 §2.5). */
  readonly approvals: ApprovalChannel;
  /** The allowed-folder check for `path` arguments (M1-9d-1); absent: no file tools. */
  readonly files?: FileOpener;
  /** The proof platform's tool half (M1-9d-2); absent: no proof tools. */
  readonly proofs?: ProofPlatformTools;
  /** M1-36i: where the free test credits claim is remembered (the agent's folder). */
  readonly freeCredits?: FreeCreditsMarker;
  close(): Promise<void>;
}

export type OpenAgentResult =
  | { readonly status: 'ok'; readonly agent: OpenedAgent }
  | {
      readonly status: 'needs_setup';
      readonly reason: 'no_agent' | 'no_keychain';
      /** Fixed copy for the user (07 §9.4 for `no_keychain`). */
      readonly message: string;
      /** How to make the keychain usable, when the probe said so (07 §9.1). */
      readonly fix?: string;
    };

/** `needs_setup` `no_agent`: nothing is set up for this name. Fixed text; never names the agent. */
export const NO_AGENT_MESSAGE =
  'AgentLink is not set up for this agent on this machine yet. Run `agentlink init` yourself, in your own terminal.';

const systemClock = (): number => Math.floor(Date.now() / 1000);

/**
 * The https origins of the 4thTech encrypted drop (D-48) that an inbox page shows as `drop` (06 §2.2
 * `FileInfo.delivery`; any other file URL shows as `own`): the default drop (M1-9d-1).
 */
export const DROP_ORIGINS: readonly string[] = Object.freeze([DROP_ORIGIN]);

/** Opens a local agent for a command or an `agentlink mcp` process. */
export async function openAgent(options: OpenAgentOptions = {}): Promise<OpenAgentResult> {
  const name = options.agent ?? DEFAULT_AGENT_NAME;
  if (!isAgentName(name)) throw new RuntimeError('agent_name_invalid');
  const deps = options.deps ?? nodeRuntimeDeps;
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? createLogger({ name: 'cli', level: cliLogLevel(process.env) });

  const found = await readAgentConfig(options.home ?? homedir(), name);
  if (found === undefined) {
    return { status: 'needs_setup', reason: 'no_agent', message: NO_AGENT_MESSAGE };
  }
  const { config, paths } = found;
  const home = options.home ?? homedir();

  if (config.keyStore === 'keychain') {
    const probe = await deps.probeKeychain();
    const selection = selectKeyStoreBackend(probe, { fileOptIn: false });
    if (!selection.ok) {
      if (selection.status === 'needs_setup') {
        return {
          status: 'needs_setup',
          reason: 'no_keychain',
          message: selection.message,
          fix: selection.fix,
        };
      }
      throw new RuntimeError('agent_open_failed');
    }
  }

  // Each step's own errors are fixed text (@4thtech-io/node); anything opened is closed on failure.
  const keyStore = await deps.openKeyStore(config.keyStore, config.agentId);
  let agentStore: AgentStore;
  try {
    agentStore = await deps.openStore(config.keyStore, config.agentId, paths.store);
  } catch (error) {
    await keyStore.close().catch(() => undefined);
    throw error;
  }
  // A chain list that does not compose (a release mismatch) fails closed: no proofs, nothing else.
  let proofs: NodeProofs | undefined;
  try {
    proofs = deps.proofs?.({ home });
  } catch {
    logger.warn('proofs unavailable', { code: 'chain_config' });
    proofs = undefined;
  }
  const approvals = createLocalApprovalChannel({
    reader: storeApprovalReader(agentStore.store),
    clock,
  });
  let client: AgentLinkClient;
  try {
    client = await deps.createClient({
      keyStore,
      store: agentStore.store,
      cipher: agentStore.cipher,
      approvals,
      clock,
      logger,
      policyMark: agentStore.policyMark,
      receiptsKept: agentStore.receiptsKept,
      transport: deps.transport(),
      dropOrigins: DROP_ORIGINS,
      files: nodeFilesPlatform({ home }),
      ...(proofs === undefined ? {} : { proofs: proofs.platform }),
    });
  } catch (error) {
    await agentStore.close().catch(() => undefined);
    await keyStore.close().catch(() => undefined);
    throw error;
  }
  if (client.agentId !== config.agentId) {
    try {
      client.close();
    } catch {
      // closing a dead connection is not an error
    }
    await agentStore.close().catch(() => undefined);
    await keyStore.close().catch(() => undefined);
    throw new RuntimeError('agent_config_invalid');
  }

  let closing: Promise<void> | undefined;
  const agent: OpenedAgent = Object.freeze({
    name,
    agentId: config.agentId,
    paths,
    client,
    approvals,
    files: nodeFileOpener({ home }),
    ...(proofs === undefined
      ? {}
      : { proofs: proofs.tools, freeCredits: fileFreeCreditsMarker(paths.dir, config.agentId) }),
    close: (): Promise<void> => {
      closing ??= (async () => {
        // Relay connections first: an open socket or its idle timer keeps a one-shot process alive.
        try {
          client.close();
        } catch {
          // closing a dead connection is not an error
        }
        await agentStore.close().catch(() => undefined);
        await keyStore.close().catch(() => undefined);
      })();
      return closing;
    },
  });
  return { status: 'ok', agent };
}
