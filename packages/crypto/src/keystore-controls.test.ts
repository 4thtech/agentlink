// Type-level contract of the three owner-flow controls of M1-9i-b2 (04 §2.3.3 "Export: who sees the
// seeds", restore step 5; 04 §2.5.1 `storage.set`; D-115): KeyExportControl, KeyImportControl and
// StorageCredentialControl. Acceptance: no raw seed crosses the control interfaces. Checked by
// `tsc -p tsconfig.test.json` (pnpm typecheck) and by Vitest's expectTypeOf.
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { StorageCredential } from './credential-digest.js';
import type {
  DisplayCode,
  EnvelopeKeys,
  ImportAgentOptions,
  ImportedAgentKeys,
  KeyExportControl,
  KeyImportControl,
  KeyStore,
  KeyStoreErrorCode,
  OwnerKeyStore,
  OwnerSession,
  RecoveryKitExportAgent,
  RecoveryKitExportRequest,
  RecoveryKitImport,
  RecoveryKitImportAgent,
  StorageCredentialControl,
} from './keystore-api.js';
import type { RecoveryCodeSecret } from './owner-seed-wrap.js';
import type {
  OpenRecoveryKitOptions,
  OpenedRecoveryKit,
  OpenedRecoveryKitAgent,
  RecoveryKitContents,
  RecoveryKitSource,
  RecoveryKitStoreSink,
  RecoveryKitStoreSource,
} from './recovery-kit.js';

type Fn = (...args: never[]) => unknown;
type MethodNames<T> = { [K in keyof T]-?: T[K] extends Fn ? K : never }[keyof T];
type Result<T, K extends keyof T> = T[K] extends Fn ? Awaited<ReturnType<T[K]>> : never;
type Params<T, K extends keyof T> = T[K] extends (...args: infer A) => unknown ? A : never;

/**
 * Every property name reachable in T, through objects, arrays and function parameters and results
 * (bounded depth). Leaves (bytes, text, numbers) and an OwnerSession (checked in keystore-api.test.ts:
 * it returns no seed) stop the walk.
 */
type Depth = [never, 0, 1, 2, 3, 4, 5, 6];
type DeepKeys<T, D extends number = 6> = [D] extends [never]
  ? never
  : T extends Uint8Array | string | number | boolean | bigint | symbol | null | undefined
    ? never
    : T extends OwnerSession
      ? never
      : T extends (...args: infer A) => infer R
        ? DeepKeys<A[number], Depth[D]> | DeepKeys<Awaited<R>, Depth[D]>
        : T extends readonly (infer E)[]
          ? DeepKeys<E, Depth[D]>
          : T extends object
            ? {
                [K in keyof T & string]-?: K | DeepKeys<T[K], Depth[D]>;
              }[keyof T & string]
            : never;

/** A property name that would carry key material or a KeyStore item value. */
type SecretName =
  `${string}${'seed' | 'Seed' | 'item' | 'Item' | 'privateKey' | 'secretKey' | 'kek'}${string}`;

type ControlSurface = KeyExportControl | KeyImportControl | StorageCredentialControl;

describe('the controls carry no raw seed (M1-9i-b2 acceptance; 04 §2.3.3)', () => {
  it('no parameter or result of any control method names a seed, an item or a secret key', () => {
    expectTypeOf<Extract<DeepKeys<KeyExportControl>, SecretName>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<DeepKeys<KeyImportControl>, SecretName>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<DeepKeys<StorageCredentialControl>, SecretName>>().toEqualTypeOf<never>();
    // The walk is not vacuous: it reaches the import handle's agents and their sinks.
    expectTypeOf<'storeLength'>().toExtend<DeepKeys<KeyImportControl>>();
    expectTypeOf<'commit'>().toExtend<DeepKeys<KeyImportControl>>();
    expectTypeOf<'agentId'>().toExtend<DeepKeys<KeyExportControl>>();
    // ...and it would catch one: the opened kit of M1-9i-b holds the seeds.
    expectTypeOf<Extract<DeepKeys<OpenedRecoveryKit>, SecretName>>().toEqualTypeOf<
      'ownerSeed' | 'items'
    >();
  });

  it('the only bytes a control returns are display codes, never a plain Uint8Array', () => {
    expectTypeOf<Result<KeyExportControl, 'sealRecoveryKit'>>().toEqualTypeOf<DisplayCode>();
    expectTypeOf<Result<KeyImportControl, 'importOwner'>>().toEqualTypeOf<DisplayCode>();
    expectTypeOf<Result<KeyImportControl, 'importAgent'>>().toEqualTypeOf<ImportedAgentKeys>();
    expectTypeOf<keyof ImportedAgentKeys>().toEqualTypeOf<'unlockCode'>();
    expectTypeOf<ImportedAgentKeys['unlockCode']>().toEqualTypeOf<DisplayCode | undefined>();
    expectTypeOf<Result<StorageCredentialControl, 'writeCredential'>>().toEqualTypeOf<string>();
    expectTypeOf<Result<StorageCredentialControl, 'removeCredential'>>().toEqualTypeOf<void>();
    // A seed (plain bytes) cannot pose as a display code.
    expectTypeOf<Uint8Array>().not.toExtend<DisplayCode>();
    expectTypeOf<DisplayCode>().toExtend<Uint8Array>();
  });

  it('the opened kit of M1-9i-b, which holds the seeds, cannot pose as an import handle', () => {
    expectTypeOf<OpenedRecoveryKit>().not.toExtend<RecoveryKitImport>();
    // Its agents carry the items; the import handle's agents do not.
    expectTypeOf<'items'>().toExtend<keyof OpenedRecoveryKitAgent>();
    expectTypeOf<'items'>().not.toExtend<keyof RecoveryKitImportAgent>();
  });

  it('none of them is on the KeyStore, the OwnerKeyStore or a session (the agent path cannot reach them)', () => {
    type Owned = keyof KeyStore | keyof OwnerKeyStore | keyof OwnerSession | keyof EnvelopeKeys;
    expectTypeOf<Extract<MethodNames<ControlSurface>, Owned>>().toEqualTypeOf<never>();
    expectTypeOf<'sealRecoveryKit' | 'importAgent' | 'writeCredential'>().not.toExtend<Owned>();
  });
});

