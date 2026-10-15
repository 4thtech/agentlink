// M1-9c-b: `agentlink_get_approval` and the `pendingApprovals` count of `agentlink_status`, against
// a real core (06 §2.1, §2.5; 04 §2.5.1; I-4). One agent with its own owner. The owner's decision is
// a real owner-signed `approval.decide` applied through `ownerActions`, as `agentlink approve` does
// it. Rows are edited directly only to play a tampered or voided store.
import {
  AgentLinkClient,
  MemoryStore,
  computeActionDigest,
  nostrTransport,
  type ApprovalChannel,
  type Sealed,
  type StoreCipher,
} from '@agentlink/core';
import {
  decodeBase64url,
  decodeUtf8,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  hmacSha256,
  randomBytes,
  type JsonObject,
  type OwnerKeyStore,
} from '@agentlink/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@agentlink/crypto/testing';
import { createLogger } from '@agentlink/log';
import type { RelayConnector, RelaySocket, RelaySocketHandlers } from '@agentlink/transport-nostr';
import { beforeEach, describe, expect, it } from 'vitest';
import { agentToolContext } from '../src/mcp/command.js';
import type { OpenedAgent } from '../src/runtime/open-agent.js';
import { callTool, type FinishedResult } from '../src/tools/index.js';

const PREFIX = 'test-sealed:';
const NOW = 1_800_000_000;
const seed = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const presence = () => ({ kind: 'passphrase' as const, secret: encodeUtf8('correct horse') });

