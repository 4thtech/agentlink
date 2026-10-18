// M1-1g-e (IR-M1-1g-e-1 L-3): the drop-auth vectors against KeyStore.signDropRequest, loaded from
// test-vectors/drop-auth/vectors.json. This package may read files; @4thtech-io/crypto's tests may
// not (no Node built-ins), so keystore-drop.test.ts carries copies of these values, and the drift
// check below fails when the vector file changes and those copies do not.
import { readFileSync } from 'node:fs';
import {
  decodeBase64url,
  decodeHex,
  decodeUtf8,
  nostrEventId,
  verifyDropAuthorization,
  type DropAuthRequest,
} from '@4thtech-io/crypto';
import { deriveAgentId } from '@4thtech-io/crypto/keystore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KeychainKeyStore } from './keychain-keystore.js';
import { keychainAccount, type KeychainBackend } from './keychain.js';

interface VectorCase {
  readonly id: string;
  readonly input: Record<string, string>;
  readonly expected: Record<string, string>;
}

const repo = (path: string): URL => new URL(`../../../${path}`, import.meta.url);
const VECTORS = (
  JSON.parse(readFileSync(repo('test-vectors/drop-auth/vectors.json'), 'utf8')) as {
    cases: VectorCase[];
  }
).cases;
const CRYPTO_TEST = readFileSync(repo('packages/crypto/src/keystore-drop.test.ts'), 'utf8');

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const AGENT = deriveAgentId(SEED);

interface DecodedEvent {
  readonly kind: number;
  readonly created_at: number;
  readonly tags: string[][];
  readonly content: string;
}
const decode = (authorization: string): DecodedEvent =>
  JSON.parse(decodeUtf8(decodeBase64url(authorization.slice('Nostr '.length)))) as DecodedEvent;

const eventUpload = (): VectorCase => {
  const found = VECTORS.find((c) => c.id === 'event-upload');
  if (found === undefined) throw new Error('drop-auth: event-upload vector missing');
  return found;
};
const accepting = (): VectorCase[] =>
  VECTORS.filter((c) => c.input.op === 'verify' && c.expected.outcome === 'accept');

class MapKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  get(account: string): Promise<Uint8Array | null> {
    const value = this.items.get(account);
    return Promise.resolve(value === undefined ? null : value.slice());
  }
  set(account: string, value: Uint8Array): Promise<void> {
    this.items.set(account, value.slice());
    return Promise.resolve();
  }
  delete(account: string): Promise<boolean> {
    return Promise.resolve(this.items.delete(account));
  }
}

describe('drop-auth vectors and KeyStore.signDropRequest (M1-1g-e)', () => {
  let store: KeychainKeyStore;

  beforeEach(async () => {
    const keychain = new MapKeychain();
    keychain.items.set(keychainAccount(AGENT, 'seed'), SEED.slice());
    keychain.items.set(keychainAccount(AGENT, 'store-key'), new Uint8Array(32).fill(7));
    store = await KeychainKeyStore.open(keychain, AGENT);
  });

  afterEach(async () => {
    await store.close();
  });

  it('builds the event-upload vector event: its payload and, under the vector pubkey, its id', async () => {
    const { input, expected } = eventUpload();
    const request = {
      method: input.method,
      url: input.url,
      body: decodeHex(input.body as string),
    } as DropAuthRequest;
    const event = decode(await store.signDropRequest(request, Number(input.createdAt)));
    expect(event.tags[2]).toEqual(['payload', expected.payload]);
    const unsigned = {
      kind: event.kind,
      created_at: event.created_at,
      tags: event.tags,
      content: '',
    };
    expect(nostrEventId(input.pubkey as string, unsigned)).toBe(expected.eventId);
  });

  it('signs every accepting verify vector request, and the verifier accepts it', async () => {
    const cases = accepting();
    expect(cases.map((c) => c.input.method)).toEqual(expect.arrayContaining(['POST', 'DELETE']));
    for (const c of cases) {
      const request = {
        method: c.input.method,
        url: c.input.url,
        body: decodeHex(c.input.body as string),
      } as DropAuthRequest;
      const ts = decode(c.input.authorization as string).created_at;
      const authorization = await store.signDropRequest(request, ts);
      expect(verifyDropAuthorization(authorization, request, Number(c.input.now)).ok, c.id).toBe(
        true,
      );
    }
  });
});

describe('the drop-auth values copied into @4thtech-io/crypto tests match vectors.json (L-3)', () => {
  const block = (name: string): string => {
    const start = CRYPTO_TEST.indexOf(`const ${name} = `);
    expect(start, name).toBeGreaterThanOrEqual(0);
    return CRYPTO_TEST.slice(start, CRYPTO_TEST.indexOf('as const;', start));
  };

  it('VECTOR_EVENT_UPLOAD equals the event-upload case', () => {
    const { input, expected } = eventUpload();
    const text = block('VECTOR_EVENT_UPLOAD');
    for (const value of [input.method, input.url, input.body, input.pubkey]) {
      expect(text).toContain(`'${value}'`);
    }
    expect(text).toContain(`createdAt: ${input.createdAt},`);
    expect(text).toContain(`payload: '${expected.payload}'`);
    expect(text).toContain(`eventId: '${expected.eventId}'`);
  });

  it('VECTOR_ACCEPTED lists exactly the accepting verify cases, with their values', () => {
    const text = block('VECTOR_ACCEPTED');
    const cases = accepting();
    expect(text.match(/id: '/g)?.length).toBe(cases.length);
    for (const c of cases) {
      const start = text.indexOf(`id: '${c.id}'`);
      expect(start, c.id).toBeGreaterThanOrEqual(0);
      const entry = text.slice(start, text.indexOf('}', start));
      const ts = decode(c.input.authorization as string).created_at;
      expect(entry).toContain(`method: '${c.input.method}'`);
      expect(entry).toContain(`url: '${c.input.url}'`);
      expect(entry).toContain(`'${c.input.body}'`);
      expect(entry).toContain(`ts: ${ts},`);
      expect(entry).toMatch(new RegExp(`now: ${c.input.now as string},?\\s*$`));
    }
  });
});
