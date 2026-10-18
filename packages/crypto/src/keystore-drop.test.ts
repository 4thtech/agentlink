// M1-1g-e (IR-M1-6c-1): KeyStore.signDropRequest, the DropSigner of @4thtech-io/storage's drop
// adapter (M1-6c). 04 §2.1 (drop key), §4; 07 §5.4 (signature format).
// - The KeyStore builds the event itself: kind 27235 and the `domain` tag are fixed inside, so the
//   signer is never a general Nostr signer.
// - It signs with the separate drop key at the current epoch, never the Nostr or EVM identity key.
// - Only POST and DELETE; the body must be the drop's signed JSON and its `ts` must equal createdAt.
// - Everything else is refused with one fixed error that never contains an input (I-7).
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DROP_AUTH_DOMAIN,
  DROP_AUTH_KIND,
  dropAuthEvent,
  verifyDropAuthorization,
  type DropAuthRequest,
} from './drop-auth.js';
import {
  decodeBase64url,
  decodeHex,
  decodeUtf8,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
} from './encoding.js';
import { CryptoInputError } from './errors.js';
import { KeyStoreError, type KeyStore } from './keystore-api.js';
import { DROP_REQUEST_REFUSED, signDropRequest } from './keystore-drop.js';
import { KEY_LABELS, derivePublicIdentity, derivePublicKey, deriveSecretKey } from './keys.js';
import { nostrEventId } from './nostr-event.js';
import { MemoryKeyStore, MemoryOwnerKeyStore, signDropAuthorization } from './testing.js';

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const OWNER_SEED = Uint8Array.from({ length: 32 }, (_, i) => 77 ^ i);
const TS = 1_790_000_000;
const URL_UPLOAD = 'https://drop.agentlink.4thtech.io/v1/upload';
const URL_DELETE = 'https://drop.agentlink.4thtech.io/v1/o/ZWOMpLAsUhfSBVsghbLRDw';
const NONCE = 'IQmYQx-k6oKFW4qJwstHFw';

const json = (value: unknown): Uint8Array => encodeUtf8(JSON.stringify(value));
const UPLOAD_BODY = json({ v: 1, size: 20000, expiresAt: TS + 86_400, nonce: NONCE, ts: TS });
const DELETE_BODY = json({ v: 1, objectId: 'ZWOMpLAsUhfSBVsghbLRDw', nonce: NONCE, ts: TS });
const UPLOAD: DropAuthRequest = { method: 'POST', url: URL_UPLOAD, body: UPLOAD_BODY };
const DELETE: DropAuthRequest = { method: 'DELETE', url: URL_DELETE, body: DELETE_BODY };

const dropHex = (seed: Uint8Array, epoch = 0): string => {
  const key = derivePublicKey(seed, KEY_LABELS.drop, epoch);
  if (key.label !== KEY_LABELS.drop) throw new Error('unreachable');
  return encodeHex(key.publicKey);
};

interface DecodedEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

function decode(authorization: string): DecodedEvent {
  expect(authorization.startsWith('Nostr ')).toBe(true);
  return JSON.parse(decodeUtf8(decodeBase64url(authorization.slice(6)))) as DecodedEvent;
}

async function refusal(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  return 'accepted';
}

function expectRefused(error: unknown): void {
  expect(error).toBeInstanceOf(CryptoInputError);
  expect((error as CryptoInputError).code).toBe('invalid_argument');
  expect((error as CryptoInputError).message).toBe(DROP_REQUEST_REFUSED);
}

// test-vectors/drop-auth (M1-27a), read from the repository: the cross-runtime suite.
interface VectorCase {
  readonly id: string;
  readonly input: Record<string, string>;
  readonly expected: Record<string, string>;
}
const VECTORS = (
  JSON.parse(
    readFileSync(new URL('../../../test-vectors/drop-auth/vectors.json', import.meta.url), 'utf8'),
  ) as { cases: VectorCase[] }
).cases;

let store: KeyStore;
afterEach(async () => {
  vi.restoreAllMocks();
  await store?.close();
});

