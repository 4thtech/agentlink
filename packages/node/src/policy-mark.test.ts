// M1-8g: the policy-version mark as a keychain item (04 §2.2, §2.5.1; 07 §3.4), against an in-memory
// keychain double and the real inter-process lock (06 §6) on a temporary directory.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withInterProcessLock } from './inter-process-lock.js';
import { keychainAccount, type KeychainBackend } from './keychain.js';
import {
  MALFORMED_MARK_VALUES,
  ascii,
  describePolicyMarkContract,
  type MarkHarness,
} from './policy-mark.fixture.js';
import {
  POLICY_MARK_ITEM,
  decodePolicyVersion,
  encodePolicyVersion,
  keychainPolicyMark,
} from './policy-mark.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A keychain double that can fail, lose writes and delay them. */
class FaultyKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  fault: 'none' | 'read' | 'write' | 'lost-write' = 'none';
  delay: (account: string, value: Uint8Array) => number = () => 0;
  writes = 0;

  async get(account: string): Promise<Uint8Array | null> {
    await Promise.resolve();
    if (this.fault === 'read') throw new Error('native: keychain read failed');
    return this.items.get(account)?.slice() ?? null;
  }
  async set(account: string, value: Uint8Array): Promise<void> {
    const copy = value.slice();
    const ms = this.delay(account, copy);
    if (ms > 0) await sleep(ms);
    else await Promise.resolve();
    if (this.fault === 'write') throw new Error('native: keychain write failed');
    this.writes += 1;
    if (this.fault === 'lost-write') return;
    this.items.set(account, copy);
  }
  async delete(account: string): Promise<boolean> {
    await Promise.resolve();
    return this.items.delete(account);
  }
}

const AGENT = `0x${'ab'.repeat(20)}`;
const OTHER = `0x${'cd'.repeat(20)}`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-policy-mark-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function keychainHarness(): Promise<MarkHarness> {
  const keychain = new FaultyKeychain();
  const lockPath = join(dir, 'agent.sqlite.lock');
  const account = keychainAccount(AGENT, POLICY_MARK_ITEM);
  const withLock = <T>(fn: () => Promise<T> | T): Promise<T> => withInterProcessLock(lockPath, fn);
  return Promise.resolve({
    open: () => keychainPolicyMark(keychain, AGENT, withLock),
    raw: async () => keychain.items.get(account)?.slice() ?? null,
    plant: async (value) => {
      if (value === null) keychain.items.delete(account);
      else keychain.items.set(account, value.slice());
    },
    fault: (kind) => {
      keychain.fault = kind;
    },
    delayWrites: (delay) => {
      keychain.delay = (_account, value) => delay(value);
    },
    writes: () => keychain.writes,
    holdLock: async () => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held!: () => void;
      const acquired = new Promise<void>((resolve) => {
        held = resolve;
      });
      void withInterProcessLock(lockPath, async () => {
        held();
        await released;
      });
      await acquired;
      return release;
    },
    close: () => Promise.resolve(),
  });
}

describePolicyMarkContract('keychain item', keychainHarness);

describe('the policy-version value (04 §2.2, §2.8)', () => {
  it('encodes canonical ASCII decimal', () => {
    expect(encodePolicyVersion(0)).toEqual(ascii('0'));
    expect(encodePolicyVersion(1)).toEqual(ascii('1'));
    expect(encodePolicyVersion(1_760_000_000)).toEqual(ascii('1760000000'));
    expect(encodePolicyVersion(Number.MAX_SAFE_INTEGER)).toEqual(ascii('9007199254740991'));
  });

  it('decodes exactly what it encodes', () => {
    for (const v of [0, 1, 9, 10, 99, 4096, 1_760_000_000, Number.MAX_SAFE_INTEGER]) {
      expect(decodePolicyVersion(encodePolicyVersion(v))).toBe(v);
    }
  });

  it('refuses every other spelling', () => {
    for (const [label, value] of MALFORMED_MARK_VALUES) {
      expect(() => decodePolicyVersion(value), label).toThrow(
        expect.objectContaining({ code: 'policy_mark_invalid' }),
      );
    }
  });

  it('refuses to encode a version outside [0, 2^53 - 1]', () => {
    for (const bad of [-1, 0.5, Number.NaN, 2 ** 53]) {
      expect(() => encodePolicyVersion(bad), String(bad)).toThrow(
        expect.objectContaining({ code: 'policy_version_invalid' }),
      );
    }
  });
});

describe('the keychain mark item', () => {
  const withLock = <T>(fn: () => Promise<T> | T): Promise<T> =>
    withInterProcessLock(join(dir, 'agent.sqlite.lock'), fn);

  it('is the item `<agentId>:policy-version` under service agentlink and holds only the version', async () => {
    expect(POLICY_MARK_ITEM).toBe('policy-version');
    expect(keychainAccount(AGENT, POLICY_MARK_ITEM)).toBe(`${AGENT}:policy-version`);
    const keychain = new FaultyKeychain();
    await keychainPolicyMark(keychain, AGENT, withLock).raise(3);
    expect([...keychain.items.keys()]).toEqual([`${AGENT}:policy-version`]);
    expect(keychain.items.get(`${AGENT}:policy-version`)).toEqual(ascii('3'));
  });

  it("is per agent: one agent's mark never moves another's", async () => {
    const keychain = new FaultyKeychain();
    await keychainPolicyMark(keychain, AGENT, withLock).raise(9);
    const other = keychainPolicyMark(keychain, OTHER, withLock);
    expect(await other.read()).toBe(0);
    expect(await other.raise(2)).toBe(2);
    expect(await keychainPolicyMark(keychain, AGENT, withLock).read()).toBe(9);
  });

  it('refuses an agent ID that is not the exact 04 §2.9 form before any keychain call', () => {
    const keychain = new FaultyKeychain();
    for (const bad of [`0x${'AB'.repeat(20)}`, 'agent', `${AGENT}:x`]) {
      expect(() => keychainPolicyMark(keychain, bad, withLock), bad).toThrow(
        expect.objectContaining({ code: 'agent_id_invalid' }),
      );
    }
  });

  it('replaces native keychain errors with keychain_failed (no native text, I-7)', async () => {
    const keychain = new FaultyKeychain();
    keychain.fault = 'read';
    const error = (await keychainPolicyMark(keychain, AGENT, withLock)
      .read()
      .catch((e: unknown) => e)) as Error & { code?: string };
    expect(error.code).toBe('keychain_failed');
    expect(error.message).not.toContain('native');
  });

  it('a keychain call that hangs times out instead of hanging the raise', async () => {
    const keychain: KeychainBackend = {
      get: () => new Promise(() => {}),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(false),
    };
    const mark = keychainPolicyMark(keychain, AGENT, withLock, { timeoutMs: 30 });
    await expect(mark.read()).rejects.toThrow(expect.objectContaining({ code: 'keychain_failed' }));
    await expect(mark.raise(1)).rejects.toThrow(
      expect.objectContaining({ code: 'keychain_failed' }),
    );
  });

  it('is a frozen object with exactly read and raise', () => {
    const mark = keychainPolicyMark(new FaultyKeychain(), AGENT, withLock);
    expect(Object.isFrozen(mark)).toBe(true);
    expect(Object.keys(mark).sort()).toEqual(['raise', 'read']);
  });
});
