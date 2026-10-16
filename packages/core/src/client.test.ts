// AgentLinkClient.create wiring (07 §2) and the store-open rules (07 §3.7).
import { MemoryKeyStore } from '@agentlink/crypto/testing';
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
    expect(proto.some((name) => /unlock|presence|export/i.test(name))).toBe(false);
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
