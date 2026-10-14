// M1-8c acceptance: the build-plan test (10 M1-8) and the on-disk scan (04 §2.2, §2.5, §2.5.2;
// D-67, D-68).
//
// Stated scope (G-1, D-67): a script running as the same OS user, with read access to the agent's
// files, its keychain items (the `owner` item included) and the database, and write access to the
// store and the keychain, that does NOT modify the installed package and does NOT read process
// memory, cannot produce a valid approval or policy change without the owner code, cannot add an
// item to a batch the owner reviewed, and cannot make a signed item cover another action. Outside
// that scope (a modified package, memory reads, a fake prompt) nothing on a same-user machine stops
// it; that residual is accepted for M1 and re-decided at M2-GATE.
//
// The keychain is a file-backed stand-in under the test HOME, readable and writable by the script,
// exactly as the OS keychain is readable by any same-user process. The script runs as a separate
// Node process (test/same-user-script.mjs).
import { execFile } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  KeyStoreError,
  TAGS,
  bip340Verify,
  canonicalizeToBytes,
  decodeBase64url,
  decodeHex,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  sha256,
  taggedHash,
  type JsonObject,
  type OwnerPublicKeys,
} from '@agentlink/crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createKeychainAgent } from './keychain-keystore.js';
import type { KeychainBackend } from './keychain.js';
import { decideReviewedWith, type ReviewedApproval } from './owner-approval.js';
import { initOwnerWith } from './owner-init.js';
import { KeychainOwnerKeyStore } from './owner-keystore.js';
import { runOwnerOperation } from './owner-operation.js';
import type { OwnerTerminal } from './owner-terminal.js';

// Every owner seed opened, copied before it is wiped, so the scan knows what to look for.
const seen = vi.hoisted(() => ({ seeds: [] as Uint8Array[] }));
vi.mock('@agentlink/crypto/keystore', async (importOriginal) => {
  const real = await importOriginal<typeof import('@agentlink/crypto/keystore')>();
  return {
    ...real,
    openOwnerSeed: async (...args: Parameters<typeof real.openOwnerSeed>) => {
      const seed = await real.openOwnerSeed(...args);
      seen.seeds.push(seed.slice());
      return seed;
    },
  };
});

