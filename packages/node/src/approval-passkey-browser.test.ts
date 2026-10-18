// M1-8e / M1-31 deferred acceptance in a real browser: the local approval page on
// `http://localhost:<port>` registers a PRF passkey and approves with it, in Chromium with a CDP
// virtual authenticator (WebAuthn PRF, user verification, resident keys; no hardware). This runs the
// page script itself (approval-page.ts), not a simulation of it.
//
// CI installs Chromium for Playwright (ci.yml), so there the test always runs and a browser that
// cannot start fails it. Locally, without the Playwright browsers, it is skipped; set
// AGENTLINK_TEST_CHROMIUM to a Chromium or chrome-headless-shell executable to run it.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TAGS,
  bip340Verify,
  canonicalizeToBytes,
  decodeBase64url,
  decodeHex,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  readPasskeyBlobHeader,
  sha256,
  taggedHash,
  type JsonObject,
  type OwnerPublicKeys,
} from '@4thtech-io/crypto';
import type { OwnerActionOutcome } from '@4thtech-io/core';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  startApprovalServerWith,
  type ApprovalForDecision,
  type ApprovalServer,
  type ApprovalServerSource,
} from './approval-server.js';
import { createKeychainAgent } from './keychain-keystore.js';
import type { KeychainBackend } from './keychain.js';
import { initOwnerWith } from './owner-init.js';
import { KeychainOwnerKeyStore } from './owner-keystore.js';
import { OWNER_PASSKEY_ACCOUNT } from './owner-passkey.js';
import type { OwnerTerminal } from './owner-terminal.js';

const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const root = mkdtempSync(join(tmpdir(), 'agentlink-m1-8e-browser-'));
const keychainFile = join(root, 'keychain-stand-in.json');

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
let browser: Browser | undefined;
let launchError: unknown;

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
  const executablePath = process.env['AGENTLINK_TEST_CHROMIUM'];
  try {
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath });
  } catch (error) {
    launchError = error;
  }
}, 120_000);

afterAll(async () => {
  await browser?.close();
  rmSync(root, { recursive: true, force: true });
});

const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await keychain.delete(OWNER_PASSKEY_ACCOUNT);
});

const id = (n: number): string => `apr_${String.fromCharCode(65 + n).repeat(22)}`;

function ownerSigValid(body: JsonObject, sig: string): boolean {
  try {
    const digest = taggedHash(TAGS.ownerAction, sha256(canonicalizeToBytes(body)));
    return bip340Verify(owner.ownerNostr, digest, decodeHex(sig, { length: 64 }));
  } catch {
    return false;
  }
}

function fakeSource(): ApprovalServerSource & {
  readonly applied: { body: JsonObject; sig: string }[];
  add(n: number): void;
} {
  const rows = new Map<string, ApprovalForDecision>();
  const applied: { body: JsonObject; sig: string }[] = [];
  return {
    applied,
    add(n) {
      const action = { tool: 'agentlink_send', to: `contact-${String(n)}`, text: 'hello' };
      const digest = encodeHex(sha256(canonicalizeToBytes(action)));
      rows.set(id(n), {
        approvalId: id(n),
        summary: `Send a message to Contact ${String(n)}`,
        actionDigest: digest,
        storedDigest: digest,
        action,
        expiresAt: Math.floor(Date.now() / 1000) + 3_600,
        commitment: false,
      });
    },
    context: () => Promise.resolve({ agent: agentId, owner }),
    list: () => Promise.resolve([...rows.values()]),
    get: (approvalId) => Promise.resolve(rows.get(approvalId)),
    apply: (signed) => {
      const params = signed.body['params'] as Record<string, unknown> | undefined;
      const row = rows.get(String(params?.['approvalId']));
      if (!ownerSigValid(signed.body, signed.sig) || row === undefined) {
        return Promise.resolve({ status: 'refused' } as never as OwnerActionOutcome);
      }
      rows.delete(row.approvalId);
      applied.push(signed);
      return Promise.resolve({ status: 'applied', op: 'approval.decide' } as OwnerActionOutcome);
    },
  };
}

