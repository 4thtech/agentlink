// WP-11 (F-1, D-117 A; 04 §2.3.3, §2.5.1 `backup.export`): the local app saves a recovery kit. Core
// prepares the unsigned `backup.export` for this agent (the page gives no value: the server draws the
// kitId and the contents are fixed), and apply() records its nonce row, the audit record of the
// export, before anything is sealed.
import { encodeBase64url, randomBytes } from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { describe, expect, it } from 'vitest';
import { FakeClock, passphrase, seed } from './testing/fixtures.js';
import { makeAgent, type TestAgent } from './testing/envelopes.js';

const START = 1_800_000_000;
const clock = new FakeClock(START);
const ownerA = new MemoryOwnerKeyStore(seed(231), passphrase());

async function agentOf(n: number): Promise<TestAgent> {
  clock.t = START;
  return makeAgent(clock, new MemoryKeyStore(seed(60 + n)), ownerA, `backup-${n}`);
}

const nonceRows = (agent: TestAgent) =>
  agent.store.transaction((tx) => tx.select('owner_action_nonces'));

describe('prepareBackupExport (WP-11, 04 §2.5.1 backup.export)', () => {
  it('builds {kitId, contents} for this agent; apply records the nonce row', async () => {
    const a = await agentOf(1);
    const kitId = encodeBase64url(randomBytes(16));
    const prepared = await a.client.ownerActions.prepareBackupExport(kitId, 'full');
    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') return;
    expect(prepared.op).toBe('backup.export');
    expect(prepared.body.op).toBe('backup.export');
    expect(prepared.body.agent).toBe(a.id);
    expect(prepared.body.params).toEqual({ kitId, contents: 'full' });
    expect(prepared.body.expiresAt - prepared.body.issuedAt).toBeLessThanOrEqual(600);

    const session = await ownerA.unlock(passphrase());
    let signed: string;
    try {
      signed = JSON.stringify({
        body: prepared.body,
        sig: await session.signOwnerAction(prepared.body),
      });
    } finally {
      await session.close();
    }
    const before = (await nonceRows(a)).length;
    expect(await a.client.ownerActions.apply(signed)).toEqual({
      status: 'applied',
      op: 'backup.export',
    });
    expect(await nonceRows(a)).toHaveLength(before + 1);
  });

  it('refuses a kitId that is not 16 bytes of base64url, and contents other than full/identity', async () => {
    const a = await agentOf(2);
    for (const bad of ['', 'short', 'A'.repeat(23), `${'A'.repeat(21)}=`, 42 as unknown as string]) {
      expect(await a.client.ownerActions.prepareBackupExport(bad, 'full')).toMatchObject({
        status: 'refused',
        op: 'backup.export',
        reason: 'params_invalid',
      });
    }
    expect(
      await a.client.ownerActions.prepareBackupExport(
        encodeBase64url(randomBytes(16)),
        'everything' as never,
      ),
    ).toMatchObject({ status: 'refused', op: 'backup.export', reason: 'params_invalid' });
  });
});
