// @vitest-environment jsdom
// M1-PAY-CONFIRM-b (#581 audit Medium): where the authenticator evaluates PRF only when the passkey
// is used, the upgrade takes one more gesture, and that get() carries no credential public key. The
// body then carries the create() authenticator data as a fifth field, so the server can keep the key
// for paid actions (04 §2.5.3 rule 5) instead of leaving the owner on the backup code.
import { afterEach, describe, expect, it } from 'vitest';
import { createUpgradePasskey } from './passkey.js';

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

describe('PRF only on use: the create() data goes along (M1-PAY-CONFIRM-b)', () => {
  it('sends credential ID, get() data, user handle, PRF output, then the create() data', async () => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = FakeCredential;
    const creation = new Uint8Array(80).fill(3);
    let gets = 0;
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: {
        create: () =>
          Promise.resolve(
            new FakeCredential(
              new Uint8Array([1, 2]).buffer,
              { getAuthenticatorData: () => creation.buffer.slice(0) },
              { prf: { enabled: true } },
            ),
          ),
        get: () => {
          gets += 1;
          return Promise.resolve(
            new FakeCredential(
              new Uint8Array([1, 2]).buffer,
              {
                authenticatorData: new Uint8Array(37).fill(4).buffer,
                userHandle: new Uint8Array([7]).buffer,
              },
              { prf: { results: { first: new Uint8Array(32).fill(5).buffer } } },
            ),
          );
        },
      },
    });
    const made = await createUpgradePasskey(
      { rpId: 'localhost', userId: 'Bw', prfSalt: 'BQY' } as never,
      { platform: false },
    );
    expect(gets).toBe(1);
    expect(made.kind).toBe('ok');
    if (made.kind !== 'ok') return;
    expect(fieldsOf(made.body)).toEqual([
      [1, 2],
      new Array(37).fill(4),
      [7],
      new Array(32).fill(5),
      new Array(80).fill(3),
    ]);
  });
});
