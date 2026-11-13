// RET-6 (S2; D-148; 04 §4.2 "Retention policy"; 06 §3 `history`; 08 §1; I-4): Settings › Storage's
// "Keep automatically" editor.
// - `GET /api/ui/storage/retention` (read): the values in force (a policy signed before D-148 reads
//   as keep forever) and, for `?messages=&files=`, what those values would remove now (counts and
//   sizes; nothing is deleted).
// - `POST /api/ui/storage/retention` (presence): `{base, messagesKeepDays, filesKeepDays}` only. The
//   server builds the owner-signed `policy.set` that changes `history` and nothing else, the owner's
//   gesture signs it and core applies it. A value outside the 06 §3 list, any other key, a stale base
//   or an edit that would also change another rule is refused before anything is signed.
import {
  AgentLinkClient,
  MemoryStore,
  type ApprovalChannel,
  type Sealed,
  type SealContext,
  type StoreCipher,
} from '@4thtech-io/core';
import {
  decodeBase64url,
  decodeUtf8,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  hmacSha256,
  type JsonObject,
  type JsonValue,
  type OwnerPresence,
} from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { describe, expect, it } from 'vitest';
import { checkGesture, type OwnerReview, type OwnerSignRequest } from '../../owner-operation.js';
import { readOnlyClient, type LocalUiContext } from '../context.js';
import { createLocalUiRoutes } from '../routes.js';
import type { LocalUiOwnerOperation, LocalUiResult } from '../route-types.js';
import { RETENTION_PATH, retentionRoutes } from './retention.js';

const PREFIX = 'retention-test-sealed:';
class TestCipher implements StoreCipher {
  seal(context: SealContext, plaintext: string): Promise<Sealed> {
    const body = JSON.stringify([context.table, context.column, context.rowKey, plaintext]);
    return Promise.resolve(`${PREFIX}${encodeBase64url(encodeUtf8(body))}` as Sealed);
  }
  open(context: SealContext, sealed: Sealed): Promise<string> {
    const parsed = JSON.parse(
      decodeUtf8(decodeBase64url(sealed.slice(PREFIX.length))),
    ) as unknown[];
    if (parsed[0] !== context.table || parsed[1] !== context.column) {
      return Promise.reject(new Error('test cipher: wrong context'));
    }
    return Promise.resolve(parsed[3] as string);
  }
  indexDigest(data: Uint8Array): Promise<string> {
    return Promise.resolve(encodeHex(hmacSha256(new Uint8Array(32).fill(0x2e), data)));
  }
}

const approvals: ApprovalChannel = {
  request: (request) => Promise.resolve({ approvalId: request.approvalId }),
  status: () => Promise.resolve({ state: 'pending' }),
};
const seed = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const passphrase = (): OwnerPresence => ({ kind: 'passphrase', secret: encodeUtf8('ret6 owner') });

interface Setup {
  readonly client: AgentLinkClient;
  readonly context: LocalUiContext;
  readonly owner: MemoryOwnerKeyStore;
  readonly apply: (patch: JsonObject, drop?: boolean) => Promise<void>;
}

