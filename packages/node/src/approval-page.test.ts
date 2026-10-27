// M1-11a-ux: the approval page's stylesheet, the page shell and the card data the server
// hands the page (08 §1, §4; 11 §5, §6.2.1, §8; 04 §2.5; D-116; I-5).
//
// - The stylesheet is served by this server at `/app.css` under the same strict CSP (no inline style,
//   no external resource), follows light and dark, and sets colours only as tokens. That every token
//   equals the @4thtech-io/ui design tokens (D-116) is checked in that package
//   (approval-page-tokens.test.ts), so a token change runs it.
// - The page shell links only same-origin resources and carries no request data.
// - The invite link of an accept-invite request never reaches the page: it is the capability that
//   opens the invite, and the owner decides on who it connects to, not on the link.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { APP_CSS, APP_JS, APP_NAV, EXPIRED_HTML, UI_STRINGS, pageHtml } from './approval-page.js';
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
import { KeychainOwnerKeyStore } from './owner-keystore.js';

/** The CSP every answer carries, pinned: this card changes the page, never the policy. */
const CSP =
  "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; " +
  "font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const INVITE = 'https://agentlink.4thtech.io/i#c2VjcmV0LWludml0ZS1ib2R5LXRoYXQtaXMtcXVpdGUtbG9uZw';

let world: OwnerWorld;
beforeAll(async () => {
  world = await ownerWorld('agentlink-m1-ux-page-');
}, 60_000);
afterAll(() => world.cleanup());

const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(): Promise<{
  server: ApprovalServer;
  source: FakeSource;
  session: () => Promise<{ cookie: string; csrf: string }>;
}> {
  const source = fakeSource(world);
  const opened: string[] = [];
  const server = await startApprovalServerWith(
    { source },
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
  return {
    server,
    source,
    async session() {
      await server.open();
      const url = new URL(opened[opened.length - 1] ?? '');
      const res = await send(server.port, `${url.pathname}${url.search}`);
      const cookie = (res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
      const page = await send(server.port, '/', { headers: { Cookie: cookie } });
      const csrf = /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(page.body)?.[1];
      return { cookie, csrf: csrf ?? '' };
    },
  };
}

/** `--al-*` custom properties set in one CSS block, by name. */
function vars(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/(--al-[a-z0-9-]+):\s*([^;]+);/g)) {
    out.set(m[1] ?? '', (m[2] ?? '').trim());
  }
  return out;
}

/** The body of the first `{…}` block after `marker` (no nested braces inside a token block). */
function blockAfter(css: string, marker: string): string {
  const at = css.indexOf(marker);
  expect(at, marker).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', at + marker.length - 1);
  return css.slice(open + 1, css.indexOf('}', open));
}

