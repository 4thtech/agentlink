// UX1112 WP-12 (S2; F-2; 02 F-14; D-72; 04 §2.5.1 `contact.block`, `contact.unblock`; proposed, owner
// confirms at merge): the owner blocks or unblocks one existing contact with an owner-signed action.
//
// - Authority is the owner signature alone (I-4): an object signed by another key, for another
//   agent, replayed, expired or outliving L(op) is refused and writes nothing.
// - `contact.block` sets an active contact to `blocked` (the existing F-14 status): later envelopes
//   from its keys are dropped at 04 §3.1.1 and never queued as requests or held (as for D-72's block
//   of an unknown sender). The contact stays in the list, marked Blocked.
// - `contact.unblock` sets a blocked contact back to `active`; what was dropped meanwhile stays gone.
// - Neither changes `revoked` or brings back a removed contact. The nonce row is the audit record;
//   nothing is sent to the contact.
// - The prepare helpers build exactly `{contact}` and refuse before any gesture what apply refuses.
import { encodeBase64url, encodeHex, randomBytes, type JsonObject } from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { OWNER_ACTION_MAX_LIFETIME_SECONDS } from '@4thtech-io/types';
import { describe, expect, it } from 'vitest';
import { FakeClock, passphrase, seed } from './testing/fixtures.js';
import { makeAgent, pairWith, textPayload, type TestAgent } from './testing/envelopes.js';

const START = 1_800_000_000;
const clock = new FakeClock(START);
const ownerA = new MemoryOwnerKeyStore(seed(241), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(242), passphrase());
const stranger = new MemoryOwnerKeyStore(seed(249), passphrase());

async function paired(): Promise<{ a: TestAgent; b: TestAgent }> {
  clock.t = START;
  const a = await makeAgent(clock, new MemoryKeyStore(seed(51)), ownerA, 'alice');
  const b = await makeAgent(clock, new MemoryKeyStore(seed(52)), ownerB, 'bob');
  await pairWith(clock, a, b);
  await pairWith(clock, b, a);
  return { a, b };
}

async function sign(owner: MemoryOwnerKeyStore, body: unknown): Promise<string> {
  const session = await owner.unlock(passphrase());
  try {
    return JSON.stringify({ body, sig: await session.signOwnerAction(body as JsonObject) });
  } finally {
    await session.close();
  }
}

async function signedText(
  agent: TestAgent,
  op: string,
  params: JsonObject,
  over: { owner?: MemoryOwnerKeyStore; agentId?: string; issuedAt?: number; life?: number } = {},
): Promise<string> {
  const owner = over.owner ?? ownerA;
  const issuedAt = over.issuedAt ?? clock.t;
  const body: JsonObject = {
    v: 1,
    agent: over.agentId ?? agent.id,
    owner: encodeHex((await owner.getPublicKeys()).ownerNostr),
    op,
    params,
    nonce: encodeBase64url(randomBytes(16)),
    issuedAt,
    expiresAt: issuedAt + (over.life ?? 600),
  };
  return sign(owner, body);
}

const status = async (agent: TestAgent, id: string) =>
  (await agent.store.transaction((tx) => tx.get('contacts', { contact_id: id })))?.status;
const setStatus = (
  agent: TestAgent,
  id: string,
  value: 'active' | 'blocked' | 'revoked' | 'removed',
) => agent.store.transaction((tx) => tx.update('contacts', { contact_id: id }, { status: value }));
const nonceRows = (agent: TestAgent) =>
  agent.store.transaction((tx) => tx.select('owner_action_nonces'));

async function talkFrom(from: TestAgent, to: TestAgent, text: string) {
  const built = await from.client.envelopes.build({
    to: { contact: to.id },
    payload: textPayload(text),
  });
  expect((await to.client.envelopes.receive({ envelope: built.envelope })).status).toBe('verified');
  return { id: built.envelope.id, processed: await to.client.envelopes.processReceived() };
}

