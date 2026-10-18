// M1-8e acceptance: the localhost passkey (WebAuthn PRF) path of the OwnerKeyStore (04 §2.2,
// §2.3.1, §2.5; 08 §1; D-79, D-82; I-1, I-4).
//
// - Registration is its own owner operation on the localhost page: one entry of the owner code
//   opens the `ALKO` owner item, the seed is sealed as `ALKP` v1 under the passkey's PRF output and
//   stored as the keychain item `owner-passkey`; the `owner` item is unchanged; the seed, the owner
//   code and the PRF output are wiped. One passkey per OS user in M1b: a second is refused.
// - Unlock: the `passkey-prf` presence opens `owner-passkey` for exactly one owner operation; a
//   wrong credential, a tampered blob, another owner and the other blob types (ALKO, ALKR, ALKS)
//   are one refusal, and the owner code path keeps working.
// - The assertion the page sends must name the stored credential, the owner as user handle, the
//   RP ID `localhost` (rpIdHash) and the UP and UV flags; anything else is refused before unlock.
// - The deferred M1-31 acceptance: a test registers and uses a PRF passkey on
//   `http://localhost:<port>`, and requests with any other Host value are rejected.
// - A PRF-less authenticator stores nothing and the owner code still decides.
// - No owner-seed or PRF bytes on disk after setup and after an operation (scan); the M1-8c
//   same-user script with the passkey path enabled cannot approve without the PRF output.
// The authenticator is the virtual one of passkey-authenticator.fixture.ts (no hardware).
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  KeyStoreError,
  TAGS,
  bip340Verify,
  canonicalizeToBytes,
  concatBytes,
  decodeBase64url,
  decodeHex,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  ownerPrfSalt,
  randomBytes,
  readPasskeyBlobHeader,
  sha256,
  taggedHash,
  type JsonObject,
  type JsonValue,
  type OwnerPublicKeys,
} from '@agentlink/crypto';
import {
  sealPasskeySeed,
  sealRecoverySeed,
  generateRecoveryCode,
} from '@agentlink/crypto/keystore';
import type { OwnerActionOutcome } from '@agentlink/core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { APP_JS } from './approval-page.js';
import {
  MAX_PRESENCE_BACKOFF_S,
  startApprovalServerWith,
  type ApprovalForDecision,
  type ApprovalServer,
  type ApprovalServerEvent,
  type ApprovalServerSource,
} from './approval-server.js';
import { createKeychainAgent } from './keychain-keystore.js';
import type { KeychainBackend } from './keychain.js';
import { initOwnerWith } from './owner-init.js';
import { KeychainOwnerKeyStore, OWNER_ACCOUNT } from './owner-keystore.js';
import {
  OWNER_PASSKEY_ACCOUNT,
  PASSKEY_RP_ID,
  authenticatorDataOk,
  encodePasskeyAssertion,
  encodePasskeyRegistration,
  parsePasskeyAssertion,
  readOwnerPasskeyHeader,
  registerOwnerPasskey,
  type PasskeyAssertion,
} from './owner-passkey.js';
import type { OwnerTerminal } from './owner-terminal.js';
import { VirtualPrfAuthenticator } from './passkey-authenticator.fixture.js';

// Every owner seed opened, copied before it is wiped, so the scan knows what to look for.
const seen = vi.hoisted(() => ({ seeds: [] as Uint8Array[], prfs: [] as Uint8Array[] }));
vi.mock('@agentlink/crypto/keystore', async (importOriginal) => {
  const real = await importOriginal<typeof import('@agentlink/crypto/keystore')>();
  return {
    ...real,
    openOwnerSeed: async (...args: Parameters<typeof real.openOwnerSeed>) => {
      const seed = await real.openOwnerSeed(...args);
      seen.seeds.push(seed.slice());
      return seed;
    },
    openPasskeySeed: async (...args: Parameters<typeof real.openPasskeySeed>) => {
      seen.prfs.push(args[1].slice());
      const seed = await real.openPasskeySeed(...args);
      seen.seeds.push(seed.slice());
      return seed;
    },
  };
});

const execFileAsync = promisify(execFile);
const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'approval-passkey-script.mjs',
);
const root = mkdtempSync(join(tmpdir(), 'agentlink-m1-8e-'));
const home = join(root, 'home');
const keychainFile = join(root, 'keychain-stand-in.json');

/** The OS keychain stand-in: one JSON file, readable and writable by the same user. */
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

const keychain = new FileKeychain();
let agentId = '';
let owner: OwnerPublicKeys;
let code = '';
const salt = ownerPrfSalt();

