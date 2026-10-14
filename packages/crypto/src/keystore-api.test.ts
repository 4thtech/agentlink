// Type-level contract of the KeyStore interfaces (M1-1g acceptance: "no interface method returns
// private key or seed bytes"; 04 §2.5: owner operations need a presence proof). Checked by
// `tsc -p tsconfig.test.json` (pnpm typecheck) and by Vitest's expectTypeOf.
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { TypedData } from './eip712.js';
import type { JsonObject } from './jcs.js';
import type { PublicIdentity } from './keys.js';
import {
  KeyStoreError,
  type EnvelopeKeys,
  type KeyStoreErrorCode,
  type EpochOptions,
  type KeyEpochControl,
  type KeyStore,
  type OwnerKeyStore,
  type OwnerPresence,
  type OwnerPublicKeys,
  type OwnerSession,
} from './keystore-api.js';
import type { WrappedCek } from './hpke.js';
import type { NostrEvent, UnsignedNostrEvent } from './nostr-event.js';

type Fn = (...args: never[]) => unknown;
type MethodNames<T> = { [K in keyof T]-?: T[K] extends Fn ? K : never }[keyof T];
type Result<T, K extends keyof T> = T[K] extends Fn ? Awaited<ReturnType<T[K]>> : never;
type Params<T, K extends keyof T> = T[K] extends (...args: infer A) => unknown ? A : never;

/** Methods whose result could be raw bytes (Uint8Array, or a supertype such as unknown). */
type BytesReturning<T> = {
  [K in MethodNames<T>]: Uint8Array extends Result<T, K> ? K : never;
}[MethodNames<T>];

/** Every result type of every method, as one union. */
type AllResults<T> = { [K in MethodNames<T>]: Result<T, K> }[MethodNames<T>];

/** True for an object parameter with a named (not index-signature) `epoch` key. */
type HasEpoch<P> = P extends object
  ? string extends keyof P
    ? never
    : 'epoch' extends keyof P
      ? true
      : never
  : never;

/** Methods that take an epoch in any parameter (G-2: only lookups and decryption may). */
type EpochTaking<T> = {
  [K in MethodNames<T>]: true extends HasEpoch<Params<T, K>[number]> ? K : never;
}[MethodNames<T>];

type EnvelopeKeyName =
  'signEnvelopeHash' | 'signNostr' | 'nip44Encrypt' | 'nip44Decrypt' | 'unwrapCek';

describe('EnvelopeKeys (type level, G-2: 03 §3, 04 §3.1.1)', () => {
  it('has exactly the methods that build and open envelopes', () => {
    expectTypeOf<MethodNames<EnvelopeKeys>>().toEqualTypeOf<EnvelopeKeyName>();
  });

  it('is implemented by KeyStore and by OwnerSession', () => {
    expectTypeOf<KeyStore>().toExtend<EnvelopeKeys>();
    expectTypeOf<OwnerSession>().toExtend<EnvelopeKeys>();
  });

  it('only unwrapCek returns bytes: the CEK, never a private key or seed', () => {
    expectTypeOf<BytesReturning<EnvelopeKeys>>().toEqualTypeOf<'unwrapCek'>();
  });

  it('signing methods take no epoch; only nip44Decrypt and unwrapCek do (IR-M1-1c-1 F5)', () => {
    expectTypeOf<EpochTaking<EnvelopeKeys>>().toEqualTypeOf<'nip44Decrypt' | 'unwrapCek'>();
    expectTypeOf<Params<EnvelopeKeys, 'signEnvelopeHash'>>().toEqualTypeOf<[Uint8Array]>();
    expectTypeOf<Params<EnvelopeKeys, 'signNostr'>>().toEqualTypeOf<[UnsignedNostrEvent]>();
    expectTypeOf<Params<EnvelopeKeys, 'nip44Encrypt'>>().toEqualTypeOf<[string, string]>();
    expectTypeOf<Params<EnvelopeKeys, 'nip44Decrypt'>>().toEqualTypeOf<
      [string, string, (EpochOptions | undefined)?]
    >();
  });

  it('unwrapCek takes the envelope id, never an HPKE info (no general HPKE-open oracle)', () => {
    expectTypeOf<Params<EnvelopeKeys, 'unwrapCek'>>().toEqualTypeOf<
      [WrappedCek, Uint8Array, (EpochOptions | undefined)?]
    >();
    expectTypeOf<keyof WrappedCek>().toEqualTypeOf<'enc' | 'wk'>();
    expectTypeOf<keyof EpochOptions>().toEqualTypeOf<'epoch'>();
  });
});

