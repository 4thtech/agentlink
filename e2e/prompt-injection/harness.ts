// M1-13b / M1-13d: the in-process harness of the prompt-injection suites (06 §4, §9; 04 I-5, §7).
//
// A victim agent and one or more hostile counterparties, each a real core (AgentLinkClient) with its
// own MemoryKeyStore, MemoryStore and owner (the crypto test seam, 04 §3.1.1: allowed in e2e), over
// an in-memory NIP-01 relay network under the real nostrTransport. Every agent's tools are the BUILT
// CLI's MCP server (apps/cli/dist, as the other e2e suites use it) over the SDK's in-memory
// transport, called by the SDK client, which validates every `structuredContent` against the tool's
// `outputSchema`. Files go through the real Node files platform and allowed-folder opener on real
// temporary folders; proofs go through the core's in-memory Notary (packages/core/src/testing/
// chain.ts: the real chain package code over a fake chain) and the CLI's real pack reader.
//
// No Docker, no OS keychain, no network, no secret: this layer always runs. The hostile side is a
// counterparty that controls its own client, so it sends through the core API wherever the tool
// layer would refuse or normalise what a modified client could still put on the wire.
//
// Nothing here prints.
import { mkdir, mkdtemp, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AgentLinkClient,
  MemoryStore,
  computeActionDigest,
  nostrTransport,
  type ApprovalChannel,
  type Sealed,
  type StoreCipher,
} from '@4thtech-io/core';
import {
  decodeBase64url,
  decodeUtf8,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  hmacSha256,
  parseJson,
  randomBytes,
  type JsonObject,
  type NostrEvent,
  type OwnerKeyStore,
} from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { createLogger, type Logger } from '@4thtech-io/log';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../apps/cli/dist/mcp/server.js';
import { nodeFileOpener, nodeFilesPlatform } from '../../apps/cli/dist/runtime/files.js';
import { packVerifierReaders } from '../../apps/cli/dist/runtime/pack-verifier.js';
import { nodeProofPacks } from '../../apps/cli/dist/runtime/proofs.js';
import { coreToolClient } from '@4thtech-io/mcp-tools/context.js';
// The core's in-memory Notary (test helper source, never built; it imports only the chain and
// crypto packages, plus types).
import { FakeNotary, FEE_UNITS } from '../../packages/core/src/testing/chain.js';
import * as chainKit from '../../packages/chain/dist/index.js';

export { FakeNotary, FEE_UNITS };

// ---- doubles ------------------------------------------------------------------------------------

const PREFIX = 'test-sealed:';

/** A store cipher double: reversible, context-bound (the real one is the keychain-keyed AEAD). */
export class TestCipher implements StoreCipher {
  seal(context: { table: string; column: string; rowKey: string }, plaintext: string) {
    const body = JSON.stringify([context.table, context.column, context.rowKey, plaintext]);
    return Promise.resolve(`${PREFIX}${encodeBase64url(encodeUtf8(body))}` as Sealed);
  }
  open(context: { table: string; column: string; rowKey: string }, sealed: Sealed) {
    const parsed = JSON.parse(
      decodeUtf8(decodeBase64url(sealed.slice(PREFIX.length))),
    ) as unknown[];
    if (parsed[0] !== context.table || parsed[1] !== context.column || parsed[2] !== context.rowKey)
      return Promise.reject(new Error('test cipher: wrong context'));
    return Promise.resolve(parsed[3] as string);
  }
  indexDigest(data: Uint8Array) {
    return Promise.resolve(encodeHex(hmacSha256(new Uint8Array(32).fill(0x1d), data)));
  }
}

interface Filter {
  kinds?: number[];
  '#p'?: string[];
  since?: number;
  until?: number;
  limit?: number;
}

function matches(filter: Filter, event: NostrEvent): boolean {
  if (filter.kinds !== undefined && !filter.kinds.includes(event.kind)) return false;
  const wanted = filter['#p'];
  if (wanted !== undefined && !event.tags.some((t) => t[0] === 'p' && wanted.includes(t[1] ?? '')))
    return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  return filter.until === undefined || event.created_at <= filter.until;
}

interface RelaySocketHandlers {
  onOpen(): void;
  onMessage(text: string): void;
}