beforeAll(async () => {
  agentId = await createKeychainAgent(keychain);
  const written: string[] = [];
  const setup: OwnerTerminal = {
    write: (text) => void written.push(text),
    readSecret: () =>
      Promise.resolve(
        encodeUtf8((written.find((t) => t.startsWith('Your owner code: ')) ?? '').slice(-4)),
      ),
    confirm: () => Promise.resolve(true),
    clearScreen: () => undefined,
  };
  ({ owner } = await initOwnerWith(
    keychain,
    setup,
    { backend: 'keychain', env: {} },
    { kdf: KDF },
  ));
  code = (written.find((t) => t.startsWith('Your owner code: ')) ?? '').slice(
    'Your owner code: '.length,
  );
  expect(code).toMatch(/^[A-Z2-7 ]{29}$/);
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await keychain.delete(OWNER_PASSKEY_ACCOUNT);
  vi.restoreAllMocks();
});

const id = (n: number): string => `apr_${String.fromCharCode(65 + n).repeat(22)}`;
const digestOf = (action: JsonValue): string => encodeHex(sha256(canonicalizeToBytes(action)));

function ownerSigValid(body: JsonObject, sig: string): boolean {
  try {
    const digest = taggedHash(TAGS.ownerAction, sha256(canonicalizeToBytes(body)));
    return bip340Verify(owner.ownerNostr, digest, decodeHex(sig, { length: 64 }));
  } catch {
    return false;
  }
}

const ownerCode = (): Uint8Array => encodeUtf8(code);

/** Registers `auth` directly (the node API behind the page's setup step). */
async function register(auth: VirtualPrfAuthenticator): Promise<void> {
  await registerOwnerPasskey(keychain, owner, ownerCode(), auth.create(owner.ownerNostr, salt));
}

async function expectCode(promise: Promise<unknown>, codeName: string): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeDefined();
  expect((error as { code?: unknown }).code).toBe(codeName);
}

// --- Assertion format and checks -------------------------------------------------------------------

describe('the assertion the page sends (04 §2.3.1; proposed, owner confirms at merge)', () => {
  it('names RP ID localhost', () => {
    expect(PASSKEY_RP_ID).toBe('localhost');
    expect(OWNER_PASSKEY_ACCOUNT).toBe('owner-passkey');
  });

  it('accepts authenticator data for localhost with UP and UV, and nothing else', () => {
    const ok = new VirtualPrfAuthenticator().create(owner.ownerNostr, salt);
    expect(authenticatorDataOk(ok.authenticatorData)).toBe(true);
    for (const options of [
      { rpId: '127.0.0.1' },
      { rpId: '[::1]' },
      { rpId: 'evil.example' },
      { rpId: 'localhost.' },
      { up: false },
      { uv: false },
    ]) {
      const a = new VirtualPrfAuthenticator(options).create(owner.ownerNostr, salt);
      expect(authenticatorDataOk(a.authenticatorData)).toBe(false);
    }
    expect(authenticatorDataOk(ok.authenticatorData.slice(0, 36))).toBe(false);
    expect(authenticatorDataOk(new Uint8Array(0))).toBe(false);
  });

  it('round-trips the binary body and refuses malformed ones', () => {
    const a = new VirtualPrfAuthenticator().create(owner.ownerNostr, salt);
    const parsed = parsePasskeyAssertion(encodePasskeyAssertion(a));
    expect(parsed.credentialId).toEqual(a.credentialId);
    expect(parsed.authenticatorData).toEqual(a.authenticatorData);
    expect(parsed.userHandle).toEqual(a.userHandle);
    expect(parsed.prfOutput).toEqual(a.prfOutput);
    const body = encodePasskeyAssertion(a);
    for (const bad of [
      new Uint8Array(0),
      body.slice(0, body.length - 1),
      concatBytes(body, new Uint8Array([0])),
      concatBytes(new Uint8Array([0x04, 0x00]), new Uint8Array(1024)),
    ]) {
      expect(() => parsePasskeyAssertion(bad)).toThrow(KeyStoreError);
    }
    // A credential ID over 1023 bytes is refused (04 §2.3.1).
    expect(() =>
      parsePasskeyAssertion(encodePasskeyAssertion({ ...a, credentialId: new Uint8Array(1024) })),
    ).toThrow(KeyStoreError);
  });
});

// --- Registration ----------------------------------------------------------------------------------

