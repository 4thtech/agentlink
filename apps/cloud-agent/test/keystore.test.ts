// M2-3a: the Worker KeyStore (04 §2.2 "Self-host Worker", §3.1.1). The shared KeyStore conformance
// suite (epochs, drop requests; M1-1g-h), parity with the in-memory reference KeyStore, the seed
// check against the recorded agent, close, and the seed-source rules over AGENT_SEED.
import { runInDurableObject } from 'cloudflare:test';
import {
  decodeHex,
  encodeBase64url,
  encodeHex,
  envelopeHash,
  randomBytes,
  verifyEnvelope,
} from '@4thtech-io/crypto';
import { MemoryKeyStore, runKeyStoreConformance } from '@4thtech-io/crypto/testing';
import { describe, expect, it } from 'vitest';
import { WorkerKeyStore, provisionSealedSeed, resolveSeedSource } from '../src/worker-keystore.js';
import { freshAgent, testEnv } from './helpers.js';
import { TEST_AGENT_SEED } from './secrets.js';
import type { TestAgentDO } from './worker.js';

const conformanceSeed = randomBytes(32);
const sourceOf = (seed: Uint8Array) => () => Promise.resolve(new Uint8Array(seed));

runKeyStoreConformance(
  {
    name: 'WorkerKeyStore',
    seed: conformanceSeed,
    open: (epoch) => WorkerKeyStore.open(sourceOf(conformanceSeed), { keyEpoch: epoch }),
  },
  { describe, it },
);

describe('WorkerKeyStore (M2-3a)', () => {
  it('derives the same identity and signatures as the reference KeyStore', async () => {
    const seed = randomBytes(32);
    const worker = await WorkerKeyStore.open(sourceOf(seed));
    const reference = new MemoryKeyStore(new Uint8Array(seed));
    expect(await worker.getPublicBundle()).toEqual(await reference.getPublicBundle());
    const peer = new MemoryKeyStore(randomBytes(32));
    const peerKey = encodeHex((await peer.getPublicBundle()).agentNostr);
    const ownKey = encodeHex((await worker.getPublicBundle()).agentNostr);
    const ct = await worker.nip44Encrypt(peerKey, 'hello');
    expect(await peer.nip44Decrypt(ownKey, ct)).toBe('hello');
    // BIP-340 signatures use fresh aux randomness, so compare by verification, not bytes.
    const b64 = (n: number) => encodeBase64url(randomBytes(n));
    const unsigned = {
      v: 1 as const,
      id: b64(16),
      thread: b64(16),
      from: ownKey,
      createdAt: 1_790_000_000,
      // Two entries: the recipient's and the sender's own copy (04 §3.1, at least 2).
      recipients: [
        { kid: b64(16), enc: b64(32), wk: b64(48) },
        { kid: b64(16), enc: b64(32), wk: b64(48) },
      ],
      aead: { alg: 'A256GCM-KC' as const, iv: b64(12), kc: b64(32), ct: b64(64) },
    };
    const sig = await worker.signEnvelopeHash(envelopeHash(unsigned));
    expect(verifyEnvelope({ ...unsigned, sig })).toBe(true);
  });

  it('wipes what the source handed it after every call', async () => {
    const seed = randomBytes(32);
    const handed: Uint8Array[] = [];
    const store = await WorkerKeyStore.open(() => {
      const copy = new Uint8Array(seed);
      handed.push(copy);
      return Promise.resolve(copy);
    });
    await store.getPublicBundle();
    await store.withStoreKey(() => undefined);
    expect(handed.length).toBeGreaterThanOrEqual(3);
    for (const copy of handed) expect(copy.every((b) => b === 0)).toBe(true);
  });

  it('refuses a seed that derives another agent than the recorded one', async () => {
    const recorded = (await new MemoryKeyStore(randomBytes(32)).getPublicBundle()).agentId;
    await expect(
      WorkerKeyStore.open(sourceOf(randomBytes(32)), { agentId: recorded }),
    ).rejects.toThrow(expect.objectContaining({ code: 'identity_mismatch' }));
  });

  it('refuses every call after close', async () => {
    const store = await WorkerKeyStore.open(sourceOf(randomBytes(32)));
    await store.close();
    await expect(store.getPublicBundle()).rejects.toThrow(
      expect.objectContaining({ code: 'keystore_closed' }),
    );
  });
});

describe('seed sources: the AGENT_SEED path (08 §3.2)', () => {
  it('uses AGENT_SEED when set and no sealed seed is stored', async () => {
    await runInDurableObject(freshAgent(), async (instance: TestAgentDO) => {
      const store = await WorkerKeyStore.open(resolveSeedSource(testEnv(), instance.testStore()));
      const expected = new MemoryKeyStore(decodeHex(TEST_AGENT_SEED, { length: 32 }));
      expect(store.agentId).toBe((await expected.getPublicBundle()).agentId);
    });
  });

  it('refuses a malformed AGENT_SEED, both secrets at once, and neither', async () => {
    await runInDurableObject(freshAgent(), async (instance: TestAgentDO) => {
      const store = instance.testStore();
      for (const bad of ['5A'.repeat(32), '5a'.repeat(31), `${'5a'.repeat(32)}\n`]) {
        expect(() => resolveSeedSource({ AGENT_SEED: bad }, store)).toThrow(
          expect.objectContaining({ code: 'seed_secret_invalid' }),
        );
      }
      expect(() => resolveSeedSource({}, store)).toThrow(
        expect.objectContaining({ code: 'seed_missing' }),
      );
      await provisionSealedSeed(
        { SEED_WRAP_KEY: 'paWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaU' },
        store,
      );
      expect(() => resolveSeedSource({ AGENT_SEED: TEST_AGENT_SEED }, store)).toThrow(
        expect.objectContaining({ code: 'seed_conflict' }),
      );
    });
  });
});
