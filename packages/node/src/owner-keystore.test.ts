// M1-8c: the OwnerKeyStore on keychain machines, `owner init`, one owner operation and the TTY
// prompt (04 §2.2, §2.5, §2.8; 07 §9.3, §9.4; D-66 (3), D-67). The same-user script test and the
// disk scan are in owner-same-user.test.ts.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { isatty } from 'node:tty';
import {
  AGENT_CARD_DOMAIN,
  AGENT_CARD_TYPES,
  CryptoInputError,
  KeyStoreError,
  TAGS,
  bip340Verify,
  canonicalizeToBytes,
  decodeHex,
  encodeHex,
  encodeUtf8,
  equalBytes,
  hashTypedData,
  recoverEvmAddress,
  sha256,
  taggedHash,
  type JsonObject,
  type OwnerPublicKeys,
  type OwnerSession,
  type TypedData,
} from '@agentlink/crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeKeyStoreError } from './errors.js';
import type { KeychainBackend } from './keychain.js';
import { decideReviewedApprovals, initOwner, performOwnerOperation } from './index.js';
import { initOwnerWith, type OwnerInitOptions } from './owner-init.js';
import {
  KeychainOwnerKeyStore,
  OWNER_ACCOUNT,
  newOwnerSeed,
  ownerFingerprintText,
  storeOwnerSeed,
} from './owner-keystore.js';
import {
  LOCAL_APPROVAL_LIFETIME_S,
  MAX_APPROVAL_BATCH_ITEMS,
  buildApprovalOperation,
  decideReviewedWith,
  type ReviewedApproval,
} from './owner-approval.js';
import { runOwnerGesture, runOwnerOperation } from './owner-operation.js';
import { HARNESS_MARKERS, ttyOwnerTerminal, type OwnerTerminal } from './owner-terminal.js';

// Every owner seed opened and every secret key derived, so the tests can check they were wiped.
const captured = vi.hoisted(() => ({ seeds: [] as Uint8Array[], keys: [] as Uint8Array[] }));
vi.mock('@agentlink/crypto/keystore', async (importOriginal) => {
  const real = await importOriginal<typeof import('@agentlink/crypto/keystore')>();
  return {
    ...real,
    openOwnerSeed: async (...args: Parameters<typeof real.openOwnerSeed>) => {
      const seed = await real.openOwnerSeed(...args);
      captured.seeds.push(seed);
      return seed;
    },
    deriveSecretKey: (...args: Parameters<typeof real.deriveSecretKey>) => {
      const key = real.deriveSecretKey(...args);
      captured.keys.push(key);
      return key;
    },
  };
});

/** The 04 §2.8 floor, so each Argon2id run is fast in tests. */
const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const CLEAN_ENV = {};
const AGENT = `0x${'ab'.repeat(20)}`;

class FakeKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  async get(account: string): Promise<Uint8Array | null> {
    await Promise.resolve();
    return this.items.get(account)?.slice() ?? null;
  }
  async set(account: string, value: Uint8Array): Promise<void> {
    await Promise.resolve();
    this.items.set(account, value.slice());
  }
  async delete(account: string): Promise<boolean> {
    await Promise.resolve();
    return this.items.delete(account);
  }
}

type Answer = string | Uint8Array | ((written: readonly string[]) => string);

/** A scripted terminal. Every secret it hands out is kept, so tests can see it wiped. */
function scripted(answers: Answer[], confirms: boolean[] = []) {
  const written: string[] = [];
  const handedOut: Uint8Array[] = [];
  const labels: string[] = [];
  const terminal: OwnerTerminal = {
    write: (text) => {
      written.push(text);
    },
    readSecret: (label) => {
      labels.push(label);
      const next = answers.shift();
      if (next === undefined) return Promise.reject(new Error('no scripted answer'));
      const bytes =
        typeof next === 'function'
          ? encodeUtf8(next(written))
          : typeof next === 'string'
            ? encodeUtf8(next)
            : next;
      handedOut.push(bytes);
      return Promise.resolve(bytes);
    },
    confirm: () => Promise.resolve(confirms.shift() ?? false),
    clearScreen: () => {
      written.push('<clear>');
    },
  };
  return { terminal, written, handedOut, labels };
}

/** The generated code as shown by `owner init`, read back from the transcript. */
function shownCode(written: readonly string[]): string {
  const line = written.find((text) => text.startsWith('Your owner code: '));
  if (line === undefined) throw new Error('no code shown');
  return line.slice('Your owner code: '.length);
}
const lastGroup = (written: readonly string[]): string => shownCode(written).slice(-4);

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (
      error instanceof NodeKeyStoreError ||
      error instanceof KeyStoreError ||
      error instanceof CryptoInputError
    ) {
      return error.code;
    }
    throw error;
  }
  return 'accepted';
}

/** Sets up an owner with the generated code; returns the code as the owner saw it. */
async function setUpOwner(keychain: FakeKeychain, options: Partial<OwnerInitOptions> = {}) {
  const run = scripted([lastGroup]);
  const result = await initOwnerWith(
    keychain,
    run.terminal,
    { backend: 'keychain', env: CLEAN_ENV, ...options },
    { kdf: KDF },
  );
  return { result, code: shownCode(run.written), written: run.written };
}

function approvalBody(owner: OwnerPublicKeys): JsonObject {
  return {
    v: 1,
    agent: AGENT,
    owner: encodeHex(owner.ownerNostr),
    op: 'approval.decide',
    params: { approvalId: 'apr_test', actionDigest: '00'.repeat(32), decision: 'approve' },
    nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
    issuedAt: 1_760_000_000,
    expiresAt: 1_760_000_600,
  };
}