describe('contact.block (WP-12, F-2; 04 §2.5.1)', () => {
  it('blocks an active contact: kept in the list as blocked, an audit row, nothing sent', async () => {
    const { a, b } = await paired();
    const outboxBefore = await a.store.transaction((tx) => tx.count('outbox'));
    const outcome = await a.client.ownerActions.apply(
      await signedText(a, 'contact.block', { contact: b.id }),
    );
    expect(outcome).toEqual({ status: 'applied', op: 'contact.block' });
    expect(await status(a, b.id)).toBe('blocked');
    expect((await a.client.contacts.list()).map((v) => [v.id, v.status])).toEqual([
      [b.id, 'blocked'],
    ]);
    const audit = await nonceRows(a);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ op: 'contact.block', applied_at: clock.t });
    expect(await a.store.transaction((tx) => tx.count('outbox'))).toBe(outboxBefore);
  });

  it('later Talk from the blocked contact is dropped, never queued as a request or held', async () => {
    const { a, b } = await paired();
    await a.client.ownerActions.apply(await signedText(a, 'contact.block', { contact: b.id }));
    const { id, processed } = await talkFrom(b, a, 'hello?');
    expect(processed).toEqual([
      { envelopeId: id, outcome: 'dropped', reason: 'blocked', flagged: false },
    ]);
    expect(await a.client.inbox.counts()).toEqual({ inbox: [], requests: 0 });
    expect(await a.store.transaction((tx) => tx.count('held_envelopes'))).toBe(0);
  });

  it('refuses an already blocked contact, writing nothing', async () => {
    const { a, b } = await paired();
    await a.client.ownerActions.apply(await signedText(a, 'contact.block', { contact: b.id }));
    expect(
      await a.client.ownerActions.apply(await signedText(a, 'contact.block', { contact: b.id })),
    ).toMatchObject({ status: 'refused', op: 'contact.block', reason: 'already_blocked' });
    expect(await nonceRows(a)).toHaveLength(1);
  });

  it('refuses a revoked, removed or unknown contact, writing nothing', async () => {
    const { a, b } = await paired();
    await setStatus(a, b.id, 'revoked');
    expect(
      await a.client.ownerActions.apply(await signedText(a, 'contact.block', { contact: b.id })),
    ).toMatchObject({ status: 'refused', reason: 'contact_revoked' });
    expect(await status(a, b.id)).toBe('revoked');
    await setStatus(a, b.id, 'removed');
    expect(
      await a.client.ownerActions.apply(await signedText(a, 'contact.block', { contact: b.id })),
    ).toMatchObject({ status: 'refused', reason: 'contact_unknown' });
    expect(await status(a, b.id)).toBe('removed');
    expect(
      await a.client.ownerActions.apply(
        await signedText(a, 'contact.block', { contact: `0x${'9'.repeat(40)}` }),
      ),
    ).toMatchObject({ status: 'refused', reason: 'contact_unknown' });
    expect(await nonceRows(a)).toEqual([]);
  });
});

describe('contact.unblock (WP-12, F-2; 04 §2.5.1)', () => {
  it('unblocks a blocked contact; later Talk arrives again; dropped messages stay gone', async () => {
    const { a, b } = await paired();
    await a.client.ownerActions.apply(await signedText(a, 'contact.block', { contact: b.id }));
    await talkFrom(b, a, 'while blocked');
    const outcome = await a.client.ownerActions.apply(
      await signedText(a, 'contact.unblock', { contact: b.id }),
    );
    expect(outcome).toEqual({ status: 'applied', op: 'contact.unblock' });
    expect(await status(a, b.id)).toBe('active');
    const { processed } = await talkFrom(b, a, 'after');
    expect(processed).toHaveLength(1);
    expect(processed[0]?.outcome).not.toBe('dropped');
    const counts = await a.client.inbox.counts();
    expect(counts.requests).toBe(0);
    expect(counts.inbox).toHaveLength(1);
    expect((await nonceRows(a)).map((r) => r.op)).toEqual(['contact.block', 'contact.unblock']);
  });

  it('refuses a contact that is not blocked, a revoked, a removed or an unknown one', async () => {
    const { a, b } = await paired();
    expect(
      await a.client.ownerActions.apply(await signedText(a, 'contact.unblock', { contact: b.id })),
    ).toMatchObject({ status: 'refused', op: 'contact.unblock', reason: 'not_blocked' });
    await setStatus(a, b.id, 'revoked');
    expect(
      await a.client.ownerActions.apply(await signedText(a, 'contact.unblock', { contact: b.id })),
    ).toMatchObject({ status: 'refused', reason: 'contact_revoked' });
    expect(await status(a, b.id)).toBe('revoked');
    await setStatus(a, b.id, 'removed');
    expect(
      await a.client.ownerActions.apply(await signedText(a, 'contact.unblock', { contact: b.id })),
    ).toMatchObject({ status: 'refused', reason: 'contact_unknown' });
    expect(await status(a, b.id)).toBe('removed');
    expect(await nonceRows(a)).toEqual([]);
  });
});