describe('KeyStore.signDropRequest: the signature (07 §5.4)', () => {
  it('verifies with the drop Worker verifier, for an upload and a DELETE', async () => {
    store = new MemoryKeyStore(SEED);
    for (const request of [UPLOAD, DELETE]) {
      const authorization = await store.signDropRequest(request, TS);
      const result = verifyDropAuthorization(authorization, request, TS);
      expect(result).toEqual({ ok: true, pubkey: dropHex(SEED), createdAt: TS });
    }
  });

  it('builds kind 27235 with exactly the u, method, payload and domain tags', async () => {
    store = new MemoryKeyStore(SEED);
    const event = decode(await store.signDropRequest(UPLOAD, TS));
    expect(event.kind).toBe(DROP_AUTH_KIND);
    expect(event.content).toBe('');
    expect(event.created_at).toBe(TS);
    expect(event.tags.map((tag) => tag[0])).toEqual(['u', 'method', 'payload', 'domain']);
    expect(event.tags[3]).toEqual(['domain', DROP_AUTH_DOMAIN]);
  });

  it('matches the vectors: the signed event of the event-upload request has the vector id', async () => {
    const vector = VECTORS.find((c) => c.id === 'event-upload');
    expect(vector).toBeDefined();
    const { method, url, body, createdAt } = (vector as VectorCase).input;
    const request = { method, url, body: decodeHex(body) } as DropAuthRequest;
    store = new MemoryKeyStore(SEED);
    const event = decode(await store.signDropRequest(request, Number(createdAt)));
    expect(event.tags[2]).toEqual(['payload', (vector as VectorCase).expected.payload]);
    // The vector's own pubkey over the event this KeyStore built gives the vector's NIP-01 id.
    const { id: _id, pubkey: _pubkey, sig: _sig, ...unsigned } = event;
    expect(nostrEventId((vector as VectorCase).input.pubkey, unsigned)).toBe(
      (vector as VectorCase).expected.eventId,
    );
  });

  it('signs every request the accepting vectors carry, and the Worker verifier accepts it', async () => {
    store = new MemoryKeyStore(SEED);
    const accepting = VECTORS.filter(
      (c) => c.input.op === 'verify' && c.expected.outcome === 'accept',
    );
    expect(accepting.length).toBeGreaterThanOrEqual(2);
    for (const c of accepting) {
      const request = {
        method: c.input.method,
        url: c.input.url,
        body: decodeHex(c.input.body as string),
      } as DropAuthRequest;
      const ts = decode(c.input.authorization as string).created_at;
      const authorization = await store.signDropRequest(request, ts);
      const result = verifyDropAuthorization(authorization, request, Number(c.input.now));
      expect(result.ok, c.id).toBe(true);
    }
  });

  it('is the test helper output for the same key and inputs (only the BIP-340 aux differs)', async () => {
    store = new MemoryKeyStore(SEED);
    const secret = deriveSecretKey(SEED, KEY_LABELS.drop, 0);
    const helper = signDropAuthorization(secret, UPLOAD, TS);
    const ours = await store.signDropRequest(UPLOAD, TS);
    const { sig: helperSig, ...helperRest } = decode(helper.authorization);
    const { sig: ourSig, ...ourRest } = decode(ours);
    expect(ourRest).toEqual(helperRest);
    expect(ourRest.pubkey).toBe(helper.pubkey);
    expect(ourSig).toMatch(/^[0-9a-f]{128}$/);
    expect(helperSig).toMatch(/^[0-9a-f]{128}$/);
    // The raw-key signer for backends gives the same event as well.
    const { sig: _s, ...rawRest } = decode(signDropRequest(secret, UPLOAD, TS));
    expect(rawRest).toEqual(helperRest);
  });
});

describe('KeyStore.signDropRequest: the drop key (04 §2.1, D-48)', () => {
  it('signs with the drop key, never the Nostr or EVM identity key', async () => {
    store = new MemoryKeyStore(SEED);
    const { pubkey } = decode(await store.signDropRequest(UPLOAD, TS));
    const identity = derivePublicIdentity(SEED, 0);
    expect(pubkey).toBe(dropHex(SEED));
    expect(pubkey).not.toBe(encodeHex(identity.agentNostr));
    expect(pubkey).not.toBe(encodeHex(identity.agentEnc));
    expect(identity.agentEvm).not.toContain(pubkey.slice(0, 40));
    // The public bundle never carries the drop key.
    const bundle = JSON.stringify(await store.getPublicBundle(), (_k, v: unknown) =>
      v instanceof Uint8Array ? encodeHex(v) : v,
    );
    expect(bundle).not.toContain(pubkey);
  });

  it('uses the drop key of the current key epoch', async () => {
    store = new MemoryKeyStore(SEED, { keyEpoch: 3 });
    const { pubkey } = decode(await store.signDropRequest(UPLOAD, TS));
    expect(pubkey).toBe(dropHex(SEED, 3));
    expect(pubkey).not.toBe(dropHex(SEED, 0));
  });

  it('an OwnerSession has no drop signer: owner keys never sign drop requests', async () => {
    const presence = { kind: 'passphrase', secret: encodeUtf8('correct horse battery') } as const;
    const owner = new MemoryOwnerKeyStore(OWNER_SEED, presence);
    const session = await owner.unlock(presence);
    expect('signDropRequest' in session).toBe(false);
    await owner.close();
    store = new MemoryKeyStore(SEED);
  });
});

