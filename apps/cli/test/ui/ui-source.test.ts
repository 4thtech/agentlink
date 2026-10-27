// M1-11a: the local UI's approval source over the agent's real core (08 §1; 11 §6.2.1; 04 §2.5.2;
// 06 §2.1; I-4, I-5).
//
// The CLI hands @4thtech-io/node's approval server an `ApprovalServerSource` built from the same
// pending reader as `agentlink approve` (pending.ts, render.ts): what the page shows (who, what,
// cost, expiry, the rule in plain words and the AI's arguments) is derived from the parsed stored
// action, the action handed back for signing is that same parsed object, a damaged row is never
// offered, and `apply` is core's `ownerActions.apply`, which verifies the owner signature (I-4).
// Inbound and AI-chosen text reaches the page as data only (the page renders it with textContent).
import {
  AgentLinkClient,
  MemoryStore,
  computeActionDigest,
  rowKeyOf,
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
  randomBytes,
  sha256,
  type JsonObject,
} from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { createLogger } from '@4thtech-io/log';
import { describe, expect, it } from 'vitest';
import { createUiApprovalSource } from '../../src/approval/ui-source.js';
import { copy } from '@4thtech-io/mcp-tools/strings/index.js';
import type { OwnerAgent } from '../../src/commands/owner/deps.js';

const T0 = 1_800_000_000;
const silent = createLogger({ name: 'test', sink: () => undefined });
const presence = () => ({ kind: 'passphrase' as const, secret: encodeUtf8('correct horse') });
const XSS = '<img src=x onerror="window.__xss=1"><script>alert(1)</script>';

/** NOT encryption: binds a value to its table, column and row key so tests see sealing (07 §3.1). */
class TestCipher implements StoreCipher {
  seal(context: SealContext, plaintext: string): Promise<Sealed> {
    const body = JSON.stringify([context.table, context.column, context.rowKey, plaintext]);
    return Promise.resolve(`t:${encodeBase64url(encodeUtf8(body))}` as Sealed);
  }
  open(context: SealContext, sealed: Sealed): Promise<string> {
    return Promise.resolve().then(() => {
      const parsed = JSON.parse(decodeUtf8(decodeBase64url(sealed.slice(2)))) as unknown[];
      if (
        parsed[0] !== context.table ||
        parsed[1] !== context.column ||
        parsed[2] !== context.rowKey
      )
        throw new Error('test cipher: wrong context');
      return parsed[3] as string;
    });
  }
  indexDigest(data: Uint8Array): Promise<string> {
    return Promise.resolve(encodeHex(sha256(data)));
  }
}

const channel: ApprovalChannel = {
  request: (r) => Promise.resolve({ approvalId: r.approvalId }),
  status: () => Promise.resolve({ state: 'unknown' }),
};
const evm = (): string => `0x${encodeHex(randomBytes(20))}`;

/**
 * M1-PAY-CONFIRM-a: a free request (`agentlink_export_proof_pack`, no fee). Requests that carry a
 * fee are never batch items (04 §2.5.3 rule 7), so the list and batch tests use free ones.
 */
function freeAction(note = 'x'): JsonObject {
  return {
    tool: 'agentlink_export_proof_pack',
    args: { recordId: '0x01', includeKey: true, note },
    context: {
      triggers: ['proofs.allowKeyDisclosure'],
      recordId: `0x${encodeHex(randomBytes(32))}`,
      envelopeHash: `0x${encodeHex(randomBytes(32))}`,
    },
  };
}

function sendAction(args: JsonObject, usd = '0.1'): JsonObject {
  return {
    tool: 'agentlink_send',
    args,
    context: {
      triggers: ['proofs.notarize'],
      counterparty: { agentId: evm(), ownerKey: encodeHex(randomBytes(32)) },
      file: null,
      fee: { token: evm(), amount: '100000', usd },
    },
  };
}

