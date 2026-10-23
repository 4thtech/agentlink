// Test doubles for owner actions, the policy-version mark (M1-7d) and the own-storage items
// (M1-9i-a). Not part of the build (tsconfig.json excludes src/testing).
import {
  credentialDigest,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  randomBytes,
  type JsonObject,
  type OwnerKeyStore,
  type StorageCredentialItemFields,
} from '@4thtech-io/crypto';
import { encodeStorageMark, type OwnStorageKeys } from '../own-storage.js';
import type { PolicyVersionMark } from '../owner-actions.js';
import { passphrase } from './fixtures.js';

/**
 * A PolicyVersionMark in memory. The real mark is a KeyStore item (04 §2.5.1, §2.2, §2.8) that the
 * Node backends implement; this one records calls and can be made to fail.
 */
export class MemoryPolicyMark implements PolicyVersionMark {
  value = 0;
  failRead = false;
  failRaise = false;
  raises: number[] = [];

  read(): Promise<number> {
    if (this.failRead) return Promise.reject(new Error('mark unreadable'));
    return Promise.resolve(this.value);
  }

  raise(version: number): Promise<number> {
    if (this.failRaise) return Promise.reject(new Error('mark not written'));
    this.raises.push(version);
    this.value = Math.max(this.value, version);
    return Promise.resolve(this.value);
  }
}

/**
 * The receipts-kept marker in memory (04 §2.2, 06 §3, D-109; M1-33a): the version at which the owner
 * kept delivery receipts on, or null. The real one is a KeyStore item next to the policy mark.
 */
export class MemoryReceiptsKept {
  value: number | null = null;
  failRead = false;
  failWrite = false;
  writes: number[] = [];

  read(): Promise<number | null> {
    if (this.failRead) return Promise.reject(new Error('marker unreadable'));
    return Promise.resolve(this.value);
  }

  write(version: number): Promise<void> {
    if (this.failWrite) return Promise.reject(new Error('marker not written'));
    this.writes.push(version);
    this.value = version;
    return Promise.resolve();
  }
}

export const newNonce = (): string => encodeBase64url(randomBytes(16));
export const newApprovalId = (): string => `apr_${encodeBase64url(randomBytes(16))}`;

/** The owner's Nostr key as `owner` spells it (64 lowercase hex, no prefix). */
export async function ownerHex(owner: OwnerKeyStore): Promise<string> {
  return encodeHex((await owner.getPublicKeys()).ownerNostr);
}

export interface Signed {
  readonly body: JsonObject;
  readonly sig: string;
}

/** Signs `body` with a fresh owner session (one presence entry, one owner operation; 04 §2.5). */
export async function signWith(owner: OwnerKeyStore, body: JsonObject): Promise<Signed> {
  const session = await owner.unlock(passphrase());
  try {
    return { body, sig: await session.signOwnerAction(body) };
  } finally {
    await session.close();
  }
}

/**
 * A recognisable S3 secret: it must never reach a log line, a row or an error (I-7). Built from
 * fragments at run time so that no source literal looks like a secret to the secret scan; the
 * value the tests search for is exactly this joined string.
 */
export const S3_CANARY = ['canary', 's3', 'value', 'c0ffee'].join('-');

/**
 * The own-storage KeyStore items in memory (04 §2.2: `storage-mark` and `s3:<id>`; M1-9i-a). The
 * real ones are KeyStore items the Node backends implement (M1-9i-c); this one keeps the item bytes,
 * records the mark writes and can be made to fail. `connect` writes an `s3:<id>` item as the
 * StorageCredentialControl would and returns its credentialDigest.
 */
export class MemoryOwnStorageKeys implements OwnStorageKeys {
  mark: Uint8Array | null = null;
  /** The `s3:<id>` items, as their fields (the real item is their canonical JCS bytes). */
  readonly items = new Map<string, StorageCredentialItemFields>();
  failRead = false;
  failWrite = false;
  failDigest = false;
  readonly writes: (string | null)[] = [];

  readMark(): Promise<Uint8Array | null> {
    if (this.failRead) return Promise.reject(new Error('mark unreadable'));
    return Promise.resolve(this.mark === null ? null : this.mark.slice());
  }

  writeMark(active: string | null): Promise<void> {
    if (this.failWrite) return Promise.reject(new Error('mark not written'));
    this.writes.push(active);
    this.mark = encodeStorageMark(active);
    return Promise.resolve();
  }

  credentialDigest(id: string): Promise<string | null> {
    if (this.failDigest) return Promise.reject(new Error('item unreadable'));
    const item = this.items.get(id);
    if (item === undefined) return Promise.resolve(null);
    return Promise.resolve(credentialDigest(item));
  }

  connect(id: string, accessKeyId = 'AKIATESTKEY', secretAccessKey = S3_CANARY): string {
    const item: StorageCredentialItemFields = {
      accessKeyId: encodeUtf8(accessKeyId),
      secretAccessKey: encodeUtf8(secretAccessKey),
      salt: randomBytes(16),
    };
    this.items.set(id, item);
    return credentialDigest(item);
  }
}
