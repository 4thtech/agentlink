// AgentLinkClient.create wiring (07 §2) and the store-open rules (07 §3.7).
import { MemoryKeyStore } from '@4thtech-io/crypto/testing';
import { describe, expect, it } from 'vitest';
import { AgentLinkClient } from './client.js';
import { STORE_SCHEMA_VERSION } from './constants.js';
import { MemoryStore } from './store/memory-store.js';
import { RecordingApprovalChannel, TestStoreCipher, seed } from './testing/fixtures.js';

const deps = (store = new MemoryStore()) => ({
  keyStore: new MemoryKeyStore(seed(1)),
  store,
  cipher: new TestStoreCipher(),
  approvals: new RecordingApprovalChannel(),
});

describe('AgentLinkClient.create', () => {
  it('opens a fresh store and exposes the agentId derived from the seed (04 §2.9)', async () => {
    const d = deps();
    const client = await AgentLinkClient.create(d);
    expect(client.agentId).toBe((await d.keyStore.getPublicBundle()).agentId);
    expect(client.approvals).toBe(d.approvals);
    expect(await client.identity.get()).toBeUndefined();
    await expect(client.identity.signedCard()).rejects.toMatchObject({ code: 'identity_missing' });
  });

  it('refuses a store whose schema is newer than the code, and one that is older (no migrations yet)', async () => {
    await expect(
      AgentLinkClient.create(deps(new MemoryStore({ schemaVersion: STORE_SCHEMA_VERSION + 1 }))),
    ).rejects.toMatchObject({ code: 'store_schema_newer' });
    await expect(
      AgentLinkClient.create(deps(new MemoryStore({ schemaVersion: STORE_SCHEMA_VERSION - 1 }))),
    ).rejects.toMatchObject({ code: 'store_schema_older' });
  });

  it('exposes no owner operation that takes presence: owner flows pass an unlocked session', () => {
    // I-4, D-54: presence is collected by the owner surface, never by the core or an MCP tool.
    const proto = Object.getOwnPropertyNames(AgentLinkClient.prototype);
    // The one approved exception: 07 §2 names `client.exportProofPack` (M1-7g). It exports a proof
    // pack, never a key; the content key in it needs the owner's approval (06 §3).
    const EXPORT_ALLOWED: readonly string[] = ['exportProofPack'];
    expect(
      proto.some((name) => !EXPORT_ALLOWED.includes(name) && /unlock|presence|export/i.test(name)),
    ).toBe(false);
    expect(proto.filter((name) => /export/i.test(name))).toEqual(['exportProofPack']);
  });

  it('close() closes the transport once and is safe to call again', async () => {
    let closed = 0;
    const client = await AgentLinkClient.create({
      ...deps(),
      transport: () => ({
        wrap: () => Promise.reject(new Error('unused')),
        publish: () => Promise.reject(new Error('unused')),
        close: () => {
          closed += 1;
        },
      }),
    });
    client.close();
    client.close();
    expect(closed).toBe(1);
  });

  it('close() is a no-op without a transport', async () => {
    const client = await AgentLinkClient.create(deps());
    expect(() => client.close()).not.toThrow();
  });
});
