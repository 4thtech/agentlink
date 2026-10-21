// M1-33a: the receipts-kept marker as a keychain item `<agentId>:receipts-kept` (04 §2.2; 06 §3
// "Existing policies"; D-109), against an in-memory keychain double and the real inter-process lock.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withInterProcessLock } from './inter-process-lock.js';
import { keychainAccount, type KeychainBackend } from './keychain.js';
import { MALFORMED_MARK_VALUES, ascii } from './policy-mark.fixture.js';
import { RECEIPTS_KEPT_ITEM, keychainReceiptsKept } from './receipts-kept.js';

class MapKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  fault: 'none' | 'read' | 'write' | 'lost-write' = 'none';
  get(account: string): Promise<Uint8Array | null> {
    if (this.fault === 'read') return Promise.reject(new Error('native: read failed'));
    return Promise.resolve(this.items.get(account)?.slice() ?? null);
  }
  set(account: string, value: Uint8Array): Promise<void> {
    if (this.fault === 'write') return Promise.reject(new Error('native: write failed'));
    if (this.fault !== 'lost-write') this.items.set(account, value.slice());
    return Promise.resolve();
  }
  delete(account: string): Promise<boolean> {
    return Promise.resolve(this.items.delete(account));
  }
}

const AGENT = `0x${'ab'.repeat(20)}`;
const OTHER = `0x${'cd'.repeat(20)}`;

let dir: string;
let keychain: MapKeychain;
const withLock = <T>(fn: () => Promise<T> | T): Promise<T> =>
  withInterProcessLock(join(dir, 'agent.sqlite.lock'), fn);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-receipts-kept-'));
  keychain = new MapKeychain();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('receipts-kept keychain item (04 §2.2, M1-33a)', () => {
  it('is the agent item `<agentId>:receipts-kept`', () => {
    expect(RECEIPTS_KEPT_ITEM).toBe('receipts-kept');
    expect(keychainAccount(AGENT, RECEIPTS_KEPT_ITEM)).toBe(`${AGENT}:receipts-kept`);
  });

  it('reads null when absent, then the version written, as canonical ASCII decimal', async () => {
    const kept = keychainReceiptsKept(keychain, AGENT, withLock);
    expect(await kept.read()).toBeNull();
    await kept.write(7);
    expect(keychain.items.get(`${AGENT}:receipts-kept`)).toEqual(ascii('7'));
    expect(await kept.read()).toBe(7);
    // Another agent's marker is its own item.
    expect(await keychainReceiptsKept(keychain, OTHER, withLock).read()).toBeNull();
  });

  it('a malformed value is refused on read and never rewritten by a read', async () => {
    const account = `${AGENT}:receipts-kept`;
    for (const [label, value] of MALFORMED_MARK_VALUES) {
      keychain.items.set(account, value.slice());
      await expect(keychainReceiptsKept(keychain, AGENT, withLock).read(), label).rejects.toThrow();
      expect(keychain.items.get(account), label).toEqual(value);
    }
  });

  it('a write that did not stick, or failed, rejects', async () => {
    const kept = keychainReceiptsKept(keychain, AGENT, withLock);
    keychain.fault = 'lost-write';
    await expect(kept.write(3)).rejects.toThrow();
    keychain.fault = 'write';
    await expect(kept.write(3)).rejects.toThrow();
  });

  it('refuses a version that is not a whole number from 0 to 2^53 - 1', async () => {
    const kept = keychainReceiptsKept(keychain, AGENT, withLock);
    for (const v of [-1, 1.5, Number.NaN, 2 ** 53]) {
      await expect(kept.write(v)).rejects.toThrow();
    }
    expect(keychain.items.size).toBe(0);
  });
});