describe('KeyExportControl (04 §2.3.3 "Export: who sees the seeds")', () => {
  it('has the one method sealRecoveryKit(session, request), which needs an OwnerSession (I-4)', () => {
    expectTypeOf<MethodNames<KeyExportControl>>().toEqualTypeOf<'sealRecoveryKit'>();
    expectTypeOf<Params<KeyExportControl, 'sealRecoveryKit'>>().toEqualTypeOf<
      [OwnerSession, RecoveryKitExportRequest]
    >();
    const sealWithout = (control: KeyExportControl, request: RecoveryKitExportRequest) =>
      // @ts-expect-error: sealRecoveryKit requires an OwnerSession.
      control.sealRecoveryKit(request);
    expect(typeof sealWithout).toBe('function');
  });

  it('takes ids, names and snapshots; the backend reads the seeds and items itself', () => {
    expectTypeOf<keyof RecoveryKitExportRequest>().toEqualTypeOf<
      'kitId' | 'createdAt' | 'contents' | 'agents' | 'snapshots' | 'path'
    >();
    expectTypeOf<RecoveryKitExportRequest['contents']>().toEqualTypeOf<RecoveryKitContents>();
    expectTypeOf<RecoveryKitExportRequest['path']>().toEqualTypeOf<string>();
    expectTypeOf<keyof RecoveryKitExportAgent>().toEqualTypeOf<'agentId' | 'name'>();
    expectTypeOf<RecoveryKitExportAgent['agentId']>().toEqualTypeOf<string>();
    expectTypeOf<RecoveryKitExportAgent['name']>().toEqualTypeOf<string>();
    // Called by the backend under the agent's lock, after it read policy-version and receipts-kept.
    expectTypeOf<RecoveryKitExportRequest['snapshots']>().toEqualTypeOf<
      (agentId: string) => Promise<RecoveryKitStoreSource>
    >();
  });
});

describe('KeyImportControl (04 §2.3.3 restore steps 3, 5 and 6)', () => {
  it('opens a kit with the recovery code and imports agents and the owner from the handle only', () => {
    expectTypeOf<MethodNames<KeyImportControl>>().toEqualTypeOf<
      'openRecoveryKit' | 'importAgent' | 'importOwner'
    >();
    expectTypeOf<Params<KeyImportControl, 'openRecoveryKit'>>().toEqualTypeOf<
      [RecoveryKitSource, RecoveryCodeSecret, OpenRecoveryKitOptions]
    >();
    expectTypeOf<Result<KeyImportControl, 'openRecoveryKit'>>().toEqualTypeOf<RecoveryKitImport>();
    expectTypeOf<Params<KeyImportControl, 'importAgent'>>().toEqualTypeOf<
      [RecoveryKitImport, string, (ImportAgentOptions | undefined)?]
    >();
    expectTypeOf<keyof ImportAgentOptions>().toEqualTypeOf<'name'>();
    expectTypeOf<Params<KeyImportControl, 'importOwner'>>().toEqualTypeOf<[RecoveryKitImport]>();
  });

  it('the handle shows only public facts, the quarantined store sinks and wipe()', () => {
    expectTypeOf<Exclude<keyof RecoveryKitImport, symbol>>().toEqualTypeOf<
      'ownerNostr' | 'kitId' | 'createdAt' | 'contents' | 'agents' | 'wipe'
    >();
    expectTypeOf<MethodNames<RecoveryKitImport>>().toEqualTypeOf<'wipe'>();
    expectTypeOf<keyof RecoveryKitImportAgent>().toEqualTypeOf<
      'agentId' | 'name' | 'store' | 'storeLength'
    >();
    expectTypeOf<RecoveryKitImportAgent['store']>().toEqualTypeOf<RecoveryKitStoreSink>();
  });
});

describe('StorageCredentialControl (04 §2.5.1 storage.set, §2.2 s3:<id>)', () => {
  it('writes and removes an s3:<id> item with an OwnerSession, and returns only the digest', () => {
    expectTypeOf<MethodNames<StorageCredentialControl>>().toEqualTypeOf<
      'writeCredential' | 'removeCredential'
    >();
    expectTypeOf<Params<StorageCredentialControl, 'writeCredential'>>().toEqualTypeOf<
      [OwnerSession, string, StorageCredential]
    >();
    expectTypeOf<Params<StorageCredentialControl, 'removeCredential'>>().toEqualTypeOf<
      [OwnerSession, string]
    >();
    expectTypeOf<keyof StorageCredential>().toEqualTypeOf<'accessKeyId' | 'secretAccessKey'>();
    // The secret travels as bytes, never as a JS string (04 §2.2).
    expectTypeOf<StorageCredential['secretAccessKey']>().toEqualTypeOf<Uint8Array>();
    const writeWithout = (control: StorageCredentialControl, credential: StorageCredential) =>
      // @ts-expect-error: writeCredential requires an OwnerSession.
      control.writeCredential('0123456789abcdef', credential);
    expect(typeof writeWithout).toBe('function');
  });

  it('refuses to overwrite an existing item with its own code', () => {
    expectTypeOf<'item_exists'>().toExtend<KeyStoreErrorCode>();
  });
});
