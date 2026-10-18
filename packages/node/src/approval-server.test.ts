// M1-8d acceptance: the local approval server (08 §1; 04 §2.5; 06 §2.5; I-4, I-7).
//
// - Served as `http://localhost:<port>` (M1-31, D-79), listening on 127.0.0.1 and ::1 on one random
//   port and nowhere else; the session token lives in memory and in the opened URL.
// - Wrong or missing token → 401; a `Host` other than `localhost:<port>` (DNS rebinding, and
//   `127.0.0.1:<port>`) and a foreign `Origin` are refused;
//   no state change through a simple cross-site request (CSRF token, non-simple content type).
// - The token grants viewing only: approving or denying needs the owner code or owner passphrase,
//   and produces an owner-signed `approval.decide` that the source (core) verifies and applies.
// - Each approval ID is decided once through the server; a second decision is refused.
// - The token never reaches a file, a log line, an event, an approval URL or an error body.
// - The M1-8c same-user script, run against the live server, cannot approve without the owner code.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
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
  type JsonValue,
  type OwnerPublicKeys,
} from '@4thtech-io/crypto';
import type { OwnerActionOutcome } from '@4thtech-io/core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  APPROVAL_SERVER_HOST,
  startApprovalServerWith,
  type ApprovalForDecision,
  type ApprovalServerInternals,
  type ApprovalServer,
  type ApprovalServerEvent,
  type ApprovalServerSource,
} from './approval-server.js';
import { createKeychainAgent } from './keychain-keystore.js';
import type { KeychainBackend } from './keychain.js';
import { initOwnerWith } from './owner-init.js';
import { KeychainOwnerKeyStore } from './owner-keystore.js';
import type { OwnerTerminal } from './owner-terminal.js';

const execFileAsync = promisify(execFile);
const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'approval-server-script.mjs',
);
const root = mkdtempSync(join(tmpdir(), 'agentlink-m1-8d-'));
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
/** Whether this machine can listen on ::1 (then the server must too). */
let hostHasIpv6 = false;

