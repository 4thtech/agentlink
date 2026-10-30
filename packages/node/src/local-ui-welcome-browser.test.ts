// U3-g-b (IR-U3-g-b-1 H-1) in a real browser: the built local app (apps/local-ui dist) served by the
// approval server as the app host with NO agent yet, Chromium with a CDP virtual authenticator. First
// run creates the first agent and opens it in the same host, so the `finish` answer carries a new
// generation; the page's generation guard adopts it (the answer is marked) instead of reloading. The
// one-time backup code stays on screen, and the next change the page sends carries the new
// generation and is not refused with `agent_changed`.
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
import { startApprovalServerWith, type ApprovalServer } from './approval-server.js';
import { createKeychainAgent, openRecordedKeyStore } from './keychain-keystore.js';
import type { KeychainBackend } from './keychain.js';
import type { AgentDirectory, AgentDirectoryEntry, AppHostAgent } from './local-ui/app-host.js';
import { KeychainOwnerKeyStore } from './owner-keystore.js';
import { defaultOwnerFiles } from './owner-setup.js';

const DIST = fileURLToPath(new URL('../../../apps/local-ui/dist/', import.meta.url));
const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const root = mkdtempSync(join(tmpdir(), 'agentlink-u3-g-b-browser-'));

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

/** The owner's computer with no agent yet: a directory whose `create` makes a real keychain agent. */
function noAgentWorld(keychain: KeychainBackend) {
  const entries = new Map<string, AgentDirectoryEntry>();
  const ids = new Map<string, string>();
  const directory: AgentDirectory = {
    list: () => Promise.resolve([...entries.values()]),
    read: (name) => Promise.resolve(entries.get(name)),
    stats: () => Promise.resolve({ contacts: 0, running: false }),
    writeLabel: (name, label) => {
      const entry = entries.get(name);
      if (entry !== undefined) entries.set(name, { ...entry, label });
      return Promise.resolve();
    },
    create: async (_label, options) => {
      const name = options?.name ?? 'slug';
      // W4-ONE-TOUCH (04 §2.8 step 2): the keys the server held since begin, as the CLI stores them.
      ids.set(
        name,
        options?.createKeys === undefined
          ? await createKeychainAgent(keychain)
          : await options.createKeys(),
      );
      entries.set(name, { name, label: name, available: true, removing: false });
      return name;
    },
    discardNew: (name) => {
      entries.delete(name);
      return Promise.resolve();
    },
    markRemoving: () => Promise.reject(new Error('never')),
    removeFolder: () => Promise.reject(new Error('never')),
    readCurrent: () => Promise.resolve(undefined),
    writeCurrent: () => Promise.resolve(),
  };
  let opens = 0;
  const open = async (name: string): Promise<AppHostAgent | undefined> => {
    const agentId = ids.get(name);
    const entry = entries.get(name);
    if (agentId === undefined || entry === undefined) return undefined;
    opens += 1;
    const store = await openAgentStoreWith('keychain', agentId, join(root, `${name}.sqlite`), {
      keychain,
    });
    const keyStore = await openRecordedKeyStore('keychain', agentId, { keychain });
    const client = await AgentLinkClient.create({
      keyStore,
      store: store.store,
      cipher: store.cipher,
      approvals,
      transport: nostrTransport({ connector: quietRelays as never, addressCheck: 'platform' }),
      policyMark: store.policyMark,
    });
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await keyStore.close();
      await store.close();
    };
    closers.push(close);
    const hex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h.slice(2), 'hex'));
    return {
      name,
      label: entry.label,
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
      localUi: { client },
      firstCard: {
        agent: agentId,
        name,
        relays: ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'],
        identity: client.identity,
        firstPolicy: { actions: client.ownerActions },
      },
      close,
    };
  };
  return { directory, open, opens: () => opens };
}

describe('first run with no agent yet in a real browser (U3-g-b)', () => {
  it('after Touch ID the backup code stays on screen and the next change carries the new generation', async (ctx) => {
    const files = appAssets();
    // Only the Linux `checks` job installs Playwright's Chromium; node-os (macOS, Windows) has none
    // (CI-WELCOME-BROWSER-OS), so a missing browser fails the test on Linux CI only.
    if (browser === undefined && process.env['CI'] !== undefined && process.platform === 'linux') {
      throw launchError;
    }
    if (browser === undefined || files === undefined) {
      ctx.skip();
      return;
    }
    const keychain = new FileKeychain();
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    const w = noAgentWorld(keychain);
    const opened: string[] = [];
    const server: ApprovalServer = await startApprovalServerWith(
      {
        source: {
          context: () => Promise.resolve(undefined),
          list: () => Promise.resolve([]),
          get: () => Promise.resolve(undefined),
          apply: () => Promise.reject(new Error('not used')),
        },
        localUi: { assets: { files } },
        host: {
          directory: w.directory,
          open: (name) => w.open(name),
          firstRun: { home, ownerFiles: defaultOwnerFiles(home) },
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
    await server.openFirstRun();

    const page = await pageWithAuthenticator();
    let loads = 0;
    page.on('load', () => {
      loads += 1;
    });
    await page.goto(opened[0] ?? '');
    expect(new URL(page.url()).pathname).toBe('/first-run');
    // U3-g (b11 §28): Welcome, pick your AI app, then name and protect with one gesture.
    await page.getByRole('button', { name: 'Get started' }).click();
    await page.getByRole('heading', { name: 'Which AI app will you use?' }).waitFor();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('heading', { name: 'Set up your agent' }).waitFor();
    await page.getByRole('button', { name: /^Use (Touch ID|Windows Hello|a passkey)$/ }).click();
    await page.getByRole('heading', { name: 'Your backup code' }).waitFor();
    const loadsAfterFinish = loads;
    const code = await page.locator('.al-secret-val').innerText();
    expect(code).toMatch(/[A-Z0-9]{4}/);
    // Give a reload every chance to happen (the guard reloads at once on a mismatch).
    await page.waitForTimeout(1500);
    expect(loads).toBe(loadsAfterFinish);
    await expect(page.getByRole('heading', { name: 'Your backup code' }).isVisible()).resolves.toBe(
      true,
    );
    expect(await page.locator('.al-secret-val').innerText()).toBe(code);
    // The first agent is open in the same host (opened for its first parts, then for the host).
    expect(w.opens()).toBe(2);

    // The next change the page sends (through the guarded fetch) carries generation 2: it reaches
    // the real U3-f route instead of the `agent_changed` or `no_agent` refusal.
    // A string, as the page's own code (this package has no DOM types).
    const answer = await page.evaluate<{ status: number; body: string }>(`(async () => {
      const meta = document.querySelector('meta[name="agentlink-csrf"]');
      const csrf = meta === null ? '' : meta.getAttribute('content');
      const res = await fetch('/api/ui/apps/apply', {
        method: 'POST',
        headers: { 'X-AgentLink-CSRF': csrf, 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(0),
      });
      return { status: res.status, body: await res.text() };
    })()`);
    // U3-f made the route real: with no presence proof it answers its own owner-presence refusal.
    expect(answer.status).toBe(403);
    expect(JSON.parse(answer.body)).toEqual({ status: 'presence_required' });
    expect(loads).toBe(loadsAfterFinish);
  }, 180_000);
});
