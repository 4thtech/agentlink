// M1-11s-b acceptance: the local UI server shell inside the approval server (08 §1; 04 §2.5, §4;
// D-118; I-4, I-7).
//
// - The React app's built files come in as an in-memory bundle from the caller (no file system path
//   is ever read). Only `index.html` and `assets/<hashed name>` with a known file type are accepted;
//   anything else fails the start. `/assets/<name>` is served from that map only, with its own
//   content type, nosniff, the strict CSP and immutable caching; any other name is 404.
// - The app's index.html is served only for `/first-run` and `/settings[/...]`, with the per-server
//   CSRF token injected; `/` and `/approve/<id>` keep the existing approval page.
// - The session token (cookie) gates the app pages, the assets and every /api/ui/ route.
// - A route declared `presence: true` runs only after the central presence gate: a POST with the
//   page's Origin, CSRF and an octet-stream body carrying the owner code (or the passkey assertion).
//   No proof, or a wrong one: 403 before the handler runs (the store is unlocked first, IR-M1-11s-b-1
//   H-1), and a wrong code counts towards the server's wrong-code backoff. The handler gets a
//   read-only client view and a one-use `sign` on that session; one that signs nothing is 409.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
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
  sha256,
  taggedHash,
  type JsonObject,
  type OwnerPublicKeys,
} from '@4thtech-io/crypto';
import type { OwnerActionOutcome } from '@4thtech-io/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerInternals,
  type ApprovalServerSource,
} from '../approval-server.js';
import { createKeychainAgent } from '../keychain-keystore.js';
import type { KeychainBackend } from '../keychain.js';
import { initOwnerWith } from '../owner-init.js';
import { KeychainOwnerKeyStore } from '../owner-keystore.js';
import type { OwnerSignature } from '../owner-operation.js';
import type { OwnerTerminal } from '../owner-terminal.js';
import type { LocalUiAssets } from './context.js';
import type { LocalUiOwnerOperation } from './route-types.js';
import { createLocalUiRoutes } from './routes.js';

const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const root = mkdtempSync(join(tmpdir(), 'agentlink-m1-11s-b-'));
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
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const source: ApprovalServerSource = {
  context: () => Promise.resolve({ agent: agentId, owner }),
  list: () => Promise.resolve([]),
  get: () => Promise.resolve(undefined),
  apply: () => Promise.resolve({ status: 'applied', op: 'contact.check' } as OwnerActionOutcome),
};

const INDEX_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="agentlink-csrf" content="" /><title>AgentLink</title>' +
  '<script type="module" crossorigin src="/assets/index-Bx3f9a2Q.js"></script>' +
  '<link rel="stylesheet" crossorigin href="/assets/index-C1d2e3f4.css"></head>' +
  '<body><div id="root"></div></body></html>';

const bundle = (): LocalUiAssets => ({
  files: new Map<string, Uint8Array>([
    ['index.html', encodeUtf8(INDEX_HTML)],
    ['assets/index-Bx3f9a2Q.js', encodeUtf8('console.log(1);')],
    ['assets/index-C1d2e3f4.css', encodeUtf8('body{margin:0}')],
    ['assets/inter-latin-400-AbC123.woff2', new Uint8Array([0x77, 0x4f, 0x46, 0x32])],
    ['assets/logo-9f8e7d.svg', encodeUtf8('<svg xmlns="http://www.w3.org/2000/svg"/>')],
  ]),
});

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

const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

interface Harness {
  readonly server: ApprovalServer;
  readonly port: number;
  readonly origin: string;
  readonly opened: string[];
  cookie(): Promise<string>;
  csrf(cookie: string): Promise<string>;
}

async function harness(
  options: {
    assets?: LocalUiAssets;
    internals?: ApprovalServerInternals;
    client?: unknown;
  } = {},
): Promise<Harness> {
  const opened: string[] = [];
  const server = await startApprovalServerWith(
    {
      source,
      localUi: {
        assets: options.assets ?? bundle(),
        ...(options.client === undefined ? {} : { client: options.client as never }),
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
      ...options.internals,
    },
  );
  servers.push(server);
  const port = server.port;
  return {
    server,
    port,
    origin: server.origin,
    opened,
    async cookie() {
      const at = opened.length;
      await server.open();
      const fresh = new URL(opened[at] ?? '').searchParams.get('t') ?? '';
      const res = await send(port, `/?t=${fresh}`);
      expect(res.status).toBe(303);
      return (res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
    },
    async csrf(cookie) {
      const res = await send(port, '/', { headers: { Cookie: cookie } });
      const match = /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(res.body);
      return match?.[1] ?? '';
    },
  };
}

function expectStrictHeaders(res: Response): void {
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['x-frame-options']).toBe('DENY');
  const csp = String(res.headers['content-security-policy']);
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("style-src 'self'");
  expect(csp).toContain("font-src 'self'");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*/);
}