async function setup(): Promise<Setup> {
  const owner = new MemoryOwnerKeyStore(seed(61), passphrase());
  const clock = { t: 1_800_000_000 };
  let mark = 0;
  const client = await AgentLinkClient.create({
    keyStore: new MemoryKeyStore(seed(6)),
    store: new MemoryStore(),
    cipher: new TestCipher(),
    approvals,
    clock: () => clock.t,
    policyMark: {
      read: () => Promise.resolve(mark),
      raise: (v: number) => Promise.resolve((mark = Math.max(mark, v))),
    },
  });
  const session = await owner.unlock(passphrase());
  await client.identity.init({
    owner: session,
    ownerKeys: await owner.getPublicKeys(),
    name: 'Agent',
    relays: ['wss://relay.agentlink.dev', 'wss://nos.lol'],
  });
  await session.close();
  const context: LocalUiContext = Object.freeze<LocalUiContext>({
    client: readOnlyClient(client),
    ownerContext: () => Promise.resolve(undefined),
    applyOwnerAction: (signed) => client.ownerActions.apply(JSON.stringify(signed)),
    now: () => clock.t * 1000,
  });
  /** Signs a policy edit as another surface would; `drop` removes `history` (pre-D-148). */
  const apply = async (patch: JsonObject, drop = false): Promise<void> => {
    const prepared = await client.ownerActions.preparePolicyEdit(patch);
    if (prepared.status !== 'prepared') throw new Error(prepared.reason);
    const body = JSON.parse(JSON.stringify(prepared.body)) as {
      params: { policy: Record<string, unknown> };
    } & JsonObject;
    if (drop) delete body.params.policy['history'];
    const s = await owner.unlock(passphrase());
    try {
      const out = await client.ownerActions.apply(
        JSON.stringify({ body, sig: await s.signOwnerAction(body) }),
      );
      if (out.status !== 'applied') throw new Error(out.reason);
    } finally {
      await s.close();
    }
  };
  return { client, context, owner, apply };
}

function ownerOp(owner: MemoryOwnerKeyStore) {
  const calls: { review: OwnerReview; requests: readonly OwnerSignRequest[] }[] = [];
  const op: LocalUiOwnerOperation = {
    sign: async (review, requests) => {
      calls.push({ review, requests });
      const frozen = checkGesture(review, requests);
      const first = frozen[0];
      if (first?.kind !== 'owner-action') throw new Error('unexpected request');
      const session = await owner.unlock(passphrase());
      try {
        const sig = await session.signOwnerAction(first.action);
        return [{ kind: 'owner-action', signed: { body: first.action, sig } }];
      } finally {
        await session.close();
      }
    },
  };
  return { op, calls };
}

const getRoute = () => {
  const r = retentionRoutes.find((x) => x.method === 'GET' && x.path === RETENTION_PATH);
  if (r === undefined || r.presence !== false) throw new Error('no read route');
  return r;
};
const postRoute = () => {
  const r = retentionRoutes.find((x) => x.method === 'POST' && x.path === RETENTION_PATH);
  if (r === undefined || r.presence !== true) throw new Error('no owner route');
  return r;
};

const read = (context: LocalUiContext, query = ''): Promise<LocalUiResult> =>
  getRoute().handler(context, { params: {}, query: new URLSearchParams(query) });

const save = (context: LocalUiContext, owner: LocalUiOwnerOperation, input: JsonValue) =>
  postRoute().handler(context, { params: {}, query: new URLSearchParams(), input }, owner);

const policyOf = async (client: AgentLinkClient) => {
  const effective = await client.ownerActions.loadPolicy();
  if (effective.mode !== 'signed') throw new Error('not signed');
  return effective;
};

describe('routes (RET-6; I-4)', () => {
  it('one read without presence and one save behind the presence gate, registered', () => {
    expect(RETENTION_PATH).toBe('/api/ui/storage/retention');
    const shape = retentionRoutes.map((r) => `${r.method} ${r.path} ${String(r.presence)}`).sort();
    expect(shape).toEqual([
      'GET /api/ui/storage/retention false',
      'POST /api/ui/storage/retention true',
    ]);
    const registered = createLocalUiRoutes()
      .routes()
      .filter((r) => r.path === RETENTION_PATH)
      .map((r) => `${r.method} ${String(r.presence)}`)
      .sort();
    expect(registered).toEqual(['GET false', 'POST true']);
  });
});