/** A NIP-01 relay network double (EVENT/OK, REQ/EVENT/EOSE) and the relay spy. */
export class RelayNetwork {
  readonly stored = new Map<string, NostrEvent[]>();
  /** Every EVENT any agent published: the spy for "nothing was sent". */
  published = 0;

  open(target: { url: string }, handlers: RelaySocketHandlers) {
    let closed = false;
    const push = (frame: unknown): void => {
      void Promise.resolve().then(() => {
        if (!closed) handlers.onMessage(JSON.stringify(frame));
      });
    };
    void Promise.resolve().then(() => handlers.onOpen());
    return {
      send: (text: string) => {
        const frame = JSON.parse(text) as unknown[];
        if (frame[0] === 'EVENT') {
          this.published += 1;
          const event = frame[1] as NostrEvent;
          const list = this.stored.get(target.url) ?? [];
          if (!list.some((e) => e.id === event.id)) list.push(event);
          this.stored.set(target.url, list);
          push(['OK', event.id, true, '']);
        } else if (frame[0] === 'REQ') {
          const subId = frame[1] as string;
          const filter = frame[2] as Filter;
          const events = (this.stored.get(target.url) ?? []).filter((e) => matches(filter, e));
          for (const e of events.slice(0, filter.limit ?? events.length)) push(['EVENT', subId, e]);
          push(['EOSE', subId]);
        }
      },
      close: () => {
        closed = true;
      },
    };
  }
}

/** Every log line of the run: the suites check none carries inbound text (I-5, I-7). */
export const logLines: string[] = [];
const logger: Logger = createLogger({
  name: 'prompt-injection',
  level: 'debug',
  sink: (_level, line) => logLines.push(line),
});

/** The owner approval channel of `agentlink mcp` in M1a: a request stays pending. */
const approvals: ApprovalChannel = {
  request: (r) => Promise.resolve({ approvalId: r.approvalId }),
  status: () => Promise.resolve({ state: 'pending' }),
};

export const presence = () => ({ kind: 'passphrase' as const, secret: encodeUtf8('pi-owner') });

// ---- agents ---------------------------------------------------------------------------------------

export interface McpResult {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly text: string;
  readonly structured: Record<string, unknown>;
  readonly isError: boolean;
}

export interface PiAgent {
  readonly label: string;
  readonly client: AgentLinkClient;
  readonly store: MemoryStore;
  readonly cipher: TestCipher;
  readonly owner: OwnerKeyStore;
  readonly home: string;
  readonly mcp: Client;
  /** How many times the allowed-folder opener actually opened a file for this agent. */
  readonly opens: { count: number };
  /** Pack paths that passed the lexical check and reached the realpath and no-follow open. */
  readonly packOpens: { count: number; paths: string[] };
  /** Every tool result this agent's MCP client got, in order. */
  readonly results: McpResult[];
  call(tool: string, args?: Record<string, unknown>): Promise<McpResult>;
  policyVersion: number;
}

export interface World {
  readonly net: RelayNetwork;
  readonly chain: FakeNotary;
  readonly root: string;
  readonly clock: () => number;
}

export async function newWorld(): Promise<World> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agentlink-pi-')));
  // A real clock: the inbox folder, receipts and drop expiry all read dates.
  const clock = () => Math.floor(Date.now() / 1000);
  return { net: new RelayNetwork(), chain: new FakeNotary(clock), root, clock };
}

const seed = (n: number): Uint8Array => new Uint8Array(32).fill(n);

/** The proof tools' platform half, over the in-memory Notary (06 §2.4; D-87 pack reader). */
function proofTools(world: World, home: string, packOpens: { count: number; paths: string[] }) {
  const config = world.chain.config;
  const readers = packVerifierReaders({
    configs: [config],
    reuse: [{ config, client: world.chain.client }],
    fetchFn: () => Promise.reject(new Error('no network in this suite')),
  });
  const packs = nodeProofPacks({
    home,
    onOpen: (requested: string) => {
      packOpens.count += 1;
      packOpens.paths.push(requested);
    },
  });
  return Object.freeze({
    ...packs,
    // The same mapping as the CLI's nodeProofs `verify` (src/runtime/proofs.ts).
    async verify(pack: Uint8Array | Readonly<Record<string, unknown>>) {
      const result = await chainKit.verifyProofPack(pack, { chains: readers });
      if (!result.valid) return { valid: false, verdict: 'failed', reason: result.reason };
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
        receipts: result.receipts.map((r: { type: string; at: string }) => ({
          type: r.type,
          at: r.at,
        })),
        contentVerified: result.contentVerified,
        content,
        notices: result.notices.map((n: { code: string }) => n.code),
      };
    },
    account: () => Promise.resolve(undefined),
    chainIdOf: (key: string) => (key === config.key ? config.chainId : undefined),
  });
}

