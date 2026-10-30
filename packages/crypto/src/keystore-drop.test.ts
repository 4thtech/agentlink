// M1-1g-e (IR-M1-6c-1): KeyStore.signDropRequest, the DropSigner of @4thtech-io/storage's drop
// adapter (M1-6c). 04 §2.1 (drop key), §4; 07 §5.4 (signature format).
// - The KeyStore builds the event itself: kind 27235 and the `domain` tag are fixed inside, so the
//   signer is never a general Nostr signer.
// - It signs with the separate drop key at the current epoch, never the Nostr or EVM identity key.
// - Only POST and DELETE; the body must be the drop's signed JSON and its `ts` must equal createdAt.
// - Everything else is refused with one fixed error that never contains an input (I-7).
import { afterEach, describe, expect, it } from 'vitest';
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
// W4-SHORT-INVITE (07 §5.4 `POST /v1/invite`): the body carries the ALI1 object (at most 17 441
// bytes, base64url), so this one path signs bodies up to the Worker's 24 KiB invite cap.
const URL_INVITE = 'https://drop.agentlink.4thtech.io/v1/invite';
const INVITE: DropAuthRequest = {
  method: 'POST',
  url: URL_INVITE,
  body: json({
    v: 1,
    lookupId: 'AAECAwQFBgcICQoLDA0ODw',
    expiresAt: TS + 86_400,
    object: 'A'.repeat(23_255),
    nonce: NONCE,
    ts: TS,
  }),
};
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

// test-vectors/drop-auth (M1-27a), copied here: the package's tests take no Node built-ins, and
// the harness runs the full suite in every runtime. A vector change fails these on purpose.
const VECTOR_EVENT_UPLOAD = {
  method: 'POST',
  url: 'https://drop.agentlink.4thtech.io/v1/upload',
  body: '7b2276223a312c2273697a65223a32303030302c22657870697265734174223a313739303038363430302c226e6f6e6365223a2249516d5951782d6b366f4b465734714a777374484677222c227473223a313739303030303030307d',
  createdAt: 1790000000,
  pubkey: '5aa35e889ea5fbffde7aa19195ad0dd4d7f33e6f86304732d8006f764f13ed6c',
  payload: 'f9393fe37b0a32977d670db149d551f7808dd5ae8029f02f26838d0b6dc3528b',
  eventId: '3439499b79920745bf0c167eada44eff1389d5c2f48886856d5c478cab615379',
} as const;
/** The requests of the accepting `verify` vectors, with their created_at and the verifier's now. */
const VECTOR_ACCEPTED = [
  {
    id: 'verify-accept',
    method: 'POST',
    url: 'https://drop.agentlink.4thtech.io/v1/upload',
    body: '7b2276223a312c2273697a65223a32303030302c22657870697265734174223a313739303038363430302c226e6f6e6365223a2249516d5951782d6b366f4b465734714a777374484677222c227473223a313739303030303030307d',
    ts: 1790000000,
    now: 1790000000,
  },
  {
    id: 'verify-accept-skew-edge',
    method: 'POST',
    url: 'https://drop.agentlink.4thtech.io/v1/upload',
    body: '7b2276223a312c2273697a65223a32303030302c22657870697265734174223a313739303038363430302c226e6f6e6365223a2249516d5951782d6b366f4b465734714a777374484677222c227473223a313739303030303030307d',
    ts: 1790000000,
    now: 1790000060,
  },
  {
    id: 'verify-accept-delete',
    method: 'DELETE',
    url: 'https://drop.agentlink.4thtech.io/v1/o/ZWOMpLAsUhfSBVsghbLRDw',
    body: '7b2276223a312c226f626a6563744964223a225a574f4d704c4173556866534256736768624c524477222c226e6f6e6365223a2276414e7069505f504d705874446966455f4a33663441222c227473223a313739303030303030307d',
    ts: 1790000000,
    now: 1790000000,
  },
] as const;

