// M1-11b-1 acceptance, the whole first run in a real browser: the built local app (apps/local-ui
// dist) served by the approval server on `http://localhost:<port>`, Chromium with a CDP virtual
// authenticator (PRF, user verification, resident keys). The page creates the passkey, the server
// creates the owner, the page shows the owner fingerprint and the collapsed backup owner code, the
// recovery kit is put off ("Later") and Ready hands back to the AI; axe-core finds no WCAG 2.1 AA
// violation on any step. A second visit then shows
// "already protected" and never offers setup again.
//
// M1-UX-FIRSTRUN-V2 (D-130 (1), (2)): the button names the platform, the same gesture signs the
// first policy (Send allowed, in a temp home), and "Your backup code" is shown once in a save form
// that moves on only after "I saved it".
//
// Needs the built packages and app (`pnpm build`) and the Playwright Chromium; without them it is
// skipped locally (in CI a missing browser fails it). AGENTLINK_TEST_CHROMIUM names another
// Chromium executable. The keychain is a file in a temp folder, never the OS keychain or ~/.agentlink.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentLinkClient, nostrTransport, type ApprovalChannel } from '@4thtech-io/core';
import { decodeBase64url, encodeBase64url } from '@4thtech-io/crypto';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openAgentStoreWith } from './agent-store.js';
import {
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerEvent,
} from './approval-server.js';
import { createKeychainAgent, openRecordedKeyStore } from './keychain-keystore.js';
import type { KeychainBackend } from './keychain.js';
import { KeychainOwnerKeyStore, OWNER_PASSKEY_ACCOUNT } from './owner-keystore.js';
import { defaultOwnerFiles } from './owner-setup.js';

const DIST = fileURLToPath(new URL('../../../apps/local-ui/dist/', import.meta.url));
const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const root = mkdtempSync(join(tmpdir(), 'agentlink-m1-11b-1-'));

class FileKeychain implements KeychainBackend {
  readonly #file = join(root, 'keychain-stand-in.json');
  #read(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.#file, 'utf8')) as Record<string, string>;
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
      this.#file,
      JSON.stringify({ ...this.#read(), [account]: encodeBase64url(value) }),
    );
    return Promise.resolve();
  }
  delete(account: string): Promise<boolean> {
    const items = this.#read();
    const had = account in items;
    Reflect.deleteProperty(items, account);
    writeFileSync(this.#file, JSON.stringify(items));
    return Promise.resolve(had);
  }
}

/** A relay connector that accepts every event (identity.init may publish). */
const quietRelays = {
  open(_target: unknown, handlers: { onOpen(): void; onMessage(text: string): void }) {
    void Promise.resolve().then(() => handlers.onOpen());
    return {
      send: (text: string) => {
        const frame = JSON.parse(text) as unknown[];
        const push = (reply: unknown): void =>
          void Promise.resolve().then(() => handlers.onMessage(JSON.stringify(reply)));
        if (frame[0] === 'EVENT') push(['OK', (frame[1] as { id: string }).id, true, '']);
        if (frame[0] === 'REQ') push(['EOSE', frame[1]]);
      },
      close: () => undefined,
    };
  },
};

const approvals: ApprovalChannel = {
  request: (request) => Promise.resolve({ approvalId: request.approvalId }),
  status: () => Promise.resolve({ state: 'pending' }),
};

/** The built app as the CLI embeds it: index.html and assets/<name>. */
function appAssets(): Map<string, Uint8Array> | undefined {
  if (!existsSync(join(DIST, 'index.html'))) return undefined;
  const files = new Map<string, Uint8Array>([
    ['index.html', new Uint8Array(readFileSync(join(DIST, 'index.html')))],
  ]);
  for (const name of readdirSync(join(DIST, 'assets'))) {
    files.set(`assets/${name}`, new Uint8Array(readFileSync(join(DIST, 'assets', name))));
  }
  return files;
}

/**
 * axe-core (this package's pinned dev dependency) in the page: WCAG 2.0 and 2.1 A and AA rules. It is
 * evaluated through the DevTools protocol, so the page's CSP stays as served.
 */
const AXE_SOURCE = readFileSync(fileURLToPath(import.meta.resolve('axe-core/axe.min.js')), 'utf8');

async function axeViolations(page: Page): Promise<string[]> {
  await page.evaluate(AXE_SOURCE);
  return page.evaluate(`(async () => {
    const result = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
    return result.violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(', '));
  })()`);
}

let browser: Browser | undefined;
let launchError: unknown;
const closers: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  const executablePath = process.env['AGENTLINK_TEST_CHROMIUM'];
  try {
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath });
  } catch (error) {
    launchError = error;
  }
}, 120_000);

afterAll(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
  await browser?.close();
  rmSync(root, { recursive: true, force: true });
});

async function pageWithAuthenticator(): Promise<Page> {
  if (browser === undefined) throw new Error('unreachable');
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });
  closers.push(() => context.close());
  return page;
}