describe('registering the localhost passkey: one owner operation (04 §2.2, §2.3.1)', () => {
  it('stores the owner seed as ALKP v1 under owner-passkey, naming that credential', async () => {
    const ownerBefore = await keychain.get(OWNER_ACCOUNT);
    const auth = new VirtualPrfAuthenticator();
    await register(auth);
    const blob = await keychain.get(OWNER_PASSKEY_ACCOUNT);
    if (blob === null) throw new Error('no owner-passkey item');
    expect(blob.length).toBe(100 + auth.credentialId.length);
    expect([...blob.slice(0, 4)]).toEqual([...encodeUtf8('ALKP')]);
    const header = readPasskeyBlobHeader(blob);
    expect(header.credentialId).toEqual(auth.credentialId);
    expect(header.ownerNostr).toEqual(owner.ownerNostr);
    expect(await readOwnerPasskeyHeader(keychain)).toEqual(header);
    // The owner code path is unchanged: the `owner` item is byte-identical.
    expect(await keychain.get(OWNER_ACCOUNT)).toEqual(ownerBefore);
  });

  it('wipes the owner code and the PRF output it was given', async () => {
    const auth = new VirtualPrfAuthenticator();
    const assertion = auth.create(owner.ownerNostr, salt);
    const secret = ownerCode();
    const prf = assertion.prfOutput;
    await registerOwnerPasskey(keychain, owner, secret, assertion);
    expect(secret.every((b) => b === 0)).toBe(true);
    expect(prf.every((b) => b === 0)).toBe(true);
  });

  it('refuses a wrong owner code and stores nothing (presence_rejected)', async () => {
    const auth = new VirtualPrfAuthenticator();
    const assertion = auth.create(owner.ownerNostr, salt);
    await expectCode(
      registerOwnerPasskey(keychain, owner, encodeUtf8('AAAA BBBB CCCC DDDD EEEE FFFF'), assertion),
      'presence_rejected',
    );
    expect(assertion.prfOutput.every((b) => b === 0)).toBe(true);
    expect(await keychain.get(OWNER_PASSKEY_ACCOUNT)).toBeNull();
  });

  it('keeps one passkey per OS user in M1b: a second registration is refused', async () => {
    const first = new VirtualPrfAuthenticator();
    await register(first);
    const before = await keychain.get(OWNER_PASSKEY_ACCOUNT);
    await expectCode(register(new VirtualPrfAuthenticator()), 'owner_passkey_exists');
    expect(await keychain.get(OWNER_PASSKEY_ACCOUNT)).toEqual(before);
  });

  it('a PRF-less authenticator stores nothing (passkey_unsupported)', async () => {
    const auth = new VirtualPrfAuthenticator({ prf: false });
    await expectCode(
      registerOwnerPasskey(keychain, owner, ownerCode(), auth.create(owner.ownerNostr, salt)),
      'passkey_unsupported',
    );
    expect(await keychain.get(OWNER_PASSKEY_ACCOUNT)).toBeNull();
  });

  it('refuses another RP ID, missing UP or UV, and a user handle that is not the owner', async () => {
    for (const options of [{ rpId: '127.0.0.1' }, { up: false }, { uv: false }]) {
      const a = new VirtualPrfAuthenticator(options).create(owner.ownerNostr, salt);
      await expectCode(registerOwnerPasskey(keychain, owner, ownerCode(), a), 'presence_rejected');
    }
    const other = new VirtualPrfAuthenticator().create(randomBytes(32), salt);
    await expectCode(
      registerOwnerPasskey(keychain, owner, ownerCode(), other),
      'presence_rejected',
    );
    expect(await keychain.get(OWNER_PASSKEY_ACCOUNT)).toBeNull();
  });

  it('refuses for an agent whose card names another owner', async () => {
    const other: OwnerPublicKeys = { ...owner, ownerEvm: new Uint8Array(20).fill(1) };
    const a = new VirtualPrfAuthenticator().create(owner.ownerNostr, salt);
    await expectCode(registerOwnerPasskey(keychain, other, ownerCode(), a), 'presence_rejected');
    expect(await keychain.get(OWNER_PASSKEY_ACCOUNT)).toBeNull();
  });
});

// --- Unlock ----------------------------------------------------------------------------------------