beforeAll(async () => {
  hostHasIpv6 = await new Promise<boolean>((resolve) => {
    const probe = createNetServer();
    probe.once('error', () => resolve(false));
    probe.listen({ host: '::1', port: 0, ipv6Only: true }, () => probe.close(() => resolve(true)));
  });
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

/**
 * A stand-in for core's approval read and `ownerActions.apply`: it verifies the owner signature, the
 * agent, the approval ID and the action digest against its own pending rows, burns the nonce and
 * marks the row decided (the M1-7d/M1-7e checks this test needs).
 */
function fakeSource(): ApprovalServerSource & {
  readonly applied: { body: JsonObject; sig: string }[];
  readonly calls: { apply: number; get: number };
  add(n: number, extra?: Partial<ApprovalForDecision>): ApprovalForDecision;
} {
  const rows = new Map<string, ApprovalForDecision>();
  const nonces = new Set<string>();
  const applied: { body: JsonObject; sig: string }[] = [];
  const calls = { apply: 0, get: 0 };
  return {
    applied,
    calls,
    add(n, extra = {}) {
      const action = { tool: 'agentlink_send', to: `contact-${String(n)}`, text: 'hello' };
      const row: ApprovalForDecision = {
        approvalId: id(n),
        summary: `Send a message to Contact ${String(n)}`,
        actionDigest: digestOf(action),
        storedDigest: digestOf(action),
        action,
        expiresAt: Math.floor(Date.now() / 1000) + 3_600,
        commitment: false,
        ...extra,
      };
      rows.set(row.approvalId, row);
      return row;
    },
    context: () => Promise.resolve({ agent: agentId, owner }),
    list: () =>
      Promise.resolve(
        [...rows.values()].map(({ approvalId, summary, actionDigest, expiresAt, commitment }) => ({
          approvalId,
          summary,
          actionDigest,
          expiresAt,
          commitment,
        })),
      ),
    get: (approvalId) => {
      calls.get += 1;
      return Promise.resolve(rows.get(approvalId));
    },
    apply: (signed) => {
      calls.apply += 1;
      const body = signed.body;
      const params = body['params'] as Record<string, unknown> | undefined;
      const row = rows.get(String(params?.['approvalId']));
      const refused = (reason: string): OwnerActionOutcome =>
        ({ status: 'refused', op: 'approval.decide', reason, nonceBurnt: false }) as never;
      if (!ownerSigValid(body, signed.sig)) return Promise.resolve(refused('bad_signature'));
      if (body['agent'] !== agentId) return Promise.resolve(refused('wrong_agent'));
      if (row === undefined) return Promise.resolve(refused('not_pending'));
      if (params?.['actionDigest'] !== row.storedDigest) {
        return Promise.resolve(refused('digest_mismatch'));
      }
      const nonce = String(body['nonce']);
      if (nonces.has(nonce)) return Promise.resolve(refused('nonce_used'));
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

/** A raw HTTP request, so the test controls Host, Origin and every other header. */
function send(
  port: number,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: Uint8Array;
    /** The loopback address to connect to (a browser may pick either for `localhost`). */
    via?: '127.0.0.1' | '::1';
  } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: options.via ?? '127.0.0.1',
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
  readonly token: string;
  readonly origin: string;
  readonly port: number;
  readonly events: ApprovalServerEvent[];
  readonly opened: string[];
  readonly notified: string[][];
  readonly ownerStoresOpened: { count: number };
  cookie(): Promise<string>;
  csrf(cookie: string): Promise<string>;
}

const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  vi.restoreAllMocks();
});

async function harness(extra: ApprovalServerInternals = {}): Promise<Harness> {
  const source = fakeSource();
  const events: ApprovalServerEvent[] = [];
  const opened: string[] = [];
  const notified: string[][] = [];
  const ownerStoresOpened = { count: 0 };
  const server = await startApprovalServerWith(
    { source, onEvent: (e) => void events.push(e) },
    {
      openOwnerStore: (expected) => {
        ownerStoresOpened.count += 1;
        return KeychainOwnerKeyStore.open(keychain, expected);
      },
      opener: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      notifier: (lines) => {
        notified.push([...lines]);
        return Promise.resolve(true);
      },
      ...extra,
    },
  );
  servers.push(server);
  await server.open();
  const sessionUrl = opened[0] ?? '';
  const url = new URL(sessionUrl);
  const token = url.searchParams.get('t') ?? '';
  const port = server.port;
  const h: Harness = {
    server,
    source,
    token,
    origin: server.origin,
    port,
    events,
    opened,
    notified,
    ownerStoresOpened,
    // M1-11a: the session link is one-shot, so every new cookie comes through a new link.
    async cookie() {
      const at = opened.length; // open() hands its link to the opener synchronously
      await server.open();
      const fresh = new URL(opened[at] ?? '').searchParams.get('t') ?? '';
      const res = await send(port, `/?t=${fresh}`);
      expect(res.status).toBe(303);
      const set = res.headers['set-cookie']?.[0] ?? '';
      return set.split(';')[0] ?? '';
    },
    async csrf(cookie) {
      const res = await send(port, '/', { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);
      const match = /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(res.body);
      return match?.[1] ?? '';
    },
  };
  return h;
}

/** A same-origin decision request as the genuine page sends it. */
async function decide(
  h: Harness,
  approvalId: string,
  decision: 'approve' | 'deny',
  secret: string | undefined,
  override: { headers?: Record<string, string>; digest?: string } = {},
): Promise<Response> {
  const cookie = await h.cookie();
  const csrf = await h.csrf(cookie);
  const row = await h.source.get(approvalId);
  return send(h.port, `/api/approvals/${approvalId}/${decision}`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: h.origin,
      'Content-Type': 'application/octet-stream',
      'X-AgentLink-CSRF': csrf,
      'X-AgentLink-Digest': override.digest ?? row?.actionDigest ?? '',
      'Sec-Fetch-Site': 'same-origin',
      ...override.headers,
    },
    ...(secret === undefined ? {} : { body: encodeUtf8(secret) }),
  });
}

describe('binding and the session token (08 §1)', () => {
  it('serves http://localhost:<port> from 127.0.0.1 and ::1 on one random port', async () => {
    const a = await harness();
    const b = await harness();
    expect(APPROVAL_SERVER_HOST).toBe('localhost');
    expect(a.server.address()).toEqual({
      host: 'localhost',
      port: a.port,
      addresses: hostHasIpv6 ? ['127.0.0.1', '::1'] : ['127.0.0.1'],
    });
    expect(a.port).toBeGreaterThan(0);
    expect(a.port).not.toBe(b.port);
    expect(a.origin).toBe(`http://localhost:${String(a.port)}`);
    expect(a.server.approvalUrl(id(1))).toBe(`${a.origin}/approve/${id(1)}`);
    // A random 256-bit token, base64url, different per server.
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.opened[0]).toBe(`${a.origin}/?t=${a.token}`);
  });

  it('answers 401 without the token or with a wrong one', async () => {
    const h = await harness();
    const wrong = encodeBase64url(new Uint8Array(32));
    for (const path of ['/', '/approve/' + id(1), `/?t=${wrong}`, '/?t=', `/?t=${h.token}x`]) {
      const res = await send(h.port, path);
      expect(res.status, path).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    const cookieName = `agentlink_${String(h.port)}`;
    const res = await send(h.port, '/', { headers: { Cookie: `${cookieName}=${wrong}` } });
    expect(res.status).toBe(401);
    // Another server's token does not open this one.
    const other = await harness();
    expect((await send(h.port, `/?t=${other.token}`)).status).toBe(401);
    // The API answers 401 too.
    expect((await send(h.port, '/api/approvals')).status).toBe(401);
  });

  it('exchanges the token for an HttpOnly session cookie and redirects without it', async () => {
    const h = await harness();
    const res = await send(h.port, `/approve/${id(1)}?t=${h.token}`);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/approve/${id(1)}`);
    const set = res.headers['set-cookie']?.[0] ?? '';
    expect(set).toContain(`agentlink_${String(h.port)}=`);
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Strict');
    expect(set).toContain('Path=/');
    expect(set).not.toMatch(/Expires|Max-Age/i);
    const cookie = await h.cookie();
    const page = await send(h.port, `/approve/${id(1)}`, { headers: { Cookie: cookie } });
    expect(page.status).toBe(200);
    expect(page.body).toContain("Your AI can't approve this for you");
  });

  it('sends no-store, no-referrer, no framing and a strict CSP on every answer', async () => {
    const h = await harness();
    const cookie = await h.cookie();
    for (const res of [
      await send(h.port, '/', { headers: { Cookie: cookie } }),
      await send(h.port, '/'),
      await send(h.port, '/', { headers: { Host: 'evil.example' } }),
    ]) {
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      const csp = String(res.headers['content-security-policy']);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain('unsafe-inline');
    }
  });
});

describe('both loopback addresses on one port (M1-31, D-79)', () => {
  /** Holds `host:port` the way another program on the machine would. */
  const hold = (host: string, port: number): Promise<NetServer> =>
    new Promise((resolve, rejectHold) => {
      const s = createNetServer();
      s.once('error', rejectHold);
      s.listen({ host, port, ipv6Only: host === '::1' }, () => resolve(s));
    });
  const held: NetServer[] = [];
  afterEach(async () => {
    await Promise.all(held.splice(0).map((s) => new Promise((r) => s.close(r))));
  });
  const realListen = (
    server: Server,
    options: { readonly host: string; readonly port: number; readonly ipv6Only?: boolean },
  ): Promise<void> =>
    new Promise((resolve, rejectListen) => {
      server.once('error', rejectListen);
      server.listen({ ...options, exclusive: true }, () => {
        server.off('error', rejectListen);
        resolve();
      });
    });
  const addressError = (code: string): Error => Object.assign(new Error(code), { code });

  it('answers a request that arrives over ::1 with Host localhost:<port>', async () => {
    const h = await harness();
    if (!hostHasIpv6) {
      // No IPv6 on this machine: the server listens on 127.0.0.1 only (the fallback test below).
      expect(h.server.address().addresses).toEqual(['127.0.0.1']);
      return;
    }
    const res = await send(h.port, `/?t=${h.token}`, { via: '::1' });
    expect(res.status).toBe(303);
    const cookie = (res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
    expect((await send(h.port, '/', { via: '::1', headers: { Cookie: cookie } })).status).toBe(200);
    // One session behind both addresses: a cookie set over ::1 works over 127.0.0.1 too.
    expect((await send(h.port, '/', { headers: { Cookie: cookie } })).status).toBe(200);
    // Over ::1 the Host rule is the same.
    const wrong = await send(h.port, `/?t=${h.token}`, {
      via: '::1',
      headers: { Host: `[::1]:${String(h.port)}` },
    });
    expect(wrong.status).toBe(403);
  });

  it('moves to a new port when another program holds ::1 on the one it chose', async () => {
    const tried: number[] = [];
    let first = true;
    const h = await harness({
      listen: async (server, options) => {
        if (options.host === '::1') {
          tried.push(options.port);
          if (first) {
            first = false;
            if (!hostHasIpv6) throw addressError('EADDRINUSE');
            held.push(await hold('::1', options.port));
          }
        }
        return realListen(server, options);
      },
    });
    expect(tried.length).toBe(2);
    expect(tried[1]).toBe(h.port);
    expect(h.port).not.toBe(tried[0]);
    expect(h.server.address().addresses).toEqual(
      hostHasIpv6 ? ['127.0.0.1', '::1'] : ['127.0.0.1'],
    );
    // The first port's IPv4 listener was released.
    await expect(send(tried[0] as number, `/?t=${h.token}`)).rejects.toThrow();
    expect((await send(h.port, `/?t=${h.token}`)).status).toBe(303);
  });

  it('gives up after five ports when ::1 is always taken, closing what it opened', async () => {
    let attempts = 0;
    const v4: Server[] = [];
    await expect(
      harness({
        listen: (server, options) => {
          if (options.host === '::1') {
            attempts += 1;
            return Promise.reject(addressError('EADDRINUSE'));
          }
          v4.push(server);
          return realListen(server, options);
        },
      }),
    ).rejects.toThrow();
    expect(attempts).toBe(5);
    expect(v4.length).toBe(5);
    for (const s of v4) expect(s.listening).toBe(false);
  });

  it('listens on 127.0.0.1 only, with a fixed event, when the machine has no IPv6', async () => {
    for (const code of ['EADDRNOTAVAIL', 'EAFNOSUPPORT']) {
      const h = await harness({
        listen: (server, options) =>
          options.host === '::1' ? Promise.reject(addressError(code)) : realListen(server, options),
      });
      expect(h.server.address()).toEqual({
        host: 'localhost',
        port: h.port,
        addresses: ['127.0.0.1'],
      });
      expect(h.origin).toBe(`http://localhost:${String(h.port)}`);
      expect(h.events).toContainEqual({ kind: 'ipv6_unavailable' });
      expect((await send(h.port, `/?t=${h.token}`)).status).toBe(303);
    }
  });

  it('fails closed on any other ::1 listen error', async () => {
    const v4: Server[] = [];
    await expect(
      harness({
        listen: (server, options) => {
          if (options.host === '::1') return Promise.reject(addressError('EACCES'));
          v4.push(server);
          return realListen(server, options);
        },
      }),
    ).rejects.toThrow();
    expect(v4.length).toBe(1);
    for (const s of v4) expect(s.listening).toBe(false);
  });

  it('listens only on 127.0.0.1 and ::1 (IPv6-only), never a wildcard or other address', async () => {
    const calls: { host: string; ipv6Only?: boolean }[] = [];
    await harness({
      listen: (server, options) => {
        calls.push({
          host: options.host,
          ...(options.ipv6Only === undefined ? {} : { ipv6Only: options.ipv6Only }),
        });
        return hostHasIpv6 || options.host !== '::1'
          ? realListen(server, options)
          : Promise.reject(addressError('EADDRNOTAVAIL'));
      },
    });
    expect(calls).toEqual([{ host: '127.0.0.1' }, { host: '::1', ipv6Only: true }]);
  });
});