describe('KeyStore (type level)', () => {
  it('only unwrapCek returns bytes: the unwrapped content key, never a private key or seed', () => {
    expectTypeOf<BytesReturning<KeyStore>>().toEqualTypeOf<'unwrapCek'>();
  });

  it('every other result is public: identity, signed event, hex or base64 text, or nothing', () => {
    expectTypeOf<Exclude<AllResults<KeyStore>, Uint8Array>>().toEqualTypeOf<
      PublicIdentity | NostrEvent | string | void
    >();
    expectTypeOf<keyof PublicIdentity>().toEqualTypeOf<
      'agentId' | 'agentEvm' | 'agentNostr' | 'agentEnc' | 'kid' | 'keyEpoch'
    >();
  });

  it('has exactly EnvelopeKeys plus getPublicBundle, sign712 and close (G-2); no hpkeOpen', () => {
    expectTypeOf<MethodNames<KeyStore>>().toEqualTypeOf<
      EnvelopeKeyName | 'getPublicBundle' | 'sign712' | 'close'
    >();
    expectTypeOf<'hpkeOpen'>().not.toExtend<keyof KeyStore>();
  });

  it('takes an epoch only on the decrypting methods and the public-key lookup', () => {
    expectTypeOf<EpochTaking<KeyStore>>().toEqualTypeOf<
      'getPublicBundle' | 'nip44Decrypt' | 'unwrapCek'
    >();
    expectTypeOf<Params<KeyStore, 'getPublicBundle'>>().toEqualTypeOf<
      [(EpochOptions | undefined)?]
    >();
    expectTypeOf<Params<KeyStore, 'sign712'>>().toEqualTypeOf<[TypedData]>();
  });
});

describe('KeyEpochControl (type level, M1-1g-d: the owner-only epoch advance)', () => {
  it('is not on the KeyStore the agent path uses', () => {
    expectTypeOf<'advanceEpoch'>().not.toExtend<keyof KeyStore>();
    expectTypeOf<'previewEpoch'>().not.toExtend<keyof KeyStore>();
    expectTypeOf<'advanceEpoch'>().not.toExtend<keyof EnvelopeKeys>();
  });

  it('has exactly previewEpoch and advanceEpoch, and returns public keys only', () => {
    expectTypeOf<MethodNames<KeyEpochControl>>().toEqualTypeOf<'previewEpoch' | 'advanceEpoch'>();
    expectTypeOf<BytesReturning<KeyEpochControl>>().toEqualTypeOf<never>();
    expectTypeOf<Result<KeyEpochControl, 'previewEpoch'>>().toEqualTypeOf<PublicIdentity>();
    expectTypeOf<Result<KeyEpochControl, 'advanceEpoch'>>().toEqualTypeOf<PublicIdentity>();
  });

  it('advanceEpoch is a compare-and-set that needs an OwnerSession (I-4)', () => {
    expectTypeOf<Params<KeyEpochControl, 'advanceEpoch'>>().toEqualTypeOf<[number, OwnerSession]>();
    expectTypeOf<Params<KeyEpochControl, 'previewEpoch'>>().toEqualTypeOf<[number]>();
    const advanceWithout = (control: KeyEpochControl) =>
      // @ts-expect-error: advanceEpoch requires an OwnerSession.
      control.advanceEpoch(0);
    expect(typeof advanceWithout).toBe('function');
  });

  it('refuses a stale compare-and-set with its own code', () => {
    expectTypeOf<'epoch_conflict'>().toExtend<KeyStoreErrorCode>();
  });
});

describe('OwnerKeyStore (type level)', () => {
  it('returns no bytes from any method; a session returns only the CEK', () => {
    expectTypeOf<BytesReturning<OwnerKeyStore>>().toEqualTypeOf<never>();
    // unwrapCek under the owner key returns a CEK, as on the KeyStore; never a key or seed.
    expectTypeOf<BytesReturning<OwnerSession>>().toEqualTypeOf<'unwrapCek'>();
    expectTypeOf<Exclude<AllResults<OwnerSession>, Uint8Array>>().toEqualTypeOf<
      NostrEvent | string | boolean | void
    >();
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

  it('a session is EnvelopeKeys plus the owner signatures (G-2, IR-M1-1g-1 M-1); no hpkeOpen', () => {
    expectTypeOf<MethodNames<OwnerSession>>().toEqualTypeOf<
      EnvelopeKeyName | 'isActive' | 'signOwnerAction' | 'sign712' | 'close'
    >();
    expectTypeOf<'hpkeOpen'>().not.toExtend<keyof OwnerSession>();
    expectTypeOf<Params<OwnerSession, 'signOwnerAction'>>().toEqualTypeOf<[JsonObject]>();
    expectTypeOf<Params<OwnerSession, 'sign712'>>().toEqualTypeOf<[TypedData]>();
  });

  it('a session signs with no epoch; it decrypts with epoch 0 only (checked at run time)', () => {
    expectTypeOf<EpochTaking<OwnerSession>>().toEqualTypeOf<'nip44Decrypt' | 'unwrapCek'>();
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

  it('separates a capability refusal from an input error and from a missing implementation', () => {
    expectTypeOf<'operation_not_allowed'>().toExtend<KeyStoreErrorCode>();
    expectTypeOf<'unsupported_operation'>().toExtend<KeyStoreErrorCode>();
    expect(new KeyStoreError('operation_not_allowed', 'x').code).toBe('operation_not_allowed');
  });
});