async function world() {
  const clock = { t: T0 };
  const store = new MemoryStore();
  const cipher = new TestCipher();
  const owner = new MemoryOwnerKeyStore(new Uint8Array(32).fill(101), presence());
  const client = await AgentLinkClient.create({
    keyStore: new MemoryKeyStore(new Uint8Array(32).fill(1)),
    store,
    cipher,
    approvals: channel,
    clock: () => clock.t,
    logger: silent,
    policyMark: { read: () => Promise.resolve(0), raise: (v: number) => Promise.resolve(v) },
  });
  const session = await owner.unlock(presence());
  await client.identity.init({
    owner: session,
    ownerKeys: await owner.getPublicKeys(),
    name: 'Agent',
    relays: ['wss://relay.agentlink.dev', 'wss://nos.lol'],
  });
  await session.close();
  const agent: OwnerAgent = {
    name: 'default',
    client,
    store,
    cipher,
    close: () => Promise.resolve(),
  };
  const source = createUiApprovalSource(agent, { now: () => clock.t });
  const request = async (
    args: JsonObject = { to: 'Ana', text: 'hello' },
    action: JsonObject = sendAction(args),
  ) => {
    const pending = await client.approvalService.request({ action, summary: 'Send a message' });
    return { approvalId: pending.approvalId, action, actionDigest: pending.actionDigest };
  };
  const sign = async (body: JsonObject) => {
    const s = await owner.unlock(presence());
    try {
      return { body, sig: await s.signOwnerAction(body) };
    } finally {
      await s.close();
    }
  };
  return { clock, store, cipher, client, owner, agent, source, request, sign };
}

