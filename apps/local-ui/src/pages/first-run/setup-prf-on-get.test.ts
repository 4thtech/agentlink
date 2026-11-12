// @vitest-environment jsdom
// M1-11s-c-c (F48; 04 §2.3.1, §2.5; 08 §1): owner setup with an authenticator that answers create()
// with `prf.enabled` only (Windows Hello, some iCloud Keychain paths). The page asks at once for the
// second gesture: get() for the new credential only, user verification required, the same PRF salt
// and the begin's challenge. It sends the get() PRF output with the assertion (credential ID,
// authenticator data, clientDataJSON, signature) after the creation fields, so the server can check
// the gesture and store the passkey. Without a PRF output from get() either, nothing more is sent:
// the master code stays the way to approve.
import { afterEach, describe, expect, it } from 'vitest';
import { createSetupPasskey } from './passkey.js';
import type { CreationValues } from './setup-api.js';

class FakeCredential {
  constructor(
    readonly rawId: ArrayBuffer,
    readonly response: unknown,
    private readonly ext: unknown,
  ) {}
  getClientExtensionResults(): unknown {
    return this.ext;
  }
}

const saved = {
  pkc: (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential,
  credentials: Object.getOwnPropertyDescriptor(navigator, 'credentials'),
};
afterEach(() => {
  (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = saved.pkc;
  if (saved.credentials) Object.defineProperty(navigator, 'credentials', saved.credentials);
  else Reflect.deleteProperty(navigator, 'credentials');
});

const fieldsOf = (body: Uint8Array): number[][] => {
  const out: number[][] = [];
  let at = 0;
  while (at < body.length) {
    const n = ((body[at] as number) << 8) | (body[at + 1] as number);
    out.push([...body.subarray(at + 2, at + 2 + n)]);
    at += 2 + n;
  }
  return out;
};

const VALUES: CreationValues = {
  rpId: 'localhost',
  rpName: 'AgentLink',
  userId: 'AQID',
  userName: 'AgentLink owner',
  challenge: 'BAUG',
  prfSalt: 'BwgJ',
};

const RAW_ID = [1, 2];
const CREATE_AUTH = new Uint8Array(80).fill(3);
const CREATE_CLIENT = new Uint8Array([123, 49, 125]);
const GET_AUTH = new Uint8Array(37).fill(4);
const GET_CLIENT = new Uint8Array([123, 50, 125]);
const SIGNATURE = new Uint8Array(70).fill(6);

interface Asked {
  creates: number;
  gets: CredentialRequestOptions[];
}

function install(createExt: unknown, getExt: unknown): Asked {
  (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = FakeCredential;
  const asked: Asked = { creates: 0, gets: [] };
  Object.defineProperty(navigator, 'credentials', {
    configurable: true,
    value: {
      create: () => {
        asked.creates += 1;
        return Promise.resolve(
          new FakeCredential(
            new Uint8Array(RAW_ID).buffer,
            {
              getAuthenticatorData: () => CREATE_AUTH.buffer.slice(0),
              clientDataJSON: CREATE_CLIENT.buffer.slice(0),
            },
            createExt,
          ),
        );
      },
      get: (options: CredentialRequestOptions) => {
        asked.gets.push(options);
        return Promise.resolve(
          new FakeCredential(
            new Uint8Array(RAW_ID).buffer,
            {
              authenticatorData: GET_AUTH.buffer.slice(0),
              clientDataJSON: GET_CLIENT.buffer.slice(0),
              signature: SIGNATURE.buffer.slice(0),
              userHandle: new Uint8Array([1, 2, 3]).buffer,
            },
            getExt,
          ),
        );
      },
    },
  });
  return asked;
}

describe('owner setup: PRF only on get() (M1-11s-c-c, F48)', () => {
  it('asks get() for the new credential with UV required, the same salt and the begin challenge, and sends its PRF output and assertion', async () => {
    const asked = install(
      { prf: { enabled: true } },
      { prf: { results: { first: new Uint8Array(32).fill(5).buffer } } },
    );
    const made = await createSetupPasskey(VALUES, { platform: true });
    expect(asked.creates).toBe(1);
    expect(asked.gets).toHaveLength(1);
    const options = asked.gets[0]?.publicKey as PublicKeyCredentialRequestOptions;
    expect(options.rpId).toBe('localhost');
    expect(options.userVerification).toBe('required');
    expect([...new Uint8Array(options.challenge as Uint8Array)]).toEqual([4, 5, 6]);
    expect(options.allowCredentials).toHaveLength(1);
    expect(options.allowCredentials?.[0]?.type).toBe('public-key');
    expect([...new Uint8Array(options.allowCredentials?.[0]?.id as Uint8Array)]).toEqual(RAW_ID);
    const prf = (options.extensions as { prf?: { eval?: { first?: Uint8Array } } }).prf;
    expect([...new Uint8Array(prf?.eval?.first as Uint8Array)]).toEqual([7, 8, 9]);
    expect(made.kind).toBe('ok');
    if (made.kind !== 'ok') return;
    expect(fieldsOf(made.body)).toEqual([
      RAW_ID,
      [...CREATE_AUTH],
      [...CREATE_CLIENT],
      new Array(32).fill(5),
      RAW_ID,
      [...GET_AUTH],
      [...GET_CLIENT],
      [...SIGNATURE],
    ]);
  });

  it('get() without a PRF output either: the creation alone is sent (master code only)', async () => {
    const asked = install({ prf: { enabled: true } }, { prf: {} });
    const made = await createSetupPasskey(VALUES, { platform: true });
    expect(asked.gets).toHaveLength(1);
    expect(made.kind).toBe('ok');
    if (made.kind !== 'ok') return;
    expect(fieldsOf(made.body)).toEqual([RAW_ID, [...CREATE_AUTH], [...CREATE_CLIENT], []]);
  });

  it('no PRF at all (prf.enabled not true): no second gesture', async () => {
    const asked = install({ prf: { enabled: false } }, {});
    const made = await createSetupPasskey(VALUES, { platform: false });
    expect(asked.gets).toHaveLength(0);
    expect(made.kind).toBe('ok');
    if (made.kind !== 'ok') return;
    expect(fieldsOf(made.body)).toEqual([RAW_ID, [...CREATE_AUTH], [...CREATE_CLIENT], []]);
  });

  it('PRF on create(): one gesture, four fields, as before', async () => {
    const asked = install(
      { prf: { enabled: true, results: { first: new Uint8Array(32).fill(5).buffer } } },
      {},
    );
    const made = await createSetupPasskey(VALUES, { platform: true });
    expect(asked.gets).toHaveLength(0);
    if (made.kind !== 'ok') throw new Error('not ok');
    expect(fieldsOf(made.body)).toEqual([
      RAW_ID,
      [...CREATE_AUTH],
      [...CREATE_CLIENT],
      new Array(32).fill(5),
    ]);
  });

  it('the second gesture cancelled: cancelled, nothing sent', async () => {
    install({ prf: { enabled: true } }, {});
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: {
        create: (navigator.credentials as { create: unknown }).create,
        get: () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })),
      },
    });
    const made = await createSetupPasskey(VALUES, { platform: true });
    expect(made.kind).toBe('cancelled');
  });
});