describe('unlocking with the passkey PRF (04 §2.3.1, §2.5)', () => {
  const action = (): JsonObject => ({
    v: 1,
    agent: agentId,
    owner: encodeHex(owner.ownerNostr),
    op: 'approval.decide',
    params: { approvalId: id(1), actionDigest: '0'.repeat(64), decision: 'deny' },
    nonce: encodeBase64url(randomBytes(16)),
    issuedAt: 1,
    expiresAt: 2,
  });

  it('opens the owner key for one session with the registered passkey, and wipes the PRF', async () => {
    const auth = new VirtualPrfAuthenticator();
    await register(auth);
    const store = await KeychainOwnerKeyStore.open(keychain, owner);
    const prf = auth.get(salt).prfOutput;
    const session = await store.unlock({ kind: 'passkey-prf', prfOutput: prf });
    expect(prf.every((b) => b === 0)).toBe(true);
    const body = action();
    expect(ownerSigValid(body, await session.signOwnerAction(body))).toBe(true);
    await session.close();
    await expect(session.signOwnerAction(action())).rejects.toMatchObject({
      code: 'owner_locked',
    });
    await store.close();
  });

  it('refuses a wrong credential, without a passkey item, and a non-32-byte PRF', async () => {
    const store = await KeychainOwnerKeyStore.open(keychain, owner);
    const other = new VirtualPrfAuthenticator();
    other.create(owner.ownerNostr, salt);
    await expect(
      store.unlock({ kind: 'passkey-prf', prfOutput: other.get(salt).prfOutput }),
    ).rejects.toMatchObject({ code: 'presence_rejected' });
    await register(new VirtualPrfAuthenticator());
    await expect(
      store.unlock({ kind: 'passkey-prf', prfOutput: other.get(salt).prfOutput }),
    ).rejects.toMatchObject({ code: 'presence_rejected' });
    await expect(
      store.unlock({ kind: 'passkey-prf', prfOutput: new Uint8Array(31) }),
    ).rejects.toBeInstanceOf(KeyStoreError);
    await store.close();
  });

  it('refuses a tampered blob: every byte position', async () => {
    const auth = new VirtualPrfAuthenticator();
    await register(auth);
    const blob = await keychain.get(OWNER_PASSKEY_ACCOUNT);
    if (blob === null) throw new Error('unreachable');
    const store = await KeychainOwnerKeyStore.open(keychain, owner);
    const positions = [0, 4, 5, 6, 38, 39, 40, blob.length - 45, blob.length - 20, blob.length - 1];
    for (const at of positions) {
      const bad = blob.slice();
      bad[at] = (bad[at] as number) ^ 0x01;
      await keychain.set(OWNER_PASSKEY_ACCOUNT, bad);
      await expect(
        store.unlock({ kind: 'passkey-prf', prfOutput: auth.get(salt).prfOutput }),
      ).rejects.toMatchObject({ code: 'presence_rejected' });
    }
    await keychain.set(OWNER_PASSKEY_ACCOUNT, blob.slice(0, blob.length - 1));
    await expect(
      store.unlock({ kind: 'passkey-prf', prfOutput: auth.get(salt).prfOutput }),
    ).rejects.toMatchObject({ code: 'presence_rejected' });
    await store.close();
  });

  it('refuses a planted ALKP blob of another owner under that passkey', async () => {
    const auth = new VirtualPrfAuthenticator();
    const planted = await sealPasskeySeed(
      auth.create(owner.ownerNostr, salt).prfOutput,
      randomBytes(32),
      auth.credentialId,
    );
    await keychain.set(OWNER_PASSKEY_ACCOUNT, planted);
    const store = await KeychainOwnerKeyStore.open(keychain, owner);
    await expect(
      store.unlock({ kind: 'passkey-prf', prfOutput: auth.get(salt).prfOutput }),
    ).rejects.toMatchObject({ code: 'presence_rejected' });
    await store.close();
  });

  it('refuses the other blob types under owner-passkey, and ALKP under owner (cross-type)', async () => {
    const auth = new VirtualPrfAuthenticator();
    await register(auth);
    const alkp = await keychain.get(OWNER_PASSKEY_ACCOUNT);
    const alko = await keychain.get(OWNER_ACCOUNT);
    if (alkp === null || alko === null) throw new Error('unreachable');
    const store = await KeychainOwnerKeyStore.open(keychain, owner);
    const recoveryCode = generateRecoveryCode();
    const alkr = await sealRecoverySeed(recoveryCode, randomBytes(32), KDF);
    const renamed = (magic: string): Uint8Array => {
      const out = alkp.slice();
      out.set(encodeUtf8(magic), 0);
      return out;
    };
    for (const blob of [alko, alkr, renamed('ALKO'), renamed('ALKR'), renamed('ALKS')]) {
      await keychain.set(OWNER_PASSKEY_ACCOUNT, blob);
      await expect(
        store.unlock({ kind: 'passkey-prf', prfOutput: auth.get(salt).prfOutput }),
      ).rejects.toMatchObject({ code: 'presence_rejected' });
    }
    // The ALKP blob in the `owner` item never opens with the owner code.
    await keychain.set(OWNER_ACCOUNT, alkp);
    try {
      await expect(
        KeychainOwnerKeyStore.open(keychain, owner).then((s) =>
          s.unlock({ kind: 'passphrase', secret: ownerCode() }),
        ),
      ).rejects.toBeInstanceOf(Error);
    } finally {
      await keychain.set(OWNER_ACCOUNT, alko);
    }
    await store.close();
  });

  it('keeps the owner code path working after a passkey is registered', async () => {
    await register(new VirtualPrfAuthenticator());
    const store = await KeychainOwnerKeyStore.open(keychain, owner);
    const session = await store.unlock({ kind: 'passphrase', secret: ownerCode() });
    const body = action();
    expect(ownerSigValid(body, await session.signOwnerAction(body))).toBe(true);
    await store.close();
  });

  it('never unlocks a card-less owner store with a passkey (owner add-agent stays code-only)', async () => {
    const auth = new VirtualPrfAuthenticator();
    await register(auth);
    await expect(
      KeychainOwnerKeyStore.unlockWithoutCard(
        keychain,
        { kind: 'passkey-prf', prfOutput: auth.get(salt).prfOutput },
        () => Promise.resolve(true),
      ),
    ).rejects.toMatchObject({ code: 'presence_required' });
  });
});

// --- The approval server on http://localhost:<port> (M1-31 deferred acceptance) --------------------

