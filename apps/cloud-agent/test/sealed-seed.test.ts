// M2-3a: the Deploy-button seed path (08 §3.2; 04 §2.2): no AGENT_SEED, only SEED_WRAP_KEY. The seed
// is generated once in the Worker and stored only sealed under SEED_WRAP_KEY (the 07 §3.1 sealed
// form, in the agent item `seed`); it is never replaced or deleted, never stored unwrapped, never
// logged; the agent syncs from it like the AGENT_SEED path.
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import {
  decodeBase64url,
  decodeHex,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  hkdfSha256,
  randomBytes,
  type OwnerPresence,
} from '@4thtech-io/crypto';
import { createStoreColumnCipher } from '@4thtech-io/crypto/keystore';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOUD_STORE_KEY_INFO, SEALED_SEED_CONTEXT } from '../src/worker-keystore.js';
import { relay } from './fake-relay.js';
import { dumpStorage, freshAgent, sendToAgent, setUpAgent } from './helpers.js';
import { TEST_SEED_WRAP_KEY } from './secrets.js';
import type { TestAgentDO } from './worker.js';

const presence = (): OwnerPresence => ({
  kind: 'passphrase',
  secret: encodeUtf8('correct horse battery'),
});

const sealedItem = (stub: DurableObjectStub<TestAgentDO>) =>
  runInDurableObject(stub, (instance: TestAgentDO) => instance.testStore().readItem('seed'));

async function openSeed(sealed: string): Promise<Uint8Array> {
  const cipher = await createStoreColumnCipher(decodeBase64url(TEST_SEED_WRAP_KEY));
  try {
    return decodeHex(await cipher.open(SEALED_SEED_CONTEXT, sealed), { length: 32 });
  } finally {
    cipher.close();
  }
}

function forms(bytes: Uint8Array): string[] {
  const b64 = btoa(String.fromCharCode(...bytes));
  return [encodeHex(bytes), encodeBase64url(bytes), b64, b64.replace(/=+$/, '')];
}

let logs: string[];
beforeEach(() => {
  relay.reset();
  logs = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('sealed seed (SEED_WRAP_KEY path)', () => {
  it('is not set up until the seed is provisioned', async () => {
    const stub = freshAgent();
    expect((await stub.syncNow()).status).toBe('not_set_up');
    expect(await sealedItem(stub)).toBeNull();
  });

  it('provisions the seed once, sealed; a second call keeps it', async () => {
    const stub = freshAgent();
    expect(await stub.provisionSeed()).toBe('created');
    const first = await sealedItem(stub);
    expect(first?.startsWith('v1.')).toBe(true);
    expect(await stub.provisionSeed()).toBe('exists');
    expect(await sealedItem(stub)).toBe(first);
    // A writer that bypasses the code cannot replace or delete it either (triggers).
    await runInDurableObject(stub, (_i: TestAgentDO, state: DurableObjectState) => {
      expect(() =>
        state.storage.sql.exec(`UPDATE agent_items SET value = 'v1.x' WHERE name = 'seed'`),
      ).toThrow();
      expect(() => state.storage.sql.exec(`DELETE FROM agent_items WHERE name = 'seed'`)).toThrow();
    });
    expect(await sealedItem(stub)).toBe(first);
  });

  it('syncs from the sealed seed, and never stores or logs it (or the store key) unwrapped', async () => {
    const stub = freshAgent();
    await stub.provisionSeed();
    const owner = new MemoryOwnerKeyStore(randomBytes(32), presence());
    const agentNostr = await setUpAgent(stub, owner, presence);
    await sendToAgent(new MemoryKeyStore(randomBytes(32)), agentNostr);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(relay.reqs).toBeGreaterThan(0);

    const seed = await openSeed((await sealedItem(stub)) as string);
    const storeKey = hkdfSha256(
      seed,
      encodeUtf8('agentlink-v1'),
      encodeUtf8(CLOUD_STORE_KEY_INFO),
      32,
    );
    const wrapKey = decodeBase64url(TEST_SEED_WRAP_KEY);
    const storage = await dumpStorage(stub);
    const logText = logs.join('\n');
    for (const secret of [...forms(seed), ...forms(storeKey), ...forms(wrapKey)]) {
      expect(storage.includes(secret)).toBe(false);
      expect(logText.includes(secret)).toBe(false);
    }
  });
});