export async function makeAgent(
  world: World,
  options: { n: number; label: string; name: string; relays: readonly string[] },
): Promise<PiAgent> {
  const home = path.join(world.root, options.label);
  await mkdir(home, { recursive: true });
  const store = new MemoryStore();
  const cipher = new TestCipher();
  const owner = new MemoryOwnerKeyStore(seed(100 + options.n), presence());
  let mark = 0;
  const client = await AgentLinkClient.create({
    keyStore: new MemoryKeyStore(seed(options.n)),
    store,
    cipher,
    approvals,
    clock: world.clock,
    transport: nostrTransport({ connector: world.net as never, addressCheck: 'platform' }),
    policyMark: {
      read: () => Promise.resolve(mark),
      raise: (v: number) => {
        mark = Math.max(mark, v);
        return Promise.resolve(mark);
      },
    },
    logger,
    files: nodeFilesPlatform({ home, drop: false }),
    proofs: world.chain.platform() as never,
  });
  const session = await owner.unlock(presence());
  await client.identity.init({
    owner: session,
    ownerKeys: await owner.getPublicKeys(),
    name: options.name,
    relays: options.relays,
  });
  await session.close();

  const opens = { count: 0 };
  const packOpens = { count: 0, paths: [] as string[] };
  const context = {
    client: coreToolClient(client, {
      files: nodeFileOpener({
        home,
        onOpen: () => {
          opens.count += 1;
        },
      }),
      proofs: proofTools(world, home, packOpens) as never,
    }),
    clock: world.clock,
    logger,
    agentName: options.label,
    approvalNextStep: (id: string) => `Run agentlink approve ${id} in your own terminal.`,
    urlOrigins: [],
  };
  const server = createMcpServer(context as never, '0.0.0-pi');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'agentlink-pi', version: '0' });
  await Promise.all([server.connect(serverSide), mcp.connect(clientSide)]);
  await mcp.listTools(); // the SDK client validates outputs against the cached schemas

  const results: McpResult[] = [];
  const agent: PiAgent = {
    label: options.label,
    client,
    store,
    cipher,
    owner,
    home,
    mcp,
    opens,
    packOpens,
    results,
    policyVersion: 0,
    async call(tool, args = {}) {
      const r = await mcp.callTool({ name: tool, arguments: args });
      const content = r.content as { type: string; text?: string }[];
      const out: McpResult = {
        tool,
        args,
        text: content.map((c) => c.text ?? '').join('\n'),
        structured: (r.structuredContent ?? {}) as Record<string, unknown>,
        isError: r.isError === true,
      };
      results.push(out);
      return out;
    },
  };
  return agent;
}

async function signOwner(agent: PiAgent, op: string, params: JsonObject): Promise<string> {
  const keys = await agent.owner.getPublicKeys();
  const issuedAt = Math.floor(Date.now() / 1000);
  const body: JsonObject = {
    v: 1,
    agent: agent.client.agentId,
    owner: encodeHex(keys.ownerNostr),
    op,
    params,
    nonce: encodeBase64url(randomBytes(16)),
    issuedAt,
    expiresAt: issuedAt + 600,
  };
  const session = await agent.owner.unlock(presence());
  try {
    return JSON.stringify({ body, sig: await session.signOwnerAction(body) });
  } finally {
    await session.close();
  }
}

/** The part of the 06 §3 policy the suites change. */
export interface PolicyEdit {
  contacts: Record<string, unknown>;
  files: Record<string, unknown>;
  [section: string]: unknown;
}