function fakeSource(): ApprovalServerSource & {
  readonly applied: { body: JsonObject; sig: string }[];
  add(n: number): ApprovalForDecision;
} {
  const rows = new Map<string, ApprovalForDecision>();
  const nonces = new Set<string>();
  const applied: { body: JsonObject; sig: string }[] = [];
  return {
    applied,
    add(n) {
      const act = { tool: 'agentlink_send', to: `contact-${String(n)}`, text: 'hello' };
      const row: ApprovalForDecision = {
        approvalId: id(n),
        summary: `Send a message to Contact ${String(n)}`,
        actionDigest: digestOf(act),
        storedDigest: digestOf(act),
        action: act,
        expiresAt: Math.floor(Date.now() / 1000) + 3_600,
        commitment: false,
      };
      rows.set(row.approvalId, row);
      return row;
    },
    context: () => Promise.resolve({ agent: agentId, owner }),
    list: () => Promise.resolve([...rows.values()]),
    get: (approvalId) => Promise.resolve(rows.get(approvalId)),
    apply: (signed) => {
      const params = signed.body['params'] as Record<string, unknown> | undefined;
      const row = rows.get(String(params?.['approvalId']));
      const refused = { status: 'refused', op: 'approval.decide' } as never as OwnerActionOutcome;
      if (!ownerSigValid(signed.body, signed.sig) || row === undefined) {
        return Promise.resolve(refused);
      }
      if (signed.body['agent'] !== agentId || params?.['actionDigest'] !== row.storedDigest) {
        return Promise.resolve(refused);
      }
      const nonce = String(signed.body['nonce']);
      if (nonces.has(nonce)) return Promise.resolve(refused);
      nonces.add(nonce);
      rows.delete(row.approvalId);
      applied.push(signed);
      return Promise.resolve({ status: 'applied', op: 'approval.decide' } as OwnerActionOutcome);
    },
  };
}

