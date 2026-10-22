// M1-11b-6 smoke: the built CLI carries the local app, and the approval server serves it at
// /first-run for a new owner.
//
// - The published bundle (apps/cli/dist/agentlink.js, `pnpm build`) embeds exactly the built local
//   app (apps/local-ui/dist): the build order puts apps/local-ui first (apps/cli devDependency).
// - The files embedded in that bundle, wired as the CLI wires them (apps/cli local-ui-wiring.ts:
//   a keychain agent, no owner anywhere, so owner setup is wired), are served by the approval server:
//   the one-shot session link the opener gets for /first-run gives a session; `GET /first-run`
//   then answers 200 with the strict CSP and the app's shell; `GET /api/ui/first-run` answers
//   `missing` on a clean home (a temp folder, a keychain stand-in file; never the OS keychain).
//
// Needs the build (CI runs `pnpm build` before `pnpm test`); without it this fails with the command
// to run.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentLinkClient } from '@4thtech-io/core';
import { decodeBase64url, encodeBase64url } from '@4thtech-io/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localUiAssetEntries } from '../../apps/cli/scripts/local-ui-embed.mjs';
import { localUiAssets } from '../../apps/cli/dist/mcp/local-ui-assets.js';
import { localUiOptions } from '../../apps/cli/dist/mcp/local-ui-wiring.js';
import {
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerEvent,
} from '../../packages/node/dist/approval-server.js';
import type { KeychainBackend } from '../../packages/node/dist/keychain.js';
import { defaultOwnerFiles, ownerSetupAvailableWith } from '../../packages/node/dist/owner-setup.js';

const BUNDLE = fileURLToPath(new URL('../../apps/cli/dist/agentlink.js', import.meta.url));
const APP_DIST = fileURLToPath(new URL('../../apps/local-ui/dist/', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'agentlink-m1-11b-6-'));
const home = join(root, 'home');

/** A keychain stand-in in the temp folder: the OS keychain is never touched. */
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
    writeFileSync(this.#file, JSON.stringify({ ...this.#read(), [account]: encodeBase64url(value) }));
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

/** The `[name, base64url]` entries the bundle embeds (bundle.config.mjs `__AGENTLINK_LOCAL_UI__`). */
function embeddedEntries(bundle: string): [string, string][] {
  const start = bundle.indexOf('function embeddedLocalUiAssets()');
  expect(start, 'embeddedLocalUiAssets is in the bundle').toBeGreaterThan(-1);
  const end = bundle.indexOf('\n}\n', start);
  const body = bundle.slice(start, end);
  return [...body.matchAll(/\["([^"\\]+)", "([A-Za-z0-9_-]*)"\]/g)].map((m) => [
    m[1] ?? '',
    m[2] ?? '',
  ]);
}

interface Response {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function send(port: number, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { Host: `localhost:${String(port)}`, ...headers },
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
    req.end();
  });
}

let entries: [string, string][] = [];
let server: ApprovalServer | undefined;
const opened: string[] = [];
const events: ApprovalServerEvent[] = [];

beforeAll(() => {
  for (const path of [BUNDLE, join(APP_DIST, 'index.html')]) {
    if (!existsSync(path)) {
      throw new Error(`${path} is missing: run \`pnpm build\` first (CI builds before tests).`);
    }
  }
  entries = embeddedEntries(readFileSync(BUNDLE, 'utf8'));
});

afterAll(async () => {
  await server?.close();
  rmSync(root, { recursive: true, force: true });
});

describe('the built CLI serves the first-run page (M1-11b-6)', () => {
  it('the bundle embeds exactly the built local app', () => {
    const built = localUiAssetEntries(APP_DIST) as [string, string][];
    expect(built.length).toBeGreaterThan(1);
    expect(entries.map(([name]) => name)).toEqual(built.map(([name]) => name));
    expect(entries).toEqual(built);
    expect(entries.some(([name]) => name === 'index.html')).toBe(true);
  });

  it('serves /first-run (200, CSP) and reports `missing` on a clean home', async () => {
    const keychain = new FileKeychain();
    const identity = {
      get: () => Promise.resolve(undefined),
      init: () => Promise.reject(new Error('not in the smoke test')),
    };
    const client = {
      agentId: `0x${'ab'.repeat(20)}`,
      identity,
      getProof: () => Promise.reject(new Error('not in the smoke test')),
    } as unknown as AgentLinkClient;
    const localUi = await localUiOptions(
      { name: 'default', client },
      {
        keyStoreOf: () => Promise.resolve('keychain'),
        ownerSetupAvailable: (first) =>
          ownerSetupAvailableWith(keychain, first, defaultOwnerFiles(home)),
        cardRelays: () => ['wss://relay.one.example', 'wss://relay.two.example'],
        assets: () => localUiAssets(entries),
      },
    );
    // Clean home: no card, no owner item, no owner file, so owner setup is wired.
    expect(localUi.ownerSetup).toBeDefined();
    server = await startApprovalServerWith(
      {
        source: {
          context: () => Promise.resolve(undefined),
          list: () => Promise.resolve([]),
          get: () => Promise.resolve(undefined),
          apply: () => Promise.reject(new Error('not in the smoke test')),
        },
        localUi: {
          ...localUi,
          ...(localUi.ownerSetup === undefined
            ? {}
            : { ownerSetup: { ...localUi.ownerSetup, ownerFiles: defaultOwnerFiles(home) } }),
        },
        onEvent: (event) => void events.push(event),
      },
      {
        keychain,
        opener: (url) => {
          opened.push(url);
          return Promise.resolve(true);
        },
        notifier: () => Promise.resolve(true),
      },
    );
    const { port, origin } = server;

    // Without the session the page is closed.
    expect((await send(port, '/first-run')).status).toBe(401);

    await expect(server.openFirstRun()).resolves.toBe(true);
    const link = new URL(opened[0] ?? '');
    expect(link.origin).toBe(origin);
    expect(link.pathname).toBe('/first-run');
    const token = link.searchParams.get('t') ?? '';
    const exchange = await send(port, `${link.pathname}${link.search}`);
    expect(exchange.status).toBe(303);
    expect(exchange.headers.location).toBe('/first-run');
    const cookie = (exchange.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
    expect(cookie).not.toBe('');

    const page = await send(port, '/first-run', { Cookie: cookie });
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    const csp = page.headers['content-security-policy'];
    expect(typeof csp).toBe('string');
    expect(csp).toContain("default-src 'none'");
    const csrf = /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(page.body)?.[1];
    expect(csrf).toBeDefined();
    const script = /src="\/(assets\/[^"]+\.js)"/.exec(page.body)?.[1];
    expect(script).toBeDefined();
    const asset = await send(port, `/${script ?? ''}`, { Cookie: cookie });
    expect(asset.status).toBe(200);

    const status = await send(port, '/api/ui/first-run', {
      Cookie: cookie,
      'X-AgentLink-CSRF': csrf ?? '',
      'Sec-Fetch-Site': 'same-origin',
    });
    expect(status.status).toBe(200);
    expect(JSON.parse(status.body)).toEqual({ owner: 'missing' });

    // The session link and token are in no event.
    const logged = JSON.stringify(events);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain('?t=');
  });
});