describe('the local first run in a real browser (M1-11b-1, D-120)', () => {
  it('passkey-first setup, fingerprint, backup code, Later, and Ready hands back to the AI', async (ctx) => {
    const files = appAssets();
    if (browser === undefined && process.env['CI'] !== undefined) throw launchError;
    if (browser === undefined || files === undefined) {
      ctx.skip();
      return;
    }
    const keychain = new FileKeychain();
    const agentId = await createKeychainAgent(keychain);
    const store = await openAgentStoreWith('keychain', agentId, join(root, 'agent.sqlite'), {
      keychain,
    });
    const keyStore = await openRecordedKeyStore('keychain', agentId, { keychain });
    closers.push(
      () => store.close(),
      () => keyStore.close(),
    );
    const client = await AgentLinkClient.create({
      keyStore,
      store: store.store,
      cipher: store.cipher,
      approvals,
      transport: nostrTransport({ connector: quietRelays as never, addressCheck: 'platform' }),
      policyMark: store.policyMark,
    });
    mkdirSync(join(root, 'home'), { recursive: true });
    const events: ApprovalServerEvent[] = [];
    const opened: string[] = [];
    const hex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h.slice(2), 'hex'));
    const server: ApprovalServer = await startApprovalServerWith(
      {
        source: {
          context: async () => {
            const view = await client.identity.get();
            if (view === undefined) return undefined;
            return {
              agent: agentId,
              owner: {
                ownerEvm: hex(view.card.ownerEvm),
                ownerNostr: hex(view.card.ownerNostr),
                ownerEnc: hex(view.card.ownerEnc),
              },
            };
          },
          list: () => Promise.resolve([]),
          get: () => Promise.resolve(undefined),
          apply: () => Promise.reject(new Error('not used')),
        },
        onEvent: (event) => void events.push(event),
        localUi: {
          assets: { files },
          client,
          ownerSetup: {
            firstCard: {
              agent: agentId,
              name: 'Alice',
              relays: ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'],
              identity: client.identity,
              firstPolicy: { actions: client.ownerActions, home: join(root, 'home') },
            },
            ownerFiles: defaultOwnerFiles(join(root, 'home')),
          },
        },
      },
      {
        keychain,
        openOwnerStore: (expected) => KeychainOwnerKeyStore.open(keychain, expected),
        opener: (url) => {
          opened.push(url);
          return Promise.resolve(true);
        },
        notifier: () => Promise.resolve(true),
        ownerKdf: KDF,
      },
    );
    closers.push(() => server.close());
    await server.open();

    const page = await pageWithAuthenticator();
    await page.goto(opened[0] ?? '');
    await page.goto(`${server.origin}/first-run`);

    await page.getByRole('heading', { name: 'Protect your approvals' }).waitFor();
    expect(await page.locator('main').innerText()).toContain('~/AgentLink/Send');
    expect(await axeViolations(page)).toEqual([]);
    await page.getByRole('button', { name: /^Use (Touch ID|Windows Hello|a passkey)$/ }).click();
    await page.getByRole('heading', { name: 'Your backup code' }).waitFor();

    // The same gesture signed the first policy: the real Send folder is allowed.
    const policy = await client.ownerActions.loadPolicy();
    expect(policy.mode).toBe('signed');
    if (policy.mode === 'signed') {
      expect(policy.policy.files.allowedFolders).toEqual([
        join(realpathSync(join(root, 'home')), 'AgentLink', 'Send'),
      ]);
    }

    // The fingerprint is the one the card now names; the code is shown once, in a save form.
    const view = await client.identity.get();
    expect(view).toBeDefined();
    const fingerprint = events.find((e) => e.kind === 'owner_setup' && e.outcome === 'done');
    expect(fingerprint).toBeDefined();
    const shown = (await page.locator('.al-fp').innerText()).replace(/\s/g, '');
    expect(shown).toContain(
      ((fingerprint as { fingerprint?: string }).fingerprint ?? 'x').replace(/\s/g, ''),
    );
    expect(await axeViolations(page)).toEqual([]);
    expect(await page.locator('.al-secret-val').innerText()).toMatch(/[A-Z0-9]{4}/);
    expect(await page.locator('form input[autocomplete="new-password"]').count()).toBe(1);
    expect(await page.locator('form input[autocomplete="username"]').inputValue()).toMatch(
      /^AgentLink backup code – /,
    );
    expect(await keychain.get(OWNER_PASSKEY_ACCOUNT)).not.toBeNull();

    await page.getByRole('button', { name: 'I saved it' }).click();
    await page.getByRole('heading', { name: 'Save your recovery kit' }).waitFor();
    expect(await axeViolations(page)).toEqual([]);
    await page.getByRole('button', { name: 'Later' }).click();
    await page.getByRole('heading', { name: "You're set" }).waitFor();
    expect(await axeViolations(page)).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem('agentlink.recoveryKit.later'))).toMatch(
      /^[0-9]+$/,
    );
    const prompt = await page.locator('.al-copy.is-hero').innerText();
    expect(prompt).toContain('Create an AgentLink invite for a colleague.');
    const body = await page.locator('main').innerText();
    expect(body).not.toMatch(/\b(wallet|gas|seed|transaction|chain|hash|0x[0-9a-f]+)\b/i);

    // A second visit: approvals are already protected; setup is never offered again.
    await page.goto(`${server.origin}/first-run`);
    await page
      .getByRole('heading', { name: 'Approvals are already protected on this computer' })
      .waitFor();
    expect(
      await page.getByRole('button', { name: /^Use (Touch ID|Windows Hello|a passkey)$/ }).count(),
    ).toBe(0);
  }, 180_000);
});