/** 04 §2.5.1: does `sig` verify under the owner Nostr key? */
function ownerSigValid(body: JsonObject, sig: string, owner: OwnerPublicKeys): boolean {
  try {
    const digest = taggedHash(TAGS.ownerAction, sha256(canonicalizeToBytes(body)));
    return bip340Verify(owner.ownerNostr, digest, decodeHex(sig, { length: 64 }));
  } catch {
    return false;
  }
}

const TYPED: TypedData = {
  types: {
    EIP712Domain: [{ name: 'name', type: 'string' }],
    Note: [{ name: 'text', type: 'string' }],
  },
  primaryType: 'Note',
  domain: { name: 'AgentLink test' },
  message: { text: 'hello' },
};

/** An agent card for `owner` as EIP-712 typed data (04 §2.4). */
function agentCardTyped(owner: OwnerPublicKeys): TypedData {
  const hex = (bytes: Uint8Array): string => `0x${encodeHex(bytes)}`;
  return {
    types: AGENT_CARD_TYPES,
    primaryType: 'AgentCard',
    domain: AGENT_CARD_DOMAIN,
    message: {
      version: 1,
      agentEvm: AGENT,
      agentNostr: hex(new Uint8Array(32).fill(1)),
      agentEnc: hex(new Uint8Array(32).fill(2)),
      ownerEvm: hex(owner.ownerEvm),
      ownerNostr: hex(owner.ownerNostr),
      ownerEnc: hex(owner.ownerEnc),
      nameHash: hex(new Uint8Array(32).fill(3)),
      relaysHash: hex(new Uint8Array(32).fill(4)),
      issuedAt: 1_760_000_000,
      expiresAt: 0,
      keyEpoch: 0,
    },
  };
}

