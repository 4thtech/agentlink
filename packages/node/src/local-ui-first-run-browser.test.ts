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

/**
 * CHORE-FLAKE-SB-CONTRAST: the status bar state (`.al-sb-state`) fades in (opacity, 200 ms) every time
 * the connection state changes. axe samples the computed colour, so a pass while the fade runs blends
 * text and background and can fail colour-contrast on a slow runner. Wait until every animation and
 * transition has finished, so axe always reads the settled colours; the rule stays on.
 */
async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(
    `(async () => {
      for (let i = 0; i < 5; i += 1) {
        const running = document
          .getAnimations()
          .filter((a) => a.playState !== 'finished' && a.effect.getComputedTiming().endTime !== Infinity);
        if (running.length === 0) return;
        await Promise.allSettled(running.map((a) => a.finished));
      }
    })()`,
  );
}

async function axeViolations(page: Page): Promise<string[]> {
  await settleAnimations(page);
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
  it('Welcome, pick, name with one gesture, backup code, and Home (U3-g; M1-11b-1, D-120)', async (ctx) => {
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

    // U3-g (b11 §28): what the page asks of the real server, as the server parses it.
    const asked: { method: string; url: string; input: string | null }[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/ui/')) {
        asked.push({
          method: request.method(),
          url: new URL(request.url()).pathname + new URL(request.url()).search,
          input: request.headers()['x-agentlink-input'] ?? null,
        });
      }
    });

    // Welcome: one sentence and one button; nothing is asked of the setup routes yet.
    await page.getByRole('button', { name: 'Get started' }).waitFor();
    expect(await page.locator('h1').innerText()).toContain('Private messages between AI agents.');
    // The one fade-in has to be over before colours are measured.
    await page.evaluate(
      'Promise.all(document.getAnimations().map((a) => a.finished)).then(() => true)',
    );
    expect(await axeViolations(page)).toEqual([]);
    await page.getByRole('button', { name: 'Get started' }).click();

    // Pick your AI app: the app list is not available from this server (U3-f's route is a stub
    // here), so the page says so in plain words and goes on.
    await page.getByRole('heading', { name: 'Which AI app will you use?' }).waitFor();
    await page.getByText("Couldn't look for AI apps. You can connect one later.").waitFor();
    expect(asked.some((a) => a.url === '/api/ui/apps')).toBe(true);
    expect(await axeViolations(page)).toEqual([]);
    await page.getByRole('button', { name: 'Continue' }).click();

    // Name and protect, one gesture.
    await page.getByRole('heading', { name: 'Set up your agent' }).waitFor();
    expect(await page.locator('main').innerText()).toContain('~/AgentLink/Send');
    expect(await page.getByLabel('Name your agent').inputValue()).toBe('My agent');
    expect(await axeViolations(page)).toEqual([]);
    // The server refuses a label that is not its own restricted form, before any Touch ID.
    const refused = await page.evaluate(async () => {
      const doc = (
        globalThis as unknown as {
          document: { querySelector(q: string): { getAttribute(n: string): string | null } | null };
        }
      ).document;
      const token = doc.querySelector('meta[name="agentlink-csrf"]')?.getAttribute('content');
      const res = await fetch('/api/ui/agents/label-check?label=Work%20%20agent', {
        headers: { 'X-AgentLink-CSRF': token ?? '' },
      });
      return { status: res.status, body: (await res.json()) as unknown };
    });
    expect(refused).toEqual({
      status: 200,
      body: { status: 'refused', reason: 'label_invalid' },
    });
    await page.getByLabel('Name your agent').fill('Home base');
    await page.getByRole('button', { name: /^Use (Touch ID|Windows Hello|a passkey)$/ }).click();
    await page.getByRole('heading', { name: 'Your backup code' }).waitFor();

    // The label was checked, then carried by begin exactly as the server parses it (X-AgentLink-Input
    // = base64url JSON {label}); W4-ONE-TOUCH (04 §2.8): finish carries only {nonce}. The first
    // agent.label is stored and verified.
    const labelInput = Buffer.from(JSON.stringify({ label: 'Home base' })).toString('base64url');
    expect(
      asked.find((a) => a.url.startsWith('/api/ui/agents/label-check?label=Home')),
    ).toBeDefined();
    const begin = asked.find((a) => a.url === '/api/ui/first-run/owner/begin');
    expect(begin?.method).toBe('POST');
    expect(begin?.input).toBe(labelInput);
    const finish = asked.find((a) => a.url === '/api/ui/first-run/owner/finish');
    expect(finish?.method).toBe('POST');
    const finishInput = JSON.parse(
      Buffer.from(finish?.input ?? '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(Object.keys(finishInput)).toEqual(['nonce']);
    expect(await client.ownerActions.loadLabel()).toEqual({
      status: 'verified',
      label: 'Home base',
    });

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

    // "I saved it": no AI app was chosen, so the end of first run is Home, with the kit put off.
    await page.getByRole('button', { name: 'I saved it' }).click();
    await page.waitForURL(`${server.origin}/settings/home`);
    expect(await page.evaluate(() => localStorage.getItem('agentlink.recoveryKit.later'))).toMatch(
      /^[0-9]+$/,
    );

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
