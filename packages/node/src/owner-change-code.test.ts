// M1-9z (04 §2.8 "Changing the owner code"; 07 §9.3): `agentlink owner change-code` †. An owner code
// that was exposed (typed into a shell or a chat) can be replaced without changing the owner.
//
// Against the real keychain owner store (one in-memory keychain per OS user):
// - The current owner code is required (owner presence); three wrong entries change nothing.
// - The new code is generated, shown once, re-typed (last four characters) and the screen cleared.
// - The owner seed is re-wrapped under the new code; the owner keys and fingerprint do not change,
//   so a store expecting the owner a card names still unlocks (cards stay valid).
// - Refused under an AI-app marker BEFORE the owner item is read.
// - Crash safety: a failure between writing the new wrap and replacing the owner item leaves the
//   old owner item, and the old code, working; the seed is never lost.
// - No owner code appears in any output line other than the one display of the new code, nor in an
//   error.
import { KeyStoreError, encodeUtf8, equalBytes, type OwnerPublicKeys } from '@agentlink/crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { NodeKeyStoreError } from './errors.js';
import type { KeychainBackend } from './keychain.js';
import { changeOwnerCodeWith } from './owner-change-code.js';
import { initOwnerWith } from './owner-init.js';
import {
  KeychainOwnerKeyStore,
  OWNER_ACCOUNT,
  OWNER_NEXT_ACCOUNT,
  ownerFingerprintText,
  storedOwnerSecretKind,
} from './owner-keystore.js';
import type { OwnerTerminal } from './owner-terminal.js';

const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const NEW_CODE_PREFIX = 'Your new owner code: ';

/** One OS user's keychain. Records every account read; `failSet` makes one account's writes fail. */
class MapKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  readonly accountsRead: string[] = [];
  failSet: string | undefined;
  /** When set, writes to this account are silently dropped (a keychain that lies). */
  dropSet: string | undefined;
  async get(account: string): Promise<Uint8Array | null> {
    await Promise.resolve();
    this.accountsRead.push(account);
    return this.items.get(account)?.slice() ?? null;
  }
  async set(account: string, value: Uint8Array): Promise<void> {
    await Promise.resolve();
    if (account === this.failSet) throw new Error('keychain: simulated crash');
    if (account === this.dropSet) return;
    this.items.set(account, value.slice());
  }
  async delete(account: string): Promise<boolean> {
    await Promise.resolve();
    return this.items.delete(account);
  }
}

let keychain: MapKeychain;

beforeEach(() => {
  keychain = new MapKeychain();
});

/** `owner init` (no first card): returns the owner keys and the code it showed. */
async function ownerInit(): Promise<{ code: string; owner: OwnerPublicKeys }> {
  const written: string[] = [];
  const shown = (): string =>
    (written.find((t) => t.startsWith('Your owner code: ')) ?? '')
      .slice('Your owner code: '.length)
      .replace(/ /g, '');
  const terminal: OwnerTerminal = {
    write: (text) => void written.push(text),
    readSecret: () => Promise.resolve(encodeUtf8(shown().slice(-4))),
    confirm: () => Promise.resolve(false),
    clearScreen: () => undefined,
  };
  const { owner } = await initOwnerWith(
    keychain,
    terminal,
    { backend: 'keychain', env: {} },
    { kdf: KDF },
  );
  return { code: shown(), owner };
}

/**
 * The owner at their own terminal: types each of `current` in turn at the owner-code prompt, then
 * re-types `retype(newCode)` (default: its last four characters) at each confirmation prompt.
 */
function owner(current: readonly string[], retype = (code: string) => code.slice(-4)) {
  const written: string[] = [];
  const labels: string[] = [];
  const queue = [...current];
  const newCode = (): string =>
    (written.find((t) => t.startsWith(NEW_CODE_PREFIX)) ?? '')
      .slice(NEW_CODE_PREFIX.length)
      .replace(/ /g, '');
  const terminal: OwnerTerminal = {
    write: (text) => void written.push(text),
    readSecret: (label) => {
      labels.push(label);
      if (newCode() !== '') return Promise.resolve(encodeUtf8(retype(newCode())));
      return Promise.resolve(encodeUtf8(queue.shift() ?? ''));
    },
    confirm: () => Promise.resolve(false),
    clearScreen: () => void written.push('<clear>'),
  };
  return { terminal, written, labels, newCode };
}

async function failure(fn: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof NodeKeyStoreError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('expected a failure');
}

/** True when `code` unlocks the owner item to exactly `expected` (the check a card relies on). */
async function unlocks(code: string, expected: OwnerPublicKeys): Promise<boolean> {
  const store = await KeychainOwnerKeyStore.open(keychain, expected);
  try {
    const session = await store.unlock({ kind: 'passphrase', secret: encodeUtf8(code) });
    await session.close();
    return true;
  } catch (error) {
    if (error instanceof KeyStoreError && error.code === 'presence_rejected') return false;
    throw error;
  } finally {
    await store.close();
  }
}

const WRONG = 'AAAAAAAAAAAAAAAAAAAAAAAA';