describe('KeyStore.signDropRequest: refusals (IR-M1-6c-1)', () => {
  const variants: [string, () => Promise<unknown>][] = [
    ['GET', () => store.signDropRequest({ ...UPLOAD, method: 'GET' }, TS)],
    ['PUT', () => store.signDropRequest({ ...UPLOAD, method: 'PUT' }, TS)],
    ['lowercase post', () => store.signDropRequest({ ...UPLOAD, method: 'post' }, TS)],
    ['createdAt other than ts', () => store.signDropRequest(UPLOAD, TS + 1)],
    ['createdAt not an integer', () => store.signDropRequest(UPLOAD, TS + 0.5)],
    ['createdAt negative', () => store.signDropRequest(UPLOAD, -1)],
    ['non-JSON body', () => store.signDropRequest({ ...UPLOAD, body: encodeUtf8('ts=1') }, TS)],
    ['JSON array body', () => store.signDropRequest({ ...UPLOAD, body: json([1]) }, TS)],
    ['no ts', () => store.signDropRequest({ ...UPLOAD, body: json({ v: 1, nonce: NONCE }) }, TS)],
    [
      'ts as text',
      () =>
        store.signDropRequest(
          { ...UPLOAD, body: json({ v: 1, nonce: NONCE, ts: String(TS) }) },
          TS,
        ),
    ],
    [
      'v other than 1',
      () => store.signDropRequest({ ...UPLOAD, body: json({ v: 2, nonce: NONCE, ts: TS }) }, TS),
    ],
    ['no nonce', () => store.signDropRequest({ ...UPLOAD, body: json({ v: 1, ts: TS }) }, TS)],
    [
      'short nonce',
      () => store.signDropRequest({ ...UPLOAD, body: json({ v: 1, nonce: 'AAAA', ts: TS }) }, TS),
    ],
    [
      'duplicate ts key',
      () =>
        store.signDropRequest(
          { ...UPLOAD, body: encodeUtf8(`{"v":1,"nonce":"${NONCE}","ts":${TS},"ts":${TS + 9}}`) },
          TS,
        ),
    ],
    [
      'body over the 1024-byte signed-body cap',
      () =>
        store.signDropRequest(
          { ...UPLOAD, body: json({ v: 1, nonce: NONCE, ts: TS, pad: 'x'.repeat(1024) }) },
          TS,
        ),
    ],
    [
      'body not bytes',
      () => store.signDropRequest({ ...UPLOAD, body: 'x' as unknown as Uint8Array }, TS),
    ],
    [
      'http URL',
      () => store.signDropRequest({ ...UPLOAD, url: 'http://drop.example/v1/upload' }, TS),
    ],
    [
      'URL not in its serialised form (uppercase host)',
      () =>
        store.signDropRequest(
          { ...UPLOAD, url: 'https://DROP.agentlink.4thtech.io/v1/upload' },
          TS,
        ),
    ],
    [
      'URL not in its serialised form (default port)',
      () =>
        store.signDropRequest(
          { ...UPLOAD, url: 'https://drop.agentlink.4thtech.io:443/v1/upload' },
          TS,
        ),
    ],
    [
      'URL with credentials',
      () =>
        store.signDropRequest(
          { ...UPLOAD, url: 'https://u:p@drop.agentlink.4thtech.io/v1/upload' },
          TS,
        ),
    ],
    ['URL with a fragment', () => store.signDropRequest({ ...UPLOAD, url: `${URL_UPLOAD}#x` }, TS)],
    [
      'a caller-chosen kind',
      () => store.signDropRequest({ ...UPLOAD, kind: 1 } as unknown as DropAuthRequest, TS),
    ],
    [
      'caller-chosen tags',
      () =>
        store.signDropRequest(
          { ...UPLOAD, tags: [['domain', 'other']] } as unknown as DropAuthRequest,
          TS,
        ),
    ],
    [
      'a caller-chosen domain',
      () => store.signDropRequest({ ...UPLOAD, domain: 'other' } as unknown as DropAuthRequest, TS),
    ],
    ['no request', () => store.signDropRequest(null as unknown as DropAuthRequest, TS)],
  ];

  for (const [name, call] of variants) {
    it(`refuses ${name} with the one fixed error`, async () => {
      store = new MemoryKeyStore(SEED);
      expectRefused(await refusal(call));
    });
  }

  it('the fixed error names no input', () => {
    expect(DROP_REQUEST_REFUSED).not.toContain(URL_UPLOAD);
    expect(DROP_REQUEST_REFUSED).not.toContain(String(TS));
    expect(DROP_REQUEST_REFUSED).not.toContain(NONCE);
  });

  it('reads each request field once and signs that snapshot (no swap after the checks)', async () => {
    store = new MemoryKeyStore(SEED);
    const reads: Record<string, number> = {};
    let urlReads = 0;
    const request = new Proxy({ ...UPLOAD } as Record<string, unknown>, {
      get(target, key, receiver) {
        if (typeof key === 'string') reads[key] = (reads[key] ?? 0) + 1;
        if (key === 'url') {
          urlReads += 1;
          return urlReads === 1 ? URL_UPLOAD : 'https://evil.example/v1/upload';
        }
        return Reflect.get(target, key, receiver) as unknown;
      },
    }) as unknown as DropAuthRequest;
    const authorization = await store.signDropRequest(request, TS);
    expect(verifyDropAuthorization(authorization, UPLOAD, TS).ok).toBe(true);
    expect(reads.method).toBe(1);
    expect(reads.url).toBe(1);
    expect(reads.body).toBe(1);
  });

  it('a closed store refuses with keystore_closed', async () => {
    store = new MemoryKeyStore(SEED);
    await store.close();
    const error = await refusal(() => store.signDropRequest(UPLOAD, TS));
    expect(error).toBeInstanceOf(KeyStoreError);
    expect((error as KeyStoreError).code).toBe('keystore_closed');
  });
});

