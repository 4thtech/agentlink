// M1-11b-2c: the server-rendered approval page is gone (08 §1; 04 §2.5; D-118; I-4, I-5). Approvals
// live only in the local app (apps/local-ui), which this server serves on `/` and `/approve/<id>`
// when the CLI embeds it. What is left here:
//
// - No route serves the old page's script or stylesheet (`/app.js`, `/app.css`: 404), and no source
//   in this package exports them.
// - A server without the app bundle answers `/` and `/approve/<id>` with a fixed page that points
//   to `approve` in the owner's own terminal: no script, no form, no CSRF token, nothing from the
//   request. The page gate (session) and the API gates (CSRF, Origin, fetch metadata, presence) are
//   unchanged, so without the app nothing can be decided in the browser at all.
// - The expired-link page (401) is fixed text with no stylesheet or script.
// - The CSP is byte for byte the same on every page.
// - M1-11a-ux (I-5), unchanged: the invite link of an accept-invite request never reaches the
//   browser: it is the capability that opens the invite, and the owner decides on who it connects
//   to, not on the link.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EXPIRED_HTML, NO_APP_HTML, PAGE_STRINGS } from './approval-pages.js';
import {
  startApprovalServerWith,
  type ApprovalDetails,
  type ApprovalServer,
} from './approval-server.js';
import {
  approvalId as id,
  fakeSource,
  ownerWorld,
  send,
  type FakeSource,
  type OwnerWorld,
} from './approval-ui.fixture.js';
import { CLI_COMMAND } from './cli-command.js';
import { TEST_APP } from './local-ui-app.fixture.js';
import type { LocalUiAssets } from './local-ui/context.js';
import { KeychainOwnerKeyStore } from './owner-keystore.js';

const SRC = dirname(fileURLToPath(import.meta.url));

/** The CSP every answer carries, pinned: this card removes a page, never changes the policy. */
const CSP =
  "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; " +
  "font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const INVITE = 'https://agentlink.4thtech.io/i#c2VjcmV0LWludml0ZS1ib2R5LXRoYXQtaXMtcXVpdGUtbG9uZw';

let world: OwnerWorld;
beforeAll(async () => {
  world = await ownerWorld('agentlink-m1-11b-2c-pages-');
}, 60_000);
afterAll(() => world.cleanup());

const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** A server with the given bundle (`undefined`: the CLI embeds no app). */
async function start(assets: LocalUiAssets | undefined = TEST_APP): Promise<{
  server: ApprovalServer;
  source: FakeSource;
  cookie: () => Promise<string>;
  session: () => Promise<{ cookie: string; csrf: string }>;
}> {
  const source = fakeSource(world);
  const opened: string[] = [];
  const server = await startApprovalServerWith(
    assets === undefined ? { source } : { source, localUi: { assets } },
    {
      keychain: world.keychain,
      openOwnerStore: (expected) => KeychainOwnerKeyStore.open(world.keychain, expected),
      opener: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      notifier: () => Promise.resolve(true),
    },
  );
  servers.push(server);
  const cookie = async (): Promise<string> => {
    await server.open();
    const url = new URL(opened[opened.length - 1] ?? '');
    const res = await send(server.port, `${url.pathname}${url.search}`);
    expect(res.status).toBe(303);
    return (res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
  };
  return {
    server,
    source,
    cookie,
    async session() {
      const c = await cookie();
      const page = await send(server.port, '/', { headers: { Cookie: c } });
      const csrf = /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(page.body)?.[1];
      return { cookie: c, csrf: csrf ?? '' };
    },
  };
}

/** Fixed HTML that can never run or load anything. */
function expectInert(html: string): void {
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/<link/i);
  expect(html).not.toMatch(/<style/i);
  expect(html).not.toMatch(/\sstyle=/i);
  expect(html).not.toMatch(/<form|<input|<button/i);
  expect(html).not.toContain('agentlink-csrf');
  expect(html).not.toContain('/app.js');
  expect(html).not.toContain('/app.css');
}

describe('the old approval page is gone (M1-11b-2c)', () => {
  it('no route serves its script or stylesheet, with or without the app', async () => {
    for (const assets of [TEST_APP, undefined]) {
      const { server, cookie } = await start(assets);
      const c = await cookie();
      for (const path of ['/app.js', '/app.css']) {
        expect((await send(server.port, path)).status, path).toBe(404);
        const res = await send(server.port, path, { headers: { Cookie: c } });
        expect(res.status, path).toBe(404);
        expect(res.headers['content-type'], path).not.toMatch(/javascript|css/);
      }
    }
  });

  it('no source of this package carries the page, its script, stylesheet or sidebar copy', () => {
    const sources = readdirSync(SRC).filter((f) => f.endsWith('.ts') && !f.includes('.test.'));
    expect(sources).not.toContain('approval-page.ts');
    for (const file of sources) {
      const text = readFileSync(join(SRC, file), 'utf8');
      expect(text, file).not.toMatch(/export (const|function) (APP_JS|APP_CSS|APP_NAV|pageHtml)\b/);
    }
  });
});

