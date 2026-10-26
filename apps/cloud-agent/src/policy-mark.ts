// M2-3a: where the policy-version mark lives on the cloud (04 §2.2, §2.5.1; 08 §3.1; proposed, owner
// confirms at merge). Locally it is a keychain item next to the seed, so that rolling back the store
// file alone cannot lower it. On the cloud it is the agent item `policy-version` in the Durable
// Object (cloud-schema.ts), next to the sealed seed: the object has no other storage. The value is the
// same canonical ASCII decimal as the keychain item; a malformed value throws and is never read as 0,
// so the core fails closed (M1-7d). `raise` reads, compares, writes and reads back in one
// `transactionSync`, and the object is single threaded, so nothing lowers it.
//
// Residual (stated in the PR): the mark shares the object's storage with the store, so a restore of
// the whole object (Durable Object point-in-time recovery, which only the Cloudflare account can
// run) rolls both back together. That account is the user's own (D-131); a same-user process on a
// computer (G-1) has no equivalent here, because the chat app only reaches MCP tools.
import type { PolicyVersionMark } from '@4thtech-io/core';
import type { DurableObjectStore } from './do-store.js';
import { CloudAgentError } from './errors.js';

/** `0`, or a non-zero digit and at most 15 more (04 §2.2). */
const CANONICAL = /^(?:0|[1-9][0-9]{0,15})$/;

function decode(value: string | null): number {
  if (value === null) return 0;
  if (!CANONICAL.test(value)) throw new CloudAgentError('mark_malformed');
  const version = Number(value);
  if (!Number.isSafeInteger(version)) throw new CloudAgentError('mark_malformed');
  return version;
}

/** The mark over the object's `policy-version` item: exactly `read` and `raise`. */
export function durableObjectPolicyMark(store: DurableObjectStore): PolicyVersionMark {
  return Object.freeze({
    read: (): Promise<number> => {
      try {
        return Promise.resolve(decode(store.readItem('policy-version')));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    raise: (version: number): Promise<number> => {
      try {
        if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
          throw new RangeError('The policy version must be a whole number from 0 to 2^53 - 1.');
        }
        const stored = store.updateItem('policy-version', (current) =>
          decode(current) >= version ? undefined : String(version),
        );
        return Promise.resolve(decode(stored));
      } catch (error) {
        return Promise.reject(error);
      }
    },
  });
}