interface Response {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function send(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: Uint8Array } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: { Host: `localhost:${String(port)}`, ...options.headers },
        setHost: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

interface Harness {
  readonly server: ApprovalServer;
  readonly source: ReturnType<typeof fakeSource>;
  readonly port: number;
  readonly origin: string;
  readonly events: ApprovalServerEvent[];
  readonly page: Record<string, string>;
  /** The server's clock (ms): tests step past the M1-11a wrong-code backoff with it. */
  readonly clock: { ms: number };
}

/** Steps the clock past the longest M1-11a backoff, so each refused case is checked on its own. */
const pastBackoff = (h: Harness): void => {
  h.clock.ms += MAX_PRESENCE_BACKOFF_S * 1000 + 1;
};

/** `clockStep`: ms the clock moves on every read (a control that steps past every backoff). */
async function harness(clockStep = 0): Promise<Harness> {
  const source = fakeSource();
  const events: ApprovalServerEvent[] = [];
  const opened: string[] = [];
  const clock = { ms: Date.now() };
  const server = await startApprovalServerWith(
    { source, onEvent: (e) => void events.push(e) },
    {
      keychain,
      openOwnerStore: (expected) => KeychainOwnerKeyStore.open(keychain, expected),
      opener: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      notifier: () => Promise.resolve(true),
      now: () => (clock.ms += clockStep),
    },
  );
  servers.push(server);
  await server.open();
  const token = new URL(opened[0] ?? '').searchParams.get('t') ?? '';
  const port = server.port;
  const first = await send(port, `/?t=${token}`);
  const cookie = (first.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
  const shell = await send(port, '/', { headers: { Cookie: cookie } });
  const csrf = /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(shell.body)?.[1];
  return {
    server,
    source,
    port,
    origin: server.origin,
    events,
    clock,
    page: {
      Cookie: cookie,
      Origin: server.origin,
      'Content-Type': 'application/octet-stream',
      'X-AgentLink-CSRF': csrf ?? '',
      'Sec-Fetch-Site': 'same-origin',
    },
  };
}

function passkeyInfo(h: Harness): Promise<Response> {
  return send(h.port, '/api/owner/passkey', { headers: h.page });
}

function registerVia(
  h: Harness,
  secret: string,
  assertion: PasskeyAssertion,
  headers: Record<string, string> = {},
): Promise<Response> {
  return send(h.port, '/api/owner/passkey', {
    method: 'POST',
    headers: { ...h.page, ...headers },
    body: encodePasskeyRegistration(encodeUtf8(secret), assertion),
  });
}

async function decideVia(
  h: Harness,
  approvalId: string,
  decision: 'approve' | 'deny',
  assertion: PasskeyAssertion,
  headers: Record<string, string> = {},
): Promise<Response> {
  const row = await h.source.get(approvalId);
  return send(h.port, `/api/approvals/${approvalId}/${decision}`, {
    method: 'POST',
    headers: {
      ...h.page,
      'X-AgentLink-Digest': row?.actionDigest ?? '0'.repeat(64),
      'X-AgentLink-Presence': 'passkey',
      ...headers,
    },
    body: encodePasskeyAssertion(assertion),
  });
}

describe('the passkey on http://localhost:<port> (M1-31, D-79; 08 §1)', () => {
  it('serves the public registration data: RP ID localhost, user.id = owner key, PRF salt', async () => {
    const h = await harness();
    const before = await passkeyInfo(h);
    expect(before.status).toBe(200);
    expect(JSON.parse(before.body)).toEqual({
      passkey: {
        registered: false,
        rpId: 'localhost',
        userId: encodeBase64url(owner.ownerNostr),
        prfSalt: encodeBase64url(salt),
      },
    });
    // Viewing needs the session like every API call.
    const anonymous = await send(h.port, '/api/owner/passkey');
    expect(anonymous.status).toBe(401);
  });

  it('registers a PRF passkey and approves with it on that origin', async () => {
    const h = await harness();
    const auth = new VirtualPrfAuthenticator();
    const reg = await registerVia(h, code, auth.create(owner.ownerNostr, salt));
    expect(reg.status).toBe(200);
    expect(JSON.parse(reg.body)).toEqual({ status: 'registered' });
    const info = JSON.parse((await passkeyInfo(h)).body) as { passkey: Record<string, unknown> };
    expect(info.passkey['registered']).toBe(true);
    expect(info.passkey['credentialId']).toBe(encodeBase64url(auth.credentialId));

    const row = h.source.add(1);
    const res = await decideVia(h, id(1), 'approve', auth.get(salt));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'applied', decision: 'approve' });
    const signed = h.source.applied[0];
    if (signed === undefined) throw new Error('unreachable');
    expect(ownerSigValid(signed.body, signed.sig)).toBe(true);
    expect(signed.body['op']).toBe('approval.decide');
    expect(signed.body['params']).toEqual({
      approvalId: id(1),
      actionDigest: row.storedDigest,
      decision: 'approve',
    });
    // One gesture, one owner operation: the same ID is not decided again.
    h.source.add(1);
    expect((await decideVia(h, id(1), 'approve', auth.get(salt))).status).toBe(409);
    expect(h.source.applied).toHaveLength(1);
    // Denying with the passkey works the same way.
    h.source.add(2);
    const deny = await decideVia(h, id(2), 'deny', auth.get(salt));
    expect(JSON.parse(deny.body)).toEqual({ status: 'applied', decision: 'deny' });
  });

  it('rejects registration and decisions with any other Host value', async () => {
    const h = await harness();
    const auth = new VirtualPrfAuthenticator();
    for (const host of [
      `127.0.0.1:${String(h.port)}`,
      `[::1]:${String(h.port)}`,
      `LOCALHOST:${String(h.port)}`,
      'evil.example',
    ]) {
      const reg = await registerVia(h, code, auth.create(owner.ownerNostr, salt), { Host: host });
      expect(reg.status).toBe(403);
    }
    expect(await keychain.get(OWNER_PASSKEY_ACCOUNT)).toBeNull();
    expect((await registerVia(h, code, auth.create(owner.ownerNostr, salt))).status).toBe(200);
    h.source.add(1);
    const wrongHost = await decideVia(h, id(1), 'approve', auth.get(salt), {
      Host: `127.0.0.1:${String(h.port)}`,
    });
    expect(wrongHost.status).toBe(403);
    expect(h.source.applied).toEqual([]);
  });

  it('refuses an assertion made for another RP ID, or without UP or UV', async () => {
    const h = await harness();
    const auth = new VirtualPrfAuthenticator();
    expect((await registerVia(h, code, auth.create(owner.ownerNostr, salt))).status).toBe(200);
    h.source.add(1);
    const good = auth.get(salt);
    const flags = (value: number): PasskeyAssertion => {
      const data = good.authenticatorData.slice();
      data[32] = value;
      return { ...auth.get(salt), authenticatorData: data };
    };
    const otherRp = {
      ...auth.get(salt),
      authenticatorData: concatBytes(
        sha256(encodeUtf8('127.0.0.1')),
        good.authenticatorData.slice(32),
      ),
    };
    for (const bad of [otherRp, flags(0x04), flags(0x01), flags(0x00)]) {
      pastBackoff(h);
      const res = await decideVia(h, id(1), 'approve', bad);
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ status: 'presence_rejected' });
    }
    expect(h.source.applied).toEqual([]);
  });

  it('refuses a wrong credential: another passkey, another credential ID, another user', async () => {
    const h = await harness();
    const auth = new VirtualPrfAuthenticator();
    expect((await registerVia(h, code, auth.create(owner.ownerNostr, salt))).status).toBe(200);
    const other = new VirtualPrfAuthenticator();
    other.create(owner.ownerNostr, salt);
    h.source.add(1);
    const cases: PasskeyAssertion[] = [
      // Another passkey, honest about its credential ID.
      other.get(salt),
      // Another passkey's PRF claiming the registered credential ID.
      { ...other.get(salt), credentialId: auth.credentialId.slice() },
      // The right PRF under a different credential ID.
      { ...auth.get(salt), credentialId: other.credentialId.slice() },
      // The right PRF with a user handle that is not the owner.
      { ...auth.get(salt), userHandle: randomBytes(32) },
    ];
    for (const bad of cases) {
      pastBackoff(h);
      const res = await decideVia(h, id(1), 'approve', bad);
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ status: 'presence_rejected' });
    }
    expect(h.source.applied).toEqual([]);
  });

  it('a PRF-less authenticator registers nothing and the owner code still decides', async () => {
    const h = await harness();
    const plain = new VirtualPrfAuthenticator({ prf: false });
    const reg = await registerVia(h, code, plain.create(owner.ownerNostr, salt));
    expect(reg.status).toBe(422);
    expect(JSON.parse(reg.body)).toEqual({ status: 'passkey_unsupported' });
    expect(await keychain.get(OWNER_PASSKEY_ACCOUNT)).toBeNull();
    h.source.add(1);
    const noPrf = await decideVia(h, id(1), 'approve', plain.get(salt));
    expect(noPrf.status).toBe(403);
    expect(JSON.parse(noPrf.body)).toMatchObject({ status: 'presence_required' });
    const row = await h.source.get(id(1));
    const viaCode = await send(h.port, `/api/approvals/${id(1)}/approve`, {
      method: 'POST',
      headers: { ...h.page, 'X-AgentLink-Digest': row?.actionDigest ?? '' },
      body: encodeUtf8(code),
    });
    expect(viaCode.status).toBe(200);
    expect(h.source.applied).toHaveLength(1);
  });

  it('refuses a passkey decision before any passkey is registered', async () => {
    const h = await harness();
    const auth = new VirtualPrfAuthenticator();
    auth.create(owner.ownerNostr, salt);
    h.source.add(1);
    const res = await decideVia(h, id(1), 'approve', auth.get(salt));
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ status: 'presence_rejected' });
  });

  it('registration needs the owner code, and a second passkey is refused', async () => {
    const h = await harness();
    const auth = new VirtualPrfAuthenticator();
    const wrong = await registerVia(
      h,
      'AAAA BBBB CCCC DDDD EEEE FFFF',
      auth.create(owner.ownerNostr, salt),
    );
    expect(wrong.status).toBe(403);
    expect(JSON.parse(wrong.body)).toEqual({ status: 'presence_rejected' });
    const none = await registerVia(h, '', auth.create(owner.ownerNostr, salt));
    expect(none.status).toBe(403);
    expect(JSON.parse(none.body)).toEqual({ status: 'presence_required' });
    expect(await keychain.get(OWNER_PASSKEY_ACCOUNT)).toBeNull();
    expect((await registerVia(h, code, auth.create(owner.ownerNostr, salt))).status).toBe(200);
    const second = await registerVia(
      h,
      code,
      new VirtualPrfAuthenticator().create(owner.ownerNostr, salt),
    );
    expect(second.status).toBe(409);
    expect(JSON.parse(second.body)).toEqual({ status: 'passkey_exists' });
  });

  it('refuses a registration without the page Origin, CSRF token or content type', async () => {
    const h = await harness();
    const auth = new VirtualPrfAuthenticator();
    const make = (): PasskeyAssertion => auth.create(owner.ownerNostr, salt);
    expect((await registerVia(h, code, make(), { Origin: 'http://evil.example' })).status).toBe(
      403,
    );
    expect((await registerVia(h, code, make(), { 'X-AgentLink-CSRF': 'wrong' })).status).toBe(403);
    expect((await registerVia(h, code, make(), { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect(await keychain.get(OWNER_PASSKEY_ACCOUNT)).toBeNull();
  });

  it('emits fixed passkey events only', async () => {
    const h = await harness();
    const auth = new VirtualPrfAuthenticator();
    await registerVia(h, code, auth.create(owner.ownerNostr, salt));
    expect(h.events).toContainEqual({ kind: 'passkey', outcome: 'registered' });
    const text = JSON.stringify(h.events);
    expect(text.includes(encodeBase64url(auth.credentialId))).toBe(false);
  });
});

// --- The page script ---------------------------------------------------------------------------------

describe('the page asks for the passkey only after a click (11 §6.2.1)', () => {
  it('uses RP ID localhost, the PRF extension, user verification and the stored credential', () => {
    expect(APP_JS).toContain("rpId: 'localhost'");
    expect(APP_JS).toContain("id: 'localhost'");
    expect(APP_JS).toContain("userVerification: 'required'");
    expect(APP_JS).toContain("residentKey: 'required'");
    expect(APP_JS).toContain('allowCredentials');
    expect(APP_JS).toContain('prf');
    expect(APP_JS).toContain("'X-AgentLink-Presence': 'passkey'");
    expect(APP_JS).toContain('/api/owner/passkey');
  });
});

// --- On-disk scan and the same-user script -----------------------------------------------------------

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() ? [path] : [];
  });
}