/** The owner edits the effective policy and signs a `policy.set` (04 §2.5), like `agentlink owner`. */
export async function editPolicy(
  agent: PiAgent,
  edit: (policy: PolicyEdit) => void,
): Promise<void> {
  const loaded = await agent.client.ownerActions.loadPolicy();
  if (loaded.mode === 'fail_closed') throw new Error('policy is fail-closed');
  const policy = structuredClone(loaded.policy) as unknown as PolicyEdit;
  edit(policy);
  agent.policyVersion += 1;
  const applied = await agent.client.ownerActions.apply(
    await signOwner(agent, 'policy.set', {
      version: agent.policyVersion,
      policy: policy as JsonObject,
    }),
  );
  if (applied.status !== 'applied') throw new Error('policy not applied');
}

/** The owner approves one stored request (`agentlink approve <id>`, minus the TTY prompt). */
export async function ownerApprove(agent: PiAgent, approvalId: string): Promise<void> {
  const row = await agent.store.transaction((tx) =>
    tx.get('approvals', { approval_id: approvalId }),
  );
  if (row === undefined) throw new Error('no such approval');
  const text = await agent.cipher.open(
    { table: 'approvals', column: 'action_json', rowKey: JSON.stringify([approvalId]) },
    row.action_json as Sealed,
  );
  const applied = await agent.client.ownerActions.apply(
    await signOwner(agent, 'approval.decide', {
      approvalId,
      actionDigest: computeActionDigest(parseJson(text) as JsonObject),
      decision: 'approve',
    }),
  );
  if (applied.status !== 'applied') throw new Error('approval not applied');
}

/** Pairs two agents the way invite, accept and the background loop do (04 §3.6). */
export async function pair(inviter: PiAgent, invitee: PiAgent): Promise<void> {
  const invite = await inviter.client.pairing.createInvite();
  const started = await invitee.client.pairing.acceptInvite({
    link: invite.inviteUrl,
    allowed: true,
  });
  if (started.status !== 'pending') throw new Error('pairing not started');
  await invitee.client.outbox.processDue();
  await inviter.client.syncInbox();
  await inviter.client.outbox.processDue();
  await invitee.client.syncInbox();
}

/** Delivers what `from` has queued and lets `to` process it (the background loop's two halves). */
export async function deliver(from: PiAgent, to: PiAgent): Promise<void> {
  await from.client.outbox.processDue();
  await to.client.syncInbox();
  await to.client.outbox.processDue();
  await from.client.syncInbox();
}

// ---- side-effect snapshot --------------------------------------------------------------------------

const TABLES = [
  'contacts',
  'pairings',
  'invites',
  'outbox',
  'receipts',
  'proofs',
  'approvals',
  'commitment_parts',
  'budget_ledger',
] as const;

export interface Effects {
  readonly published: number;
  readonly outbound: number;
  readonly rows: Readonly<Record<string, number>>;
  readonly notarizeCalls: number;
  readonly acknowledgeCalls: number;
  readonly receiptSignatures: number;
  readonly opens: number;
  readonly packOpens: number;
  readonly inboxFolder: readonly string[];
  readonly proofsFolder: readonly string[];
}

async function listing(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

/**
 * Everything an action by our code would change: relay publishes, outbound envelopes, contact,
 * pairing, approval, receipt, proof and budget rows, chain calls, file opens and the inbox and proof
 * folders. Equal snapshots before and after a phase mean our code issued no action in it.
 */
export async function effects(world: World, agent: PiAgent): Promise<Effects> {
  const rows: Record<string, number> = {};
  for (const table of TABLES) {
    rows[table] = (
      await agent.store.transaction((tx) => tx.select(table as never, {} as never))
    ).length;
  }
  const outbound = (
    await agent.store.transaction((tx) => tx.select('envelopes', { direction: 'out' } as never))
  ).length;
  return {
    published: world.net.published,
    outbound,
    rows,
    notarizeCalls: world.chain.calls.notarize,
    acknowledgeCalls: world.chain.calls.acknowledge,
    receiptSignatures: world.chain.receiptSignatures.length,
    opens: agent.opens.count,
    packOpens: agent.packOpens.count,
    inboxFolder: await listing(path.join(agent.home, 'AgentLink', 'Inbox')),
    proofsFolder: await listing(path.join(agent.home, 'AgentLink', 'Proofs')),
  };
}

/** The tool surface as the model sees it: descriptions, schemas and the server instructions. */
export async function surface(agent: PiAgent): Promise<string> {
  const tools = await agent.mcp.listTools();
  return JSON.stringify({ tools: tools.tools, instructions: agent.mcp.getInstructions() ?? null });
}