let store: KeyStore;
afterEach(async () => {
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
    const v = VECTOR_EVENT_UPLOAD;
    const request: DropAuthRequest = { method: v.method, url: v.url, body: decodeHex(v.body) };
    store = new MemoryKeyStore(SEED);
    const event = decode(await store.signDropRequest(request, v.createdAt));
    expect(event.tags[2]).toEqual(['payload', v.payload]);
    // The vector's own pubkey over the event this KeyStore built gives the vector's NIP-01 id.
    const unsigned = {
      kind: event.kind,
      created_at: event.created_at,
      tags: event.tags,
      content: '',
    };
    expect(nostrEventId(v.pubkey, unsigned)).toBe(v.eventId);
  });

  it('signs every request the accepting vectors carry, and the Worker verifier accepts it', async () => {
    store = new MemoryKeyStore(SEED);
    expect(VECTOR_ACCEPTED.map((c) => c.method)).toEqual(
      expect.arrayContaining(['POST', 'DELETE']),
    );
    for (const c of VECTOR_ACCEPTED) {
      const request: DropAuthRequest = { method: c.method, url: c.url, body: decodeHex(c.body) };
      const authorization = await store.signDropRequest(request, c.ts);
      expect(verifyDropAuthorization(authorization, request, c.now).ok, c.id).toBe(true);
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
    const raw = decode(signDropRequest(secret, UPLOAD, TS));
    expect({ ...raw, sig: helperSig }).toEqual({ ...helperRest, sig: helperSig });
  });
});