function containsBytes(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

describe('no owner-seed or PRF bytes on disk (04 §2.2, §8 rule 3)', () => {
  it('after passkey setup and after an operation', async () => {
    seen.seeds.length = 0;
    seen.prfs.length = 0;
    const h = await harness();
    const auth = new VirtualPrfAuthenticator();
    const created = auth.create(owner.ownerNostr, salt);
    const prfCopy = created.prfOutput.slice();
    expect((await registerVia(h, code, created)).status).toBe(200);
    h.source.add(1);
    expect((await decideVia(h, id(1), 'approve', auth.get(salt))).status).toBe(200);
    expect(seen.seeds.length).toBeGreaterThanOrEqual(2);
    const needles = [...seen.seeds, ...seen.prfs, prfCopy];
    const forms = (b: Uint8Array): Uint8Array[] => [
      b,
      encodeUtf8(encodeHex(b)),
      encodeUtf8(encodeBase64url(b)),
      encodeUtf8(Buffer.from(b).toString('base64')),
    ];
    for (const file of filesUnder(root)) {
      const bytes = new Uint8Array(readFileSync(file));
      for (const needle of needles) {
        for (const form of forms(needle)) expect(containsBytes(bytes, form)).toBe(false);
      }
    }
    for (const needle of [...needles]) {
      expect(JSON.stringify(h.events).includes(encodeBase64url(needle))).toBe(false);
    }
  });
});

describe('the M1-8c same-user script with the passkey path enabled (10 M1-8, D-67)', () => {
  it('cannot approve or deny without the PRF output, even holding the session', async () => {
    const h = await harness();
    const auth = new VirtualPrfAuthenticator();
    expect((await registerVia(h, code, auth.create(owner.ownerNostr, salt))).status).toBe(200);
    const jobFile = join(root, 'passkey-job.json');
    const outFile = join(root, 'passkey-script-result.json');
    const job = async (target: Harness, leakedPrf?: Uint8Array): Promise<void> => {
      for (const n of [1, 2]) target.source.add(n);
      const rows = await Promise.all([1, 2].map((n) => target.source.get(id(n))));
      writeFileSync(
        jobFile,
        JSON.stringify({
          port: target.port,
          origin: target.origin,
          cookie: target.page['Cookie'],
          csrf: target.page['X-AgentLink-CSRF'],
          keychainFile,
          credentialId: encodeBase64url(auth.credentialId),
          authenticatorData: encodeBase64url(auth.get(salt).authenticatorData),
          userHandle: encodeBase64url(owner.ownerNostr),
          prfSalt: encodeBase64url(salt),
          approvals: rows.map((r) => ({ approvalId: r?.approvalId, digest: r?.actionDigest })),
          outFile,
          ...(leakedPrf === undefined ? {} : { leakedPrf: encodeBase64url(leakedPrf) }),
        }),
      );
    };
    type ScriptResult = { attempts: { name: string; status: number }[] };
    const run = async (): Promise<ScriptResult> => {
      await execFileAsync(process.execPath, [SCRIPT, jobFile], {
        env: {
          ...process.env,
          HOME: home,
          AGENTLINK_OWNER_CODE: 'AAAA BBBB CCCC DDDD EEEE FFFF',
          AGENTLINK_OWNER_PASSPHRASE: 'not the owner passphrase',
        },
      });
      return JSON.parse(readFileSync(outFile, 'utf8')) as ScriptResult;
    };

    await job(h);
    const result = await run();
    expect(result.attempts.length).toBeGreaterThan(10);
    expect(result.attempts.filter((a) => a.status === 200).map((a) => a.name)).toEqual([]);
    expect(h.source.applied).toEqual([]);
    // M1-11a: the wrong guesses also ran into the backoff.
    expect(result.attempts.some((a) => a.status === 429)).toBe(true);
    const blob = await keychain.get(OWNER_PASSKEY_ACCOUNT);
    expect(blob === null ? undefined : readPasskeyBlobHeader(blob).credentialId).toEqual(
      auth.credentialId,
    );

    // Harness control (not vacuous): the same script holding the PRF output does approve. It runs
    // against a fresh server (same keychain and passkey), since the guesses above left this one in
    // the M1-11a backoff; its clock steps past any backoff on every read, because the script tries
    // its wrong guesses before the leaked PRF output.
    const fresh = await harness(MAX_PRESENCE_BACKOFF_S * 1000 + 1);
    await job(fresh, auth.get(salt).prfOutput);
    const leaked = await run();
    expect(leaked.attempts.some((a) => a.status === 200)).toBe(true);
    expect(fresh.source.applied.length).toBeGreaterThan(0);
    for (const s of fresh.source.applied) expect(ownerSigValid(s.body, s.sig)).toBe(true);
  }, 120_000);
});