describe('GET: the values in force and a preview', () => {
  it('answers the signed values and the version', async () => {
    const { context, apply } = await setup();
    await apply({ history: { messagesKeepDays: 365, filesKeepDays: 30 } });
    const r = await read(context);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      status: 'ok',
      version: 1,
      keep: { messagesKeepDays: 365, filesKeepDays: 30 },
    });
  });

  it('a policy signed before D-148 reads as keep forever', async () => {
    const { context, apply } = await setup();
    await apply({ receipts: { autoOpened: false } }, true);
    const r = await read(context);
    expect(r.body).toMatchObject({ status: 'ok', keep: { messagesKeepDays: 0, filesKeepDays: 0 } });
  });

  it('with messages= and files=: what they would remove now (counts and sizes only)', async () => {
    const { context, apply } = await setup();
    await apply({ history: { messagesKeepDays: 0, filesKeepDays: 0 } });
    const r = await read(context, 'messages=90&files=30');
    expect(r.status).toBe(200);
    const preview = (r.body as { preview?: unknown }).preview;
    expect(preview).toEqual({ messages: { count: 0, bytes: 0 }, files: { count: 0, bytes: 0 } });
  });

  it('a value outside the 06 §3 list, a lone key or another key is invalid_query', async () => {
    const { context, apply } = await setup();
    await apply({});
    for (const q of ['messages=30&files=30', 'messages=90', 'files=x&messages=0', 'x=1']) {
      expect((await read(context, q)).status, q).toBe(400);
    }
  });
});

describe('POST: the owner-signed history change (presence)', () => {
  it('signs and applies a policy.set that changes history and nothing else', async () => {
    const { client, context, owner, apply } = await setup();
    await apply({ receipts: { autoOpened: true } });
    const before = await policyOf(client);
    const { op, calls } = ownerOp(owner);
    const r = await save(context, op, { base: 1, messagesKeepDays: 730, filesKeepDays: 180 });
    expect(r).toMatchObject({ status: 200, body: { status: 'done', version: 2 } });
    expect(calls).toHaveLength(1);
    const after = await policyOf(client);
    expect(after.version).toBe(2);
    expect(after.policy.history).toEqual({ messagesKeepDays: 730, filesKeepDays: 180 });
    const { history: _a, ...restBefore } = before.policy as Record<string, unknown>;
    const { history: _b, ...restAfter } = after.policy as Record<string, unknown>;
    expect(restAfter).toEqual(restBefore);
  });

  it('on a policy signed before D-148: sets history, the rest unchanged', async () => {
    const { client, context, owner, apply } = await setup();
    await apply({}, true);
    expect((await policyOf(client)).policy.history).toBeUndefined();
    const { op } = ownerOp(owner);
    const r = await save(context, op, { base: 1, messagesKeepDays: 0, filesKeepDays: 90 });
    expect(r.body).toMatchObject({ status: 'done' });
    expect((await policyOf(client)).policy.history).toEqual({
      messagesKeepDays: 0,
      filesKeepDays: 90,
    });
  });

  it('refuses before signing: a value off the list, a missing or extra key, a stale base', async () => {
    const { client, context, owner, apply } = await setup();
    await apply({});
    const { op, calls } = ownerOp(owner);
    const bad: JsonValue[] = [
      { base: 1, messagesKeepDays: 30, filesKeepDays: 90 },
      { base: 1, messagesKeepDays: 0, filesKeepDays: 1 },
      { base: 1, messagesKeepDays: '0', filesKeepDays: 90 },
      { base: 1, filesKeepDays: 90 },
      { base: 1, messagesKeepDays: 0, filesKeepDays: 90, receipts: { autoOpened: true } },
      { base: 1, messagesKeepDays: 0, filesKeepDays: 90, history: {} },
      { messagesKeepDays: 0, filesKeepDays: 90 },
      { base: 0, messagesKeepDays: 0, filesKeepDays: 90 },
      null,
      [],
    ];
    for (const input of bad) {
      const r = await save(context, op, input);
      expect(r.status, JSON.stringify(input)).not.toBe(200);
    }
    expect(calls).toHaveLength(0);
    expect((await policyOf(client)).version).toBe(1);
  });
});
