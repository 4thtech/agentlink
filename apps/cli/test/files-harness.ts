// Test harness for the file tools end to end (M1-9d-1): two real cores over an in-memory relay
// network, each served by the real MCP server over the SDK's in-memory transport. Runtime-agnostic
// (no Node built-in), so the Node test (files-mcp.test.ts) and the workerd test with the real drop
// Worker (files-drop.worker.test.ts) share it. Key stores come from the tests (the crypto test seam
// is importable from *.test.ts files only, tools/deps-check/policy.mjs).
import {
  AgentLinkClient,
  MemoryStore,
  nostrTransport,
  type ApprovalChannel,
  type FilesPlatform,
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
  randomBytes,
  type JsonObject,
  type KeyStore,
  type NostrEvent,
  type OwnerKeyStore,
} from '@4thtech-io/crypto';
import { createLogger, type Logger } from '@4thtech-io/log';
import type {
  RelayConnector,
  RelaySocket,
  RelaySocketHandlers,
  RelayTarget,
} from '@4thtech-io/transport-nostr';
import { defaultPolicy, type Policy } from '@4thtech-io/types';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import type { ToolContext } from '../src/tools/index.js';

const PREFIX = 'test-sealed:';

export class TestCipher implements StoreCipher {
  seal(
    context: { table: string; column: string; rowKey: string },
    plaintext: string,
  ): Promise<Sealed> {
    const body = JSON.stringify([context.table, context.column, context.rowKey, plaintext]);
    return Promise.resolve(`${PREFIX}${encodeBase64url(encodeUtf8(body))}` as Sealed);
  }
  open(
    context: { table: string; column: string; rowKey: string },
    sealed: Sealed,
  ): Promise<string> {
    const parsed = JSON.parse(
      decodeUtf8(decodeBase64url(sealed.slice(PREFIX.length))),
    ) as unknown[];
    if (
      parsed[0] !== context.table ||
      parsed[1] !== context.column ||
      parsed[2] !== context.rowKey
    ) {
      return Promise.reject(new Error('test cipher: wrong context'));
    }
    return Promise.resolve(parsed[3] as string);
  }
  indexDigest(data: Uint8Array): Promise<string> {
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
  if (
    wanted !== undefined &&
    !event.tags.some((t) => t[0] === 'p' && wanted.includes(t[1] ?? ''))
  ) {
    return false;
  }
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  return filter.until === undefined || event.created_at <= filter.until;
}

/** A relay network double (NIP-01 EVENT/OK, REQ/EVENT/EOSE), and the relay spy. */
export class RelayNetwork implements RelayConnector {
  readonly stored = new Map<string, NostrEvent[]>();
  published = 0;

  open(target: RelayTarget, handlers: RelaySocketHandlers): RelaySocket {
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

export const presence = () => ({
  kind: 'passphrase' as const,
  secret: encodeUtf8('correct horse'),
});

/** Every log line, for the canary scan. */
export const logLines: string[] = [];
export const testLogger: Logger = createLogger({
  name: 'test',
  level: 'debug',
  sink: (_level, line) => logLines.push(line),
});

const approvals: ApprovalChannel = {
  request: (r) => Promise.resolve({ approvalId: r.approvalId }),
  status: () => Promise.resolve({ state: 'pending' }),
};

export interface Agent {
  readonly client: AgentLinkClient;
  readonly store: MemoryStore;
  readonly owner: OwnerKeyStore;
  readonly keyStore: KeyStore;
  readonly clock: () => number;
}

export interface AgentOptions {
  readonly keyStore: KeyStore;
  readonly owner: OwnerKeyStore;
  readonly declaredName: string;
  readonly relays: readonly string[];
  readonly net: RelayNetwork;
  readonly clock: () => number;
  readonly files?: FilesPlatform;
  readonly dropOrigins?: readonly string[];
}

export async function makeAgent(options: AgentOptions): Promise<Agent> {
  const store = new MemoryStore();
  let mark = 0;
  const client = await AgentLinkClient.create({
    keyStore: options.keyStore,
    store,
    cipher: new TestCipher(),
    approvals,
    clock: options.clock,
    transport: nostrTransport({ connector: options.net, addressCheck: 'platform' }),
    policyMark: {
      read: () => Promise.resolve(mark),
      raise: (v: number) => {
        mark = Math.max(mark, v);
        return Promise.resolve(mark);
      },
    },
    logger: testLogger,
    ...(options.files === undefined ? {} : { files: options.files }),
    ...(options.dropOrigins === undefined ? {} : { dropOrigins: options.dropOrigins }),
  });
  const session = await options.owner.unlock(presence());
  await client.identity.init({
    owner: session,
    ownerKeys: await options.owner.getPublicKeys(),
    name: options.declaredName,
    relays: options.relays,
  });
  await session.close();
  return {
    client,
    store,
    owner: options.owner,
    keyStore: options.keyStore,
    clock: options.clock,
  };
}

/** Signs and applies a policy (the owner's `policy.set`, 04 §2.5). */
export async function setPolicy(agent: Agent, edit: (policy: Policy) => void): Promise<void> {
  const policy = defaultPolicy();
  policy.contacts.acceptInvites = 'auto';
  edit(policy);
  const keys = await agent.owner.getPublicKeys();
  const now = agent.clock();
  const body: JsonObject = {
    v: 1,
    agent: agent.client.agentId,
    owner: encodeHex(keys.ownerNostr),
    op: 'policy.set',
    params: { version: 1, policy: policy as unknown as JsonObject },
    nonce: encodeBase64url(randomBytes(16)),
    issuedAt: now,
    expiresAt: now + 600,
  };
  const session = await agent.owner.unlock(presence());
  let signed: string;
  try {
    signed = JSON.stringify({ body, sig: await session.signOwnerAction(body) });
  } finally {
    await session.close();
  }
  const applied = await agent.client.ownerActions.apply(signed);
  if (applied.status !== 'applied') throw new Error('policy not applied');
}

/** Pairs the two agents the way invite, accept and the background loop do (04 §3.6). */
export async function pair(inviter: Agent, invitee: Agent): Promise<void> {
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

/** Every tool result of the test run, for the zero-access canary scan (IR-D48-1 F15f). */
export const results: string[] = [];

export async function connect(context: ToolContext): Promise<Client> {
  const server = createMcpServer(context, '0.0.0-test');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  await client.listTools(); // the client caches the output schemas it validates with
  return client;
}

export interface Call {
  readonly structured: Record<string, unknown>;
  readonly text: string;
}

export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Call> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError === true) throw new Error('tool returned a protocol error');
  const [content] = result.content as { type: string; text: string }[];
  const out = {
    structured: result.structuredContent as Record<string, unknown>,
    text: content?.text ?? '',
  };
  results.push(`${out.text}\n${JSON.stringify(out.structured)}`);
  return out;
}

/** Deterministic bytes with a recognisable marker at the start. */
export function fileBytes(size: number, marker = 'PLAINTEXT-MARKER-9d1'): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) out[i] = (i * 31 + 7) & 0xff;
  const m = new TextEncoder().encode(marker);
  out.set(m.subarray(0, Math.min(m.length, size)));
  return out;
}

/** The handler context for an agent, as `agentlink mcp` builds it, with the given client. */
export function toolContext(client: ToolContext['client'], agentName: string): ToolContext {
  return {
    client,
    clock: () => Math.floor(Date.now() / 1000),
    logger: testLogger,
    agentName,
    approvalNextStep: (id) => `Run agentlink approve ${id} in your own terminal.`,
    urlOrigins: [],
  };
}