describe('owner change-code (M1-9z)', () => {
  it('re-wraps the owner seed under a new generated code; the owner and fingerprint stay the same', async () => {
    const init = await ownerInit();
    const before = keychain.items.get(OWNER_ACCOUNT)?.slice();
    const o = owner([init.code]);
    const result = await changeOwnerCodeWith(
      keychain,
      o.terminal,
      { backend: 'keychain', env: {} },
      { kdf: KDF },
    );
    const next = o.newCode();
    expect(next).toMatch(/^[A-Z2-7]{24}$/);
    expect(next).not.toBe(init.code);
    // Fingerprint and owner keys unchanged.
    expect(result.fingerprint).toBe(ownerFingerprintText(init.owner));
    expect(equalBytes(result.owner.ownerNostr, init.owner.ownerNostr)).toBe(true);
    expect(equalBytes(result.owner.ownerEvm, init.owner.ownerEvm)).toBe(true);
    expect(equalBytes(result.owner.ownerEnc, init.owner.ownerEnc)).toBe(true);
    // The item changed; the new code opens it to the same owner (cards stay valid); the old does not.
    const after = keychain.items.get(OWNER_ACCOUNT);
    expect(after).toBeDefined();
    expect(before !== undefined && after !== undefined && equalBytes(before, after)).toBe(false);
    expect(await unlocks(next, init.owner)).toBe(true);
    expect(await unlocks(init.code, init.owner)).toBe(false);
    expect(await storedOwnerSecretKind(keychain)).toBe(1);
    // No staging item is left behind.
    expect(keychain.items.has(OWNER_NEXT_ACCOUNT)).toBe(false);
    // Prompts: the current code once, then one re-type of the new code; the screen was cleared.
    expect(o.labels).toHaveLength(2);
    expect(o.labels[0]).toBe('Owner code:');
    expect(o.written).toContain('<clear>');
    expect(o.written.join('\n')).toContain(ownerFingerprintText(init.owner));
    // The recovery kit is never touched, and the copy says so.
    expect(o.written.join('\n')).toMatch(/recovery kit/i);
  });

  it('never shows the current code, and shows the new code exactly once', async () => {
    const init = await ownerInit();
    const o = owner([init.code]);
    await changeOwnerCodeWith(keychain, o.terminal, { backend: 'keychain', env: {} }, { kdf: KDF });
    const next = o.newCode();
    const text = o.written.join('\n').replace(/ /g, '');
    expect(text).not.toContain(init.code);
    expect(text.split(next).length - 1).toBe(1);
    const nextIndex = o.written.findIndex((t) => t.startsWith(NEW_CODE_PREFIX));
    const clearIndex = o.written.indexOf('<clear>');
    expect(clearIndex).toBeGreaterThan(nextIndex);
    for (const line of o.written.slice(clearIndex)) {
      expect(line.replace(/ /g, '')).not.toContain(next);
    }
  });

  it('refuses after three wrong current codes and changes nothing', async () => {
    const init = await ownerInit();
    const before = keychain.items.get(OWNER_ACCOUNT)?.slice();
    const o = owner([WRONG, WRONG, WRONG]);
    const f = await failure(() =>
      changeOwnerCodeWith(keychain, o.terminal, { backend: 'keychain', env: {} }, { kdf: KDF }),
    );
    expect(f.code).toBe('owner_secret_refused');
    expect(f.message).not.toContain(WRONG);
    expect(o.labels).toHaveLength(3);
    expect(o.newCode()).toBe('');
    const after = keychain.items.get(OWNER_ACCOUNT);
    expect(before !== undefined && after !== undefined && equalBytes(before, after)).toBe(true);
    expect(keychain.items.has(OWNER_NEXT_ACCOUNT)).toBe(false);
    expect(await unlocks(init.code, init.owner)).toBe(true);
  });

  it('accepts the current code on a later try', async () => {
    const init = await ownerInit();
    const o = owner([WRONG, init.code]);
    await changeOwnerCodeWith(keychain, o.terminal, { backend: 'keychain', env: {} }, { kdf: KDF });
    expect(await unlocks(o.newCode(), init.owner)).toBe(true);
  });

  it('is refused under an AI-app marker before the owner item is read', async () => {
    await ownerInit();
    keychain.accountsRead.length = 0;
    const o = owner(['unused']);
    const f = await failure(() =>
      changeOwnerCodeWith(
        keychain,
        o.terminal,
        { backend: 'keychain', env: { CLAUDECODE: '1' } },
        { kdf: KDF },
      ),
    );
    expect(f.code).toBe('harness_detected');
    expect(keychain.accountsRead).toEqual([]);
    expect(o.labels).toEqual([]);
  });

  it('keeps the old code working when the new code is not re-typed correctly', async () => {
    const init = await ownerInit();
    const before = keychain.items.get(OWNER_ACCOUNT)?.slice();
    const o = owner([init.code], () => 'ZZZZ');
    const f = await failure(() =>
      changeOwnerCodeWith(keychain, o.terminal, { backend: 'keychain', env: {} }, { kdf: KDF }),
    );
    expect(f.code).toBe('owner_secret_refused');
    const after = keychain.items.get(OWNER_ACCOUNT);
    expect(before !== undefined && after !== undefined && equalBytes(before, after)).toBe(true);
    expect(await unlocks(init.code, init.owner)).toBe(true);
    expect(o.written).toContain('<clear>');
  });

  it('crash safety: a failure between writing the new wrap and replacing keeps the old code', async () => {
    const init = await ownerInit();
    const before = keychain.items.get(OWNER_ACCOUNT)?.slice();
    keychain.failSet = OWNER_ACCOUNT;
    const o = owner([init.code]);
    const f = await failure(() =>
      changeOwnerCodeWith(keychain, o.terminal, { backend: 'keychain', env: {} }, { kdf: KDF }),
    );
    expect(f.code).toBe('keychain_failed');
    expect(f.message.replace(/ /g, '')).not.toContain(o.newCode());
    expect(f.message).not.toContain(init.code);
    keychain.failSet = undefined;
    const after = keychain.items.get(OWNER_ACCOUNT);
    expect(before !== undefined && after !== undefined && equalBytes(before, after)).toBe(true);
    expect(await unlocks(init.code, init.owner)).toBe(true);
  });

  it('crash safety: a keychain that drops the replace keeps the old code and reports it', async () => {
    const init = await ownerInit();
    keychain.dropSet = OWNER_ACCOUNT;
    const o = owner([init.code]);
    const f = await failure(() =>
      changeOwnerCodeWith(keychain, o.terminal, { backend: 'keychain', env: {} }, { kdf: KDF }),
    );
    expect(f.code).toBe('keychain_failed');
    keychain.dropSet = undefined;
    expect(await unlocks(init.code, init.owner)).toBe(true);
    expect(keychain.items.has(OWNER_NEXT_ACCOUNT)).toBe(false);
  });

  it('crash safety: a staging write that fails changes nothing', async () => {
    const init = await ownerInit();
    keychain.failSet = OWNER_NEXT_ACCOUNT;
    const o = owner([init.code]);
    const f = await failure(() =>
      changeOwnerCodeWith(keychain, o.terminal, { backend: 'keychain', env: {} }, { kdf: KDF }),
    );
    expect(f.code).toBe('keychain_failed');
    keychain.failSet = undefined;
    expect(await unlocks(init.code, init.owner)).toBe(true);
  });

  it('refuses an owner item that is not the owner the agents name, like a wrong code', async () => {
    const init = await ownerInit();
    const other = await (async () => {
      const k = keychain;
      keychain = new MapKeychain();
      const second = await ownerInit();
      keychain = k;
      return second.owner;
    })();
    const o = owner([init.code, init.code, init.code]);
    const f = await failure(() =>
      changeOwnerCodeWith(
        keychain,
        o.terminal,
        { backend: 'keychain', env: {}, owner: other },
        { kdf: KDF },
      ),
    );
    expect(f.code).toBe('owner_secret_refused');
    expect(await unlocks(init.code, init.owner)).toBe(true);
  });

  it('accepts the expected owner the agents name', async () => {
    const init = await ownerInit();
    const o = owner([init.code]);
    const result = await changeOwnerCodeWith(
      keychain,
      o.terminal,
      { backend: 'keychain', env: {}, owner: init.owner },
      { kdf: KDF },
    );
    expect(result.fingerprint).toBe(ownerFingerprintText(init.owner));
  });

  it('says to run owner init when no owner is set up', async () => {
    const o = owner(['unused']);
    const f = await failure(() =>
      changeOwnerCodeWith(keychain, o.terminal, { backend: 'keychain', env: {} }, { kdf: KDF }),
    );
    expect(f.code).toBe('owner_missing');
    expect(o.labels).toEqual([]);
  });

  it('is not available for a file-KeyStore agent yet', async () => {
    const o = owner(['unused']);
    const f = await failure(() =>
      changeOwnerCodeWith(keychain, o.terminal, { backend: 'file', env: {} }, { kdf: KDF }),
    );
    expect(f.code).toBe('backend_unavailable');
    expect(keychain.accountsRead).toEqual([]);
  });

  it('moves an opted-in owner passphrase to a generated owner code', async () => {
    const passphrase = 'correct horse battery staple';
    const terminal: OwnerTerminal = {
      write: () => undefined,
      readSecret: () => Promise.resolve(encodeUtf8(passphrase)),
      confirm: () => Promise.resolve(true),
      clearScreen: () => undefined,
    };
    const { owner: keys } = await initOwnerWith(
      keychain,
      terminal,
      { backend: 'keychain', env: {}, choosePassphrase: true },
      { kdf: KDF },
    );
    expect(await storedOwnerSecretKind(keychain)).toBe(2);
    const o = owner([passphrase]);
    await changeOwnerCodeWith(keychain, o.terminal, { backend: 'keychain', env: {} }, { kdf: KDF });
    expect(o.labels[0]).toBe('Owner passphrase:');
    expect(await storedOwnerSecretKind(keychain)).toBe(1);
    expect(await unlocks(o.newCode(), keys)).toBe(true);
  });
});