describe('the approval page stylesheet (M1-11a-ux; D-116)', () => {
  it('is served at /app.css as text/css under the unchanged strict CSP', async () => {
    const { server } = await start();
    const res = await send(server.port, '/app.css');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe(CSP);
    expect(res.body).toBe(APP_CSS);
    expect((await send(server.port, '/app.css', { method: 'POST' })).status).toBe(405);
  });

  it('keeps the CSP byte for byte on the page, the script and the stylesheet', async () => {
    const { server, session } = await start();
    const { cookie } = await session();
    for (const path of ['/', `/approve/${id(1)}`, '/app.js', '/app.css']) {
      const res = await send(server.port, path, { headers: { Cookie: cookie } });
      expect(res.headers['content-security-policy'], path).toBe(CSP);
    }
  });

  it('loads nothing from outside: no url(), no @import, no external origin', () => {
    expect(APP_CSS).not.toMatch(/url\s*\(/i);
    expect(APP_CSS).not.toMatch(/@import/i);
    expect(APP_CSS).not.toMatch(/:\/\//);
    expect(APP_CSS).not.toMatch(/expression\s*\(/i);
  });

  it('follows the light and the dark theme', () => {
    expect(APP_CSS).toContain('color-scheme: dark');
    expect(APP_CSS).toMatch(/@media \(prefers-color-scheme: light\)/);
    expect(APP_CSS).toContain('color-scheme: light');
  });

  it('sets colours only as tokens, the same set in light and dark (no invented values)', () => {
    const dark = vars(blockAfter(APP_CSS, ':root {'));
    const light = vars(blockAfter(APP_CSS, '@media (prefers-color-scheme: light) {\n  :root {'));
    expect(dark.size).toBeGreaterThan(10);
    // Light sets every colour dark sets, so nothing leaks from one theme into the other.
    expect([...light.keys()].sort()).toEqual([...dark.keys()].sort());
    // Colours outside the token blocks would be invented values.
    const rules = APP_CSS.replace(blockAfter(APP_CSS, ':root {'), '').replace(
      blockAfter(APP_CSS, '@media (prefers-color-scheme: light) {\n  :root {'),
      '',
    );
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});

describe('the page shell (M1-11a-ux)', () => {
  it('links its own stylesheet and script only, with no inline style or script', () => {
    const html = pageHtml('abc');
    expect(html).toContain('<link rel="stylesheet" href="/app.css">');
    expect(html).toContain('<script src="/app.js" defer></script>');
    expect(html).not.toMatch(/<style|style=/i);
    expect(html).not.toMatch(/:\/\//);
    expect(html).not.toMatch(/<script>(?!<\/script>)/);
  });
});

describe('the shared app navigation (M1-11b-2a)', () => {
  it('is left out by default, so the page without the app is unchanged', () => {
    const html = pageHtml('abc');
    expect(html).not.toContain('al-side');
    expect(html).not.toContain('/settings/');
  });

  it('lists the seven app pages in the app order, Approvals current, as plain same-origin links', () => {
    const html = pageHtml('abc', { appNav: true });
    expect(APP_NAV.map((i) => i.path)).toEqual([
      '/',
      '/settings/activity',
      '/settings/contacts',
      '/settings/files',
      '/settings/proofs',
      '/settings/rules',
      '/settings/backup',
    ]);
    expect(APP_NAV.map((i) => i.label)).toEqual([
      'Approvals',
      'Activity',
      'Contacts',
      'Files',
      'Proofs & credits',
      'Rules',
      'Settings',
    ]);
    for (const item of APP_NAV) {
      expect(html).toContain(`href="${item.path}"`);
      expect(html).toContain(`<span>${item.label.replace(/&/g, '&amp;')}</span>`);
    }
    expect(html).toContain('<div class="al-side-brand">');
    expect(html).toMatch(
      /<div class="al-side-brand"><svg[^]*?<\/svg><span>AgentLink<\/span><\/div>/,
    );
    expect(html.split('aria-current="page"').length - 1).toBe(1);
    expect(html).toContain('<a class="al-nav is-active" href="/" aria-current="page">');
    // Same shell rules as before: own stylesheet and script only, nothing inline, nothing outside.
    expect(html).toContain('<link rel="stylesheet" href="/app.css">');
    expect(html).toContain('<script src="/app.js" defer></script>');
    expect(html).not.toMatch(/<style|style=|\son[a-z]+=/i);
    expect(html).not.toMatch(/:\/\//);
    expect(html).toContain('<main id="app" class="al-page">');
    expect(html.split('agentlink-csrf').length - 1).toBe(1);
  });

  it('draws the sidebar from the AppShell rules and hides it on narrow screens like the app', () => {
    for (const rule of ['.al-side {', '.al-nav {', '.al-nav.is-active {', '.al-shell-main {']) {
      expect(APP_CSS).toContain(rule);
    }
    expect(APP_CSS).toMatch(/@media \(max-width: 600px\) \{\s*\.al-side \{\s*display: none;/);
  });

  it('never puts the navigation on the expired-link page', () => {
    expect(EXPIRED_HTML).not.toContain('al-side');
  });
});

describe('the "Switch to …" next step on Approvals (M1-UX-FIRSTRUN-V2-c, B-9)', () => {
  it('names the platform and the backup code in plain words, never a password', () => {
    expect(UI_STRINGS.switchMac).toBe('Switch to Touch ID');
    expect(UI_STRINGS.switchWindows).toBe('Switch to Windows Hello');
    expect(UI_STRINGS.switchOther).toBe('Switch to a passkey');
    const copy = [
      UI_STRINGS.switchMac,
      UI_STRINGS.switchWindows,
      UI_STRINGS.switchOther,
      UI_STRINGS.switchBody,
    ].join(' ');
    expect(copy).toContain('backup code');
    expect(copy.toLowerCase()).not.toMatch(/password|wallet|seed|transaction|gas\b/);
  });

  it('links only to the fixed first-run path, and only when the app is there to go to', () => {
    // The page script draws the link only beside the app sidebar (pageHtml appNav); the old
    // inline set-up stays for a server without the app bundle.
    expect(APP_JS).toContain("href = '/first-run'");
    expect(APP_JS).toMatch(/querySelector\('\.al-side'\)/);
    expect(APP_JS).not.toMatch(/first-run\?/);
  });
});

describe('what the page is given for an accept-invite request (M1-11a-ux; I-5)', () => {
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
