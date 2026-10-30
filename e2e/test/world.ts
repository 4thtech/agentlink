// M1-13c: the two "worlds" the files-and-proof scenario (files-proof-scenario.ts) runs against, and
// the in-process agent host both use.
//
// - The fake world (always on in the deterministic job, no network, no key): the repo's own fakes
//   behind the real agent stack. Each agent is the real `openAgent` of the built CLI (real OS
//   keychain, real SQLite store, local strfry relays) and the real `createMcpCommand` MCP server over
//   an in-memory transport, so the tools, the policy, the approvals and the background loop are the
//   shipped ones. Two things are substituted, through the runtime's own seams (RuntimeDeps):
//   the proof platform (`FakeNotary`, packages/core/src/testing: the EIP-712, credit and receipt
//   rules of the Notary, one instance shared by every agent) and the encrypted drop (fake-drop.mjs,
//   the drop's HTTP protocol in memory).
// - The live world (opt-in, live-files-and-proof.test.ts): nothing substituted but the relays. The
//   real submitter, RPC, drop and faucet are used through the CLI's default platform.
//
// Nothing here prints or logs a key, an RPC URL or a drop URL (I-7).
import type { Logger } from '@4thtech-io/log';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpCommand } from '../../apps/cli/dist/mcp/command.js';
import { createPackVerifier } from '../../apps/cli/dist/runtime/pack-verifier.js';
import { nodeProofs } from '../../apps/cli/dist/runtime/proofs.js';
import { openAgent, type RuntimeDeps } from '../../apps/cli/dist/runtime/index.js';
import { BASE_SEPOLIA, FEE_UNITS, FakeNotary } from '../../packages/core/src/testing/chain.js';
import { createFakeDrop } from '../src/fake-drop.mjs';
import { e2eRuntimeDeps, fileLogger, type McpCall, type TestAgent } from './support.js';
import type { WriteStream } from 'node:fs';

export interface McpHandle {
  call: (name: string, args?: Record<string, unknown>) => Promise<McpCall>;
  tools: () => Promise<string[]>;
  close: () => Promise<void>;
}

/** Short loop intervals, as in src/agent-host.mjs: the scenario waits on delivery. */
const LOOP = Object.freeze({ syncIntervalMs: 1_000, leaseIntervalMs: 2_000 });

/** The agent's `agentlink mcp` server (createMcpCommand) and a scripted client, in this process. */
export async function startInProcess(
  agent: TestAgent,
  deps: RuntimeDeps,
  log: WriteStream,
): Promise<McpHandle> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const logger: Logger = fileLogger(`inproc-${agent.label}`, log);
  const handler = createMcpCommand({
    openAgent: (options) => openAgent({ ...options, home: agent.home, deps }),
    transport: () => serverSide,
    version: '0.0.0-e2e',
    logger,
    loop: LOOP,
  });
  const done = handler({
    command: 'mcp',
    parsed: { values: {}, positionals: [], agent: undefined },
    output: { print: () => undefined, printError: () => undefined },
    terminal: { stdinIsTTY: false, stdoutIsTTY: false, env: {} },
  } as never);
  const client = new Client({ name: 'agentlink-e2e', version: '0' });
  await client.connect(clientSide);
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
    close: async () => {
      await client.close();
      await done;
    },
  };
}

export type PackVerifier = ReturnType<typeof createPackVerifier>;

export interface World {
  readonly kind: 'fake' | 'live';
  /** The runtime of every agent in this world (local relays; fakes only in the fake world). */
  deps(relays: Readonly<Record<string, number>>): RuntimeDeps;
  /** The pack verifier a third party's `agentlink verify` runs (fake chain, or the shipped RPC). */
  verifier(): PackVerifier;
  /**
   * J3: the agent takes the faucet route and gets testnet credits (no chain is chosen by hand).
   * Returns false when the faucet refused (live: a rate limit), so the caller can skip, not retry.
   */
  topUp(agentId: string): Promise<boolean>;
  /** Wait budgets: the fake world answers at once; the live one waits for blocks. */
  readonly waitMs: { readonly relay: number; readonly chain: number };
  /** The files the world's drop saw (fake only), for the zero-access audit. */
  readonly drop?: ReturnType<typeof createFakeDrop>;
  readonly notary?: FakeNotary;
  /** What the world stored that the canary scan must read (fake: the drop's ciphertext). */
  readonly storedBytes?: () => Uint8Array[];
}

