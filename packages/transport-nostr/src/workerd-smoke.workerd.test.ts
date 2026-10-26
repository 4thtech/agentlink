// M2-3t-w: the Nostr transport's gift wrap runs in the Cloudflare Workers runtime (workerd), where
// the cloud agent (M2-3a) will use it. Runs in the package's `workerd` Vitest project only.
import {
  canonicalize,
  encodeBase64url,
  encodeHex,
  envelopeHash,
  randomBytes,
  type Envelope,
} from '@4thtech-io/crypto';
import { MemoryKeyStore } from '@4thtech-io/crypto/testing';
import { describe, expect, it } from 'vitest';
import { unwrapGiftWrap, wrapEnvelope } from './index.js';

const b64 = (length: number): string => encodeBase64url(randomBytes(length));

async function keys() {
  const store = new MemoryKeyStore(randomBytes(32));
  return { store, pubkey: encodeHex((await store.getPublicBundle()).agentNostr) };
}

describe('@4thtech-io/transport-nostr in workerd (M2-3t-w)', () => {
  it('runs inside the Workers runtime, not Node', () => {
    const g = globalThis as { navigator?: { userAgent?: string }; WebSocketPair?: unknown };
    expect(g.navigator?.userAgent).toBe('Cloudflare-Workers');
    expect(typeof g.WebSocketPair).toBe('function');
  });

  it('wraps an envelope for a recipient and unwraps it again (NIP-44, seal, gift wrap)', async () => {
    const sender = await keys();
    const recipient = await keys();
    const unsigned = {
      v: 1 as const,
      id: b64(16),
      thread: b64(16),
      from: sender.pubkey,
      createdAt: 1_760_000_000,
      recipients: [{ kid: b64(16), enc: b64(32), wk: b64(48) }],
      aead: { alg: 'A256GCM-KC' as const, iv: b64(12), kc: b64(32), ct: b64(64) },
    };
    const envelope: Envelope = {
      ...unsigned,
      sig: await sender.store.signEnvelopeHash(envelopeHash(unsigned)),
    };
    const { wraps } = await wrapEnvelope(envelope, [recipient.pubkey], sender.store);
    expect(wraps).toHaveLength(1);
    const opened = await unwrapGiftWrap(wraps[0]!.event, recipient.store);
    expect(canonicalize(opened.envelope)).toBe(canonicalize(envelope));
  });
});
