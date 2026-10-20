// Test doubles for owner actions and the policy-version mark (M1-7d). Not part of the build
// (tsconfig.json excludes src/testing).
import {
  encodeBase64url,
  encodeHex,
  randomBytes,
  type JsonObject,
  type OwnerKeyStore,
} from '@4thtech-io/crypto';
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