/** The fake world: one shared FakeNotary and one fake drop for every agent. */
export function createFakeWorld(): World {
  const notary = new FakeNotary(() => Math.floor(Date.now() / 1000));
  const drop = createFakeDrop();
  const verifier = createPackVerifier({
    configs: [BASE_SEPOLIA],
    reuse: [{ config: BASE_SEPOLIA, client: notary.client }],
  });
  return {
    kind: 'fake',
    notary,
    drop,
    waitMs: { relay: 60_000, chain: 20_000 },
    // W4-SHORT-INVITE: invite objects are drop bytes too (the zero-access audit covers them).
    storedBytes: () => [
      ...[...drop.objects.values()].flatMap((o) => (o.bytes ? [o.bytes] : [])),
      ...[...drop.invites.values()].map((o) => o.bytes),
    ],
    verifier: () => verifier,
    topUp: (agentId) => {
      // The faucet's gift: 50 cents of testnet credits, five $0.10 fees (apps/submitter faucet,
      // M1-10b; `FAUCET_DEFAULTS.usdCents`).
      notary.fund(agentId, 5n * FEE_UNITS);
      return Promise.resolve(true);
    },
    deps(relays) {
      const base = e2eRuntimeDeps(relays);
      return {
        ...base,
        createClient: (options) =>
          base.createClient({
            ...options,
            ...(options.files === undefined
              ? {}
              : {
                  files: {
                    ...options.files,
                    drop: { endpoint: drop.origin, fetch: drop.fetch },
                    download: drop.download,
                  },
                }),
          }),
        proofs: ({ home }) => {
          // The real platform object for the pack files (readPack, savePack); its chain half, the
          // verifier and the account read are replaced below, so its own RPC clients are never used.
          const real = nodeProofs({ home, configs: [BASE_SEPOLIA] });
          if (real === undefined) return undefined;
          return {
            platform: notary.platform(),
            tools: {
              ...real.tools,
              verify: async (pack) => {
                const result = await verifier(pack);
                if (!result.valid)
                  return { valid: false, verdict: 'failed', reason: result.reason };
                const content =
                  result.content.status === 'verified' || result.content.status === 'unattributed'
                    ? (result.content.payload as unknown)
                    : undefined;
                return {
                  valid: true,
                  verdict: result.verdict,
                  chain: result.chain,
                  recordId: result.recordId,
                  signer: result.signer,
                  signerCard:
                    result.signerCard === null
                      ? null
                      : {
                          ownerEvm: result.signerCard.ownerEvm,
                          ownerNostr: result.signerCard.ownerNostr,
                          ownerEnc: result.signerCard.ownerEnc,
                        },
                  timestamp: result.timestamp,
                  envelopeHash: result.envelopeHash,
                  receipts: result.receipts.map((r) => ({ type: r.type, at: r.at })),
                  contentVerified: result.contentVerified,
                  content,
                  notices: result.notices.map((n) => n.code),
                };
              },
              account: (agentId) =>
                Promise.resolve({
                  credits: [
                    {
                      chain: BASE_SEPOLIA.key,
                      token: 'USDC',
                      amount: notary.creditOf(agentId).toString(),
                      usd: (Number(notary.creditOf(agentId)) / 1e6).toFixed(2),
                    },
                  ],
                  prices: [
                    { action: 'notarize', usd: '0.10', protocolUsd: '0.10', integratorUsd: '0' },
                  ],
                }),
            },
          };
        },
      };
    },
  };
}

/** The base URL of the testnet submitter and its faucet (D-28 testing hostname, 07 §6.2). */
export const LIVE_SUBMITTER = 'https://submit.agentlink.4thtech.io';

/**
 * The live world: the CLI's default platform (shipped RPC, the 4thTech submitter, the real drop,
 * automatic chain selection) with only the relays local. The faucet is called once per agent that
 * needs credits and never retried: a refusal (already claimed, rate limited, daily cap) ends the
 * attempt and the caller skips.
 */
export function createLiveWorld(): World {
  const verifier = createPackVerifier();
  return {
    kind: 'live',
    waitMs: { relay: 90_000, chain: 240_000 },
    verifier: () => verifier,
    deps: (relays) => e2eRuntimeDeps(relays),
    async topUp(agentId) {
      const response = await fetch(`${LIVE_SUBMITTER}/v1/faucet`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chainId: BASE_SEPOLIA.chainId, agent: agentId }),
        redirect: 'manual',
        signal: AbortSignal.timeout(60_000),
      });
      // Only the status is kept: the answer carries a transaction hash and nothing else.
      await response.arrayBuffer().catch(() => undefined);
      return response.status === 200;
    },
  };
}