class TestCipher implements StoreCipher {
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

/** A relay that holds nothing: every REQ ends at once. */
const emptyRelays: RelayConnector = {
  open(_target, handlers: RelaySocketHandlers): RelaySocket {
    void Promise.resolve().then(() => handlers.onOpen());
    return {
      send: (text: string) => {
        const frame = JSON.parse(text) as unknown[];
        if (frame[0] === 'REQ') {
          void Promise.resolve().then(() => handlers.onMessage(JSON.stringify(['EOSE', frame[1]])));
        } else if (frame[0] === 'EVENT') {
          const id = (frame[1] as { id: string }).id;
          void Promise.resolve().then(() =>
            handlers.onMessage(JSON.stringify(['OK', id, true, ''])),
          );
        }
      },
      close: () => undefined,
    };
  },
};

const channel: ApprovalChannel = {
  request: (r) => Promise.resolve({ approvalId: r.approvalId }),
  status: () => Promise.resolve({ state: 'pending' }),
};

interface Agent {
  readonly client: AgentLinkClient;
  readonly store: MemoryStore;
  readonly owner: OwnerKeyStore;
  readonly opened: OpenedAgent;
}

async function makeAgent(): Promise<Agent> {
  const store = new MemoryStore();
  const owner = new MemoryOwnerKeyStore(seed(101), presence());
  let mark = 0;
  const client = await AgentLinkClient.create({
    keyStore: new MemoryKeyStore(seed(1)),
    store,
    cipher: new TestCipher(),
    approvals: channel,
    clock: () => NOW,
    transport: nostrTransport({ connector: emptyRelays, addressCheck: 'platform' }),
    policyMark: {
      read: () => Promise.resolve(mark),
      raise: (v: number) => {
        mark = Math.max(mark, v);
        return Promise.resolve(mark);
      },
    },
    logger: createLogger({ name: 'test', sink: () => undefined }),
  });
  const session = await owner.unlock(presence());
  await client.identity.init({
    owner: session,
    ownerKeys: await owner.getPublicKeys(),
    name: 'Alice',
    relays: ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'],
  });
  await session.close();
  const opened = {
    name: 'alice',
    agentId: client.agentId,
    paths: {},
    client,
    approvals: channel,
    close: () => Promise.resolve(),
  } as unknown as OpenedAgent;
  return { client, store, owner, opened };
}

async function ownerSign(a: Agent, op: string, params: JsonObject) {
  const keys = await a.owner.getPublicKeys();
  const body: JsonObject = {
    v: 1,
    agent: a.client.agentId,
    owner: encodeHex(keys.ownerNostr),
    op,
    params,
    nonce: encodeBase64url(randomBytes(16)),
    issuedAt: NOW,
    expiresAt: NOW + 600,
  };
  const session = await a.owner.unlock(presence());
  try {
    return JSON.stringify({ body, sig: await session.signOwnerAction(body) });
  } finally {
    await session.close();
  }
}

const exportAction = (note: string): JsonObject => ({
  tool: 'agentlink_export_proof_pack',
  args: { recordId: '0x01', includeKey: true, note },
  context: {
    triggers: ['proofs.allowKeyDisclosure'],
    recordId: `0x${'ab'.repeat(32)}`,
    envelopeHash: `0x${'cd'.repeat(32)}`,
  },
});

interface Req {
  readonly id: string;
  readonly action: JsonObject;
}

async function request(a: Agent, note: string): Promise<Req> {
  const action = exportAction(note);
  const pending = await a.client.approvalService.request({
    action,
    summary: 'Include the document key in an export',
  });
  return { id: pending.approvalId, action };
}

async function decide(a: Agent, r: Req, how: 'approve' | 'deny'): Promise<void> {
  const outcome = await a.client.ownerActions.apply(
    await ownerSign(a, 'approval.decide', {
      approvalId: r.id,
      actionDigest: computeActionDigest(r.action),
      decision: how,
    }),
  );
  expect(outcome.status).toBe('applied');
}

const silent = createLogger({ name: 'test', sink: () => undefined });
let agent: Agent;
const call = (name: string, args: Record<string, unknown> = {}): Promise<FinishedResult> =>
  callTool(
    name,
    args,
    agentToolContext(agent.opened, silent, () => NOW),
  );
const approvalOf = async (id: string) =>
  (await call('agentlink_get_approval', { approvalId: id })).structured;
const pendingCount = async () => (await call('agentlink_status')).structured['pendingApprovals'];
const setRow = (id: string, patch: Record<string, unknown>) =>
  agent.store.transaction((tx) => tx.update('approvals', { approval_id: id }, patch as never));
const rowOf = (id: string) =>
  agent.store.transaction((tx) => tx.get('approvals', { approval_id: id }));

beforeEach(async () => {
  agent = await makeAgent();
});

describe('agentlink_get_approval against a real core (06 §2.5)', () => {
  it('maps pending, approved and denied rows, with decidedAt once decided', async () => {
    const p = await request(agent, 'p');
    const a = await request(agent, 'a');
    const d = await request(agent, 'd');
    await decide(agent, a, 'approve');
    await decide(agent, d, 'deny');
    expect(await approvalOf(p.id)).toMatchObject({ status: 'ok', approval: 'pending' });
    expect(await approvalOf(p.id)).not.toHaveProperty('decidedAt');
    expect(await approvalOf(a.id)).toMatchObject({ status: 'ok', approval: 'approved' });
    expect(await approvalOf(a.id)).toHaveProperty('decidedAt');
    expect(await approvalOf(d.id)).toMatchObject({ status: 'ok', approval: 'denied' });
  });

  it('maps an owner cancel to denied', async () => {
    const c = await request(agent, 'c');
    await decide(agent, c, 'approve');
    const cancelled = await agent.client.ownerActions.apply(
      await ownerSign(agent, 'approval.cancel', { approvalId: c.id }),
    );
    expect(cancelled.status).toBe('applied');
    expect(await approvalOf(c.id)).toMatchObject({ approval: 'denied' });
  });

  it('an unknown ID is not_found', async () => {
    const result = await call('agentlink_get_approval', { approvalId: `apr_${'A'.repeat(22)}` });
    expect(result.structured.status).toBe('not_found');
  });

  it('a lapsed request reads expired', async () => {
    const e = await request(agent, 'e');
    await setRow(e.id, { expires_at: NOW - 1 });
    expect(await approvalOf(e.id)).toMatchObject({ status: 'ok', approval: 'expired' });
    expect(await approvalOf(e.id)).not.toHaveProperty('used');
  });

  it('a used approval reads expired with used: true; a voided request reads expired without it', async () => {
    const used = await request(agent, 'u');
    await decide(agent, used, 'approve');
    await setRow(used.id, { status: 'void' });
    expect(await approvalOf(used.id)).toMatchObject({ approval: 'expired', used: true });
    const voided = await request(agent, 'v');
    await setRow(voided.id, { status: 'void' });
    const read = await approvalOf(voided.id);
    expect(read).toMatchObject({ approval: 'expired' });
    expect(read).not.toHaveProperty('used');
  });

  it('a tampered row reads denied and is never approved (fail closed)', async () => {
    const a = await request(agent, 'a');
    const b = await request(agent, 'b');
    const c = await request(agent, 'c');
    await decide(agent, a, 'approve');
    await decide(agent, c, 'approve');
    const rowA = (await rowOf(a.id))!;
    // A decision copied from another request, with the status edited to approved.
    await setRow(b.id, { status: 'approved', signed_decision: rowA.signed_decision });
    // A sealed action moved from another row.
    await setRow(c.id, { action_json: rowA.action_json });
    for (const id of [b.id, c.id]) {
      const read = await approvalOf(id);
      expect(read['approval']).toBe('denied');
    }
    // Garbage in the stored decision.
    const d = await request(agent, 'd');
    await decide(agent, d, 'approve');
    await setRow(d.id, { signed_decision: '{"body":{},"sig":"00"}' });
    expect((await approvalOf(d.id))['approval']).toBe('denied');
  });

  it('never reports signed, and never changes a row (read-only)', async () => {
    const a = await request(agent, 'a');
    await decide(agent, a, 'approve');
    const before = JSON.stringify(await agent.store.transaction((tx) => tx.select('approvals')));
    const read = await approvalOf(a.id);
    await call('agentlink_status');
    expect(JSON.stringify(read)).not.toContain('signed');
    expect(JSON.stringify(await agent.store.transaction((tx) => tx.select('approvals')))).toBe(
      before,
    );
  });
});

describe('agentlink_status pendingApprovals against a real core (06 §2.1)', () => {
  it('counts only undecided, uncancelled, unlapsed requests; void and used rows do not count', async () => {
    expect(await pendingCount()).toBe(0);
    const p1 = await request(agent, 'p1');
    await request(agent, 'p2');
    expect(await pendingCount()).toBe(2);
    await decide(agent, p1, 'approve');
    expect(await pendingCount()).toBe(1);
    const used = await request(agent, 'used');
    await decide(agent, used, 'approve');
    await setRow(used.id, { status: 'void' });
    const voided = await request(agent, 'void');
    await setRow(voided.id, { status: 'void' });
    const lapsed = await request(agent, 'lapsed');
    await setRow(lapsed.id, { expires_at: NOW - 1 });
    expect(await pendingCount()).toBe(1);
  });
});