describe('a server without the app bundle (M1-11b-2c)', () => {
  it('answers / and /approve/<id> with the fixed page that points to the terminal', async () => {
    const { server, cookie } = await start(undefined);
    const c = await cookie();
    for (const path of ['/', `/approve/${id(1)}`]) {
      const res = await send(server.port, path, { headers: { Cookie: c } });
      expect(res.status, path).toBe(503);
      expect(res.headers['content-type'], path).toBe('text/html; charset=utf-8');
      expect(res.headers['content-security-policy'], path).toBe(CSP);
      expect(res.headers['cache-control'], path).toBe('no-store');
      expect(res.body, path).toBe(NO_APP_HTML);
      expect(res.body, path).not.toContain('apr_');
      expect(res.body, path).not.toContain(c.split('=')[1] ?? 'missing');
    }
    expect(NO_APP_HTML).toContain(`<code>${CLI_COMMAND} approve</code>`);
    expectInert(NO_APP_HTML);
  });

  it('keeps the page gate: no session, no page; a link opens once; only GET', async () => {
    const { server, cookie } = await start(undefined);
    for (const path of ['/', `/approve/${id(1)}`]) {
      const res = await send(server.port, path);
      expect(res.status, path).toBe(401);
      expect(res.body, path).toBe(EXPIRED_HTML);
    }
    const c = await cookie();
    expect((await send(server.port, '/', { method: 'POST', headers: { Cookie: c } })).status).toBe(
      405,
    );
    // Malformed approval IDs are no page.
    for (const path of ['/approve/', '/approve/apr_short', `/approve/${id(1)}/x`]) {
      expect((await send(server.port, path, { headers: { Cookie: c } })).status, path).toBe(404);
    }
  });

  it('keeps the decide gates: without a page there is no CSRF token, so nothing is decided', async () => {
    const { server, source, cookie } = await start(undefined);
    source.add(1);
    const c = await cookie();
    const read = await send(server.port, '/api/approvals', { headers: { Cookie: c } });
    expect(read.status).toBe(403);
    const decide = await send(server.port, `/api/approvals/${id(1)}/approve`, {
      method: 'POST',
      headers: {
        Cookie: c,
        Origin: server.origin,
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/octet-stream',
      },
      body: new TextEncoder().encode(world.code),
    });
    expect(decide.status).toBe(403);
    expect(source.applied).toEqual([]);
    expect(source.pending(1)).toBe(true);
  });
});

describe('the fixed pages (M1-11b-2c; 11 §6.2.1)', () => {
  it('the expired-link page is fixed text that names the terminal command, nothing else', () => {
    expect(EXPIRED_HTML).toContain(`<code>${CLI_COMMAND} approve</code>`);
    expect(EXPIRED_HTML).toContain('This link has expired.');
    expectInert(EXPIRED_HTML);
  });

  it('keeps the CSP byte for byte on the app pages, the fixed page and the expired page', async () => {
    const withApp = await start();
    const c = await withApp.cookie();
    for (const path of ['/', `/approve/${id(1)}`, '/first-run']) {
      const res = await send(withApp.server.port, path, { headers: { Cookie: c } });
      expect(res.status, path).toBe(200);
      expect(res.headers['content-security-policy'], path).toBe(CSP);
    }
    expect(
      (await send(withApp.server.port, '/')).headers['content-security-policy'],
      'expired',
    ).toBe(CSP);
  });

  it('the words name the command that works and stay in plain words', () => {
    expect(PAGE_STRINGS.expired).toContain(`${CLI_COMMAND} approve`);
    expect(PAGE_STRINGS.noApp).toContain(`${CLI_COMMAND} approve`);
    const all = Object.values(PAGE_STRINGS).join(' ').toLowerCase();
    expect(all).not.toMatch(/wallet|seed phrase|transaction|\bgas\b|owner key/);
  });
});

describe('what the app is given for an accept-invite request (M1-11a-ux; I-5)', () => {
  const details: ApprovalDetails = {
    headline: 'Connect with “Ana” (self-declared)',
    who: '“Ana” (self-declared) · owner 7F3A·19C2 · not in your contacts yet',
    what: 'Connect with a new contact',
    cost: 'Free',
    expires: '12 Oct 2026 14:02 UTC',
    rule: 'Your rules ask you to approve every new contact.',
    fromAi: [
      { name: 'inviteUrl', value: INVITE },
      { name: 'note', value: 'kept' },
    ],
  };

  it('never carries the invite link; keeps the plain headline', async () => {
    const { server, source, session } = await start();
    source.add(1, {
      summary: `Connect with a new contact · ${details.who} · Free`,
      details,
    });
    const { cookie, csrf } = await session();
    expect(csrf).not.toBe('');
    for (const path of ['/api/approvals', `/api/approvals/${id(1)}`]) {
      const res = await send(server.port, path, {
        headers: { Cookie: cookie, 'X-AgentLink-CSRF': csrf },
      });
      expect(res.status, path).toBe(200);
      expect(res.body, path).not.toContain(INVITE);
      expect(res.body, path).not.toContain('inviteUrl');
      expect(res.body, path).toContain('Connect with “Ana” (self-declared)');
      expect(res.body, path).toContain('"note"');
    }
  });

  it('refuses a headline that is not plain text of a sane length (fail closed)', async () => {
    const { server, source, session } = await start();
    source.add(1, { details: { ...details, headline: 'x'.repeat(100_000) } });
    source.add(2, { details: { ...details, headline: 7 as unknown as string } });
    source.add(3, { details });
    const { cookie, csrf } = await session();
    const res = await send(server.port, '/api/approvals', {
      headers: { Cookie: cookie, 'X-AgentLink-CSRF': csrf },
    });
    const ids = (JSON.parse(res.body) as { approvals: { approvalId: string }[] }).approvals.map(
      (a) => a.approvalId,
    );
    expect(ids).toEqual([id(3)]);
  });
});