const execFileAsync = promisify(execFile);
const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'same-user-script.mjs');
const root = mkdtempSync(join(tmpdir(), 'agentlink-m1-8c-'));
const home = join(root, 'home');
const keychainFile = join(home, '.keychain-stand-in.json');
const dbFile = join(home, '.agentlink', 'agent.db.json');

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The OS keychain stand-in: one JSON file of base64url values, readable by the same user. */
class FileKeychain implements KeychainBackend {
  #read(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(keychainFile, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }
  get(account: string): Promise<Uint8Array | null> {
    const value = this.#read()[account];
    return Promise.resolve(value === undefined ? null : decodeBase64url(value));
  }
  set(account: string, value: Uint8Array): Promise<void> {
    writeFileSync(
      keychainFile,
      JSON.stringify({ ...this.#read(), [account]: encodeBase64url(value) }),
    );
    return Promise.resolve();
  }
  delete(account: string): Promise<boolean> {
    const items = this.#read();
    const had = account in items;
    Reflect.deleteProperty(items, account);
    writeFileSync(keychainFile, JSON.stringify(items));
    return Promise.resolve(had);
  }
}

function terminal(answers: ((written: string[]) => string)[], confirms: boolean[] = []) {
  const written: string[] = [];
  const t: OwnerTerminal = {
    write: (text) => void written.push(text),
    readSecret: () => {
      const next = answers.shift();
      return next === undefined
        ? Promise.reject(new Error('no answer'))
        : Promise.resolve(encodeUtf8(next(written)));
    },
    confirm: () => Promise.resolve(confirms.shift() ?? false),
    clearScreen: () => void written.push('<clear>'),
  };
  return { terminal: t, written };
}

function ownerSigValid(body: JsonObject, sig: string, owner: OwnerPublicKeys): boolean {
  try {
    const digest = taggedHash(TAGS.ownerAction, sha256(canonicalizeToBytes(body)));
    return bip340Verify(owner.ownerNostr, digest, decodeHex(sig, { length: 64 }));
  } catch {
    return false;
  }
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** True when `needle` occurs in `hay`. */
function contains(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** No file under `dir` holds the seed (raw, hex or base64url) or the owner code (any spelling). */
function scan(dir: string, seeds: readonly Uint8Array[], code: string): string[] {
  const needles = [
    ...seeds.flatMap((s) => [s, encodeUtf8(encodeHex(s)), encodeUtf8(encodeBase64url(s))]),
    encodeUtf8(code),
    encodeUtf8(code.replaceAll(' ', '')),
  ];
  return filesUnder(dir).filter((file) => {
    const bytes = readFileSync(file);
    return needles.some((needle) => contains(bytes, needle));
  });
}

const id = (n: number): string => `apr_${String.fromCharCode(65 + n).repeat(22)}`;

describe('a same-user script cannot approve or change policy (10 M1-8, D-67, D-68)', () => {
  it('holds for approvals, policy changes and batches, within the stated scope', async () => {
    mkdirSync(join(home, '.agentlink'), { recursive: true });
    const keychain = new FileKeychain();
    const agentId = await createKeychainAgent(keychain);

    // The owner sets up the owner key; the code exists only on the owner's terminal.
    const setup = terminal([
      (w) => (w.find((t) => t.startsWith('Your owner code: ')) ?? '').slice(-4),
    ]);
    const { owner } = await initOwnerWith(
      keychain,
      setup.terminal,
      { backend: 'keychain', env: {} },
      { kdf: KDF },
    );
    const code = (setup.written.find((t) => t.startsWith('Your owner code: ')) ?? '').slice(
      'Your owner code: '.length,
    );
    expect(code).toMatch(/^[A-Z2-7 ]{29}$/);

    const ownerHex = encodeHex(owner.ownerNostr);
    const base = {
      v: 1,
      agent: agentId,
      owner: ownerHex,
      issuedAt: 1_760_000_000,
      expiresAt: 1_760_000_600,
    };
    const approval = {
      ...base,
      op: 'approval.decide',
      params: { approvalId: id(0), actionDigest: '11'.repeat(32), decision: 'approve' },
      nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
    };
    const policy = {
      ...base,
      op: 'policy.set',
      params: { version: 2, policy: { contacts: { unknownSender: 'queue' } } },
      nonce: 'AAAAAAAAAAAAAAAAAAAAAQ',
    };

    // Positive control: with the code at the prompt, the owner's signature verifies.
    const store = await KeychainOwnerKeyStore.open(keychain, owner);
    const control = await runOwnerOperation(
      store,
      terminal([() => code]).terminal,
      { lines: ['Approve'] },
      { kind: 'owner-action', action: approval },
    );
    if (control.kind !== 'owner-action') throw new Error('unreachable');
    expect(ownerSigValid(control.signed.body, control.signed.sig, owner)).toBe(true);

    // The owner reviews and signs a batch of two; a third request arrives unreviewed.
    const reviewed = [1, 2].map((n): ReviewedApproval => ({
      approvalId: id(n),
      action: { tool: 'agentlink_send', to: `contact-${String(n)}` },
      decision: 'approve',
      commitment: false,
      summary: `Send a message to Contact ${String(n)}`,
      requestExpiresAt: Math.floor(Date.now() / 1000) + 3_600,
    }));
    const batch = await decideReviewedWith(
      store,
      terminal([() => code], [true]).terminal,
      { agent: agentId, owner },
      reviewed,
    );
    expect(ownerSigValid(batch.body, batch.sig, owner)).toBe(true);

    // The store as the script finds it: pending requests, the signed batch, an unreviewed request.
    writeFileSync(
      dbFile,
      JSON.stringify({
        pending: [{ body: approval }, { body: policy }],
        signedBatch: batch,
        unreviewed: { approvalId: id(3), actionDigest: '33'.repeat(32) },
      }),
    );

    // No owner-seed bytes and no owner code on disk after setup and after the operations.
    expect(seen.seeds.length).toBeGreaterThan(0);
    expect(scan(home, seen.seeds, code)).toEqual([]);

    // The script, as a separate same-user process, with AGENTLINK_OWNER_* set to guesses.
    const jobFile = join(root, 'job.json');
    const outFile = join(root, 'script-result.json');
    writeFileSync(
      jobFile,
      JSON.stringify({
        home,
        keychainFile,
        dbFile,
        agentId,
        owner: { ownerEvm: encodeHex(owner.ownerEvm), ownerNostr: ownerHex },
        outFile,
      }),
    );
    type ScriptResult = {
      attempts: { name: string; body: JsonObject; sig: string }[];
      opened: number;
      guesses: number;
      plantedCode: string;
    };
    const runScript = async (ownerCodeGuess: string): Promise<ScriptResult> => {
      await execFileAsync(process.execPath, [SCRIPT, jobFile], {
        env: {
          ...process.env,
          HOME: home,
          AGENTLINK_OWNER_CODE: ownerCodeGuess,
          AGENTLINK_OWNER_PASSPHRASE: 'not the owner passphrase',
        },
      });
      return JSON.parse(readFileSync(outFile, 'utf8')) as ScriptResult;
    };

    // Harness control (the test is not vacuous): a script that HAS the owner code does produce
    // valid owner signatures. The keychain stand-in is restored after its plant.
    const keychainBefore = readFileSync(keychainFile);
    const leaked = await runScript(code);
    expect(leaked.opened).toBe(1);
    expect(leaked.attempts.some((a) => ownerSigValid(a.body, a.sig, owner))).toBe(true);
    writeFileSync(keychainFile, keychainBefore);

    const result = await runScript('AAAA BBBB CCCC DDDD EEEE FFFF');
    expect(result.opened).toBe(0);
    expect(result.guesses).toBeGreaterThanOrEqual(6);
    expect(result.attempts.length).toBeGreaterThan(20);
    const valid = result.attempts.filter((a) => ownerSigValid(a.body, a.sig, owner));
    expect(valid.map((a) => a.name)).toEqual([]);
    expect(result.attempts.some((a) => a.name.startsWith('batch'))).toBe(true);
    expect(result.attempts.some((a) => (a.body['op'] as string) === 'policy.set')).toBe(true);

    // The planted owner item (the script's own seed under its own code) never unlocks for this
    // agent's owner, neither with the script's code nor with the owner's.
    for (const typed of [result.plantedCode, code]) {
      const error = await runOwnerOperation(
        store,
        terminal([() => typed]).terminal,
        { lines: ['Approve'] },
        { kind: 'owner-action', action: approval },
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(KeyStoreError);
      expect((error as KeyStoreError).code).toBe('presence_rejected');
    }
    await store.close();
  }, 120_000);
});