const zeroed = (bytes: Uint8Array): boolean => bytes.every((b) => b === 0);
/** Lets queued prompt reads attach their listener, as keystrokes arrive later than the prompt. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  captured.seeds.length = 0;
  captured.keys.length = 0;
});

describe('owner init on a keychain machine (04 §2.2, D-67)', () => {
  it('stores ALKO v1 (90 bytes, secretKind 1) under service agentlink, account owner, by default', async () => {
    const keychain = new FakeKeychain();
    const { result, code } = await setUpOwner(keychain);
    const blob = keychain.items.get(OWNER_ACCOUNT);
    expect(OWNER_ACCOUNT).toBe('owner');
    expect(blob?.length).toBe(90);
    expect(new TextDecoder().decode(blob?.subarray(0, 4))).toBe('ALKO');
    expect(blob?.[4]).toBe(1);
    expect(blob?.[5]).toBe(1);
    expect(result.secretKind).toBe(1);
    expect(code).toMatch(/^[A-Z2-7]{4}( [A-Z2-7]{4}){5}$/);
    expect([...keychain.items.keys()]).toEqual(['owner']);
    expect(result.fingerprint).toBe(ownerFingerprintText(result.owner));
  });

  it('shows the fingerprint and the lost-code consequence before the code, once, then clears', async () => {
    const { result, written } = await setUpOwner(new FakeKeychain());
    const codeAt = written.findIndex((t) => t.startsWith('Your owner code: '));
    const fpAt = written.findIndex((t) => t.includes(result.fingerprint));
    const lostAt = written.findIndex((t) => t.startsWith('Store this owner code off this machine'));
    expect(fpAt).toBeGreaterThanOrEqual(0);
    expect(fpAt).toBeLessThan(codeAt);
    expect(lostAt).toBeLessThan(codeAt);
    expect(written.filter((t) => t.startsWith('Your owner code: '))).toHaveLength(1);
    expect(written[codeAt + 1]).toBe('<clear>');
    expect(written.at(-1)).toBe(
      `Owner set up. Your owner fingerprint: ${result.fingerprint}. Check that \`agentlink doctor\` shows the same one.`,
    );
  });

  it('writes nothing when the code is not re-typed correctly (three attempts)', async () => {
    const keychain = new FakeKeychain();
    const run = scripted(['ZZZZ', 'zzzz', '9999']);
    expect(
      await codeOf(() =>
        initOwnerWith(
          keychain,
          run.terminal,
          { backend: 'keychain', env: CLEAN_ENV },
          { kdf: KDF },
        ),
      ),
    ).toBe('owner_secret_refused');
    expect(keychain.items.size).toBe(0);
    expect(run.written.at(-1)).toBe('<clear>');
  });

  it('never overwrites an existing owner item', async () => {
    const keychain = new FakeKeychain();
    await setUpOwner(keychain);
    const before = keychain.items.get(OWNER_ACCOUNT)?.slice();
    const run = scripted([lastGroup]);
    expect(
      await codeOf(() =>
        initOwnerWith(
          keychain,
          run.terminal,
          { backend: 'keychain', env: CLEAN_ENV },
          { kdf: KDF },
        ),
      ),
    ).toBe('owner_exists');
    expect(keychain.items.get(OWNER_ACCOUNT)).toEqual(before);
    expect(run.labels).toEqual([]);
    // storeOwnerSeed refuses on its own too.
    const { seed } = newOwnerSeed();
    expect(
      await codeOf(() =>
        storeOwnerSeed(
          keychain,
          seed,
          { secret: encodeUtf8('A'.repeat(24)), secretKind: 1 },
          { kdf: KDF },
        ),
      ),
    ).toBe('owner_exists');
    expect(keychain.items.get(OWNER_ACCOUNT)).toEqual(before);
  });

  it('refuses when the agent card already names an owner, naming its fingerprint', async () => {
    const { keys } = newOwnerSeed();
    const run = scripted([]);
    const error = await initOwnerWith(
      new FakeKeychain(),
      run.terminal,
      { backend: 'keychain', env: CLEAN_ENV, cardOwner: keys },
      { kdf: KDF },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NodeKeyStoreError);
    expect((error as NodeKeyStoreError).code).toBe('owner_exists');
    expect((error as NodeKeyStoreError).message).toContain(ownerFingerprintText(keys));
  });

  it('opt-in: states the offline-guessing exposure first, then takes a chosen passphrase (kind 2)', async () => {
    const keychain = new FakeKeychain();
    const passphrase = 'correct horse battery';
    let beforePrompt: string[] = [];
    const run = scripted(
      [
        (written) => {
          beforePrompt = [...written];
          return passphrase;
        },
        passphrase,
      ],
      [true],
    );
    const result = await initOwnerWith(
      keychain,
      run.terminal,
      { backend: 'keychain', env: CLEAN_ENV, choosePassphrase: true },
      { kdf: KDF },
    );
    expect(result.secretKind).toBe(2);
    expect(keychain.items.get(OWNER_ACCOUNT)?.[5]).toBe(2);
    expect(run.written[0]).toContain('try to guess the passphrase offline');
    expect(run.written.join('\n')).not.toContain('Your owner code');
    // IR-M1-8c-1 F-5: the fingerprint and what a lost passphrase means come before the passphrase.
    expect(beforePrompt).toContain(`Your owner fingerprint: ${result.fingerprint}.`);
    expect(
      beforePrompt.some((t) => t.startsWith('Keep this owner passphrase off this machine')),
    ).toBe(true);
  });

  it('the re-type check reads 0/1/8 as O/I/B, like the code itself (04 §2.8)', async () => {
    const keychain = new FakeKeychain();
    const lookalike = (written: readonly string[]): string =>
      lastGroup(written)
        .toLowerCase()
        .replaceAll('o', '0')
        .replaceAll('i', '1')
        .replaceAll('b', '8');
    const run = scripted([lookalike]);
    const result = await initOwnerWith(
      keychain,
      run.terminal,
      { backend: 'keychain', env: CLEAN_ENV },
      { kdf: KDF },
    );
    expect(result.secretKind).toBe(1);
    expect(keychain.items.has(OWNER_ACCOUNT)).toBe(true);
  });

  it('opt-in declined: falls back to the generated code', async () => {
    const keychain = new FakeKeychain();
    const run = scripted([lastGroup], [false]);
    const result = await initOwnerWith(
      keychain,
      run.terminal,
      { backend: 'keychain', env: CLEAN_ENV, choosePassphrase: true },
      { kdf: KDF },
    );
    expect(result.secretKind).toBe(1);
  });

  it('D-66 (3): a chosen passphrase under 12 code points after NFKC is refused; 12 is accepted', async () => {
    const eleven = 'abcdefghijk';
    const nfkcShort = 'é'.repeat(6); // 12 code points typed, 6 after NFKC
    for (const short of [eleven, nfkcShort]) {
      const keychain = new FakeKeychain();
      const run = scripted([short, short, short], [true]);
      expect(
        await codeOf(() =>
          initOwnerWith(
            keychain,
            run.terminal,
            { backend: 'keychain', env: CLEAN_ENV, choosePassphrase: true },
            { kdf: KDF },
          ),
        ),
      ).toBe('owner_secret_refused');
      expect(keychain.items.size).toBe(0);
      expect(run.written).toContain('Use at least 12 characters.');
      expect(run.handedOut.every(zeroed)).toBe(true);
    }
    const keychain = new FakeKeychain();
    const twelve = 'abcdefghijkl';
    const run = scripted([twelve, twelve], [true]);
    const result = await initOwnerWith(
      keychain,
      run.terminal,
      { backend: 'keychain', env: CLEAN_ENV, choosePassphrase: true },
      { kdf: KDF },
    );
    expect(result.secretKind).toBe(2);
  });

  it('a chosen passphrase typed differently twice is refused', async () => {
    const keychain = new FakeKeychain();
    const run = scripted(
      ['abcdefghijkl', 'abcdefghijkX', 'abcdefghijkl', 'X', 'abcdefghijkl', 'Y'],
      [true],
    );
    expect(
      await codeOf(() =>
        initOwnerWith(
          keychain,
          run.terminal,
          { backend: 'keychain', env: CLEAN_ENV, choosePassphrase: true },
          { kdf: KDF },
        ),
      ),
    ).toBe('owner_secret_refused');
    expect(keychain.items.size).toBe(0);
  });

  it('file-KeyStore machine: a chosen passphrase is refused; the owner.alko path is M1-8f', async () => {
    const run = scripted([]);
    expect(
      await codeOf(() =>
        initOwnerWith(new FakeKeychain(), run.terminal, {
          backend: 'file',
          env: CLEAN_ENV,
          choosePassphrase: true,
        }),
      ),
    ).toBe('owner_secret_refused');
    expect(
      await codeOf(() =>
        initOwnerWith(new FakeKeychain(), run.terminal, { backend: 'file', env: CLEAN_ENV }),
      ),
    ).toBe('backend_unavailable');
    expect(run.labels).toEqual([]);
  });

  it('is refused while an AI-app marker is set (UX guard, 04 §2.8)', async () => {
    for (const marker of HARNESS_MARKERS) {
      const keychain = new FakeKeychain();
      const run = scripted([lastGroup]);
      expect(
        await codeOf(() =>
          initOwnerWith(keychain, run.terminal, { backend: 'keychain', env: { [marker]: '1' } }),
        ),
      ).toBe('harness_detected');
      expect(keychain.items.size).toBe(0);
      expect(run.written).toEqual([]);
    }
  });

  it('the public owner operations are refused while an AI-app marker is set (IR-M1-8c-1 F-2)', async () => {
    const { keys } = newOwnerSeed();
    const saved = { ...process.env };
    process.env['CLAUDECODE'] = '1';
    try {
      expect(
        await codeOf(() =>
          performOwnerOperation(keys, {
            kind: 'owner-action',
            action: approvalBody(keys),
            summary: 'Approve',
          }),
        ),
      ).toBe('harness_detected');
      expect(await codeOf(() => decideReviewedApprovals({ agent: AGENT, owner: keys }, []))).toBe(
        'harness_detected',
      );
    } finally {
      process.env = saved;
    }
  });

  it('the public initOwner needs an interactive terminal (no TTY here)', async () => {
    // M1-8h: the public entry always issues the first card; these refusals come before it is used.
    const firstCard = {
      agent: AGENT,
      name: 'Agent',
      relays: ['wss://one.relay-alpha.net', 'wss://nos.lol'],
      identity: {
        get: () => Promise.resolve(undefined),
        init: () => Promise.reject(new Error('not reached')),
      },
    };
    expect(
      await codeOf(() => initOwner({ backend: 'keychain', env: { CLAUDECODE: '1' }, firstCard })),
    ).toBe('harness_detected');
    if (!isatty(0) || !isatty(1)) {
      expect(
        await codeOf(() => initOwner({ backend: 'keychain', env: CLEAN_ENV, firstCard })),
      ).toBe('owner_prompt_unavailable');
    }
  });
});

describe('one owner operation (04 §2.5, D-68)', () => {
  async function ready() {
    const keychain = new FakeKeychain();
    const { result, code } = await setUpOwner(keychain);
    const store = await KeychainOwnerKeyStore.open(keychain, result.owner);
    return { keychain, owner: result.owner, code, store };
  }
  const signAction = (
    store: KeychainOwnerKeyStore,
    terminal: OwnerTerminal,
    action: JsonObject,
    lines: readonly string[] = ['Approve'],
  ) => runOwnerOperation(store, terminal, { lines }, { kind: 'owner-action', action });

  it('signs exactly the reviewed owner action with the owner key, after showing it', async () => {
    const { owner, code, store } = await ready();
    const body = approvalBody(owner);
    const run = scripted([code]);
    const out = await signAction(store, run.terminal, body, ['Approve: send a message to Acme']);
    expect(run.labels).toEqual(['Owner code:']);
    expect(run.written).toEqual(['Approve: send a message to Acme']);
    if (out.kind !== 'owner-action') throw new Error('unreachable');
    expect(out.signed.body).toEqual(body);
    expect(ownerSigValid(out.signed.body, out.signed.sig, owner)).toBe(true);
    expect(ownerSigValid({ ...body, nonce: 'BBBBBBBBBBBBBBBBBBBBBA' }, out.signed.sig, owner)).toBe(
      false,
    );
  });

  it('a session signs typed data with the owner EVM key (the agent card)', async () => {
    const { owner, code, store } = await ready();
    // M1-8h-b (IR-M1-8h-1 L3): the generic owner operation signs no card; only the bound card
    // sessions of owner init and owner add-agent do (owner-first-card.ts). The key itself is the
    // owner EVM key.
    const cardTyped = agentCardTyped(owner);
    const session = await store.unlock({ kind: 'passphrase', secret: encodeUtf8(code) });
    const signature = await session.sign712(cardTyped);
    await session.close();
    await store.close();
    const recovered = recoverEvmAddress(
      hashTypedData(cardTyped).digest,
      decodeHex(signature.slice(2)),
    );
    expect(equalBytes(recovered, owner.ownerEvm)).toBe(true);
  });

  it('IR-M1-8h-1 L3: one owner operation refuses the agent card, before any prompt', async () => {
    const { owner, code, store } = await ready();
    const run = scripted([code]);
    const refused = await codeOf(() =>
      runOwnerOperation(
        store,
        run.terminal,
        { lines: ['Sign your agent profile'] },
        { kind: 'typed-data', typedData: agentCardTyped(owner) },
      ),
    );
    expect(refused).toBe('owner_operation_refused');
    expect(run.labels).toEqual([]);
    expect(run.written).toEqual([]);
    await store.close();
  });

  it('IR-M1-8h-1 L2: storeOwnerSeed never deletes an owner item it did not write', async () => {
    // Another run's item lands between this run's write and its read-back.
    const other = new Uint8Array(90).fill(9);
    class RacingKeychain extends FakeKeychain {
      override async set(account: string, value: Uint8Array): Promise<void> {
        await super.set(account, value);
        this.items.set(account, other.slice());
      }
    }
    const keychain = new RacingKeychain();
    const { seed } = newOwnerSeed();
    expect(
      await codeOf(() =>
        storeOwnerSeed(
          keychain,
          seed,
          { secret: encodeUtf8('A'.repeat(24)), secretKind: 1 },
          { kdf: KDF },
        ),
      ),
    ).toBe('keychain_failed');
    expect(keychain.items.get(OWNER_ACCOUNT)).toEqual(other);
  });

  it('accepts the code in lower case, with dashes, and with 0/1/8 for O/I/B', async () => {
    const { owner, code, store } = await ready();
    const variant = code
      .toLowerCase()
      .replaceAll(' ', '-')
      .replaceAll('o', '0')
      .replaceAll('i', '1')
      .replaceAll('b', '8');
    const out = await signAction(store, scripted([variant]).terminal, approvalBody(owner));
    expect(out.kind).toBe('owner-action');
  });

  it('a wrong code signs nothing (presence_rejected), and the typed bytes are wiped', async () => {
    const { owner, store } = await ready();
    const run = scripted(['AAAA AAAA AAAA AAAA AAAA AAAA']);
    expect(await codeOf(() => signAction(store, run.terminal, approvalBody(owner)))).toBe(
      'presence_rejected',
    );
    expect(run.handedOut.every(zeroed)).toBe(true);
    expect(captured.seeds).toEqual([]);
  });

  it('a malformed code is the same kind of answer as a wrong one', async () => {
    const { owner, store } = await ready();
    for (const typed of ['', 'short', 'ÄÖÜ'.repeat(8)]) {
      const run = scripted([typed]);
      const code = await codeOf(() => signAction(store, run.terminal, approvalBody(owner)));
      expect(['presence_rejected', 'presence_required']).toContain(code);
      expect(run.handedOut.every(zeroed)).toBe(true);
    }
  });

  it('wipes the typed code, the owner seed and the session keys; the session ends with the operation', async () => {
    const { owner, code, store } = await ready();
    captured.keys.length = 0;
    const sessions: OwnerSession[] = [];
    const unlock = store.unlock.bind(store);
    store.unlock = async (...args) => {
      const session = await unlock(...args);
      sessions.push(session);
      return session;
    };
    const run = scripted([code]);
    await signAction(store, run.terminal, approvalBody(owner));
    expect(run.handedOut).toHaveLength(1);
    expect(run.handedOut.every(zeroed)).toBe(true);
    expect(captured.seeds).toHaveLength(1);
    expect(captured.seeds.every(zeroed)).toBe(true);
    expect(captured.keys.length).toBeGreaterThanOrEqual(3);
    expect(captured.keys.every(zeroed)).toBe(true);
    expect(sessions).toHaveLength(1);
    const session = sessions[0] as OwnerSession;
    expect(session.isActive()).toBe(false);
    expect(await codeOf(() => session.signOwnerAction(approvalBody(owner)))).toBe('owner_locked');
    expect(await codeOf(() => session.sign712(TYPED))).toBe('owner_locked');
  });

  it('one gesture may sign an approval and its rule change ("Remember for this contact", 06 §3), then ends', async () => {
    const { owner, code, store } = await ready();
    const sessions: OwnerSession[] = [];
    const unlock = store.unlock.bind(store);
    store.unlock = async (...args) => {
      const session = await unlock(...args);
      sessions.push(session);
      return session;
    };
    const policy: JsonObject = {
      ...approvalBody(owner),
      op: 'policy.set',
      params: { version: 2, policy: {} },
    };
    const run = scripted([code]);
    const out = await runOwnerGesture(store, run.terminal, { lines: ['Approve and remember'] }, [
      { kind: 'owner-action', action: approvalBody(owner) },
      { kind: 'owner-action', action: policy },
    ]);
    expect(run.labels).toEqual(['Owner code:']);
    expect(out).toHaveLength(2);
    for (const signature of out) {
      if (signature.kind !== 'owner-action') throw new Error('unreachable');
      expect(ownerSigValid(signature.signed.body, signature.signed.sig, owner)).toBe(true);
    }
    expect(sessions).toHaveLength(1);
    expect(await codeOf(() => sessions[0]!.signOwnerAction(policy))).toBe('owner_locked');
    // Any other pair, or more objects, is not one gesture.
    for (const requests of [
      [
        { kind: 'owner-action', action: policy },
        { kind: 'owner-action', action: approvalBody(owner) },
      ],
      [
        { kind: 'owner-action', action: approvalBody(owner) },
        { kind: 'owner-action', action: approvalBody(owner) },
      ],
      [
        { kind: 'owner-action', action: approvalBody(owner) },
        { kind: 'owner-action', action: policy },
        { kind: 'owner-action', action: policy },
      ],
      [],
    ] as const) {
      expect(
        await codeOf(() =>
          runOwnerGesture(store, scripted([]).terminal, { lines: ['X'] }, requests),
        ),
      ).toBe('owner_operation_invalid');
    }
  });

  it('asks for the code again on the next operation (no unlock session)', async () => {
    const { owner, code, store } = await ready();
    const run = scripted([code, code]);
    await signAction(store, run.terminal, approvalBody(owner));
    await signAction(store, run.terminal, approvalBody(owner));
    expect(run.labels).toEqual(['Owner code:', 'Owner code:']);
    await expect(signAction(store, scripted([]).terminal, approvalBody(owner))).rejects.toThrow(
      'no scripted answer',
    );
  });

  it('refuses empty or non-printable review text before prompting', async () => {
    const { owner, store } = await ready();
    const run = scripted([]);
    expect(await codeOf(() => signAction(store, run.terminal, approvalBody(owner), []))).toBe(
      'owner_operation_invalid',
    );
    expect(
      await codeOf(() =>
        signAction(store, run.terminal, approvalBody(owner), ['Approve\u001b[2J']),
      ),
    ).toBe('owner_operation_invalid');
    expect(run.labels).toEqual([]);
  });

  it('a "no" to the question cancels before the prompt', async () => {
    const { owner, store } = await ready();
    const run = scripted([], [false]);
    expect(
      await codeOf(() =>
        runOwnerOperation(
          store,
          run.terminal,
          { lines: ['Approve'], question: 'Continue? (y/N)' },
          { kind: 'owner-action', action: approvalBody(owner) },
        ),
      ),
    ).toBe('owner_prompt_cancelled');
    expect(run.labels).toEqual([]);
  });

  it('signs the snapshot taken before the prompt, not a later change to the caller object', async () => {
    const { owner, code, store } = await ready();
    const body = approvalBody(owner) as Record<string, unknown>;
    const run = scripted([
      () => {
        (body['params'] as Record<string, unknown>)['decision'] = 'deny';
        return code;
      },
    ]);
    const out = await signAction(store, run.terminal, body as JsonObject);
    if (out.kind !== 'owner-action') throw new Error('unreachable');
    expect((out.signed.body['params'] as Record<string, unknown>)['decision']).toBe('approve');
  });

  it('refuses a body for another owner key', async () => {
    const { owner, code, store } = await ready();
    const other = { ...approvalBody(owner), owner: 'cd'.repeat(32) };
    expect(await codeOf(() => signAction(store, scripted([code]).terminal, other))).toBe(
      'invalid_argument',
    );
  });
});

describe('batch approval (04 §2.5.2, D-68)', () => {
  const NOW = 1_760_000_000;
  const fixed = { nowSeconds: () => NOW, nonce: () => new Uint8Array(16).fill(1) };
  const id = (n: number): string => `apr_${String.fromCharCode(65 + n).repeat(22)}`;
  const action = (n: number): JsonObject => ({
    tool: 'agentlink_send',
    to: `contact-${String(n)}`,
  });
  const digestOf = (value: JsonObject): string => encodeHex(sha256(canonicalizeToBytes(value)));
  const reviewed = (n: number, decision: 'approve' | 'deny' = 'approve'): ReviewedApproval => ({
    approvalId: id(n),
    action: action(n),
    storedDigest: digestOf(action(n)),
    decision,
    commitment: false,
    summary: `Send a message to Contact ${String(n)}`,
    requestExpiresAt: NOW + 3_600 + n,
  });

  async function ready() {
    const keychain = new FakeKeychain();
    const { result, code } = await setUpOwner(keychain);
    const store = await KeychainOwnerKeyStore.open(keychain, result.owner);
    return { owner: result.owner, code, store, context: { agent: AGENT, owner: result.owner } };
  }

  it('one code entry signs one approval.decideBatch over exactly the reviewed items', async () => {
    const { owner, code, store, context } = await ready();
    const items = [reviewed(3), reviewed(1, 'deny'), reviewed(2), reviewed(0)];
    const run = scripted([code], [true]);
    const signed = await decideReviewedWith(store, run.terminal, context, items, fixed);
    expect(run.labels).toEqual(['Owner code:']);
    expect(signed.body['op']).toBe('approval.decideBatch');
    const params = signed.body['params'] as {
      items: { approvalId: string; actionDigest: string; decision: string }[];
    };
    expect(params.items.map((i) => i.approvalId)).toEqual([id(0), id(1), id(2), id(3)]);
    expect(params.items[1]).toEqual({
      approvalId: id(1),
      actionDigest: digestOf(action(1)),
      decision: 'deny',
    });
    expect(Object.keys(signed.body).sort()).toEqual(
      ['agent', 'expiresAt', 'issuedAt', 'nonce', 'op', 'owner', 'params', 'v'].sort(),
    );
    expect(signed.body['issuedAt']).toBe(NOW);
    expect(signed.body['expiresAt']).toBe(NOW + LOCAL_APPROVAL_LIFETIME_S);
    expect(signed.body['nonce']).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(ownerSigValid(signed.body, signed.sig, owner)).toBe(true);
    // Shown before the code: every item, soonest to expire first, then the totals.
    expect(run.written).toEqual([
      'Your decisions (4):',
      '  1. Approve: Send a message to Contact 0',
      '  2. Deny: Send a message to Contact 1',
      '  3. Approve: Send a message to Contact 2',
      '  4. Approve: Send a message to Contact 3',
      'Approve 3 and deny 1. Your owner code covers exactly these 4. Anything new waits for your next review.',
    ]);
  });

  it('an item added, removed or changed after signing breaks the signature', async () => {
    const { owner, code, store, context } = await ready();
    const signed = await decideReviewedWith(
      store,
      scripted([code], [true]).terminal,
      context,
      [reviewed(0), reviewed(1), reviewed(2)],
      fixed,
    );
    const items = (signed.body['params'] as { items: JsonObject[] }).items;
    const extra = { approvalId: id(9), actionDigest: digestOf(action(9)), decision: 'approve' };
    const variants: JsonObject[] = [
      { ...signed.body, params: { items: [...items, extra] } },
      { ...signed.body, params: { items: items.slice(0, 2) } },
      {
        ...signed.body,
        params: { items: [items[0], items[1], { ...items[2], decision: 'deny' }] },
      },
      {
        ...signed.body,
        params: { items: [items[0], items[1], { ...items[2], actionDigest: digestOf(action(7)) }] },
      },
    ] as JsonObject[];
    for (const variant of variants) expect(ownerSigValid(variant, signed.sig, owner)).toBe(false);
  });

  it('a single decision is approval.decide, never a batch of one', async () => {
    const { owner, code, store, context } = await ready();
    const signed = await decideReviewedWith(
      store,
      scripted([code], [true]).terminal,
      context,
      [reviewed(0)],
      fixed,
    );
    expect(signed.body['op']).toBe('approval.decide');
    expect(signed.body['params']).toEqual({
      approvalId: id(0),
      actionDigest: digestOf(action(0)),
      decision: 'approve',
    });
    expect(ownerSigValid(signed.body, signed.sig, owner)).toBe(true);
  });

  it('expiresAt is at most the earliest request expiry', async () => {
    const { context } = await ready();
    const soon = { ...reviewed(1), requestExpiresAt: NOW + 120 };
    const op = buildApprovalOperation(context, [reviewed(0), soon], fixed);
    expect(op.body['expiresAt']).toBe(NOW + 120);
    expect(() =>
      buildApprovalOperation(context, [{ ...soon, requestExpiresAt: NOW }], fixed),
    ).toThrow(expect.objectContaining({ code: 'owner_operation_invalid' }) as Error);
  });

  it(`refuses an empty list, more than ${String(MAX_APPROVAL_BATCH_ITEMS)} items and duplicates; 20 is accepted`, async () => {
    const { context } = await ready();
    const twenty = Array.from({ length: 20 }, (_, n) => reviewed(n));
    expect(MAX_APPROVAL_BATCH_ITEMS).toBe(20);
    const ok = buildApprovalOperation(context, twenty, fixed);
    expect((ok.body['params'] as { items: unknown[] }).items).toHaveLength(20);
    const refuse = (list: ReviewedApproval[]) => () => buildApprovalOperation(context, list, fixed);
    const refused = expect.objectContaining({ code: 'owner_operation_invalid' }) as Error;
    expect(refuse([])).toThrow(refused);
    expect(refuse([...twenty, reviewed(20)])).toThrow(refused);
    expect(refuse([reviewed(0), reviewed(0, 'deny')])).toThrow(refused);
  });

  it('signs only digests it recomputed: a stored digest that differs is never offered', async () => {
    const { store, context } = await ready();
    const tampered = { ...reviewed(1), storedDigest: digestOf(action(5)) };
    const run = scripted([], [true]);
    expect(
      await codeOf(() =>
        decideReviewedWith(store, run.terminal, context, [reviewed(0), tampered], fixed),
      ),
    ).toBe('owner_operation_invalid');
    expect(run.labels).toEqual([]);
    expect(run.written).toEqual([]);
  });

  it('requires the stored digest: an item without one is never offered (IR-M1-8c-1 F-3)', async () => {
    const { store, context } = await ready();
    const withoutDigest: Record<string, unknown> = { ...reviewed(1) };
    Reflect.deleteProperty(withoutDigest, 'storedDigest');
    const run = scripted([], [true]);
    for (const item of [withoutDigest, { ...reviewed(1), storedDigest: 'AB'.repeat(32) }]) {
      expect(
        await codeOf(() =>
          decideReviewedWith(
            store,
            run.terminal,
            context,
            [reviewed(0), item as unknown as ReviewedApproval],
            fixed,
          ),
        ),
      ).toBe('owner_operation_invalid');
    }
    expect(run.labels).toEqual([]);
    expect(run.written).toEqual([]);
  });

  it('refuses malformed items before prompting', async () => {
    const { context } = await ready();
    const refused = expect.objectContaining({ code: 'owner_operation_invalid' }) as Error;
    for (const bad of [
      { ...reviewed(0), approvalId: 'apr_short' },
      { ...reviewed(0), decision: 'maybe' },
      { ...reviewed(0), summary: 'line\nbreak' },
      { ...reviewed(0), requestExpiresAt: 1.5 },
    ]) {
      expect(() =>
        buildApprovalOperation(context, [bad as ReviewedApproval, reviewed(1)], fixed),
      ).toThrow(refused);
    }
  });

  it('never batches a commitment (IR-D-68-1); a commitment alone is an approval.decide', async () => {
    const { owner, code, store, context } = await ready();
    const terms = { ...reviewed(1), commitment: true };
    expect(() => buildApprovalOperation(context, [reviewed(0), terms], fixed)).toThrow(
      expect.objectContaining({ code: 'owner_operation_invalid' }) as Error,
    );
    expect(() =>
      buildApprovalOperation(context, [{ ...reviewed(0), commitment: 'no' } as never], fixed),
    ).toThrow(expect.objectContaining({ code: 'owner_operation_invalid' }) as Error);
    const signed = await decideReviewedWith(
      store,
      scripted([code], [true]).terminal,
      context,
      [terms],
      fixed,
    );
    expect(signed.body['op']).toBe('approval.decide');
    expect(ownerSigValid(signed.body, signed.sig, owner)).toBe(true);
  });

  it('"no" at Continue signs nothing and asks for no code', async () => {
    const { store, context } = await ready();
    const run = scripted([], [false]);
    expect(
      await codeOf(() =>
        decideReviewedWith(store, run.terminal, context, [reviewed(0), reviewed(1)], fixed),
      ),
    ).toBe('owner_prompt_cancelled');
    expect(run.labels).toEqual([]);
  });

  it('the session is closed after the batch: the next batch asks for the code again', async () => {
    const { code, store, context } = await ready();
    const run = scripted([code, code], [true, true]);
    await decideReviewedWith(store, run.terminal, context, [reviewed(0), reviewed(1)], fixed);
    await decideReviewedWith(store, run.terminal, context, [reviewed(2), reviewed(3)], fixed);
    expect(run.labels).toEqual(['Owner code:', 'Owner code:']);
    expect(run.handedOut.every(zeroed)).toBe(true);
    expect(captured.seeds.every(zeroed)).toBe(true);
  });
});

describe('KeychainOwnerKeyStore', () => {
  it('is owner_missing without an owner item', async () => {
    const { keys } = newOwnerSeed();
    expect(await codeOf(() => KeychainOwnerKeyStore.open(new FakeKeychain(), keys))).toBe(
      'owner_missing',
    );
  });

  it('refuses an owner item for another owner, even with that item’s own code (04 §2.8)', async () => {
    const keychain = new FakeKeychain();
    const planted = await setUpOwner(keychain); // a seed the card does not name
    const { keys: cardOwner } = newOwnerSeed();
    const store = await KeychainOwnerKeyStore.open(keychain, cardOwner);
    const run = scripted([planted.code]);
    expect(
      await codeOf(() =>
        runOwnerOperation(
          store,
          run.terminal,
          { lines: ['Approve'] },
          { kind: 'owner-action', action: approvalBody(cardOwner) },
        ),
      ),
    ).toBe('presence_rejected');
    expect(captured.seeds.every(zeroed)).toBe(true);
  });

  it('refuses a passkey proof (M1-8e) and wipes it; refuses a damaged item', async () => {
    const keychain = new FakeKeychain();
    const { result } = await setUpOwner(keychain);
    const store = await KeychainOwnerKeyStore.open(keychain, result.owner);
    const prf = new Uint8Array(32).fill(9);
    expect(await codeOf(() => store.unlock({ kind: 'passkey-prf', prfOutput: prf }))).toBe(
      'presence_required',
    );
    expect(zeroed(prf)).toBe(true);
    keychain.items.set(OWNER_ACCOUNT, new Uint8Array(89));
    expect(await codeOf(() => store.secretKind())).toBe('owner_mismatch');
    await store.close();
    expect(await codeOf(() => store.getPublicKeys())).toBe('keystore_closed');
  });

  it('lock() and close() cancel an unlock in flight', async () => {
    const keychain = new FakeKeychain();
    const { result, code } = await setUpOwner(keychain);
    const store = await KeychainOwnerKeyStore.open(keychain, result.owner);
    const pending = store.unlock({ kind: 'passphrase', secret: encodeUtf8(code) });
    await store.lock();
    expect(await codeOf(() => pending)).toBe('owner_locked');
  });
});

describe('the TTY prompt (04 §2.8, 07 §9.2)', () => {
  class FakeTty extends EventEmitter {
    isTTY = true;
    isRaw = false;
    rawCalls: boolean[] = [];
    setRawMode(mode: boolean): this {
      this.rawCalls.push(mode);
      this.isRaw = mode;
      return this;
    }
    resume(): this {
      return this;
    }
    pause(): this {
      return this;
    }
  }
  const fakeOut = () => {
    const out: string[] = [];
    return { out, stream: { isTTY: true, write: (t: string) => out.push(t) } };
  };

  it('refuses a pipe, a redirected output or an input without raw mode', () => {
    const pipe = new PassThrough();
    pipe.end('ABCD EFGH IJKL MNOP QRST UVWX\n');
    const { stream } = fakeOut();
    for (const [input, output] of [
      [pipe, stream],
      [new FakeTty(), { isTTY: false, write: () => true }],
      [Object.assign(new EventEmitter(), { isTTY: true, resume() {}, pause() {} }), stream],
    ] as const) {
      expect(() => ttyOwnerTerminal({ input: input as never, output })).toThrow(
        expect.objectContaining({ code: 'owner_prompt_unavailable' }) as Error,
      );
    }
  });

  it('reads bytes without echo, handles Backspace and escape sequences, restores the mode and wipes chunks', async () => {
    const tty = new FakeTty();
    const { out, stream } = fakeOut();
    const terminal = ttyOwnerTerminal({ input: tty, output: stream });
    const reading = terminal.readSecret('Owner code:');
    const chunks = [
      Buffer.from('abX'),
      Buffer.from([0x7f]),
      Buffer.from('\u001b[Acé'),
      Buffer.from([0x7f]),
      Buffer.from('d\r'),
    ];
    await tick();
    for (const chunk of chunks) tty.emit('data', chunk);
    const secret = await reading;
    expect(new TextDecoder().decode(secret)).toBe('abcd');
    expect(out.join('')).toBe('Owner code: \n');
    expect(tty.rawCalls).toEqual([true, false]);
    expect(chunks.every(zeroed)).toBe(true);
  });

  it('Ctrl-C cancels', async () => {
    const tty = new FakeTty();
    const terminal = ttyOwnerTerminal({ input: tty, output: fakeOut().stream });
    const reading = terminal.readSecret('Owner code:');
    await tick();
    tty.emit('data', Buffer.from([0x61, 0x03]));
    expect(await codeOf(() => reading)).toBe('owner_prompt_cancelled');
    expect(tty.isRaw).toBe(false);
  });

  it('AGENTLINK_OWNER_* variables are ignored: the public operation still needs a terminal', async () => {
    const { keys } = newOwnerSeed();
    const saved = { ...process.env };
    process.env['AGENTLINK_OWNER_CODE'] = 'ABCD EFGH IJKL MNOP QRST UVWX';
    process.env['AGENTLINK_OWNER_PASSPHRASE'] = 'ABCD EFGH IJKL MNOP QRST UVWX';
    // This suite may itself run inside an AI app; the marker guard is tested separately.
    for (const marker of HARNESS_MARKERS) Reflect.deleteProperty(process.env, marker);
    try {
      if (!isatty(0) || !isatty(1)) {
        expect(
          await codeOf(() =>
            performOwnerOperation(keys, {
              kind: 'owner-action',
              action: approvalBody(keys),
              summary: 'Approve',
            }),
          ),
        ).toBe('owner_prompt_unavailable');
        expect(await codeOf(() => decideReviewedApprovals({ agent: AGENT, owner: keys }, []))).toBe(
          'owner_prompt_unavailable',
        );
      }
    } finally {
      process.env = saved;
    }
  });
});
