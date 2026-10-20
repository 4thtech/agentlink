// Delivery receipts on from an older default (06 §3 "Existing policies"; D-109, decided by Tali in
// chat on 2026-10-20; M1-33a). A verified policy with global `receipts.autoDelivered: true` is "on
// from an older default" unless the receipts-kept marker (04 §2.2, a KeyStore item) holds a version
// at most the policy's own. The marker is written only after the policy.set that kept `true` was
// applied and verified at that version. Fail closed and the defaults never count as an older default.
import type { JsonObject } from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { defaultPolicy, type Policy } from '@4thtech-io/types';
import { describe, expect, it } from 'vitest';
import { AgentLinkClient } from './client.js';
import {
  FakeClock,
  RELAYS,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
} from './testing/fixtures.js';
import {
  MemoryPolicyMark,
  MemoryReceiptsKept,
  newNonce,
  ownerHex,
  signWith,
} from './testing/owner.js';
import { MemoryStore } from './store/memory-store.js';

async function setup(options: { kept?: MemoryReceiptsKept | null } = {}) {
  const owner = new MemoryOwnerKeyStore(seed(101), passphrase());
  const store = new MemoryStore();
  const clock = new FakeClock();
  const policyMark = new MemoryPolicyMark();
  const kept = options.kept === undefined ? new MemoryReceiptsKept() : options.kept;
  const client = await AgentLinkClient.create({
    keyStore: new MemoryKeyStore(seed(1)),
    store,
    cipher: new TestStoreCipher(),
    approvals: new RecordingApprovalChannel(),
    clock: clock.now,
    policyMark,
    ...(kept === null ? {} : { receiptsKept: kept }),
  });
  const session = await owner.unlock(passphrase());
  await client.identity.init({
    owner: session,
    ownerKeys: await owner.getPublicKeys(),
    name: 'Agent',
    relays: RELAYS,
  });
  await session.close();
  const OWNER = await ownerHex(owner);
  let version = 0;
  /** Signs and applies the whole policy at the next version; returns that version. */
  const apply = async (edit: (p: Policy) => void = () => {}): Promise<number> => {
    const policy = defaultPolicy();
    edit(policy);
    version += 1;
    const body: JsonObject = {
      v: 1,
      agent: client.agentId,
      owner: OWNER,
      op: 'policy.set',
      params: { version, policy: policy as unknown as JsonObject },
      nonce: newNonce(),
      issuedAt: clock.t,
      expiresAt: clock.t + 600,
    };
    const r = await client.ownerActions.apply(JSON.stringify(await signWith(owner, body)));
    expect(r).toMatchObject({ status: 'applied' });
    return version;
  };
  const on = (p: Policy) => {
    p.receipts.autoDelivered = true;
  };
  return { client, store, policyMark, kept, apply, on };
}

describe('receipts on from an older default (06 §3, D-109)', () => {
  it('a signed policy with autoDelivered true and no marker is on from an older default', async () => {
    const { client, apply, on } = await setup();
    await apply(on);
    expect(await client.ownerActions.receiptsOnFromOlderDefault()).toBe(true);
  });

  it('the defaults, a signed false and fail closed are never an older default', async () => {
    const { client, store, apply, on } = await setup();
    expect((await client.ownerActions.loadPolicy()).mode).toBe('defaults');
    expect(await client.ownerActions.receiptsOnFromOlderDefault()).toBe(false);
    await apply();
    expect(await client.ownerActions.receiptsOnFromOlderDefault()).toBe(false);
    await apply(on);
    // The stored rules go missing: fail closed, no receipt is signed anyway.
    await store.transaction((tx) => tx.delete('policies', {}));
    expect((await client.ownerActions.loadPolicy()).mode).toBe('fail_closed');
    expect(await client.ownerActions.receiptsOnFromOlderDefault()).toBe(false);
  });

  it('kept: the marker records the version; later re-signs keep true without counting as old', async () => {
    const { client, kept, apply, on } = await setup();
    await apply(on);
    const v = await apply(on); // the owner's re-sign that explicitly kept true
    expect(await client.ownerActions.recordReceiptsKept(v)).toBe(true);
    expect(kept!.value).toBe(v);
    expect(await client.ownerActions.receiptsOnFromOlderDefault()).toBe(false);
    await apply(on); // a later re-sign for another reason
    expect(await client.ownerActions.receiptsOnFromOlderDefault()).toBe(false);
  });

  it('the marker is written only for the applied version that kept true', async () => {
    const { client, kept, apply, on } = await setup();
    const v1 = await apply(on);
    // Not the applied version (above or below it): refused, nothing written.
    expect(await client.ownerActions.recordReceiptsKept(v1 + 1)).toBe(false);
    const v2 = await apply(on);
    expect(await client.ownerActions.recordReceiptsKept(v1)).toBe(false);
    expect(kept!.value).toBeNull();
    // The applied policy turned receipts off: nothing to keep.
    const v3 = await apply();
    expect(await client.ownerActions.recordReceiptsKept(v3)).toBe(false);
    expect(kept!.value).toBeNull();
    expect(v2).toBeLessThan(v3);
  });

  it('a marker above the applied version, an unreadable one, or none at all counts as not kept', async () => {
    const { client, kept, apply, on } = await setup();
    const v = await apply(on);
    kept!.value = v + 1;
    expect(await client.ownerActions.receiptsOnFromOlderDefault()).toBe(true);
    kept!.value = v;
    expect(await client.ownerActions.receiptsOnFromOlderDefault()).toBe(false);
    kept!.failRead = true;
    expect(await client.ownerActions.receiptsOnFromOlderDefault()).toBe(true);
  });

  it('without a marker store nothing is remembered: still asked, recordReceiptsKept is false', async () => {
    const { client, apply, on } = await setup({ kept: null });
    const v = await apply(on);
    expect(await client.ownerActions.receiptsOnFromOlderDefault()).toBe(true);
    expect(await client.ownerActions.recordReceiptsKept(v)).toBe(false);
  });

  it('a failed marker write reports false and is not trusted', async () => {
    const { client, kept, apply, on } = await setup();
    const v = await apply(on);
    kept!.failWrite = true;
    expect(await client.ownerActions.recordReceiptsKept(v)).toBe(false);
    expect(await client.ownerActions.receiptsOnFromOlderDefault()).toBe(true);
  });

  it('checks a given policy and version (policy recover reviews the stored rules)', async () => {
    const { client, kept } = await setup();
    const p = defaultPolicy();
    p.receipts.autoDelivered = true;
    expect(await client.ownerActions.receiptsOnFromOlderDefault({ policy: p, version: 4 })).toBe(
      true,
    );
    kept!.value = 4;
    expect(await client.ownerActions.receiptsOnFromOlderDefault({ policy: p, version: 4 })).toBe(
      false,
    );
    p.receipts.autoDelivered = false;
    kept!.value = null;
    expect(await client.ownerActions.receiptsOnFromOlderDefault({ policy: p, version: 4 })).toBe(
      false,
    );
  });
});