describe('KeyStore.signDropRequest: no key material out (I-1, I-7)', () => {
  it('returns only the header text, which holds no seed or secret key', async () => {
    store = new MemoryKeyStore(SEED);
    const authorization = await store.signDropRequest(UPLOAD, TS);
    expect(typeof authorization).toBe('string');
    expect(Object.keys(decode(authorization)).sort()).toEqual(
      ['content', 'created_at', 'id', 'kind', 'pubkey', 'sig', 'tags'].sort(),
    );
    const decoded = decodeUtf8(decodeBase64url(authorization.slice(6)));
    for (const label of [KEY_LABELS.drop, KEY_LABELS.nostr, KEY_LABELS.evm, KEY_LABELS.enc]) {
      const secret = deriveSecretKey(SEED, label, 0);
      for (const text of [authorization, decoded]) {
        expect(text).not.toContain(encodeHex(secret));
        expect(text).not.toContain(encodeBase64url(secret));
      }
    }
    for (const text of [authorization, decoded]) {
      expect(text).not.toContain(encodeHex(SEED));
      expect(text).not.toContain(encodeBase64url(SEED));
    }
  });

  it('logs nothing, on success or refusal', async () => {
    store = new MemoryKeyStore(SEED);
    const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    await store.signDropRequest(UPLOAD, TS);
    await refusal(() => store.signDropRequest({ ...UPLOAD, method: 'GET' }, TS));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('the raw-key signer refuses the same requests and checks its key', () => {
    const secret = deriveSecretKey(SEED, KEY_LABELS.drop, 0);
    expect(() => signDropRequest(secret, { ...UPLOAD, method: 'GET' }, TS)).toThrow(
      DROP_REQUEST_REFUSED,
    );
    expect(() => signDropRequest(secret, UPLOAD, TS + 1)).toThrow(DROP_REQUEST_REFUSED);
    expect(() => signDropRequest(new Uint8Array(31), UPLOAD, TS)).toThrow(CryptoInputError);
    // The unsigned event it signs is the module's own dropAuthEvent, so its id matches.
    const event = decode(signDropRequest(secret, UPLOAD, TS));
    expect(nostrEventId(event.pubkey, dropAuthEvent(UPLOAD, TS))).toBe(event.id);
  });
});