describe('Host and Origin checks (DNS rebinding, cross-site requests)', () => {
  it('refuses a wrong Host header even with the right token', async () => {
    const h = await harness();
    const cookie = await h.cookie();
    for (const host of [
      'evil.example',
      `evil.example:${String(h.port)}`,
      `127.0.0.1:${String(h.port)}`,
      'localhost',
      `localhost:${String(h.port + 1)}`,
      `localhost.:${String(h.port)}`,
      `localhost:0${String(h.port)}`,
      `localhost.evil.example:${String(h.port)}`,
      '[::1]',
      '127.0.0.1',
      `127.0.0.1:${String(h.port + 1)}`,
      `127.0.0.1.evil.example:${String(h.port)}`,
      `[::1]:${String(h.port)}`,
      `127.0.0.1.:${String(h.port)}`,
      `LOCALHOST:${String(h.port)}`,
      `EVIL.EXAMPLE:${String(h.port)}`,
    ]) {
      const viaToken = await send(h.port, `/?t=${h.token}`, { headers: { Host: host } });
      expect(viaToken.status, host).toBe(403);
      expect(viaToken.headers['set-cookie'], host).toBeUndefined();
      const viaCookie = await send(h.port, '/api/approvals', {
        headers: { Host: host, Cookie: cookie },
      });
      expect(viaCookie.status, host).toBe(403);
    }
    expect(h.events.some((e) => e.kind === 'rejected' && e.reason === 'host')).toBe(true);
  });

  it('refuses a cross-origin POST and reaches neither the owner store nor core', async () => {
    const h = await harness();
    h.source.add(1);
    for (const headers of [
      { Origin: 'http://evil.example' },
      { Origin: `http://127.0.0.1:${String(h.port + 1)}` },
      { Origin: `http://127.0.0.1:${String(h.port)}` },
      { Origin: `http://[::1]:${String(h.port)}` },
      { Origin: `http://localhost:${String(h.port + 1)}` },
      { Origin: `https://localhost:${String(h.port)}` },
      { Origin: `http://localhost.:${String(h.port)}` },
      { Origin: `http://LOCALHOST:${String(h.port)}` },
      { Origin: 'null' },
      { Origin: '' },
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Site': 'same-site' },
    ]) {
      const res = await decide(h, id(1), 'approve', code, { headers });
      expect(res.status, JSON.stringify(headers)).toBe(403);
    }
    expect(h.ownerStoresOpened.count).toBe(0);
    expect(h.source.calls.apply).toBe(0);
  });

  it('refuses a POST with no Origin, no or a wrong CSRF token, or a simple content type', async () => {
    const h = await harness();
    h.source.add(1);
    const cookie = await h.cookie();
    const csrf = await h.csrf(cookie);
    const row = await h.source.get(id(1));
    const base = {
      Cookie: cookie,
      Origin: h.origin,
      'Content-Type': 'application/octet-stream',
      'X-AgentLink-CSRF': csrf,
      'X-AgentLink-Digest': row?.actionDigest ?? '',
    };
    const without = (name: string): Record<string, string> => {
      const copy: Record<string, string> = { ...base };
      Reflect.deleteProperty(copy, name);
      return copy;
    };
    const cases: [string, Record<string, string>, number][] = [
      ['no origin', without('Origin'), 403],
      ['no csrf', without('X-AgentLink-CSRF'), 403],
      ['wrong csrf', { ...base, 'X-AgentLink-CSRF': h.token }, 403],
      ['token as csrf is not csrf', { ...base, 'X-AgentLink-CSRF': csrf + 'A' }, 403],
      ['text/plain', { ...base, 'Content-Type': 'text/plain' }, 415],
      ['form', { ...base, 'Content-Type': 'application/x-www-form-urlencoded' }, 415],
      ['multipart', { ...base, 'Content-Type': 'multipart/form-data; boundary=x' }, 415],
      ['no cookie', without('Cookie'), 401],
    ];
    for (const [name, headers, status] of cases) {
      const res = await send(h.port, `/api/approvals/${id(1)}/approve`, {
        method: 'POST',
        headers,
        body: encodeUtf8(code),
      });
      expect(res.status, name).toBe(status);
    }
    expect(h.ownerStoresOpened.count).toBe(0);
    expect(h.source.calls.apply).toBe(0);
  });

  it('changes nothing through GET, and refuses other methods', async () => {
    const h = await harness();
    h.source.add(1);
    const cookie = await h.cookie();
    expect(
      (await send(h.port, `/api/approvals/${id(1)}/approve`, { headers: { Cookie: cookie } }))
        .status,
    ).toBe(405);
    expect(
      (await send(h.port, `/approve/${id(1)}/approve`, { headers: { Cookie: cookie } })).status,
    ).toBe(404);
    // A view with a query string is still only a view.
    await send(h.port, `/approve/${id(1)}?decision=approve`, { headers: { Cookie: cookie } });
    for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const res = await send(h.port, `/api/approvals/${id(1)}/approve`, {
        method,
        headers: { Cookie: cookie, Origin: h.origin },
      });
      expect(res.status, method).toBe(405);
      // No CORS grant, ever.
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
    expect(h.source.calls.apply).toBe(0);
  });

  it('requires the CSRF header and same-origin fetch metadata to read the API', async () => {
    const h = await harness();
    h.source.add(1);
    const cookie = await h.cookie();
    const csrf = await h.csrf(cookie);
    const ok = await send(h.port, '/api/approvals', {
      headers: { Cookie: cookie, 'X-AgentLink-CSRF': csrf, 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toContain('application/json');
    const list = JSON.parse(ok.body) as { approvals: { approvalId: string }[] };
    expect(list.approvals.map((a) => a.approvalId)).toEqual([id(1)]);
    expect(ok.body).not.toContain('hello'); // the action itself is never served
    expect((await send(h.port, '/api/approvals', { headers: { Cookie: cookie } })).status).toBe(
      403,
    );
    expect(
      (
        await send(h.port, '/api/approvals', {
          headers: { Cookie: cookie, 'X-AgentLink-CSRF': csrf, 'Sec-Fetch-Site': 'cross-site' },
        })
      ).status,
    ).toBe(403);
  });
});

describe('owner presence for every decision (04 §2.5, I-4)', () => {
  it('refuses to approve without the owner code, and with a wrong one', async () => {
    const h = await harness();
    h.source.add(1);
    const none = await decide(h, id(1), 'approve', undefined);
    expect(none.status).toBe(403);
    expect(JSON.parse(none.body)).toMatchObject({ status: 'presence_required' });
    expect(h.ownerStoresOpened.count).toBe(0);
    const wrong = await decide(h, id(1), 'approve', 'AAAA BBBB CCCC DDDD EEEE FFFF');
    expect(wrong.status).toBe(403);
    expect(JSON.parse(wrong.body)).toMatchObject({ status: 'presence_rejected' });
    expect(h.source.calls.apply).toBe(0);
    expect(h.source.applied).toEqual([]);
  });

  it('signs one approval.decide over exactly the shown request with the owner code', async () => {
    const h = await harness();
    const row = h.source.add(1);
    const res = await decide(h, id(1), 'approve', code);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'applied', decision: 'approve' });
    expect(h.source.applied).toHaveLength(1);
    const signed = h.source.applied[0];
    if (signed === undefined) throw new Error('unreachable');
    expect(ownerSigValid(signed.body, signed.sig)).toBe(true);
    expect(signed.body['op']).toBe('approval.decide');
    expect(signed.body['agent']).toBe(agentId);
    expect(signed.body['params']).toEqual({
      approvalId: id(1),
      actionDigest: row.storedDigest,
      decision: 'approve',
    });
  });

  it('denies with the owner code too', async () => {
    const h = await harness();
    h.source.add(2);
    const res = await decide(h, id(2), 'deny', code);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'applied', decision: 'deny' });
    expect((h.source.applied[0]?.body['params'] as Record<string, unknown>)['decision']).toBe(
      'deny',
    );
  });

  it('decides each approval ID once (single use)', async () => {
    const h = await harness();
    h.source.add(1);
    expect((await decide(h, id(1), 'approve', code)).status).toBe(200);
    const opened = h.ownerStoresOpened.count;
    // The source still offers it (a stale cache): the server refuses before asking for presence.
    h.source.add(1);
    const again = await decide(h, id(1), 'approve', code);
    expect(again.status).toBe(409);
    expect(h.ownerStoresOpened.count).toBe(opened);
    expect(h.source.applied).toHaveLength(1);
  });

  it('runs one owner operation at a time: two concurrent approvals of one ID apply once', async () => {
    const h = await harness();
    h.source.add(1);
    const results = await Promise.all([
      decide(h, id(1), 'approve', code),
      decide(h, id(1), 'approve', code),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(h.source.applied).toHaveLength(1);
  });

  it('refuses when the request changed since the page showed it, or is not pending', async () => {
    const h = await harness();
    h.source.add(1);
    const stale = await decide(h, id(1), 'approve', code, { digest: '00'.repeat(32) });
    expect(stale.status).toBe(409);
    const missing = await decide(h, id(5), 'approve', code, { digest: '11'.repeat(32) });
    expect(missing.status).toBe(409);
    // The stored digest does not match the stored action: never offered (04 §2.5.2 step 2).
    h.source.add(3, { storedDigest: '22'.repeat(32), actionDigest: '22'.repeat(32) });
    const tampered = await decide(h, id(3), 'approve', code);
    expect(tampered.status).toBe(409);
    expect(h.source.applied).toEqual([]);
    expect(h.ownerStoresOpened.count).toBeLessThanOrEqual(1);
  });

  it('refuses a malformed approval ID and an oversized owner secret', async () => {
    const h = await harness();
    const cookie = await h.cookie();
    const csrf = await h.csrf(cookie);
    const headers = {
      Cookie: cookie,
      Origin: h.origin,
      'Content-Type': 'application/octet-stream',
      'X-AgentLink-CSRF': csrf,
      'X-AgentLink-Digest': '11'.repeat(32),
    };
    for (const bad of ['apr_short', '..%2F..%2Fetc', `${id(1)}x`, 'apr_' + '-'.repeat(21) + '/']) {
      const res = await send(h.port, `/api/approvals/${bad}/approve`, {
        method: 'POST',
        headers,
        body: encodeUtf8(code),
      });
      expect([400, 404], bad).toContain(res.status);
    }
    h.source.add(1);
    const big = await send(h.port, `/api/approvals/${id(1)}/approve`, {
      method: 'POST',
      headers: {
        ...headers,
        'X-AgentLink-Digest': (await h.source.get(id(1)))?.actionDigest ?? '',
      },
      body: new Uint8Array(4096).fill(65),
    });
    expect(big.status).toBe(413);
    expect(h.source.calls.apply).toBe(0);
  });
});

// M1-11a-b: `agentlink mcp` puts approvalUrl(id) in the `pending_approval` result, so the agent sees
// it. It must grant nothing: the session comes only from the one-shot link handed to the OS opener,
// and a decision needs owner presence even with a session.
describe('the agent-visible approval url (M1-11a-b, 06 §2.5, I-4)', () => {
  it('holds no token and opens nothing by itself', async () => {
    const h = await harness();
    h.source.add(1);
    const url = h.server.approvalUrl(id(1));
    expect(url).toBe(`${h.origin}/approve/${id(1)}`);
    expect(new URL(url).search).toBe('');
    const res = await send(h.port, new URL(url).pathname);
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body).toContain('This link has expired');
  });

  it('the one-shot link the opener gets for a request works once, then lands on the same url', async () => {
    const h = await harness();
    h.source.add(1);
    const at = h.opened.length;
    await h.server.open(id(1));
    const link = new URL(h.opened[at] ?? '');
    expect(link.pathname).toBe(`/approve/${id(1)}`);
    const first = await send(h.port, `${link.pathname}${link.search}`);
    expect(first.status).toBe(303);
    expect(`${h.origin}${first.headers.location ?? ''}`).toBe(h.server.approvalUrl(id(1)));
    const cookie = (first.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
    const again = await send(h.port, `${link.pathname}${link.search}`);
    expect(again.status).toBe(401);
    expect(again.headers['set-cookie']).toBeUndefined();
    // The owner's browser, holding the cookie, opens the url the agent showed.
    const page = await send(h.port, new URL(h.server.approvalUrl(id(1))).pathname, {
      headers: { Cookie: cookie },
    });
    expect(page.status).toBe(200);
  });

  it('a same-user agent with the url, and even with a stolen session, cannot approve', async () => {
    const h = await harness();
    h.source.add(1);
    const row = await h.source.get(id(1));
    // Only the url: no cookie, so every decision route answers 401 before any body is read.
    const bare = await send(h.port, `/api/approvals/${id(1)}/approve`, {
      method: 'POST',
      headers: {
        Origin: h.origin,
        'Content-Type': 'application/octet-stream',
        'X-AgentLink-Digest': row?.actionDigest ?? '',
      },
      body: encodeUtf8(code),
    });
    expect(bare.status).toBe(401);
    // A session raced out of the opener's argv (the accepted residual): still no decision without
    // owner presence.
    const none = await decide(h, id(1), 'approve', undefined);
    expect(none.status).toBe(403);
    expect(JSON.parse(none.body)).toMatchObject({ status: 'presence_required' });
    const guess = await decide(h, id(1), 'approve', 'AAAA BBBB CCCC DDDD EEEE FFFF');
    expect(guess.status).toBe(403);
    expect(h.source.calls.apply).toBe(0);
    expect(h.source.applied).toEqual([]);
  });
});

describe('the token and the owner code stay out of files, logs and URLs (08 §1, I-7)', () => {
  it('never writes or logs them', async () => {
    const logged: string[] = [];
    const capture = (...args: unknown[]): void => void logged.push(args.map(String).join(' '));
    for (const name of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, name).mockImplementation(capture);
    }
    // Captured, not written: the spies swallow whatever the server might print.
    const { stdout, stderr } = process;
    const out = vi.spyOn(stdout, 'write').mockImplementation((chunk) => {
      logged.push(String(chunk));
      return true;
    });
    const err = vi.spyOn(stderr, 'write').mockImplementation((chunk) => {
      logged.push(String(chunk));
      return true;
    });
    const before = new Set(filesUnder(root));
    const h = await harness();
    h.source.add(1);
    h.source.add(2);
    await send(h.port, '/', { headers: { Host: 'evil.example' } });
    await send(h.port, `/?t=${h.token}`, { headers: { Host: 'evil.example' } });
    await decide(h, id(2), 'approve', 'AAAA BBBB CCCC DDDD EEEE FFFF');
    await decide(h, id(1), 'approve', code);
    const url = await h.server.notifyNewApproval(id(2));
    out.mockRestore();
    err.mockRestore();
    const cookie = await h.cookie();
    const csrf = await h.csrf(cookie);

    expect(url).toBe(`${h.origin}/approve/${id(2)}`);
    expect(h.server.approvalUrl(id(2))).toBe(url);
    const needles = [h.token, csrf, code, code.replaceAll(' ', '')];
    const haystacks = [
      ...logged,
      JSON.stringify(h.events),
      JSON.stringify(h.notified),
      url,
      ...filesUnder(root)
        .filter((f) => !before.has(f))
        .map((f) => readFileSync(f, 'latin1')),
    ];
    for (const needle of needles) {
      for (const hay of haystacks) expect(hay.includes(needle)).toBe(false);
    }
    // Error answers never echo the token either.
    const res = await send(h.port, `/?t=${h.token}`, { headers: { Host: 'evil.example' } });
    expect(res.body.includes(h.token)).toBe(false);
  });

  it('raises a fixed OS notification for a new request, with no request text', async () => {
    const h = await harness();
    h.source.add(1, { summary: 'Send <b>secret</b> to Mallory' });
    const url = await h.server.notifyNewApproval(id(1));
    expect(url).toBe(`${h.origin}/approve/${id(1)}`);
    expect(h.notified).toEqual([['AgentLink', 'An approval is waiting for you.']]);
    expect(JSON.stringify(h.notified)).not.toContain('Mallory');
    await expect(h.server.notifyNewApproval('apr_bad')).rejects.toThrow();
    // open() with a malformed ID rejects; it never throws synchronously and never opens anything.
    const opening = h.server.open('apr_bad');
    await expect(opening).rejects.toThrow();
    expect(h.opened).toHaveLength(1);
  });

  it('escapes request text in the page it serves', async () => {
    const h = await harness();
    h.source.add(1, { summary: '<script>alert(1)</script>' });
    const cookie = await h.cookie();
    const page = await send(h.port, `/approve/${id(1)}`, { headers: { Cookie: cookie } });
    expect(page.status).toBe(200);
    expect(page.body).not.toContain('<script>alert(1)</script>');
  });
});