describe('authority (I-4; 04 §2.5.1)', () => {
  for (const op of ['contact.block', 'contact.unblock'] as const) {
    it(`${op}: refused when signed by another key, for another agent, replayed, expired or too long-lived`, async () => {
      const { a, b } = await paired();
      if (op === 'contact.unblock') await setStatus(a, b.id, 'blocked');
      const before = await status(a, b.id);
      const refusedWith = async (text: string, reason: string) =>
        expect(await a.client.ownerActions.apply(text)).toMatchObject({
          status: 'refused',
          reason,
        });
      const params = { contact: b.id };
      await refusedWith(await signedText(a, op, params, { owner: stranger }), 'owner_mismatch');
      await refusedWith(
        await signedText(a, op, params, { agentId: `0x${'1'.repeat(40)}` }),
        'agent_mismatch',
      );
      await refusedWith(await signedText(a, op, params, { issuedAt: clock.t - 700 }), 'expired');
      await refusedWith(await signedText(a, op, params, { life: 601 }), 'lifetime_exceeded');
      expect(await status(a, b.id)).toBe(before);
      expect(await nonceRows(a)).toEqual([]);

      const once = await signedText(a, op, params);
      expect((await a.client.ownerActions.apply(once)).status).toBe('applied');
      await refusedWith(once, 'nonce_used');
    });
  }
});

describe('prepareContactBlock and prepareContactUnblock (WP-12)', () => {
  it('build exactly {contact} within L(op); each applies once signed by the owner', async () => {
    const { a, b } = await paired();
    const block = await a.client.ownerActions.prepareContactBlock(b.id);
    if (block.status !== 'prepared' || block.body.op !== 'contact.block') {
      throw new Error('not prepared');
    }
    expect(block.body.params).toEqual({ contact: b.id });
    expect(block.body.expiresAt - block.body.issuedAt).toBeLessThanOrEqual(
      OWNER_ACTION_MAX_LIFETIME_SECONDS['contact.block'],
    );
    expect(await a.client.ownerActions.apply(await sign(ownerA, block.body))).toEqual({
      status: 'applied',
      op: 'contact.block',
    });
    // Before any gesture: block again is refused, unblock is prepared.
    expect(await a.client.ownerActions.prepareContactBlock(b.id)).toEqual({
      status: 'refused',
      op: 'contact.block',
      reason: 'already_blocked',
    });
    const unblock = await a.client.ownerActions.prepareContactUnblock(b.id);
    if (unblock.status !== 'prepared' || unblock.body.op !== 'contact.unblock') {
      throw new Error('not prepared');
    }
    expect(unblock.body.params).toEqual({ contact: b.id });
    expect(await a.client.ownerActions.apply(await sign(ownerA, unblock.body))).toEqual({
      status: 'applied',
      op: 'contact.unblock',
    });
    expect(await a.client.ownerActions.prepareContactUnblock(b.id)).toEqual({
      status: 'refused',
      op: 'contact.unblock',
      reason: 'not_blocked',
    });
  });

  it('refuse a revoked, removed, unknown or malformed contact', async () => {
    const { a, b } = await paired();
    for (const id of [`0x${'9'.repeat(40)}`, 'marko', `0x${'A'.repeat(40)}`]) {
      expect(await a.client.ownerActions.prepareContactBlock(id)).toMatchObject({
        reason: 'contact_unknown',
      });
      expect(await a.client.ownerActions.prepareContactUnblock(id)).toMatchObject({
        reason: 'contact_unknown',
      });
    }
    await setStatus(a, b.id, 'revoked');
    expect(await a.client.ownerActions.prepareContactBlock(b.id)).toMatchObject({
      reason: 'contact_revoked',
    });
    expect(await a.client.ownerActions.prepareContactUnblock(b.id)).toMatchObject({
      reason: 'contact_revoked',
    });
    await setStatus(a, b.id, 'removed');
    expect(await a.client.ownerActions.prepareContactUnblock(b.id)).toMatchObject({
      reason: 'contact_unknown',
    });
  });

  it('a prepared contact.block signed by another owner is refused and blocks nothing', async () => {
    const { a, b } = await paired();
    const block = await a.client.ownerActions.prepareContactBlock(b.id);
    if (block.status !== 'prepared') throw new Error('not prepared');
    // The stranger's store refuses to sign a body naming another owner; a forged owner field is
    // refused by core as owner_mismatch.
    await expect(sign(stranger, block.body)).rejects.toThrow();
    const forged = {
      ...block.body,
      owner: encodeHex((await stranger.getPublicKeys()).ownerNostr),
    };
    expect(await a.client.ownerActions.apply(await sign(stranger, forged))).toMatchObject({
      status: 'refused',
      reason: 'owner_mismatch',
    });
    expect(await status(a, b.id)).toBe('active');
  });
});
