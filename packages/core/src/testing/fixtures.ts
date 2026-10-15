// Test doubles for @agentlink/core tests. Not part of the build (tsconfig.json excludes src/testing).
//
// TestStoreCipher is NOT encryption: it encodes the plaintext with its SealContext so tests can check
// that `enc` values are sealed, bound to table, column and row key, and refused elsewhere (07 §3.1).
// The real StoreCipher (AES-256-GCM under the store key through @agentlink/crypto) is M1-8b.
import {
  decodeBase64url,
  decodeUtf8,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  hmacSha256,
  type OwnerPresence,
} from '@agentlink/crypto';
import type { Sealed } from '../store/schema.js';
import type { SealContext, Store, StoreCipher } from '../store/store.js';
import type {
  ApprovalChannel,
  ApprovalChannelStatus,
  ApprovalRequest,
} from '../approval-channel.js';

const PREFIX = 'test-sealed:';

export class TestStoreCipher implements StoreCipher {
  sealCalls = 0;
  openCalls = 0;

  seal(context: SealContext, plaintext: string): Promise<Sealed> {
    this.sealCalls += 1;
    const body = JSON.stringify([context.table, context.column, context.rowKey, plaintext]);
    return Promise.resolve(`${PREFIX}${encodeBase64url(encodeUtf8(body))}` as Sealed);
  }

  open(context: SealContext, sealed: Sealed): Promise<string> {
    this.openCalls += 1;
    return Promise.resolve().then(() => {
      if (!sealed.startsWith(PREFIX)) throw new Error('test cipher: not a sealed value');
      const parsed: unknown = JSON.parse(decodeUtf8(decodeBase64url(sealed.slice(PREFIX.length))));
      if (
        !Array.isArray(parsed) ||
        parsed[0] !== context.table ||
        parsed[1] !== context.column ||
        parsed[2] !== context.rowKey ||
        typeof parsed[3] !== 'string'
      ) {
        throw new Error('test cipher: the value does not open in this context');
      }
      return parsed[3];
    });
  }

  /** A keyed digest under a fixed test index key (07 §3.1); the real one is HKDF of the store key. */
  indexDigest(data: Uint8Array): Promise<string> {
    return Promise.resolve(encodeHex(hmacSha256(TEST_INDEX_KEY, data)));
  }
}

/** The fixed index key of TestStoreCipher (test only). */
export const TEST_INDEX_KEY = new Uint8Array(32).fill(0x1d);

/** An ApprovalChannel that records requests and reports a scripted status. */
export class RecordingApprovalChannel implements ApprovalChannel {
  readonly requests: ApprovalRequest[] = [];
  next: ApprovalChannelStatus = { state: 'pending' };

  request(request: ApprovalRequest) {
    this.requests.push(request);
    return Promise.resolve({ approvalId: request.approvalId });
  }

  status() {
    return Promise.resolve(this.next);
  }
}

/** A fake clock in unix seconds. */
export class FakeClock {
  constructor(public t = 1_800_000_000) {}
  now = (): number => this.t;
}

/** A fresh 32-byte seed filled with `n`. */
export const seed = (n: number): Uint8Array => new Uint8Array(32).fill(n);

/** A fresh passphrase presence (the store wipes what it is given, so each unlock needs a new one). */
export const passphrase = (text = 'correct horse'): OwnerPresence => ({
  kind: 'passphrase',
  secret: encodeUtf8(text),
});

export const RELAYS = Object.freeze(['wss://relay.agentlink.dev', 'wss://nos.lol']);

let envelopeCounter = 0;

/**
 * Stores a processed pairing envelope (the evidence completePairing looks for, 04 §2.9, §3.6). The
 * real handshake and ack are built, verified and stored by M1-7c; here only the row exists.
 */
export async function storePairingEnvelope(
  store: Store,
  options: {
    readonly type: 'handshake' | 'handshake-ack';
    readonly direction: 'in' | 'out';
    readonly from: string;
    readonly createdAt?: number;
  },
): Promise<string> {
  envelopeCounter += 1;
  const id = `env-${envelopeCounter}`;
  await store.transaction((tx) =>
    tx.insert('envelopes', {
      envelope_id: id,
      envelope_hash: `0x${envelopeCounter.toString(16).padStart(64, '0')}`,
      thread_id: 'thread',
      direction: options.direction,
      contact_id: null,
      from_key: options.from,
      type: options.type,
      state: 'ok',
      refused_reason: null,
      created_at: options.createdAt ?? 1,
      envelope_json: '{}',
      payload_json: null,
      read_at: null,
      delivery: options.direction === 'out' ? 'sent' : null,
      refused_at: null,
      request_accepted_at: null,
    }),
  );
  return id;
}