describe('the M1-8c same-user script against the running server (10 M1-8, D-67)', () => {
  it('cannot approve or deny without the owner code, even holding the token', async () => {
    const jobFile = join(root, 'server-job.json');
    const outFile = join(root, 'server-script-result.json');
    /** A server with three pending requests, and the script's job file for it. */
    const serverWithJob = async (): Promise<Harness> => {
      const h = await harness();
      for (const n of [1, 2, 3]) h.source.add(n);
      const cookie = await h.cookie();
      const csrf = await h.csrf(cookie);
      const rows = await Promise.all([1, 2, 3].map((n) => h.source.get(id(n))));
      writeFileSync(
        jobFile,
        JSON.stringify({
          port: h.port,
          origin: h.origin,
          token: h.token,
          cookie,
          csrf,
          keychainFile,
          approvals: rows.map((r) => ({ approvalId: r?.approvalId, digest: r?.actionDigest })),
          outFile,
        }),
      );
      return h;
    };
    type ScriptResult = { attempts: { name: string; status: number }[] };
    const run = async (guess: string): Promise<ScriptResult> => {
      await execFileAsync(process.execPath, [SCRIPT, jobFile], {
        env: {
          ...process.env,
          HOME: home,
          AGENTLINK_OWNER_CODE: guess,
          AGENTLINK_OWNER_PASSPHRASE: 'not the owner passphrase',
        },
      });
      return JSON.parse(readFileSync(outFile, 'utf8')) as ScriptResult;
    };

    const h = await serverWithJob();
    const result = await run('AAAA BBBB CCCC DDDD EEEE FFFF');
    expect(result.attempts.length).toBeGreaterThan(10);
    expect(result.attempts.filter((a) => a.status === 200).map((a) => a.name)).toEqual([]);
    expect(h.source.applied).toEqual([]);
    // M1-11a: the wrong guesses also ran into the backoff.
    expect(result.attempts.some((a) => a.status === 429)).toBe(true);

    // Harness control (not vacuous): the same script holding the owner code does approve. It runs
    // against a fresh server, since the guesses above left this one in the M1-11a backoff.
    const fresh = await serverWithJob();
    const leaked = await run(code);
    expect(leaked.attempts.some((a) => a.status === 200)).toBe(true);
    expect(fresh.source.applied.length).toBeGreaterThan(0);
    for (const s of fresh.source.applied) expect(ownerSigValid(s.body, s.sig)).toBe(true);
  }, 120_000);
});

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() ? [path] : [];
  });
}