describe('static assets of the local UI (M1-11s-b, 04 §4)', () => {
  it('serves each bundled asset with its content type, nosniff, strict CSP and immutable caching', async () => {
    const h = await harness();
    const cookie = await h.cookie();
    const cases: [string, string, string][] = [
      ['/assets/index-Bx3f9a2Q.js', 'text/javascript; charset=utf-8', 'console.log(1);'],
      ['/assets/index-C1d2e3f4.css', 'text/css; charset=utf-8', 'body{margin:0}'],
      ['/assets/inter-latin-400-AbC123.woff2', 'font/woff2', 'wOF2'],
      ['/assets/logo-9f8e7d.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ];
    for (const [path, type, body] of cases) {
      const res = await send(h.port, path, { headers: { Cookie: cookie } });
      expect(res.status, path).toBe(200);
      expect(res.headers['content-type'], path).toBe(type);
      expect(res.body, path).toBe(body);
      expect(res.headers['cache-control'], path).toBe('private, max-age=31536000, immutable');
      expectStrictHeaders(res);
    }
  });

  it('answers 404 for unknown names and every traversal or odd form, and reads no file', async () => {
    const h = await harness();
    const cookie = await h.cookie();
    for (const path of [
      '/assets/missing-123.js',
      '/assets/',
      '/assets',
      '/assets/..%2fapproval-server.ts',
      '/assets/..%2F..%2Fpackage.json',
      '/assets/%2e%2e/index.html',
      '/assets/index-Bx3f9a2Q.js%00.css',
      '/assets/sub/index-Bx3f9a2Q.js',
      '/assets//etc/passwd',
      '/assets/.hidden.js',
      '/assets/index.html',
      '/assets/index-Bx3f9a2Q.JS',
      '/index.html',
      '/assets/..\\..\\package.json',
    ]) {
      const res = await send(h.port, path, { headers: { Cookie: cookie } });
      expect(res.status, path).toBe(404);
      expect(res.body, path).not.toContain('console.log');
      expectStrictHeaders(res);
    }
    // Only a GET reads an asset.
    const post = await send(h.port, '/assets/index-Bx3f9a2Q.js', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: h.origin },
    });
    expect(post.status).toBe(405);
  });

  it('needs the session cookie for an asset', async () => {
    const h = await harness();
    expect((await send(h.port, '/assets/index-Bx3f9a2Q.js')).status).toBe(401);
  });

  it('refuses to start with a bundle name or file type it does not serve', async () => {
    for (const name of [
      '../secret.js',
      'assets/../../secret.js',
      'assets/sub/a.js',
      'assets/.env',
      'assets/run.exe',
      'assets/page.html',
      'other.html',
      '/index.html',
      'assets/a\\b.js',
    ]) {
      const assets: LocalUiAssets = { files: new Map([[name, encodeUtf8('x')]]) };
      await expect(harness({ assets }), name).rejects.toThrow(/local UI/);
    }
    const noHead: LocalUiAssets = { files: new Map([['index.html', encodeUtf8('<p>x</p>')]]) };
    await expect(harness({ assets: noHead })).rejects.toThrow(/local UI/);
    // A token already in the file (a stale or planted one) is refused, never served.
    const preset: LocalUiAssets = {
      files: new Map([
        ['index.html', encodeUtf8('<head><meta name="agentlink-csrf" content="abc"></head>')],
      ]),
    };
    await expect(harness({ assets: preset })).rejects.toThrow(/local UI/);
    // IR-M1-11s-b-1 L-2: any other form of the meta (attribute order, quotes) is refused too.
    for (const html of [
      '<head><meta content="" name="agentlink-csrf"></head>',
      "<head><meta name='agentlink-csrf' content=''></head>",
      '<head><meta name="agentlink-csrf" content="" /><meta name=agentlink-csrf></head>',
    ]) {
      const odd: LocalUiAssets = { files: new Map([['index.html', encodeUtf8(html)]]) };
      await expect(harness({ assets: odd }), html).rejects.toThrow(/local UI/);
    }
  });
});

