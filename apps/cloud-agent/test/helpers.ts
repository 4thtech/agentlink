// Shared steps of the AgentDO tests. No test seam import here: a test passes its own test owner and
// sender (MemoryOwnerKeyStore, MemoryKeyStore from `@4thtech-io/crypto/testing`, which only
// *.test.ts files may import).
import { env, runInDurableObject } from 'cloudflare:test';
import { AgentLinkClient } from '@4thtech-io/core';
import {
  encodeBase64url,
  encodeHex,
  encodeHex0x,
  envelopeHash,
  randomBytes,
  type Envelope,
  type KeyStore,
  type OwnerKeyStore,
  type OwnerPresence,
} from '@4thtech-io/crypto';
import { wrapEnvelope } from '@4thtech-io/transport-nostr';
import type { CloudAgentEnv } from '../src/agent-do.js';
import { PendingApprovalChannel } from '../src/approval-channel.js';
import { openStoreCipher } from '../src/store-cipher.js';
import { WorkerKeyStore, resolveSeedSource } from '../src/worker-keystore.js';
import { relay, type RelayEvent } from './fake-relay.js';
import type { TestAgentDO } from './worker.js';

/** The agent's own relays in the tests (two: the card rule's minimum, 04 §3.4). */
export const RELAY_URLS = [
  'wss://relay-a.cloud-agent-test.net',
  'wss://relay-b.cloud-agent-test.net',
];

export const testEnv = (): CloudAgentEnv => env as CloudAgentEnv;

/** A fresh object per test (its own storage), named so tests never share one. */
export function freshAgent(): DurableObjectStub<TestAgentDO> {
  const ns = testEnv().AGENT as unknown as DurableObjectNamespace<TestAgentDO>;
  return ns.get(ns.idFromName(`agent-${encodeHex(randomBytes(8))}`));
}

/**
 * Creates the agent's identity inside the object, as `/setup` will (M2-3f-1): the owner signs the
 * first card with a session from `owner`. Returns the agent's Nostr key (64 lowercase hex).
 */
export async function setUpAgent(
  stub: DurableObjectStub<TestAgentDO>,
  owner: OwnerKeyStore,
  presence: () => OwnerPresence,
  relays: readonly string[] = RELAY_URLS,
): Promise<string> {
  return runInDurableObject(stub, async (instance: TestAgentDO) => {
    const store = instance.testStore();
    const keyStore = await WorkerKeyStore.open(resolveSeedSource(testEnv(), store));
    const cipher = await openStoreCipher(keyStore);
    try {
      const client = await AgentLinkClient.create({
        keyStore,
        store,
        cipher,
        approvals: new PendingApprovalChannel(),
        clock: () => instance.testClock(),
      });
      // The test owner's session has an expiry timer; close it so nothing stays pending.
      const session = await owner.unlock(presence());
      try {
        await client.identity.init({
          owner: session,
          ownerKeys: await owner.getPublicKeys(),
          name: 'Cloud agent',
          relays,
        });
      } finally {
        await session.close();
      }
      client.close();
      await instance.start();
      return encodeHex((await keyStore.getPublicBundle()).agentNostr);
    } finally {
      cipher.close();
      await keyStore.close();
    }
  });
}

const b64 = (length: number): string => encodeBase64url(randomBytes(length));

/** A signed envelope from `sender` to the agent, gift-wrapped and put on the relay. */
export async function sendToAgent(
  sender: KeyStore,
  agentNostr: string,
): Promise<{
  readonly envelopeId: string;
  readonly envelopeHash: string;
  readonly wrap: RelayEvent;
}> {
  const from = encodeHex((await sender.getPublicBundle()).agentNostr);
  const unsigned = {
    v: 1 as const,
    id: b64(16),
    thread: b64(16),
    from,
    createdAt: Math.floor(Date.now() / 1000) - 60,
    // Two entries: the recipient's and the sender's own copy (04 §3.1, at least 2).
    recipients: [
      { kid: b64(16), enc: b64(32), wk: b64(48) },
      { kid: b64(16), enc: b64(32), wk: b64(48) },
    ],
    aead: { alg: 'A256GCM-KC' as const, iv: b64(12), kc: b64(32), ct: b64(64) },
  };
  const envelope: Envelope = {
    ...unsigned,
    sig: await sender.signEnvelopeHash(envelopeHash(unsigned)),
  };
  const { wraps } = await wrapEnvelope(envelope, [agentNostr], sender);
  const wrap = wraps[0]?.event as unknown as RelayEvent;
  relay.events.push(wrap);
  return { envelopeId: unsigned.id, envelopeHash: encodeHex0x(envelopeHash(unsigned)), wrap };
}

/** Every row of every table in the object's SQLite storage, as one JSON text. */
export async function dumpStorage(stub: DurableObjectStub<TestAgentDO>): Promise<string> {
  return runInDurableObject(stub, (_instance: TestAgentDO, state: DurableObjectState) => {
    const tables = [
      ...state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").raw(),
    ]
      .map((r) => r[0])
      .filter((n): n is string => typeof n === 'string' && !n.startsWith('sqlite_'));
    const out: Record<string, unknown> = {};
    for (const table of tables) {
      try {
        out[table] = state.storage.sql.exec(`SELECT * FROM "${table}"`).toArray();
      } catch {
        // an internal table the object may not read
      }
    }
    return JSON.stringify(out);
  });
}