describe('KeyStore.signDropRequest: invite uploads (W4-SHORT-INVITE, 07 §5.4)', () => {
  it('signs a POST /v1/invite whose body carries the largest invite object', async () => {
    store = new MemoryKeyStore(SEED);
    expect(INVITE.body.length).toBeGreaterThan(1024);
    const authorization = await store.signDropRequest(INVITE, TS);
    expect(verifyDropAuthorization(authorization, INVITE, TS)).toEqual({
      ok: true,
      pubkey: dropHex(SEED),
      createdAt: TS,
    });
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
    [
      'URL over 512 characters (IR-M1-1g-e-1 L-1)',
      () => store.signDropRequest({ ...UPLOAD, url: `${URL_UPLOAD}?${'a'.repeat(512)}` }, TS),
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
    [
      'an invite body over the 24 KiB invite cap (W4-SHORT-INVITE)',
      () =>
        store.signDropRequest(
          { ...INVITE, body: json({ v: 1, nonce: NONCE, ts: TS, pad: 'x'.repeat(24 * 1024) }) },
          TS,
        ),
    ],
    [
      'a body over 1024 bytes on any other path, or a DELETE to /v1/invite',
      () =>
        store.signDropRequest(
          {
            method: 'DELETE',
            url: URL_INVITE,
            body: json({ v: 1, nonce: NONCE, ts: TS, pad: 'x'.repeat(2000) }),
          },
          TS,
        ),
    ],
    [
      'a large body on /v1/invite with a query',
      () => store.signDropRequest({ ...INVITE, url: `${URL_INVITE}?x=1` }, TS),
    ],
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

  // Nothing is logged: this package has no logger and its lint refuses console output; the
  // keychain backend's test (packages/node keychain.test.ts) also spies on the console.

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

// M1-1g-f (IR-M1-1g-e-1): a DELETE may name the retained epoch its object was uploaded under
// (04 §2.1: an object's locator records the epoch, so older objects stay deletable; 07 §5.4). The
// same cases run against the keychain KeyStore and its facade (packages/node keychain.test.ts).
describe('KeyStore.signDropRequest: the epoch of a DELETE (M1-1g-f, 04 §2.1)', () => {
  const PRESENCE = { kind: 'passphrase', secret: encodeUtf8('correct horse battery') } as const;

  /** A MemoryKeyStore at epoch 0, advanced once to epoch 1 through the owner's control. */
  async function advanced(): Promise<KeyStore> {
    const keys = new MemoryKeyStore(SEED);
    const owner = new MemoryOwnerKeyStore(OWNER_SEED, PRESENCE);
    await owner.epochControl(keys).advanceEpoch(0, await owner.unlock(PRESENCE));
    await owner.close();
    return keys;
  }

  it('after an advance, a DELETE with {epoch: n} verifies and carries the epoch-n drop key', async () => {
    store = await advanced();
    expect((await store.getPublicBundle()).keyEpoch).toBe(1);
    const old = await store.signDropRequest(DELETE, TS, { epoch: 0 });
    expect(verifyDropAuthorization(old, DELETE, TS)).toEqual({
      ok: true,
      pubkey: dropHex(SEED, 0),
      createdAt: TS,
    });
    const current = await store.signDropRequest(DELETE, TS, { epoch: 1 });
    expect(verifyDropAuthorization(current, DELETE, TS)).toEqual({
      ok: true,
      pubkey: dropHex(SEED, 1),
      createdAt: TS,
    });
  });

  it('without an epoch (or with epoch undefined) it signs with the current epoch', async () => {
    store = await advanced();
    expect(decode(await store.signDropRequest(DELETE, TS)).pubkey).toBe(dropHex(SEED, 1));
    expect(decode(await store.signDropRequest(UPLOAD, TS, {})).pubkey).toBe(dropHex(SEED, 1));
    expect(
      decode(await store.signDropRequest(UPLOAD, TS, { epoch: undefined } as never)).pubkey,
    ).toBe(dropHex(SEED, 1));
  });

  const refusedVariants: [string, () => Promise<unknown>][] = [
    ['a POST with an older epoch', () => store.signDropRequest(UPLOAD, TS, { epoch: 0 })],
    ['a POST with the current epoch', () => store.signDropRequest(UPLOAD, TS, { epoch: 1 })],
    [
      'a POST with an epoch above the current one',
      () => store.signDropRequest(UPLOAD, TS, { epoch: 2 }),
    ],
    ['a negative epoch', () => store.signDropRequest(DELETE, TS, { epoch: -1 })],
    ['a fractional epoch', () => store.signDropRequest(DELETE, TS, { epoch: 0.5 })],
    ['a NaN epoch', () => store.signDropRequest(DELETE, TS, { epoch: Number.NaN })],
    ['an epoch above 2^32 - 1', () => store.signDropRequest(DELETE, TS, { epoch: 2 ** 32 })],
    ['an epoch as text', () => store.signDropRequest(DELETE, TS, { epoch: '0' as never })],
    ['null options', () => store.signDropRequest(DELETE, TS, null as never)],
    ['options that are not an object', () => store.signDropRequest(DELETE, TS, 0 as never)],
    [
      'options with another key',
      () => store.signDropRequest(DELETE, TS, { epoch: 0, label: 'x' } as never),
    ],
  ];

  for (const [name, call] of refusedVariants) {
    it(`refuses ${name} with the one fixed error, before any key is read`, async () => {
      store = await advanced();
      // A closed store fails with keystore_closed as soon as it touches its seed, so the fixed
      // refusal shows the request was refused before that.
      await store.close();
      expectRefused(await refusal(call));
    });
  }

  it('refuses a DELETE epoch above the current one with epoch_unavailable, before any key is read', async () => {
    store = await advanced();
    for (const epoch of [2, 3, 2 ** 32 - 1]) {
      const error = await refusal(() => store.signDropRequest(DELETE, TS, { epoch }));
      expect(error).toBeInstanceOf(KeyStoreError);
      expect((error as KeyStoreError).code).toBe('epoch_unavailable');
    }
    await store.close();
    const error = await refusal(() => store.signDropRequest(DELETE, TS, { epoch: 2 }));
    expect(error).toBeInstanceOf(KeyStoreError);
    expect((error as KeyStoreError).code).toBe('epoch_unavailable');
  });

  it('reads the epoch once and signs with that value (no swap after the check)', async () => {
    store = await advanced();
    let reads = 0;
    const options = {
      get epoch(): number {
        reads += 1;
        return reads === 1 ? 0 : 7;
      },
    };
    const authorization = await store.signDropRequest(DELETE, TS, options);
    expect(reads).toBe(1);
    expect(decode(authorization).pubkey).toBe(dropHex(SEED, 0));
  });
});