describe('the app pages and the existing approval page (M1-11s-b)', () => {
  it('serves the app only for /first-run and /settings/*, with the CSRF token injected', async () => {
    const h = await harness();
    const cookie = await h.cookie();
    const csrf = await h.csrf(cookie);
    for (const path of ['/first-run', '/settings', '/settings/contacts', '/settings/rules/edit']) {
      const res = await send(h.port, path, { headers: { Cookie: cookie } });
      expect(res.status, path).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toContain('<div id="root"></div>');
      expect(res.body).toContain(`<meta name="agentlink-csrf" content="${csrf}">`);
      expect(res.body).not.toContain('content=""');
      expect(res.body).not.toContain('/app.js');
      expectStrictHeaders(res);
    }
    for (const path of [
      '/settingsx',
      '/settings/',
      '/settings//x',
      '/settings/Contacts',
      '/first-run/x',
      '/first-run/',
      '/approvals',
      '/activity',
      '/favicon.ico',
    ]) {
      const res = await send(h.port, path, { headers: { Cookie: cookie } });
      expect(res.status, path).toBe(404);
    }
  });

  it('fills the token into an index.html with no csrf meta too, exactly once', async () => {
    const assets: LocalUiAssets = {
      files: new Map([
        ['index.html', encodeUtf8('<html><HEAD lang="x"><title>t</title></HEAD></html>')],
      ]),
    };
    const h = await harness({ assets });
    const cookie = await h.cookie();
    const csrf = await h.csrf(cookie);
    const res = await send(h.port, '/first-run', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(res.body.split('agentlink-csrf')).toHaveLength(2);
    expect(res.body).toContain(`<HEAD lang="x"><meta name="agentlink-csrf" content="${csrf}">`);
  });

  it('keeps / and /approve/<id> on the existing approval page', async () => {
    const h = await harness();
    const cookie = await h.cookie();
    for (const path of ['/', `/approve/apr_${'A'.repeat(22)}`]) {
      const res = await send(h.port, path, { headers: { Cookie: cookie } });
      expect(res.status, path).toBe(200);
      expect(res.body).toContain('/app.js');
      expect(res.body).not.toContain('<div id="root"></div>');
    }
  });

  it('needs the session for the app pages, and exchanges a one-shot link on them', async () => {
    const h = await harness();
    expect((await send(h.port, '/settings')).status).toBe(401);
    expect((await send(h.port, '/first-run')).status).toBe(401);
    await h.server.open();
    const token = new URL(h.opened.at(-1) ?? '').searchParams.get('t') ?? '';
    const res = await send(h.port, `/settings/contacts?t=${token}`);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/settings/contacts');
    expect(res.headers['set-cookie']?.[0]).toContain('HttpOnly');
    // One-shot: the same link never works twice.
    expect((await send(h.port, `/settings/contacts?t=${token}`)).status).toBe(401);
  });

  it('answers 404 for the app pages when the CLI has no bundle (an empty bundle is fine)', async () => {
    const h = await harness({ assets: { files: new Map() } });
    const cookie = await h.cookie();
    expect((await send(h.port, '/settings', { headers: { Cookie: cookie } })).status).toBe(404);
    expect((await send(h.port, '/', { headers: { Cookie: cookie } })).status).toBe(200);
  });
});

// M1-11b-2a (owner feedback 2026-10-26: "if I click on Approvals there is no menu to get back"): the
// approval page carries the app's sidebar when the app is bundled. Navigation only: the session,
// CSRF and presence gates of the approval page are unchanged (04 §2.5, I-4).
describe('the shared app navigation on the approval page (M1-11b-2a)', () => {
  const NAV_PATHS = [
    '/',
    '/settings/activity',
    '/settings/contacts',
    '/settings/files',
    '/settings/proofs',
    '/settings/rules',
    '/settings/backup',
  ];

  it('shows the app sidebar on / and /approve/<id> when the app is bundled, Approvals current', async () => {
    const h = await harness();
    const cookie = await h.cookie();
    for (const path of ['/', `/approve/apr_${'A'.repeat(22)}`]) {
      const res = await send(h.port, path, { headers: { Cookie: cookie } });
      expect(res.status, path).toBe(200);
      expect(res.body).toContain('<nav class="al-side" aria-label="Main">');
      const hrefs = [...res.body.matchAll(/<a class="al-nav[^"]*" href="([^"]*)"/g)].map(
        (m) => m[1],
      );
      expect(hrefs, path).toEqual(NAV_PATHS);
      expect(res.body).toMatch(/<a class="al-nav is-active" href="\/" aria-current="page">/);
      expect(res.body.split('aria-current').length - 1).toBe(1);
      // Still the approval page, under the same strict headers.
      expect(res.body).toContain('<script src="/app.js" defer></script>');
      expectStrictHeaders(res);
    }
  });

  it('leaves the sidebar out when there is no app to go to (no bundle)', async () => {
    const h = await harness({ assets: { files: new Map() } });
    const cookie = await h.cookie();
    const res = await send(h.port, '/', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('al-side');
    expect(res.body).not.toContain('/settings/');
  });

  it('puts no token, session link or outside address into the navigation', async () => {
    const h = await harness();
    const cookie = await h.cookie();
    const res = await send(h.port, '/', { headers: { Cookie: cookie } });
    const nav = res.body.slice(res.body.indexOf('<nav'), res.body.indexOf('</nav>'));
    expect(nav).not.toBe('');
    expect(nav).not.toContain('?t=');
    expect(nav).not.toContain('agentlink-csrf');
    expect(nav).not.toMatch(/:\/\/|javascript:/i);
    expect(nav).not.toMatch(/<script|style=|\son[a-z]+=/i);
    // The cookie value never reaches the markup.
    expect(res.body).not.toContain(cookie.split('=')[1] ?? 'missing');
  });

  it('keeps the page gate: no session, no page (the sidebar never opens a door)', async () => {
    const h = await harness();
    expect((await send(h.port, '/')).status).toBe(401);
    expect((await send(h.port, `/approve/apr_${'A'.repeat(22)}`)).status).toBe(401);
    // An expired link shows the fixed page with no navigation into the app.
    const expired = await send(h.port, '/');
    expect(expired.body).not.toContain('al-side');
  });

  it('keeps the decide gate: no CSRF, no Origin or no presence is refused as before', async () => {
    const h = await harness();
    const cookie = await h.cookie();
    const csrf = await h.csrf(cookie);
    const path = `/api/approvals/apr_${'A'.repeat(22)}/approve`;
    const base = {
      Cookie: cookie,
      Origin: h.origin,
      'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/json',
    };
    const body = encodeUtf8(JSON.stringify({}));
    const cases: [string, Record<string, string>][] = [
      ['no csrf', base],
      [
        'no origin',
        { Cookie: cookie, 'X-AgentLink-CSRF': csrf, 'Content-Type': 'application/json' },
      ],
      ['cross-site', { ...base, 'X-AgentLink-CSRF': csrf, 'Sec-Fetch-Site': 'cross-site' }],
      ['no presence', { ...base, 'X-AgentLink-CSRF': csrf }],
    ];
    for (const [name, headers] of cases) {
      const res = await send(h.port, path, { method: 'POST', headers, body });
      expect(res.status, name).toBeGreaterThanOrEqual(400);
      expect(res.body, name).not.toContain('applied');
    }
    // A GET on the decide route never decides.
    const get = await send(h.port, path, { headers: { Cookie: cookie } });
    expect(get.status).toBeGreaterThanOrEqual(400);
  });
});

describe('the /api/ui/ routes: session, CSRF and the central presence gate (I-4)', () => {
  it('needs the session cookie, the CSRF header and same-origin metadata on every route', async () => {
    const h = await harness();
    expect((await send(h.port, '/api/ui/activity')).status).toBe(401);
    const cookie = await h.cookie();
    const csrf = await h.csrf(cookie);
    expect((await send(h.port, '/api/ui/activity', { headers: { Cookie: cookie } })).status).toBe(
      403,
    );
    const crossSite = await send(h.port, '/api/ui/activity', {
      headers: { Cookie: cookie, 'X-AgentLink-CSRF': csrf, 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(crossSite.status).toBe(403);
    const res = await send(h.port, '/api/ui/activity', {
      headers: { Cookie: cookie, 'X-AgentLink-CSRF': csrf },
    });
    // The handler ran: this harness has no agent client, so the activity page (M1-11c-a1) says so.
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_set_up' });
    expect((await send(h.port, '/api/ui/nope', { headers: { Cookie: cookie } })).status).toBe(404);
    const wrongMethod = await send(h.port, '/api/ui/activity', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: h.origin, 'X-AgentLink-CSRF': csrf },
    });
    expect(wrongMethod.status).toBe(405);
  });

  it('gates the Messages reads like every route: session, CSRF, same-origin; GET only (MSG-FILES-IO-c)', async () => {
    const h = await harness();
    const paths = ['/api/ui/messages', `/api/ui/messages/0x${'b0'.repeat(20)}?box=in&limit=5`];
    for (const path of paths) {
      expect((await send(h.port, path)).status).toBe(401);
    }
    const cookie = await h.cookie();
    const csrf = await h.csrf(cookie);
    for (const path of paths) {
      expect((await send(h.port, path, { headers: { Cookie: cookie } })).status).toBe(403);
      for (const site of ['cross-site', 'same-site']) {
        const res = await send(h.port, path, {
          headers: { Cookie: cookie, 'X-AgentLink-CSRF': csrf, 'Sec-Fetch-Site': site },
        });
        expect(res.status).toBe(403);
      }
      const res = await send(h.port, path, {
        headers: { Cookie: cookie, 'X-AgentLink-CSRF': csrf, 'Sec-Fetch-Site': 'same-origin' },
      });
      // The handler ran: this harness has no agent client.
      expect(res.status).toBe(409);
      expect(JSON.parse(res.body)).toEqual({ error: 'not_set_up' });
      const post = await send(h.port, path, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: h.origin, 'X-AgentLink-CSRF': csrf },
      });
      expect(post.status).toBe(405);
    }
  });

  /** A presence route whose handler records each call and signs one contact.check. */
  function ownerRoutes(calls: { input: unknown; signed?: OwnerSignature[]; second?: unknown }[]) {
    const routes = createLocalUiRoutes();
    routes.register({
      method: 'POST',
      path: '/api/ui/test/:id/check',
      presence: true,
      handler: async (_ctx, req, ownerOp: LocalUiOwnerOperation) => {
        const call: { input: unknown; signed?: OwnerSignature[]; second?: unknown } = {
          input: { params: req.params, input: req.input },
        };
        calls.push(call);
        const action = {
          v: 1,
          op: 'contact.check',
          agent: agentId,
          owner: encodeHex(owner.ownerNostr),
          nonce: 'n'.repeat(22),
          params: { contact: req.params['id'] ?? '' },
        };
        call.signed = [
          ...(await ownerOp.sign({ lines: ['Mark the safety code as checked'] }, [
            { kind: 'owner-action', action },
          ])),
        ];
        try {
          await ownerOp.sign({ lines: ['again'] }, [{ kind: 'owner-action', action }]);
        } catch (error) {
          call.second = error;
        }
        return { status: 200, body: { status: 'done' } };
      },
    });
    return routes;
  }

  async function post(
    h: Harness,
    body: Uint8Array | undefined,
    extra: Record<string, string> = {},
  ): Promise<Response> {
    const cookie = await h.cookie();
    const csrf = await h.csrf(cookie);
    return send(h.port, '/api/ui/test/c1/check', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: h.origin,
        'X-AgentLink-CSRF': csrf,
        'Content-Type': 'application/octet-stream',
        'Sec-Fetch-Site': 'same-origin',
        ...extra,
      },
      ...(body === undefined ? {} : { body }),
    });
  }

  it('refuses a presence route without owner presence before the handler runs', async () => {
    const calls: { input: unknown }[] = [];
    const h = await harness({ internals: { routes: ownerRoutes(calls) } });
    const none = await post(h, undefined);
    expect(none.status).toBe(403);
    expect(JSON.parse(none.body)).toEqual({ status: 'presence_required' });
    const unknownMode = await post(h, encodeUtf8(code), { 'X-AgentLink-Presence': 'token' });
    expect(unknownMode.status).toBe(403);
    const badPasskey = await post(h, encodeUtf8('not an assertion'), {
      'X-AgentLink-Presence': 'passkey',
    });
    expect(badPasskey.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('refuses a presence route without Origin, without CSRF or with a simple content type', async () => {
    const calls: { input: unknown }[] = [];
    const h = await harness({ internals: { routes: ownerRoutes(calls) } });
    const cookie = await h.cookie();
    const csrf = await h.csrf(cookie);
    const base = {
      Cookie: cookie,
      Origin: h.origin,
      'X-AgentLink-CSRF': csrf,
      'Content-Type': 'application/octet-stream',
    };
    const variants: [Record<string, string>, number][] = [
      [{ ...base, Origin: '' }, 403],
      [{ ...base, 'X-AgentLink-CSRF': 'x' }, 403],
      [{ ...base, 'Content-Type': 'text/plain' }, 415],
      [{ ...base, Cookie: '' }, 401],
    ];
    for (const [headers, status] of variants) {
      const clean = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== ''));
      const res = await send(h.port, '/api/ui/test/c1/check', {
        method: 'POST',
        headers: clean,
        body: encodeUtf8(code),
      });
      expect(res.status).toBe(status);
    }
    expect(calls).toHaveLength(0);
  });

  it('runs the handler with owner presence: one signature, once, over what the handler built', async () => {
    const calls: { input: unknown; signed?: OwnerSignature[]; second?: unknown }[] = [];
    const h = await harness({ internals: { routes: ownerRoutes(calls) } });
    const input = encodeBase64url(encodeUtf8(JSON.stringify({ note: 'hi' })));
    const res = await post(h, encodeUtf8(code), { 'X-AgentLink-Input': input });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'done' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toEqual({ params: { id: 'c1' }, input: { note: 'hi' } });
    const signed = calls[0]?.signed?.[0];
    expect(signed?.kind).toBe('owner-action');
    if (signed?.kind !== 'owner-action') throw new Error('unreachable');
    const digest = taggedHash(TAGS.ownerAction, sha256(canonicalizeToBytes(signed.signed.body)));
    expect(
      bip340Verify(owner.ownerNostr, digest, decodeHex(signed.signed.sig, { length: 64 })),
    ).toBe(true);
    expect((signed.signed.body as JsonObject)['op']).toBe('contact.check');
    // The one entry served one owner operation: a second signature is refused.
    expect(calls[0]?.second).toBeInstanceOf(Error);
  });

  it('refuses a malformed input header before presence is used', async () => {
    const calls: { input: unknown }[] = [];
    const h = await harness({ internals: { routes: ownerRoutes(calls) } });
    for (const bad of ['%%%', encodeBase64url(encodeUtf8('{not json')), 'A'.repeat(20_000)]) {
      const res = await post(h, encodeUtf8(code), { 'X-AgentLink-Input': bad });
      expect([400, 431]).toContain(res.status);
    }
    expect(calls).toHaveLength(0);
  });

  // IR-M1-11s-b-1 H-1: presence is verified before the handler runs. A wrong code never reaches it
  // (this test pinned the opposite at eebdebd6, a bad pin corrected here, not a weakening).
  it('refuses a wrong owner code before the handler runs and counts it towards the backoff', async () => {
    const calls: { input: unknown }[] = [];
    let clock = 1_000_000;
    const h = await harness({ internals: { routes: ownerRoutes(calls), now: () => clock } });
    for (let i = 0; i < 3; i += 1) {
      const res = await post(h, encodeUtf8('AAAA BBBB CCCC DDDD EEEE FFFF'));
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ status: 'presence_rejected' });
    }
    expect(calls).toHaveLength(0);
    const held = await post(h, encodeUtf8(code));
    expect(held.status).toBe(429);
    expect(held.headers['retry-after']).toBe('5');
    expect(calls).toHaveLength(0);
    clock += 6_000;
    expect((await post(h, encodeUtf8(code))).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('refuses a presence route whose handler returns without signing (409, never its result)', async () => {
    const routes = createLocalUiRoutes();
    let ran = 0;
    routes.register({
      method: 'POST',
      path: '/api/ui/test/:id/check',
      presence: true,
      handler: () => {
        ran += 1;
        return Promise.resolve({ status: 200, body: { status: 'changed without signing' } });
      },
    });
    const h = await harness({ internals: { routes } });
    const res = await post(h, encodeUtf8(code));
    expect(ran).toBe(1);
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ status: 'refused' });
  });

  it('closes the session and locks the store after success, a handler error and a wrong code', async () => {
    const seen: { locked: number; closed: number; sessionsClosed: number }[] = [];
    const openOwnerStore = async (expected: OwnerPublicKeys) => {
      const store = await KeychainOwnerKeyStore.open(keychain, expected);
      const record = { locked: 0, closed: 0, sessionsClosed: 0 };
      seen.push(record);
      const lock = store.lock.bind(store);
      const close = store.close.bind(store);
      const unlock = store.unlock.bind(store);
      store.lock = () => {
        record.locked += 1;
        return lock();
      };
      store.close = () => {
        record.closed += 1;
        return close();
      };
      store.unlock = async (...args: Parameters<typeof unlock>) => {
        const session = await unlock(...args);
        const end = session.close.bind(session);
        session.close = () => {
          record.sessionsClosed += 1;
          return end();
        };
        return session;
      };
      return store;
    };
    const routes = ownerRoutes([]);
    let afterSign: { signed?: OwnerSignature[] } | undefined;
    routes.register({
      method: 'POST',
      path: '/api/ui/test/:id/fail',
      presence: true,
      handler: async (_ctx, req, ownerOp) => {
        afterSign = {
          signed: [
            ...(await ownerOp.sign({ lines: ['Check'] }, [
              {
                kind: 'owner-action',
                action: {
                  v: 1,
                  op: 'contact.check',
                  agent: agentId,
                  owner: encodeHex(owner.ownerNostr),
                  nonce: 'm'.repeat(22),
                  params: { contact: req.params['id'] ?? '' },
                },
              },
            ])),
          ],
        };
        throw new Error('the handler failed after signing');
      },
    });
    const h = await harness({ internals: { routes, openOwnerStore } });
    expect((await post(h, encodeUtf8(code))).status).toBe(200);
    expect((await post(h, encodeUtf8('AAAA BBBB CCCC DDDD EEEE FFFF'))).status).toBe(403);
    const cookie = await h.cookie();
    const csrf = await h.csrf(cookie);
    const failed = await send(h.port, '/api/ui/test/c1/fail', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: h.origin,
        'X-AgentLink-CSRF': csrf,
        'Content-Type': 'application/octet-stream',
      },
      body: encodeUtf8(code),
    });
    expect(failed.status).toBe(500);
    expect(afterSign?.signed).toHaveLength(1);
    // close() locks as well, so lock runs at least once per request.
    expect(
      seen.map((r) => ({
        locked: r.locked >= 1,
        closed: r.closed,
        sessionsClosed: r.sessionsClosed,
      })),
    ).toEqual([
      { locked: true, closed: 1, sessionsClosed: 1 },
      { locked: true, closed: 1, sessionsClosed: 0 },
      { locked: true, closed: 1, sessionsClosed: 1 },
    ]);
  });

  it('gives handlers a read-only view of the core client, never the client itself', async () => {
    const routes = createLocalUiRoutes();
    let client: unknown;
    routes.register({
      method: 'GET',
      path: '/api/ui/test/client',
      presence: false,
      handler: (ctx) => {
        client = ctx.client;
        return Promise.resolve({ status: 200, body: {} });
      },
    });
    const full = {
      agentId: 'agent-1',
      getProof: () => Promise.resolve(undefined),
      sendMessage: () => Promise.reject(new Error('never')),
      notarize: () => Promise.reject(new Error('never')),
      store: {},
      keyStore: {},
    };
    const h = await harness({ internals: { routes }, client: full });
    const cookie = await h.cookie();
    const csrf = await h.csrf(cookie);
    const res = await send(h.port, '/api/ui/test/client', {
      headers: { Cookie: cookie, 'X-AgentLink-CSRF': csrf },
    });
    expect(res.status).toBe(200);
    expect(client).not.toBe(full);
    // M1-11c-a1 adds the activity feed read, M1-11c-a2 the contacts read, M1-11c-a4 the proofs read (context.ts).
    // MSG-FILES-IO-c adds the read-only messages view.
    expect(Object.keys(client as object).sort()).toEqual([
      'agentId',
      'contacts',
      'files',
      'getProof',
      'listActivity',
      'messages',
      'policy',
      'proofs',
    ]);
    expect(Object.isFrozen(client)).toBe(true);
  });
});
