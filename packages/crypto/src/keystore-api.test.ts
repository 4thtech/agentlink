// Type-level contract of the KeyStore interfaces (M1-1g acceptance: "no interface method returns
// private key or seed bytes"; 04 §2.5: owner operations need a presence proof). Checked by
// `tsc -p tsconfig.test.json` (pnpm typecheck) and by Vitest's expectTypeOf.
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { PublicIdentity } from './keys.js';
import {
  KeyStoreError,
  type KeyStore,
  type OwnerKeyStore,
  type OwnerPresence,
  type OwnerPublicKeys,
  type OwnerSession,
} from './keystore-api.js';
import type { NostrEvent } from './nostr-event.js';

type Fn = (...args: never[]) => unknown;
type MethodNames<T> = { [K in keyof T]-?: T[K] extends Fn ? K : never }[keyof T];
type Result<T, K extends keyof T> = T[K] extends Fn ? Awaited<ReturnType<T[K]>> : never;

/** Methods whose result could be raw bytes (Uint8Array, or a supertype such as unknown). */
type BytesReturning<T> = {
  [K in MethodNames<T>]: Uint8Array extends Result<T, K> ? K : never;
}[MethodNames<T>];

/** Every result type of every method, as one union. */
type AllResults<T> = { [K in MethodNames<T>]: Result<T, K> }[MethodNames<T>];

describe('KeyStore (type level)', () => {
  it('only hpkeOpen returns bytes: the unwrapped content key, never a private key or seed', () => {
    expectTypeOf<BytesReturning<KeyStore>>().toEqualTypeOf<'hpkeOpen'>();
  });

  it('every other result is public: identity, signed event, hex or base64 text, or nothing', () => {
    expectTypeOf<Exclude<AllResults<KeyStore>, Uint8Array>>().toEqualTypeOf<
      PublicIdentity | NostrEvent | string | void
    >();
    expectTypeOf<keyof PublicIdentity>().toEqualTypeOf<
      'agentId' | 'agentEvm' | 'agentNostr' | 'agentEnc' | 'kid' | 'keyEpoch'
    >();
  });

  it('has exactly the 03 §3 methods plus the G-2 additions', () => {
    expectTypeOf<MethodNames<KeyStore>>().toEqualTypeOf<
      | 'getPublicBundle'
      | 'signNostr'
      | 'signEnvelopeHash'
      | 'nip44Encrypt'
      | 'nip44Decrypt'
      | 'sign712'
      | 'hpkeOpen'
      | 'close'
    >();
  });
});

describe('OwnerKeyStore (type level)', () => {
  it('returns no bytes from any method, its sessions included', () => {
    expectTypeOf<BytesReturning<OwnerKeyStore>>().toEqualTypeOf<never>();
    // hpkeOpen under the owner key returns a CEK, as on the KeyStore; never a key or seed.
    expectTypeOf<BytesReturning<OwnerSession>>().toEqualTypeOf<'hpkeOpen'>();
    expectTypeOf<keyof OwnerPublicKeys>().toEqualTypeOf<'ownerEvm' | 'ownerNostr' | 'ownerEnc'>();
  });

  it('has no signing method: signatures come only from a session', () => {
    expectTypeOf<MethodNames<OwnerKeyStore>>().toEqualTypeOf<
      'getPublicKeys' | 'unlock' | 'lock' | 'close'
    >();
    expectTypeOf<Result<OwnerKeyStore, 'unlock'>>().toEqualTypeOf<OwnerSession>();
  });

  it('cannot be unlocked without a presence proof', () => {
    expectTypeOf<Parameters<OwnerKeyStore['unlock']>[0]>().toEqualTypeOf<OwnerPresence>();
    expectTypeOf<undefined>().not.toExtend<OwnerPresence>();
    expectTypeOf<null>().not.toExtend<OwnerPresence>();
    const unlockWithout = (store: OwnerKeyStore) =>
      // @ts-expect-error: unlock requires an OwnerPresence argument.
      store.unlock();
    expect(typeof unlockWithout).toBe('function');
  });

  it('a session has the owner signatures and the owner-channel operations (M-1, G-2)', () => {
    expectTypeOf<MethodNames<OwnerSession>>().toEqualTypeOf<
      | 'isActive'
      | 'signOwnerAction'
      | 'sign712'
      | 'signEnvelopeHash'
      | 'signNostr'
      | 'nip44Decrypt'
      | 'hpkeOpen'
      | 'close'
    >();
  });

  it('accepts only the two presence kinds of 04 §2.5', () => {
    expectTypeOf<OwnerPresence['kind']>().toEqualTypeOf<'passphrase' | 'passkey-prf'>();
  });
});

describe('KeyStoreError', () => {
  it('carries a stable code and a fixed message', () => {
    const error = new KeyStoreError('keystore_closed', 'keystore: the store is closed');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('KeyStoreError');
    expect(error.code).toBe('keystore_closed');
  });
});