async function start(): Promise<{
  server: ApprovalServer;
  source: ReturnType<typeof fakeSource>;
  sessionUrl: string;
}> {
  const source = fakeSource();
  const opened: string[] = [];
  const server = await startApprovalServerWith(
    { source },
    {
      keychain,
      openOwnerStore: (expected) => KeychainOwnerKeyStore.open(keychain, expected),
      opener: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      notifier: () => Promise.resolve(true),
    },
  );
  servers.push(server);
  await server.open();
  return { server, source, sessionUrl: opened[0] ?? '' };
}

/** A page with a CDP virtual authenticator (internal, resident keys, UV, PRF as asked). */
async function pageWithAuthenticator(hasPrf: boolean): Promise<{
  page: Page;
  credentials: () => Promise<string[]>;
}> {
  if (browser === undefined) throw new Error('unreachable');
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf,
      automaticPresenceSimulation: true,
    },
  });
  return {
    page,
    credentials: async () => {
      const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
      return credentials.map((c) => c.credentialId);
    },
  };
}

/** Skips locally when no browser could start; in CI that is a failure. */
function needBrowser(skip: () => void): void {
  if (browser !== undefined) return;
  if (process.env['CI'] !== undefined) throw launchError;
  skip();
}

describe('the localhost approval page with a PRF passkey (M1-8e, M1-31; Chromium)', () => {
  it('registers a passkey on http://localhost:<port> and approves with it', async (ctx) => {
    needBrowser(() => ctx.skip());
    const { server, source, sessionUrl } = await start();
    expect(sessionUrl.startsWith(`http://localhost:${String(server.port)}/?t=`)).toBe(true);
    const { page, credentials } = await pageWithAuthenticator(true);

    await page.goto(sessionUrl);
    await page.getByRole('button', { name: 'Set up a passkey' }).click();
    await page.locator('input[type=password]').fill(code);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByText('Passkey set up.').waitFor();

    const blob = await keychain.get(OWNER_PASSKEY_ACCOUNT);
    if (blob === null) throw new Error('no owner-passkey item');
    const header = readPasskeyBlobHeader(blob);
    expect(header.ownerNostr).toEqual(owner.ownerNostr);
    const [credentialId] = await credentials();
    expect(credentialId).toBeDefined();
    // CDP reports the credential ID in standard base64.
    expect(new Uint8Array(Buffer.from(credentialId ?? '', 'base64'))).toEqual(header.credentialId);

    source.add(1);
    await page.goto(server.approvalUrl(id(1)));
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('button', { name: 'Approve with your passkey' }).click();
    await page.getByText('Approved.').waitFor();
    expect(source.applied).toHaveLength(1);
    const signed = source.applied[0];
    if (signed === undefined) throw new Error('unreachable');
    expect(ownerSigValid(signed.body, signed.sig)).toBe(true);
    expect((signed.body['params'] as Record<string, unknown>)['approvalId']).toBe(id(1));
    await page.context().close();
  }, 120_000);

  it('a PRF-less authenticator registers nothing; the owner code still approves', async (ctx) => {
    needBrowser(() => ctx.skip());
    const { server, source, sessionUrl } = await start();
    const { page } = await pageWithAuthenticator(false);

    await page.goto(sessionUrl);
    await page.getByRole('button', { name: 'Set up a passkey' }).click();
    await page.locator('input[type=password]').fill(code);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByText("This passkey can't protect approvals here.").waitFor();
    expect(await keychain.get(OWNER_PASSKEY_ACCOUNT)).toBeNull();

    source.add(1);
    await page.goto(server.approvalUrl(id(1)));
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    expect(await page.getByRole('button', { name: 'Approve with your passkey' }).count()).toBe(0);
    await page.locator('input[type=password]').fill(code);
    await page.getByRole('button', { name: 'Confirm approval' }).click();
    await page.getByText('Approved.').waitFor();
    expect(source.applied).toHaveLength(1);
    await page.context().close();
  }, 120_000);

  it('refuses the page at http://127.0.0.1:<port> (one origin, D-79)', async (ctx) => {
    needBrowser(() => ctx.skip());
    const { server, sessionUrl } = await start();
    const { page } = await pageWithAuthenticator(true);
    const other = sessionUrl.replace('http://localhost:', 'http://127.0.0.1:');
    expect(other.startsWith(`http://127.0.0.1:${String(server.port)}/`)).toBe(true);
    const response = await page.goto(other);
    expect(response?.status()).toBe(403);
    await page.context().close();
  }, 60_000);
});