describe('the local UI approval source (M1-11a)', () => {
  it('lists live pending requests with who, what, cost, expiry, the rule and the AI arguments', async () => {
    const w = await world();
    const a = await w.request({ to: 'Ana', text: 'hello' });
    w.clock.t += 10;
    const b = await w.request({ to: 'Ben', text: 'second' });
    const list = await w.source.list();
    expect(list.map((v) => v.approvalId)).toEqual([a.approvalId, b.approvalId]);
    const view = list[0];
    if (view === undefined) throw new Error('unreachable');
    expect(view.actionDigest).toBe(a.actionDigest);
    expect(view.commitment).toBe(false);
    expect(view.summary).toContain('Send a message');
    expect(view.details).toMatchObject({
      what: 'Send a message',
      cost: '$0.10',
      rule: 'Your rules ask you to approve every proof.',
    });
    expect(view.details?.who.length).toBeGreaterThan(0);
    expect(view.details?.expires).toMatch(/UTC$/);
    // In the stored action's canonical (JCS) key order.
    expect(view.details?.fromAi).toEqual([
      { name: 'text', value: 'hello' },
      { name: 'to', value: 'Ana' },
    ]);
    // M1-11a-ux: a plain headline; not a contact, so no name in it.
    expect(view.details?.headline).toBe('Send a message');
  });

  it('never hands the page the invite link of an accept-invite request (M1-11a-ux)', async () => {
    const w = await world();
    const invite = 'https://agentlink.4thtech.io/i#c2VjcmV0LWludml0ZS1ib2R5';
    const action: JsonObject = {
      tool: 'agentlink_accept_invite',
      args: { inviteUrl: invite },
      context: {
        triggers: ['contacts.acceptInvites'],
        inviteId: encodeBase64url(randomBytes(16)),
        counterparty: { agentId: evm(), ownerKey: encodeHex(randomBytes(32)) },
      },
    };
    await w.client.approvalService.request({ action, summary: 'Connect with a new contact' });
    const [view] = await w.source.list();
    expect(view?.details?.what).toBe('Connect with a new contact');
    expect(view?.details?.headline).toBe('Connect with a new contact');
    expect(view?.details?.fromAi).toEqual([]);
    expect(JSON.stringify(view)).not.toContain(invite);
  });

  it('says what a proof makes public on a send that adds proof (11 §5.6, D-109)', async () => {
    const w = await world();
    await w.request({ to: 'Ana', text: 'hello', notarize: true });
    const [view] = await w.source.list();
    expect(view?.details?.rule).toContain(copy('common.privacy.proof'));
    expect(view?.details?.rule).toMatch(/If .+ confirms delivery, it also becomes public/);
    expect(view?.details?.rule).toMatchSnapshot();
  });

  it('passes injected HTML in AI-chosen text through as data, never as markup', async () => {
    const w = await world();
    await w.request({ to: XSS, text: XSS, path: `/tmp/${XSS}.pdf` });
    const [view] = await w.source.list();
    expect(view?.details?.fromAi).toEqual([
      { name: 'path', value: `/tmp/${XSS}.pdf` },
      { name: 'text', value: XSS },
      { name: 'to', value: XSS },
    ]);
  });

  it('get() returns the parsed stored action for signing; a decided or expired request is gone', async () => {
    const w = await world();
    const a = await w.request();
    const entry = await w.source.get(a.approvalId);
    expect(entry?.action).toEqual(a.action);
    expect(entry?.storedDigest).toBe(computeActionDigest(a.action));
    expect(entry?.actionDigest).toBe(a.actionDigest);
    w.clock.t += 7 * 24 * 3600;
    expect(await w.source.get(a.approvalId)).toBeUndefined();
    expect(await w.source.list()).toEqual([]);
    expect(await w.source.get('apr_nonsense')).toBeUndefined();
  });

  it('never offers a damaged row (04 §2.5.2 step 2)', async () => {
    const w = await world();
    const approvalId = `apr_${encodeBase64url(randomBytes(16))}`;
    const key = rowKeyOf([approvalId]);
    const action = await w.cipher.seal(
      { table: 'approvals', column: 'action_json', rowKey: key },
      '{"tool":"agentlink_send","args":{}}',
    );
    const summary = await w.cipher.seal(
      { table: 'approvals', column: 'summary', rowKey: key },
      'Send a message',
    );
    await w.store.transaction((tx) =>
      tx.insert('approvals', {
        approval_id: approvalId,
        action_json: action,
        scope_json: null,
        answers_envelope_id: null,
        scope_key: null,
        source: 'owner',
        policy_hash: null,
        signed_decision: null,
        signed_cancel: null,
        summary,
        status: 'pending',
        expires_at: w.clock.t + 3600,
        created_at: w.clock.t,
        decided_at: null,
      }),
    );
    expect(await w.source.list()).toEqual([]);
    expect(await w.source.get(approvalId)).toBeUndefined();
  });

  it('context() names the agent and its owner; apply() is core verifying the owner signature', async () => {
    const w = await world();
    // M1-PAY-CONFIRM-a: free requests; a paid one is never a batch item (04 §2.5.3 rule 7).
    const a = await w.request(undefined, freeAction('a'));
    const b = await w.request(undefined, freeAction('b'));
    const context = await w.source.context();
    expect(context?.agent).toBe(w.client.agentId);
    expect(context?.owner.ownerNostr).toEqual((await w.owner.getPublicKeys()).ownerNostr);
    const items = [a, b]
      .map((r) => ({ approvalId: r.approvalId, actionDigest: r.actionDigest, decision: 'approve' }))
      .sort((x, y) => (x.approvalId < y.approvalId ? -1 : 1));
    const body: JsonObject = {
      v: 1,
      agent: w.client.agentId,
      owner: encodeHex((await w.owner.getPublicKeys()).ownerNostr),
      op: 'approval.decideBatch',
      params: { items },
      nonce: encodeBase64url(randomBytes(16)),
      issuedAt: w.clock.t,
      expiresAt: w.clock.t + 600,
    };
    // A forged signature is refused by core.
    const forged = await w.source.apply({ body, sig: '00'.repeat(64) });
    expect(forged.status).toBe('refused');
    const fresh = { ...body, nonce: encodeBase64url(randomBytes(16)) };
    const outcome = await w.source.apply(await w.sign(fresh));
    expect(outcome).toMatchObject({ status: 'applied', op: 'approval.decideBatch' });
    expect(await w.source.list()).toEqual([]);
  });
});
